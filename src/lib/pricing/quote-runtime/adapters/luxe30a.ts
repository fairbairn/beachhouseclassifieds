import type { QuoteExecutionRequest, QuoteExecutionResult } from "../types";

type LuxeQuoteContext = {
  listingId: string;
  detailUrl: string;
};

type LuxeMoney = {
  currency?: unknown;
  fareAccommodation?: unknown;
  fareAccommodationAdjusted?: unknown;
  totalFees?: unknown;
  totalTaxes?: unknown;
  hostPayout?: unknown;
  hostPayoutUsd?: unknown;
  subTotalPrice?: unknown;
};

type LuxeQuoteResponse = {
  status?: unknown;
  checkInDateLocalized?: unknown;
  checkOutDateLocalized?: unknown;
  unitTypeId?: unknown;
  rates?: {
    ratePlans?: Array<{
      ratePlan?: {
        money?: LuxeMoney;
      };
    }>;
  };
  stay?: Array<{
    checkInDateLocalized?: unknown;
    checkOutDateLocalized?: unknown;
    unitTypeId?: unknown;
  }>;
};

const ADAPTER_KEY = "luxe30a" as const;
const DEFAULT_TIMEOUT_MS = 20000;
const GUESTY_QUOTES_ENDPOINT =
  "https://app.guesty.com/api/pm-websites-backend/reservations/quotes";
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";
const DEFAULT_X_REQUEST_CONTEXT = {
  v: 1,
  w: 1973369,
  s: "xqkii9nw",
  u: "9319cb88",
  h: "2b1d3d38c9877de12ec05b9bbb3b1bc4",
};

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
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function roundMoney(value: number | null): number | null {
  if (value === null) {
    return null;
  }
  return Math.round(value * 100) / 100;
}

function buildXRequestContextHeader(): string {
  const payload = {
    v: DEFAULT_X_REQUEST_CONTEXT.v,
    w: Number(
      process.env.LUXE30A_REQUEST_CONTEXT_W ?? DEFAULT_X_REQUEST_CONTEXT.w,
    ),
    s: process.env.LUXE30A_REQUEST_CONTEXT_S ?? DEFAULT_X_REQUEST_CONTEXT.s,
    u: process.env.LUXE30A_REQUEST_CONTEXT_U ?? DEFAULT_X_REQUEST_CONTEXT.u,
    h: process.env.LUXE30A_REQUEST_CONTEXT_H ?? DEFAULT_X_REQUEST_CONTEXT.h,
  };

  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

function normalizeTimeoutMs(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.max(1000, Math.floor(raw));
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

function normalizeListingId(raw: unknown): string | null {
  const value = asString(raw);
  if (!value) {
    return null;
  }

  // Guesty listing IDs are typically 24-char hex IDs.
  if (!/^[a-f0-9]{24}$/i.test(value)) {
    return null;
  }

  return value;
}

function buildDetailUrl(listingId: string): string {
  return `https://luxe30a.guestybookings.com/en/properties/${listingId}`;
}

function buildHandoffUrl(input: {
  detailUrl: string;
  listingId: string;
  checkInIso: string;
  checkOutIso: string;
  adults: number;
  children: number;
}): string {
  const parsed = new URL(input.detailUrl || buildDetailUrl(input.listingId));
  parsed.searchParams.set(
    "minOccupancy",
    String(Math.max(1, input.adults + input.children)),
  );
  parsed.searchParams.set("checkIn", input.checkInIso);
  parsed.searchParams.set("checkOut", input.checkOutIso);
  return parsed.toString();
}

function extractQuoteContext(input: QuoteExecutionRequest): LuxeQuoteContext {
  const context =
    input.quoteContext &&
    typeof input.quoteContext === "object" &&
    !Array.isArray(input.quoteContext)
      ? input.quoteContext
      : null;

  const listingId =
    normalizeListingId(context?.listing_id) ??
    normalizeListingId(context?.unit_id) ??
    normalizeListingId(context?.unitTypeId) ??
    normalizeListingId(input.listingId);

  if (!listingId) {
    throw new Error(
      `Missing required listing ID for ${ADAPTER_KEY} listing ${input.listingId}`,
    );
  }

  const detailUrl = asString(context?.detail_url) ?? buildDetailUrl(listingId);

  return {
    listingId,
    detailUrl,
  };
}

export async function executeLuxe30aSingleQuote(
  input: QuoteExecutionRequest,
): Promise<QuoteExecutionResult> {
  const startedAt = performance.now();
  const timeoutMs = normalizeTimeoutMs(input.options?.timeoutMs);

  let quoteContext: LuxeQuoteContext;
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

  const runtimeHandoffUrl = buildHandoffUrl({
    detailUrl: quoteContext.detailUrl,
    listingId: quoteContext.listingId,
    checkInIso: input.checkInIso,
    checkOutIso: input.checkOutIso,
    adults: input.adults,
    children: input.children,
  });

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  const xRequestContext = buildXRequestContextHeader();

  let response: Response;
  let bodyText = "";
  try {
    response = await fetch(GUESTY_QUOTES_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/plain, */*",
        origin: "https://luxe30a.guestybookings.com",
        "user-agent": BROWSER_USER_AGENT,
        "x-request-context": xRequestContext,
      },
      body: JSON.stringify({
        checkInDateLocalized: input.checkInIso,
        checkOutDateLocalized: input.checkOutIso,
        guestsCount: String(Math.max(1, input.adults + input.children)),
        listingId: quoteContext.listingId,
      }),
      signal: controller.signal,
    });

    bodyText = await response.text();
  } catch (error: unknown) {
    clearTimeout(timeoutHandle);

    const message =
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
        message,
        retryable: true,
        listingId: input.listingId,
        checkInIso: input.checkInIso,
        checkOutIso: input.checkOutIso,
        details: {
          handoff_url: runtimeHandoffUrl,
        },
      }),
    };
  } finally {
    clearTimeout(timeoutHandle);
  }

  let payload: LuxeQuoteResponse | null = null;
  try {
    payload = JSON.parse(bodyText) as LuxeQuoteResponse;
  } catch {
    payload = null;
  }

  if (!response.ok || payload === null) {
    const message =
      payload === null
        ? `Quote request returned empty or non-JSON body with status ${response.status}`
        : `Quote request failed with status ${response.status}`;
    return {
      success: false,
      elapsedMs: performance.now() - startedAt,
      error: toError({
        code: "QUOTE_HTTP_ERROR",
        message,
        retryable: response.status >= 500 || response.status === 429,
        listingId: input.listingId,
        checkInIso: input.checkInIso,
        checkOutIso: input.checkOutIso,
        details: {
          status: response.status,
          response_preview: bodyText.slice(0, 220),
          handoff_url: runtimeHandoffUrl,
        },
      }),
    };
  }

  const status = asString(payload.status)?.toLowerCase() ?? "";
  const money = payload.rates?.ratePlans?.[0]?.ratePlan?.money;
  const baseTotal =
    toFiniteNumber(money?.fareAccommodationAdjusted) ??
    toFiniteNumber(money?.fareAccommodation);
  const taxesTotal = toFiniteNumber(money?.totalTaxes);
  const feesTotalExclTaxes = toFiniteNumber(money?.totalFees);
  const grandTotal =
    toFiniteNumber(money?.hostPayout) ?? toFiniteNumber(money?.hostPayoutUsd);
  const quotedTotal =
    grandTotal ??
    toFiniteNumber(money?.subTotalPrice) ??
    (baseTotal !== null && taxesTotal !== null && feesTotalExclTaxes !== null
      ? baseTotal + taxesTotal + feesTotalExclTaxes
      : null);

  const roundedBase = roundMoney(baseTotal);
  const roundedTaxes = roundMoney(taxesTotal);
  const roundedFees = roundMoney(feesTotalExclTaxes);
  const roundedGrand = roundMoney(grandTotal);
  const roundedQuoted = roundMoney(quotedTotal);

  const availableTotals = roundedBase !== null && roundedQuoted !== null;
  const quoteAvailable =
    status === "valid"
      ? availableTotals
      : status.length === 0 && availableTotals;

  return {
    success: true,
    elapsedMs: performance.now() - startedAt,
    observation: {
      startDate:
        asString(payload.checkInDateLocalized) ??
        asString(payload.stay?.[0]?.checkInDateLocalized) ??
        input.checkInIso,
      endDate:
        asString(payload.checkOutDateLocalized) ??
        asString(payload.stay?.[0]?.checkOutDateLocalized) ??
        input.checkOutIso,
      quoteAvailable,
      quoteUnavailableReason: quoteAvailable
        ? null
        : `quote_status_${status || "unknown"}`,
      currency: asString(money?.currency) ?? "USD",
      baseTotal: quoteAvailable ? roundedBase : null,
      taxesTotal: quoteAvailable ? roundedTaxes : null,
      feesTotalExclTaxes: quoteAvailable ? roundedFees : null,
      grandTotal: quoteAvailable ? (roundedGrand ?? roundedQuoted) : null,
      quotedTotal: quoteAvailable ? (roundedQuoted ?? roundedGrand) : null,
      handoffUrl: runtimeHandoffUrl,
    },
  };
}
