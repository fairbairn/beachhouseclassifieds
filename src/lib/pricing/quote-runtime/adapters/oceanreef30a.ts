import type { QuoteExecutionRequest, QuoteExecutionResult } from "../types";

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

const ADAPTER_KEY = "oceanreef30a" as const;
const BASE_HOST = "https://www.oceanreefresorts.com";
const PRICE_SUMMARY_ENDPOINT = `${BASE_HOST}/ajax/pricesummary/`;
const DEFAULT_PETS = 0;
const DEFAULT_RETRY_DELAYS_MS = [0, 1200, 3000, 6000];
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

function parseAmount(value: string): number | null {
  const parsed = Number(value.trim().replace(/,/g, ""));
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return roundCurrency(parsed);
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeNumericUnitId(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = String(Math.floor(value));
    return /^\d+$/.test(normalized) ? normalized : null;
  }

  if (typeof value === "string") {
    const normalized = value.trim();
    return /^\d+$/.test(normalized) ? normalized : null;
  }

  return null;
}

function stripHtmlTags(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toUsDate(isoDate: string): string {
  const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return isoDate;
  }
  return `${match[2]}/${match[3]}/${match[1]}`;
}

function parsePriceByLabel(html: string, label: string): number | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `<li\\s+class="book-quote-item(?:\\s+[^"]*)?">[\\s\\S]*?<span\\s+class="book-quote-item-text">\\s*${escaped}\\s*<\\/span>[\\s\\S]*?<span\\s+class="book-quote-item-price"[^>]*data-price="([^"]+)"`,
    "i",
  );
  const match = html.match(pattern);
  if (!match?.[1]) {
    return null;
  }
  return parseAmount(match[1]);
}

function parseFeeLinesTotal(html: string): number | null {
  const feeSectionMatch = html.match(
    /<ul\s+class="book-quote-item-toggle-list">([\s\S]*?)<\/ul>/i,
  );
  if (!feeSectionMatch?.[1]) {
    return null;
  }

  const itemPattern =
    /<span\s+class="book-quote-item-text">\s*([^<]+?)\s*<\/span>[\s\S]*?<span\s+class="book-quote-item-price"[^>]*data-price="([^"]+)"/gi;

  let total = 0;
  let count = 0;
  let match: RegExpExecArray | null = itemPattern.exec(feeSectionMatch[1]);
  while (match) {
    const name = stripHtmlTags(match[1] ?? "").trim();
    const amount = parseAmount(match[2] ?? "");
    if (name && amount !== null && amount >= 0) {
      total += amount;
      count += 1;
    }
    match = itemPattern.exec(feeSectionMatch[1]);
  }

  return count > 0 ? roundCurrency(total) : null;
}

function parseUnavailableReason(html: string): string | null {
  const text = stripHtmlTags(html).toLowerCase();
  if (!text) {
    return "Empty quote response";
  }

  const knownSignals = [
    "not available",
    "dates unavailable",
    "unavailable",
    "no availability",
    "cannot be booked",
    "no rates",
    "available rate type was not found",
    "rate type was not found",
  ];

  for (const signal of knownSignals) {
    if (text.includes(signal)) {
      return "Dates unavailable for selected stay window";
    }
  }

  return null;
}

function buildFallbackHandoffUrl(input: {
  propertyId: string | null;
  checkInIso: string;
  checkOutIso: string;
}): string {
  const checkin = toUsDate(input.checkInIso);
  const checkout = toUsDate(input.checkOutIso);
  const propertyId = input.propertyId ?? "";
  return `${BASE_HOST}/rentals/book-now?propertyID=${propertyId}&checkin=${checkin}&checkout=${checkout}`;
}

function toFormBody(input: {
  propertyId: string;
  checkInIso: string;
  checkOutIso: string;
  adults: number;
  children: number;
  pets: number;
}): URLSearchParams {
  const body = new URLSearchParams();
  body.set("propertyID", input.propertyId);
  body.set("checkin", toUsDate(input.checkInIso));
  body.set("checkout", toUsDate(input.checkOutIso));
  body.set("adults", String(Math.max(1, input.adults)));
  body.set("children", String(Math.max(0, input.children)));
  body.set("pets", String(Math.max(0, input.pets)));
  body.set("leaseID", "");
  body.set("optInFees", "");
  body.set("optOutFees", "");
  body.set("customQuoteID", "");
  body.set("chargetemplateid", "");
  body.set("travelInsuranceID", "");
  body.set("promoCodeSubmitted", "0");
  body.set("promocode", "");
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
  return DEFAULT_RETRY_DELAYS_MS;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchQuoteHtml(input: {
  detailUrl: string;
  propertyId: string | null;
  checkInIso: string;
  checkOutIso: string;
  adults: number;
  children: number;
  pets: number;
}): Promise<RawObservation> {
  const fallbackHandoffUrl = buildFallbackHandoffUrl({
    propertyId: input.propertyId,
    checkInIso: input.checkInIso,
    checkOutIso: input.checkOutIso,
  });

  if (!input.propertyId) {
    return {
      startDate: input.checkInIso,
      endDate: input.checkOutIso,
      quoteAvailable: false,
      quoteUnavailableReason: "Missing numeric propertyID on detail record",
      baseTotal: null,
      taxesTotal: null,
      feesTotal: null,
      grandTotal: null,
      currency: "USD",
      handoffUrl: fallbackHandoffUrl,
    };
  }

  const retryDelaysMs = parseRetryDelaysMs(
    process.env.OCEANREEF30A_QUOTE_RETRY_DELAYS_MS ?? "",
  );

  let lastFailureReason = "Quote request failed";

  for (let attempt = 0; attempt < retryDelaysMs.length; attempt += 1) {
    const delayMs = retryDelaysMs[attempt] ?? 0;
    if (delayMs > 0) {
      await sleep(delayMs);
    }

    try {
      const response = await fetch(PRICE_SUMMARY_ENDPOINT, {
        method: "POST",
        headers: {
          accept: "text/html, */*; q=0.01",
          "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
          "x-requested-with": "XMLHttpRequest",
          "user-agent": USER_AGENT,
          referer: input.detailUrl,
          origin: BASE_HOST,
        },
        body: toFormBody({
          propertyId: input.propertyId,
          checkInIso: input.checkInIso,
          checkOutIso: input.checkOutIso,
          adults: input.adults,
          children: input.children,
          pets: input.pets,
        }),
      });

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
      const feesTopline = parsePriceByLabel(html, "Fees");
      const grandTotal = parsePriceByLabel(html, "Total");
      const feeLinesTotal = parseFeeLinesTotal(html);
      const feesTotal = feeLinesTotal ?? feesTopline;

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
        quoteUnavailableReason:
          quoteAvailable || reason === null
            ? null
            : "Dates unavailable for selected stay window",
        baseTotal,
        taxesTotal,
        feesTotal,
        grandTotal,
        currency: "USD",
        handoffUrl: fallbackHandoffUrl,
      };
    } catch (error: unknown) {
      lastFailureReason =
        error instanceof Error ? error.message : "Quote request threw";
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

function resolveRuntimeQuoteContext(input: QuoteExecutionRequest): {
  detailUrl: string;
  quoteContext: Record<string, unknown>;
} {
  const context =
    input.quoteContext &&
    typeof input.quoteContext === "object" &&
    !Array.isArray(input.quoteContext)
      ? { ...input.quoteContext }
      : null;

  const detailUrl = asNonEmptyString(context?.detail_url);
  const unitId = normalizeNumericUnitId(context?.unit_id);

  if (!detailUrl || !unitId) {
    throw new Error(
      `Missing required quoteContext.unit_id/detail_url for ${ADAPTER_KEY} listing ${input.listingId}`,
    );
  }

  return {
    detailUrl,
    quoteContext: {
      ...context,
      detail_url: detailUrl,
      unit_id: unitId,
    },
  };
}

export async function executeOceanreef30aSingleQuote(
  input: QuoteExecutionRequest,
): Promise<QuoteExecutionResult> {
  const fallbackHandoffUrl = buildFallbackHandoffUrl({
    propertyId: null,
    checkInIso: input.checkInIso,
    checkOutIso: input.checkOutIso,
  });

  let runtimeContext: {
    detailUrl: string;
    quoteContext: Record<string, unknown>;
  };
  try {
    runtimeContext = resolveRuntimeQuoteContext(input);
  } catch (error: unknown) {
    return {
      success: false,
      elapsedMs: 0,
      error: {
        code: "QUOTE_CONTEXT_MISSING",
        message:
          error instanceof Error ? error.message : "Quote context missing",
        retryable: false,
        details: {
          adapterKey: ADAPTER_KEY,
          listingId: input.listingId,
          checkInIso: input.checkInIso,
          checkOutIso: input.checkOutIso,
          handoffUrl: fallbackHandoffUrl,
        },
      },
    };
  }

  const startedAt = Date.now();
  const unitId = normalizeNumericUnitId(runtimeContext.quoteContext.unit_id);
  if (!unitId) {
    return {
      success: false,
      elapsedMs: 0,
      error: {
        code: "QUOTE_CONTEXT_MISSING",
        message: `Missing required quoteContext.unit_id for ${ADAPTER_KEY} listing ${input.listingId}`,
        retryable: false,
        details: {
          adapterKey: ADAPTER_KEY,
          listingId: input.listingId,
          checkInIso: input.checkInIso,
          checkOutIso: input.checkOutIso,
          handoffUrl: fallbackHandoffUrl,
        },
      },
    };
  }

  const runtimeHandoffUrl = buildFallbackHandoffUrl({
    propertyId: unitId,
    checkInIso: input.checkInIso,
    checkOutIso: input.checkOutIso,
  });

  try {
    const raw = await fetchQuoteHtml({
      detailUrl: runtimeContext.detailUrl,
      propertyId: unitId,
      checkInIso: input.checkInIso,
      checkOutIso: input.checkOutIso,
      adults: Math.max(1, input.adults),
      children: Math.max(0, input.children),
      pets: DEFAULT_PETS,
    });

    const elapsedMs = Date.now() - startedAt;
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
            checkInIso: input.checkInIso,
            checkOutIso: input.checkOutIso,
            handoffUrl: runtimeHandoffUrl,
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
        currency: raw.currency,
        baseTotal: raw.baseTotal,
        taxesTotal: raw.taxesTotal,
        feesTotalExclTaxes: raw.feesTotal,
        grandTotal: raw.grandTotal,
        quotedTotal: raw.grandTotal,
        handoffUrl: raw.handoffUrl,
      },
    };
  } catch (error: unknown) {
    return {
      success: false,
      elapsedMs: 0,
      error: {
        code: "QUOTE_EXECUTION_FAILED",
        message:
          error instanceof Error ? error.message : "Quote execution failed",
        retryable: false,
        details: {
          adapterKey: ADAPTER_KEY,
          listingId: input.listingId,
          checkInIso: input.checkInIso,
          checkOutIso: input.checkOutIso,
          handoffUrl: runtimeHandoffUrl,
        },
      },
    };
  }
}
