import type { QuoteExecutionRequest, QuoteExecutionResult } from "../types";

type StreamlineFee = {
  name?: unknown;
  value?: unknown;
};

type StreamlinePreReservationPayload = {
  unit_id?: unknown;
  price?: unknown;
  taxes?: unknown;
  total?: unknown;
  currency?: unknown;
  required_fees?: unknown;
  taxes_details?: unknown;
};

type StreamlinePreReservationResponse = {
  data?: StreamlinePreReservationPayload;
  status?: {
    code?: unknown;
    description?: unknown;
  };
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

const ADAPTER_KEY = "30abeach" as const;
const MIN_VALID_BASE_TOTAL = 100;
const DEFAULT_TIMEOUT_MS = 20000;
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

function asOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toUsDate(isoDate: string): string {
  const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return isoDate;
  }
  return `${match[2]}/${match[3]}/${match[1]}`;
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
  params.set("oc", String(Math.max(1, input.adults)));
  params.set("os", String(Math.max(0, input.children)));
  return `${origin}/checkout/?${params.toString()}`;
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

async function verifyPropertyAvailability(input: {
  detailUrl: string;
  listingId: string;
  checkInIso: string;
  checkOutIso: string;
  adults: number;
  children: number;
  signal: AbortSignal;
}): Promise<{ available: boolean; reason: string | null }> {
  const origin = new URL(input.detailUrl).origin;
  const endpoint = `${origin}/wp-admin/admin-ajax.php`;
  const body = new URLSearchParams();
  body.set("action", "streamlinecore-api-request");
  body.set(
    "params",
    JSON.stringify({
      methodName: "VerifyPropertyAvailability",
      params: {
        unit_id: Number(input.listingId),
        startdate: toUsDate(input.checkInIso),
        enddate: toUsDate(input.checkOutIso),
        occupants: String(input.adults),
        occupants_small: String(input.children),
        pets: "0",
        use_room_type_logic: 0,
        include_coupon_information: 1,
      },
    }),
  );

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      accept: "application/json,text/plain,*/*",
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      "user-agent": USER_AGENT,
      referer: input.detailUrl,
      origin,
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
  const code = asOptionalString(payload.status?.code);
  if (code) {
    return {
      available: false,
      reason: asOptionalString(payload.status?.description) ?? code,
    };
  }

  return { available: true, reason: null };
}

async function fetchPreReservationQuote(input: {
  detailUrl: string;
  listingId: string;
  checkInIso: string;
  checkOutIso: string;
  adults: number;
  children: number;
  signal: AbortSignal;
}): Promise<RawObservation> {
  const origin = new URL(input.detailUrl).origin;
  const queryParams = new URLSearchParams({
    action: "streamlinecore-api-request",
    params: JSON.stringify({
      methodName: "GetPreReservationPrice",
      params: {
        unit_id: Number(input.listingId),
        startdate: toUsDate(input.checkInIso),
        enddate: toUsDate(input.checkOutIso),
        occupants: input.adults,
        occupants_small: input.children,
        pets: 0,
      },
    }),
  });

  const endpoint = `${origin}/wp-admin/admin-ajax.php?${queryParams.toString()}`;
  const handoffUrl = buildCheckoutUrl({
    detailUrl: input.detailUrl,
    listingId: input.listingId,
    checkInIso: input.checkInIso,
    checkOutIso: input.checkOutIso,
    adults: input.adults,
    children: input.children,
  });

  const availability = await verifyPropertyAvailability(input);
  if (!availability.available) {
    return {
      startDate: input.checkInIso,
      endDate: input.checkOutIso,
      quoteAvailable: false,
      quoteUnavailableReason: availability.reason ?? "Dates unavailable",
      baseTotal: null,
      taxesTotal: null,
      feesTotal: null,
      grandTotal: null,
      currency: "USD",
      handoffUrl,
    };
  }

  const response = await fetch(endpoint, {
    method: "GET",
    headers: {
      accept: "application/json,text/plain,*/*",
      "user-agent": USER_AGENT,
      referer: input.detailUrl,
    },
    signal: input.signal,
  });

  if (!response.ok) {
    return {
      startDate: input.checkInIso,
      endDate: input.checkOutIso,
      quoteAvailable: false,
      quoteUnavailableReason: `Quote request failed with status ${response.status}`,
      baseTotal: null,
      taxesTotal: null,
      feesTotal: null,
      grandTotal: null,
      currency: "USD",
      handoffUrl,
    };
  }

  const payload = (await response.json()) as StreamlinePreReservationResponse;
  const statusCode = asOptionalString(payload.status?.code);
  if (statusCode) {
    return {
      startDate: input.checkInIso,
      endDate: input.checkOutIso,
      quoteAvailable: false,
      quoteUnavailableReason:
        asOptionalString(payload.status?.description) ?? statusCode,
      baseTotal: null,
      taxesTotal: null,
      feesTotal: null,
      grandTotal: null,
      currency: "USD",
      handoffUrl,
    };
  }

  const data = payload.data;
  const baseTotalRaw = toFiniteNumber(data?.price);
  const nonBaseTotalRaw = toFiniteNumber(data?.taxes);
  const grandTotalRaw = toFiniteNumber(data?.total);

  const feeLines = Array.isArray(data?.required_fees)
    ? (data.required_fees as StreamlineFee[])
        .map((line) => {
          const amount = toFiniteNumber(line.value);
          const name = asOptionalString(line.name);
          if (!name || amount === null || amount < 0) {
            return null;
          }
          return {
            name,
            amount: roundCurrency(amount),
          };
        })
        .filter(
          (line): line is { name: string; amount: number } => line !== null,
        )
    : [];

  const taxesDetailTotal = Array.isArray(data?.taxes_details)
    ? roundCurrency(
        (data.taxes_details as StreamlineFee[]).reduce((sum, line) => {
          const amount = toFiniteNumber(line.value);
          return sum + (amount !== null && amount > 0 ? amount : 0);
        }, 0),
      )
    : null;

  const feesTotal = feeLines.length
    ? roundCurrency(feeLines.reduce((sum, line) => sum + line.amount, 0))
    : null;

  const baseTotal =
    baseTotalRaw !== null && baseTotalRaw > 0
      ? roundCurrency(baseTotalRaw)
      : null;
  const grandTotal =
    grandTotalRaw !== null && grandTotalRaw > 0
      ? roundCurrency(grandTotalRaw)
      : null;

  let taxesTotal: number | null = taxesDetailTotal;
  if (taxesTotal === null && nonBaseTotalRaw !== null && feesTotal !== null) {
    taxesTotal = roundCurrency(Math.max(nonBaseTotalRaw - feesTotal, 0));
  }
  if (taxesTotal === null && nonBaseTotalRaw !== null && nonBaseTotalRaw > 0) {
    taxesTotal = roundCurrency(nonBaseTotalRaw);
  }

  const availabilityError = validateAvailableTotals({
    baseTotal,
    taxesTotal,
    feesTotal,
    grandTotal,
  });

  return {
    startDate: input.checkInIso,
    endDate: input.checkOutIso,
    quoteAvailable: availabilityError === null,
    quoteUnavailableReason: availabilityError,
    baseTotal,
    taxesTotal,
    feesTotal,
    grandTotal,
    currency: asOptionalString(data?.currency) ?? "USD",
    handoffUrl,
  };
}

function resolveRuntimeQuoteContext(input: QuoteExecutionRequest): {
  listingId: string;
  detailUrl: string;
} {
  const quoteContext =
    input.quoteContext &&
    typeof input.quoteContext === "object" &&
    !Array.isArray(input.quoteContext)
      ? input.quoteContext
      : null;

  const detailUrl = asOptionalString(quoteContext?.detail_url);
  if (!detailUrl) {
    throw new Error(
      `Missing required quoteContext.detail_url for ${ADAPTER_KEY} listing ${input.listingId}`,
    );
  }

  const listingIdFromContext =
    asOptionalString(quoteContext?.listing_id) ??
    asOptionalString(quoteContext?.unit_id);

  return {
    listingId: listingIdFromContext ?? input.listingId,
    detailUrl,
  };
}

export async function execute30ABeachSingleQuote(
  input: QuoteExecutionRequest,
): Promise<QuoteExecutionResult> {
  const startedAt = performance.now();
  const timeoutMs = normalizeTimeoutMs(input.options?.timeoutMs);

  let runtimeContext: { listingId: string; detailUrl: string };
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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const raw = await fetchPreReservationQuote({
      detailUrl: runtimeContext.detailUrl,
      listingId: runtimeContext.listingId,
      checkInIso: input.checkInIso,
      checkOutIso: input.checkOutIso,
      adults: Math.max(1, input.adults),
      children: Math.max(0, input.children),
      signal: controller.signal,
    });

    if (!raw.quoteAvailable) {
      return {
        success: false,
        elapsedMs: performance.now() - startedAt,
        error: toError({
          code: "QUOTE_UNAVAILABLE",
          message: raw.quoteUnavailableReason ?? "Quote unavailable",
          retryable: true,
          listingId: input.listingId,
          checkInIso: input.checkInIso,
          checkOutIso: input.checkOutIso,
        }),
      };
    }

    return {
      success: true,
      elapsedMs: performance.now() - startedAt,
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
      }),
    };
  } finally {
    clearTimeout(timer);
  }
}
