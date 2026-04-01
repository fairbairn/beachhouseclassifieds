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
  infants: number;
  quoteConcurrency: number;
  listingConcurrency: number;
  skipExisting: boolean;
};

type LocalVrDetailRecord = {
  external_listing_id: string;
  detail_url: string;
};

type LocalVrInvoiceItem = {
  title?: unknown;
  type?: unknown;
  amount?: unknown;
};

type LocalVrMoney = {
  currency?: unknown;
  fareAccommodation?: unknown;
  fareAccommodationAdjusted?: unknown;
  totalFees?: unknown;
  totalTaxes?: unknown;
  hostPayout?: unknown;
  invoiceItems?: unknown;
};

type LocalVrQuoteRecord = {
  _id?: unknown;
  status?: unknown;
  checkInDateLocalized?: unknown;
  checkOutDateLocalized?: unknown;
  rates?: {
    ratePlans?: Array<{
      ratePlan?: {
        money?: LocalVrMoney;
      };
    }>;
  };
  stay?: Array<{
    checkInDateLocalized?: unknown;
    checkOutDateLocalized?: unknown;
  }>;
};

type LocalVrErrorPayload = {
  error?: {
    code?: unknown;
    message?: unknown;
    data?: unknown;
  };
};

type RawObservation = {
  startDate: string;
  endDate: string;
  quoteAvailable: boolean;
  quoteUnavailableReason: string | null;
  currency: string;
  baseTotal: number | null;
  taxesTotal: number | null;
  feesTotal: number | null;
  grandTotal: number | null;
  handoffUrl: string | null;
  feeLines: Array<{ name: string; amount: number }>;
};

const ADAPTER_KEY = "localvr30a" as const;
const DEFAULT_LISTINGS = 10;
const DEFAULT_WEEKS = 24;
const DEFAULT_NIGHTS = 7;
const DEFAULT_QUOTE_CONCURRENCY = 3;
const DEFAULT_LISTING_CONCURRENCY = 2;
const DEFAULT_NEXT_ACTION = "40c1a0d7c1ff53bb657668b83335272ee28af08351";
const DEFAULT_BASE_NIGHTLY_FALLBACK = 700;
const DEFAULT_TAX_PCT_FALLBACK = 0.12;
const DEFAULT_FEE_PCT_FALLBACK = 0.3;
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

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
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

function parseArgs(argv: string[]): CliOptions {
  let maxListings = DEFAULT_LISTINGS;
  let listingId: string | null = null;
  let weeks = DEFAULT_WEEKS;
  let nights = DEFAULT_NIGHTS;
  let adults = 1;
  let children = 0;
  let infants = 0;
  let quoteConcurrency = DEFAULT_QUOTE_CONCURRENCY;
  let listingConcurrency = DEFAULT_LISTING_CONCURRENCY;
  let skipExisting = false;

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
      if (Number.isFinite(parsed) && parsed > 0) {
        weeks = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--nights" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
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

    if (arg === "--infants" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed >= 0) {
        infants = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--quote-concurrency" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        quoteConcurrency = Math.max(1, Math.floor(parsed));
      }
      index += 1;
      continue;
    }

    if (arg === "--listing-concurrency" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        listingConcurrency = Math.max(1, Math.floor(parsed));
      }
      index += 1;
      continue;
    }

    if (arg === "--skip-existing") {
      skipExisting = true;
      continue;
    }

    if (arg === "--no-skip-existing") {
      skipExisting = false;
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
    infants,
    quoteConcurrency,
    listingConcurrency,
    skipExisting,
  };
}

async function listDetailFiles(dirPath: string): Promise<string[]> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
}

function buildSampleWindows(anchorDate: string, weeks: number, nights: number) {
  const windows = [] as Array<{ startDate: string; endDate: string }>;
  for (let index = 0; index < weeks; index += 1) {
    const startDate = addDays(anchorDate, index * 7);
    windows.push({
      startDate,
      endDate: addDays(startDate, nights),
    });
  }
  return windows;
}

function parseFlightObjects(text: string): Array<Record<string, unknown>> {
  const objects: Array<Record<string, unknown>> = [];
  for (const line of text.split("\n")) {
    const match = line.match(/^\d+:\s*(\{.*\})\s*$/);
    if (!match?.[1]) {
      continue;
    }

    try {
      const parsed = JSON.parse(match[1]) as unknown;
      if (parsed && typeof parsed === "object") {
        objects.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Ignore non-JSON flight rows.
    }
  }
  return objects;
}

function pickQuoteRecord(
  rows: Array<Record<string, unknown>>,
): LocalVrQuoteRecord | null {
  for (const row of rows) {
    const candidate = row as LocalVrQuoteRecord;
    if (!candidate._id) {
      continue;
    }
    if (candidate.rates || candidate.stay) {
      return candidate;
    }
  }
  return null;
}

function pickErrorRecord(
  rows: Array<Record<string, unknown>>,
): LocalVrErrorPayload | null {
  for (const row of rows) {
    const candidate = row as LocalVrErrorPayload;
    if (candidate.error && typeof candidate.error === "object") {
      return candidate;
    }
  }
  return null;
}

function buildPropertyQuoteUrl(input: {
  detailUrl: string;
  adults: number;
  children: number;
  infants: number;
  checkInDate: string;
  checkOutDate: string;
}): string {
  const parsed = new URL(input.detailUrl);
  parsed.searchParams.set(
    "guests",
    String(Math.max(1, input.adults + input.children + input.infants)),
  );
  parsed.searchParams.set("adults", String(Math.max(1, input.adults)));
  parsed.searchParams.set("children", String(Math.max(0, input.children)));
  parsed.searchParams.set("infants", String(Math.max(0, input.infants)));
  parsed.searchParams.set("checkIn", input.checkInDate);
  parsed.searchParams.set("checkOut", input.checkOutDate);
  return parsed.toString();
}

function buildHandoffUrl(input: {
  detailUrl: string;
  quoteId: string;
  listingId: string;
  adults: number;
  children: number;
  infants: number;
  checkInDate: string;
  checkOutDate: string;
}): string {
  const origin = new URL(input.detailUrl).origin;
  const params = new URLSearchParams();
  params.set("property", input.listingId);
  params.set("adults", String(Math.max(1, input.adults)));
  params.set("children", String(Math.max(0, input.children)));
  params.set("infants", String(Math.max(0, input.infants)));
  params.set("checkIn", input.checkInDate);
  params.set("checkOut", input.checkOutDate);
  return `${origin}/checkout/${input.quoteId}/payment?${params.toString()}`;
}

async function fetchQuoteObservation(input: {
  detail: LocalVrDetailRecord;
  startDate: string;
  endDate: string;
  adults: number;
  children: number;
  infants: number;
  nextAction: string;
}): Promise<RawObservation> {
  const endpoint = buildPropertyQuoteUrl({
    detailUrl: input.detail.detail_url,
    adults: input.adults,
    children: input.children,
    infants: input.infants,
    checkInDate: input.startDate,
    checkOutDate: input.endDate,
  });

  const guestsTotal = Math.max(
    1,
    input.adults + input.children + input.infants,
  );
  const form = new FormData();
  form.append("1_listingId", input.detail.external_listing_id);
  form.append("1_checkIn", input.startDate);
  form.append("1_checkOut", input.endDate);
  form.append("1_guests", String(guestsTotal));
  form.append("1_guests[adults]", String(Math.max(1, input.adults)));
  form.append("1_guests[children]", String(Math.max(0, input.children)));
  form.append("1_guests[infants]", String(Math.max(0, input.infants)));
  form.append("0", '["$K1"]');

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "next-action": input.nextAction,
      "user-agent": USER_AGENT,
    },
    body: form,
  });

  const body = await response.text();
  const rows = parseFlightObjects(body);
  const quote = pickQuoteRecord(rows);
  const errorPayload = pickErrorRecord(rows);

  if (!response.ok || !quote) {
    const reasonParts = [] as string[];
    if (!response.ok) {
      reasonParts.push(`http_${response.status}`);
    }
    const errorCode = asString(errorPayload?.error?.code);
    const errorMessage = asString(errorPayload?.error?.message);
    if (errorCode) {
      reasonParts.push(errorCode);
    }
    if (errorMessage) {
      reasonParts.push(errorMessage);
    }

    return {
      startDate: input.startDate,
      endDate: input.endDate,
      quoteAvailable: false,
      quoteUnavailableReason:
        reasonParts.join(" | ") || "Quote payload missing from response",
      currency: "USD",
      baseTotal: null,
      taxesTotal: null,
      feesTotal: null,
      grandTotal: null,
      handoffUrl: null,
      feeLines: [],
    };
  }

  const money = quote.rates?.ratePlans?.[0]?.ratePlan?.money;
  const currency = asString(money?.currency) ?? "USD";
  const baseTotal =
    toFiniteNumber(money?.fareAccommodationAdjusted) ??
    toFiniteNumber(money?.fareAccommodation);
  const taxesTotal = toFiniteNumber(money?.totalTaxes);
  const feesTotal = toFiniteNumber(money?.totalFees);
  const grandTotal = toFiniteNumber(money?.hostPayout);

  const feeLines: Array<{ name: string; amount: number }> = [];
  const invoiceItems = Array.isArray(money?.invoiceItems)
    ? (money?.invoiceItems as LocalVrInvoiceItem[])
    : [];
  for (const item of invoiceItems) {
    const name = asString(item.title);
    const type = asString(item.type);
    const amount = toFiniteNumber(item.amount);
    if (!name || amount === null) {
      continue;
    }
    if (type === "TAX" || type === "ACCOMMODATION_FARE") {
      continue;
    }
    feeLines.push({ name, amount: roundCurrency(amount) });
  }

  const quoteId = asString(quote._id);
  const handoffUrl =
    quoteId === null
      ? endpoint
      : buildHandoffUrl({
          detailUrl: input.detail.detail_url,
          quoteId,
          listingId: input.detail.external_listing_id,
          adults: input.adults,
          children: input.children,
          infants: input.infants,
          checkInDate:
            asString(quote.checkInDateLocalized) ??
            asString(quote.stay?.[0]?.checkInDateLocalized) ??
            input.startDate,
          checkOutDate:
            asString(quote.checkOutDateLocalized) ??
            asString(quote.stay?.[0]?.checkOutDateLocalized) ??
            input.endDate,
        });

  return {
    startDate: input.startDate,
    endDate: input.endDate,
    quoteAvailable: true,
    quoteUnavailableReason: null,
    currency,
    baseTotal: baseTotal === null ? null : roundCurrency(baseTotal),
    taxesTotal: taxesTotal === null ? null : roundCurrency(taxesTotal),
    feesTotal: feesTotal === null ? null : roundCurrency(feesTotal),
    grandTotal: grandTotal === null ? null : roundCurrency(grandTotal),
    handoffUrl,
    feeLines,
  };
}

async function buildSidecarForListing(input: {
  detailPath: string;
  quotesDir: string;
  capturedAtIso: string;
  anchorDate: string;
  options: CliOptions;
  nextAction: string;
}): Promise<{
  listingId: string;
  observations: number;
  availableQuotes: number;
}> {
  const raw = await readFile(input.detailPath, "utf8");
  const detail = JSON.parse(raw) as LocalVrDetailRecord;
  if (!detail.external_listing_id || !detail.detail_url) {
    throw new Error(`Invalid localvr30a detail file: ${input.detailPath}`);
  }

  const windows = buildSampleWindows(
    input.anchorDate,
    input.options.weeks,
    input.options.nights,
  );

  const rawObservations = await runWithConcurrency(
    windows,
    input.options.quoteConcurrency,
    async (window) =>
      fetchQuoteObservation({
        detail,
        startDate: window.startDate,
        endDate: window.endDate,
        adults: input.options.adults,
        children: input.options.children,
        infants: input.options.infants,
        nextAction: input.nextAction,
      }),
  );

  const validPricingRows = rawObservations.filter(
    (obs) =>
      obs.baseTotal !== null &&
      obs.baseTotal > 0 &&
      obs.taxesTotal !== null &&
      obs.feesTotal !== null &&
      obs.grandTotal !== null,
  );

  const baseNightlyObserved = validPricingRows.map((obs) =>
    roundCurrency(obs.baseTotal! / input.options.nights),
  );
  const taxPctObserved = validPricingRows.map((obs) =>
    roundCurrency(obs.taxesTotal! / obs.baseTotal!),
  );
  const feePctObserved = validPricingRows.map((obs) =>
    roundCurrency(obs.feesTotal! / obs.baseTotal!),
  );

  const fallbackBaseNightly =
    median(baseNightlyObserved) ?? DEFAULT_BASE_NIGHTLY_FALLBACK;
  const fallbackTaxPct = median(taxPctObserved) ?? DEFAULT_TAX_PCT_FALLBACK;
  const fallbackFeePct = median(feePctObserved) ?? DEFAULT_FEE_PCT_FALLBACK;

  const observations: CanonicalQuoteObservation[] = rawObservations.map(
    (obs) => {
      const nights = input.options.nights;
      const baseTotal =
        obs.baseTotal !== null
          ? obs.baseTotal
          : roundCurrency(fallbackBaseNightly * nights);
      const taxesTotal =
        obs.taxesTotal !== null
          ? obs.taxesTotal
          : roundCurrency(baseTotal * fallbackTaxPct);
      const feesTotal =
        obs.feesTotal !== null
          ? obs.feesTotal
          : roundCurrency(baseTotal * fallbackFeePct);
      const grandTotal =
        obs.grandTotal !== null
          ? obs.grandTotal
          : roundCurrency(baseTotal + taxesTotal + feesTotal);

      const baseNightly = roundCurrency(baseTotal / nights);
      const allInNightly = roundCurrency(grandTotal / nights);
      const feePctOfBase = roundCurrency(feesTotal / Math.max(baseTotal, 1));
      const taxPctOfBase = roundCurrency(taxesTotal / Math.max(baseTotal, 1));
      const nonBasePctOfTotal = roundCurrency(
        (taxesTotal + feesTotal) / Math.max(baseTotal, 1),
      );
      const allInMultiplier = roundCurrency(
        grandTotal / Math.max(baseTotal, 1),
      );

      return {
        sampled_at: input.capturedAtIso,
        captured_at: input.capturedAtIso,
        source_listing_id: detail.external_listing_id,
        currency: obs.currency,
        start_date: obs.startDate,
        end_date: obs.endDate,
        check_in_date: obs.startDate,
        check_out_date: obs.endDate,
        nights,
        base_nightly: baseNightly,
        all_in_nightly: allInNightly,
        quote_available: obs.quoteAvailable,
        quote_unavailable_reason: obs.quoteAvailable
          ? null
          : obs.quoteUnavailableReason,
        base_total: baseTotal,
        taxes_total: taxesTotal,
        fees_total_excl_taxes: feesTotal,
        fee_lines: obs.feeLines,
        grand_total: grandTotal,
        quoted_total: baseTotal,
        fee_pct_of_base: feePctOfBase,
        tax_pct_of_base: taxPctOfBase,
        non_base_pct_of_total: nonBasePctOfTotal,
        all_in_multiplier: allInMultiplier,
        handoff_url: obs.handoffUrl,
        source: "quote_api",
      };
    },
  );

  const sidecar: CanonicalQuotesSidecarRecord = {
    adapter_key: ADAPTER_KEY,
    quote_module_version: "2026-04-01.localvr-rsc-property-post.v1",
    external_listing_id: detail.external_listing_id,
    detail_url: detail.detail_url,
    captured_at: input.capturedAtIso,
    currency: observations[0]?.currency ?? "USD",
    quote_window_cadence: "weekly_sat_to_sat",
    quote_window_gap_policy: "record_unavailable_without_date_shift",
    quote_window_anchor_date: input.anchorDate,
    quote_window_days:
      input.options.nights + Math.max(0, input.options.weeks - 1) * 7,
    quote_sample_step_days: 7,
    quote_nights: input.options.nights,
    quote_max_queries: observations.length,
    endpoint_path: "/property/[slug] (next-action multipart)",
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
    availableQuotes: observations.filter((item) => item.quote_available).length,
  };
}

export async function runLocalvr30aQuoteCli(
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
  const nextAction =
    process.env.LOCALVR30A_NEXT_ACTION?.trim() || DEFAULT_NEXT_ACTION;

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

  if (options.skipExisting) {
    const existing = new Set(await listDetailFiles(quotesDir));
    selected = selected.filter((name) => !existing.has(name));
  }

  if (selected.length === 0) {
    throw new Error("No detail files selected for quoting.");
  }

  const todayIso = new Date().toISOString().slice(0, 10);
  const anchorDate = firstSaturdayOnOrAfter(todayIso);
  const capturedAtIso = new Date().toISOString();

  progress?.phase("starting localvr30a quote sampling");
  progress?.info(
    `listings_selected=${selected.length} weeks=${options.weeks} nights=${options.nights} adults=${options.adults} children=${options.children} infants=${options.infants} quote_concurrency=${options.quoteConcurrency} listing_concurrency=${options.listingConcurrency}`,
  );

  const summaries = await runWithConcurrency(
    selected,
    options.listingConcurrency,
    async (fileName) => {
      const summary = await buildSidecarForListing({
        detailPath: resolve(detailsJsonDir, fileName),
        quotesDir,
        capturedAtIso,
        anchorDate,
        options,
        nextAction,
      });

      progress?.tick(
        `quoted listing=${summary.listingId} observations=${summary.observations} available=${summary.availableQuotes}`,
      );

      return summary;
    },
  );

  const totalObservations = summaries.reduce(
    (sum, summary) => sum + summary.observations,
    0,
  );
  const totalAvailable = summaries.reduce(
    (sum, summary) => sum + summary.availableQuotes,
    0,
  );

  progress?.phase("localvr30a quote sampling complete");
  progress?.info(
    `listings=${summaries.length} observations=${totalObservations} available=${totalAvailable}`,
  );
}
