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
  check_in_date: string;
  nights: number;
  base_nightly: number | null;
  quote_available: boolean;
};

type QuoteSidecarRecord = {
  observations?: QuoteObservation[];
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

function readQuoteAnchorsByDate(
  observations: QuoteObservation[] | undefined,
  targetNights: number,
): Map<string, number> {
  const availableObservations = (observations ?? []).filter(
    (observation) => observation.quote_available,
  );

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

    const projectedNightly = projectedTotal / targetNights;
    const anchorCheckOutDate = bucket[0]!.checkOutDate;
    const projectedStartDate = addDays(anchorCheckOutDate, -targetNights);
    for (let offset = 0; offset < targetNights; offset += 1) {
      const date = addDays(projectedStartDate, offset);
      const existing = totalsByDate.get(date) ?? { total: 0, count: 0 };
      existing.total += projectedNightly;
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
    try {
      const quotePath = resolve(quotesDir, `${listing.fileId}.json`);
      const quoteRaw = await readFile(quotePath, "utf8");
      const quoteSidecar = readJson<QuoteSidecarRecord>(quoteRaw);
      quoteAnchorsByDate = readQuoteAnchorsByDate(
        quoteSidecar.observations,
        quoteAnchorTargetNights,
      );
    } catch {
      // Quote sidecars are optional in bootstrap phases.
    }

    const availabilityMap = new Map(
      (detail.normalized_availability?.days ?? []).map((day) => [
        day.date,
        day,
      ]),
    );
    const rateMap = new Map(
      (detail.normalized_rates?.days ?? []).map((day) => [day.date, day]),
    );

    const seededValues: Array<number | null> = dates.map((date) => {
      const availability = availabilityMap.get(date);
      const rateDay = rateMap.get(date);

      const quoteAnchor = quoteAnchorsByDate.get(date);
      if (
        typeof quoteAnchor === "number" &&
        Number.isFinite(quoteAnchor) &&
        quoteAnchor > 0
      ) {
        return roundCurrency(quoteAnchor);
      }

      const nightly = Number(rateDay?.nightly_rate);
      if (
        availability?.is_available &&
        Number.isFinite(nightly) &&
        nightly > 0
      ) {
        return nightly;
      }
      return null;
    });

    const listingAnchors = seededValues.filter(
      (value): value is number => value !== null && value > 0,
    );
    const listingAnchorBase = median(listingAnchors) ?? assumptionsAnchorBase;

    const days: ListingPricingDayRecord[] = dates.map((date, index) => {
      const availability = availabilityMap.get(date);
      const rateDay = rateMap.get(date);
      const seeded = seededValues[index];

      let baseNightly: number;
      let source: ListingPricingDayRecord["source"];
      let confidence: ListingPricingDayRecord["confidence"];

      if (seeded !== null) {
        baseNightly = seeded;
        source = "accurate_scrape";
        confidence = "high";
      } else {
        const interpolated = interpolateValue(seededValues, index);
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

      const estimatedFeesNightly = roundCurrency(baseNightly * avgFeePct);
      const estimatedTaxesNightly = roundCurrency(baseNightly * avgTaxPct);
      const allInNightly = roundCurrency(baseNightly * avgAllInMultiplier);

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
