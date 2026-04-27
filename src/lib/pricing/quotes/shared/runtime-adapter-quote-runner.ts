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
  skipCoveredWindows: boolean;
  minOverlapNights: number;
  backfillOnly: boolean;
  backfillWindowHours: number;
  dryRun: boolean;
};

type CanonicalIndexEntry = {
  file_id?: unknown;
  detail_url?: unknown;
  external_listing_id?: unknown;
  quote_context?: unknown;
};

type ListingSeed = {
  fileId: string;
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

type QuoteWindow = {
  startDate: string;
  endDate: string;
  nights: number;
};

type AvailabilityDay = {
  date: string;
  status_code?: string;
  is_available?: boolean;
  is_available_for_checkin?: boolean;
  is_available_for_checkout?: boolean;
  min_nights_required?: number | null;
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
const DEFAULT_MIN_OVERLAP_NIGHTS = 3;
const DEFAULT_BACKFILL_WINDOW_HOURS = 1;
const DEFAULT_MIN_PROBE_NIGHTS = 3;
const DEFAULT_MAX_PROBE_NIGHTS = 14;
const DEFAULT_QUOTE_OBSERVATION_RETENTION_DAYS = 365;

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
  let skipCoveredWindows =
    process.env.QUOTE_CAPTURE_SKIP_COVERED_WINDOWS !== "0";
  let minOverlapNights = Math.max(
    1,
    Number(
      process.env.QUOTE_CAPTURE_MIN_OVERLAP_NIGHTS ??
        DEFAULT_MIN_OVERLAP_NIGHTS,
    ) || DEFAULT_MIN_OVERLAP_NIGHTS,
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

    if (arg === "--skip-covered-windows") {
      skipCoveredWindows = true;
      continue;
    }

    if (arg === "--no-skip-covered-windows") {
      skipCoveredWindows = false;
      continue;
    }

    if (arg === "--min-overlap-nights" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        minOverlapNights = Math.floor(parsed);
      }
      index += 1;
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
    skipCoveredWindows,
    minOverlapNights: Math.max(1, minOverlapNights),
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
  fileId: string;
  freshHours: number;
}): Promise<boolean> {
  const sidecarPath = resolve(input.quotesDir, `${input.fileId}.json`);
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
  fileId: string;
}): Promise<string | null> {
  const detailPath = resolve(input.detailsJsonDir, `${input.fileId}.json`);
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
  fileId: string;
}): Promise<string | null> {
  const quotePath = resolve(input.quotesDir, `${input.fileId}.json`);
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

function normalizeListingLookupKey(value: string): string {
  const canonical = canonicalizeExternalListingId(value);
  if (canonical) {
    return canonical;
  }
  return value.trim().toLowerCase();
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
      externalListingIdRaw || externalListingIdFromDetailUrl(detailUrl);
    const fileIdRaw =
      typeof entry.file_id === "string" ? entry.file_id.trim() : "";
    const fileId =
      canonicalizeExternalListingId(fileIdRaw) ||
      canonicalizeExternalListingId(externalListingId) ||
      canonicalizeExternalListingId(externalListingIdFromDetailUrl(detailUrl));
    if (!externalListingId || !fileId) {
      continue;
    }

    const quoteContext = asObject(entry.quote_context);

    seeds.push({
      fileId,
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
    const requestedListingKey = normalizeListingLookupKey(options.listingId);
    selected = seeds.filter(
      (seed) =>
        normalizeListingLookupKey(seed.externalListingId) ===
          requestedListingKey ||
        normalizeListingLookupKey(seed.fileId) === requestedListingKey,
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
      nights,
    });
  }
  return windows;
}

function normalizeAvailabilityDays(raw: unknown): AvailabilityDay[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const out: AvailabilityDay[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const day = item as Record<string, unknown>;
    const date =
      typeof day.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day.date)
        ? day.date
        : null;
    if (!date) {
      continue;
    }

    const minNightsRaw = day.min_nights_required;
    const minNights =
      typeof minNightsRaw === "number" &&
      Number.isFinite(minNightsRaw) &&
      minNightsRaw > 0
        ? Math.floor(minNightsRaw)
        : null;

    out.push({
      date,
      status_code:
        typeof day.status_code === "string"
          ? day.status_code.trim().toUpperCase()
          : undefined,
      is_available:
        typeof day.is_available === "boolean" ? day.is_available : undefined,
      is_available_for_checkin:
        typeof day.is_available_for_checkin === "boolean"
          ? day.is_available_for_checkin
          : undefined,
      is_available_for_checkout:
        typeof day.is_available_for_checkout === "boolean"
          ? day.is_available_for_checkout
          : undefined,
      min_nights_required: minNights,
    });
  }

  return out;
}

async function loadAvailabilityDays(input: {
  detailsJsonDir: string;
  fileId: string;
}): Promise<AvailabilityDay[]> {
  const detailPath = resolve(input.detailsJsonDir, `${input.fileId}.json`);
  try {
    const raw = await readFile(detailPath, "utf8");
    const parsed = JSON.parse(raw) as {
      normalized_availability?: { days?: unknown };
    };
    return normalizeAvailabilityDays(parsed.normalized_availability?.days);
  } catch {
    return [];
  }
}

function canStartStay(day: AvailabilityDay): boolean {
  if (day.status_code === "I" || day.status_code === "A") {
    return true;
  }
  return day.is_available_for_checkin === true;
}

function canEndStay(day: AvailabilityDay): boolean {
  if (day.status_code === "O" || day.status_code === "A") {
    return true;
  }
  return day.is_available_for_checkout === true;
}

function canQuoteWindow(input: {
  byDate: Map<string, AvailabilityDay>;
  startDate: string;
  nights: number;
}): boolean {
  const { byDate, startDate, nights } = input;
  const start = byDate.get(startDate);
  if (!start) {
    return false;
  }

  if (!canStartStay(start)) {
    return false;
  }

  const minNights =
    typeof start.min_nights_required === "number" &&
    start.min_nights_required > 0
      ? start.min_nights_required
      : 1;
  if (nights < minNights) {
    return false;
  }

  // Start day can be arrival-only (I). Remaining stay dates must be available.
  for (let offset = 1; offset < nights; offset += 1) {
    const stayDate = addDays(startDate, offset);
    const day = byDate.get(stayDate);
    if (!day || day.is_available !== true) {
      return false;
    }
  }

  const checkOut = byDate.get(addDays(startDate, nights));
  if (!checkOut || !canEndStay(checkOut)) {
    return false;
  }

  return true;
}

function buildAdaptiveQuoteWindows(input: {
  weeks: number;
  targetNights: number;
  availabilityDays: AvailabilityDay[];
  defaultMinProbeNights: number;
  defaultMaxProbeNights: number;
}): QuoteWindow[] {
  const todayIso = new Date().toISOString().slice(0, 10);
  const horizonDays = Math.max(1, input.weeks * 7);
  const horizonEndIso = addDays(todayIso, horizonDays - 1);
  const fallback = buildQuoteWindows(input.weeks, input.targetNights);
  if (input.availabilityDays.length === 0) {
    return fallback;
  }

  const byDate = new Map(input.availabilityDays.map((day) => [day.date, day]));
  const explicitMinNightValues = input.availabilityDays
    .map((day) =>
      typeof day.min_nights_required === "number" && day.min_nights_required > 0
        ? Math.floor(day.min_nights_required)
        : null,
    )
    .filter((value): value is number => value !== null);
  const inferredMinNights =
    explicitMinNightValues.length > 0
      ? Math.max(1, Math.min(...explicitMinNightValues))
      : Math.max(1, input.defaultMinProbeNights);
  const minProbeNights = Math.min(
    14,
    Math.max(3, input.defaultMinProbeNights, inferredMinNights),
  );
  const maxProbeNights = Math.max(
    minProbeNights,
    Math.min(14, Math.max(input.defaultMaxProbeNights, input.targetNights)),
  );

  const sortedDays = [...input.availabilityDays]
    .filter((day) => day.date >= todayIso && day.date <= horizonEndIso)
    .sort((left, right) => left.date.localeCompare(right.date));

  const windows: QuoteWindow[] = [];
  let dayIndex = 0;
  while (dayIndex < sortedDays.length) {
    const day = sortedDays[dayIndex];
    if (!day) {
      break;
    }

    if (!canStartStay(day)) {
      dayIndex += 1;
      continue;
    }

    let selectedNights: number | null = null;
    for (let nights = maxProbeNights; nights >= minProbeNights; nights -= 1) {
      if (canQuoteWindow({ byDate, startDate: day.date, nights })) {
        selectedNights = nights;
        break;
      }
    }

    if (selectedNights === null) {
      dayIndex += 1;
      continue;
    }

    const nextStartDate = addDays(day.date, selectedNights);
    windows.push({
      startDate: day.date,
      endDate: nextStartDate,
      nights: selectedNights,
    });

    while (dayIndex < sortedDays.length) {
      const probeDay = sortedDays[dayIndex];
      if (!probeDay || probeDay.date >= nextStartDate) {
        break;
      }
      dayIndex += 1;
    }
  }

  if (windows.length === 0) {
    return fallback;
  }

  return windows.sort((left, right) => {
    const startCompare = left.startDate.localeCompare(right.startDate);
    if (startCompare !== 0) {
      return startCompare;
    }
    return right.nights - left.nights;
  });
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

function parseIsoMs(iso: string | null | undefined): number | null {
  if (!iso || typeof iso !== "string") {
    return null;
  }

  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return parsed;
}

function windowNightsFromDates(startDate: string, endDate: string): number {
  const startMs = Date.parse(`${startDate}T00:00:00Z`);
  const endMs = Date.parse(`${endDate}T00:00:00Z`);
  if (
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs) ||
    endMs <= startMs
  ) {
    return 0;
  }

  return Math.floor((endMs - startMs) / (24 * 60 * 60 * 1000));
}

function overlapNights(input: {
  leftStartDate: string;
  leftEndDate: string;
  rightStartDate: string;
  rightEndDate: string;
}): number {
  const leftStart = Date.parse(`${input.leftStartDate}T00:00:00Z`);
  const leftEnd = Date.parse(`${input.leftEndDate}T00:00:00Z`);
  const rightStart = Date.parse(`${input.rightStartDate}T00:00:00Z`);
  const rightEnd = Date.parse(`${input.rightEndDate}T00:00:00Z`);

  if (
    !Number.isFinite(leftStart) ||
    !Number.isFinite(leftEnd) ||
    !Number.isFinite(rightStart) ||
    !Number.isFinite(rightEnd)
  ) {
    return 0;
  }

  const start = Math.max(leftStart, rightStart);
  const end = Math.min(leftEnd, rightEnd);
  if (end <= start) {
    return 0;
  }

  return Math.floor((end - start) / (24 * 60 * 60 * 1000));
}

function observationIsFresh(input: {
  observation: CanonicalQuoteObservation;
  freshHours: number;
}): boolean {
  const capturedMs = parseIsoMs(input.observation.captured_at);
  if (capturedMs === null) {
    return false;
  }

  const ageMs = Date.now() - capturedMs;
  return ageMs <= input.freshHours * 60 * 60 * 1000;
}

function windowCoveredByFreshObservation(input: {
  window: QuoteWindow;
  existingObservations: CanonicalQuoteObservation[];
  freshHours: number;
  minOverlapNights: number;
}): boolean {
  const targetMinOverlap = Math.min(
    input.window.nights,
    Math.max(1, input.minOverlapNights),
  );

  return input.existingObservations.some((observation) => {
    if (!isRealQuoteObservation(observation)) {
      return false;
    }

    if (!observationIsFresh({ observation, freshHours: input.freshHours })) {
      return false;
    }

    const observationNights =
      typeof observation.nights === "number" && observation.nights > 0
        ? observation.nights
        : windowNightsFromDates(
            observation.check_in_date,
            observation.check_out_date,
          );
    if (observationNights < targetMinOverlap) {
      return false;
    }

    const overlap = overlapNights({
      leftStartDate: input.window.startDate,
      leftEndDate: input.window.endDate,
      rightStartDate: observation.check_in_date,
      rightEndDate: observation.check_out_date,
    });

    return overlap >= targetMinOverlap;
  });
}

function observationKey(observation: CanonicalQuoteObservation): string {
  return [
    observation.check_in_date,
    observation.check_out_date,
    observation.nights,
  ].join("|");
}

function observationMonthBucket(
  observation: CanonicalQuoteObservation,
): string {
  const checkIn = observation.check_in_date ?? "";
  if (checkIn.length >= 7) {
    return checkIn.slice(0, 7);
  }
  return "unknown";
}

function isRealQuoteObservation(
  observation: CanonicalQuoteObservation,
): boolean {
  if (observation.quote_available !== true) {
    return false;
  }

  if (
    observation.pricing_source &&
    observation.pricing_source !== "runtime_parsed"
  ) {
    return false;
  }

  return true;
}

async function loadExistingRealQuoteObservations(input: {
  outputPath: string;
}): Promise<CanonicalQuoteObservation[]> {
  try {
    const raw = await readFile(input.outputPath, "utf8");
    const parsed = JSON.parse(raw) as { observations?: unknown };
    if (!Array.isArray(parsed.observations)) {
      return [];
    }

    const observations: CanonicalQuoteObservation[] = [];
    for (const entry of parsed.observations) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }

      const observation = entry as CanonicalQuoteObservation;
      if (!isRealQuoteObservation(observation)) {
        continue;
      }

      observations.push(observation);
    }

    return observations;
  } catch {
    return [];
  }
}

function mergeRealQuoteObservations(input: {
  existing: CanonicalQuoteObservation[];
  latest: CanonicalQuoteObservation[];
  nowMs: number;
  retentionDays: number;
}): CanonicalQuoteObservation[] {
  const byKey = new Map<string, CanonicalQuoteObservation>();

  const upsert = (observation: CanonicalQuoteObservation): void => {
    const key = observationKey(observation);
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, observation);
      return;
    }

    const currentMs =
      parseIsoMs(current.captured_at) ?? Number.NEGATIVE_INFINITY;
    const nextMs =
      parseIsoMs(observation.captured_at) ?? Number.NEGATIVE_INFINITY;
    if (nextMs >= currentMs) {
      byKey.set(key, observation);
    }
  };

  for (const observation of input.existing) {
    if (isRealQuoteObservation(observation)) {
      upsert(observation);
    }
  }

  for (const observation of input.latest) {
    if (isRealQuoteObservation(observation)) {
      upsert(observation);
    }
  }

  const merged = Array.from(byKey.values());
  const monthToNewestMs = new Map<string, number>();
  for (const observation of merged) {
    const bucket = observationMonthBucket(observation);
    const capturedMs = parseIsoMs(observation.captured_at);
    if (capturedMs === null) {
      continue;
    }
    const existingNewest =
      monthToNewestMs.get(bucket) ?? Number.NEGATIVE_INFINITY;
    if (capturedMs > existingNewest) {
      monthToNewestMs.set(bucket, capturedMs);
    }
  }

  const maxAgeMs = Math.max(1, input.retentionDays) * 24 * 60 * 60 * 1000;
  const pruned = merged.filter((observation) => {
    const capturedMs = parseIsoMs(observation.captured_at);
    if (capturedMs === null) {
      return true;
    }

    const ageMs = input.nowMs - capturedMs;
    if (ageMs < maxAgeMs) {
      return true;
    }

    const bucket = observationMonthBucket(observation);
    const newestInBucket = monthToNewestMs.get(bucket);
    if (!Number.isFinite(newestInBucket ?? Number.NaN)) {
      return true;
    }

    // Only prune 1y+ observations when a newer quote exists in the same month bucket.
    return capturedMs >= (newestInBucket ?? capturedMs);
  });

  return pruned.sort((a, b) => {
    if (a.check_in_date < b.check_in_date) {
      return -1;
    }
    if (a.check_in_date > b.check_in_date) {
      return 1;
    }
    if (a.nights < b.nights) {
      return -1;
    }
    if (a.nights > b.nights) {
      return 1;
    }

    const aMs = parseIsoMs(a.captured_at) ?? 0;
    const bMs = parseIsoMs(b.captured_at) ?? 0;
    return aMs - bMs;
  });
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
  availabilityDays: AvailabilityDay[];
  defaultMinProbeNights: number;
  defaultMaxProbeNights: number;
  existingRealQuoteObservations: CanonicalQuoteObservation[];
  progress?: QuoteProgress;
  onWindowsPlanned?: (windows: number) => void;
  onWindowResult?: (result: { quoteAvailable: boolean }) => void;
  onListingComplete?: (result: {
    listingId: string;
    windows: number;
    available: number;
  }) => void;
}): Promise<CanonicalQuotesSidecarRecord> {
  const { config, listing, options } = input;
  const windows = buildAdaptiveQuoteWindows({
    weeks: options.weeks,
    targetNights: options.nights,
    availabilityDays: input.availabilityDays,
    defaultMinProbeNights: input.defaultMinProbeNights,
    defaultMaxProbeNights: input.defaultMaxProbeNights,
  });

  const windowsToQuery = options.skipCoveredWindows
    ? windows.filter(
        (window) =>
          !windowCoveredByFreshObservation({
            window,
            existingObservations: input.existingRealQuoteObservations,
            freshHours: options.freshHours,
            minOverlapNights: options.minOverlapNights,
          }),
      )
    : windows;
  input.onWindowsPlanned?.(windowsToQuery.length);

  if (windowsToQuery.length === 0) {
    const endpointPathRaw =
      typeof listing.quoteContext?.endpoint_path === "string"
        ? listing.quoteContext.endpoint_path.trim()
        : "";
    const endpointPath = endpointPathRaw.startsWith("/")
      ? endpointPathRaw
      : (config.defaultEndpointPath ?? DEFAULT_ENDPOINT_PATH);

    input.onListingComplete?.({
      listingId: listing.externalListingId,
      windows: 0,
      available: 0,
    });
    input.progress?.tick(
      `quotes listing=${listing.externalListingId} windows=0 available=0 skipped_reason=fresh_overlap`,
    );

    const sidecar: CanonicalQuotesSidecarRecord = {
      adapter_key: config.adapterKey,
      external_listing_id: listing.externalListingId,
      detail_url: listing.detailUrl,
      captured_at: new Date().toISOString(),
      currency: "USD",
      quote_window_cadence: "weekly_anchor_adaptive_span",
      quote_window_gap_policy: "probe_longest_available_span",
      quote_window_anchor_date: firstSaturdayOnOrAfter(
        new Date().toISOString().slice(0, 10),
      ),
      quote_window_days: options.weeks * 7,
      quote_sample_step_days: 1,
      quote_nights: options.nights,
      quote_max_queries: 0,
      endpoint_path: endpointPath,
      observations: [],
    };
    assertCanonicalQuotesSidecarRecord(sidecar);
    return sidecar;
  }

  const groupedWindowsByStartDate = new Map<string, QuoteWindow[]>();
  for (const window of windowsToQuery) {
    const existing = groupedWindowsByStartDate.get(window.startDate) ?? [];
    existing.push(window);
    groupedWindowsByStartDate.set(window.startDate, existing);
  }
  const startDatePlans = Array.from(groupedWindowsByStartDate.values()).map(
    (plan) =>
      [...plan].sort((left, right) => {
        const startCompare = left.startDate.localeCompare(right.startDate);
        if (startCompare !== 0) {
          return startCompare;
        }
        return right.nights - left.nights;
      }),
  );

  type RuntimeWindowResult = {
    window: QuoteWindow;
    result: QuoteExecutionResult;
    runtimeHandoffUrl: string | null;
    quoteAvailable: boolean;
  };

  const runtimeResultsNested = await runWithConcurrency(
    startDatePlans,
    options.quoteConcurrency,
    async (plan): Promise<RuntimeWindowResult[]> => {
      const planResults: RuntimeWindowResult[] = [];

      for (const window of plan) {
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
        const quoteAvailable = hasUsableAvailableTotals(result);
        if (quoteAvailable && !runtimeHandoffUrl) {
          throw new Error(
            `runtime adapter '${config.adapterKey}' did not provide handoffUrl for listing '${listing.externalListingId}' window ${window.startDate} -> ${window.endDate}`,
          );
        }

        input.onWindowResult?.({ quoteAvailable });
        planResults.push({
          window,
          result,
          runtimeHandoffUrl,
          quoteAvailable,
        });

        if (quoteAvailable) {
          break;
        }
      }

      return planResults;
    },
  );
  const runtimeResults = runtimeResultsNested.flat();

  const observations: CanonicalQuoteObservation[] = runtimeResults
    .filter((entry) => entry.quoteAvailable)
    .map((entry) => {
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
        nights: entry.window.nights,
        result: entry.result,
      });
    });

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
    quote_window_cadence: "weekly_anchor_adaptive_span",
    quote_window_gap_policy: "probe_longest_available_span",
    quote_window_anchor_date: firstSaturdayOnOrAfter(
      new Date().toISOString().slice(0, 10),
    ),
    quote_window_days: options.weeks * 7,
    quote_sample_step_days: 1,
    quote_nights: options.nights,
    quote_max_queries: runtimeResults.length,
    endpoint_path: endpointPath,
    observations,
  };

  assertCanonicalQuotesSidecarRecord(sidecar);
  input.onListingComplete?.({
    listingId: listing.externalListingId,
    windows: runtimeResults.length,
    available: observations.filter((obs) => obs.quote_available).length,
  });
  input.progress?.tick(
    `quotes listing=${listing.externalListingId} windows=${runtimeResults.length} available=${observations.filter((obs) => obs.quote_available).length}`,
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
  const retentionDaysFromEnv = Number(
    process.env.QUOTE_CAPTURE_OBSERVATION_RETENTION_DAYS ??
      String(DEFAULT_QUOTE_OBSERVATION_RETENTION_DAYS),
  );
  const observationRetentionDays =
    Number.isFinite(retentionDaysFromEnv) && retentionDaysFromEnv > 0
      ? Math.floor(retentionDaysFromEnv)
      : DEFAULT_QUOTE_OBSERVATION_RETENTION_DAYS;
  const minProbeNightsFromEnv = Number(
    process.env.QUOTE_CAPTURE_MIN_PROBE_NIGHTS ??
      String(DEFAULT_MIN_PROBE_NIGHTS),
  );
  const maxProbeNightsFromEnv = Number(
    process.env.QUOTE_CAPTURE_MAX_PROBE_NIGHTS ??
      String(DEFAULT_MAX_PROBE_NIGHTS),
  );
  const defaultMinProbeNights =
    Number.isFinite(minProbeNightsFromEnv) && minProbeNightsFromEnv > 0
      ? Math.floor(minProbeNightsFromEnv)
      : DEFAULT_MIN_PROBE_NIGHTS;
  const defaultMaxProbeNights =
    Number.isFinite(maxProbeNightsFromEnv) && maxProbeNightsFromEnv > 0
      ? Math.floor(maxProbeNightsFromEnv)
      : DEFAULT_MAX_PROBE_NIGHTS;

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
      `skip_covered_windows=${options.skipCoveredWindows}`,
      `min_overlap_nights=${options.minOverlapNights}`,
      `selection=${options.listingId ? `listing:${options.listingId}` : `max-listings:${options.maxListings}`}`,
      `min_probe_nights=${defaultMinProbeNights}`,
      `max_probe_nights=${defaultMaxProbeNights}`,
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
  const detailsJsonDir = resolve(
    process.cwd(),
    "src",
    "lib",
    "data",
    "external-sources",
    config.adapterKey,
    "details",
    "json",
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
        fileId: listing.fileId,
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

  const backfillStatuses: QuoteBackfillStatus[] = [];
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
        fileId: listing.fileId,
      });
      const quoteCapturedAt = await loadQuoteCapturedAt({
        quotesDir,
        fileId: listing.fileId,
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
    modeLabel: "quote",
    heartbeatMs: Math.max(
      1000,
      Number(process.env.QUOTE_CAPTURE_HEARTBEAT_MS ?? "15000") || 15000,
    ),
  });

  let skippedCoveredListings = 0;
  const sidecars = await runWithConcurrency(
    listingsToProcess,
    options.listingConcurrency,
    async (listing): Promise<CanonicalQuotesSidecarRecord | null> => {
      const outputPath = resolve(quotesDir, `${listing.fileId}.json`);
      const existingObservations = await loadExistingRealQuoteObservations({
        outputPath,
      });

      const sidecar = await buildSidecarForListing({
        config,
        listing,
        options,
        availabilityDays: await loadAvailabilityDays({
          detailsJsonDir,
          fileId: listing.fileId,
        }),
        defaultMinProbeNights,
        defaultMaxProbeNights,
        existingRealQuoteObservations: existingObservations,
        progress,
        onWindowsPlanned: (windows) => {
          tracker.onWindowsPlanned(windows);
        },
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

      if (sidecar.quote_max_queries === 0) {
        skippedCoveredListings += 1;
        return null;
      }

      const mergedObservations = mergeRealQuoteObservations({
        existing: existingObservations,
        latest: sidecar.observations,
        nowMs: Date.now(),
        retentionDays: observationRetentionDays,
      });

      const persistedSidecar: CanonicalQuotesSidecarRecord = {
        ...sidecar,
        observations: mergedObservations,
      };
      assertCanonicalQuotesSidecarRecord(persistedSidecar);
      await writeFile(
        outputPath,
        `${JSON.stringify(persistedSidecar, null, 2)}\n`,
        "utf8",
      );
      progress?.tick(
        `quote sidecar flushed listing=${sidecar.external_listing_id}`,
      );

      return persistedSidecar;
    },
  ).finally(() => {
    tracker.finish();
  });

  const persistedSidecars = sidecars.filter(
    (sidecar): sidecar is CanonicalQuotesSidecarRecord => sidecar !== null,
  );

  const totalObservations = persistedSidecars.reduce(
    (sum, sidecar) => sum + sidecar.observations.length,
    0,
  );
  const availableObservations = persistedSidecars.reduce(
    (sum, sidecar) =>
      sum +
      sidecar.observations.filter((observation) => observation.quote_available)
        .length,
    0,
  );

  progress?.success(
    `quote-capture complete listings=${persistedSidecars.length} observations=${totalObservations} available=${availableObservations} skipped_fresh=${skippedFresh} skipped_covered=${skippedCoveredListings}`,
  );
}
