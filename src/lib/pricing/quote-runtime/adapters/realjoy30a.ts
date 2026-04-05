import type { QuoteExecutionRequest, QuoteExecutionResult } from "../types";

type RealjoyQuoteContext = {
  propertyId: string;
  propertyName: string;
  detailUrl: string;
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

const ADAPTER_KEY = "realjoy30a" as const;
const BASE_HOST = "https://www.realjoy.com";
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_QUOTE_RETRY_DELAYS_MS = [0, 1200, 3000, 6000];
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

function normalizeTimeoutMs(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.max(1000, Math.floor(raw));
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

function parsePriceByLabel(html: string, label: string): number | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `<span\\s+class="pdp-quote-item-text">\\s*${escaped}\\s*<\\/span>[\\s\\S]*?<span\\s+class="pdp-quote-item-price"\\s+data-price="([^"]+)"`,
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
  const checkin = toUsDate(input.checkInIso);
  const checkout = toUsDate(input.checkOutIso);
  return `${BASE_HOST}/beach-rentals/book-now?propertyID=${input.propertyId}&checkin=${checkin}&checkout=${checkout}&promocode=`;
}

function normalizeHandoffUrl(urlValue: string): string {
  try {
    const parsed = new URL(urlValue, BASE_HOST);
    if (!parsed.searchParams.has("promocode")) {
      parsed.searchParams.set("promocode", "");
    }
    return parsed.toString();
  } catch {
    return urlValue;
  }
}

function toFormBody(input: {
  propertyId: string;
  propertyName: string;
  checkInIso: string;
  checkOutIso: string;
}): URLSearchParams {
  const body = new URLSearchParams();
  body.set("checkin", toUsDate(input.checkInIso));
  body.set("checkout", toUsDate(input.checkOutIso));
  body.set("propertyID", input.propertyId);
  body.set("roomTypeID", "");
  body.set("propertyName", input.propertyName);
  body.set("hash", "");
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

async function sleep(ms: number): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function defaultDetailUrlForListing(listingId: string): string {
  return `${BASE_HOST}/beach-rentals/${listingId}`;
}

function extractQuoteContext(
  input: QuoteExecutionRequest,
): RealjoyQuoteContext {
  const quoteContext =
    input.quoteContext &&
    typeof input.quoteContext === "object" &&
    !Array.isArray(input.quoteContext)
      ? input.quoteContext
      : null;

  if (!quoteContext) {
    throw new Error(
      `Missing required quote_context for ${ADAPTER_KEY} listing ${input.listingId}`,
    );
  }

  const propertyId =
    typeof quoteContext.property_id === "string"
      ? quoteContext.property_id.trim()
      : "";
  if (!propertyId) {
    throw new Error(
      `Missing required quote_context.property_id for ${ADAPTER_KEY} listing ${input.listingId}`,
    );
  }

  const propertyNameRaw =
    typeof quoteContext.property_name === "string"
      ? quoteContext.property_name.trim()
      : "";
  const detailUrlRaw =
    typeof quoteContext.detail_url === "string"
      ? quoteContext.detail_url.trim()
      : "";

  return {
    propertyId,
    propertyName: propertyNameRaw || input.listingId || propertyId,
    detailUrl: detailUrlRaw || defaultDetailUrlForListing(input.listingId),
  };
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

async function fetchRealjoyQuote(input: {
  quoteContext: RealjoyQuoteContext;
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
    process.env.REALJOY30A_QUOTE_RETRY_DELAYS_MS ?? "",
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

      const baseTotal = parsePriceByLabel(html, "Rent");
      const taxesTotal = parsePriceByLabel(html, "Taxes");
      const feesTotal = parsePriceByLabel(html, "Fees");
      const grandTotal = parsePriceByLabel(html, "Total");
      const handoffUrl = normalizeHandoffUrl(
        extractBookNowUrl(html) ?? fallbackHandoffUrl,
      );

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
    handoffUrl: normalizeHandoffUrl(fallbackHandoffUrl),
  };
}

export async function executeRealjoy30aSingleQuote(
  input: QuoteExecutionRequest,
): Promise<QuoteExecutionResult> {
  const startedAt = performance.now();
  const timeoutMs = normalizeTimeoutMs(input.options?.timeoutMs);

  let quoteContext: RealjoyQuoteContext;
  try {
    quoteContext = extractQuoteContext(input);
  } catch (error: unknown) {
    return {
      success: false,
      elapsedMs: 0,
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

  const raw = await fetchRealjoyQuote({
    quoteContext,
    checkInIso: input.checkInIso,
    checkOutIso: input.checkOutIso,
    timeoutMs,
  });

  const elapsedMs = performance.now() - startedAt;

  if (!raw.quoteAvailable) {
    return {
      success: false,
      elapsedMs,
      error: toError({
        code: "QUOTE_UNAVAILABLE",
        message: raw.quoteUnavailableReason ?? "Quote unavailable",
        retryable: true,
        listingId: input.listingId,
        checkInIso: input.checkInIso,
        checkOutIso: input.checkOutIso,
        details: {
          handoff_url: raw.handoffUrl,
        },
      }),
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
