import type { QuoteExecutionRequest, QuoteExecutionResult } from "../types";

type CoastStatus = {
  code?: unknown;
  description?: unknown;
};

type CoastFeeLine = {
  name?: unknown;
  value?: unknown;
  active?: unknown;
};

type CoastQuoteData = {
  price?: unknown;
  taxes?: unknown;
  total?: unknown;
  currency?: unknown;
  required_fees?: unknown;
  optional_fees?: unknown;
  taxes_details?: unknown;
};

type CoastQuoteResponse = {
  status?: CoastStatus;
  data?: CoastQuoteData;
};

type CoastQuoteContext = {
  unitId: string;
  detailUrl: string;
};

const ADAPTER_KEY = "coastproperties30a" as const;
const BASE_HOST = "https://www.coast-properties.com";
const AJAX_ENDPOINT = `${BASE_HOST}/wp-admin/admin-ajax.php`;
const MAX_RATE_LIMIT_RETRIES = 2;
const RATE_LIMIT_BACKOFF_MS = 900;
const DEFAULT_TIMEOUT_MS = 20000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
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

function sumFeeLines(lines: Array<{ name: string; amount: number }>): number {
  return roundCurrency(lines.reduce((sum, line) => sum + line.amount, 0));
}

function parseFeeArray(
  value: unknown,
): Array<{ name: string; amount: number }> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      const line = entry as CoastFeeLine;
      const amount = parseMoney(line.value);
      if (amount === null) {
        return null;
      }
      const name = (typeof line.name === "string" && line.name.trim()) || "Fee";
      return { name, amount };
    })
    .filter((line): line is { name: string; amount: number } => line !== null);
}

function parseActiveOptionalFeeArray(
  value: unknown,
): Array<{ name: string; amount: number }> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      const line = entry as CoastFeeLine;
      const isActive =
        line.active === 1 || line.active === "1" || line.active === true;
      if (!isActive) {
        return null;
      }

      const amount = parseMoney(line.value);
      if (amount === null) {
        return null;
      }

      const name =
        (typeof line.name === "string" && line.name.trim()) || "Optional Fee";
      return { name, amount };
    })
    .filter((line): line is { name: string; amount: number } => line !== null);
}

function toUsDate(isoDate: string): string {
  const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return isoDate;
  }
  return `${match[2]}/${match[3]}/${match[1]}`;
}

function buildCheckoutUrl(input: {
  unitId: string;
  adults: number;
  children: number;
  startDateIso: string;
  endDateIso: string;
}): string {
  const params = new URLSearchParams();
  params.set("unit", input.unitId);
  params.set("oc", String(Math.max(1, input.adults)));
  params.set("sd", input.startDateIso);
  params.set("ed", input.endDateIso);
  params.set("os", String(Math.max(0, input.children)));
  return `${BASE_HOST}/checkout/?${params.toString()}`;
}

function normalizeTimeoutMs(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.max(1000, Math.floor(raw));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function toError(input: {
  code: string;
  message: string;
  retryable: boolean;
  listingId: string;
  checkInIso: string;
  checkOutIso: string;
}): QuoteExecutionResult {
  return {
    success: false,
    elapsedMs: 0,
    error: {
      code: input.code,
      message: input.message,
      retryable: input.retryable,
      details: {
        adapterKey: ADAPTER_KEY,
        listingId: input.listingId,
        checkInIso: input.checkInIso,
        checkOutIso: input.checkOutIso,
      },
    },
  };
}

function extractQuoteContext(input: QuoteExecutionRequest): CoastQuoteContext {
  const context =
    input.quoteContext &&
    typeof input.quoteContext === "object" &&
    !Array.isArray(input.quoteContext)
      ? input.quoteContext
      : null;

  const unitId = asString(context?.unit_id);
  const detailUrl = asString(context?.detail_url);

  if (!unitId || !detailUrl) {
    throw new Error(
      `Missing required quote_context values for ${ADAPTER_KEY} listing ${input.listingId}. Required: unit_id, detail_url`,
    );
  }

  return { unitId, detailUrl };
}

export async function executeCoastproperties30aSingleQuote(
  input: QuoteExecutionRequest,
): Promise<QuoteExecutionResult> {
  const startedAt = performance.now();
  const timeoutMs = normalizeTimeoutMs(input.options?.timeoutMs);

  let context: CoastQuoteContext;
  try {
    context = extractQuoteContext(input);
  } catch (error: unknown) {
    const failure = toError({
      code: "QUOTE_CONTEXT_MISSING",
      message: error instanceof Error ? error.message : "Missing quote context",
      retryable: false,
      listingId: input.listingId,
      checkInIso: input.checkInIso,
      checkOutIso: input.checkOutIso,
    });
    return {
      ...failure,
      elapsedMs: performance.now() - startedAt,
    };
  }

  const defaultUnavailable = {
    startDate: input.checkInIso,
    endDate: input.checkOutIso,
    quoteAvailable: false,
    quoteUnavailableReason: "Quote response unavailable",
    currency: "USD",
    baseTotal: null,
    taxesTotal: null,
    feesTotalExclTaxes: null,
    grandTotal: null,
    quotedTotal: null,
    handoffUrl: buildCheckoutUrl({
      unitId: context.unitId,
      adults: input.adults,
      children: input.children,
      startDateIso: input.checkInIso,
      endDateIso: input.checkOutIso,
    }),
  };

  const availabilityPayload = {
    methodName: "VerifyPropertyAvailability",
    params: {
      unit_id: Number(context.unitId),
      startdate: toUsDate(input.checkInIso),
      enddate: toUsDate(input.checkOutIso),
      occupants: String(Math.max(1, input.adults)),
      occupants_small: String(Math.max(0, input.children)),
      pets: "0",
      use_room_type_logic: 0,
      include_coupon_information: 1,
    },
  };

  try {
    for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
      const availabilityBody = new URLSearchParams();
      availabilityBody.set("action", "streamlinecore-api-request");
      availabilityBody.set("params", JSON.stringify(availabilityPayload));

      const availabilityResponse = await fetch(AJAX_ENDPOINT, {
        method: "POST",
        headers: {
          accept: "application/json, text/plain, */*",
          "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
          "user-agent": USER_AGENT,
          referer: context.detailUrl,
          origin: BASE_HOST,
        },
        body: availabilityBody.toString(),
      });

      if (
        availabilityResponse.status === 429 &&
        attempt < MAX_RATE_LIMIT_RETRIES
      ) {
        await sleep(RATE_LIMIT_BACKOFF_MS * (attempt + 1));
        continue;
      }

      if (!availabilityResponse.ok) {
        return {
          success: true,
          elapsedMs: performance.now() - startedAt,
          observation: {
            ...defaultUnavailable,
            quoteUnavailableReason: `VerifyPropertyAvailability HTTP ${availabilityResponse.status}`,
          },
        };
      }

      let availabilityParsed: CoastQuoteResponse;
      try {
        availabilityParsed =
          (await availabilityResponse.json()) as CoastQuoteResponse;
      } catch {
        return {
          success: true,
          elapsedMs: performance.now() - startedAt,
          observation: {
            ...defaultUnavailable,
            quoteUnavailableReason:
              "VerifyPropertyAvailability returned invalid JSON",
          },
        };
      }

      const availabilityStatus = availabilityParsed.status;
      if (availabilityStatus && typeof availabilityStatus === "object") {
        const code = asString(availabilityStatus.code);
        const reason =
          asString(availabilityStatus.description) ?? "Dates unavailable";
        return {
          success: true,
          elapsedMs: performance.now() - startedAt,
          observation: {
            ...defaultUnavailable,
            quoteUnavailableReason: code ? `${code}: ${reason}` : reason,
          },
        };
      }

      break;
    }

    const requestPayload = {
      methodName: "GetPreReservationPrice",
      params: {
        unit_id: Number(context.unitId),
        startdate: toUsDate(input.checkInIso),
        enddate: toUsDate(input.checkOutIso),
        occupants: String(Math.max(1, input.adults)),
        occupants_small: String(Math.max(0, input.children)),
        pets: "0",
        include_coupon_information: 1,
      },
    };

    for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
      const body = new URLSearchParams();
      body.set("action", "streamlinecore-api-request");
      body.set("params", JSON.stringify(requestPayload));

      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetch(AJAX_ENDPOINT, {
          method: "POST",
          headers: {
            accept: "application/json, text/plain, */*",
            "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
            "user-agent": USER_AGENT,
            referer: context.detailUrl,
            origin: BASE_HOST,
          },
          body: body.toString(),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutHandle);
      }

      if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
        await sleep(RATE_LIMIT_BACKOFF_MS * (attempt + 1));
        continue;
      }

      if (!response.ok) {
        return {
          success: true,
          elapsedMs: performance.now() - startedAt,
          observation: {
            ...defaultUnavailable,
            quoteUnavailableReason: `Quote HTTP ${response.status}`,
          },
        };
      }

      let parsed: CoastQuoteResponse;
      try {
        parsed = (await response.json()) as CoastQuoteResponse;
      } catch {
        return {
          success: true,
          elapsedMs: performance.now() - startedAt,
          observation: {
            ...defaultUnavailable,
            quoteUnavailableReason: "Quote endpoint returned invalid JSON",
          },
        };
      }

      const status = parsed.status;
      if (status && typeof status === "object") {
        const code = asString(status.code);
        const reason = asString(status.description) ?? "Dates unavailable";
        return {
          success: true,
          elapsedMs: performance.now() - startedAt,
          observation: {
            ...defaultUnavailable,
            quoteUnavailableReason: code ? `${code}: ${reason}` : reason,
          },
        };
      }

      const data = (parsed.data ?? {}) as CoastQuoteData;
      const baseTotal = parseMoney(data.price);
      const grandTotal = parseMoney(data.total);
      const currency = asString(data.currency) ?? "USD";

      const requiredFeeLines = parseFeeArray(data.required_fees);
      const optionalFeeLines = parseActiveOptionalFeeArray(data.optional_fees);
      const feeLines = [...requiredFeeLines, ...optionalFeeLines];
      const feesTotal = sumFeeLines(feeLines);

      const taxesLines = parseFeeArray(data.taxes_details);
      let taxesTotal = sumFeeLines(taxesLines);
      if (taxesTotal === 0) {
        const taxesAggregate = parseMoney(data.taxes);
        if (taxesAggregate !== null) {
          taxesTotal = Math.max(0, roundCurrency(taxesAggregate - feesTotal));
        }
      }

      if (
        baseTotal === null ||
        baseTotal < 100 ||
        taxesTotal <= 0 ||
        grandTotal === null ||
        grandTotal <= baseTotal ||
        feesTotal >= baseTotal
      ) {
        return {
          success: true,
          elapsedMs: performance.now() - startedAt,
          observation: {
            ...defaultUnavailable,
            quoteUnavailableReason:
              "Quote payload totals were incomplete or inconsistent",
          },
        };
      }

      return {
        success: true,
        elapsedMs: performance.now() - startedAt,
        observation: {
          startDate: input.checkInIso,
          endDate: input.checkOutIso,
          quoteAvailable: true,
          quoteUnavailableReason: null,
          currency,
          baseTotal,
          taxesTotal,
          feesTotalExclTaxes: feesTotal,
          grandTotal,
          quotedTotal: grandTotal,
          handoffUrl: defaultUnavailable.handoffUrl,
        },
      };
    }

    return {
      success: true,
      elapsedMs: performance.now() - startedAt,
      observation: {
        ...defaultUnavailable,
        quoteUnavailableReason: "Too many requests after retry attempts",
      },
    };
  } catch (error: unknown) {
    const isAbort =
      error instanceof DOMException && error.name === "AbortError";
    const failure = toError({
      code: isAbort ? "QUOTE_TIMEOUT" : "QUOTE_EXECUTION_FAILED",
      message: isAbort
        ? `Quote request timed out after ${timeoutMs}ms`
        : error instanceof Error
          ? error.message
          : "Unknown quote execution error",
      retryable: isAbort,
      listingId: input.listingId,
      checkInIso: input.checkInIso,
      checkOutIso: input.checkOutIso,
    });

    return {
      ...failure,
      elapsedMs: performance.now() - startedAt,
    };
  }
}
