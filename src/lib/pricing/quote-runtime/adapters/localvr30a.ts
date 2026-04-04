import type { QuoteExecutionRequest, QuoteExecutionResult } from "../types";

type LocalVrInvoiceItem = {
  title?: unknown;
  type?: unknown;
  amount?: unknown;
};

type LocalVrMoney = {
  currency?: unknown;
  fareAccommodation?: unknown;
  fareAccommodationAdjusted?: unknown;
  totalFees?: unknown;
  totalTaxes?: unknown;
  hostPayout?: unknown;
  invoiceItems?: unknown;
};

type LocalVrQuoteRecord = {
  _id?: unknown;
  checkInDateLocalized?: unknown;
  checkOutDateLocalized?: unknown;
  rates?: {
    ratePlans?: Array<{
      ratePlan?: {
        money?: LocalVrMoney;
      };
    }>;
  };
  stay?: Array<{
    checkInDateLocalized?: unknown;
    checkOutDateLocalized?: unknown;
  }>;
};

type LocalVrErrorPayload = {
  error?: {
    code?: unknown;
    message?: unknown;
  };
};

type LocalVrQuoteContext = {
  listingId: string;
  detailUrl: string;
};

const ADAPTER_KEY = "localvr30a" as const;
const DEFAULT_NEXT_ACTION = "40c1a0d7c1ff53bb657668b83335272ee28af08351";
const DEFAULT_TIMEOUT_MS = 20000;
const MIN_VALID_BASE_TOTAL = 100;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function parseFlightObjects(text: string): Array<Record<string, unknown>> {
  const objects: Array<Record<string, unknown>> = [];
  for (const line of text.split("\n")) {
    const match = line.match(/^\d+:\s*(\{.*\})\s*$/);
    if (!match?.[1]) {
      continue;
    }

    try {
      const parsed = JSON.parse(match[1]) as unknown;
      if (parsed && typeof parsed === "object") {
        objects.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Ignore non-JSON flight rows.
    }
  }
  return objects;
}

function pickQuoteRecord(
  rows: Array<Record<string, unknown>>,
): LocalVrQuoteRecord | null {
  for (const row of rows) {
    const candidate = row as LocalVrQuoteRecord;
    if (!candidate._id) {
      continue;
    }
    if (candidate.rates || candidate.stay) {
      return candidate;
    }
  }
  return null;
}

function pickErrorRecord(
  rows: Array<Record<string, unknown>>,
): LocalVrErrorPayload | null {
  for (const row of rows) {
    const candidate = row as LocalVrErrorPayload;
    if (candidate.error && typeof candidate.error === "object") {
      return candidate;
    }
  }
  return null;
}

function normalizeTimeoutMs(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.max(1000, Math.floor(raw));
}

function validateAvailableTotals(input: {
  baseTotal: number | null;
  taxesTotal: number | null;
  feesTotal: number | null;
  grandTotal: number | null;
}): string | null {
  if (input.baseTotal === null || input.baseTotal < MIN_VALID_BASE_TOTAL) {
    return `base_total_below_minimum(${MIN_VALID_BASE_TOTAL})`;
  }

  if (input.taxesTotal === null || input.taxesTotal <= 0) {
    return "taxes_total_not_positive";
  }

  if (input.grandTotal === null || input.grandTotal <= input.baseTotal) {
    return "grand_total_not_greater_than_base_total";
  }

  if (input.feesTotal === null) {
    return "fees_total_missing";
  }

  if (input.feesTotal < 0) {
    return "fees_total_negative";
  }

  if (input.feesTotal >= input.baseTotal) {
    return "fees_total_gte_base_total";
  }

  return null;
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

function buildPropertyQuoteUrl(input: {
  detailUrl: string;
  adults: number;
  children: number;
  checkInDate: string;
  checkOutDate: string;
}): string {
  const parsed = new URL(input.detailUrl);
  parsed.searchParams.set(
    "guests",
    String(Math.max(1, input.adults + input.children)),
  );
  parsed.searchParams.set("adults", String(Math.max(1, input.adults)));
  parsed.searchParams.set("children", String(Math.max(0, input.children)));
  parsed.searchParams.set("infants", "0");
  parsed.searchParams.set("checkIn", input.checkInDate);
  parsed.searchParams.set("checkOut", input.checkOutDate);
  return parsed.toString();
}

function buildHandoffUrl(input: {
  detailUrl: string;
  quoteId: string;
  listingId: string;
  adults: number;
  children: number;
  checkInDate: string;
  checkOutDate: string;
}): string {
  const origin = new URL(input.detailUrl).origin;
  const params = new URLSearchParams();
  params.set("property", input.listingId);
  params.set("adults", String(Math.max(1, input.adults)));
  params.set("children", String(Math.max(0, input.children)));
  params.set("infants", "0");
  params.set("checkIn", input.checkInDate);
  params.set("checkOut", input.checkOutDate);
  return `${origin}/checkout/${input.quoteId}/payment?${params.toString()}`;
}

function extractQuoteContext(
  input: QuoteExecutionRequest,
): LocalVrQuoteContext {
  const context =
    input.quoteContext &&
    typeof input.quoteContext === "object" &&
    !Array.isArray(input.quoteContext)
      ? input.quoteContext
      : null;

  const listingId =
    asString(context?.listing_id) ??
    asString(context?.property_id) ??
    asString(context?.unit_id);
  if (!listingId) {
    throw new Error(
      `Missing required quoteContext.listing_id for ${ADAPTER_KEY} listing ${input.listingId}`,
    );
  }

  const detailUrl = asString(context?.detail_url);
  if (!detailUrl) {
    throw new Error(
      `Missing required quoteContext.detail_url for ${ADAPTER_KEY} listing ${input.listingId}`,
    );
  }

  return {
    listingId,
    detailUrl,
  };
}

export async function executeLocalvr30aSingleQuote(
  input: QuoteExecutionRequest,
): Promise<QuoteExecutionResult> {
  const startedAt = performance.now();
  const timeoutMs = normalizeTimeoutMs(input.options?.timeoutMs);

  let quoteContext: LocalVrQuoteContext;
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

  const endpoint = buildPropertyQuoteUrl({
    detailUrl: quoteContext.detailUrl,
    adults: input.adults,
    children: input.children,
    checkInDate: input.checkInIso,
    checkOutDate: input.checkOutIso,
  });

  const guestsTotal = Math.max(1, input.adults + input.children);
  const form = new FormData();
  form.append("1_listingId", quoteContext.listingId);
  form.append("1_checkIn", input.checkInIso);
  form.append("1_checkOut", input.checkOutIso);
  form.append("1_guests", String(guestsTotal));
  form.append("1_guests[adults]", String(Math.max(1, input.adults)));
  form.append("1_guests[children]", String(Math.max(0, input.children)));
  form.append("1_guests[infants]", "0");
  form.append("0", '["$K1"]');

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  let body = "";
  let rows: Array<Record<string, unknown>> = [];

  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "next-action":
          process.env.LOCALVR30A_NEXT_ACTION?.trim() || DEFAULT_NEXT_ACTION,
        "user-agent": USER_AGENT,
      },
      body: form,
      signal: controller.signal,
    });

    body = await response.text();
    rows = parseFlightObjects(body);
  } catch (error: unknown) {
    clearTimeout(timeoutHandle);

    const errorMessage =
      error instanceof Error && error.name === "AbortError"
        ? `Quote request timed out after ${timeoutMs}ms`
        : error instanceof Error
          ? error.message
          : "Quote request failed";

    return {
      success: false,
      elapsedMs: performance.now() - startedAt,
      error: toError({
        code:
          error instanceof Error && error.name === "AbortError"
            ? "QUOTE_TIMEOUT"
            : "QUOTE_REQUEST_FAILED",
        message: errorMessage,
        retryable: true,
        listingId: input.listingId,
        checkInIso: input.checkInIso,
        checkOutIso: input.checkOutIso,
      }),
    };
  } finally {
    clearTimeout(timeoutHandle);
  }

  const quote = pickQuoteRecord(rows);
  const errorPayload = pickErrorRecord(rows);
  const errorCode = asString(errorPayload?.error?.code);
  const errorMessage = asString(errorPayload?.error?.message);

  if (!response.ok || !quote) {
    const reasonParts = [] as string[];
    if (!response.ok) {
      reasonParts.push(`http_${response.status}`);
    }
    if (errorCode) {
      reasonParts.push(errorCode);
    }
    if (errorMessage) {
      reasonParts.push(errorMessage);
    }

    return {
      success: true,
      elapsedMs: performance.now() - startedAt,
      observation: {
        startDate: input.checkInIso,
        endDate: input.checkOutIso,
        quoteAvailable: false,
        quoteUnavailableReason:
          reasonParts.join("; ") || "quote_response_missing_or_invalid",
        currency: "USD",
        baseTotal: null,
        taxesTotal: null,
        feesTotalExclTaxes: null,
        grandTotal: null,
        quotedTotal: null,
        handoffUrl: null,
      },
    };
  }

  const money = quote.rates?.ratePlans?.[0]?.ratePlan?.money;
  const currency = asString(money?.currency) ?? "USD";
  const baseTotal =
    toFiniteNumber(money?.fareAccommodationAdjusted) ??
    toFiniteNumber(money?.fareAccommodation);
  const taxesTotal = toFiniteNumber(money?.totalTaxes);
  const feesTotal = toFiniteNumber(money?.totalFees);
  const grandTotal = toFiniteNumber(money?.hostPayout);

  const invoiceItems = Array.isArray(money?.invoiceItems)
    ? (money?.invoiceItems as LocalVrInvoiceItem[])
    : [];
  const feeLines: Array<{ name: string; amount: number }> = [];
  for (const item of invoiceItems) {
    const name = asString(item.title);
    const type = asString(item.type);
    const amount = toFiniteNumber(item.amount);
    if (!name || amount === null) {
      continue;
    }
    if (type === "TAX" || type === "ACCOMMODATION_FARE") {
      continue;
    }
    feeLines.push({ name, amount: roundCurrency(amount) });
  }

  const quoteId = asString(quote._id);
  const handoffUrl =
    quoteId === null
      ? endpoint
      : buildHandoffUrl({
          detailUrl: quoteContext.detailUrl,
          quoteId,
          listingId: quoteContext.listingId,
          adults: input.adults,
          children: input.children,
          checkInDate:
            asString(quote.checkInDateLocalized) ??
            asString(quote.stay?.[0]?.checkInDateLocalized) ??
            input.checkInIso,
          checkOutDate:
            asString(quote.checkOutDateLocalized) ??
            asString(quote.stay?.[0]?.checkOutDateLocalized) ??
            input.checkOutIso,
        });

  const roundedBase = baseTotal === null ? null : roundCurrency(baseTotal);
  const roundedTaxes = taxesTotal === null ? null : roundCurrency(taxesTotal);
  const roundedFees = feesTotal === null ? null : roundCurrency(feesTotal);
  const roundedGrand = grandTotal === null ? null : roundCurrency(grandTotal);
  const unavailableReason = validateAvailableTotals({
    baseTotal: roundedBase,
    taxesTotal: roundedTaxes,
    feesTotal: roundedFees,
    grandTotal: roundedGrand,
  });
  const available = unavailableReason === null;

  return {
    success: true,
    elapsedMs: performance.now() - startedAt,
    observation: {
      startDate: input.checkInIso,
      endDate: input.checkOutIso,
      quoteAvailable: available,
      quoteUnavailableReason: available ? null : unavailableReason,
      currency,
      baseTotal: available ? roundedBase : null,
      taxesTotal: available ? roundedTaxes : null,
      feesTotalExclTaxes: available ? roundedFees : null,
      grandTotal: available ? roundedGrand : null,
      quotedTotal: available ? roundedGrand : null,
      handoffUrl,
    },
  };
}
