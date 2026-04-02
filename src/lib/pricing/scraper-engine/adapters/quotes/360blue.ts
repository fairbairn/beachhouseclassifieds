import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  assertCanonicalQuotesSidecarRecord,
  type CanonicalQuoteObservation,
  type CanonicalQuotesSidecarRecord,
} from "@/lib/pricing/contracts/quote-observations-contract";
import { execute360BlueSingleQuote } from "@/lib/pricing/quote-runtime/adapters/360blue";
import type { QuoteExecutionRequest } from "@/lib/pricing/quote-runtime/types";
import { createQuoteCaptureProgressTracker } from "@/lib/pricing/quotes/shared/quote-capture-progress";
import { runWithConcurrency } from "@/lib/pricing/quotes/shared/run-with-concurrency";
import type { QuoteProgress } from "@/lib/pricing/quotes/types";

type CliOptions = {
  maxListings: number;
  listingId: string | null;
  weeks: number;
  nights: number;
  listingConcurrency: number;
  quoteConcurrency: number;
  timeoutMs: number;
  maxAttempts: number;
  allowDetailBackfill: boolean;
};

type CanonicalIndexEntry = {
  detail_url?: unknown;
  external_listing_id?: unknown;
  quote_context?: unknown;
};

type ListingSeed = {
  externalListingId: string;
  detailUrl: string;
  quoteContext: Record<string, unknown> | null;
};

type EstimatedPricing = {
  baseNightly: number;
  allInNightly: number;
  baseTotal: number;
  taxesTotal: number;
  feesTotalExclTaxes: number;
  grandTotal: number;
  quotedTotal: number;
  feePctOfBase: number;
  taxPctOfBase: number;
  nonBasePctOfTotal: number;
  allInMultiplier: number;
};

const ADAPTER_KEY = "360blue";
const DEFAULT_MAX_LISTINGS = 10;
const DEFAULT_WEEKS = 24;
const DEFAULT_NIGHTS = 7;
const DEFAULT_LISTING_CONCURRENCY = 3;
const DEFAULT_QUOTE_CONCURRENCY = 3;
const DEFAULT_QUOTE_TIMEOUT_MS = 12000;
const DEFAULT_QUOTE_MAX_ATTEMPTS = 2;
const DEFAULT_ENDPOINT_PATH = "/api/nrbe/reservation-quotes.json";
const DEFAULT_CART_CREATE_ENDPOINT =
  "https://www.callistavacations.com/api/nrbe/carts/create.json";
const DEFAULT_TAX_PCT = 0.12;
const DEFAULT_BASE_NIGHTLY = 500;

function parseArgs(argv: string[]): CliOptions {
  let maxListings = DEFAULT_MAX_LISTINGS;
  let listingId: string | null = null;
  let weeks = DEFAULT_WEEKS;
  let nights = DEFAULT_NIGHTS;
  let listingConcurrency = DEFAULT_LISTING_CONCURRENCY;
  let quoteConcurrency = DEFAULT_QUOTE_CONCURRENCY;
  let timeoutMs = DEFAULT_QUOTE_TIMEOUT_MS;
  let maxAttempts = Math.max(
    1,
    Number(
      process.env.BLUE360_RATE_QUOTE_MAX_ATTEMPTS ?? DEFAULT_QUOTE_MAX_ATTEMPTS,
    ) || DEFAULT_QUOTE_MAX_ATTEMPTS,
  );
  let allowDetailBackfill =
    process.env.QUOTE_CAPTURE_ALLOW_DETAIL_BACKFILL === "1" ||
    process.env.QUOTE_CAPTURE_ALLOW_DETAIL_BACKFILL === "true";

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

    if (arg === "--listing-concurrency" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        listingConcurrency = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--detail-fetch-concurrency" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        listingConcurrency = Math.floor(parsed);
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

    if (arg === "--quote-timeout-ms" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        timeoutMs = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--detail-timeout-ms" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        timeoutMs = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--quote-max-attempts" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        maxAttempts = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--all-listings") {
      maxListings = Number.POSITIVE_INFINITY;
      continue;
    }

    if (arg === "--backfill-quote-context-from-details") {
      allowDetailBackfill = true;
      continue;
    }
  }

  return {
    maxListings,
    listingId,
    weeks: Math.max(1, weeks),
    nights: Math.max(1, nights),
    listingConcurrency: Math.max(1, listingConcurrency),
    quoteConcurrency: Math.max(1, quoteConcurrency),
    timeoutMs: Math.max(1000, timeoutMs),
    maxAttempts: Math.max(1, maxAttempts),
    allowDetailBackfill,
  };
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function normalizeDetailUrl(value: string): string {
  return value.split("#")[0]?.replace(/\/$/, "") ?? value;
}

function externalListingIdFromDetailUrl(detailUrl: string): string {
  try {
    const parsed = new URL(detailUrl);
    const parts = parsed.pathname.split("/").filter(Boolean);
    return parts[parts.length - 1] ?? "";
  } catch {
    const parts = normalizeDetailUrl(detailUrl).split("/").filter(Boolean);
    return parts[parts.length - 1] ?? "";
  }
}

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function firstSaturdayOnOrAfter(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  const day = date.getUTCDay();
  const delta = (6 - day + 7) % 7;
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? null;
  }
  const left = sorted[middle - 1];
  const right = sorted[middle];
  if (left === undefined || right === undefined) {
    return null;
  }
  return Math.round(((left + right) / 2) * 100) / 100;
}

function buildHandoffUrlFromContext(input: {
  quoteContext: Record<string, unknown> | null;
  checkInIso: string;
  checkOutIso: string;
}): string | null {
  const context = input.quoteContext;
  if (!context) {
    return null;
  }

  const unitIdRaw = context.unit_id;
  const unitId =
    typeof unitIdRaw === "string"
      ? Number(unitIdRaw.trim())
      : Number(unitIdRaw);
  if (!Number.isFinite(unitId) || unitId <= 0) {
    return null;
  }

  const cartCreateEndpointRaw =
    typeof context.cart_create_endpoint === "string"
      ? context.cart_create_endpoint.trim()
      : "";
  const cartCreateEndpoint =
    cartCreateEndpointRaw || DEFAULT_CART_CREATE_ENDPOINT;

  const payload = {
    unitId: Math.floor(unitId),
    arrivalDate: input.checkInIso,
    departureDate: input.checkOutIso,
    adults: 1,
    children: 0,
  };

  const params = new URLSearchParams();
  params.set("method", "POST");
  params.set("contentType", "application/json");
  params.set("payload", JSON.stringify(payload));
  return `${cartCreateEndpoint}#${params.toString()}`;
}

function createEstimatedPricing(input: {
  baseNightly: number;
  nights: number;
  taxPctOfBase: number;
}): EstimatedPricing {
  const baseTotal = Math.round(input.baseNightly * input.nights * 100) / 100;
  const taxesTotal =
    Math.round(baseTotal * Math.max(0, input.taxPctOfBase) * 100) / 100;
  const feesTotalExclTaxes = 0;
  const grandTotal =
    Math.round((baseTotal + taxesTotal + feesTotalExclTaxes) * 100) / 100;
  const allInNightly =
    input.nights > 0 ? Math.round((grandTotal / input.nights) * 100) / 100 : 0;
  const allInMultiplier =
    baseTotal > 0
      ? Math.round((grandTotal / baseTotal) * 1_000_000) / 1_000_000
      : 1;
  const nonBasePctOfTotal =
    grandTotal > 0
      ? Math.round(((grandTotal - baseTotal) / grandTotal) * 1_000_000) /
        1_000_000
      : 0;

  return {
    baseNightly: Math.round(input.baseNightly * 100) / 100,
    allInNightly,
    baseTotal,
    taxesTotal,
    feesTotalExclTaxes,
    grandTotal,
    quotedTotal: grandTotal,
    feePctOfBase: 0,
    taxPctOfBase:
      baseTotal > 0
        ? Math.round((taxesTotal / baseTotal) * 1_000_000) / 1_000_000
        : 0,
    nonBasePctOfTotal,
    allInMultiplier,
  };
}

async function loadDetailQuoteContext(
  externalListingId: string,
): Promise<Record<string, unknown> | null> {
  const detailPath = resolve(
    process.cwd(),
    "src",
    "lib",
    "data",
    "external-sources",
    ADAPTER_KEY,
    "details",
    "json",
    `${externalListingId}.json`,
  );

  try {
    const raw = await readFile(detailPath, "utf8");
    const parsed = JSON.parse(raw) as { quote_context?: unknown };
    return asObject(parsed.quote_context);
  } catch {
    return null;
  }
}

async function loadListingSeeds(
  options: CliOptions,
  progress?: QuoteProgress,
): Promise<ListingSeed[]> {
  const indexPath = resolve(
    process.cwd(),
    "src",
    "lib",
    "data",
    "external-sources",
    ADAPTER_KEY,
    "details",
    "index.json",
  );
  const raw = await readFile(indexPath, "utf8");
  const parsed = JSON.parse(raw) as CanonicalIndexEntry[];
  if (!Array.isArray(parsed)) {
    throw new Error(`Malformed canonical index for ${ADAPTER_KEY}`);
  }

  progress?.phase(`loading canonical listings entries=${parsed.length}`);

  const missingQuoteContextEntries = parsed.filter((entry) => {
    const quoteContext = asObject(entry.quote_context);
    return quoteContext === null;
  }).length;
  if (missingQuoteContextEntries > 0) {
    progress?.tick(
      options.allowDetailBackfill
        ? `canonical index entries missing quote_context=${missingQuoteContextEntries}; attempting detail-json backfill`
        : `canonical index entries missing quote_context=${missingQuoteContextEntries}; backfill disabled (index-only mode)`,
    );
  }

  const seeds: ListingSeed[] = [];
  let backfilled = 0;
  let scanned = 0;
  for (const entry of parsed) {
    const detailUrl =
      typeof entry.detail_url === "string"
        ? normalizeDetailUrl(entry.detail_url)
        : "";
    if (!detailUrl) {
      continue;
    }

    const externalListingIdRaw =
      typeof entry.external_listing_id === "string"
        ? entry.external_listing_id.trim()
        : "";
    const externalListingId =
      externalListingIdRaw || externalListingIdFromDetailUrl(detailUrl);
    if (!externalListingId) {
      continue;
    }

    let quoteContext = asObject(entry.quote_context);
    if (!quoteContext && options.allowDetailBackfill) {
      quoteContext = await loadDetailQuoteContext(externalListingId);
      if (quoteContext) {
        entry.quote_context = quoteContext;
        backfilled += 1;
      }
    }

    seeds.push({
      externalListingId,
      detailUrl,
      quoteContext,
    });

    scanned += 1;
    if (scanned <= 20 || scanned % 200 === 0 || scanned === parsed.length) {
      progress?.tick(
        `canonical seed scan progress ${scanned}/${parsed.length} selected=${seeds.length} backfilled=${backfilled}`,
      );
    }
  }

  if (backfilled > 0) {
    await writeFile(indexPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    progress?.tick(
      `canonical index quote_context backfilled entries=${backfilled}`,
    );
  }

  if (missingQuoteContextEntries > 0 && !options.allowDetailBackfill) {
    progress?.tick(
      `quote_context backfill disabled; proceeding with canonical index only`,
    );
  }

  let selected = seeds;
  if (options.listingId) {
    selected = seeds.filter(
      (seed) => seed.externalListingId === options.listingId,
    );
  } else {
    selected = seeds.slice(0, options.maxListings);
  }

  if (selected.length === 0) {
    throw new Error(
      options.listingId
        ? `Listing '${options.listingId}' not found in canonical index.`
        : "No listings selected from canonical index.",
    );
  }

  return selected;
}

type QuoteWindow = {
  startDate: string;
  endDate: string;
};

function buildQuoteWindows(weeks: number, nights: number): QuoteWindow[] {
  const todayIso = new Date().toISOString().slice(0, 10);
  const anchor = firstSaturdayOnOrAfter(todayIso);
  const windows: QuoteWindow[] = [];
  for (let index = 0; index < weeks; index += 1) {
    const startDate = addDays(anchor, index * 7);
    windows.push({
      startDate,
      endDate: addDays(startDate, nights),
    });
  }
  return windows;
}

async function executeWithRetries(
  request: QuoteExecutionRequest,
  maxAttempts: number,
): Promise<Awaited<ReturnType<typeof execute360BlueSingleQuote>>> {
  let lastResult = await execute360BlueSingleQuote(request);
  if (lastResult.success || !lastResult.error.retryable || maxAttempts <= 1) {
    return lastResult;
  }

  for (let attempt = 2; attempt <= maxAttempts; attempt += 1) {
    lastResult = await execute360BlueSingleQuote(request);
    if (lastResult.success || !lastResult.error.retryable) {
      return lastResult;
    }
  }

  return lastResult;
}

function createSuccessObservation(input: {
  listingId: string;
  nights: number;
  result: Awaited<ReturnType<typeof execute360BlueSingleQuote>>;
}): CanonicalQuoteObservation {
  const observation = input.result.success
    ? input.result.observation
    : {
        startDate: "",
        endDate: "",
        quoteAvailable: false,
        currency: "USD",
        baseTotal: 0,
        taxesTotal: 0,
        feesTotalExclTaxes: 0,
        grandTotal: 0,
        quotedTotal: 0,
        handoffUrl: null,
      };

  const baseTotal = observation.baseTotal ?? 0;
  const taxesTotal = observation.taxesTotal ?? 0;
  const feesTotalExclTaxes = observation.feesTotalExclTaxes ?? 0;
  const grandTotal = observation.grandTotal ?? observation.quotedTotal ?? 0;
  const baseNightly =
    input.nights > 0
      ? Math.round((baseTotal / input.nights) * 100) / 100
      : null;
  const allInNightly =
    input.nights > 0
      ? Math.round((grandTotal / input.nights) * 100) / 100
      : null;

  return {
    sampled_at: new Date().toISOString(),
    captured_at: new Date().toISOString(),
    source_listing_id: input.listingId,
    currency: observation.currency ?? "USD",
    start_date: observation.startDate,
    end_date: observation.endDate,
    check_in_date: observation.startDate,
    check_out_date: observation.endDate,
    nights: input.nights,
    base_nightly: baseNightly,
    all_in_nightly: allInNightly,
    quote_available: true,
    quote_unavailable_reason: null,
    base_total: baseTotal,
    taxes_total: taxesTotal,
    fees_total_excl_taxes: feesTotalExclTaxes,
    fee_lines: [],
    grand_total: grandTotal,
    quoted_total: observation.quotedTotal ?? grandTotal,
    fee_pct_of_base:
      baseTotal > 0
        ? Math.round((feesTotalExclTaxes / baseTotal) * 1_000_000) / 1_000_000
        : 0,
    tax_pct_of_base:
      baseTotal > 0
        ? Math.round((taxesTotal / baseTotal) * 1_000_000) / 1_000_000
        : 0,
    non_base_pct_of_total:
      grandTotal > 0
        ? Math.round(((grandTotal - baseTotal) / grandTotal) * 1_000_000) /
          1_000_000
        : 0,
    all_in_multiplier:
      baseTotal > 0
        ? Math.round((grandTotal / baseTotal) * 1_000_000) / 1_000_000
        : null,
    handoff_url: observation.handoffUrl,
    source: "quote_api",
  };
}

function createUnavailableObservation(input: {
  listingId: string;
  startDate: string;
  endDate: string;
  nights: number;
  reason: string;
  pricing: EstimatedPricing;
  handoffUrl: string | null;
}): CanonicalQuoteObservation {
  return {
    sampled_at: new Date().toISOString(),
    captured_at: new Date().toISOString(),
    source_listing_id: input.listingId,
    currency: "USD",
    start_date: input.startDate,
    end_date: input.endDate,
    check_in_date: input.startDate,
    check_out_date: input.endDate,
    nights: input.nights,
    base_nightly: input.pricing.baseNightly,
    all_in_nightly: input.pricing.allInNightly,
    quote_available: false,
    quote_unavailable_reason: input.reason,
    base_total: input.pricing.baseTotal,
    taxes_total: input.pricing.taxesTotal,
    fees_total_excl_taxes: input.pricing.feesTotalExclTaxes,
    fee_lines: [],
    grand_total: input.pricing.grandTotal,
    quoted_total: input.pricing.quotedTotal,
    fee_pct_of_base: input.pricing.feePctOfBase,
    tax_pct_of_base: input.pricing.taxPctOfBase,
    non_base_pct_of_total: input.pricing.nonBasePctOfTotal,
    all_in_multiplier: input.pricing.allInMultiplier,
    handoff_url: input.handoffUrl,
    source: "quote_api",
  };
}

async function buildSidecarForListing(input: {
  listing: ListingSeed;
  options: CliOptions;
  maxAttempts: number;
  progress?: QuoteProgress;
  onWindowResult?: (result: { quoteAvailable: boolean }) => void;
  onListingComplete?: (result: {
    listingId: string;
    windows: number;
    available: number;
  }) => void;
}): Promise<CanonicalQuotesSidecarRecord> {
  const { listing, options, maxAttempts } = input;
  const windows = buildQuoteWindows(options.weeks, options.nights);

  const runtimeResults = await runWithConcurrency(
    windows,
    options.quoteConcurrency,
    async (window) => {
      const request: QuoteExecutionRequest = {
        listingId: listing.externalListingId,
        checkInIso: window.startDate,
        checkOutIso: window.endDate,
        adults: 1,
        children: 0,
        quoteContext: listing.quoteContext,
        options: {
          timeoutMs: options.timeoutMs,
        },
      };

      const result = await executeWithRetries(request, maxAttempts);
      return {
        window,
        result,
      };
    },
  );

  const successful = runtimeResults.filter((entry) => entry.result.success);
  const successBaseNightlies = successful
    .map((entry) => {
      const observation = entry.result.success
        ? entry.result.observation
        : null;
      if (
        !observation ||
        options.nights <= 0 ||
        observation.baseTotal === null
      ) {
        return null;
      }
      return Math.round((observation.baseTotal / options.nights) * 100) / 100;
    })
    .filter((value): value is number => value !== null && value > 0);
  const successTaxPcts = successful
    .map((entry) => {
      const observation = entry.result.success
        ? entry.result.observation
        : null;
      if (
        !observation ||
        observation.baseTotal === null ||
        observation.baseTotal <= 0 ||
        observation.taxesTotal === null
      ) {
        return null;
      }
      return observation.taxesTotal / observation.baseTotal;
    })
    .filter((value): value is number => value !== null && value >= 0);

  const fallbackBaseNightly =
    median(successBaseNightlies) ?? DEFAULT_BASE_NIGHTLY;
  const fallbackTaxPct = median(successTaxPcts) ?? DEFAULT_TAX_PCT;

  const observations: CanonicalQuoteObservation[] = runtimeResults.map(
    (entry) => {
      if (entry.result.success) {
        input.onWindowResult?.({ quoteAvailable: true });
        return createSuccessObservation({
          listingId: listing.externalListingId,
          nights: options.nights,
          result: entry.result,
        });
      }

      const estimated = createEstimatedPricing({
        baseNightly: fallbackBaseNightly,
        nights: options.nights,
        taxPctOfBase: fallbackTaxPct,
      });
      const reason = `${entry.result.error.code}: ${entry.result.error.message}`;
      input.onWindowResult?.({ quoteAvailable: false });
      return createUnavailableObservation({
        listingId: listing.externalListingId,
        startDate: entry.window.startDate,
        endDate: entry.window.endDate,
        nights: options.nights,
        reason,
        pricing: estimated,
        handoffUrl: buildHandoffUrlFromContext({
          quoteContext: listing.quoteContext,
          checkInIso: entry.window.startDate,
          checkOutIso: entry.window.endDate,
        }),
      });
    },
  );

  const endpointPathRaw =
    typeof listing.quoteContext?.endpoint_path === "string"
      ? listing.quoteContext.endpoint_path.trim()
      : "";
  const endpointPath = endpointPathRaw.startsWith("/")
    ? endpointPathRaw
    : DEFAULT_ENDPOINT_PATH;

  const sidecar: CanonicalQuotesSidecarRecord = {
    adapter_key: ADAPTER_KEY,
    external_listing_id: listing.externalListingId,
    detail_url: listing.detailUrl,
    captured_at: new Date().toISOString(),
    currency: "USD",
    quote_window_cadence: "weekly_sat_to_sat",
    quote_window_gap_policy: "record_unavailable_without_date_shift",
    quote_window_anchor_date: firstSaturdayOnOrAfter(
      new Date().toISOString().slice(0, 10),
    ),
    quote_window_days: options.weeks * 7,
    quote_sample_step_days: 7,
    quote_nights: options.nights,
    quote_max_queries: options.weeks,
    endpoint_path: endpointPath,
    observations,
  };

  assertCanonicalQuotesSidecarRecord(sidecar);
  input.onListingComplete?.({
    listingId: listing.externalListingId,
    windows: observations.length,
    available: observations.filter((obs) => obs.quote_available).length,
  });
  input.progress?.tick(
    `quotes listing=${listing.externalListingId} windows=${observations.length} available=${observations.filter((obs) => obs.quote_available).length}`,
  );
  return sidecar;
}

export async function run360BlueQuoteCli(
  argv: string[],
  progress?: QuoteProgress,
): Promise<void> {
  const options = parseArgs(argv);

  progress?.info(
    [
      `quote-capture mode=index-runtime`,
      `weeks=${options.weeks}`,
      `nights=${options.nights}`,
      `listing_concurrency=${options.listingConcurrency}`,
      `quote_concurrency=${options.quoteConcurrency}`,
      `timeout_ms=${options.timeoutMs}`,
      `max_attempts=${options.maxAttempts}`,
      `allow_detail_backfill=${options.allowDetailBackfill}`,
      `selection=${options.listingId ? `listing:${options.listingId}` : `max-listings:${options.maxListings}`}`,
    ].join(" "),
  );

  const listings = await loadListingSeeds(options, progress);
  const totalListings = listings.length;
  const tracker = createQuoteCaptureProgressTracker({
    progress,
    totalListings,
    windowsPerListing: options.weeks,
    modeLabel: "quote",
    heartbeatMs: Math.max(
      1000,
      Number(process.env.QUOTE_CAPTURE_HEARTBEAT_MS ?? "15000") || 15000,
    ),
  });
  const quotesDir = resolve(
    process.cwd(),
    "src",
    "lib",
    "data",
    "external-sources",
    ADAPTER_KEY,
    "details",
    "quotes",
  );
  await mkdir(quotesDir, { recursive: true });

  const sidecars = await runWithConcurrency(
    listings,
    options.listingConcurrency,
    async (listing) => {
      const sidecar = await buildSidecarForListing({
        listing,
        options,
        maxAttempts: options.maxAttempts,
        progress,
        onWindowResult: ({ quoteAvailable }) => {
          tracker.onWindowResult(quoteAvailable);
        },
        onListingComplete: ({ listingId, windows, available }) => {
          tracker.onListingComplete({
            listingId,
            windows,
            available,
          });
        },
      });

      const outputPath = resolve(
        quotesDir,
        `${sidecar.external_listing_id}.json`,
      );
      await writeFile(
        outputPath,
        `${JSON.stringify(sidecar, null, 2)}\n`,
        "utf8",
      );
      progress?.tick(
        `quote sidecar flushed listing=${sidecar.external_listing_id}`,
      );

      return sidecar;
    },
  ).finally(() => {
    tracker.finish();
  });

  const totalObservations = sidecars.reduce(
    (sum, sidecar) => sum + sidecar.observations.length,
    0,
  );
  const availableObservations = sidecars.reduce(
    (sum, sidecar) =>
      sum +
      sidecar.observations.filter((observation) => observation.quote_available)
        .length,
    0,
  );

  progress?.success(
    `quote-capture complete listings=${sidecars.length} observations=${totalObservations} available=${availableObservations}`,
  );
}
