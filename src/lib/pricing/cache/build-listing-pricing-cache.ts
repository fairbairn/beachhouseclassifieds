import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  assertListingPricingCacheRecord,
  type ListingPricingCacheRecord,
  type ListingPricingDayRecord,
} from "@/lib/pricing/contracts/listing-pricing-cache-contract";
import { selectCanonicalListings } from "@/lib/pricing/shared/canonical-index-listings";

type AvailabilityDay = {
  date: string;
  status_code?: "A" | "U" | "I" | "O" | "X";
  is_available: boolean;
  is_available_for_checkin?: boolean;
  is_available_for_checkout?: boolean;
  min_nights_required?: number | null;
};

type RateDay = {
  date: string;
  nightly_rate: number | null;
  min_nights: number | null;
  is_booked: boolean | null;
};

type DetailRecord = {
  external_listing_id: string;
  detail_url: string;
  normalized_availability?: {
    days?: AvailabilityDay[];
  };
  normalized_rates?: {
    currency?: string;
    days?: RateDay[];
  };
};

type QuoteObservation = {
  start_date?: string;
  check_out_date?: string;
  base_total?: number | null;
  grand_total?: number | null;
  quoted_total?: number | null;
  check_in_date: string;
  nights: number;
  base_nightly: number | null;
  quote_available: boolean;
};

type QuoteSidecarRecord = {
  observations?: QuoteObservation[];
};

type QuoteObservationSupport = {
  hasAny: boolean;
  months: Set<string>;
  sortedEpochDays: number[];
};

type SeededValue = {
  baseNightly: number | null;
  valueOrigin: "quote_anchor" | "scraped_rate" | null;
  quoteAnchorScope: "same_month" | "surrounding_months" | "none";
  nearestQuoteObservationDistanceDays: number | null;
};

type PricingAssumptionsStore = {
  assumptions?: {
    avg_fee_pct_of_base?: number;
    avg_tax_pct_of_base?: number;
    avg_all_in_multiplier?: number;
  };
  samples?: Array<{
    base_total?: number;
    nights?: number;
  }>;
};

const DEFAULT_QUOTE_ANCHOR_TARGET_NIGHTS = 7;
const MIN_NEAREST_DURATION_RATIO = 0.75;
const MAX_NEAREST_DURATION_RATIO = 1.35;

export type PricingCacheCliOptions = {
  weeks: number;
  fromDate: string;
  listingId: string | null;
  maxListings: number | null;
  dryRun: boolean;
};

export type BuildListingPricingCacheInput = {
  adapterKey: string;
  options: PricingCacheCliOptions;
  defaultAssumptions: {
    avgFeePct: number;
    avgTaxPct: number;
    avgAllInMultiplier?: number;
  };
  globalDefaultBaseNightly?: number;
  assumptionsAnchorFallbackMultiplier?: number;
  rootDir?: string;
};

export type BuildListingPricingCacheResult = {
  adapterKey: string;
  weeks: number;
  fromDate: string;
  toDate: string;
  listingCount: number;
  dryRun: boolean;
  avgBaseNightly: number | null;
  avgAllInNightly: number | null;
};

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

function isComparableStayLength(
  observedNights: number,
  targetNights: number,
): boolean {
  if (observedNights <= 0 || targetNights <= 0) {
    return false;
  }

  const ratio = observedNights / targetNights;
  return (
    ratio >= MIN_NEAREST_DURATION_RATIO && ratio <= MAX_NEAREST_DURATION_RATIO
  );
}

function toIsoDate(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }
  return date.toISOString().slice(0, 10);
}

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function toMonthKey(isoDate: string): string {
  return isoDate.slice(0, 7);
}

function toEpochDay(isoDate: string): number {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  return Math.floor(date.getTime() / 86_400_000);
}

function dayOfWeek(isoDate: string): number {
  return new Date(`${isoDate}T00:00:00.000Z`).getUTCDay();
}

function firstSaturdayOnOrAfter(isoDate: string): string {
  const day = dayOfWeek(isoDate);
  const delta = (6 - day + 7) % 7;
  return addDays(isoDate, delta);
}

function readJson<T>(raw: string): T {
  return JSON.parse(raw) as T;
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

function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return roundCurrency((sorted[mid - 1]! + sorted[mid]!) / 2);
  }
  return roundCurrency(sorted[mid]!);
}

function mean(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return roundCurrency(
    values.reduce((sum, value) => sum + value, 0) / values.length,
  );
}

function nearestDistanceFromSortedDays(
  sortedDays: number[],
  targetDay: number,
): number | null {
  if (sortedDays.length === 0) {
    return null;
  }

  let low = 0;
  let high = sortedDays.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const value = sortedDays[mid]!;
    if (value === targetDay) {
      return 0;
    }
    if (value < targetDay) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  const left = high >= 0 ? sortedDays[high] : null;
  const right = low < sortedDays.length ? sortedDays[low] : null;
  const leftDistance =
    left === null ? Number.POSITIVE_INFINITY : targetDay - left;
  const rightDistance =
    right === null ? Number.POSITIVE_INFINITY : right - targetDay;
  const nearest = Math.min(leftDistance, rightDistance);
  return Number.isFinite(nearest) ? nearest : null;
}

function buildQuoteObservationSupport(
  observations: QuoteObservation[] | undefined,
): QuoteObservationSupport {
  const available = (observations ?? []).filter(
    (observation) => observation.quote_available,
  );
  const months = new Set<string>();
  const daySet = new Set<number>();

  for (const observation of available) {
    const checkInDate = observation.check_in_date || observation.start_date;
    if (!checkInDate) {
      continue;
    }

    const nights = Math.max(1, Math.floor(observation.nights));
    for (let offset = 0; offset < nights; offset += 1) {
      const stayDate = addDays(checkInDate, offset);
      months.add(toMonthKey(stayDate));
      daySet.add(toEpochDay(stayDate));
    }
  }

  return {
    hasAny: daySet.size > 0,
    months,
    sortedEpochDays: [...daySet].sort((left, right) => left - right),
  };
}

function deriveMonthlyQualityBand(input: {
  dayCount: number;
  contrivedDays: number;
  quoteAnchorSameMonthDays: number;
  quoteAnchorSurroundingMonthDays: number;
  interpolatedDays: number;
  scrapedRateDays: number;
}): "high" | "medium" | "low" {
  const {
    dayCount,
    contrivedDays,
    quoteAnchorSameMonthDays,
    quoteAnchorSurroundingMonthDays,
    interpolatedDays,
    scrapedRateDays,
  } = input;

  if (dayCount <= 0) {
    return "low";
  }

  if (
    quoteAnchorSameMonthDays > 0 ||
    scrapedRateDays >= Math.ceil(dayCount / 2)
  ) {
    return "high";
  }

  if (quoteAnchorSurroundingMonthDays > 0 || interpolatedDays > 0) {
    return "medium";
  }

  if (contrivedDays > 0) {
    return "low";
  }

  return "low";
}

function toValidPositiveNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return value;
}

function fitLinearRegression(input: Array<{ x: number; y: number }>): {
  slope: number;
  intercept: number;
} | null {
  if (input.length < 2) {
    return null;
  }

  const n = input.length;
  const sx = input.reduce((sum, point) => sum + point.x, 0);
  const sy = input.reduce((sum, point) => sum + point.y, 0);
  const sxx = input.reduce((sum, point) => sum + point.x * point.x, 0);
  const sxy = input.reduce((sum, point) => sum + point.x * point.y, 0);
  const denominator = n * sxx - sx * sx;
  if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-9) {
    return null;
  }

  const slope = (n * sxy - sx * sy) / denominator;
  const intercept = (sy - slope * sx) / n;

  if (!Number.isFinite(slope) || !Number.isFinite(intercept)) {
    return null;
  }

  return { slope, intercept };
}

function deriveDayOfWeekWeights(observations: QuoteObservation[]): number[] {
  const stats = Array.from({ length: 7 }, () => ({ total: 0, count: 0 }));

  for (const observation of observations) {
    const nights = Math.max(1, Math.floor(observation.nights));
    const nightly =
      toValidPositiveNumber(observation.base_nightly) ??
      (() => {
        const baseTotal = toValidPositiveNumber(observation.base_total);
        if (baseTotal === null || nights <= 0) {
          return null;
        }
        return baseTotal / nights;
      })();

    if (nightly === null || !Number.isFinite(nightly) || nightly <= 0) {
      continue;
    }

    for (let offset = 0; offset < nights; offset += 1) {
      const stayDate = addDays(observation.check_in_date, offset);
      const dow = dayOfWeek(stayDate);
      const bucket = stats[dow]!;
      bucket.total += nightly;
      bucket.count += 1;
    }
  }

  const allNightlyMeans = stats
    .filter((bucket) => bucket.count > 0)
    .map((bucket) => bucket.total / bucket.count);

  const globalMean = mean(allNightlyMeans) ?? 1;
  if (!Number.isFinite(globalMean) || globalMean <= 0) {
    return Array.from({ length: 7 }, () => 1);
  }

  return stats.map((bucket) => {
    if (bucket.count <= 0) {
      return 1;
    }
    const ratio = bucket.total / bucket.count / globalMean;
    const clamped = Math.min(1.35, Math.max(0.75, ratio));
    return Number.isFinite(clamped) && clamped > 0 ? clamped : 1;
  });
}

function distributeTotalAcrossDays(input: {
  total: number;
  startDate: string;
  nights: number;
  dayOfWeekWeights: number[];
}): number[] {
  const factors = Array.from({ length: input.nights }, (_, offset) => {
    const date = addDays(input.startDate, offset);
    const dow = dayOfWeek(date);
    const weight = input.dayOfWeekWeights[dow] ?? 1;
    return Number.isFinite(weight) && weight > 0 ? weight : 1;
  });

  const sumFactors = factors.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(sumFactors) || sumFactors <= 0) {
    const flatNightly = roundCurrency(input.total / input.nights);
    return Array.from({ length: input.nights }, () => flatNightly);
  }

  const allocated = factors.map((factor) =>
    roundCurrency((input.total * factor) / sumFactors),
  );

  const allocatedTotal = roundCurrency(
    allocated.reduce((sum, value) => sum + value, 0),
  );
  const delta = roundCurrency(input.total - allocatedTotal);
  if (allocated.length > 0 && Math.abs(delta) > 0) {
    allocated[allocated.length - 1] = roundCurrency(
      allocated[allocated.length - 1]! + delta,
    );
  }

  return allocated;
}

type QuoteChargeModel = {
  sampleCount: number;
  variablePctOfBase: number;
  fixedFeeTotal: number;
};

function deriveQuoteChargeModel(
  observations: QuoteObservation[] | undefined,
): QuoteChargeModel | null {
  const rows = (observations ?? [])
    .filter((observation) => observation.quote_available)
    .map((observation) => {
      const baseTotal = toValidPositiveNumber(observation.base_total);
      const grandTotal =
        toValidPositiveNumber(observation.quoted_total) ??
        toValidPositiveNumber(observation.grand_total);
      if (baseTotal === null || grandTotal === null || grandTotal < baseTotal) {
        return null;
      }
      return { baseTotal, grandTotal };
    })
    .filter(
      (
        row,
      ): row is {
        baseTotal: number;
        grandTotal: number;
      } => row !== null,
    );

  if (rows.length < 2) {
    return null;
  }

  const fit = fitLinearRegression(
    rows.map((row) => ({ x: row.baseTotal, y: row.grandTotal })),
  );

  if (fit) {
    const slope = Number.isFinite(fit.slope) ? fit.slope : 1;
    const intercept = Number.isFinite(fit.intercept) ? fit.intercept : 0;
    const variablePctOfBase = Math.max(0, slope - 1);
    const fixedFeeTotal = Math.max(0, intercept);
    return {
      sampleCount: rows.length,
      variablePctOfBase,
      fixedFeeTotal,
    };
  }

  const variablePcts = rows
    .map((row) => {
      if (row.baseTotal <= 0) {
        return null;
      }
      return Math.max(0, (row.grandTotal - row.baseTotal) / row.baseTotal);
    })
    .filter(
      (value): value is number => value !== null && Number.isFinite(value),
    );

  const variablePctOfBase = median(variablePcts);
  if (variablePctOfBase === null) {
    return null;
  }

  return {
    sampleCount: rows.length,
    variablePctOfBase: Math.max(0, variablePctOfBase),
    fixedFeeTotal: 0,
  };
}

function readQuoteAnchorsByDate(
  observations: QuoteObservation[] | undefined,
  targetNights: number,
): Map<string, number> {
  const availableObservations = (observations ?? []).filter(
    (observation) => observation.quote_available,
  );
  const dayOfWeekWeights = deriveDayOfWeekWeights(availableObservations);

  const totalsByDate = new Map<string, { total: number; count: number }>();
  for (const observation of availableObservations) {
    const nights = Math.max(1, Math.floor(observation.nights));
    const nightly =
      toValidPositiveNumber(observation.base_nightly) ??
      (() => {
        const baseTotal = toValidPositiveNumber(observation.base_total);
        if (baseTotal === null || nights <= 0) {
          return null;
        }
        return baseTotal / nights;
      })();

    if (nightly === null || !Number.isFinite(nightly) || nightly <= 0) {
      continue;
    }

    const span = nights;
    for (let offset = 0; offset < span; offset += 1) {
      const date = addDays(observation.check_in_date, offset);
      const existing = totalsByDate.get(date) ?? { total: 0, count: 0 };
      existing.total += nightly;
      existing.count += 1;
      totalsByDate.set(date, existing);
    }
  }

  // Build same-checkout stay-length ladders and project target-night anchors.
  const byCheckoutDate = new Map<
    string,
    Array<{
      checkOutDate: string;
      nights: number;
      baseTotal: number;
    }>
  >();

  for (const observation of availableObservations) {
    const checkInDate = observation.check_in_date || observation.start_date;
    if (!checkInDate) {
      continue;
    }

    const nights = Math.max(1, Math.floor(observation.nights));
    const checkOutDate =
      observation.check_out_date ?? addDays(checkInDate, nights);
    const baseTotal =
      toValidPositiveNumber(observation.base_total) ??
      (() => {
        const baseNightly = toValidPositiveNumber(observation.base_nightly);
        if (baseNightly === null) {
          return null;
        }
        return baseNightly * nights;
      })();

    if (baseTotal === null || !Number.isFinite(baseTotal) || baseTotal <= 0) {
      continue;
    }

    const bucket = byCheckoutDate.get(checkOutDate) ?? [];
    bucket.push({
      checkOutDate,
      nights,
      baseTotal,
    });
    byCheckoutDate.set(checkOutDate, bucket);
  }

  for (const [, bucket] of byCheckoutDate.entries()) {
    if (bucket.length === 0) {
      continue;
    }

    const byNights = new Map<number, number[]>();
    for (const item of bucket) {
      const current = byNights.get(item.nights) ?? [];
      current.push(item.baseTotal);
      byNights.set(item.nights, current);
    }

    const points = Array.from(byNights.entries())
      .map(([nights, totals]) => {
        const averageTotal = mean(totals);
        if (averageTotal === null) {
          return null;
        }
        return { nights, averageTotal };
      })
      .filter(
        (point): point is { nights: number; averageTotal: number } =>
          point !== null,
      )
      .sort((left, right) => left.nights - right.nights);

    if (points.length === 0) {
      continue;
    }

    let projectedTotal: number | null = null;
    const exact = points.find((point) => point.nights === targetNights);
    if (exact) {
      projectedTotal = exact.averageTotal;
    } else if (points.length >= 2) {
      const fit = fitLinearRegression(
        points.map((point) => ({ x: point.nights, y: point.averageTotal })),
      );
      if (fit) {
        const predicted = fit.intercept + fit.slope * targetNights;
        if (Number.isFinite(predicted) && predicted > 0) {
          projectedTotal = predicted;
        }
      }
    }

    if (projectedTotal === null) {
      const nearest = [...points].sort(
        (left, right) =>
          Math.abs(left.nights - targetNights) -
          Math.abs(right.nights - targetNights),
      )[0];
      if (
        nearest &&
        nearest.nights > 0 &&
        isComparableStayLength(nearest.nights, targetNights)
      ) {
        projectedTotal = nearest.averageTotal * (targetNights / nearest.nights);
      }
    }

    if (projectedTotal === null || projectedTotal <= 0) {
      continue;
    }

    const anchorCheckOutDate = bucket[0]!.checkOutDate;
    const projectedStartDate = addDays(anchorCheckOutDate, -targetNights);
    const projectedNightlies = distributeTotalAcrossDays({
      total: projectedTotal,
      startDate: projectedStartDate,
      nights: targetNights,
      dayOfWeekWeights,
    });
    for (let offset = 0; offset < targetNights; offset += 1) {
      const date = addDays(projectedStartDate, offset);
      const existing = totalsByDate.get(date) ?? { total: 0, count: 0 };
      existing.total += projectedNightlies[offset] ?? 0;
      existing.count += 1;
      totalsByDate.set(date, existing);
    }
  }

  const anchors = new Map<string, number>();
  for (const [date, stats] of totalsByDate.entries()) {
    if (stats.count <= 0) {
      continue;
    }
    anchors.set(date, roundCurrency(stats.total / stats.count));
  }

  return anchors;
}

export function parsePricingCacheCliArgs(
  argv: string[],
  defaultWeeks: number,
): PricingCacheCliOptions {
  let weeks = defaultWeeks;
  const tomorrow = addDays(toIsoDate(new Date()), 1);
  let fromDate = firstSaturdayOnOrAfter(tomorrow);
  let listingId: string | null = null;
  let maxListings: number | null = null;
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    if (arg === "--weeks" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0 && parsed <= 52) {
        weeks = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--from-date" && value) {
      fromDate = firstSaturdayOnOrAfter(toIsoDate(value));
      index += 1;
      continue;
    }

    if (arg === "--listing-id" && value) {
      listingId = value.trim();
      index += 1;
      continue;
    }

    if (arg === "--max-listings" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        maxListings = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--dry-run") {
      dryRun = true;
    }
  }

  return { weeks, fromDate, listingId, maxListings, dryRun };
}

export async function buildListingPricingCacheForAdapter(
  input: BuildListingPricingCacheInput,
): Promise<BuildListingPricingCacheResult> {
  const root = input.rootDir ?? process.cwd();
  const fromDate = firstSaturdayOnOrAfter(input.options.fromDate);
  const globalDefaultBaseNightly = input.globalDefaultBaseNightly ?? 650;
  const assumptionsAnchorFallbackMultiplier =
    input.assumptionsAnchorFallbackMultiplier ?? 0.92;
  const quoteAnchorTargetNights = Math.max(
    1,
    Number(
      process.env.PRICING_CACHE_QUOTE_ANCHOR_TARGET_NIGHTS ??
        DEFAULT_QUOTE_ANCHOR_TARGET_NIGHTS,
    ) || DEFAULT_QUOTE_ANCHOR_TARGET_NIGHTS,
  );
  const minQuoteChargeModelSamples = Math.max(
    2,
    Number(process.env.PRICING_CACHE_MIN_QUOTE_MODEL_SAMPLES ?? 4) || 4,
  );

  const adapterRoot = resolve(
    root,
    "src",
    "lib",
    "data",
    "external-sources",
    input.adapterKey,
  );
  const detailsJsonDir = resolve(adapterRoot, "details", "json");
  const pricingDir = resolve(adapterRoot, "details", "pricing");
  const quotesDir = resolve(adapterRoot, "details", "quotes");
  const assumptionsPath = resolve(adapterRoot, "pricing-assumptions.json");

  let assumptionsStore: PricingAssumptionsStore = {};
  try {
    const assumptionsRaw = await readFile(assumptionsPath, "utf8");
    assumptionsStore = readJson<PricingAssumptionsStore>(assumptionsRaw);
  } catch {
    // Some adapters only have detail + quote sidecars. Fall back to defaults.
    assumptionsStore = {};
  }

  const avgFeePct = Number(
    assumptionsStore.assumptions?.avg_fee_pct_of_base ??
      input.defaultAssumptions.avgFeePct,
  );
  const avgTaxPct = Number(
    assumptionsStore.assumptions?.avg_tax_pct_of_base ??
      input.defaultAssumptions.avgTaxPct,
  );
  const avgAllInMultiplier = Number(
    assumptionsStore.assumptions?.avg_all_in_multiplier ??
      input.defaultAssumptions.avgAllInMultiplier ??
      1 + avgFeePct + avgTaxPct,
  );

  const sampleAnchors = (assumptionsStore.samples ?? [])
    .map((sample) => {
      const baseTotal = Number(sample.base_total);
      const nights = Number(sample.nights);
      if (
        !Number.isFinite(baseTotal) ||
        !Number.isFinite(nights) ||
        nights <= 0
      ) {
        return null;
      }
      return baseTotal / nights;
    })
    .filter((value): value is number => value !== null && value > 0);
  const assumptionsAnchorBase =
    median(sampleAnchors) ??
    roundCurrency(
      globalDefaultBaseNightly * assumptionsAnchorFallbackMultiplier,
    );

  const selectedListings = await selectCanonicalListings({
    adapterKey: input.adapterKey,
    listingId: input.options.listingId,
    maxListings: input.options.maxListings,
    rootDir: root,
  });

  const horizonDays = input.options.weeks * 7;
  const dates = Array.from({ length: horizonDays }, (_, index) =>
    addDays(fromDate, index),
  );
  const toDate = dates[dates.length - 1] ?? fromDate;

  let listingCount = 0;
  let totalDays = 0;
  let totalBase = 0;
  let totalAllIn = 0;

  if (!input.options.dryRun) {
    await mkdir(pricingDir, { recursive: true });
  }

  for (const listing of selectedListings) {
    const detailPathCandidates = [
      resolve(detailsJsonDir, `${listing.fileId}.json`),
      resolve(detailsJsonDir, `${listing.detailFileBaseName}.json`),
      resolve(detailsJsonDir, `${listing.externalListingId}.json`),
    ];
    let detail: DetailRecord | null = null;
    for (const detailPath of detailPathCandidates) {
      try {
        const raw = await readFile(detailPath, "utf8");
        detail = readJson<DetailRecord>(raw);
        break;
      } catch {
        // Try next candidate.
      }
    }
    if (!detail) {
      // Active listing may not have a detail artifact yet; skip until scraped.
      continue;
    }

    let quoteAnchorsByDate = new Map<string, number>();
    let quoteObservations: QuoteObservation[] = [];
    let quoteChargeModel: QuoteChargeModel | null = null;
    try {
      const quotePath = resolve(quotesDir, `${listing.fileId}.json`);
      const quoteRaw = await readFile(quotePath, "utf8");
      const quoteSidecar = readJson<QuoteSidecarRecord>(quoteRaw);
      quoteObservations = quoteSidecar.observations ?? [];
      quoteAnchorsByDate = readQuoteAnchorsByDate(
        quoteObservations,
        quoteAnchorTargetNights,
      );
      quoteChargeModel = deriveQuoteChargeModel(quoteObservations);
    } catch {
      // Quote sidecars are optional in bootstrap phases.
    }

    const quoteObservationSupport =
      buildQuoteObservationSupport(quoteObservations);

    const availabilityMap = new Map(
      (detail.normalized_availability?.days ?? []).map((day) => [
        day.date,
        day,
      ]),
    );
    const rateMap = new Map(
      (detail.normalized_rates?.days ?? []).map((day) => [day.date, day]),
    );

    const seededValues: SeededValue[] = dates.map((date) => {
      const availability = availabilityMap.get(date);
      const rateDay = rateMap.get(date);
      const monthHasQuoteObservations = quoteObservationSupport.months.has(
        toMonthKey(date),
      );

      const quoteAnchor = quoteAnchorsByDate.get(date);
      if (
        typeof quoteAnchor === "number" &&
        Number.isFinite(quoteAnchor) &&
        quoteAnchor > 0
      ) {
        return {
          baseNightly: roundCurrency(quoteAnchor),
          valueOrigin: "quote_anchor",
          quoteAnchorScope: monthHasQuoteObservations
            ? "same_month"
            : quoteObservationSupport.hasAny
              ? "surrounding_months"
              : "none",
          nearestQuoteObservationDistanceDays: nearestDistanceFromSortedDays(
            quoteObservationSupport.sortedEpochDays,
            toEpochDay(date),
          ),
        };
      }

      const nightly = Number(rateDay?.nightly_rate);
      if (
        availability?.is_available &&
        Number.isFinite(nightly) &&
        nightly > 0
      ) {
        return {
          baseNightly: nightly,
          valueOrigin: "scraped_rate",
          quoteAnchorScope: "none",
          nearestQuoteObservationDistanceDays: null,
        };
      }
      return {
        baseNightly: null,
        valueOrigin: null,
        quoteAnchorScope: "none",
        nearestQuoteObservationDistanceDays: null,
      };
    });

    const seededNightlyValues = seededValues.map(
      (seeded) => seeded.baseNightly,
    );

    const listingAnchors = seededValues.filter(
      (value): value is SeededValue =>
        value.baseNightly !== null && value.baseNightly > 0,
    );
    const listingAnchorBase =
      median(listingAnchors.map((value) => value.baseNightly!)) ??
      assumptionsAnchorBase;

    const days: ListingPricingDayRecord[] = dates.map((date, index) => {
      const availability = availabilityMap.get(date);
      const rateDay = rateMap.get(date);
      const seeded = seededValues[index];

      let baseNightly: number;
      let source: ListingPricingDayRecord["source"];
      let confidence: ListingPricingDayRecord["confidence"];

      if (seeded && seeded.baseNightly !== null) {
        baseNightly = seeded.baseNightly;
        source = "accurate_scrape";
        confidence = "high";
      } else {
        const interpolated = interpolateValue(seededNightlyValues, index);
        if (interpolated !== null) {
          baseNightly = interpolated;
          source = "derived_interpolated";
          confidence = "medium";
        } else if (
          Number.isFinite(listingAnchorBase) &&
          listingAnchorBase > 0
        ) {
          baseNightly = listingAnchorBase;
          source = "derived_assumptions_anchor";
          confidence = "low";
        } else {
          baseNightly = globalDefaultBaseNightly;
          source = "derived_global_default";
          confidence = "low";
        }
      }

      const useQuoteChargeModel =
        quoteChargeModel !== null &&
        quoteChargeModel.sampleCount >= minQuoteChargeModelSamples;

      const estimatedFeesNightly = useQuoteChargeModel
        ? roundCurrency(
            quoteChargeModel.fixedFeeTotal / quoteAnchorTargetNights,
          )
        : roundCurrency(baseNightly * avgFeePct);
      const estimatedTaxesNightly = useQuoteChargeModel
        ? roundCurrency(baseNightly * quoteChargeModel.variablePctOfBase)
        : roundCurrency(baseNightly * avgTaxPct);
      const allInNightly = useQuoteChargeModel
        ? roundCurrency(
            baseNightly + estimatedFeesNightly + estimatedTaxesNightly,
          )
        : roundCurrency(baseNightly * avgAllInMultiplier);

      const isAvailable =
        typeof availability?.is_available === "boolean"
          ? availability.is_available
          : rateDay?.is_booked === null
            ? true
            : rateDay?.is_booked === false;

      const normalizedStatusCode =
        availability?.status_code === "A" ||
        availability?.status_code === "U" ||
        availability?.status_code === "I" ||
        availability?.status_code === "O" ||
        availability?.status_code === "X"
          ? availability.status_code
          : undefined;

      const observedCheckInAllowed =
        typeof availability?.is_available_for_checkin === "boolean"
          ? availability.is_available_for_checkin
          : undefined;

      const observedCheckOutAllowed =
        typeof availability?.is_available_for_checkout === "boolean"
          ? availability.is_available_for_checkout
          : undefined;

      const isCheckInAllowed =
        observedCheckInAllowed ??
        (normalizedStatusCode === "A" || normalizedStatusCode === "I"
          ? true
          : normalizedStatusCode === "U" || normalizedStatusCode === "O"
            ? false
            : undefined);

      const isCheckOutAllowed =
        observedCheckOutAllowed ??
        (normalizedStatusCode === "A" || normalizedStatusCode === "O"
          ? true
          : normalizedStatusCode === "U" || normalizedStatusCode === "I"
            ? false
            : undefined);

      const inferredStatusCode =
        normalizedStatusCode ??
        (typeof observedCheckInAllowed === "boolean" &&
        typeof observedCheckOutAllowed === "boolean"
          ? observedCheckInAllowed && observedCheckOutAllowed
            ? "A"
            : observedCheckInAllowed
              ? "I"
              : observedCheckOutAllowed
                ? "O"
                : "U"
          : undefined);

      const provenance = (() => {
        if (seeded?.valueOrigin === "quote_anchor") {
          return {
            value_origin: "quote_anchor" as const,
            quote_anchor_scope: seeded.quoteAnchorScope,
            has_any_quote_observations: quoteObservationSupport.hasAny,
            nearest_quote_observation_distance_days:
              seeded.nearestQuoteObservationDistanceDays,
          };
        }

        if (seeded?.valueOrigin === "scraped_rate") {
          return {
            value_origin: "scraped_rate" as const,
            quote_anchor_scope: "none" as const,
            has_any_quote_observations: quoteObservationSupport.hasAny,
            nearest_quote_observation_distance_days: null,
          };
        }

        if (source === "derived_interpolated") {
          return {
            value_origin: "interpolated" as const,
            quote_anchor_scope: "none" as const,
            has_any_quote_observations: quoteObservationSupport.hasAny,
            nearest_quote_observation_distance_days: null,
          };
        }

        if (source === "derived_assumptions_anchor") {
          return {
            value_origin: "assumptions_anchor" as const,
            quote_anchor_scope: "none" as const,
            has_any_quote_observations: quoteObservationSupport.hasAny,
            nearest_quote_observation_distance_days: null,
          };
        }

        return {
          value_origin: "global_default" as const,
          quote_anchor_scope: "none" as const,
          has_any_quote_observations: quoteObservationSupport.hasAny,
          nearest_quote_observation_distance_days: null,
        };
      })();

      return {
        date,
        is_available: isAvailable,
        availability_status_code: inferredStatusCode,
        is_available_for_checkin: isCheckInAllowed,
        is_available_for_checkout: isCheckOutAllowed,
        min_nights:
          rateDay?.min_nights ??
          (typeof availability?.min_nights_required === "number"
            ? availability.min_nights_required
            : null),
        base_nightly: roundCurrency(baseNightly),
        estimated_fees_nightly: estimatedFeesNightly,
        estimated_taxes_nightly: estimatedTaxesNightly,
        all_in_nightly: allInNightly,
        currency: detail.normalized_rates?.currency ?? "USD",
        source,
        confidence,
        provenance,
      };
    });

    const sourceSummary: ListingPricingCacheRecord["source_summary"] = {
      accurate_scrape_days: days.filter(
        (day) => day.source === "accurate_scrape",
      ).length,
      derived_interpolated_days: days.filter(
        (day) => day.source === "derived_interpolated",
      ).length,
      derived_assumptions_anchor_days: days.filter(
        (day) => day.source === "derived_assumptions_anchor",
      ).length,
      derived_global_default_days: days.filter(
        (day) => day.source === "derived_global_default",
      ).length,
    };

    const monthSummaryMap = new Map<
      string,
      {
        month: string;
        dayCount: number;
        contrivedDays: number;
        quoteAnchorSameMonthDays: number;
        quoteAnchorSurroundingMonthDays: number;
        interpolatedDays: number;
        scrapedRateDays: number;
      }
    >();

    for (const day of days) {
      const month = toMonthKey(day.date);
      const bucket = monthSummaryMap.get(month) ?? {
        month,
        dayCount: 0,
        contrivedDays: 0,
        quoteAnchorSameMonthDays: 0,
        quoteAnchorSurroundingMonthDays: 0,
        interpolatedDays: 0,
        scrapedRateDays: 0,
      };

      bucket.dayCount += 1;

      if (day.provenance?.value_origin === "quote_anchor") {
        if (day.provenance.quote_anchor_scope === "same_month") {
          bucket.quoteAnchorSameMonthDays += 1;
        } else if (day.provenance.quote_anchor_scope === "surrounding_months") {
          bucket.quoteAnchorSurroundingMonthDays += 1;
        }
      } else if (day.provenance?.value_origin === "scraped_rate") {
        bucket.scrapedRateDays += 1;
      } else if (day.provenance?.value_origin === "interpolated") {
        bucket.interpolatedDays += 1;
      } else if (
        day.provenance?.value_origin === "assumptions_anchor" ||
        day.provenance?.value_origin === "global_default"
      ) {
        bucket.contrivedDays += 1;
      }

      monthSummaryMap.set(month, bucket);
    }

    const monthlyQualitySummary = [...monthSummaryMap.values()]
      .sort((left, right) => left.month.localeCompare(right.month))
      .map((month) => ({
        month: month.month,
        day_count: month.dayCount,
        contrived_days: month.contrivedDays,
        quote_anchor_same_month_days: month.quoteAnchorSameMonthDays,
        quote_anchor_surrounding_month_days:
          month.quoteAnchorSurroundingMonthDays,
        interpolated_days: month.interpolatedDays,
        scraped_rate_days: month.scrapedRateDays,
        quality_band: deriveMonthlyQualityBand(month),
      }));

    const listingCache: ListingPricingCacheRecord = {
      adapter_key: input.adapterKey,
      external_listing_id: detail.external_listing_id,
      detail_url: detail.detail_url,
      generated_at: new Date().toISOString(),
      horizon: {
        from_date: fromDate,
        to_date: toDate,
        weeks: input.options.weeks,
      },
      assumptions_snapshot: {
        avg_fee_pct_of_base: avgFeePct,
        avg_tax_pct_of_base: avgTaxPct,
        avg_all_in_multiplier: avgAllInMultiplier,
      },
      quality_summary: {
        has_any_quote_observations: quoteObservationSupport.hasAny,
        quote_observation_months: [...quoteObservationSupport.months].sort(),
        monthly: monthlyQualitySummary,
      },
      source_summary: sourceSummary,
      days,
    };

    assertListingPricingCacheRecord(listingCache);

    const cachePath = resolve(pricingDir, `${listing.fileId}.json`);

    if (!input.options.dryRun) {
      await writeFile(
        cachePath,
        `${JSON.stringify(listingCache, null, 2)}\n`,
        "utf8",
      );
    }

    listingCount += 1;
    totalDays += days.length;
    totalBase += days.reduce((sum, day) => sum + day.base_nightly, 0);
    totalAllIn += days.reduce((sum, day) => sum + day.all_in_nightly, 0);
  }

  const avgBaseNightly =
    totalDays > 0 ? roundCurrency(totalBase / totalDays) : null;
  const avgAllInNightly =
    totalDays > 0 ? roundCurrency(totalAllIn / totalDays) : null;

  return {
    adapterKey: input.adapterKey,
    weeks: input.options.weeks,
    fromDate,
    toDate,
    listingCount,
    dryRun: input.options.dryRun,
    avgBaseNightly,
    avgAllInNightly,
  };
}
