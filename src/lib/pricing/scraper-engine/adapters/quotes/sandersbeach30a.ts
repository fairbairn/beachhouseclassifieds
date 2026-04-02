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

type SandersDetailRecord = {
  external_listing_id: string;
  detail_url: string;
  h1?: string;
  title?: string;
  quote_context?: {
    eid?: number | null;
    inventory_id?: string;
    type_id?: string;
  };
  location?: {
    address?: string;
    directions_daddr?: string;
  };
};

type RcapiPriceNode = {
  eid?: unknown;
  p?: unknown;
  c?: unknown;
  n?: unknown;
  qp?: {
    rcav?: {
      IDs?: Record<string, string[]>;
    };
  };
};

type RcapiRow = {
  eid?: unknown;
  name?: unknown;
  prices?: RcapiPriceNode[];
  type?: unknown;
};

type RawObservation = {
  startDate: string;
  endDate: string;
  quoteAvailable: boolean;
  quoteUnavailableReason: string | null;
  grandTotal: number | null;
  currency: string;
  handoffUrl: string;
};

type EidEntry = {
  eid: number;
  displayName: string;
};

const ADAPTER_KEY = "sandersbeach30a" as const;
const BASE_HOST = "https://www.sandersbeachrentals.com";
const RCAPI_ENDPOINT = `${BASE_HOST}/rcapi/item/avail/search`;
const DEFAULT_LISTINGS = 10;
const DEFAULT_WEEKS = 24;
const DEFAULT_NIGHTS = 7;
const DEFAULT_QUOTE_CONCURRENCY = 4;
const DEFAULT_LISTING_CONCURRENCY = 2;
const DEFAULT_TAX_RATE = 0.12;
const GLOBAL_DEFAULT_GRAND_NIGHTLY = 700;
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

function toUsDate(isoDate: string): string {
  const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return isoDate;
  }
  return `${match[2]}/${match[3]}/${match[1]}`;
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

function parsePositiveInt(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
  }
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/&amp;/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

function listingDisplayName(detail: SandersDetailRecord): string {
  const fromDetail =
    (detail.h1 && detail.h1.trim()) ||
    (detail.title && detail.title.trim()) ||
    detail.external_listing_id;
  return fromDetail.replace(/\s+vacation rental$/i, "").trim();
}

function buildListingNameCandidates(detail: SandersDetailRecord): string[] {
  const values = [
    listingDisplayName(detail),
    detail.external_listing_id.replace(/-/g, " "),
    detail.location?.address ?? "",
    detail.location?.directions_daddr ?? "",
  ];

  const normalized = values
    .map((value) => normalizeName(value))
    .filter((value) => value.length > 0);

  return Array.from(new Set(normalized));
}

function resolveEidForListing(
  detail: SandersDetailRecord,
  eidIndex: Map<string, EidEntry>,
): EidEntry | null {
  const candidates = buildListingNameCandidates(detail);

  for (const candidate of candidates) {
    const exact = eidIndex.get(candidate);
    if (exact) {
      return exact;
    }
  }

  for (const candidate of candidates) {
    for (const [nameKey, entry] of eidIndex.entries()) {
      if (nameKey.includes(candidate) || candidate.includes(nameKey)) {
        return entry;
      }
    }
  }

  return null;
}

function buildProbeOffsetsDays(): number[] {
  const offsets = new Set<number>();

  for (let day = 0; day <= 84; day += 7) {
    offsets.add(day);
  }

  for (let day = 0; day <= 730; day += 14) {
    offsets.add(day);
  }

  return [...offsets].sort((left, right) => left - right);
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

async function listDetailFiles(detailsJsonDir: string): Promise<string[]> {
  const entries = await readdir(detailsJsonDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

function buildSearchUrl(input: {
  checkInIso: string;
  checkOutIso: string;
  adults: number;
  children: number;
  eid?: number;
}): string {
  const query = new URLSearchParams();
  query.set("rcav[begin]", toUsDate(input.checkInIso));
  query.set("rcav[end]", toUsDate(input.checkOutIso));
  query.set("rcav[adult]", String(Math.max(1, input.adults)));
  query.set("rcav[child]", String(Math.max(0, input.children)));
  if (input.eid) {
    query.set("rcav[eid]", String(input.eid));
  }
  query.set("rcav[flex]", "");
  query.set("rcav[flex_type]", "d");
  return `${RCAPI_ENDPOINT}?${query.toString()}`;
}

function buildHandoffUrl(input: {
  checkInIso: string;
  checkOutIso: string;
  adults: number;
  children: number;
  eid: number;
  id8Value: string | null;
}): string {
  const query = new URLSearchParams();
  query.set("rcav[begin]", toUsDate(input.checkInIso));
  query.set("rcav[end]", toUsDate(input.checkOutIso));
  query.set("rcav[adult]", String(Math.max(1, input.adults)));
  query.set("rcav[child]", String(Math.max(0, input.children)));
  query.set("rcav[eid]", String(input.eid));
  if (input.id8Value && input.id8Value.trim().length > 0) {
    query.append("rcav[IDs][8][]", input.id8Value.trim());
  }
  query.set("eid", String(input.eid));
  return `${BASE_HOST}/rescms/item/${input.eid}/buy?${query.toString()}`;
}

async function fetchRcapiRows(
  url: string,
  referer: string,
): Promise<RcapiRow[]> {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      accept: "application/json, text/plain, */*",
      "x-requested-with": "XMLHttpRequest",
      "user-agent": USER_AGENT,
      referer: referer,
      origin: BASE_HOST,
    },
  });

  if (!response.ok) {
    return [];
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return [];
  }

  return Array.isArray(payload) ? (payload as RcapiRow[]) : [];
}

async function buildEidIndex(input: {
  details: SandersDetailRecord[];
  options: CliOptions;
  progress: QuoteProgress | null;
}): Promise<Map<string, EidEntry>> {
  const captureAnchor = firstSaturdayOnOrAfter(input.options.fromDate);
  const probeOffsetsDays = buildProbeOffsetsDays();

  const indexMap = new Map<string, EidEntry>();

  await runWithConcurrency(probeOffsetsDays, 3, async (offsetDays) => {
    const startDate = addDays(captureAnchor, offsetDays);
    const endDate = addDays(startDate, input.options.nights);
    const probeUrl = buildSearchUrl({
      checkInIso: startDate,
      checkOutIso: endDate,
      adults: input.options.adults,
      children: input.options.children,
    });

    const rows = await fetchRcapiRows(probeUrl, `${BASE_HOST}/`);
    for (const row of rows) {
      const eid = parsePositiveInt(row.eid);
      const name = asString(row.name);
      if (!eid || !name) {
        continue;
      }
      const key = normalizeName(name);
      if (!indexMap.has(key)) {
        indexMap.set(key, { eid, displayName: name });
      }
    }
  });

  const resolved = input.details
    .map((detail) => resolveEidForListing(detail, indexMap))
    .filter((entry): entry is EidEntry => entry !== null).length;

  input.progress?.info(
    `eid_index size=${indexMap.size} probe_windows=${probeOffsetsDays.length} resolved_listings=${resolved}/${input.details.length}`,
  );

  return indexMap;
}

async function fetchObservation(input: {
  detailUrl: string;
  startDate: string;
  endDate: string;
  adults: number;
  children: number;
  eid: number;
  fallbackInventoryId?: string;
  fallbackTypeId?: string;
}): Promise<RawObservation> {
  const searchUrl = buildSearchUrl({
    checkInIso: input.startDate,
    checkOutIso: input.endDate,
    adults: input.adults,
    children: input.children,
    eid: input.eid,
  });

  const rows = await fetchRcapiRows(searchUrl, input.detailUrl);
  const firstRow = rows[0] ?? null;
  const firstPrice = Array.isArray(firstRow?.prices)
    ? firstRow.prices[0]
    : null;
  const grandTotal = parseMoney(firstPrice?.p);
  const currency = asString(firstPrice?.c) ?? "USD";
  const idFromResponse = firstPrice?.qp?.rcav?.IDs?.["8"]?.[0] ?? null;
  const id8 =
    (typeof idFromResponse === "string" && idFromResponse.trim()) ||
    (input.fallbackTypeId === "8" && input.fallbackInventoryId?.trim()
      ? input.fallbackInventoryId.trim()
      : null);

  return {
    startDate: input.startDate,
    endDate: input.endDate,
    quoteAvailable: grandTotal !== null && grandTotal > 0,
    quoteUnavailableReason:
      grandTotal !== null && grandTotal > 0
        ? null
        : "RCAPI did not return a total for selected stay window",
    grandTotal,
    currency,
    handoffUrl: buildHandoffUrl({
      checkInIso: input.startDate,
      checkOutIso: input.endDate,
      adults: input.adults,
      children: input.children,
      eid: input.eid,
      id8Value: typeof id8 === "string" ? id8 : null,
    }),
  };
}

async function buildSidecarForListing(input: {
  detailPath: string;
  quotesDir: string;
  options: CliOptions;
  capturedAtIso: string;
  eidIndex: Map<string, EidEntry>;
}): Promise<{
  listingId: string;
  observations: number;
  availableQuotes: number;
}> {
  const detailRaw = await readFile(input.detailPath, "utf8");
  const detail = JSON.parse(detailRaw) as SandersDetailRecord;

  const explicitEid = parsePositiveInt(detail.quote_context?.eid ?? null);
  const eidEntry = explicitEid
    ? {
        eid: explicitEid,
        displayName: listingDisplayName(detail),
      }
    : resolveEidForListing(detail, input.eidIndex);
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

      if (!eidEntry) {
        return {
          startDate,
          endDate,
          quoteAvailable: false,
          quoteUnavailableReason:
            "Missing listing eid mapping from RCAPI index",
          grandTotal: null,
          currency: "USD",
          handoffUrl: detail.detail_url,
        } satisfies RawObservation;
      }

      return fetchObservation({
        detailUrl: detail.detail_url,
        startDate,
        endDate,
        adults: input.options.adults,
        children: input.options.children,
        eid: eidEntry.eid,
        fallbackInventoryId: detail.quote_context?.inventory_id,
        fallbackTypeId: detail.quote_context?.type_id,
      });
    },
  );

  const grandNightlySeries: Array<number | null> = rawObservations.map((raw) =>
    raw.grandTotal !== null && raw.grandTotal > 0
      ? roundCurrency(raw.grandTotal / input.options.nights)
      : null,
  );
  const observedGrandNightlies = grandNightlySeries.filter(
    (value): value is number => value !== null && value > 0,
  );
  const fallbackGrandNightly =
    median(observedGrandNightlies) ?? GLOBAL_DEFAULT_GRAND_NIGHTLY;

  const observations: CanonicalQuoteObservation[] = rawObservations.map(
    (raw, index) => {
      const grandNightly =
        grandNightlySeries[index] ??
        interpolateValue(grandNightlySeries, index) ??
        fallbackGrandNightly;
      const grandTotal =
        raw.grandTotal !== null && raw.grandTotal > 0
          ? raw.grandTotal
          : roundCurrency(grandNightly * input.options.nights);
      const subTotal = roundCurrency(grandTotal / (1 + DEFAULT_TAX_RATE));
      const taxesTotal = roundCurrency(Math.max(0, grandTotal - subTotal));
      const feesTotal = 0;
      const baseTotal = subTotal;
      const baseNightly = roundCurrency(baseTotal / input.options.nights);
      const allInNightly = roundCurrency(grandTotal / input.options.nights);

      return {
        sampled_at: input.capturedAtIso,
        captured_at: input.capturedAtIso,
        source_listing_id: detail.external_listing_id,
        currency: raw.currency,
        start_date: raw.startDate,
        end_date: raw.endDate,
        check_in_date: raw.startDate,
        check_out_date: raw.endDate,
        nights: input.options.nights,
        base_nightly: baseNightly,
        all_in_nightly: allInNightly,
        quote_available: raw.quoteAvailable,
        quote_unavailable_reason: raw.quoteAvailable
          ? null
          : raw.quoteUnavailableReason,
        base_total: baseTotal,
        taxes_total: taxesTotal,
        fees_total_excl_taxes: feesTotal,
        fee_lines: [],
        grand_total: grandTotal,
        quoted_total: grandTotal,
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

export async function runSandersBeach30AQuoteCli(
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

  const details = await Promise.all(
    selected.map(async (fileName) => {
      const raw = await readFile(resolve(detailsJsonDir, fileName), "utf8");
      return JSON.parse(raw) as SandersDetailRecord;
    }),
  );

  const explicitEidCount = details.filter(
    (detail) => parsePositiveInt(detail.quote_context?.eid ?? null) !== null,
  ).length;

  progress?.phase("starting sandersbeach30a quote sampling");
  progress?.info(
    `listings_selected=${selected.length} weeks=${options.weeks} nights=${options.nights} quote_concurrency=${options.quoteConcurrency} listing_concurrency=${options.listingConcurrency}`,
  );
  progress?.info(`details_with_explicit_eid=${explicitEidCount}/${details.length}`);

  const eidIndex = await buildEidIndex({ details, options, progress });

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
        eidIndex,
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
    `sandersbeach30a quote sampling complete listings=${summaries.length}`,
  );
}
