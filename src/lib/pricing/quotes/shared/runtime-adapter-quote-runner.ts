import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  assertCanonicalQuotesSidecarRecord,
  type CanonicalQuoteObservation,
  type CanonicalQuotesSidecarRecord,
} from "@/lib/pricing/contracts/quote-observations-contract";
import type {
  QuoteExecutionRequest,
  QuoteExecutionResult,
} from "@/lib/pricing/quote-runtime/types";
import { runWithConcurrency } from "@/lib/pricing/quotes/shared/run-with-concurrency";
import type { QuoteProgress } from "@/lib/pricing/quotes/types";
import { canonicalizeExternalListingId } from "@/lib/pricing/shared/external-listing-id";
import { createQuoteCaptureProgressTracker } from "./quote-capture-progress";

type CliOptions = {
  maxListings: number;
  listingId: string | null;
  weeks: number;
  nights: number;
  listingConcurrency: number;
  quoteConcurrency: number;
  timeoutMs: number;
  maxAttempts: number;
  skipFreshQuotes: boolean;
  freshHours: number;
  backfillOnly: boolean;
  backfillWindowHours: number;
  dryRun: boolean;
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

type QuoteBackfillStatus = {
  listingId: string;
  shouldProcess: boolean;
  reason:
    | "missing_quote_sidecar"
    | "missing_quote_captured_at"
    | "missing_detail_json"
    | "missing_detail_fetched_at"
    | "quote_before_detail_window"
    | "quote_after_detail_window"
    | "quote_within_detail_window";
  detailFetchedAt: string | null;
  quoteCapturedAt: string | null;
  deltaMinutes: number | null;
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

type QuoteWindow = {
  startDate: string;
  endDate: string;
};

function hasPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function hasUsableAvailableTotals(result: QuoteExecutionResult): boolean {
  if (!result.success || !result.observation.quoteAvailable) {
    return false;
  }

  const { baseTotal, grandTotal, quotedTotal } = result.observation;
  const hasBase = hasPositiveNumber(baseTotal);
  const hasGrand =
    hasPositiveNumber(grandTotal) || hasPositiveNumber(quotedTotal);
  return hasBase && hasGrand;
}

export type RuntimeAdapterQuoteRunnerConfig = {
  adapterKey: string;
  executeSingleQuote: (
    request: QuoteExecutionRequest,
  ) => Promise<QuoteExecutionResult>;
  maxAttemptsEnvVar?: string;
  defaultMaxListings?: number;
  defaultWeeks?: number;
  defaultNights?: number;
  defaultListingConcurrency?: number;
  defaultQuoteConcurrency?: number;
  defaultQuoteTimeoutMs?: number;
  defaultQuoteMaxAttempts?: number;
  defaultEndpointPath?: string;
  defaultTaxPct?: number;
  defaultBaseNightly?: number;
};

const DEFAULT_MAX_LISTINGS = 10;
const DEFAULT_WEEKS = 24;
const DEFAULT_NIGHTS = 7;
const DEFAULT_LISTING_CONCURRENCY = 3;
const DEFAULT_QUOTE_CONCURRENCY = 3;
const DEFAULT_QUOTE_TIMEOUT_MS = 12000;
const DEFAULT_QUOTE_MAX_ATTEMPTS = 2;
const DEFAULT_ENDPOINT_PATH = "/api/nrbe/reservation-quotes.json";
const DEFAULT_TAX_PCT = 0.12;
const DEFAULT_BASE_NIGHTLY = 500;
const DEFAULT_FRESH_HOURS = 24;
const DEFAULT_BACKFILL_WINDOW_HOURS = 1;

function parseArgs(
  argv: string[],
  defaults: {
    maxListings: number;
    weeks: number;
    nights: number;
    listingConcurrency: number;
    quoteConcurrency: number;
    timeoutMs: number;
    maxAttempts: number;
  },
): CliOptions {
  let maxListings = defaults.maxListings;
  let listingId: string | null = null;
  let weeks = defaults.weeks;
  let nights = defaults.nights;
  let listingConcurrency = defaults.listingConcurrency;
  let quoteConcurrency = defaults.quoteConcurrency;
  let timeoutMs = defaults.timeoutMs;
  let maxAttempts = defaults.maxAttempts;
  let skipFreshQuotes =
    process.env.QUOTE_CAPTURE_SKIP_FRESH_QUOTES === "1" ||
    process.env.QUOTE_CAPTURE_SKIP_FRESH_QUOTES === "true";
  let freshHours = Math.max(
    1,
    Number(process.env.QUOTE_CAPTURE_FRESH_HOURS ?? DEFAULT_FRESH_HOURS) ||
      DEFAULT_FRESH_HOURS,
  );
  let backfillOnly =
    process.env.QUOTE_CAPTURE_BACKFILL_ONLY === "1" ||
    process.env.QUOTE_CAPTURE_BACKFILL_ONLY === "true";
  let backfillWindowHours = Math.max(
    1,
    Number(
      process.env.QUOTE_CAPTURE_BACKFILL_WINDOW_HOURS ??
        DEFAULT_BACKFILL_WINDOW_HOURS,
    ) || DEFAULT_BACKFILL_WINDOW_HOURS,
  );
  let dryRun =
    process.env.QUOTE_CAPTURE_DRY_RUN === "1" ||
    process.env.QUOTE_CAPTURE_DRY_RUN === "true";

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

    if (arg === "--skip-fresh-quotes") {
      skipFreshQuotes = true;
      continue;
    }

    if (arg === "--fresh-hours" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        freshHours = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--backfill-only") {
      backfillOnly = true;
      continue;
    }

    if (arg === "--backfill-window-hours" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        backfillWindowHours = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--dry-run") {
      dryRun = true;
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
    skipFreshQuotes,
    freshHours: Math.max(1, freshHours),
    backfillOnly,
    backfillWindowHours: Math.max(1, backfillWindowHours),
    dryRun,
  };
}

function isIsoWithinHours(iso: string, hours: number): boolean {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) {
    return false;
  }

  return Date.now() - parsed <= hours * 60 * 60 * 1000;
}

async function hasFreshQuoteSidecar(input: {
  quotesDir: string;
  externalListingId: string;
  freshHours: number;
}): Promise<boolean> {
  const sidecarPath = resolve(
    input.quotesDir,
    `${input.externalListingId}.json`,
  );
  try {
    const raw = await readFile(sidecarPath, "utf8");
    const parsed = JSON.parse(raw) as { captured_at?: unknown };
    if (typeof parsed.captured_at !== "string" || !parsed.captured_at.trim()) {
      return false;
    }
    return isIsoWithinHours(parsed.captured_at, input.freshHours);
  } catch {
    return false;
  }
}

async function loadDetailFetchedAt(input: {
  detailsJsonDir: string;
  externalListingId: string;
}): Promise<string | null> {
  const detailPath = resolve(
    input.detailsJsonDir,
    `${input.externalListingId}.json`,
  );
  try {
    const raw = await readFile(detailPath, "utf8");
    const parsed = JSON.parse(raw) as { fetched_at?: unknown };
    if (typeof parsed.fetched_at !== "string" || !parsed.fetched_at.trim()) {
      return null;
    }
    return parsed.fetched_at;
  } catch {
    return null;
  }
}

async function loadQuoteCapturedAt(input: {
  quotesDir: string;
  externalListingId: string;
}): Promise<string | null> {
  const quotePath = resolve(input.quotesDir, `${input.externalListingId}.json`);
  try {
    const raw = await readFile(quotePath, "utf8");
    const parsed = JSON.parse(raw) as { captured_at?: unknown };
    if (typeof parsed.captured_at !== "string" || !parsed.captured_at.trim()) {
      return null;
    }
    return parsed.captured_at;
  } catch {
    return null;
  }
}

function evaluateQuoteBackfillStatus(input: {
  listingId: string;
  detailFetchedAt: string | null;
  quoteCapturedAt: string | null;
  backfillWindowHours: number;
}): QuoteBackfillStatus {
  const { listingId, detailFetchedAt, quoteCapturedAt, backfillWindowHours } =
    input;

  if (quoteCapturedAt === null) {
    return {
      listingId,
      shouldProcess: true,
      reason: "missing_quote_sidecar",
      detailFetchedAt,
      quoteCapturedAt,
      deltaMinutes: null,
    };
  }

  if (!quoteCapturedAt.trim()) {
    return {
      listingId,
      shouldProcess: true,
      reason: "missing_quote_captured_at",
      detailFetchedAt,
      quoteCapturedAt,
      deltaMinutes: null,
    };
  }

  if (detailFetchedAt === null) {
    return {
      listingId,
      shouldProcess: true,
      reason: "missing_detail_json",
      detailFetchedAt,
      quoteCapturedAt,
      deltaMinutes: null,
    };
  }

  if (!detailFetchedAt.trim()) {
    return {
      listingId,
      shouldProcess: true,
      reason: "missing_detail_fetched_at",
      detailFetchedAt,
      quoteCapturedAt,
      deltaMinutes: null,
    };
  }

  const detailMs = Date.parse(detailFetchedAt);
  if (!Number.isFinite(detailMs)) {
    return {
      listingId,
      shouldProcess: true,
      reason: "missing_detail_fetched_at",
      detailFetchedAt,
      quoteCapturedAt,
      deltaMinutes: null,
    };
  }

  const quoteMs = Date.parse(quoteCapturedAt);
  if (!Number.isFinite(quoteMs)) {
    return {
      listingId,
      shouldProcess: true,
      reason: "missing_quote_captured_at",
      detailFetchedAt,
      quoteCapturedAt,
      deltaMinutes: null,
    };
  }

  const windowMs = backfillWindowHours * 60 * 60 * 1000;
  const deltaMinutes = Math.round((quoteMs - detailMs) / (60 * 1000));
  const diffMs = quoteMs - detailMs;

  if (diffMs < -windowMs) {
    return {
      listingId,
      shouldProcess: true,
      reason: "quote_before_detail_window",
      detailFetchedAt,
      quoteCapturedAt,
      deltaMinutes,
    };
  }

  if (diffMs > windowMs) {
    return {
      listingId,
      shouldProcess: true,
      reason: "quote_after_detail_window",
      detailFetchedAt,
      quoteCapturedAt,
      deltaMinutes,
    };
  }

  return {
    listingId,
    shouldProcess: false,
    reason: "quote_within_detail_window",
    detailFetchedAt,
    quoteCapturedAt,
    deltaMinutes,
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

async function loadListingSeeds(
  adapterKey: string,
  options: CliOptions,
  progress?: QuoteProgress,
): Promise<ListingSeed[]> {
  const indexPath = resolve(
    process.cwd(),
    "src",
    "lib",
    "data",
    "external-sources",
    adapterKey,
    "details",
    "index.json",
  );
  const raw = await readFile(indexPath, "utf8");
  const parsed = JSON.parse(raw) as CanonicalIndexEntry[];
  if (!Array.isArray(parsed)) {
    throw new Error(`Malformed canonical index for ${adapterKey}`);
  }

  progress?.phase(`loading canonical listings entries=${parsed.length}`);

  const missingQuoteContextEntries = parsed.filter((entry) => {
    const quoteContext = asObject(entry.quote_context);
    return quoteContext === null;
  }).length;
  if (missingQuoteContextEntries > 0) {
    progress?.tick(
      `canonical index entries missing quote_context=${missingQuoteContextEntries}; index-only mode`,
    );
  }

  const redundantEndpointPathEntries = parsed.filter((entry) => {
    const quoteContext = asObject(entry.quote_context);
    return quoteContext !== null && "endpoint_path" in quoteContext;
  }).length;
  if (redundantEndpointPathEntries > 0) {
    throw new Error(
      `canonical index entries include redundant quote_context.endpoint_path=${redundantEndpointPathEntries}; remove endpoint_path from quote_context payloads`,
    );
  }

  const seeds: ListingSeed[] = [];
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
      canonicalizeExternalListingId(externalListingIdRaw) ||
      externalListingIdFromDetailUrl(detailUrl);
    if (!externalListingId) {
      continue;
    }

    const quoteContext = asObject(entry.quote_context);

    seeds.push({
      externalListingId,
      detailUrl,
      quoteContext,
    });

    scanned += 1;
    if (scanned <= 20 || scanned % 200 === 0 || scanned === parsed.length) {
      progress?.tick(
        `canonical seed scan progress ${scanned}/${parsed.length} selected=${seeds.length}`,
      );
    }
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
  executeSingleQuote: (
    request: QuoteExecutionRequest,
  ) => Promise<QuoteExecutionResult>,
): Promise<QuoteExecutionResult> {
  const isRateLimitedResult = (result: QuoteExecutionResult): boolean => {
    if (result.success) {
      return false;
    }

    const code = result.error.code.trim().toUpperCase();
    const message = result.error.message.trim().toLowerCase();
    return (
      code === "QUOTE_RATE_LIMITED" ||
      message.includes("too_many_requests") ||
      message.includes("too many requests") ||
      message.includes("rate limit") ||
      message.includes("status 429")
    );
  };

  const sleep = async (ms: number): Promise<void> => {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
  };

  let lastResult = await executeSingleQuote(request);
  if (lastResult.success || !lastResult.error.retryable || maxAttempts <= 1) {
    return lastResult;
  }

  for (let attempt = 2; attempt <= maxAttempts; attempt += 1) {
    const backoffMs = isRateLimitedResult(lastResult)
      ? Math.min(12000, 2000 * 2 ** (attempt - 2))
      : Math.min(3000, 500 * attempt);
    const jitterMs = Math.floor(Math.random() * 400);
    await sleep(backoffMs + jitterMs);

    lastResult = await executeSingleQuote(request);
    if (lastResult.success || !lastResult.error.retryable) {
      return lastResult;
    }
  }

  return lastResult;
}

function createSuccessObservation(input: {
  listingId: string;
  nights: number;
  result: QuoteExecutionResult;
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

  const observedBaseTotal =
    typeof observation.baseTotal === "number" && observation.baseTotal > 0
      ? observation.baseTotal
      : null;
  const observedTaxesTotal =
    typeof observation.taxesTotal === "number" && observation.taxesTotal >= 0
      ? observation.taxesTotal
      : null;
  const observedFeesTotal =
    typeof observation.feesTotalExclTaxes === "number" &&
    observation.feesTotalExclTaxes >= 0
      ? observation.feesTotalExclTaxes
      : null;
  const observedGrandTotal =
    typeof observation.grandTotal === "number" && observation.grandTotal > 0
      ? observation.grandTotal
      : typeof observation.quotedTotal === "number" &&
          observation.quotedTotal > 0
        ? observation.quotedTotal
        : null;

  const baseTotal = observedBaseTotal ?? observedGrandTotal ?? 1;
  const taxesTotal = observedTaxesTotal ?? 0;
  const feesTotalExclTaxes = observedFeesTotal ?? 0;
  const grandTotal =
    observedGrandTotal ??
    Math.round((baseTotal + taxesTotal + feesTotalExclTaxes) * 100) / 100;
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
    quoted_total:
      typeof observation.quotedTotal === "number" && observation.quotedTotal > 0
        ? observation.quotedTotal
        : grandTotal,
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
        : 1,
    handoff_url: observation.handoffUrl,
    source: "quote_api",
    pricing_source: "runtime_parsed",
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
    pricing_source: "estimated_unavailable",
  };
}

function toUnavailableReason(result: QuoteExecutionResult): string {
  if (result.success) {
    return (
      result.observation.quoteUnavailableReason?.trim() ||
      "adapter returned unavailable quote window"
    );
  }

  const code = result.error.code.trim().toUpperCase();
  const message = result.error.message.trim();
  const normalizedMessage = message.toLowerCase();
  const isRateLimited =
    code === "QUOTE_RATE_LIMITED" ||
    normalizedMessage.includes("too_many_requests") ||
    normalizedMessage.includes("too many requests") ||
    normalizedMessage.includes("rate limit") ||
    normalizedMessage.includes("status 429");

  if (isRateLimited) {
    return "QUOTE_UNAVAILABLE: Quote provider temporarily throttled request";
  }

  return `${result.error.code}: ${result.error.message}`;
}

function runtimeProvidedHandoffUrl(
  result: QuoteExecutionResult,
): string | null {
  if (result.success) {
    if (
      typeof result.observation.handoffUrl === "string" &&
      result.observation.handoffUrl.trim().length > 0
    ) {
      return result.observation.handoffUrl.trim();
    }
    return null;
  }

  const details =
    result.error.details && typeof result.error.details === "object"
      ? result.error.details
      : null;
  const handoff =
    details?.handoffUrl ??
    (typeof details?.handoff_url === "string" ? details.handoff_url : null);
  if (typeof handoff === "string" && handoff.trim().length > 0) {
    return handoff.trim();
  }
  return null;
}

async function buildSidecarForListing(input: {
  config: RuntimeAdapterQuoteRunnerConfig;
  listing: ListingSeed;
  options: CliOptions;
  progress?: QuoteProgress;
  onWindowResult?: (result: { quoteAvailable: boolean }) => void;
  onListingComplete?: (result: {
    listingId: string;
    windows: number;
    available: number;
  }) => void;
}): Promise<CanonicalQuotesSidecarRecord> {
  const { config, listing, options } = input;
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

      const result = await executeWithRetries(
        request,
        options.maxAttempts,
        config.executeSingleQuote,
      );

      const runtimeHandoffUrl = runtimeProvidedHandoffUrl(result);
      if (!runtimeHandoffUrl) {
        throw new Error(
          `runtime adapter '${config.adapterKey}' did not provide handoffUrl for listing '${listing.externalListingId}' window ${window.startDate} -> ${window.endDate}`,
        );
      }

      const quoteAvailable = hasUsableAvailableTotals(result);
      input.onWindowResult?.({ quoteAvailable });

      return {
        window,
        result,
        runtimeHandoffUrl,
        quoteAvailable,
      };
    },
  );

  const successBaseNightlies = runtimeResults
    .map((entry) => {
      if (!entry.result.success || options.nights <= 0) {
        return null;
      }
      if (entry.result.observation.baseTotal === null) {
        return null;
      }
      return (
        Math.round(
          (entry.result.observation.baseTotal / options.nights) * 100,
        ) / 100
      );
    })
    .filter((value): value is number => value !== null && value > 0);

  const successTaxPcts = runtimeResults
    .map((entry) => {
      if (!entry.result.success) {
        return null;
      }
      const { baseTotal, taxesTotal } = entry.result.observation;
      if (baseTotal === null || taxesTotal === null || baseTotal <= 0) {
        return null;
      }
      return taxesTotal / baseTotal;
    })
    .filter((value): value is number => value !== null && value >= 0);

  const fallbackBaseNightly =
    median(successBaseNightlies) ??
    config.defaultBaseNightly ??
    DEFAULT_BASE_NIGHTLY;
  const fallbackTaxPct =
    median(successTaxPcts) ?? config.defaultTaxPct ?? DEFAULT_TAX_PCT;

  const observations: CanonicalQuoteObservation[] = runtimeResults.map(
    (entry) => {
      if (entry.quoteAvailable) {
        if (
          !entry.result.success ||
          typeof entry.result.observation.handoffUrl !== "string" ||
          entry.result.observation.handoffUrl.trim().length === 0
        ) {
          throw new Error(
            `runtime adapter '${config.adapterKey}' returned available totals without handoffUrl for listing '${listing.externalListingId}' window ${entry.window.startDate} -> ${entry.window.endDate}`,
          );
        }
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
      const reason = toUnavailableReason(entry.result);
      return createUnavailableObservation({
        listingId: listing.externalListingId,
        startDate: entry.window.startDate,
        endDate: entry.window.endDate,
        nights: options.nights,
        reason,
        pricing: estimated,
        handoffUrl: entry.runtimeHandoffUrl,
      });
    },
  );

  const endpointPathRaw =
    typeof listing.quoteContext?.endpoint_path === "string"
      ? listing.quoteContext.endpoint_path.trim()
      : "";
  const endpointPath = endpointPathRaw.startsWith("/")
    ? endpointPathRaw
    : (config.defaultEndpointPath ?? DEFAULT_ENDPOINT_PATH);

  const sidecar: CanonicalQuotesSidecarRecord = {
    adapter_key: config.adapterKey,
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

export async function runRuntimeAdapterQuoteCli(
  config: RuntimeAdapterQuoteRunnerConfig,
  argv: string[],
  progress?: QuoteProgress,
): Promise<void> {
  const defaults = {
    maxListings: config.defaultMaxListings ?? DEFAULT_MAX_LISTINGS,
    weeks: config.defaultWeeks ?? DEFAULT_WEEKS,
    nights: config.defaultNights ?? DEFAULT_NIGHTS,
    listingConcurrency:
      config.defaultListingConcurrency ?? DEFAULT_LISTING_CONCURRENCY,
    quoteConcurrency:
      config.defaultQuoteConcurrency ?? DEFAULT_QUOTE_CONCURRENCY,
    timeoutMs: config.defaultQuoteTimeoutMs ?? DEFAULT_QUOTE_TIMEOUT_MS,
    maxAttempts: Math.max(
      1,
      Number(
        process.env[config.maxAttemptsEnvVar ?? ""] ??
          config.defaultQuoteMaxAttempts ??
          DEFAULT_QUOTE_MAX_ATTEMPTS,
      ) ||
        config.defaultQuoteMaxAttempts ||
        DEFAULT_QUOTE_MAX_ATTEMPTS,
    ),
  };

  const options = parseArgs(argv, defaults);

  progress?.info(
    [
      `quote-capture mode=index-runtime`,
      `weeks=${options.weeks}`,
      `nights=${options.nights}`,
      `listing_concurrency=${options.listingConcurrency}`,
      `quote_concurrency=${options.quoteConcurrency}`,
      `timeout_ms=${options.timeoutMs}`,
      `max_attempts=${options.maxAttempts}`,
      `skip_fresh_quotes=${options.skipFreshQuotes}`,
      `fresh_hours=${options.freshHours}`,
      `selection=${options.listingId ? `listing:${options.listingId}` : `max-listings:${options.maxListings}`}`,
    ].join(" "),
  );

  const listings = await loadListingSeeds(config.adapterKey, options, progress);

  const quotesDir = resolve(
    process.cwd(),
    "src",
    "lib",
    "data",
    "external-sources",
    config.adapterKey,
    "details",
    "quotes",
  );
  await mkdir(quotesDir, { recursive: true });

  let listingsToProcess = listings;
  let skippedFresh = 0;
  if (options.skipFreshQuotes) {
    progress?.phase(
      `evaluating existing quote sidecars for freshness (hours=${options.freshHours})`,
    );
    const keep: ListingSeed[] = [];
    for (const listing of listings) {
      const fresh = await hasFreshQuoteSidecar({
        quotesDir,
        externalListingId: listing.externalListingId,
        freshHours: options.freshHours,
      });
      if (fresh) {
        skippedFresh += 1;
      } else {
        keep.push(listing);
      }
    }
    listingsToProcess = keep;
    progress?.tick(
      `quote freshness evaluation complete skipped_fresh=${skippedFresh}/${listings.length} to_process=${listingsToProcess.length}`,
    );
  }

  let backfillStatuses: QuoteBackfillStatus[] = [];
  if (options.backfillOnly) {
    progress?.phase(
      `evaluating quote backfill candidates (window_hours=${options.backfillWindowHours})`,
    );

    for (const listing of listingsToProcess) {
      const detailFetchedAt = await loadDetailFetchedAt({
        detailsJsonDir: resolve(
          process.cwd(),
          "src",
          "lib",
          "data",
          "external-sources",
          config.adapterKey,
          "details",
          "json",
        ),
        externalListingId: listing.externalListingId,
      });
      const quoteCapturedAt = await loadQuoteCapturedAt({
        quotesDir,
        externalListingId: listing.externalListingId,
      });

      backfillStatuses.push(
        evaluateQuoteBackfillStatus({
          listingId: listing.externalListingId,
          detailFetchedAt,
          quoteCapturedAt,
          backfillWindowHours: options.backfillWindowHours,
        }),
      );
    }

    const byReason = new Map<string, number>();
    for (const status of backfillStatuses) {
      byReason.set(status.reason, (byReason.get(status.reason) ?? 0) + 1);
    }

    listingsToProcess = listingsToProcess.filter((listing) => {
      const status = backfillStatuses.find(
        (entry) => entry.listingId === listing.externalListingId,
      );
      return status?.shouldProcess ?? false;
    });

    const reasonsSummary = Array.from(byReason.entries())
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([reason, count]) => `${reason}:${count}`)
      .join(", ");

    progress?.tick(
      `quote backfill evaluation complete candidates=${listingsToProcess.length}/${backfillStatuses.length}${reasonsSummary ? ` reasons=[${reasonsSummary}]` : ""}`,
    );
  }

  if (options.dryRun) {
    const selectedIds = listingsToProcess.map(
      (listing) => listing.externalListingId,
    );
    const sampleIds = selectedIds.slice(0, 20).join(", ");

    progress?.success(
      [
        `quote-capture dry-run complete adapter=${config.adapterKey}`,
        `selected=${selectedIds.length}`,
        `skipped_fresh=${skippedFresh}`,
        `backfill_only=${options.backfillOnly}`,
        `sample_listing_ids=${sampleIds || "none"}`,
      ].join(" "),
    );
    return;
  }

  if (listingsToProcess.length === 0) {
    progress?.success(
      `quote-capture complete listings=0 observations=0 available=0 skipped_fresh=${skippedFresh}`,
    );
    return;
  }

  const tracker = createQuoteCaptureProgressTracker({
    progress,
    totalListings: listingsToProcess.length,
    windowsPerListing: options.weeks,
    modeLabel: "quote",
    heartbeatMs: Math.max(
      1000,
      Number(process.env.QUOTE_CAPTURE_HEARTBEAT_MS ?? "15000") || 15000,
    ),
  });

  const sidecars = await runWithConcurrency(
    listingsToProcess,
    options.listingConcurrency,
    async (listing) => {
      const sidecar = await buildSidecarForListing({
        config,
        listing,
        options,
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
    `quote-capture complete listings=${sidecars.length} observations=${totalObservations} available=${availableObservations} skipped_fresh=${skippedFresh}`,
  );
}
