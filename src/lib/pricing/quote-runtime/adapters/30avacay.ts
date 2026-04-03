import type { QuoteExecutionRequest, QuoteExecutionResult } from "../types";

type RouterFeeLine = {
  name?: unknown;
  amount?: unknown;
};

type RouterQuoteResponse = {
  apiError?: unknown;
  errorMsg?: unknown;
  isAvailable?: unknown;
  rent?: unknown;
  fees?: unknown;
  taxes?: unknown;
  travelInsurance?: unknown;
  damageProtection?: unknown;
  optionalExtras?: unknown;
  bookingTotal?: unknown;
};

type RouterQuoteResult = {
  quoteAvailable: boolean;
  quoteUnavailableReason: string | null;
  baseTotal: number | null;
  taxesTotal: number | null;
  feesTotalExclTaxes: number | null;
  grandTotal: number | null;
  currency: string;
  handoffUrl: string;
  isRateLimited: boolean;
};

const ADAPTER_KEY = "30avacay" as const;
const BASE_HOST = "https://www.30a-vacay.com";
const ROUTER_ENDPOINT = `${BASE_HOST}/vacation-rentals/router/`;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const DEFAULT_TIMEOUT_MS = 20000;
const RATE_LIMIT_BACKOFF_MS = 900;
const MAX_RATE_LIMIT_RETRIES = 3;
function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

function normalizeTimeoutMs(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.max(1000, Math.floor(raw));
}

function toUsDate(isoDate: string): string {
  const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return isoDate;
  }
  return `${String(Number(match[2]))}/${String(Number(match[3]))}/${match[1]}`;
}

function parseMoney(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? roundCurrency(value) : null;
  }
  if (typeof value === "string") {
    const parsed = Number(value.trim().replace(/,/g, ""));
    return Number.isFinite(parsed) ? roundCurrency(parsed) : null;
  }
  return null;
}

function toUnixSecondsAtUtcMidnight(isoDate: string): number {
  return Math.floor(new Date(`${isoDate}T00:00:00.000Z`).getTime() / 1000);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function isRateLimitedMessage(value: string | null): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.toLowerCase();
  return (
    normalized.includes("too many requests") ||
    normalized.includes("rate limit") ||
    normalized.includes("throttle")
  );
}

function parseFeeLines(
  value: unknown,
): Array<{ name: string; amount: number }> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      const line = entry as RouterFeeLine;
      const amount = parseMoney(line.amount);
      if (amount === null) {
        return null;
      }
      const name = (typeof line.name === "string" && line.name.trim()) || "Fee";
      return {
        name,
        amount,
      };
    })
    .filter((line): line is { name: string; amount: number } => line !== null);
}

function sumFeeLines(lines: Array<{ name: string; amount: number }>): number {
  return roundCurrency(lines.reduce((total, line) => total + line.amount, 0));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function buildCheckoutUrl(input: {
  unitId: string;
  startDate: string;
  endDate: string;
  nights: number;
  persons: number;
}): string {
  const params = new URLSearchParams();
  params.set("id", input.unitId);
  params.set("quote", "yes");
  params.set("arr", String(toUnixSecondsAtUtcMidnight(input.startDate)));
  params.set("depart", String(toUnixSecondsAtUtcMidnight(input.endDate)));
  params.set("nights", String(input.nights));
  params.set("persons", String(input.persons));
  return `${BASE_HOST}/vacation-rentals/checkout/?${params.toString()}`;
}

function resolveRequestContext(input: QuoteExecutionRequest): {
  unitId: string;
  detailUrl: string;
} {
  const context =
    input.quoteContext &&
    typeof input.quoteContext === "object" &&
    !Array.isArray(input.quoteContext)
      ? input.quoteContext
      : null;

  const fromContextUnitId =
    typeof context?.unit_id === "string"
      ? context.unit_id.trim()
      : typeof context?.unit_id === "number"
        ? String(context.unit_id)
        : "";

  const fromContextDetailUrl =
    typeof context?.detail_url === "string" ? context.detail_url.trim() : "";

  if (!fromContextUnitId || !fromContextDetailUrl) {
    throw new Error(
      `Missing required quoteContext.unit_id/detail_url for ${ADAPTER_KEY} listing ${input.listingId}`,
    );
  }

  return {
    unitId: fromContextUnitId,
    detailUrl: fromContextDetailUrl,
  };
}

function toError(input: {
  code: string;
  message: string;
  retryable: boolean;
  request: QuoteExecutionRequest;
  details?: Record<string, unknown>;
}) {
  return {
    code: input.code,
    message: input.message,
    retryable: input.retryable,
    details: {
      adapterKey: ADAPTER_KEY,
      listingId: input.request.listingId,
      checkInIso: input.request.checkInIso,
      checkOutIso: input.request.checkOutIso,
      ...(input.details ?? {}),
    },
  };
}

async function fetchRouterQuote(input: {
  request: QuoteExecutionRequest;
  unitId: string;
  detailUrl: string;
  timeoutMs: number;
}): Promise<RouterQuoteResult> {
  const persons = Math.max(1, input.request.adults + input.request.children);
  const nights =
    (toUnixSecondsAtUtcMidnight(input.request.checkOutIso) -
      toUnixSecondsAtUtcMidnight(input.request.checkInIso)) /
    86400;
  const handoffUrl = buildCheckoutUrl({
    unitId: input.unitId,
    startDate: input.request.checkInIso,
    endDate: input.request.checkOutIso,
    nights,
    persons,
  });

  const payload = {
    call: "getPrice",
    unitId: input.unitId,
    people: persons,
    arrive: toUsDate(input.request.checkInIso),
    depart: toUsDate(input.request.checkOutIso),
    optIn: false,
    promoCode: "",
    sdpBool: false,
  };

  let lastRateLimitReason: string | null = null;

  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), input.timeoutMs);
    let response: Response;
    try {
      const headers: Record<string, string> = {
        accept: "application/json, text/plain, */*",
        "content-type": "application/json;charset=UTF-8",
        "user-agent": USER_AGENT,
        origin: BASE_HOST,
      };
      if (input.detailUrl.trim()) {
        headers.referer = input.detailUrl.trim();
      }

      response = await fetch(ROUTER_ENDPOINT, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutHandle);
    }

    if (!response.ok) {
      if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
        lastRateLimitReason = `Router HTTP ${response.status}`;
        await sleep(RATE_LIMIT_BACKOFF_MS * (attempt + 1));
        continue;
      }

      return {
        quoteAvailable: false,
        quoteUnavailableReason: `Router HTTP ${response.status}`,
        baseTotal: null,
        taxesTotal: null,
        feesTotalExclTaxes: null,
        grandTotal: null,
        currency: "USD",
        handoffUrl,
        isRateLimited: response.status === 429,
      };
    }

    let rawPayload: RouterQuoteResponse;
    try {
      rawPayload = (await response.json()) as RouterQuoteResponse;
    } catch {
      return {
        quoteAvailable: false,
        quoteUnavailableReason: "Router returned invalid JSON",
        baseTotal: null,
        taxesTotal: null,
        feesTotalExclTaxes: null,
        grandTotal: null,
        currency: "USD",
        handoffUrl,
        isRateLimited: false,
      };
    }

    const apiError = asString(rawPayload.apiError);
    const errorMsg = asString(rawPayload.errorMsg);
    if (
      (isRateLimitedMessage(apiError) || isRateLimitedMessage(errorMsg)) &&
      attempt < MAX_RATE_LIMIT_RETRIES
    ) {
      lastRateLimitReason = apiError ?? errorMsg;
      await sleep(RATE_LIMIT_BACKOFF_MS * (attempt + 1));
      continue;
    }

    const isAvailable = rawPayload.isAvailable === true;
    const parsedRent = parseMoney(rawPayload.rent);
    const baseTotal = parsedRent !== null && parsedRent > 0 ? parsedRent : null;

    const feesLines = parseFeeLines(rawPayload.fees);
    const taxesLines = parseFeeLines(rawPayload.taxes);
    const travelInsuranceLines = parseFeeLines(
      rawPayload.travelInsurance ? [rawPayload.travelInsurance] : [],
    );
    const damageProtectionLines = parseFeeLines(
      rawPayload.damageProtection ? [rawPayload.damageProtection] : [],
    );
    const extrasLines = parseFeeLines(rawPayload.optionalExtras);

    const allFeeLines = [
      ...feesLines,
      ...travelInsuranceLines,
      ...damageProtectionLines,
      ...extrasLines,
    ];

    const taxesTotalRaw = sumFeeLines(taxesLines);
    const feesTotalRaw = sumFeeLines(allFeeLines);
    const taxesTotal = taxesTotalRaw > 0 ? taxesTotalRaw : null;
    const feesTotalExclTaxes = feesTotalRaw > 0 ? feesTotalRaw : null;
    const parsedBookingTotal = parseMoney(rawPayload.bookingTotal);
    const bookingTotal =
      parsedBookingTotal !== null && parsedBookingTotal > 0
        ? parsedBookingTotal
        : null;
    const computedGrandTotal =
      baseTotal !== null
        ? roundCurrency(
            baseTotal + (feesTotalExclTaxes ?? 0) + (taxesTotal ?? 0),
          )
        : null;

    return {
      quoteAvailable: isAvailable && baseTotal !== null,
      quoteUnavailableReason:
        isAvailable && baseTotal !== null
          ? null
          : (apiError ??
            errorMsg ??
            "Dates unavailable for selected stay window"),
      baseTotal,
      taxesTotal,
      feesTotalExclTaxes,
      grandTotal: bookingTotal ?? computedGrandTotal,
      currency: "USD",
      handoffUrl,
      isRateLimited: false,
    };
  }

  return {
    quoteAvailable: false,
    quoteUnavailableReason:
      lastRateLimitReason ?? "Too many requests after retry attempts",
    baseTotal: null,
    taxesTotal: null,
    feesTotalExclTaxes: null,
    grandTotal: null,
    currency: "USD",
    handoffUrl,
    isRateLimited: true,
  };
}

export async function execute30AvacaySingleQuote(
  request: QuoteExecutionRequest,
): Promise<QuoteExecutionResult> {
  const startedAt = performance.now();
  const timeoutMs = normalizeTimeoutMs(request.options?.timeoutMs);
  let requestContext: { unitId: string; detailUrl: string };
  try {
    requestContext = resolveRequestContext(request);
  } catch (error: unknown) {
    return {
      success: false,
      elapsedMs: performance.now() - startedAt,
      error: toError({
        code: "QUOTE_CONTEXT_MISSING",
        message:
          error instanceof Error ? error.message : "Quote context missing",
        retryable: false,
        request,
      }),
    };
  }
  const unitId = requestContext.unitId;

  let quote: RouterQuoteResult;
  try {
    quote = await fetchRouterQuote({
      request,
      unitId,
      detailUrl: requestContext.detailUrl,
      timeoutMs,
    });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Quote request failed";
    return {
      success: false,
      elapsedMs: performance.now() - startedAt,
      error: toError({
        code: message.includes("aborted")
          ? "QUOTE_TIMEOUT"
          : "QUOTE_FETCH_FAILED",
        message,
        retryable: true,
        request,
        details: {
          unitId,
        },
      }),
    };
  }

  if (!quote.quoteAvailable || quote.baseTotal === null) {
    return {
      success: false,
      elapsedMs: performance.now() - startedAt,
      error: toError({
        code: quote.isRateLimited ? "QUOTE_RATE_LIMITED" : "QUOTE_UNAVAILABLE",
        message:
          quote.quoteUnavailableReason ??
          "Dates unavailable for selected stay window",
        retryable: quote.isRateLimited,
        request,
        details: {
          unitId,
          handoffUrl: quote.handoffUrl,
        },
      }),
    };
  }

  return {
    success: true,
    elapsedMs: performance.now() - startedAt,
    observation: {
      startDate: request.checkInIso,
      endDate: request.checkOutIso,
      quoteAvailable: true,
      currency: quote.currency,
      baseTotal: quote.baseTotal,
      taxesTotal: quote.taxesTotal,
      feesTotalExclTaxes: quote.feesTotalExclTaxes,
      grandTotal: quote.grandTotal,
      quotedTotal: quote.grandTotal,
      handoffUrl: quote.handoffUrl,
    },
  };
}
