import type { QuoteExecutionRequest, QuoteExecutionResult } from "../types";

type ExclusiveFeeLine = {
  name?: unknown;
  value?: unknown;
};

type ExclusiveQuoteBody = {
  result?: unknown;
  nightlyRates?: unknown;
  guestDiscountedRent?: unknown;
  otherChargesTotal?: unknown;
  otherChargesItemized?: unknown;
  serviceFeeTotal?: unknown;
  taxes?: unknown;
  grandTotal?: unknown;
  bookingURL?: unknown;
  cid?: unknown;
  message?: unknown;
  errors?: unknown;
  promoCode?: unknown;
};

type ExclusiveQuoteResponse = {
  body?: ExclusiveQuoteBody;
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

const ADAPTER_KEY = "exclusive30a" as const;
const BASE_HOST = "https://www.exclusive30a.com";
const QUOTE_ENDPOINT = `${BASE_HOST}/quote`;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

function parseCurrencyLike(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return roundCurrency(value);
  }

  if (typeof value === "string") {
    const parsed = Number(value.replace(/[^0-9.-]/g, "").trim());
    if (Number.isFinite(parsed)) {
      return roundCurrency(parsed);
    }
  }

  return null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeNumericPropertyId(value: unknown): string | null {
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

function stripHtml(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseUnavailableReason(value: unknown): string | null {
  if (typeof value === "string") {
    const cleaned = stripHtml(value);
    return cleaned.length > 0 ? cleaned : null;
  }

  if (Array.isArray(value)) {
    const cleaned = value
      .map((entry) => (typeof entry === "string" ? stripHtml(entry) : ""))
      .filter((entry) => entry.length > 0)
      .join(" ")
      .trim();
    return cleaned.length > 0 ? cleaned : null;
  }

  return null;
}

function parseFeeLinesTotal(body: ExclusiveQuoteBody): number | null {
  const lines: Array<{ name: string; amount: number }> = [];

  const itemized = body.otherChargesItemized;
  if (Array.isArray(itemized)) {
    for (const rawLine of itemized) {
      if (!rawLine || typeof rawLine !== "object") {
        continue;
      }
      const line = rawLine as ExclusiveFeeLine;
      const name = asString(line.name).trim() || "Fee";
      const amount = parseCurrencyLike(line.value);
      if (!name || amount === null || amount < 0) {
        continue;
      }
      lines.push({ name, amount });
    }
  }

  const serviceFee = parseCurrencyLike(body.serviceFeeTotal);
  if (serviceFee !== null && serviceFee > 0) {
    lines.push({ name: "Service Fee", amount: serviceFee });
  }

  if (lines.length === 0) {
    return null;
  }

  return roundCurrency(lines.reduce((sum, line) => sum + line.amount, 0));
}

function buildFallbackHandoffUrl(input: {
  startDate: string;
  endDate: string;
  listingId: string;
  adults: number;
  promoCode: string;
  cid: string;
  nights: number;
}): string {
  const params = new URLSearchParams();
  params.set("arrival", input.startDate);
  params.set("departure", input.endDate);
  params.set("pid", input.listingId);
  params.set("numberOfAdult", String(Math.max(1, input.adults)));
  params.set("promoCode", input.promoCode);
  params.set("cid", input.cid);
  params.set("nights", String(input.nights));
  return `${BASE_HOST}/booking/review?${params.toString()}`;
}

async function fetchQuote(input: {
  detailUrl: string;
  listingId: string;
  startDate: string;
  endDate: string;
  nights: number;
  adults: number;
  children: number;
  pets: number;
  promoCode: string;
}): Promise<RawObservation> {
  const params = new URLSearchParams();
  params.set("arrival", input.startDate);
  params.set("departure", input.endDate);
  params.set("pid", input.listingId);
  params.set("numberOfAdult", String(Math.max(1, input.adults)));
  params.set("numberOfChild", String(Math.max(0, input.children)));
  params.set("numberOfPets", String(Math.max(0, input.pets)));
  params.set("travelInsurance", "");
  params.set("nights", String(input.nights));
  params.set("promoCode", input.promoCode);

  const fallbackHandoffUrl = buildFallbackHandoffUrl({
    startDate: input.startDate,
    endDate: input.endDate,
    listingId: input.listingId,
    adults: input.adults,
    promoCode: input.promoCode,
    cid: "",
    nights: input.nights,
  });

  const response = await fetch(`${QUOTE_ENDPOINT}?${params.toString()}`, {
    method: "GET",
    headers: {
      accept: "application/json, text/javascript, */*; q=0.01",
      "x-requested-with": "XMLHttpRequest",
      "user-agent": USER_AGENT,
      referer: input.detailUrl,
    },
  });

  if (!response.ok) {
    return {
      startDate: input.startDate,
      endDate: input.endDate,
      quoteAvailable: false,
      quoteUnavailableReason: `Quote request failed with status ${response.status}`,
      baseTotal: null,
      taxesTotal: null,
      feesTotal: null,
      grandTotal: null,
      currency: "USD",
      handoffUrl: fallbackHandoffUrl,
    };
  }

  let parsed: ExclusiveQuoteResponse;
  try {
    parsed = (await response.json()) as ExclusiveQuoteResponse;
  } catch {
    return {
      startDate: input.startDate,
      endDate: input.endDate,
      quoteAvailable: false,
      quoteUnavailableReason: "Quote endpoint returned invalid JSON",
      baseTotal: null,
      taxesTotal: null,
      feesTotal: null,
      grandTotal: null,
      currency: "USD",
      handoffUrl: fallbackHandoffUrl,
    };
  }

  const body = parsed.body ?? {};
  const result = asString(body.result).toLowerCase();

  const baseTotal =
    parseCurrencyLike(body.guestDiscountedRent) ??
    parseCurrencyLike(body.nightlyRates);
  const taxesTotal = parseCurrencyLike(body.taxes);
  const feesTotal =
    parseCurrencyLike(body.otherChargesTotal) ?? parseFeeLinesTotal(body);
  const grandTotal = parseCurrencyLike(body.grandTotal);

  const cidRaw = body.cid;
  const cid =
    typeof cidRaw === "string" || typeof cidRaw === "number"
      ? String(cidRaw)
      : "";
  const handoffUrl =
    asString(body.bookingURL).trim() ||
    buildFallbackHandoffUrl({
      startDate: input.startDate,
      endDate: input.endDate,
      listingId: input.listingId,
      adults: input.adults,
      promoCode: asString(body.promoCode).trim() || input.promoCode,
      cid,
      nights: input.nights,
    });

  if (result !== "success") {
    const reason =
      parseUnavailableReason(body.errors) ??
      parseUnavailableReason(body.message) ??
      "Dates unavailable for selected stay window";

    return {
      startDate: input.startDate,
      endDate: input.endDate,
      quoteAvailable: false,
      quoteUnavailableReason: reason,
      baseTotal,
      taxesTotal,
      feesTotal,
      grandTotal,
      currency: "USD",
      handoffUrl,
    };
  }

  return {
    startDate: input.startDate,
    endDate: input.endDate,
    quoteAvailable:
      baseTotal !== null &&
      baseTotal > 0 &&
      grandTotal !== null &&
      grandTotal > 0,
    quoteUnavailableReason: null,
    baseTotal,
    taxesTotal,
    feesTotal,
    grandTotal,
    currency: "USD",
    handoffUrl,
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
  const propertyId = normalizeNumericPropertyId(context?.property_id);

  if (!detailUrl || !propertyId) {
    throw new Error(
      `Missing required quoteContext.property_id/detail_url for ${ADAPTER_KEY} listing ${input.listingId}`,
    );
  }

  return {
    detailUrl,
    quoteContext: {
      ...context,
      detail_url: detailUrl,
      property_id: propertyId,
    },
  };
}

export async function executeExclusive30aSingleQuote(
  input: QuoteExecutionRequest,
): Promise<QuoteExecutionResult> {
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
        },
      },
    };
  }

  const startedAt = Date.now();
  const propertyId = normalizeNumericPropertyId(
    runtimeContext.quoteContext.property_id,
  );
  if (!propertyId) {
    return {
      success: false,
      elapsedMs: 0,
      error: {
        code: "QUOTE_CONTEXT_MISSING",
        message: `Missing required quoteContext.property_id for ${ADAPTER_KEY} listing ${input.listingId}`,
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

  try {
    const nights = Math.max(
      1,
      Math.round(
        (new Date(`${input.checkOutIso}T00:00:00.000Z`).getTime() -
          new Date(`${input.checkInIso}T00:00:00.000Z`).getTime()) /
          86400000,
      ),
    );

    const raw = await fetchQuote({
      detailUrl: runtimeContext.detailUrl,
      listingId: propertyId,
      startDate: input.checkInIso,
      endDate: input.checkOutIso,
      nights,
      adults: Math.max(1, Math.floor(input.adults)),
      children: Math.max(0, Math.floor(input.children)),
      pets: 0,
      promoCode: "",
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
        },
      },
    };
  }
}
