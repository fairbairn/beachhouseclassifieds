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
  anchorDate: string | null;
  nights: number;
  adults: number;
  children: number;
  infants: number;
  pets: number;
  quoteConcurrency: number;
  listingConcurrency: number;
};

type OverseeDetailRecord = {
  external_listing_id: string;
  detail_url: string;
};

type OverseeCharge = {
  Description?: unknown;
  Amount?: unknown;
};

type OverseeQuoteResponse = {
  arrival?: unknown;
  departure?: unknown;
  nights?: unknown;
  TotalGoods?: unknown;
  TotalTax?: unknown;
  TotalCost?: unknown;
  Charges?: unknown;
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

const ADAPTER_KEY = "oversee30a" as const;
const BASE_HOST = "https://oversee.us";
const DEFAULT_LISTINGS = 10;
const DEFAULT_WEEKS = 24;
const DEFAULT_NIGHTS = 7;
const DEFAULT_ADULTS = 1;
const DEFAULT_CHILDREN = 0;
const DEFAULT_INFANTS = 0;
const DEFAULT_PETS = 0;
const DEFAULT_QUOTE_CONCURRENCY = 4;
const DEFAULT_LISTING_CONCURRENCY = 2;
const GLOBAL_DEFAULT_BASE_NIGHTLY = 650;
const DEFAULT_FALLBACK_TAX_PCT = 0.12;
const DEFAULT_FALLBACK_FEE_PCT = 0.03;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
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

function formatOverseeDate(isoDate: string): string {
  const parsed = new Date(`${isoDate}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    return isoDate;
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(parsed);
}

function parseAmount(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return roundCurrency(value);
  }

  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.replace(/[^0-9.-]/g, "").trim();
  if (!normalized) {
    return null;
  }

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return roundCurrency(parsed);
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
  let nights = DEFAULT_NIGHTS;
  let adults = DEFAULT_ADULTS;
  let children = DEFAULT_CHILDREN;
  let infants = DEFAULT_INFANTS;
  let pets = DEFAULT_PETS;
  let quoteConcurrency = DEFAULT_QUOTE_CONCURRENCY;
  let listingConcurrency = DEFAULT_LISTING_CONCURRENCY;
  const anchorDateFromEnv =
    process.env.SCRAPER_QUOTE_ANCHOR_DATE?.trim() || null;

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

    if (arg === "--pets" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed >= 0) {
        pets = Math.floor(parsed);
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
  }

  return {
    maxListings,
    listingId,
    weeks: DEFAULT_WEEKS,
    anchorDate: anchorDateFromEnv,
    nights,
    adults,
    children,
    infants,
    pets,
    quoteConcurrency,
    listingConcurrency,
  };
}

function listDetailFiles(detailsJsonDir: string): Promise<string[]> {
  return readdir(detailsJsonDir).then((files) =>
    files.filter((name) => name.endsWith(".json")).sort(),
  );
}

function buildSampleWindows(anchorDate: string, weeks: number, nights: number) {
  return Array.from({ length: weeks }, (_, index) => {
    const startDate = addDays(anchorDate, index * 7);
    const endDate = addDays(startDate, nights);
    return { startDate, endDate };
  });
}

function buildPetsLabel(pets: number): string {
  if (pets <= 0) {
    return "No Pets";
  }
  return pets === 1 ? "1 Pet" : `${pets} Pets`;
}

function buildCheckAvailabilityUrl(input: {
  listingId: string;
  startDate: string;
  endDate: string;
  adults: number;
  children: number;
  infants: number;
  pets: number;
}): string {
  const url = new URL(BASE_HOST);
  url.searchParams.set("vrpjax", "1");
  url.searchParams.set("act", "checkavailability");
  url.searchParams.set("par", "1");
  url.searchParams.set("obj[Arrival]", formatOverseeDate(input.startDate));
  url.searchParams.set("obj[Departure]", formatOverseeDate(input.endDate));
  url.searchParams.set("search[Adults]", String(Math.max(1, input.adults)));
  url.searchParams.set("search[Children]", String(Math.max(0, input.children)));
  url.searchParams.set("search[Infants]", String(Math.max(0, input.infants)));

  const petsLabel = buildPetsLabel(input.pets);
  url.searchParams.set("obj[Pets]", petsLabel);
  url.searchParams.set("search[pets_count]", petsLabel);
  url.searchParams.set("obj[PropID]", input.listingId);

  return url.toString();
}

function buildHandoffUrl(input: {
  listingId: string;
  startDate: string;
  endDate: string;
  adults: number;
  children: number;
  infants: number;
  pets: number;
}): string {
  const url = new URL(`${BASE_HOST}/vrp/book/step3/`);
  url.searchParams.set("obj[Arrival]", formatOverseeDate(input.startDate));
  url.searchParams.set("obj[Departure]", formatOverseeDate(input.endDate));
  url.searchParams.set("search[Adults]", String(Math.max(1, input.adults)));
  url.searchParams.set("search[Children]", String(Math.max(0, input.children)));
  url.searchParams.set("search[Infants]", String(Math.max(0, input.infants)));

  const petsLabel = buildPetsLabel(input.pets);
  url.searchParams.set("obj[Pets]", petsLabel);
  url.searchParams.set("search[pets_count]", petsLabel);
  url.searchParams.set("obj[PropID]", input.listingId);

  return url.toString();
}

async function fetchQuoteObservation(input: {
  detail: OverseeDetailRecord;
  startDate: string;
  endDate: string;
  options: CliOptions;
}): Promise<RawObservation> {
  const endpoint = buildCheckAvailabilityUrl({
    listingId: input.detail.external_listing_id,
    startDate: input.startDate,
    endDate: input.endDate,
    adults: input.options.adults,
    children: input.options.children,
    infants: input.options.infants,
    pets: input.options.pets,
  });
  const handoffUrl = buildHandoffUrl({
    listingId: input.detail.external_listing_id,
    startDate: input.startDate,
    endDate: input.endDate,
    adults: input.options.adults,
    children: input.options.children,
    infants: input.options.infants,
    pets: input.options.pets,
  });

  try {
    const response = await fetch(endpoint, {
      method: "GET",
      headers: {
        "user-agent": USER_AGENT,
        accept: "application/json,text/plain,*/*",
        referer: input.detail.detail_url,
      },
    });

    if (!response.ok) {
      return {
        startDate: input.startDate,
        endDate: input.endDate,
        quoteAvailable: false,
        quoteUnavailableReason: `http_${response.status}`,
        baseTotal: null,
        taxesTotal: null,
        feesTotal: null,
        grandTotal: null,
        currency: "USD",
        handoffUrl,
        feeLines: [],
      };
    }

    const payload = (await response.json()) as OverseeQuoteResponse;

    const baseTotal = parseAmount(payload.TotalGoods);
    const taxesTotal = parseAmount(payload.TotalTax);
    const grandTotal = parseAmount(payload.TotalCost);

    const feesFromMath =
      baseTotal !== null && taxesTotal !== null && grandTotal !== null
        ? roundCurrency(Math.max(0, grandTotal - baseTotal - taxesTotal))
        : null;

    const feeLines: Array<{ name: string; amount: number }> = [];
    const charges = Array.isArray(payload.Charges)
      ? (payload.Charges as OverseeCharge[])
      : [];

    for (const charge of charges) {
      const name = String(charge.Description ?? "").trim();
      const amount = parseAmount(charge.Amount);
      if (!name || amount === null) {
        continue;
      }

      const normalizedName = name.toLowerCase();
      if (
        normalizedName === "rent" ||
        normalizedName.includes("tax") ||
        amount <= 0
      ) {
        continue;
      }

      feeLines.push({ name, amount });
    }

    const feesFromLines = feeLines.reduce((sum, item) => sum + item.amount, 0);
    const feesTotal =
      feesFromLines > 0 ? roundCurrency(feesFromLines) : feesFromMath;

    const quoteAvailable =
      baseTotal !== null &&
      baseTotal > 0 &&
      taxesTotal !== null &&
      taxesTotal >= 0 &&
      grandTotal !== null &&
      grandTotal >= baseTotal;

    return {
      startDate: input.startDate,
      endDate: input.endDate,
      quoteAvailable,
      quoteUnavailableReason: quoteAvailable
        ? null
        : "Missing or invalid quote totals in checkavailability payload",
      baseTotal,
      taxesTotal,
      feesTotal,
      grandTotal,
      currency: "USD",
      handoffUrl,
      feeLines,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      startDate: input.startDate,
      endDate: input.endDate,
      quoteAvailable: false,
      quoteUnavailableReason: `network_error: ${message}`,
      baseTotal: null,
      taxesTotal: null,
      feesTotal: null,
      grandTotal: null,
      currency: "USD",
      handoffUrl,
      feeLines: [],
    };
  }
}

async function buildSidecarForListing(input: {
  detailPath: string;
  quotesDir: string;
  capturedAtIso: string;
  anchorDate: string;
  options: CliOptions;
}): Promise<{
  listingId: string;
  observations: number;
  availableQuotes: number;
}> {
  const raw = await readFile(input.detailPath, "utf8");
  const detail = JSON.parse(raw) as OverseeDetailRecord;

  if (!detail.external_listing_id || !detail.detail_url) {
    throw new Error(`Invalid oversee30a detail file: ${input.detailPath}`);
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
        options: input.options,
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

  const baseNightlySeries: Array<number | null> = rawObservations.map((obs) =>
    obs.baseTotal !== null
      ? roundCurrency(obs.baseTotal / input.options.nights)
      : null,
  );
  const observedBaseNightly = validPricingRows.map((obs) =>
    roundCurrency(obs.baseTotal! / input.options.nights),
  );
  const observedTaxPcts = validPricingRows.map((obs) =>
    roundCurrency(obs.taxesTotal! / obs.baseTotal!),
  );
  const observedFeePcts = validPricingRows.map((obs) =>
    roundCurrency(obs.feesTotal! / obs.baseTotal!),
  );

  const fallbackBaseNightly =
    median(observedBaseNightly) ?? GLOBAL_DEFAULT_BASE_NIGHTLY;
  const fallbackTaxPct = median(observedTaxPcts) ?? DEFAULT_FALLBACK_TAX_PCT;
  const fallbackFeePct = median(observedFeePcts) ?? DEFAULT_FALLBACK_FEE_PCT;

  const observations: CanonicalQuoteObservation[] = rawObservations.map(
    (obs, index) => {
      const nights = input.options.nights;
      const baseNightly =
        baseNightlySeries[index] ??
        interpolateValue(baseNightlySeries, index) ??
        fallbackBaseNightly;

      const baseTotal =
        obs.baseTotal !== null
          ? obs.baseTotal
          : roundCurrency(baseNightly * nights);
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

      const allInNightly = roundCurrency(grandTotal / nights);
      const feePctOfBase = roundCurrency(feesTotal / Math.max(baseTotal, 1));
      const taxPctOfBase = roundCurrency(taxesTotal / Math.max(baseTotal, 1));
      const nonBasePctOfTotal = roundCurrency(
        (taxesTotal + feesTotal) / Math.max(grandTotal, 1),
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
        base_nightly: roundCurrency(baseNightly),
        all_in_nightly: allInNightly,
        quote_available: obs.quoteAvailable,
        quote_unavailable_reason: obs.quoteAvailable
          ? null
          : (obs.quoteUnavailableReason ?? "checkavailability unavailable"),
        base_total: baseTotal,
        taxes_total: taxesTotal,
        fees_total_excl_taxes: feesTotal,
        fee_lines: obs.feeLines,
        grand_total: grandTotal,
        quoted_total: grandTotal,
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
    quote_module_version: "2026-04-01.oversee30a.checkavailability.v1",
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
    endpoint_path: "/?vrpjax=1&act=checkavailability&par=1",
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

export async function runOversee30aQuoteCli(
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

  const todayIso = new Date().toISOString().slice(0, 10);
  const anchorDate =
    options.anchorDate && /^\d{4}-\d{2}-\d{2}$/.test(options.anchorDate)
      ? options.anchorDate
      : firstSaturdayOnOrAfter(todayIso);
  const capturedAtIso = new Date().toISOString();

  progress?.phase("starting oversee30a quote sampling");
  progress?.info(
    `listings_selected=${selected.length} weeks=${options.weeks} nights=${options.nights} adults=${options.adults} children=${options.children} infants=${options.infants} pets=${options.pets} quote_concurrency=${options.quoteConcurrency} listing_concurrency=${options.listingConcurrency}`,
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

  progress?.phase("oversee30a quote sampling complete");
  progress?.info(
    `listings=${summaries.length} observations=${totalObservations} available=${totalAvailable} captured_at=${capturedAtIso}`,
  );

  if (!progress) {
    console.log(`${ADAPTER_KEY} quote sidecar generation complete.`);
    console.log(`- listings: ${summaries.length}`);
    console.log(`- observations: ${totalObservations}`);
    console.log(`- available: ${totalAvailable}`);
    console.log(`- captured_at: ${capturedAtIso}`);
  }
}
