import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  assertListingPricingCacheRecord,
  type ListingPricingCacheIndex,
  type ListingPricingCacheRecord,
  type ListingPricingDayRecord,
} from "@/lib/pricing/contracts/listing-pricing-cache-contract";
import { selectCanonicalListings } from "@/lib/pricing/shared/canonical-index-listings";

type AvailabilityDay = {
  date: string;
  is_available: boolean;
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

function readQuoteAnchorsByDate(
  observations: QuoteObservation[] | undefined,
): Map<string, number> {
  const totalsByDate = new Map<string, { total: number; count: number }>();
  for (const observation of observations ?? []) {
    if (!observation.quote_available) {
      continue;
    }

    const nightly = Number(observation.base_nightly);
    const nights = Number(observation.nights);
    if (!Number.isFinite(nightly) || nightly <= 0) {
      continue;
    }
    if (!Number.isFinite(nights) || nights <= 0) {
      continue;
    }

    const span = Math.max(1, Math.floor(nights));
    for (let offset = 0; offset < span; offset += 1) {
      const date = addDays(observation.check_in_date, offset);
      const existing = totalsByDate.get(date) ?? { total: 0, count: 0 };
      existing.total += nightly;
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
  let fromDate = toIsoDate(new Date());
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
      fromDate = toIsoDate(value);
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
  const globalDefaultBaseNightly = input.globalDefaultBaseNightly ?? 650;
  const assumptionsAnchorFallbackMultiplier =
    input.assumptionsAnchorFallbackMultiplier ?? 0.92;

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
    addDays(input.options.fromDate, index),
  );
  const toDate = dates[dates.length - 1] ?? input.options.fromDate;

  const indexRows: ListingPricingCacheIndex["listings"] = [];

  let listingCount = 0;
  let totalDays = 0;
  let totalBase = 0;
  let totalAllIn = 0;

  if (!input.options.dryRun) {
    await mkdir(pricingDir, { recursive: true });
  }

  for (const listing of selectedListings) {
    const detailPath = resolve(
      detailsJsonDir,
      `${listing.externalListingId}.json`,
    );
    let detail: DetailRecord;
    try {
      const raw = await readFile(detailPath, "utf8");
      detail = readJson<DetailRecord>(raw);
    } catch {
      // Active listing may not have a detail artifact yet; skip until scraped.
      continue;
    }

    let quoteAnchorsByDate = new Map<string, number>();
    try {
      const quotePath = resolve(
        quotesDir,
        `${detail.external_listing_id}.json`,
      );
      const quoteRaw = await readFile(quotePath, "utf8");
      const quoteSidecar = readJson<QuoteSidecarRecord>(quoteRaw);
      quoteAnchorsByDate = readQuoteAnchorsByDate(quoteSidecar.observations);
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

      return {
        date,
        is_available: isAvailable,
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
        from_date: input.options.fromDate,
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

    const avgBaseNightly = roundCurrency(
      days.reduce((sum, day) => sum + day.base_nightly, 0) / days.length,
    );
    const avgAllInNightly = roundCurrency(
      days.reduce((sum, day) => sum + day.all_in_nightly, 0) / days.length,
    );

    const cachePath = resolve(pricingDir, `${detail.external_listing_id}.json`);
    const cachePathRelative = `details/pricing/${detail.external_listing_id}.json`;

    if (!input.options.dryRun) {
      await writeFile(
        cachePath,
        `${JSON.stringify(listingCache, null, 2)}\n`,
        "utf8",
      );
    }

    indexRows.push({
      external_listing_id: detail.external_listing_id,
      detail_url: detail.detail_url,
      cache_path: cachePathRelative,
      days: days.length,
      avg_base_nightly: avgBaseNightly,
      avg_all_in_nightly: avgAllInNightly,
      generated_at: listingCache.generated_at,
    });

    listingCount += 1;
    totalDays += days.length;
    totalBase += days.reduce((sum, day) => sum + day.base_nightly, 0);
    totalAllIn += days.reduce((sum, day) => sum + day.all_in_nightly, 0);
  }

  const indexPayload: ListingPricingCacheIndex = {
    adapter_key: input.adapterKey,
    generated_at: new Date().toISOString(),
    weeks: input.options.weeks,
    from_date: input.options.fromDate,
    to_date: toDate,
    listing_count: listingCount,
    avg_base_nightly:
      listingCount > 0 ? roundCurrency(totalBase / totalDays) : null,
    avg_all_in_nightly:
      listingCount > 0 ? roundCurrency(totalAllIn / totalDays) : null,
    listings: indexRows,
  };

  if (!input.options.dryRun) {
    await writeFile(
      resolve(pricingDir, "index.json"),
      `${JSON.stringify(indexPayload, null, 2)}\n`,
      "utf8",
    );
  }

  return {
    adapterKey: input.adapterKey,
    weeks: input.options.weeks,
    fromDate: input.options.fromDate,
    toDate,
    listingCount,
    dryRun: input.options.dryRun,
    avgBaseNightly: indexPayload.avg_base_nightly,
    avgAllInNightly: indexPayload.avg_all_in_nightly,
  };
}
