import type { QuoteExecutionRequest, QuoteExecutionResult } from "../types";

type KeycoPricingContextResponse = {
  pricing?: {
    isAvailable?: boolean;
    totalBaseRate?: number | null;
    taxes?: number | null;
    pricingFees?: Array<{
      amount?: number | null;
      description?: string | null;
    }> | null;
    errorMessage?: string | null;
    handoffUrl?: string | null;
    checkoutUrl?: string | null;
    bookingUrl?: string | null;
    bookNowUrl?: string | null;
    bookingContextId?: string | null;
    bookingContext?: {
      id?: string | null;
      bookingContextId?: string | null;
    } | null;
  } | null;
  isAvailable?: boolean;
  totalBaseRate?: number | null;
  taxes?: number | null;
  pricingFees?: Array<{
    amount?: number | null;
    description?: string | null;
  }> | null;
  errorMessage?: string | null;
  handoffUrl?: string | null;
  checkoutUrl?: string | null;
  bookingUrl?: string | null;
  bookNowUrl?: string | null;
  bookingContextId?: string | null;
  bookingContext?: {
    id?: string | null;
    bookingContextId?: string | null;
  } | null;
};

const ADAPTER_KEY = "keyco30a" as const;
const BASE_HOST = "https://key.co";
const DEFAULT_TIMEOUT_MS = 5000;

function normalizeTimeoutMs(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.max(1000, Math.floor(raw));
}

function toPositiveInt(input: number, fallback: number): number {
  if (!Number.isFinite(input)) {
    return fallback;
  }
  return Math.max(1, Math.floor(input));
}

function toNonNegativeInt(input: number, fallback: number): number {
  if (!Number.isFinite(input)) {
    return fallback;
  }
  return Math.max(0, Math.floor(input));
}

function normalizePossibleUrl(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return null;
  }

  try {
    return new URL(raw, BASE_HOST).toString();
  } catch {
    return null;
  }
}

function normalizePossibleToken(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return null;
  }

  return /^[A-Za-z0-9_-]{4,128}$/.test(raw) ? raw : null;
}

function extractBookingContextIdFromUrl(value: string | null): string | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = new URL(value);
    return (
      normalizePossibleToken(parsed.searchParams.get("bookingContextId")) ??
      normalizePossibleToken(parsed.searchParams.get("booking_context_id"))
    );
  } catch {
    return null;
  }
}

function resolveBookingContextId(input: {
  pricingNode:
    | KeycoPricingContextResponse["pricing"]
    | KeycoPricingContextResponse
    | null
    | undefined;
  body: KeycoPricingContextResponse | null;
  directUrl: string | null;
}): string | null {
  return (
    normalizePossibleToken(input.pricingNode?.bookingContextId) ??
    normalizePossibleToken(
      input.pricingNode?.bookingContext?.bookingContextId,
    ) ??
    normalizePossibleToken(input.pricingNode?.bookingContext?.id) ??
    normalizePossibleToken(input.body?.bookingContextId) ??
    normalizePossibleToken(input.body?.bookingContext?.bookingContextId) ??
    normalizePossibleToken(input.body?.bookingContext?.id) ??
    extractBookingContextIdFromUrl(input.directUrl)
  );
}

function resolveDetailUrl(input: QuoteExecutionRequest): string {
  const fromContext =
    input.quoteContext &&
    typeof input.quoteContext === "object" &&
    !Array.isArray(input.quoteContext) &&
    typeof input.quoteContext.detail_url === "string"
      ? input.quoteContext.detail_url.trim()
      : "";

  if (fromContext) {
    return fromContext;
  }

  return `${BASE_HOST}/listings/${input.listingId}`;
}

function buildCheckoutUrl(input: {
  listingId: string;
  checkInIso: string;
  checkOutIso: string;
  adults: number;
  children: number;
  bookingContextId: string | null;
}): string {
  const url = new URL(
    `https://itinerary.key.co/listings/${input.listingId}/checkout`,
  );
  url.searchParams.set("listing_start_date", input.checkInIso);
  url.searchParams.set("listing_end_date", input.checkOutIso);
  url.searchParams.set("listing_adult_count", String(input.adults));
  url.searchParams.set("listing_child_count", String(input.children));
  url.searchParams.set("listing_infant_count", "0");
  url.searchParams.set("listing_pet_count", "0");
  if (input.bookingContextId) {
    url.searchParams.set("bookingContextId", input.bookingContextId);
  }
  return url.toString();
}

function resolveHandoffUrl(input: {
  listingId: string;
  detailUrl: string;
  checkInIso: string;
  checkOutIso: string;
  adults: number;
  children: number;
  pricingNode:
    | KeycoPricingContextResponse["pricing"]
    | KeycoPricingContextResponse
    | null
    | undefined;
  body: KeycoPricingContextResponse | null;
}): string {
  const direct =
    normalizePossibleUrl(input.pricingNode?.handoffUrl) ??
    normalizePossibleUrl(input.pricingNode?.checkoutUrl) ??
    normalizePossibleUrl(input.pricingNode?.bookingUrl) ??
    normalizePossibleUrl(input.pricingNode?.bookNowUrl) ??
    normalizePossibleUrl(input.body?.handoffUrl) ??
    normalizePossibleUrl(input.body?.checkoutUrl) ??
    normalizePossibleUrl(input.body?.bookingUrl) ??
    normalizePossibleUrl(input.body?.bookNowUrl);

  if (direct && /\/checkout/i.test(direct)) {
    return direct;
  }

  const bookingContextId = resolveBookingContextId({
    pricingNode: input.pricingNode,
    body: input.body,
    directUrl: direct,
  });

  return buildCheckoutUrl({
    listingId: input.listingId,
    checkInIso: input.checkInIso,
    checkOutIso: input.checkOutIso,
    adults: input.adults,
    children: input.children,
    bookingContextId,
  });
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

export async function executeKeyco30aSingleQuote(
  input: QuoteExecutionRequest,
): Promise<QuoteExecutionResult> {
  const startedAt = performance.now();
  const timeoutMs = normalizeTimeoutMs(input.options?.timeoutMs);

  const adults = toPositiveInt(input.adults, 1);
  const children = toNonNegativeInt(input.children, 0);

  const params = new URLSearchParams({
    startDate: input.checkInIso,
    endDate: input.checkOutIso,
    adultCount: String(adults),
    childCount: String(children),
    infantCount: "0",
    petCount: "0",
  });

  const endpoint = `${BASE_HOST}/api/listing/${input.listingId}/pricing-context?${params.toString()}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: "GET",
      headers: {
        accept: "application/json, text/plain, */*",
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        success: false,
        elapsedMs: performance.now() - startedAt,
        error: toError({
          code: "QUOTE_HTTP_ERROR",
          message: `Quote request failed with status ${response.status}`,
          retryable: response.status >= 500 || response.status === 429,
          listingId: input.listingId,
          checkInIso: input.checkInIso,
          checkOutIso: input.checkOutIso,
          details: {
            status: response.status,
          },
        }),
      };
    }

    let body: KeycoPricingContextResponse | null = null;
    try {
      body = (await response.json()) as KeycoPricingContextResponse;
    } catch {
      return {
        success: false,
        elapsedMs: performance.now() - startedAt,
        error: toError({
          code: "QUOTE_RESPONSE_INVALID",
          message: "Quote response is not valid JSON",
          retryable: false,
          listingId: input.listingId,
          checkInIso: input.checkInIso,
          checkOutIso: input.checkOutIso,
        }),
      };
    }

    const pricingNode =
      body?.pricing && typeof body.pricing === "object" ? body.pricing : body;

    const baseTotal = Number(pricingNode?.totalBaseRate);
    const taxesTotalRaw = Number(pricingNode?.taxes);
    const hasRate = Number.isFinite(baseTotal) && baseTotal > 0;
    const isAvailable =
      typeof pricingNode?.isAvailable === "boolean"
        ? pricingNode.isAvailable
        : typeof body?.isAvailable === "boolean"
          ? body.isAvailable
          : hasRate;

    if (!isAvailable || !hasRate) {
      const message =
        typeof pricingNode?.errorMessage === "string" &&
        pricingNode.errorMessage.trim().length > 0
          ? pricingNode.errorMessage.trim()
          : "Quote unavailable for selected stay window";

      return {
        success: false,
        elapsedMs: performance.now() - startedAt,
        error: toError({
          code: "QUOTE_UNAVAILABLE",
          message,
          retryable: false,
          listingId: input.listingId,
          checkInIso: input.checkInIso,
          checkOutIso: input.checkOutIso,
        }),
      };
    }

    const taxesTotal =
      Number.isFinite(taxesTotalRaw) && taxesTotalRaw >= 0 ? taxesTotalRaw : 0;

    const feeLines = Array.isArray(pricingNode?.pricingFees)
      ? pricingNode.pricingFees
          .map((line) => Number(line?.amount))
          .filter((value) => Number.isFinite(value) && value >= 0)
      : [];

    const feesTotalExclTaxes = feeLines.reduce(
      (sum, value) => sum + Number(value),
      0,
    );
    const grandTotal = baseTotal + taxesTotal + feesTotalExclTaxes;

    const handoffUrl = resolveHandoffUrl({
      listingId: input.listingId,
      detailUrl: resolveDetailUrl(input),
      checkInIso: input.checkInIso,
      checkOutIso: input.checkOutIso,
      adults,
      children,
      pricingNode,
      body,
    });

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
        handoffUrl,
      },
    };
  } catch (error: unknown) {
    const timedOut = error instanceof Error && error.name === "AbortError";
    return {
      success: false,
      elapsedMs: performance.now() - startedAt,
      error: toError({
        code: timedOut ? "QUOTE_TIMEOUT" : "QUOTE_FETCH_FAILED",
        message: timedOut
          ? `Quote request timed out after ${timeoutMs}ms`
          : error instanceof Error
            ? error.message
            : "Quote request failed",
        retryable: true,
        listingId: input.listingId,
        checkInIso: input.checkInIso,
        checkOutIso: input.checkOutIso,
      }),
    };
  } finally {
    clearTimeout(timer);
  }
}
