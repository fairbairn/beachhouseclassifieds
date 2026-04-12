import type { QuoteExecutionRequest, QuoteExecutionResult } from "../types";

type QuoteRequestContext = {
  propertyId: string;
  propertyName: string;
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

const ADAPTER_KEY = "panhandle30a" as const;
const BASE_HOST = "https://www.panhandlegetaways.com";
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
  checkInIso: string;
  checkOutIso: string;
  propertyName: string;
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

function normalizeTimeoutMs(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_QUOTE_TIMEOUT_MS;
  }
  return Math.max(1000, Math.floor(raw));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function extractQuoteContext(
  input: QuoteExecutionRequest,
): QuoteRequestContext {
  const context = input.quoteContext;
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    throw new Error(
      `Missing required quoteContext.property_id for ${ADAPTER_KEY} listing ${input.listingId}`,
    );
  }

  const propertyIdRaw = context.property_id;
  const propertyNameRaw = context.property_name;
  const propertyId =
    typeof propertyIdRaw === "string" ? propertyIdRaw.trim() : "";
  const propertyName =
    typeof propertyNameRaw === "string" ? propertyNameRaw.trim() : "";

  if (!propertyId) {
    throw new Error(
      `Missing required quoteContext.property_id for ${ADAPTER_KEY} listing ${input.listingId}`,
    );
  }

  return {
    propertyId,
    propertyName: propertyName || propertyId,
  };
}

async function fetchPanhandleQuote(input: {
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
    process.env.PANHANDLE30A_QUOTE_RETRY_DELAYS_MS ?? "",
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
            referer: fallbackHandoffUrl,
            origin: BASE_HOST,
          },
          signal: controller.signal,
          body: toFormBody({
            propertyId: input.quoteContext.propertyId,
            checkInIso: input.checkInIso,
            checkOutIso: input.checkOutIso,
            propertyName: input.quoteContext.propertyName,
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

export async function executePanhandle30aSingleQuote(
  input: QuoteExecutionRequest,
): Promise<QuoteExecutionResult> {
  let quoteContext: QuoteRequestContext;
  try {
    quoteContext = extractQuoteContext(input);
  } catch (error: unknown) {
    return {
      success: false,
      elapsedMs: 0,
      error: {
        code: "QUOTE_CONTEXT_MISSING",
        message:
          error instanceof Error ? error.message : "Missing quote context",
        retryable: false,
        details: {
          adapterKey: ADAPTER_KEY,
          listingId: input.listingId,
          checkInIso: input.checkInIso,
          checkOutIso: input.checkOutIso,
        },
      },
    };
  }

  const timeoutMs = normalizeTimeoutMs(input.options?.timeoutMs);
  const startedAt = performance.now();
  const raw = await fetchPanhandleQuote({
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
      error: {
        code: "QUOTE_UNAVAILABLE",
        message: raw.quoteUnavailableReason ?? "Quote unavailable",
        retryable: true,
        details: {
          adapterKey: ADAPTER_KEY,
          listingId: input.listingId,
          startDate: raw.startDate,
          endDate: raw.endDate,
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
