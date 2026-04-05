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

type StayAt30AQuoteContext = {
  unitId: string;
  detailUrl: string;
};

const ADAPTER_KEY = "stayat30a" as const;
const BASE_HOST = "https://www.stayat30avacationrentals.com";
const ROUTER_ENDPOINT = `${BASE_HOST}/vacation-rentals/router/`;
const DEFAULT_TIMEOUT_MS = 20000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

function toUsDate(isoDate: string): string {
  const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return isoDate;
  }
  const month = String(Number(match[2]));
  const day = String(Number(match[3]));
  return `${month}/${day}/${match[1]}`;
}

function toUnixSecondsAtUtcMidnight(isoDate: string): number {
  return Math.floor(new Date(`${isoDate}T00:00:00.000Z`).getTime() / 1000);
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

function asOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
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

function isRateLimitedMessage(value: string | null): boolean {
  if (!value) {
    return false;
  }

  const normalized = value.toLowerCase();
  return (
    normalized.includes("too many requests") ||
    normalized.includes("too_many_requests") ||
    normalized.includes("allowed requests per minute") ||
    normalized.includes("requests per minute") ||
    normalized.includes("rate limit") ||
    normalized.includes("throttle")
  );
}

function normalizeTimeoutMs(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.max(1000, Math.floor(raw));
}

function buildCheckoutUrl(input: {
  unitId: string;
  checkInIso: string;
  checkOutIso: string;
  adults: number;
  children: number;
}): string {
  const persons = Math.max(1, input.adults + input.children);
  const nights = Math.max(
    1,
    (toUnixSecondsAtUtcMidnight(input.checkOutIso) -
      toUnixSecondsAtUtcMidnight(input.checkInIso)) /
      86400,
  );

  const params = new URLSearchParams();
  params.set("id", input.unitId);
  params.set("quote", "yes");
  params.set("arr", String(toUnixSecondsAtUtcMidnight(input.checkInIso)));
  params.set("depart", String(toUnixSecondsAtUtcMidnight(input.checkOutIso)));
  params.set("nights", String(nights));
  params.set("persons", String(persons));

  return `${BASE_HOST}/vacation-rentals/checkout/?${params.toString()}`;
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

function extractQuoteContext(
  input: QuoteExecutionRequest,
): StayAt30AQuoteContext {
  const context =
    input.quoteContext &&
    typeof input.quoteContext === "object" &&
    !Array.isArray(input.quoteContext)
      ? input.quoteContext
      : null;

  const unitId =
    asOptionalString(context?.unit_id) ??
    asOptionalString(context?.listing_id) ??
    asOptionalString(context?.unitId);
  if (!unitId) {
    throw new Error(
      `Missing required quoteContext.unit_id for ${ADAPTER_KEY} listing ${input.listingId}`,
    );
  }

  const detailUrl =
    asOptionalString(context?.detail_url) ??
    `${BASE_HOST}/vacation-rentals/rental/${input.listingId}`;

  return {
    unitId,
    detailUrl,
  };
}

export async function executeStayat30aSingleQuote(
  input: QuoteExecutionRequest,
): Promise<QuoteExecutionResult> {
  const startedAt = performance.now();
  const timeoutMs = normalizeTimeoutMs(input.options?.timeoutMs);

  let quoteContext: StayAt30AQuoteContext;
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

  const handoffUrl = buildCheckoutUrl({
    unitId: quoteContext.unitId,
    checkInIso: input.checkInIso,
    checkOutIso: input.checkOutIso,
    adults: Math.max(1, input.adults),
    children: Math.max(0, input.children),
  });

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const payload = {
      call: "getPrice",
      unitId: quoteContext.unitId,
      people: Math.max(1, input.adults + input.children),
      arrive: toUsDate(input.checkInIso),
      depart: toUsDate(input.checkOutIso),
      optIn: false,
      promoCode: "",
      sdpBool: false,
    };

    const response = await fetch(ROUTER_ENDPOINT, {
      method: "POST",
      headers: {
        accept: "application/json, text/plain, */*",
        "content-type": "application/json;charset=UTF-8",
        "user-agent": USER_AGENT,
        referer: quoteContext.detailUrl,
        origin: BASE_HOST,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        success: false,
        elapsedMs: performance.now() - startedAt,
        error: toError({
          code:
            response.status === 429
              ? "QUOTE_RATE_LIMITED"
              : "QUOTE_UNAVAILABLE",
          message: `Router HTTP ${response.status}`,
          retryable: response.status >= 500 || response.status === 429,
          listingId: input.listingId,
          checkInIso: input.checkInIso,
          checkOutIso: input.checkOutIso,
          details: {
            handoffUrl,
          },
        }),
      };
    }

    const rawPayload = (await response.json()) as RouterQuoteResponse;

    const apiError = asOptionalString(rawPayload.apiError);
    const errorMsg = asOptionalString(rawPayload.errorMsg);
    if (isRateLimitedMessage(apiError) || isRateLimitedMessage(errorMsg)) {
      return {
        success: false,
        elapsedMs: performance.now() - startedAt,
        error: toError({
          code: "QUOTE_RATE_LIMITED",
          message: apiError ?? errorMsg ?? "Rate limited",
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

    const isAvailable = rawPayload.isAvailable === true;
    const baseTotal = parseMoney(rawPayload.rent);

    const feesLines = parseFeeLines(rawPayload.fees);
    const taxesLines = parseFeeLines(rawPayload.taxes);
    const travelInsuranceLines = parseFeeLines(
      rawPayload.travelInsurance ? [rawPayload.travelInsurance] : [],
    );
    const damageProtectionLines = parseFeeLines(
      rawPayload.damageProtection ? [rawPayload.damageProtection] : [],
    );

    const allFeeLines = [
      ...feesLines,
      ...travelInsuranceLines,
      ...damageProtectionLines,
    ];

    const taxesTotal = sumFeeLines(taxesLines);
    const feesTotalExclTaxes = sumFeeLines(allFeeLines);

    const parsedBookingTotal = parseMoney(rawPayload.bookingTotal);
    const computedGrandTotal =
      baseTotal !== null
        ? roundCurrency(baseTotal + taxesTotal + feesTotalExclTaxes)
        : null;
    const grandTotal = parsedBookingTotal ?? computedGrandTotal;

    if (!isAvailable || baseTotal === null || baseTotal <= 0) {
      return {
        success: false,
        elapsedMs: performance.now() - startedAt,
        error: toError({
          code: "QUOTE_UNAVAILABLE",
          message:
            apiError ??
            errorMsg ??
            "Dates unavailable for selected stay window",
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
    const isAbortError = error instanceof Error && error.name === "AbortError";
    return {
      success: false,
      elapsedMs: performance.now() - startedAt,
      error: toError({
        code: isAbortError ? "QUOTE_TIMEOUT" : "QUOTE_REQUEST_FAILED",
        message: isAbortError
          ? `Quote request timed out after ${timeoutMs}ms`
          : error instanceof Error
            ? error.message
            : "Quote request failed",
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
    clearTimeout(timeoutHandle);
  }
}
