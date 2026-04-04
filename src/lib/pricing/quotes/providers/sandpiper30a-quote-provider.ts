import type { QuoteProgress } from "@/lib/pricing/quotes/types";
import type {
  SingleQuoteObservationInput,
  SingleQuoteObservationResult,
} from "@/lib/pricing/scraper-engine/types";

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

const BASE_HOST = "https://sandpipervacationrentals.com";
const AJAX_ENDPOINT = `${BASE_HOST}/wp-admin/admin-ajax.php`;
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
  const match = fragmentHtml.match(
    /id=["']book-now["'][^>]*href=["']([^"']+)["']/i,
  );
  const href = match?.[1]?.trim() ?? "";
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
  nights: number;
  adults: number;
  children: number;
  progress?: QuoteProgress | null;
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

    if (bookHref) {
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
          if (parsed.grandTotal !== null) {
            grandTotal = parsed.grandTotal;
          }
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        input.progress?.tick(
          `listing_unit=${input.unitCode} booking_fetch_error=${message}`,
        );
      }
    }

    const quoteAvailable =
      payload.success === true &&
      totalFromFragment !== null &&
      (grandTotal !== null || baseTotal !== null);

    return {
      startDate: input.startDate,
      endDate: input.endDate,
      quoteAvailable,
      quoteUnavailableReason: quoteAvailable
        ? null
        : (unavailableReason ?? "Quote unavailable for selected stay window"),
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

export async function runSandpiper30aSingleQuoteObservation(
  input: SingleQuoteObservationInput,
  progress: QuoteProgress | null = null,
): Promise<SingleQuoteObservationResult> {
  const startedAt = performance.now();
  const unitCode = asOptionalString(input.quoteContext?.unit_code);
  const detailUrlFromContext = asOptionalString(input.quoteContext?.detail_url);
  const detailUrl = detailUrlFromContext ?? input.detailUrl;
  const searchNonce = asOptionalString(input.quoteContext?.search_nonce);

  if (!unitCode) {
    return {
      elapsedMs: performance.now() - startedAt,
      observation: {
        startDate: input.checkInIso,
        endDate: input.checkOutIso,
        quoteAvailable: false,
        currency: null,
        baseTotal: null,
        taxesTotal: null,
        feesTotalExclTaxes: null,
        grandTotal: null,
        quotedTotal: null,
        handoffUrl: input.handoffUrl ?? null,
        reason: "missing_quote_context_unit_code",
      },
    };
  }

  const nights = Math.max(
    1,
    Math.round(
      (new Date(`${input.checkOutIso}T00:00:00.000Z`).getTime() -
        new Date(`${input.checkInIso}T00:00:00.000Z`).getTime()) /
        86400000,
    ),
  );

  const raw = await fetchQuoteObservation({
    detailUrl,
    unitCode,
    searchNonce,
    startDate: input.checkInIso,
    endDate: input.checkOutIso,
    nights,
    adults: Math.max(1, Math.floor(input.adults)),
    children: Math.max(0, Math.floor(input.children)),
    progress,
  });

  const feesTotalExclTaxes = raw.feesTotal;
  const quotedTotal = raw.grandTotal;
  const reason = raw.quoteAvailable
    ? null
    : (raw.quoteUnavailableReason ?? "Quote unavailable");

  return {
    elapsedMs: performance.now() - startedAt,
    observation: {
      startDate: raw.startDate,
      endDate: raw.endDate,
      quoteAvailable: raw.quoteAvailable,
      currency: raw.currency || null,
      baseTotal: raw.baseTotal,
      taxesTotal: raw.taxesTotal,
      feesTotalExclTaxes,
      grandTotal: raw.grandTotal,
      quotedTotal,
      handoffUrl: raw.handoffUrl,
      reason,
    },
  };
}
