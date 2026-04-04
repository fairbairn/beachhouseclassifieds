import type { QuoteExecutionRequest, QuoteExecutionResult } from "../types";

type AjaxQuoteResponse = {
  success?: unknown;
  data?: unknown;
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
  feeLines: Array<{ name: string; amount: number }>;
};

const ADAPTER_KEY = "sandpiper30a" as const;
const BASE_HOST = "https://sandpipervacationrentals.com";
const AJAX_ENDPOINT = `${BASE_HOST}/wp-admin/admin-ajax.php`;
const MIN_VALID_BASE_TOTAL = 100;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

function parseMoney(value: string): number | null {
  const cleaned = value.replace(/[$,\s]/g, "").trim();
  if (!cleaned) {
    return null;
  }

  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? roundCurrency(parsed) : null;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function stripHtml(value: string): string {
  return decodeHtmlEntities(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTotalFromQuoteFragment(fragmentHtml: string): number | null {
  const match = fragmentHtml.match(
    /class=["'][^"']*total-price[^"']*["'][^>]*>\s*\$([0-9,]+(?:\.[0-9]{2})?)\s*</i,
  );
  if (!match?.[1]) {
    return null;
  }
  return parseMoney(match[1]);
}

function extractBookHrefFromQuoteFragment(fragmentHtml: string): string | null {
  const anchorMatch = fragmentHtml.match(/<a[^>]*id=["']book-now["'][^>]*>/i);
  const anchorTag = anchorMatch?.[0] ?? "";
  const hrefMatch = anchorTag.match(/href=["']([^"']+)["']/i);
  const href = hrefMatch?.[1]?.trim() ?? "";
  if (!href) {
    return null;
  }

  try {
    const absolute = new URL(decodeHtmlEntities(href), BASE_HOST);
    absolute.pathname = absolute.pathname.replace(/\/$/, "") + "/";
    return absolute.toString();
  } catch {
    return null;
  }
}

function parseBookingBreakdown(bookingHtml: string): {
  baseTotal: number | null;
  taxesTotal: number | null;
  feesTotal: number | null;
  grandTotal: number | null;
  feeLines: Array<{ name: string; amount: number }>;
} {
  const summaryBlockMatch = bookingHtml.match(
    /<div class="payment-summary booking-form__payment-summary">([\s\S]*?)<\/div>\s*<\/div>/i,
  );
  const summaryBlock = summaryBlockMatch?.[1] ?? bookingHtml;

  const subTotalMatch = summaryBlock.match(
    /<td>\s*Sub\s*Total\s*<\/td>\s*<td[^>]*>\s*\$([0-9,]+(?:\.[0-9]{2})?)\s*<\/td>/i,
  );
  const taxesMatch = summaryBlock.match(
    /<td>\s*Taxes\s*<\/td>\s*<td[^>]*>\s*\$([0-9,]+(?:\.[0-9]{2})?)\s*<\/td>/i,
  );
  const totalMatch = summaryBlock.match(
    /<td>\s*<strong>\s*Total\s*<\/strong>\s*<\/td>\s*<td[^>]*>\s*<strong>\s*\$([0-9,]+(?:\.[0-9]{2})?)\s*<\/strong>\s*<\/td>/i,
  );

  const subTotal = subTotalMatch?.[1] ? parseMoney(subTotalMatch[1]) : null;
  const taxesTotal = taxesMatch?.[1] ? parseMoney(taxesMatch[1]) : null;
  const grandTotal = totalMatch?.[1] ? parseMoney(totalMatch[1]) : null;

  const rateRowsMatch = summaryBlock.match(
    /<table class="table payment-summary__rate-breakdown">([\s\S]*?)<\/table>/i,
  );
  const rateRows = rateRowsMatch?.[1] ?? "";

  const rowRegex =
    /<tr>\s*<td>([\s\S]*?)<\/td>\s*<td[^>]*>\s*\$([0-9,]+(?:\.[0-9]{2})?)\s*<\/td>\s*<\/tr>/gi;

  let baseTotal: number | null = null;
  const feeLines: Array<{ name: string; amount: number }> = [];

  for (const match of rateRows.matchAll(rowRegex)) {
    const label = stripHtml(match[1] ?? "");
    const amount = parseMoney(match[2] ?? "");
    if (!label || amount === null) {
      continue;
    }

    if (/^rate\s*\(/i.test(label) || /^rate\b/i.test(label)) {
      if (baseTotal === null) {
        baseTotal = amount;
      }
      continue;
    }

    feeLines.push({ name: label, amount });
  }

  const feeLinesTotal = feeLines.length
    ? roundCurrency(feeLines.reduce((sum, line) => sum + line.amount, 0))
    : null;

  let feesTotal: number | null = null;
  if (subTotal !== null && baseTotal !== null) {
    feesTotal = roundCurrency(Math.max(0, subTotal - baseTotal));
  } else {
    feesTotal = feeLinesTotal;
  }

  return {
    baseTotal,
    taxesTotal,
    feesTotal,
    grandTotal,
    feeLines,
  };
}

function resolveGrandTotal(input: {
  baseTotal: number | null;
  taxesTotal: number | null;
  feesTotal: number | null;
  parsedGrandTotal: number | null;
  fallbackGrandTotal: number | null;
}): number | null {
  const derivedFromParts =
    input.baseTotal !== null &&
    input.taxesTotal !== null &&
    input.feesTotal !== null
      ? roundCurrency(input.baseTotal + input.taxesTotal + input.feesTotal)
      : null;

  if (derivedFromParts !== null) {
    return derivedFromParts;
  }

  if (input.parsedGrandTotal !== null) {
    return input.parsedGrandTotal;
  }

  return input.fallbackGrandTotal;
}

function parseUnavailableReason(fragmentHtml: string): string | null {
  const listItemMatch = fragmentHtml.match(
    /class=["'][^"']*stay-error-list-item[^"']*["'][^>]*>([\s\S]*?)<\/li>/i,
  );
  if (listItemMatch?.[1]) {
    const reason = stripHtml(listItemMatch[1]);
    if (reason.length > 0) {
      return reason;
    }
  }

  const text = stripHtml(fragmentHtml).toLowerCase();
  if (!text) {
    return "Empty quote response";
  }
  if (text.includes("not available")) {
    return "Dates unavailable for selected stay window";
  }
  if (text.includes("please select") || text.includes("required")) {
    return "Quote API rejected request parameters";
  }
  return null;
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

function buildFallbackHandoffUrl(input: {
  startDate: string;
  endDate: string;
  unitCode: string;
  adults: number;
  children: number;
}): string {
  const params = new URLSearchParams();
  params.set("start_date", input.startDate);
  params.set("end_date", input.endDate);
  params.set("unit_code", input.unitCode);
  params.set(
    "guests",
    `${Math.max(1, input.adults)},${Math.max(0, input.children)}`,
  );
  return `${BASE_HOST}/booking/?${params.toString()}`;
}

function asOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function fetchQuoteObservation(input: {
  detailUrl: string;
  unitCode: string;
  searchNonce: string | null;
  startDate: string;
  endDate: string;
  adults: number;
  children: number;
}): Promise<RawObservation> {
  const query = new URLSearchParams();
  query.set("post_type", "vacation_rental");
  query.set("s", "");
  query.set("action", "q4vr_stay");
  query.set("unit_code", input.unitCode);
  query.set("start_date", input.startDate);
  query.set("end_date", input.endDate);
  query.set(
    "guests",
    `${Math.max(1, input.adults)},${Math.max(0, input.children)},0`,
  );
  if (input.searchNonce) {
    query.set("search_nonce", input.searchNonce);
  }

  const fallbackHandoff = buildFallbackHandoffUrl({
    startDate: input.startDate,
    endDate: input.endDate,
    unitCode: input.unitCode,
    adults: input.adults,
    children: input.children,
  });

  try {
    const response = await fetch(`${AJAX_ENDPOINT}?${query.toString()}`, {
      method: "GET",
      headers: {
        accept: "application/json, text/javascript, */*; q=0.01",
        "user-agent": USER_AGENT,
        referer: input.detailUrl,
        origin: BASE_HOST,
      },
    });

    if (!response.ok) {
      return {
        startDate: input.startDate,
        endDate: input.endDate,
        quoteAvailable: false,
        quoteUnavailableReason: `Quote request failed with status ${response.status}`,
        baseTotal: null,
        taxesTotal: null,
        feesTotal: null,
        grandTotal: null,
        currency: "USD",
        handoffUrl: fallbackHandoff,
        feeLines: [],
      };
    }

    const payload = (await response.json()) as AjaxQuoteResponse;
    const fragmentHtml = typeof payload.data === "string" ? payload.data : "";
    const totalFromFragment = extractTotalFromQuoteFragment(fragmentHtml);
    const unavailableReason = parseUnavailableReason(fragmentHtml);

    const bookHref = extractBookHrefFromQuoteFragment(fragmentHtml);
    const handoffUrl = bookHref ?? fallbackHandoff;

    let baseTotal: number | null = null;
    let taxesTotal: number | null = null;
    let feesTotal: number | null = null;
    let grandTotal: number | null = totalFromFragment;
    let feeLines: Array<{ name: string; amount: number }> = [];

    if (handoffUrl) {
      try {
        const bookingResponse = await fetch(handoffUrl, {
          method: "GET",
          headers: {
            accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "user-agent": USER_AGENT,
            referer: input.detailUrl,
          },
        });

        if (bookingResponse.ok) {
          const bookingHtml = await bookingResponse.text();
          const parsed = parseBookingBreakdown(bookingHtml);
          baseTotal = parsed.baseTotal;
          taxesTotal = parsed.taxesTotal;
          feesTotal = parsed.feesTotal;
          feeLines = parsed.feeLines;
          grandTotal = resolveGrandTotal({
            baseTotal,
            taxesTotal,
            feesTotal,
            parsedGrandTotal: parsed.grandTotal,
            fallbackGrandTotal: totalFromFragment,
          });
        }
      } catch {
        // Keep quote fragment totals when booking fetch fails.
      }
    }

    const preliminaryAvailable =
      payload.success === true &&
      totalFromFragment !== null &&
      (grandTotal !== null || baseTotal !== null);

    const availabilityError = preliminaryAvailable
      ? validateAvailableTotals({
          baseTotal,
          taxesTotal,
          feesTotal,
          grandTotal,
        })
      : null;

    const quoteAvailable = preliminaryAvailable && availabilityError === null;

    return {
      startDate: input.startDate,
      endDate: input.endDate,
      quoteAvailable,
      quoteUnavailableReason: quoteAvailable
        ? null
        : (availabilityError ??
          unavailableReason ??
          "Quote unavailable for selected stay window"),
      baseTotal,
      taxesTotal,
      feesTotal,
      grandTotal,
      currency: "USD",
      handoffUrl,
      feeLines,
    };
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Quote request failed";
    return {
      startDate: input.startDate,
      endDate: input.endDate,
      quoteAvailable: false,
      quoteUnavailableReason: message,
      baseTotal: null,
      taxesTotal: null,
      feesTotal: null,
      grandTotal: null,
      currency: "USD",
      handoffUrl: fallbackHandoff,
      feeLines: [],
    };
  }
}

function resolveRuntimeQuoteContext(input: QuoteExecutionRequest): {
  detailUrl: string;
  quoteContext: Record<string, unknown>;
} {
  const context =
    input.quoteContext &&
    typeof input.quoteContext === "object" &&
    !Array.isArray(input.quoteContext)
      ? { ...input.quoteContext }
      : null;

  const detailUrl = asOptionalString(context?.detail_url);
  const unitCode = asOptionalString(context?.unit_code);

  if (!detailUrl || !unitCode) {
    throw new Error(
      `Missing required quoteContext.unit_code/detail_url for ${ADAPTER_KEY} listing ${input.listingId}`,
    );
  }

  return {
    detailUrl,
    quoteContext: {
      ...context,
      detail_url: detailUrl,
      unit_code: unitCode,
    },
  };
}

export async function executeSandpiper30aSingleQuote(
  input: QuoteExecutionRequest,
): Promise<QuoteExecutionResult> {
  let runtimeContext: {
    detailUrl: string;
    quoteContext: Record<string, unknown>;
  };
  try {
    runtimeContext = resolveRuntimeQuoteContext(input);
  } catch (error: unknown) {
    return {
      success: false,
      elapsedMs: 0,
      error: {
        code: "QUOTE_CONTEXT_MISSING",
        message:
          error instanceof Error ? error.message : "Quote context missing",
        retryable: false,
        details: {
          adapterKey: ADAPTER_KEY,
          listingId: input.listingId,
          checkInIso: input.checkInIso,
          checkOutIso: input.checkOutIso,
        },
      },
    };
  }

  const startedAt = Date.now();
  const searchNonce = asOptionalString(
    runtimeContext.quoteContext.search_nonce,
  );
  const unitCode = asOptionalString(runtimeContext.quoteContext.unit_code);
  if (!unitCode) {
    return {
      success: false,
      elapsedMs: 0,
      error: {
        code: "QUOTE_CONTEXT_MISSING",
        message: `Missing required quoteContext.unit_code for ${ADAPTER_KEY} listing ${input.listingId}`,
        retryable: false,
        details: {
          adapterKey: ADAPTER_KEY,
          listingId: input.listingId,
          checkInIso: input.checkInIso,
          checkOutIso: input.checkOutIso,
        },
      },
    };
  }

  try {
    const raw = await fetchQuoteObservation({
      detailUrl: runtimeContext.detailUrl,
      unitCode,
      searchNonce,
      startDate: input.checkInIso,
      endDate: input.checkOutIso,
      adults: Math.max(1, input.adults),
      children: Math.max(0, input.children),
    });

    const elapsedMs = Date.now() - startedAt;
    if (!raw.quoteAvailable) {
      return {
        success: false,
        elapsedMs,
        error: {
          code: "QUOTE_UNAVAILABLE",
          message: raw.quoteUnavailableReason ?? "Quote unavailable",
          retryable: true,
          details: {
            adapterKey: ADAPTER_KEY,
            listingId: input.listingId,
            checkInIso: input.checkInIso,
            checkOutIso: input.checkOutIso,
          },
        },
      };
    }

    return {
      success: true,
      elapsedMs,
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
      elapsedMs: 0,
      error: {
        code: "QUOTE_EXECUTION_FAILED",
        message:
          error instanceof Error ? error.message : "Quote execution failed",
        retryable: false,
        details: {
          adapterKey: ADAPTER_KEY,
          listingId: input.listingId,
          checkInIso: input.checkInIso,
          checkOutIso: input.checkOutIso,
        },
      },
    };
  }
}
