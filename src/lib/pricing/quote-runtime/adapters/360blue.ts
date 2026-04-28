import type { QuoteExecutionRequest, QuoteExecutionResult } from "../types";

type QuoteRequestContext = {
  unitId: string;
  reservationQuotesEndpoint: string;
  cartCreateEndpoint: string;
  detailUrl: string;
};

type ReservationQuoteApiResponse = {
  subTotal: number;
  total: number;
  taxes: number;
};

const ADAPTER_KEY = "360blue" as const;
const BASE_HOST = "https://www.360blue.com";
const DEFAULT_RESERVATION_QUOTES_ENDPOINT =
  "https://www.360blue.com/api/nrbe/reservation-quotes.json";
const DEFAULT_CART_CREATE_ENDPOINT =
  "https://www.360blue.com/api/nrbe/carts/create.json";
const DEFAULT_TIMEOUT_MS = 12000;
const REQUEST_REFERER = "https://www.360blue.com/";
const REQUEST_ORIGIN = "https://www.360blue.com";
const REQUEST_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function canonicalize360BlueHost(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.endsWith("callistavacations.com")) {
      parsed.hostname = "www.360blue.com";
      parsed.protocol = "https:";
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

function normalizeTimeoutMs(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.max(1000, Math.floor(raw));
}

function toPositiveIntString(input: unknown): string | null {
  const value =
    typeof input === "string" ? Number(input.trim()) : Number(input ?? NaN);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  return String(Math.floor(value));
}

function toNonNegativeInt(input: number, fallback: number): number {
  if (!Number.isFinite(input)) {
    return fallback;
  }
  return Math.max(0, Math.floor(input));
}

function toPositiveInt(input: number, fallback: number): number {
  if (!Number.isFinite(input)) {
    return fallback;
  }
  return Math.max(1, Math.floor(input));
}

function extractQuoteContext(
  input: QuoteExecutionRequest,
): QuoteRequestContext {
  const context = input.quoteContext;
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    throw new Error(
      `Missing required quoteContext.unit_id for ${ADAPTER_KEY} listing ${input.listingId}`,
    );
  }

  const unitId = toPositiveIntString(context.unit_id);
  if (!unitId) {
    throw new Error(
      `Missing required quoteContext.unit_id for ${ADAPTER_KEY} listing ${input.listingId}`,
    );
  }

  const endpointPathRaw =
    typeof context.endpoint_path === "string"
      ? context.endpoint_path.trim()
      : "";
  const reservationQuotesEndpoint = endpointPathRaw.startsWith("/")
    ? `https://www.360blue.com${endpointPathRaw}`
    : DEFAULT_RESERVATION_QUOTES_ENDPOINT;

  const cartCreateEndpointRaw =
    typeof context.cart_create_endpoint === "string"
      ? context.cart_create_endpoint.trim()
      : "";

  const cartCreateEndpoint = canonicalize360BlueHost(
    cartCreateEndpointRaw || DEFAULT_CART_CREATE_ENDPOINT,
  );

  const detailUrlRaw =
    typeof context.detail_url === "string" ? context.detail_url.trim() : "";

  const detailUrl = canonicalize360BlueHost(
    detailUrlRaw.length > 0
      ? detailUrlRaw
      : `${BASE_HOST}/destinations/emerald-coast/walton-county/properties/${encodeURIComponent(input.listingId)}`,
  );

  return {
    unitId,
    reservationQuotesEndpoint,
    cartCreateEndpoint,
    detailUrl,
  };
}

function buildPrefilledDetailUrl(input: {
  detailUrl: string;
  checkInIso: string;
  checkOutIso: string;
  adults: number;
  children: number;
}): string {
  try {
    const parsed = new URL(input.detailUrl);
    parsed.searchParams.set("arrivalDate", input.checkInIso);
    parsed.searchParams.set("departureDate", input.checkOutIso);
    parsed.searchParams.set("adults", String(toPositiveInt(input.adults, 1)));
    parsed.searchParams.set(
      "children",
      String(toNonNegativeInt(input.children, 0)),
    );
    return parsed.toString();
  } catch {
    return input.detailUrl;
  }
}

function buildHandoffUrl(input: {
  cartCreateEndpoint: string;
  unitId: string;
  checkInIso: string;
  checkOutIso: string;
  adults: number;
  children: number;
}): string {
  const payload = {
    unitId: Number(input.unitId),
    arrivalDate: input.checkInIso,
    departureDate: input.checkOutIso,
    adults: toPositiveInt(input.adults, 1),
    children: toNonNegativeInt(input.children, 0),
  };

  const params = new URLSearchParams();
  params.set("method", "POST");
  params.set("contentType", "application/json");
  params.set("payload", JSON.stringify(payload));
  return `${input.cartCreateEndpoint}#${params.toString()}`;
}

function buildFallbackHandoffUrl(input: QuoteExecutionRequest): string {
  const context =
    input.quoteContext &&
    typeof input.quoteContext === "object" &&
    !Array.isArray(input.quoteContext)
      ? input.quoteContext
      : null;

  const detailUrlRaw =
    context && typeof context.detail_url === "string"
      ? context.detail_url.trim()
      : "";
  if (detailUrlRaw.length > 0) {
    return canonicalize360BlueHost(detailUrlRaw);
  }

  return `${BASE_HOST}/destinations/emerald-coast/walton-county/properties/${encodeURIComponent(input.listingId)}`;
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

export async function execute360BlueSingleQuote(
  input: QuoteExecutionRequest,
): Promise<QuoteExecutionResult> {
  const startedAt = performance.now();
  const timeoutMs = normalizeTimeoutMs(input.options?.timeoutMs);
  const fallbackHandoffUrl = buildFallbackHandoffUrl(input);

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
        details: { handoffUrl: fallbackHandoffUrl },
      }),
    };
  }

  const query = new URLSearchParams();
  query.set("unitId", quoteContext.unitId);
  query.set("arrivalDate", input.checkInIso);
  query.set("departureDate", input.checkOutIso);
  query.set("adults", String(toPositiveInt(input.adults, 1)));
  query.set("children", String(toNonNegativeInt(input.children, 0)));

  const handoffUrl = buildHandoffUrl({
    cartCreateEndpoint: quoteContext.cartCreateEndpoint,
    unitId: quoteContext.unitId,
    checkInIso: input.checkInIso,
    checkOutIso: input.checkOutIso,
    adults: input.adults,
    children: input.children,
  });

  const prefilledDetailUrl = buildPrefilledDetailUrl({
    detailUrl: quoteContext.detailUrl,
    checkInIso: input.checkInIso,
    checkOutIso: input.checkOutIso,
    adults: input.adults,
    children: input.children,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(
      `${quoteContext.reservationQuotesEndpoint}?${query.toString()}`,
      {
        method: "GET",
        headers: {
          accept: "application/json, text/plain, */*",
          "accept-language": "en-US,en;q=0.9",
          origin: REQUEST_ORIGIN,
          referer: REQUEST_REFERER,
          "user-agent": REQUEST_USER_AGENT,
        },
        signal: controller.signal,
      },
    );

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
          details: { status: response.status, handoffUrl },
        }),
      };
    }

    let payload: ReservationQuoteApiResponse;
    try {
      payload = (await response.json()) as ReservationQuoteApiResponse;
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
          details: { handoffUrl },
        }),
      };
    }

    const baseTotal = Number(payload.subTotal);
    const taxesTotal = Number(payload.taxes);
    const grandTotal = Number(payload.total);

    if (
      !Number.isFinite(baseTotal) ||
      !Number.isFinite(taxesTotal) ||
      !Number.isFinite(grandTotal)
    ) {
      return {
        success: false,
        elapsedMs: performance.now() - startedAt,
        error: toError({
          code: "QUOTE_RESPONSE_INCOMPLETE",
          message: "Quote response is missing numeric totals",
          retryable: false,
          listingId: input.listingId,
          checkInIso: input.checkInIso,
          checkOutIso: input.checkOutIso,
          details: { handoffUrl },
        }),
      };
    }

    if (baseTotal <= 0 || grandTotal < baseTotal) {
      return {
        success: false,
        elapsedMs: performance.now() - startedAt,
        error: toError({
          code: "QUOTE_UNAVAILABLE",
          message: "Quote totals indicate the stay is unavailable",
          retryable: true,
          listingId: input.listingId,
          checkInIso: input.checkInIso,
          checkOutIso: input.checkOutIso,
          details: {
            subTotal: baseTotal,
            total: grandTotal,
            handoffUrl,
          },
        }),
      };
    }

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
        feesTotalExclTaxes: Math.max(0, grandTotal - baseTotal - taxesTotal),
        grandTotal,
        quotedTotal: grandTotal,
        detailUrl: prefilledDetailUrl,
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
        details: { handoffUrl },
      }),
    };
  } finally {
    clearTimeout(timer);
  }
}
