import type { QuoteExecutionRequest, QuoteExecutionResult } from "../types";

type QuoteRequestContext = {
  propertyId: string;
  propertyName: string;
  roomTypeId: string;
  hash: string;
  detailUrl: string;
};

type ProminenceUnavailableClassification = {
  code: string;
  retryable: boolean;
  httpStatus: number | null;
};

type RawObservation = {
  startDate: string;
  endDate: string;
  quoteAvailable: boolean;
  quoteUnavailableReason: string | null;
  baseTotal: number | null;
  taxesTotal: number | null;
  feesTotal: number | null;
  grandTotal: number | null;
  currency: string;
  handoffUrl: string;
};

const ADAPTER_KEY = "prominence30a" as const;
const BASE_HOST = "https://www.prominenceon30a.com";
const DEFAULT_QUOTE_RETRY_DELAYS_MS = [0, 1200, 3000, 6000];
const DEFAULT_QUOTE_TIMEOUT_MS = 20000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

function toUsDate(isoDate: string): string {
  const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return isoDate;
  }
  return `${match[2]}/${match[3]}/${match[1]}`;
}

function stripHtmlTags(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseAmount(value: string): number | null {
  const parsed = Number(value.trim().replace(/,/g, ""));
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return roundCurrency(parsed);
}

function parsePriceByLabelContains(html: string, label: string): number | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `<span\\s+class="pdp-quote-item-text">\\s*[^<]*${escaped}[^<]*\\s*<\\/span>[\\s\\S]*?<span\\s+class="pdp-quote-item-price"\\s+data-price="([^"]+)"`,
    "i",
  );
  const match = html.match(pattern);
  if (!match?.[1]) {
    return null;
  }
  return parseAmount(match[1]);
}

function parseUnavailableReason(html: string): string | null {
  const trimmed = html.trim();
  if (trimmed === "No") {
    return "Dates unavailable for selected stay window";
  }
  if (trimmed === "API Error") {
    return "Quote API returned an error";
  }

  const alertMatch = html.match(
    /<div\s+class="alert-sm\s+alert-danger[^>]*>([\s\S]*?)<\/div>/i,
  );
  if (!alertMatch?.[1]) {
    return null;
  }

  const reason = stripHtmlTags(alertMatch[1]).trim();
  return reason.length > 0 ? reason : null;
}

function classifyUnavailableReason(
  reason: string | null,
): ProminenceUnavailableClassification {
  const normalized = (reason ?? "Quote unavailable").trim();
  const lower = normalized.toLowerCase();

  if (
    lower.includes("timed out") ||
    lower.includes("timeout") ||
    lower.includes("etimedout")
  ) {
    return {
      code: "QUOTE_TIMEOUT_TRANSIENT",
      retryable: true,
      httpStatus: null,
    };
  }

  const statusMatch = normalized.match(/status\s+(\d{3})/i);
  const httpStatus = statusMatch?.[1] ? Number(statusMatch[1]) : null;
  if (httpStatus !== null && Number.isFinite(httpStatus)) {
    const hardFail =
      httpStatus === 400 ||
      httpStatus === 403 ||
      httpStatus === 404 ||
      httpStatus === 429 ||
      httpStatus >= 500;

    return {
      code: `QUOTE_HTTP_${httpStatus}`,
      retryable: !hardFail,
      httpStatus,
    };
  }

  return {
    code: "QUOTE_UNAVAILABLE",
    retryable: true,
    httpStatus: null,
  };
}

function extractBookNowUrl(html: string): string | null {
  const match = html.match(/id="bookNowURL"[^>]*value="([^"]+)"/i);
  if (!match?.[1]) {
    return null;
  }

  const decoded = match[1]
    .replace(/&amp;/g, "&")
    .replace(/&#x2F;/g, "/")
    .trim();
  return decoded.length > 0 ? decoded : null;
}

function buildFallbackHandoffUrl(input: {
  propertyId: string;
  checkInIso: string;
  checkOutIso: string;
}): string {
  return `${BASE_HOST}/rentals/book-now?propertyID=${input.propertyId}&checkin=${input.checkInIso}&checkout=${input.checkOutIso}`;
}

function toFormBody(input: {
  propertyId: string;
  propertyName: string;
  roomTypeId: string;
  hash: string;
  checkInIso: string;
  checkOutIso: string;
}): URLSearchParams {
  const body = new URLSearchParams();
  body.set("checkin", toUsDate(input.checkInIso));
  body.set("checkout", toUsDate(input.checkOutIso));
  body.set("propertyID", input.propertyId);
  body.set("roomTypeID", input.roomTypeId);
  body.set("propertyName", input.propertyName);
  body.set("hash", input.hash);
  return body;
}

function parseRetryDelaysMs(raw: string): number[] {
  const parsed = raw
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .map((value) => Math.floor(value));
  if (parsed.length >= 2) {
    return parsed;
  }
  return DEFAULT_QUOTE_RETRY_DELAYS_MS;
}

function normalizeTimeoutMs(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_QUOTE_TIMEOUT_MS;
  }
  return Math.max(1000, Math.floor(raw));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function toError(input: {
  code: string;
  message: string;
  retryable: boolean;
  listingId: string;
  checkInIso: string;
  checkOutIso: string;
  details?: Record<string, unknown>;
}) {
  return {
    code: input.code,
    message: input.message,
    retryable: input.retryable,
    details: {
      adapterKey: ADAPTER_KEY,
      listingId: input.listingId,
      checkInIso: input.checkInIso,
      checkOutIso: input.checkOutIso,
      ...(input.details ?? {}),
    },
  };
}

function asOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractQuoteContext(
  input: QuoteExecutionRequest,
): QuoteRequestContext {
  const context =
    input.quoteContext &&
    typeof input.quoteContext === "object" &&
    !Array.isArray(input.quoteContext)
      ? input.quoteContext
      : null;

  const propertyId =
    asOptionalString(context?.property_id) ??
    asOptionalString(context?.propertyID);
  const propertyName =
    asOptionalString(context?.property_name) ??
    asOptionalString(context?.propertyName) ??
    propertyId;
  const roomTypeId =
    asOptionalString(context?.room_type_id) ??
    asOptionalString(context?.roomTypeID) ??
    "";
  const hash = asOptionalString(context?.hash) ?? "";
  const detailUrl =
    asOptionalString(context?.detail_url) ??
    asOptionalString(context?.detailUrl) ??
    "";

  if (!propertyId || !detailUrl) {
    throw new Error(
      `Missing required quote_context values for ${ADAPTER_KEY} listing ${input.listingId}. Required: property_id, detail_url`,
    );
  }

  return {
    propertyId,
    propertyName: propertyName || propertyId,
    roomTypeId,
    hash,
    detailUrl,
  };
}

async function fetchProminenceQuote(input: {
  quoteContext: QuoteRequestContext;
  checkInIso: string;
  checkOutIso: string;
  timeoutMs: number;
}): Promise<RawObservation> {
  const endpoint = `${BASE_HOST}/ajax/quote`;
  const fallbackHandoffUrl = buildFallbackHandoffUrl({
    propertyId: input.quoteContext.propertyId,
    checkInIso: input.checkInIso,
    checkOutIso: input.checkOutIso,
  });

  const retryDelaysMs = parseRetryDelaysMs(
    process.env.PROMINENCE30A_QUOTE_RETRY_DELAYS_MS ??
      process.env.PROMINENCE30_QUOTE_RETRY_DELAYS_MS ??
      "",
  );

  let lastFailureReason = "Quote request failed";

  for (let attempt = 0; attempt < retryDelaysMs.length; attempt += 1) {
    const delayMs = retryDelaysMs[attempt] ?? 0;
    if (delayMs > 0) {
      await sleep(delayMs);
    }

    try {
      const controller = new AbortController();
      const timeoutHandle = setTimeout(
        () => controller.abort(),
        input.timeoutMs,
      );

      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers: {
            accept: "text/html, */*; q=0.01",
            "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
            "x-requested-with": "XMLHttpRequest",
            "user-agent": USER_AGENT,
            referer: input.quoteContext.detailUrl,
            origin: BASE_HOST,
          },
          signal: controller.signal,
          body: toFormBody({
            propertyId: input.quoteContext.propertyId,
            propertyName: input.quoteContext.propertyName,
            roomTypeId: input.quoteContext.roomTypeId,
            hash: input.quoteContext.hash,
            checkInIso: input.checkInIso,
            checkOutIso: input.checkOutIso,
          }),
        });
      } finally {
        clearTimeout(timeoutHandle);
      }

      if (!response.ok) {
        lastFailureReason = `Quote request failed with status ${response.status}`;
        if (attempt < retryDelaysMs.length - 1) {
          continue;
        }
        break;
      }

      const html = await response.text();
      const reason = parseUnavailableReason(html);

      const baseTotal = parsePriceByLabelContains(html, "Rent");
      const taxesTotal = parsePriceByLabelContains(html, "Taxes");
      const feesTotal = parsePriceByLabelContains(html, "Fees");
      const grandTotal = parsePriceByLabelContains(html, "Total");
      const handoffUrl = extractBookNowUrl(html) ?? fallbackHandoffUrl;

      const quoteAvailable =
        reason === null &&
        baseTotal !== null &&
        baseTotal > 0 &&
        grandTotal !== null &&
        grandTotal >= baseTotal;

      if (
        !quoteAvailable &&
        reason === null &&
        attempt < retryDelaysMs.length - 1
      ) {
        lastFailureReason = "Quote response missing totals";
        continue;
      }

      return {
        startDate: input.checkInIso,
        endDate: input.checkOutIso,
        quoteAvailable,
        quoteUnavailableReason: reason,
        baseTotal,
        taxesTotal,
        feesTotal,
        grandTotal,
        currency: "USD",
        handoffUrl,
      };
    } catch (error: unknown) {
      lastFailureReason =
        error instanceof Error && error.name === "AbortError"
          ? `Quote request timed out after ${input.timeoutMs}ms`
          : error instanceof Error
            ? error.message
            : "Quote request threw";
      if (attempt < retryDelaysMs.length - 1) {
        continue;
      }
    }
  }

  return {
    startDate: input.checkInIso,
    endDate: input.checkOutIso,
    quoteAvailable: false,
    quoteUnavailableReason: lastFailureReason,
    baseTotal: null,
    taxesTotal: null,
    feesTotal: null,
    grandTotal: null,
    currency: "USD",
    handoffUrl: fallbackHandoffUrl,
  };
}

export async function executeProminence30SingleQuote(
  input: QuoteExecutionRequest,
): Promise<QuoteExecutionResult> {
  const startedAt = performance.now();
  const timeoutMs = normalizeTimeoutMs(
    input.options?.timeoutMs ??
      Number(
        process.env.PROMINENCE30A_QUOTE_TIMEOUT_MS ??
          process.env.PROMINENCE30_QUOTE_TIMEOUT_MS ??
          DEFAULT_QUOTE_TIMEOUT_MS,
      ),
  );

  let quoteContext: QuoteRequestContext;
  try {
    quoteContext = extractQuoteContext(input);
  } catch (error: unknown) {
    return {
      success: false,
      elapsedMs: performance.now() - startedAt,
      error: toError({
        code: "QUOTE_CONTEXT_MISSING",
        message:
          error instanceof Error ? error.message : "Missing quote context",
        retryable: false,
        listingId: input.listingId,
        checkInIso: input.checkInIso,
        checkOutIso: input.checkOutIso,
      }),
    };
  }

  const raw = await fetchProminenceQuote({
    quoteContext,
    checkInIso: input.checkInIso,
    checkOutIso: input.checkOutIso,
    timeoutMs,
  });

  const elapsedMs = performance.now() - startedAt;
  if (!raw.quoteAvailable) {
    const classification = classifyUnavailableReason(
      raw.quoteUnavailableReason,
    );
    return {
      success: false,
      elapsedMs,
      error: {
        code: classification.code,
        message: raw.quoteUnavailableReason ?? "Quote unavailable",
        retryable: classification.retryable,
        details: {
          adapterKey: ADAPTER_KEY,
          listingId: input.listingId,
          startDate: raw.startDate,
          endDate: raw.endDate,
          httpStatus: classification.httpStatus,
          handoff_url: raw.handoffUrl,
        },
      },
    };
  }

  return {
    success: true,
    elapsedMs,
    observation: {
      startDate: raw.startDate,
      endDate: raw.endDate,
      quoteAvailable: true,
      currency: raw.currency || null,
      baseTotal: raw.baseTotal,
      taxesTotal: raw.taxesTotal,
      feesTotalExclTaxes: raw.feesTotal,
      grandTotal: raw.grandTotal,
      quotedTotal: raw.grandTotal,
      handoffUrl: raw.handoffUrl,
    },
  };
}
