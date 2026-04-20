import type { QuoteExecutionRequest, QuoteExecutionResult } from "../types";

type OwnerrezCharge = {
  type?: unknown;
  description?: unknown;
  amount?: unknown;
};

type OwnerrezQuoteResponse = {
  succeeded?: unknown;
  total?: unknown;
  errors?: unknown;
  charges?: unknown;
  currencyThreeLetter?: unknown;
};

type ThirtyAFivestarQuoteContext = {
  propertyKey: string;
  widgetKey: string;
  detailUrl: string;
  referrerUrl: string;
};

const ADAPTER_KEY = "30afivestar" as const;
const OWNERREZ_QUOTE_ENDPOINT = "https://app.ownerrez.com/widgets/quote";
const OWNERREZ_HANDOFF_ENDPOINT =
  "https://app.ownerrez.com/widgets/inquirybook";
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_RUNTIME_REFERRER_URL = "https://30acollections.com/";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
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

function normalizeTimeoutMs(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.max(1000, Math.floor(raw));
}

function normalizeUrlCandidate(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return new URL(trimmed).toString();
  } catch {
    return null;
  }
}

function resolveRuntimeReferrer(
  context: Record<string, unknown> | null,
): string {
  const contextReferrer =
    normalizeUrlCandidate(context?.referrer) ??
    normalizeUrlCandidate(context?.original_referrer) ??
    normalizeUrlCandidate(context?.host_url);

  if (contextReferrer) {
    return contextReferrer;
  }

  const envReferrer = normalizeUrlCandidate(
    process.env.THIRTYAFIVESTAR_OWNERREZ_REFERRER_URL,
  );
  if (envReferrer) {
    return envReferrer;
  }

  return DEFAULT_RUNTIME_REFERRER_URL;
}

function toOwnerrezDate(isoDate: string): string {
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];

  const parsed = new Date(`${isoDate}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    return isoDate;
  }

  const weekday = weekdays[parsed.getUTCDay()] ?? "";
  const month = months[parsed.getUTCMonth()] ?? "";
  const day = String(parsed.getUTCDate());
  const year = String(parsed.getUTCFullYear());
  return `${weekday} ${month} ${day} ${year}`.trim();
}

function buildHandoffUrl(input: {
  propertyKey: string;
  widgetKey: string;
  referrerUrl: string;
  checkInIso: string;
  checkOutIso: string;
  adults: number;
  children: number;
  pets: number;
}): string {
  const endpoint = `${OWNERREZ_HANDOFF_ENDPOINT}?key=${encodeURIComponent(input.widgetKey)}`;

  // OwnerRez checkout bootstraps with a POST to inquirybook, then redirects.
  const formPayload = new URLSearchParams();
  formPayload.set("HostUrl", input.referrerUrl);
  formPayload.set("OriginalReferrer", input.referrerUrl);
  formPayload.set("Referrer", input.referrerUrl);
  formPayload.set("SplitName", "False");
  formPayload.set("RequirePhone", "False");
  formPayload.set("AllowNonSpecificDates", "False");
  formPayload.set("ChannelLinkedAccountId", "");
  formPayload.set("ListingSite", "");
  formPayload.set("PropertyKeyx", input.propertyKey);
  formPayload.set("ArrivalDate", toOwnerrezDate(input.checkInIso));
  formPayload.set("DepartureDate", toOwnerrezDate(input.checkOutIso));
  formPayload.set("Adults", String(Math.max(1, input.adults)));
  formPayload.set(
    "Children",
    input.children > 0 ? String(Math.max(0, input.children)) : "",
  );
  formPayload.set(
    "Pets",
    input.pets > 0 ? String(Math.max(0, input.pets)) : "",
  );
  formPayload.set("DiscountCode", "");
  formPayload.set("Name", "Quote Runtime");
  formPayload.set("Email", "quote-runtime@beachhouseclassifieds.local");
  formPayload.set("Phone.Original", "");
  formPayload.set("Phone.E164", "");
  formPayload.set("Phone.Extension", "");
  formPayload.set("Comments", "");
  formPayload.set("OptInTransactionalSms", "false");
  formPayload.set("actionType", "Book");

  const handoffMeta = new URLSearchParams();
  handoffMeta.set("method", "POST");
  handoffMeta.set(
    "contentType",
    "application/x-www-form-urlencoded; charset=UTF-8",
  );
  handoffMeta.set("payload", formPayload.toString());

  return `${endpoint}#${handoffMeta.toString()}`;
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
): ThirtyAFivestarQuoteContext {
  const context =
    input.quoteContext &&
    typeof input.quoteContext === "object" &&
    !Array.isArray(input.quoteContext)
      ? input.quoteContext
      : null;

  const propertyKey = asOptionalString(context?.property_key);
  const widgetKey = asOptionalString(context?.widget_key);
  const detailUrl = asOptionalString(context?.detail_url);
  const referrerUrl = resolveRuntimeReferrer(context);

  if (!propertyKey || !widgetKey || !detailUrl) {
    throw new Error(
      `Missing required quote_context fields (property_key, widget_key, detail_url) for ${ADAPTER_KEY} listing ${input.listingId}`,
    );
  }

  return {
    propertyKey,
    widgetKey,
    detailUrl,
    referrerUrl,
  };
}

function parseCharges(chargesRaw: unknown): {
  baseTotal: number;
  taxesTotal: number;
  feesTotalExclTaxes: number;
} {
  const charges = Array.isArray(chargesRaw)
    ? (chargesRaw as OwnerrezCharge[])
    : [];

  let baseTotal = 0;
  let taxesTotal = 0;
  let feesTotalExclTaxes = 0;

  for (const charge of charges) {
    const amount = parseMoney(charge.amount);
    if (amount === null) {
      continue;
    }

    const chargeType = asOptionalString(charge.type)?.toLowerCase() ?? "";
    if (chargeType === "rent") {
      baseTotal += amount;
      continue;
    }

    if (chargeType === "tax") {
      taxesTotal += amount;
      continue;
    }

    feesTotalExclTaxes += amount;
  }

  return {
    baseTotal: roundCurrency(baseTotal),
    taxesTotal: roundCurrency(taxesTotal),
    feesTotalExclTaxes: roundCurrency(feesTotalExclTaxes),
  };
}

export async function execute30AFivestarSingleQuote(
  input: QuoteExecutionRequest,
): Promise<QuoteExecutionResult> {
  const startedAt = performance.now();
  const timeoutMs = normalizeTimeoutMs(input.options?.timeoutMs);

  let quoteContext: ThirtyAFivestarQuoteContext;
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

  const handoffUrl = buildHandoffUrl({
    propertyKey: quoteContext.propertyKey,
    widgetKey: quoteContext.widgetKey,
    referrerUrl: quoteContext.referrerUrl,
    checkInIso: input.checkInIso,
    checkOutIso: input.checkOutIso,
    adults: Math.max(1, input.adults),
    children: Math.max(0, input.children),
    pets: 0,
  });

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const requestUrl = new URL(OWNERREZ_QUOTE_ENDPOINT);
    requestUrl.searchParams.set("propertyKey", quoteContext.propertyKey);
    requestUrl.searchParams.set("widgetKey", quoteContext.widgetKey);
    requestUrl.searchParams.set(
      "arrivalDate",
      toOwnerrezDate(input.checkInIso),
    );
    requestUrl.searchParams.set(
      "departureDate",
      toOwnerrezDate(input.checkOutIso),
    );
    requestUrl.searchParams.set("adults", String(Math.max(1, input.adults)));
    requestUrl.searchParams.set(
      "children",
      input.children > 0 ? String(input.children) : "",
    );
    requestUrl.searchParams.set("pets", "");
    requestUrl.searchParams.set("discountCode", "");
    requestUrl.searchParams.set("displayCulture", "");
    requestUrl.searchParams.set("originalReferrer", quoteContext.referrerUrl);
    requestUrl.searchParams.set("channelLinkedAccountId", "");
    requestUrl.searchParams.set("listingSite", "");
    requestUrl.searchParams.set("noCacheStamp", String(Date.now()));
    requestUrl.searchParams.set("_", String(Date.now()));

    const response = await fetch(requestUrl.toString(), {
      method: "GET",
      headers: {
        accept: "application/json, text/plain, */*",
        "user-agent": USER_AGENT,
        referer: quoteContext.detailUrl,
      },
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
          message: `OwnerRez quote HTTP ${response.status}`,
          retryable: response.status >= 500 || response.status === 429,
          listingId: input.listingId,
          checkInIso: input.checkInIso,
          checkOutIso: input.checkOutIso,
          details: {
            handoff_url: handoffUrl,
          },
        }),
      };
    }

    const payload = (await response.json()) as OwnerrezQuoteResponse;
    const succeeded = payload.succeeded === true;
    const total = parseMoney(payload.total);
    const errorsMessage =
      asOptionalString(payload.errors) ?? "Quote unavailable";
    const currency = asOptionalString(payload.currencyThreeLetter) ?? "USD";

    const { baseTotal, taxesTotal, feesTotalExclTaxes } = parseCharges(
      payload.charges,
    );

    const grandTotal =
      total ?? roundCurrency(baseTotal + taxesTotal + feesTotalExclTaxes);

    if (!succeeded || !grandTotal || grandTotal <= 0 || baseTotal <= 0) {
      return {
        success: false,
        elapsedMs: performance.now() - startedAt,
        error: toError({
          code: "QUOTE_UNAVAILABLE",
          message: errorsMessage,
          retryable: true,
          listingId: input.listingId,
          checkInIso: input.checkInIso,
          checkOutIso: input.checkOutIso,
          details: {
            handoff_url: handoffUrl,
            succeeded,
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
        currency,
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
          handoff_url: handoffUrl,
        },
      }),
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
}
