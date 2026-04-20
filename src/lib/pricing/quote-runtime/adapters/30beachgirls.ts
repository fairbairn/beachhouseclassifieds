import type { QuoteExecutionRequest, QuoteExecutionResult } from "../types";

type CartPriceResponse = {
  data?: {
    cartPrice?: {
      cartId?: string;
      creditCard?: {
        totalOfStay?: { total?: number; withDiscount?: number };
        subtotal?: { total?: number; withDiscount?: number };
        taxesAndFees?: { total?: number };
      };
    };
  };
  errors?: Array<{ message?: string; code?: string }>;
};

const ADAPTER_KEY = "30beachgirls" as const;
const GRAPHQL_ENDPOINT =
  "https://arriere.prod.avantstay.com/public/graphql?_q=HomeService_loadPreBookingPriceBreakdown";
const DEFAULT_TIMEOUT_MS = 20000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

function asOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return null;
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

function buildCheckoutUrl(input: {
  listingId: string;
  checkInIso: string;
  checkOutIso: string;
  adults: number;
  children: number;
}): string {
  const params = new URLSearchParams();
  params.set("adults", String(Math.max(1, input.adults)));
  params.set("check-in", input.checkInIso);
  params.set("check-out", input.checkOutIso);
  params.set("guests", String(Math.max(0, input.children)));
  params.set("source", "BEACH_GIRLS");
  return `https://avantstay.com/checkout/${encodeURIComponent(input.listingId)}?${params.toString()}`;
}

function resolveRuntimeQuoteContext(input: QuoteExecutionRequest): {
  listingId: string;
  homeId: string;
} {
  const quoteContext =
    input.quoteContext &&
    typeof input.quoteContext === "object" &&
    !Array.isArray(input.quoteContext)
      ? input.quoteContext
      : null;

  const homeId =
    asOptionalString(quoteContext?.home_id) ??
    asOptionalString(quoteContext?.homeId) ??
    asOptionalString(quoteContext?.id);

  if (!homeId) {
    throw new Error(
      `Missing required quoteContext.home_id for ${ADAPTER_KEY} listing ${input.listingId}`,
    );
  }

  const listingId =
    asOptionalString(quoteContext?.listing_id) ??
    asOptionalString(quoteContext?.hash) ??
    input.listingId;

  return {
    listingId,
    homeId,
  };
}

async function fetchCartPrice(input: {
  homeId: string;
  checkInIso: string;
  checkOutIso: string;
  adults: number;
  children: number;
  signal: AbortSignal;
}): Promise<CartPriceResponse> {
  const query =
    "query($bookingRequest: BookingRequestInput!){ cartPrice(bookingRequest:$bookingRequest){ cartId creditCard { totalOfStay { total withDiscount } subtotal { total withDiscount } taxesAndFees { total } } } }";

  const variables = {
    bookingRequest: {
      homeId: input.homeId,
      from: input.checkInIso,
      until: input.checkOutIso,
      adults: input.adults,
      children: input.children,
      infants: 0,
      guests: Math.max(1, input.adults + input.children),
      pets: 0,
      inputPaymentMode: "CREDIT_CARD",
    },
  };

  const response = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": USER_AGENT,
    },
    body: JSON.stringify({ query, variables }),
    signal: input.signal,
  });

  if (!response.ok) {
    return {
      errors: [
        {
          message: `Quote request failed with status ${response.status}`,
          code: "HTTP_ERROR",
        },
      ],
    };
  }

  return (await response.json()) as CartPriceResponse;
}

export async function execute30beachgirlsSingleQuote(
  input: QuoteExecutionRequest,
): Promise<QuoteExecutionResult> {
  const startedAt = performance.now();
  const timeoutMs = normalizeTimeoutMs(input.options?.timeoutMs);

  let runtimeContext: { listingId: string; homeId: string };
  try {
    runtimeContext = resolveRuntimeQuoteContext(input);
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

  const fallbackHandoffUrl = buildCheckoutUrl({
    listingId: runtimeContext.listingId,
    checkInIso: input.checkInIso,
    checkOutIso: input.checkOutIso,
    adults: Math.max(1, input.adults),
    children: Math.max(0, input.children),
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const payload = await fetchCartPrice({
      homeId: runtimeContext.homeId,
      checkInIso: input.checkInIso,
      checkOutIso: input.checkOutIso,
      adults: Math.max(1, input.adults),
      children: Math.max(0, input.children),
      signal: controller.signal,
    });

    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
      const firstError = payload.errors[0];
      const code = asOptionalString(firstError?.code) ?? "QUOTE_UNAVAILABLE";
      const message =
        asOptionalString(firstError?.message) ?? "Quote unavailable";

      return {
        success: false,
        elapsedMs: performance.now() - startedAt,
        error: toError({
          code,
          message,
          retryable: true,
          listingId: input.listingId,
          checkInIso: input.checkInIso,
          checkOutIso: input.checkOutIso,
          details: {
            handoffUrl: fallbackHandoffUrl,
          },
        }),
      };
    }

    const creditCard = payload.data?.cartPrice?.creditCard;
    const totalOfStay = creditCard?.totalOfStay;
    const subtotal = creditCard?.subtotal;
    const taxesAndFees = creditCard?.taxesAndFees;

    const baseTotalRaw =
      toFiniteNumber(subtotal?.withDiscount) ?? toFiniteNumber(subtotal?.total);
    const grandTotalRaw =
      toFiniteNumber(totalOfStay?.withDiscount) ??
      toFiniteNumber(totalOfStay?.total);
    const taxesTotalRaw = toFiniteNumber(taxesAndFees?.total);

    const baseTotal =
      baseTotalRaw !== null && baseTotalRaw > 0
        ? roundCurrency(baseTotalRaw)
        : null;
    const grandTotal =
      grandTotalRaw !== null && grandTotalRaw > 0
        ? roundCurrency(grandTotalRaw)
        : null;
    const taxesTotal =
      taxesTotalRaw !== null && taxesTotalRaw >= 0
        ? roundCurrency(taxesTotalRaw)
        : null;

    if (baseTotal === null || grandTotal === null) {
      return {
        success: false,
        elapsedMs: performance.now() - startedAt,
        error: toError({
          code: "QUOTE_TOTALS_MISSING",
          message: "Missing quote totals in cartPrice response",
          retryable: true,
          listingId: input.listingId,
          checkInIso: input.checkInIso,
          checkOutIso: input.checkOutIso,
          details: {
            handoffUrl: fallbackHandoffUrl,
          },
        }),
      };
    }

    const feesTotalExclTaxes =
      taxesTotal === null
        ? null
        : roundCurrency(Math.max(grandTotal - baseTotal - taxesTotal, 0));

    return {
      success: true,
      elapsedMs: performance.now() - startedAt,
      observation: {
        startDate: input.checkInIso,
        endDate: input.checkOutIso,
        quoteAvailable: true,
        currency: "USD",
        baseTotal,
        taxesTotal,
        feesTotalExclTaxes,
        grandTotal,
        quotedTotal: grandTotal,
        handoffUrl: fallbackHandoffUrl,
      },
    };
  } catch (error: unknown) {
    return {
      success: false,
      elapsedMs: performance.now() - startedAt,
      error: toError({
        code:
          error instanceof Error && error.name === "AbortError"
            ? "QUOTE_TIMEOUT"
            : "QUOTE_REQUEST_FAILED",
        message:
          error instanceof Error
            ? error.message
            : "Unexpected quote request failure",
        retryable: true,
        listingId: input.listingId,
        checkInIso: input.checkInIso,
        checkOutIso: input.checkOutIso,
        details: {
          handoffUrl: fallbackHandoffUrl,
        },
      }),
    };
  } finally {
    clearTimeout(timer);
  }
}
