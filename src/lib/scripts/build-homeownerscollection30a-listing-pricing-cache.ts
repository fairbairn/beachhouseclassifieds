import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  assertListingPricingCacheRecord,
  type ListingPricingCacheIndex,
  type ListingPricingCacheRecord,
  type ListingPricingDayRecord,
} from "@/core/pricing/listing-pricing-cache";

type CliOptions = {
  weeks: number;
  fromDate: string;
  listingId: string | null;
  maxListings: number | null;
  dryRun: boolean;
};

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

type RateObservation = {
  start_date?: string;
  nights?: number;
  base_total?: number | null;
  taxes_total?: number | null;
  fees_total_excl_taxes?: number | null;
  fee_lines?: Array<{ name?: string; amount?: number }>;
};

type HomeownersDetailRecord = {
  external_listing_id: string;
  detail_url: string;
  normalized_availability?: {
    days?: AvailabilityDay[];
  };
  normalized_rates?: {
    currency?: string;
    days?: RateDay[];
  };
  rates_raw?: {
    observations_path?: string | null;
    observations?: RateObservation[];
  };
};

type HomeownersQuotesSidecar = {
  observations?: RateObservation[];
};

const ADAPTER_KEY = "homeownerscollection30a" as const;
const DEFAULT_WEEKS = 24;
const GLOBAL_DEFAULT_BASE_NIGHTLY = 650;
const GLOBAL_DEFAULT_FEE_PCT = 0.03;
const GLOBAL_DEFAULT_TAX_PCT = 0.12;

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
  let weeks = DEFAULT_WEEKS;
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

function readJson<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

async function loadObservationsForDetail(
  adapterRoot: string,
  detail: HomeownersDetailRecord,
): Promise<RateObservation[]> {
  const inline = detail.rates_raw?.observations ?? [];
  if (inline.length > 0) {
    return inline;
  }

  const sidecarPath =
    detail.rates_raw?.observations_path ??
    resolve(
      adapterRoot,
      "details",
      "quotes",
      `${detail.external_listing_id}.json`,
    );

  try {
    const raw = await readFile(sidecarPath, "utf8");
    const sidecar = readJson<HomeownersQuotesSidecar>(raw);
    return sidecar.observations ?? [];
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
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
  const pricingDir = resolve(adapterRoot, "details", "pricing");

  const entries = await readdir(detailsJsonDir, { withFileTypes: true });
  const detailFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();

  let selected = detailFiles;
  if (options.listingId) {
    const targetFile = `${options.listingId}.json`;
    selected = detailFiles.filter((fileName) => fileName === targetFile);
  }
  if (options.maxListings !== null) {
    selected = selected.slice(0, options.maxListings);
  }

  const horizonDays = options.weeks * 7;
  const dates = Array.from({ length: horizonDays }, (_, index) =>
    addDays(options.fromDate, index),
  );
  const toDate = dates[dates.length - 1] ?? options.fromDate;

  const indexRows: ListingPricingCacheIndex["listings"] = [];

  let listingCount = 0;
  let totalDays = 0;
  let totalBase = 0;
  let totalAllIn = 0;

  if (!options.dryRun) {
    await mkdir(pricingDir, { recursive: true });
  }

  for (const fileName of selected) {
    const detailPath = resolve(detailsJsonDir, fileName);
    const raw = await readFile(detailPath, "utf8");
    const detail = readJson<HomeownersDetailRecord>(raw);
    const observations = await loadObservationsForDetail(adapterRoot, detail);

    const availabilityMap = new Map(
      (detail.normalized_availability?.days ?? []).map((day) => [
        day.date,
        day,
      ]),
    );
    const rateMap = new Map(
      (detail.normalized_rates?.days ?? []).map((day) => [day.date, day]),
    );

    const validObservations = observations.filter((observation) => {
      const baseTotal = Number(observation.base_total);
      return Number.isFinite(baseTotal) && baseTotal > 0;
    });

    const feePcts = validObservations
      .map((observation) => {
        const baseTotal = Number(observation.base_total);
        const feesTotal = Number(observation.fees_total_excl_taxes ?? 0);
        if (
          !Number.isFinite(baseTotal) ||
          baseTotal <= 0 ||
          !Number.isFinite(feesTotal)
        ) {
          return null;
        }
        return feesTotal / baseTotal;
      })
      .filter((value): value is number => value !== null && value >= 0);

    const taxPcts = validObservations
      .map((observation) => {
        const baseTotal = Number(observation.base_total);
        const taxesTotal = Number(observation.taxes_total ?? 0);
        if (
          !Number.isFinite(baseTotal) ||
          baseTotal <= 0 ||
          !Number.isFinite(taxesTotal)
        ) {
          return null;
        }
        return taxesTotal / baseTotal;
      })
      .filter((value): value is number => value !== null && value >= 0);

    const avgFeePct = median(feePcts) ?? GLOBAL_DEFAULT_FEE_PCT;
    const avgTaxPct = median(taxPcts) ?? GLOBAL_DEFAULT_TAX_PCT;
    const avgAllInMultiplier = 1 + avgFeePct + avgTaxPct;

    const observationByStartDate = new Map(
      validObservations
        .map((observation) => {
          const startDate = String(observation.start_date ?? "");
          if (!startDate) {
            return null;
          }
          return [startDate, observation] as const;
        })
        .filter((entry): entry is readonly [string, RateObservation] =>
          Boolean(entry),
        ),
    );

    const seededValues: Array<number | null> = dates.map((date) => {
      const availability = availabilityMap.get(date);
      const rateDay = rateMap.get(date);
      const nightly = Number(rateDay?.nightly_rate);
      if (
        availability?.is_available &&
        Number.isFinite(nightly) &&
        nightly > 0
      ) {
        return roundCurrency(nightly);
      }
      return null;
    });

    const listingAnchors = seededValues.filter(
      (value): value is number => value !== null && value > 0,
    );
    const listingAnchorBase =
      median(listingAnchors) ?? roundCurrency(GLOBAL_DEFAULT_BASE_NIGHTLY);

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
        } else if (listingAnchorBase > 0) {
          baseNightly = listingAnchorBase;
          source = "derived_assumptions_anchor";
          confidence = "low";
        } else {
          baseNightly = GLOBAL_DEFAULT_BASE_NIGHTLY;
          source = "derived_global_default";
          confidence = "low";
        }
      }

      const observation = observationByStartDate.get(date);
      const nights = Number(observation?.nights ?? 0);
      const observationFees = Number(observation?.fees_total_excl_taxes ?? NaN);
      const observationTaxes = Number(observation?.taxes_total ?? NaN);

      const estimatedFeesNightly =
        Number.isFinite(observationFees) && nights > 0
          ? roundCurrency(observationFees / nights)
          : roundCurrency(baseNightly * avgFeePct);
      const estimatedTaxesNightly =
        Number.isFinite(observationTaxes) && nights > 0
          ? roundCurrency(observationTaxes / nights)
          : roundCurrency(baseNightly * avgTaxPct);
      const allInNightly = roundCurrency(
        baseNightly + estimatedFeesNightly + estimatedTaxesNightly,
      );

      const feeComponents =
        Array.isArray(observation?.fee_lines) && nights > 0
          ? observation.fee_lines
              .map((line) => {
                const name = String(line?.name ?? "").trim();
                const amount = Number(line?.amount);
                if (!name || !Number.isFinite(amount) || amount < 0) {
                  return null;
                }
                return {
                  name,
                  amount: roundCurrency(amount / nights),
                  kind: "fee" as const,
                  source: "quote_exact" as const,
                };
              })
              .filter((line): line is NonNullable<typeof line> => Boolean(line))
          : undefined;

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
        ...(feeComponents && feeComponents.length > 0
          ? { fee_components: feeComponents }
          : {}),
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
      adapter_key: ADAPTER_KEY,
      external_listing_id: detail.external_listing_id,
      detail_url: detail.detail_url,
      generated_at: new Date().toISOString(),
      horizon: {
        from_date: options.fromDate,
        to_date: toDate,
        weeks: options.weeks,
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

    if (!options.dryRun) {
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
    adapter_key: ADAPTER_KEY,
    generated_at: new Date().toISOString(),
    weeks: options.weeks,
    from_date: options.fromDate,
    to_date: toDate,
    listing_count: listingCount,
    avg_base_nightly:
      listingCount > 0 ? roundCurrency(totalBase / totalDays) : null,
    avg_all_in_nightly:
      listingCount > 0 ? roundCurrency(totalAllIn / totalDays) : null,
    listings: indexRows,
  };

  if (!options.dryRun) {
    await writeFile(
      resolve(pricingDir, "index.json"),
      `${JSON.stringify(indexPayload, null, 2)}\n`,
      "utf8",
    );
  }

  console.log(`${ADAPTER_KEY} listing pricing cache build complete.`);
  console.log(`- weeks: ${options.weeks}`);
  console.log(`- from_date: ${options.fromDate}`);
  console.log(`- to_date: ${toDate}`);
  console.log(`- listings: ${listingCount}`);
  console.log(`- dry_run: ${options.dryRun}`);
  console.log(`- avg_base_nightly: ${indexPayload.avg_base_nightly ?? "n/a"}`);
  console.log(
    `- avg_all_in_nightly: ${indexPayload.avg_all_in_nightly ?? "n/a"}`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    `Failed to build homeownerscollection30a listing pricing cache: ${message}`,
  );
  process.exit(1);
});
