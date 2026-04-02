import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  assertCanonicalQuotesSidecarRecord,
  type CanonicalQuoteObservation,
  type CanonicalQuotesSidecarRecord,
} from "@/lib/pricing/contracts/quote-observations-contract";
import { runWithConcurrency } from "@/lib/pricing/quotes/shared/run-with-concurrency";
import type { QuoteProgress } from "@/lib/pricing/quotes/types";

type CliOptions = {
  maxListings: number;
  listingId: string | null;
  weeks: number;
  nights: number;
  adults: number;
  children: number;
  quoteConcurrency: number;
  listingConcurrency: number;
};

type SandpiperDetailRecord = {
  external_listing_id: string;
  detail_url: string;
  html_path?: string;
};

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
const DEFAULT_LISTINGS = 10;
const DEFAULT_WEEKS = 24;
const DEFAULT_NIGHTS = 7;
const DEFAULT_ADULTS = 2;
const DEFAULT_CHILDREN = 0;
const DEFAULT_QUOTE_CONCURRENCY = 3;
const DEFAULT_LISTING_CONCURRENCY = 2;
const DEFAULT_BASE_NIGHTLY_FALLBACK = 700;
const DEFAULT_FALLBACK_TAX_PCT = 0.12;
const DEFAULT_FALLBACK_FEE_PCT = 0.18;
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

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dayOfWeek(isoDate: string): number {
  return new Date(`${isoDate}T00:00:00.000Z`).getUTCDay();
}

function firstSaturdayOnOrAfter(isoDate: string): string {
  const day = dayOfWeek(isoDate);
  const delta = (6 - day + 7) % 7;
  return addDays(isoDate, delta);
}

function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return roundCurrency((sorted[middle - 1]! + sorted[middle]!) / 2);
  }
  return roundCurrency(sorted[middle]!);
}

function interpolateValue(
  values: Array<number | null>,
  index: number,
): number | null {
  const current = values[index];
  if (current !== null) {
    return current;
  }

  let leftIndex = index - 1;
  while (leftIndex >= 0 && values[leftIndex] === null) {
    leftIndex -= 1;
  }

  let rightIndex = index + 1;
  while (rightIndex < values.length && values[rightIndex] === null) {
    rightIndex += 1;
  }

  const leftValue = leftIndex >= 0 ? values[leftIndex] : null;
  const rightValue = rightIndex < values.length ? values[rightIndex] : null;

  if (leftValue !== null && rightValue !== null) {
    const span = rightIndex - leftIndex;
    const offset = index - leftIndex;
    const ratio = offset / span;
    return roundCurrency(leftValue + (rightValue - leftValue) * ratio);
  }

  if (leftValue !== null) {
    return leftValue;
  }

  if (rightValue !== null) {
    return rightValue;
  }

  return null;
}

function parseArgs(argv: string[]): CliOptions {
  let maxListings = DEFAULT_LISTINGS;
  let listingId: string | null = null;
  let weeks = DEFAULT_WEEKS;
  let nights = DEFAULT_NIGHTS;
  let adults = DEFAULT_ADULTS;
  let children = DEFAULT_CHILDREN;
  let quoteConcurrency = DEFAULT_QUOTE_CONCURRENCY;
  let listingConcurrency = DEFAULT_LISTING_CONCURRENCY;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    if (arg === "--max-listings" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        maxListings = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--listing-id" && value) {
      listingId = value.trim();
      index += 1;
      continue;
    }

    if (arg === "--weeks" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0 && parsed <= 52) {
        weeks = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--nights" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0 && parsed <= 30) {
        nights = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--adults" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        adults = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--children" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed >= 0) {
        children = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--quote-concurrency" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        quoteConcurrency = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--listing-concurrency" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        listingConcurrency = Math.floor(parsed);
      }
      index += 1;
      continue;
    }
  }

  return {
    maxListings,
    listingId,
    weeks,
    nights,
    adults,
    children,
    quoteConcurrency,
    listingConcurrency,
  };
}

async function listDetailFiles(detailsJsonDir: string): Promise<string[]> {
  const entries = await readdir(detailsJsonDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
}

function extractUnitCode(detailHtml: string): string | null {
  const match = detailHtml.match(
    /<input[^>]*id=["']unitCode["'][^>]*value=["']([^"']+)["'][^>]*>/i,
  );
  const unitCode = match?.[1]?.trim() ?? "";
  return unitCode.length > 0 ? unitCode : null;
}

function extractSearchNonce(detailHtml: string): string | null {
  const match = detailHtml.match(/"search_nonce"\s*:\s*"([a-zA-Z0-9]+)"/i);
  return match?.[1]?.trim() || null;
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

async function buildSidecarForListing(input: {
  detailPath: string;
  quotesDir: string;
  options: CliOptions;
  capturedAtIso: string;
  progress?: QuoteProgress | null;
}): Promise<{
  listingId: string;
  observations: number;
  availableQuotes: number;
}> {
  const raw = await readFile(input.detailPath, "utf8");
  const detail = JSON.parse(raw) as SandpiperDetailRecord;

  if (!detail.html_path) {
    throw new Error(
      `Missing html_path for listing ${detail.external_listing_id}`,
    );
  }

  const detailHtml = await readFile(detail.html_path, "utf8");
  const unitCode = extractUnitCode(detailHtml);
  if (!unitCode) {
    throw new Error(
      `Missing unitCode in detail HTML for ${detail.external_listing_id}`,
    );
  }
  const searchNonce = extractSearchNonce(detailHtml);

  const captureDate = input.capturedAtIso.slice(0, 10);
  const anchorDate = firstSaturdayOnOrAfter(captureDate);
  const quoteWindowDays = input.options.weeks * 7;
  const sampleStepDays = input.options.nights;
  const sampleCount = Math.max(1, Math.floor(quoteWindowDays / sampleStepDays));

  const indexes = Array.from({ length: sampleCount }, (_, index) => index);

  const rawObservations = await runWithConcurrency(
    indexes,
    input.options.quoteConcurrency,
    async (index) => {
      const startDate = addDays(anchorDate, index * sampleStepDays);
      const endDate = addDays(startDate, input.options.nights);
      return fetchQuoteObservation({
        detailUrl: detail.detail_url,
        unitCode,
        searchNonce,
        startDate,
        endDate,
        nights: input.options.nights,
        adults: input.options.adults,
        children: input.options.children,
        progress: input.progress,
      });
    },
  );

  const baseNightlySeries = rawObservations.map((observation) =>
    observation.baseTotal !== null
      ? roundCurrency(observation.baseTotal / input.options.nights)
      : observation.grandTotal !== null
        ? roundCurrency(observation.grandTotal / input.options.nights)
        : null,
  );

  const observedBaseNightlies = baseNightlySeries.filter(
    (value): value is number => value !== null && value > 0,
  );
  const fallbackBaseNightly =
    median(observedBaseNightlies) ?? DEFAULT_BASE_NIGHTLY_FALLBACK;

  const observedTaxPcts = rawObservations
    .map((observation) => {
      if (
        observation.baseTotal === null ||
        observation.baseTotal <= 0 ||
        observation.taxesTotal === null
      ) {
        return null;
      }
      return roundCurrency(observation.taxesTotal / observation.baseTotal);
    })
    .filter((value): value is number => value !== null);

  const observedFeePcts = rawObservations
    .map((observation) => {
      if (
        observation.baseTotal === null ||
        observation.baseTotal <= 0 ||
        observation.feesTotal === null
      ) {
        return null;
      }
      return roundCurrency(observation.feesTotal / observation.baseTotal);
    })
    .filter((value): value is number => value !== null);

  const fallbackTaxPct = median(observedTaxPcts) ?? DEFAULT_FALLBACK_TAX_PCT;
  const fallbackFeePct = median(observedFeePcts) ?? DEFAULT_FALLBACK_FEE_PCT;

  const observations: CanonicalQuoteObservation[] = rawObservations.map(
    (rawObservation, index) => {
      const baseNightly =
        baseNightlySeries[index] ??
        interpolateValue(baseNightlySeries, index) ??
        fallbackBaseNightly;

      const baseTotal =
        rawObservation.baseTotal !== null
          ? rawObservation.baseTotal
          : roundCurrency(baseNightly * input.options.nights);

      const taxesTotal =
        rawObservation.taxesTotal !== null
          ? rawObservation.taxesTotal
          : roundCurrency(baseTotal * fallbackTaxPct);

      const feesTotal =
        rawObservation.feesTotal !== null
          ? rawObservation.feesTotal
          : roundCurrency(baseTotal * fallbackFeePct);

      const grandTotal =
        rawObservation.grandTotal !== null
          ? rawObservation.grandTotal
          : roundCurrency(baseTotal + taxesTotal + feesTotal);

      const allInNightly = roundCurrency(grandTotal / input.options.nights);

      return {
        sampled_at: input.capturedAtIso,
        captured_at: input.capturedAtIso,
        source_listing_id: detail.external_listing_id,
        currency: rawObservation.currency,
        start_date: rawObservation.startDate,
        end_date: rawObservation.endDate,
        check_in_date: rawObservation.startDate,
        check_out_date: rawObservation.endDate,
        nights: input.options.nights,
        base_nightly: roundCurrency(baseNightly),
        all_in_nightly: allInNightly,
        quote_available: rawObservation.quoteAvailable,
        quote_unavailable_reason: rawObservation.quoteAvailable
          ? null
          : (rawObservation.quoteUnavailableReason ??
            "Dates unavailable for selected stay window"),
        base_total: baseTotal,
        taxes_total: taxesTotal,
        fees_total_excl_taxes: feesTotal,
        fee_lines: rawObservation.feeLines,
        grand_total: grandTotal,
        quoted_total: baseTotal,
        fee_pct_of_base: roundCurrency(feesTotal / Math.max(baseTotal, 1)),
        tax_pct_of_base: roundCurrency(taxesTotal / Math.max(baseTotal, 1)),
        non_base_pct_of_total: roundCurrency(
          (taxesTotal + feesTotal) / Math.max(baseTotal, 1),
        ),
        all_in_multiplier: roundCurrency(grandTotal / Math.max(baseTotal, 1)),
        handoff_url: rawObservation.handoffUrl,
        source: "quote_api",
      };
    },
  );

  const sidecar: CanonicalQuotesSidecarRecord = {
    adapter_key: ADAPTER_KEY,
    external_listing_id: detail.external_listing_id,
    detail_url: detail.detail_url,
    captured_at: input.capturedAtIso,
    currency: observations[0]?.currency ?? "USD",
    quote_window_cadence: "weekly_sat_to_sat",
    quote_window_gap_policy: "record_unavailable_without_date_shift",
    quote_window_anchor_date: anchorDate,
    quote_window_days: quoteWindowDays,
    quote_sample_step_days: sampleStepDays,
    quote_nights: input.options.nights,
    quote_max_queries: observations.length,
    endpoint_path: "/wp-admin/admin-ajax.php?action=q4vr_stay",
    observations,
  };

  assertCanonicalQuotesSidecarRecord(sidecar);

  const outputPath = resolve(
    input.quotesDir,
    `${detail.external_listing_id}.json`,
  );
  await writeFile(outputPath, `${JSON.stringify(sidecar, null, 2)}\n`, "utf8");

  return {
    listingId: detail.external_listing_id,
    observations: observations.length,
    availableQuotes: rawObservations.filter((item) => item.quoteAvailable)
      .length,
  };
}

export async function runSandpiper30AQuoteCli(
  argv: string[] = process.argv.slice(2),
  progress: QuoteProgress | null = null,
): Promise<void> {
  const options = parseArgs(argv);
  const root = process.cwd();
  const adapterRoot = resolve(
    root,
    "src",
    "lib",
    "data",
    "external-sources",
    ADAPTER_KEY,
  );
  const detailsJsonDir = resolve(adapterRoot, "details", "json");
  const quotesDir = resolve(adapterRoot, "details", "quotes");

  await mkdir(quotesDir, { recursive: true });

  const detailFiles = await listDetailFiles(detailsJsonDir);
  let selected = detailFiles;
  if (options.listingId) {
    selected = detailFiles.filter(
      (name) => name === `${options.listingId}.json`,
    );
  } else {
    selected = detailFiles.slice(0, options.maxListings);
  }

  if (selected.length === 0) {
    throw new Error("No detail files selected for quoting.");
  }

  progress?.phase("starting sandpiper30a quote sampling");
  progress?.info(
    `listings_selected=${selected.length} weeks=${options.weeks} nights=${options.nights} quote_concurrency=${options.quoteConcurrency} listing_concurrency=${options.listingConcurrency}`,
  );

  const capturedAtIso = new Date().toISOString();

  const summaries = await runWithConcurrency(
    selected,
    options.listingConcurrency,
    async (fileName) => {
      const summary = await buildSidecarForListing({
        detailPath: resolve(detailsJsonDir, fileName),
        quotesDir,
        options,
        capturedAtIso,
        progress,
      });

      progress?.tick(
        `quoted listing=${summary.listingId} observations=${summary.observations} available=${summary.availableQuotes}`,
      );
      if (!progress) {
        console.log(
          `quoted listing=${summary.listingId} observations=${summary.observations} available=${summary.availableQuotes}`,
        );
      }

      return summary;
    },
  );

  console.log(`${ADAPTER_KEY} quote sidecar generation complete.`);
  console.log(`- listings: ${summaries.length}`);
  console.log(`- captured_at: ${capturedAtIso}`);
  console.log(
    `- listing_ids: ${summaries.map((item) => item.listingId).join(", ")}`,
  );

  progress?.success(
    `sandpiper30a quote sampling complete listings=${summaries.length}`,
  );
}
