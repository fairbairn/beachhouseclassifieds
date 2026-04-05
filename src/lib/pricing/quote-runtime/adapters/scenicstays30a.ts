import type { QuoteExecutionRequest, QuoteExecutionResult } from "../types";

type QuoteRequestContext = {
  propertyId: string;
  propertyName: string;
  roomTypeId: string;
  hash: string;
  detailUrl: string;
  quoteEndpoint: string;
};

const ADAPTER_KEY = "scenicstays30a" as const;
const MIN_VALID_BASE_TOTAL = 100;
const DEFAULT_TIMEOUT_MS = 20000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toUsDate(isoDate: string): string {
  const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return isoDate;
  }
  return `${match[2]}/${match[3]}/${match[1]}`;
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

function buildHandoffUrl(input: {
  detailUrl: string;
  propertyId: string;
  checkInIso: string;
  checkOutIso: string;
}): string {
  let origin = "https://www.scenicstays30a.com";
  try {
    origin = new URL(input.detailUrl).origin;
  } catch {
    origin = "https://www.scenicstays30a.com";
  }
  const checkinUs = toUsDate(input.checkInIso);
  const checkoutUs = toUsDate(input.checkOutIso);
  return `${origin}/rentals/book-now?propertyID=${input.propertyId}&checkin=${checkinUs}&checkout=${checkoutUs}`;
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

  const propertyId =
    toPositiveIntString(context.unit_id) ??
    toPositiveIntString(context.listing_id);
  if (!propertyId) {
    throw new Error(
      `Missing required quoteContext.unit_id for ${ADAPTER_KEY} listing ${input.listingId}`,
    );
  }

  const detailUrl = asOptionalString(context.detail_url);
  if (!detailUrl) {
    throw new Error(
      `Missing required quoteContext.detail_url for ${ADAPTER_KEY} listing ${input.listingId}`,
    );
  }

  const quoteEndpointRaw = asOptionalString(context.quote_endpoint);
  const quoteEndpoint =
    quoteEndpointRaw && quoteEndpointRaw.startsWith("http")
      ? quoteEndpointRaw
      : `${new URL(detailUrl).origin}/ajax/quote`;

  const propertyName =
    asOptionalString(context.property_name) ??
    asOptionalString(context.detail_name) ??
    input.listingId;

  const roomTypeId = asOptionalString(context.room_type_id) ?? "";
  const hash = asOptionalString(context.hash) ?? "";

  return {
    propertyId,
    propertyName,
    roomTypeId,
    hash,
    detailUrl,
    quoteEndpoint,
  };
}

function extractPriceByLabel(
  fragmentHtml: string,
  label: string,
): number | null {
  const labelPattern = escapeRegExp(label);
  const regex = new RegExp(
    `<span[^>]*class=["'][^"']*pdp-quote-item-text[^"']*["'][^>]*>\\s*${labelPattern}\\s*</span>[\\s\\S]{0,260}?data-price=["']([0-9.]+)["']`,
    "i",
  );
  const match = fragmentHtml.match(regex);
  return toFiniteNumber(match?.[1] ?? null);
}

function extractPriceByLabels(
  fragmentHtml: string,
  labels: readonly string[],
): number | null {
  for (const label of labels) {
    const extracted = extractPriceByLabel(fragmentHtml, label);
    if (extracted !== null) {
      return extracted;
    }
  }
  return null;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function extractUnavailableReasonFromFragment(
  fragmentHtml: string,
): string | null {
  const unavailablePattern =
    /not available|unavailable|minimum stay|arrival\/?departure|selected dates/i;

  const alertMatch = fragmentHtml.match(
    /<div[^>]*class=["'][^"']*alert-danger[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
  );
  const raw = alertMatch?.[1] ?? "";
  const text = raw
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Prefer provider-rendered alert copy whenever it is present.
  if (text) {
    return text;
  }

  const normalizedText = fragmentHtml
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();

  if (!unavailablePattern.test(normalizedText)) {
    return null;
  }

  const sentenceMatch = normalizedText.match(
    /[^.?!]*(not available|unavailable|minimum stay|arrival\/?departure|selected dates)[^.?!]*[.?!]?/i,
  );
  return (sentenceMatch?.[0] ?? normalizedText).trim();
}

function isTransientQuoteServiceMessage(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return (
    normalized.includes("too_many_requests") ||
    normalized.includes("too many requests") ||
    normalized.includes("rate limit") ||
    normalized === "api error"
  );
}
export async function executeScenicstays30aSingleQuote(
  input: QuoteExecutionRequest,
): Promise<QuoteExecutionResult> {
  const startedAt = performance.now();
  const timeoutMs = normalizeTimeoutMs(input.options?.timeoutMs);
  const fallbackHandoffUrlWithoutContext = `https://www.scenicstays30a.com/rentals/book-now?checkin=${encodeURIComponent(toUsDate(input.checkInIso))}&checkout=${encodeURIComponent(toUsDate(input.checkOutIso))}`;

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
        details: {
          handoffUrl: fallbackHandoffUrlWithoutContext,
        },
      }),
    };
  }

  const runtimeHandoffUrl = buildHandoffUrl({
    detailUrl: quoteContext.detailUrl,
    propertyId: quoteContext.propertyId,
    checkInIso: input.checkInIso,
    checkOutIso: input.checkOutIso,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const body = new URLSearchParams();
    body.set("checkin", toUsDate(input.checkInIso));
    body.set("checkout", toUsDate(input.checkOutIso));
    body.set("propertyID", quoteContext.propertyId);
    body.set("roomTypeID", quoteContext.roomTypeId);
    body.set("propertyName", quoteContext.propertyName);
    body.set("hash", quoteContext.hash);

    const response = await fetch(quoteContext.quoteEndpoint, {
      method: "POST",
      headers: {
        accept: "text/html, */*; q=0.01",
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "x-requested-with": "XMLHttpRequest",
        "user-agent": USER_AGENT,
        referer: quoteContext.detailUrl,
        origin: new URL(quoteContext.detailUrl).origin,
      },
      body: body.toString(),
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
            handoffUrl: runtimeHandoffUrl,
          },
        }),
      };
    }

    const responseText = (await response.text()).trim();
    if (
      !responseText ||
      responseText === "No" ||
      responseText === "API Error"
    ) {
      return {
        success: false,
        elapsedMs: performance.now() - startedAt,
        error: toError({
          code: "QUOTE_UNAVAILABLE",
          message:
            responseText === "No"
              ? "Quote endpoint returned No"
              : responseText === "API Error"
                ? "Quote endpoint returned API Error"
                : "Quote endpoint returned empty response",
          retryable: true,
          listingId: input.listingId,
          checkInIso: input.checkInIso,
          checkOutIso: input.checkOutIso,
          details: {
            handoffUrl: runtimeHandoffUrl,
          },
        }),
      };
    }

    if (isTransientQuoteServiceMessage(responseText)) {
      return {
        success: false,
        elapsedMs: performance.now() - startedAt,
        error: toError({
          code: "QUOTE_RATE_LIMITED",
          message: "Quote provider temporarily throttled request",
          retryable: true,
          listingId: input.listingId,
          checkInIso: input.checkInIso,
          checkOutIso: input.checkOutIso,
          details: {
            response_preview: responseText.slice(0, 220),
            handoffUrl: runtimeHandoffUrl,
          },
        }),
      };
    }

    const baseTotal = extractPriceByLabel(responseText, "Rent");
    const taxesTotal = extractPriceByLabels(responseText, [
      "Tax",
      "Taxes",
      "Lodging Tax",
      "Lodging Taxes",
    ]);
    const feesTotal = extractPriceByLabels(responseText, [
      "Fees",
      "Fee",
      "Service Fee",
      "Guest Fee",
      "Resort Fee",
    ]);
    const subtotal = extractPriceByLabel(responseText, "Subtotal");
    const grandTotal = extractPriceByLabel(responseText, "Total");

    if (baseTotal === null || grandTotal === null) {
      const unavailableReason =
        extractUnavailableReasonFromFragment(responseText);
      if (unavailableReason) {
        if (isTransientQuoteServiceMessage(unavailableReason)) {
          return {
            success: false,
            elapsedMs: performance.now() - startedAt,
            error: toError({
              code: "QUOTE_RATE_LIMITED",
              message: "Quote provider temporarily throttled request",
              retryable: true,
              listingId: input.listingId,
              checkInIso: input.checkInIso,
              checkOutIso: input.checkOutIso,
              details: {
                response_preview: responseText.slice(0, 220),
                handoffUrl: runtimeHandoffUrl,
              },
            }),
          };
        }

        return {
          success: false,
          elapsedMs: performance.now() - startedAt,
          error: toError({
            code: "QUOTE_UNAVAILABLE",
            message: unavailableReason,
            retryable: true,
            listingId: input.listingId,
            checkInIso: input.checkInIso,
            checkOutIso: input.checkOutIso,
            details: {
              handoffUrl: runtimeHandoffUrl,
            },
          }),
        };
      }

      return {
        success: false,
        elapsedMs: performance.now() - startedAt,
        error: toError({
          code: "QUOTE_RESPONSE_INCOMPLETE",
          message: "Quote response is missing numeric totals in HTML fragment",
          retryable: false,
          listingId: input.listingId,
          checkInIso: input.checkInIso,
          checkOutIso: input.checkOutIso,
          details: {
            response_preview: responseText.slice(0, 220),
            handoffUrl: runtimeHandoffUrl,
          },
        }),
      };
    }

    if (baseTotal < MIN_VALID_BASE_TOTAL || grandTotal <= baseTotal) {
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
            rent: baseTotal,
            total: grandTotal,
            handoffUrl: runtimeHandoffUrl,
          },
        }),
      };
    }

    let feesResolved =
      feesTotal ?? (subtotal !== null ? subtotal - baseTotal : null);
    let taxesResolved =
      taxesTotal ??
      (subtotal !== null ? grandTotal - subtotal : null) ??
      (feesResolved !== null ? grandTotal - baseTotal - feesResolved : null);

    if (feesResolved === null && taxesResolved !== null) {
      feesResolved = grandTotal - baseTotal - taxesResolved;
    }

    if (feesResolved === null || taxesResolved === null) {
      return {
        success: false,
        elapsedMs: performance.now() - startedAt,
        error: toError({
          code: "QUOTE_RESPONSE_INCOMPLETE",
          message:
            "Quote response is missing required numeric fee/tax totals in HTML fragment",
          retryable: false,
          listingId: input.listingId,
          checkInIso: input.checkInIso,
          checkOutIso: input.checkOutIso,
          details: {
            has_subtotal: subtotal !== null,
            has_fees: feesTotal !== null,
            has_taxes: taxesTotal !== null,
            response_preview: responseText.slice(0, 220),
            handoffUrl: runtimeHandoffUrl,
          },
        }),
      };
    }

    feesResolved = roundMoney(Math.max(0, feesResolved));
    taxesResolved = roundMoney(Math.max(0, taxesResolved));

    if (taxesResolved <= 0) {
      return {
        success: false,
        elapsedMs: performance.now() - startedAt,
        error: toError({
          code: "QUOTE_RESPONSE_INCOMPLETE",
          message: "Quote response produced non-positive taxes total",
          retryable: false,
          listingId: input.listingId,
          checkInIso: input.checkInIso,
          checkOutIso: input.checkOutIso,
          details: {
            base_total: baseTotal,
            fees_total: feesResolved,
            taxes_total: taxesResolved,
            grand_total: grandTotal,
            handoffUrl: runtimeHandoffUrl,
          },
        }),
      };
    }

    const recomputedTotal = roundMoney(
      baseTotal + feesResolved + taxesResolved,
    );
    if (Math.abs(recomputedTotal - grandTotal) > 0.02) {
      return {
        success: false,
        elapsedMs: performance.now() - startedAt,
        error: toError({
          code: "QUOTE_RESPONSE_INCONSISTENT",
          message: "Quote totals are internally inconsistent",
          retryable: false,
          listingId: input.listingId,
          checkInIso: input.checkInIso,
          checkOutIso: input.checkOutIso,
          details: {
            base_total: baseTotal,
            fees_total: feesResolved,
            taxes_total: taxesResolved,
            grand_total: grandTotal,
            recomputed_total: recomputedTotal,
            handoffUrl: runtimeHandoffUrl,
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
        baseTotal: baseTotal,
        taxesTotal: taxesResolved,
        feesTotalExclTaxes: feesResolved,
        grandTotal: grandTotal,
        quotedTotal: grandTotal,
        handoffUrl: runtimeHandoffUrl,
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
          handoffUrl: runtimeHandoffUrl,
        },
      }),
    };
  } finally {
    clearTimeout(timer);
  }
}
