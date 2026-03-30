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
  fromDate: string;
  nights: number;
  adults: number;
  children: number;
  quoteConcurrency: number;
  listingConcurrency: number;
};

type BenchmarkDetailRecord = {
  external_listing_id: string;
  detail_url: string;
};

type RcapiPriceNode = {
  p?: string;
  c?: string;
};

type RcapiResult = {
  prices?: RcapiPriceNode[];
};

type RawObservation = {
  startDate: string;
  endDate: string;
  quoteAvailable: boolean;
  baseTotal: number | null;
  currency: string;
  handoffUrl: string;
};

const ADAPTER_KEY = "benchmark30a" as const;
const BASE_HOST = "https://www.benchmark30a.com";
const DEFAULT_LISTINGS = 10;
const DEFAULT_WEEKS = 24;
const DEFAULT_NIGHTS = 7;
const DEFAULT_QUOTE_CONCURRENCY = 4;
const DEFAULT_LISTING_CONCURRENCY = 2;
const FIXED_TAX_RATE = 0.12;
const FIXED_FEE_RATE = 0;
const GLOBAL_DEFAULT_BASE_NIGHTLY = 650;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

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

function toUsDate(isoDate: string): string {
  const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return isoDate;
  }
  return `${match[2]}/${match[3]}/${match[1]}`;
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
  let fromDate = new Date().toISOString().slice(0, 10);
  let nights = DEFAULT_NIGHTS;
  let adults = 1;
  let children = 0;
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
      if (Number.isFinite(parsed) && parsed > 0) {
        weeks = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--from-date" && value) {
      fromDate = value.trim();
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
    weeks,
    fromDate,
    nights,
    adults,
    children,
    quoteConcurrency,
    listingConcurrency,
  };
}

function parseEntityIdFromHtml(html: string): number | null {
  const patterns = [/"eid":"(\d+)"/i, /rc-eid-(\d+)/i];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (!match?.[1]) {
      continue;
    }

    const parsed = Number(match[1]);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return null;
}

function parseIdsTuple(detailUrl: string, html: string): string | null {
  try {
    const parsed = new URL(detailUrl);
    const tuple =
      parsed.searchParams.get("rcav[IDs][8][0]") ??
      parsed.searchParams.get("rcav%5BIDs%5D%5B8%5D%5B0%5D");
    if (tuple && tuple.trim()) {
      return tuple.trim();
    }
  } catch {
    // Ignore parse failures and fall back to html extraction.
  }

  const htmlMatch = html.match(/"id":"(\d+-\d+)"/i);
  return htmlMatch?.[1]?.trim() ?? null;
}

function buildCheckoutUrl(input: {
  checkInIso: string;
  checkOutIso: string;
  adults: number;
  children: number;
  entityId: number;
  idsTuple: string;
}): string {
  const params = new URLSearchParams();
  params.set("rcav[begin]", toUsDate(input.checkInIso));
  params.set("rcav[end]", toUsDate(input.checkOutIso));
  params.set("rcav[adult]", String(input.adults));
  params.set("rcav[child]", String(input.children));
  params.set("rcav[eid]", String(input.entityId));
  params.append("rcav[IDs][8][]", input.idsTuple);
  params.set("eid", String(input.entityId));
  return `${BASE_HOST}/rescms/item/${input.entityId}/buy?${params.toString()}`;
}

async function fetchRcapiBaseTotal(input: {
  detailUrl: string;
  checkInIso: string;
  checkOutIso: string;
  adults: number;
  children: number;
  entityId: number;
  idsTuple: string;
}): Promise<{
  quoteAvailable: boolean;
  baseTotal: number | null;
  currency: string;
}> {
  const params = new URLSearchParams();
  params.set("rcav[begin]", toUsDate(input.checkInIso));
  params.set("rcav[end]", toUsDate(input.checkOutIso));
  params.set("rcav[adult]", String(input.adults));
  params.set("rcav[child]", String(input.children));
  params.set("rcav[eid]", String(input.entityId));
  params.append("rcav[IDs][8][]", input.idsTuple);
  params.set("eid", String(input.entityId));

  const url = `${BASE_HOST}/rcapi/item/avail/search?${params.toString()}`;
  const response = await fetch(url, {
    headers: {
      accept: "application/json, text/plain, */*",
      "x-requested-with": "XMLHttpRequest",
      "user-agent": USER_AGENT,
      referer: input.detailUrl,
    },
  });

  if (!response.ok) {
    return { quoteAvailable: false, baseTotal: null, currency: "USD" };
  }

  const payload = (await response.json()) as unknown;
  const rows = Array.isArray(payload) ? (payload as RcapiResult[]) : [];
  const priceNode = rows[0]?.prices?.[0] ?? null;
  const baseTotalRaw = Number(priceNode?.p ?? "");
  const baseTotal =
    Number.isFinite(baseTotalRaw) && baseTotalRaw > 0
      ? roundCurrency(baseTotalRaw)
      : null;

  return {
    quoteAvailable: baseTotal !== null,
    baseTotal,
    currency: priceNode?.c?.trim() || "USD",
  };
}

async function listDetailFiles(detailsJsonDir: string): Promise<string[]> {
  const entries = await readdir(detailsJsonDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
}

async function buildSidecarForListing(input: {
  detailPath: string;
  htmlPath: string;
  quotesDir: string;
  options: CliOptions;
  capturedAtIso: string;
}): Promise<{
  listingId: string;
  observations: number;
  availableQuotes: number;
}> {
  const detailRaw = await readFile(input.detailPath, "utf8");
  const detail = JSON.parse(detailRaw) as BenchmarkDetailRecord;
  const htmlRaw = await readFile(input.htmlPath, "utf8");

  const entityId = parseEntityIdFromHtml(htmlRaw);
  const idsTuple = parseIdsTuple(detail.detail_url, htmlRaw);
  if (!entityId || !idsTuple) {
    throw new Error(
      `Missing quote identifiers for listing ${detail.external_listing_id}`,
    );
  }

  const captureDateIso = input.capturedAtIso.slice(0, 10);
  const anchorDate = firstSaturdayOnOrAfter(captureDateIso);
  const quoteWindowDays = input.options.weeks * 7;
  const sampleStepDays = input.options.nights;
  const sampleCount = Math.max(1, Math.floor(quoteWindowDays / sampleStepDays));

  const sampleIndexes = Array.from(
    { length: sampleCount },
    (_, index) => index,
  );
  const rawObservations = await runWithConcurrency(
    sampleIndexes,
    input.options.quoteConcurrency,
    async (index) => {
      const startDate = addDays(anchorDate, index * sampleStepDays);
      const endDate = addDays(startDate, input.options.nights);

      const quote = await fetchRcapiBaseTotal({
        detailUrl: detail.detail_url,
        checkInIso: startDate,
        checkOutIso: endDate,
        adults: input.options.adults,
        children: input.options.children,
        entityId,
        idsTuple,
      });

      return {
        startDate,
        endDate,
        quoteAvailable: quote.quoteAvailable,
        baseTotal: quote.baseTotal,
        currency: quote.currency,
        handoffUrl: buildCheckoutUrl({
          checkInIso: startDate,
          checkOutIso: endDate,
          adults: input.options.adults,
          children: input.options.children,
          entityId,
          idsTuple,
        }),
      } satisfies RawObservation;
    },
  );

  const baseNightlySeries: Array<number | null> = rawObservations.map((obs) =>
    obs.baseTotal !== null
      ? roundCurrency(obs.baseTotal / input.options.nights)
      : null,
  );
  const availableNightlies = baseNightlySeries.filter(
    (value): value is number => value !== null && value > 0,
  );
  const fallbackBaseNightly =
    median(availableNightlies) ?? GLOBAL_DEFAULT_BASE_NIGHTLY;

  const observations: CanonicalQuoteObservation[] = rawObservations.map(
    (raw, index) => {
      const baseNightly =
        baseNightlySeries[index] ??
        interpolateValue(baseNightlySeries, index) ??
        fallbackBaseNightly;
      const baseTotal =
        raw.baseTotal !== null
          ? raw.baseTotal
          : roundCurrency(baseNightly * input.options.nights);

      const taxesTotal = roundCurrency(baseTotal * FIXED_TAX_RATE);
      const feesTotal = roundCurrency(baseTotal * FIXED_FEE_RATE);
      const grandTotal = roundCurrency(baseTotal + taxesTotal + feesTotal);
      const allInNightly = roundCurrency(grandTotal / input.options.nights);

      return {
        sampled_at: input.capturedAtIso,
        captured_at: input.capturedAtIso,
        source_listing_id: detail.external_listing_id,
        currency: raw.currency || "USD",
        start_date: raw.startDate,
        end_date: raw.endDate,
        check_in_date: raw.startDate,
        check_out_date: raw.endDate,
        nights: input.options.nights,
        base_nightly: roundCurrency(baseNightly),
        all_in_nightly: allInNightly,
        quote_available: raw.quoteAvailable,
        quote_unavailable_reason: raw.quoteAvailable
          ? null
          : "Dates unavailable for selected stay window",
        base_total: baseTotal,
        taxes_total: taxesTotal,
        fees_total_excl_taxes: feesTotal,
        fee_lines: [],
        grand_total: grandTotal,
        quoted_total: baseTotal,
        fee_pct_of_base: 0,
        tax_pct_of_base: roundCurrency(taxesTotal / Math.max(baseTotal, 1)),
        non_base_pct_of_total: roundCurrency(
          (taxesTotal + feesTotal) / Math.max(baseTotal, 1),
        ),
        all_in_multiplier: roundCurrency(grandTotal / Math.max(baseTotal, 1)),
        handoff_url: raw.handoffUrl,
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
    endpoint_path: "/rcapi/item/avail/search",
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
    availableQuotes: rawObservations.filter((obs) => obs.quoteAvailable).length,
  };
}

export async function runBenchmark30aQuoteCli(
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
  const detailsHtmlDir = resolve(adapterRoot, "details", "html");
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

  progress?.phase("starting benchmark30a quote sampling");
  progress?.info(
    `listings_selected=${selected.length} weeks=${options.weeks} nights=${options.nights} quote_concurrency=${options.quoteConcurrency} listing_concurrency=${options.listingConcurrency}`,
  );

  const capturedAtIso = new Date().toISOString();
  const summaries: Array<{
    listingId: string;
    observations: number;
    availableQuotes: number;
  }> = await runWithConcurrency(
    selected,
    options.listingConcurrency,
    async (fileName) => {
      const listingId = fileName.replace(/\.json$/i, "");
      const summary = await buildSidecarForListing({
        detailPath: resolve(detailsJsonDir, fileName),
        htmlPath: resolve(detailsHtmlDir, `${listingId}.html`),
        quotesDir,
        options,
        capturedAtIso,
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
    `benchmark30a quote sampling complete listings=${summaries.length}`,
  );
}
