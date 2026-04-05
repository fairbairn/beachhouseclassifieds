import type { QuoteExecutionRequest, QuoteExecutionResult } from "../types";

type DuneQuoteContext = {
  listingId: string;
  detailUrl: string;
  endpointUrl: string;
  origin: string;
};

type StreamlineFee = {
  name?: string;
  value?: number | string;
};

type StreamlinePreReservationPayload = {
  price?: number | string;
  taxes?: number | string;
  total?: number | string;
  currency?: string;
  required_fees?: StreamlineFee[];
  taxes_details?: StreamlineFee[];
};

type StreamlinePreReservationResponse = {
  data?: StreamlinePreReservationPayload;
  status?: {
    code?: string;
    description?: string;
  };
};

const ADAPTER_KEY = "dunevr30a" as const;
const DEFAULT_ENDPOINT_PATH = "/wp-admin/admin-ajax.php";
const DEFAULT_TIMEOUT_MS = 20000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function normalizeTimeoutMs(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.max(1000, Math.floor(raw));
}

function toPositiveIntString(value: unknown): string | null {
  const parsed =
    typeof value === "string" ? Number(value.trim()) : Number(value ?? NaN);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return String(Math.floor(parsed));
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value.replace(/[^0-9.-]/g, "").trim());
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

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

function extractQuoteContext(input: QuoteExecutionRequest): DuneQuoteContext {
  const context = input.quoteContext;
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    throw new Error(
      `Missing required quoteContext for ${ADAPTER_KEY} listing ${input.listingId}`,
    );
  }

  const listingId =
    toPositiveIntString(context.listing_id) ??
    toPositiveIntString(context.unit_id);
  if (!listingId) {
    throw new Error(
      `Missing required quoteContext.listing_id for ${ADAPTER_KEY} listing ${input.listingId}`,
    );
  }

  const detailUrl =
    typeof context.detail_url === "string" ? context.detail_url.trim() : "";
  if (!detailUrl) {
    throw new Error(
      `Missing required quoteContext.detail_url for ${ADAPTER_KEY} listing ${input.listingId}`,
    );
  }

  const parsedDetailUrl = new URL(detailUrl);
  const origin = parsedDetailUrl.origin;

  const endpointUrl = `${origin}${DEFAULT_ENDPOINT_PATH}`;

  return {
    listingId,
    detailUrl,
    endpointUrl,
    origin,
  };
}

function buildCheckoutUrl(input: {
  detailUrl: string;
  listingId: string;
  checkInIso: string;
  checkOutIso: string;
  adults: number;
  children: number;
}): string {
  const origin = new URL(input.detailUrl).origin;
  const params = new URLSearchParams();
  params.set("unit", input.listingId);
  params.set("sd", input.checkInIso);
  params.set("ed", input.checkOutIso);
  params.set("oc", String(Math.max(1, Math.floor(input.adults))));
  params.set("os", String(Math.max(0, Math.floor(input.children))));
  return `${origin}/checkout/?${params.toString()}`;
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

async function verifyPropertyAvailability(input: {
  context: DuneQuoteContext;
  checkInIso: string;
  checkOutIso: string;
  adults: number;
  children: number;
  signal: AbortSignal;
}): Promise<{ available: boolean; reason: string | null }> {
  const body = new URLSearchParams();
  body.set("action", "streamlinecore-api-request");
  body.set(
    "params",
    JSON.stringify({
      methodName: "VerifyPropertyAvailability",
      params: {
        unit_id: Number(input.context.listingId),
        startdate: toUsDate(input.checkInIso),
        enddate: toUsDate(input.checkOutIso),
        occupants: String(Math.max(1, Math.floor(input.adults))),
        occupants_small: String(Math.max(0, Math.floor(input.children))),
        pets: "0",
        use_room_type_logic: 0,
        include_coupon_information: 1,
      },
    }),
  );

  const response = await fetch(input.context.endpointUrl, {
    method: "POST",
    headers: {
      accept: "application/json,text/plain,*/*",
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      "user-agent": USER_AGENT,
      referer: input.context.detailUrl,
      origin: input.context.origin,
    },
    body: body.toString(),
    signal: input.signal,
  });

  if (!response.ok) {
    return {
      available: false,
      reason: `VerifyPropertyAvailability failed with status ${response.status}`,
    };
  }

  const payload = (await response.json()) as StreamlinePreReservationResponse;
  if (payload.status?.code) {
    return {
      available: false,
      reason: payload.status.description?.trim() || payload.status.code,
    };
  }

  return {
    available: true,
    reason: null,
  };
}

export async function executeDunevr30aSingleQuote(
  input: QuoteExecutionRequest,
): Promise<QuoteExecutionResult> {
  const startedAt = performance.now();
  const timeoutMs = normalizeTimeoutMs(input.options?.timeoutMs);

  let context: DuneQuoteContext;
  try {
    context = extractQuoteContext(input);
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

  const handoffUrl = buildCheckoutUrl({
    detailUrl: context.detailUrl,
    listingId: context.listingId,
    checkInIso: input.checkInIso,
    checkOutIso: input.checkOutIso,
    adults: input.adults,
    children: input.children,
  });

  const verifyController = new AbortController();
  const verifyTimer = setTimeout(() => verifyController.abort(), timeoutMs);
  let availability: { available: boolean; reason: string | null };
  try {
    availability = await verifyPropertyAvailability({
      context,
      checkInIso: input.checkInIso,
      checkOutIso: input.checkOutIso,
      adults: input.adults,
      children: input.children,
      signal: verifyController.signal,
    });
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
            : "Failed availability verification",
        retryable: true,
        listingId: input.listingId,
        checkInIso: input.checkInIso,
        checkOutIso: input.checkOutIso,
        details: {
          handoffUrl,
        },
      }),
    };
  } finally {
    clearTimeout(verifyTimer);
  }

  if (!availability.available) {
    return {
      success: false,
      elapsedMs: performance.now() - startedAt,
      error: toError({
        code: "QUOTE_UNAVAILABLE",
        message: availability.reason ?? "Dates unavailable",
        retryable: true,
        listingId: input.listingId,
        checkInIso: input.checkInIso,
        checkOutIso: input.checkOutIso,
        details: {
          handoffUrl,
        },
      }),
    };
  }

  const query = new URLSearchParams({
    action: "streamlinecore-api-request",
    params: JSON.stringify({
      methodName: "GetPreReservationPrice",
      params: {
        unit_id: Number(context.listingId),
        startdate: toUsDate(input.checkInIso),
        enddate: toUsDate(input.checkOutIso),
        occupants: Math.max(1, Math.floor(input.adults)),
        occupants_small: Math.max(0, Math.floor(input.children)),
        pets: 0,
      },
    }),
  });

  const quoteController = new AbortController();
  const quoteTimer = setTimeout(() => quoteController.abort(), timeoutMs);

  try {
    const response = await fetch(`${context.endpointUrl}?${query.toString()}`, {
      method: "GET",
      headers: {
        accept: "application/json,text/plain,*/*",
        "user-agent": USER_AGENT,
        referer: context.detailUrl,
      },
      signal: quoteController.signal,
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
            handoffUrl,
          },
        }),
      };
    }

    let payload: StreamlinePreReservationResponse;
    try {
      payload = (await response.json()) as StreamlinePreReservationResponse;
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
          details: {
            handoffUrl,
          },
        }),
      };
    }

    if (payload.status?.code) {
      return {
        success: false,
        elapsedMs: performance.now() - startedAt,
        error: toError({
          code: "QUOTE_UNAVAILABLE",
          message: payload.status.description?.trim() || payload.status.code,
          retryable: true,
          listingId: input.listingId,
          checkInIso: input.checkInIso,
          checkOutIso: input.checkOutIso,
          details: {
            handoffUrl,
          },
        }),
      };
    }

    const data = payload.data;
    const baseTotal = toFiniteNumber(data?.price);
    const nonBaseTotal = toFiniteNumber(data?.taxes);
    const grandTotal = toFiniteNumber(data?.total);

    const feesTotal = Array.isArray(data?.required_fees)
      ? roundCurrency(
          data.required_fees.reduce((sum, fee) => {
            const amount = toFiniteNumber(fee.value);
            return sum + (amount !== null && amount > 0 ? amount : 0);
          }, 0),
        )
      : null;

    const taxesDetailTotal = Array.isArray(data?.taxes_details)
      ? roundCurrency(
          data.taxes_details.reduce((sum, fee) => {
            const amount = toFiniteNumber(fee.value);
            return sum + (amount !== null && amount > 0 ? amount : 0);
          }, 0),
        )
      : null;

    let taxesTotal: number | null = taxesDetailTotal;
    if (taxesTotal === null && nonBaseTotal !== null && feesTotal !== null) {
      taxesTotal = roundCurrency(Math.max(nonBaseTotal - feesTotal, 0));
    }
    if (taxesTotal === null && nonBaseTotal !== null && nonBaseTotal > 0) {
      taxesTotal = roundCurrency(nonBaseTotal);
    }

    const normalizedBase =
      baseTotal !== null && baseTotal > 0 ? roundCurrency(baseTotal) : null;
    const normalizedGrand =
      grandTotal !== null && grandTotal > 0 ? roundCurrency(grandTotal) : null;
    const normalizedFees =
      feesTotal !== null && feesTotal >= 0 ? roundCurrency(feesTotal) : null;

    if (
      normalizedBase === null ||
      normalizedGrand === null ||
      normalizedGrand < normalizedBase
    ) {
      return {
        success: false,
        elapsedMs: performance.now() - startedAt,
        error: toError({
          code: "QUOTE_RESPONSE_INCOMPLETE",
          message: "Quote response is missing expected totals",
          retryable: false,
          listingId: input.listingId,
          checkInIso: input.checkInIso,
          checkOutIso: input.checkOutIso,
          details: {
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
        currency: data?.currency?.trim() || "USD",
        baseTotal: normalizedBase,
        taxesTotal,
        feesTotalExclTaxes: normalizedFees,
        grandTotal: normalizedGrand,
        quotedTotal: normalizedGrand,
        handoffUrl,
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
          error instanceof Error ? error.message : "Quote request failed",
        retryable: true,
        listingId: input.listingId,
        checkInIso: input.checkInIso,
        checkOutIso: input.checkOutIso,
        details: {
          handoffUrl,
        },
      }),
    };
  } finally {
    clearTimeout(quoteTimer);
  }
}
