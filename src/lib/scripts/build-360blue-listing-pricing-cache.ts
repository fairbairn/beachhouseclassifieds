import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { AdapterPricingAssumptionsStore } from "@/lib/pricing/contracts/adapter-pricing-assumptions-contract";

type CliOptions = {
  weeks: number;
  fromDate: string;
  listingId: string | null;
  maxListings: number | null;
  dryRun: boolean;
};

type DetailRateDay = {
  date: string;
  nightly_rate: number | null;
  min_nights: number | null;
  is_booked: boolean | null;
};

type DetailAvailabilityDay = {
  date: string;
  is_available: boolean;
  booking_day_state?: "bookable" | "blocked" | "unknown";
  min_nights_required?: number | null;
};

type QuoteWindow = {
  arrival_date: string;
  departure_date: string;
  nights: number;
  subtotal: number;
  total: number;
};

type DetailRecord = {
  external_listing_id: string;
  detail_url: string;
  normalized_rates?: {
    currency?: string;
    days?: DetailRateDay[];
  };
  normalized_availability?: {
    days?: DetailAvailabilityDay[];
  };
  rates_raw?: {
    quote_windows_path?: string | null;
    quote_windows?: QuoteWindow[];
  };
};

type QuoteWindowsSidecar = {
  quote_windows?: QuoteWindow[];
};

type DayCache = {
  date: string;
  is_available: boolean;
  min_nights: number | null;
  base_nightly: number;
  all_in_nightly: number;
  currency: string;
  source:
    | "accurate_scrape"
    | "derived_quote_window"
    | "derived_interpolated"
    | "derived_assumptions_anchor"
    | "derived_global_default";
  confidence: "high" | "medium" | "low";
};

type ListingPricingCache = {
  adapter_key: "360blue";
  external_listing_id: string;
  detail_url: string;
  generated_at: string;
  horizon: {
    from_date: string;
    to_date: string;
    weeks: number;
  };
  source_summary: {
    accurate_scrape_days: number;
    derived_quote_window_days: number;
    derived_interpolated_days: number;
    derived_assumptions_anchor_days: number;
    derived_global_default_days: number;
    unavailable_dates: number;
  };
  days: DayCache[];
};

const GLOBAL_DEFAULT_BASE_NIGHTLY = 500;

function parseArgs(argv: string[]): CliOptions {
  let weeks = 24;
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

function isoRange(startIsoDate: string, dayCount: number): string[] {
  return Array.from({ length: dayCount }, (_, index) =>
    addDays(startIsoDate, index),
  );
}

function roundTo(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return roundTo((sorted[mid - 1]! + sorted[mid]!) / 2, 2);
  }
  return roundTo(sorted[mid]!, 2);
}

function buildAvailabilityMap(
  detail: DetailRecord,
): Map<string, DetailAvailabilityDay> {
  return new Map(
    (detail.normalized_availability?.days ?? []).map((day) => [day.date, day]),
  );
}

function buildRateMap(detail: DetailRecord): Map<string, DetailRateDay> {
  return new Map(
    (detail.normalized_rates?.days ?? []).map((day) => [day.date, day]),
  );
}

function applyQuoteWindows(
  quoteWindows: QuoteWindow[],
): Map<string, { base: number[]; allIn: number[] }> {
  const byDate = new Map<string, { base: number[]; allIn: number[] }>();

  for (const window of quoteWindows) {
    const nights = Number(window.nights);
    if (!Number.isFinite(nights) || nights <= 0) {
      continue;
    }

    const basePerNight = Number(window.subtotal) / nights;
    const allInPerNight = Number(window.total) / nights;
    if (!Number.isFinite(basePerNight) || basePerNight <= 0) {
      continue;
    }
    if (!Number.isFinite(allInPerNight) || allInPerNight <= 0) {
      continue;
    }

    const dates = isoRange(window.arrival_date, nights);
    for (const date of dates) {
      const current = byDate.get(date) ?? { base: [], allIn: [] };
      current.base.push(basePerNight);
      current.allIn.push(allInPerNight);
      byDate.set(date, current);
    }
  }

  return byDate;
}

function interpolateValue(
  values: Array<number | null>,
  index: number,
): number | null {
  if (values[index] !== null) {
    return values[index];
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
    return roundTo(leftValue + (rightValue - leftValue) * ratio, 2);
  }

  if (leftValue !== null) {
    return leftValue;
  }

  if (rightValue !== null) {
    return rightValue;
  }

  return null;
}

function averageAssumptionBaseNightly(
  assumptions: AdapterPricingAssumptionsStore,
): number | null {
  const nightlyValues = assumptions.samples
    .map((sample) => {
      if (!sample.nights || sample.nights <= 0 || sample.base_total <= 0) {
        return null;
      }
      return sample.base_total / sample.nights;
    })
    .filter(
      (value): value is number => value !== null && Number.isFinite(value),
    );

  if (nightlyValues.length === 0) {
    return null;
  }

  const total = nightlyValues.reduce((sum, value) => sum + value, 0);
  return roundTo(total / nightlyValues.length, 2);
}

function lowerConfidence(
  confidence: DayCache["confidence"],
): DayCache["confidence"] {
  if (confidence === "high") {
    return "medium";
  }
  return "low";
}

function buildListingCache(
  detail: DetailRecord,
  assumptions: AdapterPricingAssumptionsStore,
  fromDate: string,
  weeks: number,
  quoteWindows: QuoteWindow[],
): ListingPricingCache {
  const days = weeks * 7;
  const horizonDates = isoRange(fromDate, days);
  const toDate = horizonDates[horizonDates.length - 1] ?? fromDate;
  const currency =
    detail.normalized_rates?.currency ?? assumptions.currency ?? "USD";
  const availabilityByDate = buildAvailabilityMap(detail);
  const ratesByDate = buildRateMap(detail);
  const quoteByDate = applyQuoteWindows(quoteWindows);
  const assumptionsMultiplier =
    assumptions.assumptions.avg_all_in_multiplier > 0
      ? assumptions.assumptions.avg_all_in_multiplier
      : 1;

  const listingKnownBases: Array<number | null> = horizonDates.map((date) => {
    const rateDay = ratesByDate.get(date);
    const nightlyRate = rateDay?.nightly_rate;
    if (
      nightlyRate !== null &&
      nightlyRate !== undefined &&
      Number(nightlyRate) > 0
    ) {
      return Number(nightlyRate);
    }

    const quote = quoteByDate.get(date);
    const value = quote ? median(quote.base) : null;
    return value !== null && value > 0 ? value : null;
  });

  const listingMedianBase = median(
    listingKnownBases.filter((value): value is number => value !== null),
  );
  const adapterAnchorBase = averageAssumptionBaseNightly(assumptions);
  const globalDefaultBase =
    adapterAnchorBase ?? listingMedianBase ?? GLOBAL_DEFAULT_BASE_NIGHTLY;

  const dayRows: DayCache[] = horizonDates.map((date, index) => {
    const availability = availabilityByDate.get(date);
    const rateDay = ratesByDate.get(date);
    const quote = quoteByDate.get(date);

    const isAvailable =
      availability?.is_available ??
      (availability?.booking_day_state === "bookable" ? true : false);
    const minNights =
      availability?.min_nights_required ?? rateDay?.min_nights ?? null;

    const nightlyRate = rateDay?.nightly_rate;
    if (
      nightlyRate !== null &&
      nightlyRate !== undefined &&
      Number(nightlyRate) > 0
    ) {
      const base = roundTo(Number(nightlyRate), 2);
      const confidence: DayCache["confidence"] = isAvailable
        ? "high"
        : lowerConfidence("high");
      return {
        date,
        is_available: isAvailable,
        min_nights: minNights,
        base_nightly: base,
        all_in_nightly: roundTo(base * assumptionsMultiplier, 2),
        currency,
        source: "accurate_scrape",
        confidence,
      };
    }

    if (quote && quote.base.length > 0 && quote.allIn.length > 0) {
      const base = median(quote.base);
      const allIn = median(quote.allIn);
      if (base !== null && allIn !== null) {
        const confidence: DayCache["confidence"] = isAvailable
          ? "high"
          : lowerConfidence("high");
        return {
          date,
          is_available: isAvailable,
          min_nights: minNights,
          base_nightly: base,
          all_in_nightly: allIn,
          currency,
          source: "derived_quote_window",
          confidence,
        };
      }
    }

    const interpolatedBase = interpolateValue(listingKnownBases, index);
    if (interpolatedBase !== null && interpolatedBase > 0) {
      const confidence: DayCache["confidence"] = isAvailable
        ? "medium"
        : lowerConfidence("medium");
      return {
        date,
        is_available: isAvailable,
        min_nights: minNights,
        base_nightly: interpolatedBase,
        all_in_nightly: roundTo(interpolatedBase * assumptionsMultiplier, 2),
        currency,
        source: "derived_interpolated",
        confidence,
      };
    }

    const anchorBase = listingMedianBase ?? adapterAnchorBase;
    if (anchorBase !== null && anchorBase > 0) {
      const confidence: DayCache["confidence"] = isAvailable
        ? "low"
        : lowerConfidence("low");
      return {
        date,
        is_available: isAvailable,
        min_nights: minNights,
        base_nightly: anchorBase,
        all_in_nightly: roundTo(anchorBase * assumptionsMultiplier, 2),
        currency,
        source: "derived_assumptions_anchor",
        confidence,
      };
    }

    return {
      date,
      is_available: isAvailable,
      min_nights: minNights,
      base_nightly: globalDefaultBase,
      all_in_nightly: roundTo(globalDefaultBase * assumptionsMultiplier, 2),
      currency,
      source: "derived_global_default",
      confidence: "low",
    };
  });

  return {
    adapter_key: "360blue",
    external_listing_id: detail.external_listing_id,
    detail_url: detail.detail_url,
    generated_at: new Date().toISOString(),
    horizon: {
      from_date: fromDate,
      to_date: toDate,
      weeks,
    },
    source_summary: {
      accurate_scrape_days: dayRows.filter(
        (day) => day.source === "accurate_scrape",
      ).length,
      derived_quote_window_days: dayRows.filter(
        (day) => day.source === "derived_quote_window",
      ).length,
      derived_interpolated_days: dayRows.filter(
        (day) => day.source === "derived_interpolated",
      ).length,
      derived_assumptions_anchor_days: dayRows.filter(
        (day) => day.source === "derived_assumptions_anchor",
      ).length,
      derived_global_default_days: dayRows.filter(
        (day) => day.source === "derived_global_default",
      ).length,
      unavailable_dates: dayRows.filter((day) => !day.is_available).length,
    },
    days: dayRows,
  };
}

async function loadQuoteWindowsForDetail(
  adapterRoot: string,
  detail: DetailRecord,
): Promise<QuoteWindow[]> {
  const inline = detail.rates_raw?.quote_windows ?? [];
  if (inline.length > 0) {
    return inline;
  }

  const sidecarPath =
    detail.rates_raw?.quote_windows_path ??
    resolve(
      adapterRoot,
      "details",
      "quotes",
      `${detail.external_listing_id}.json`,
    );

  try {
    const raw = await readFile(sidecarPath, "utf8");
    const sidecar = JSON.parse(raw) as QuoteWindowsSidecar;
    return sidecar.quote_windows ?? [];
  } catch {
    return [];
  }
}

async function loadAssumptionsStore(
  assumptionsPath: string,
): Promise<AdapterPricingAssumptionsStore> {
  const raw = await readFile(assumptionsPath, "utf8");
  return JSON.parse(raw) as AdapterPricingAssumptionsStore;
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const root = process.cwd();
  const adapterRoot = resolve(
    root,
    "src",
    "lib",
    "data",
    "external-sources",
    "360blue",
  );
  const detailsJsonDir = resolve(adapterRoot, "details", "json");
  const detailsPricingDir = resolve(adapterRoot, "details", "pricing");
  const assumptionsPath = resolve(adapterRoot, "pricing-assumptions.json");

  const assumptions = await loadAssumptionsStore(assumptionsPath);
  const entries = await readdir(detailsJsonDir, { withFileTypes: true });
  const jsonFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();

  const selected = options.listingId
    ? jsonFiles.filter((name) => name === `${options.listingId}.json`)
    : options.maxListings === null
      ? jsonFiles
      : jsonFiles.slice(0, options.maxListings);

  if (selected.length === 0) {
    throw new Error(
      "No matching detail JSON files found for cache generation.",
    );
  }

  if (!options.dryRun) {
    await mkdir(detailsPricingDir, { recursive: true });
  }

  let written = 0;
  let failed = 0;
  const failureSamples: Array<{ filename: string; reason: string }> = [];
  const manifest: Array<{
    external_listing_id: string;
    cache_path: string;
    generated_at: string;
    source_summary: ListingPricingCache["source_summary"];
  }> = [];

  for (const filename of selected) {
    const detailPath = resolve(detailsJsonDir, filename);

    try {
      const raw = await readFile(detailPath, "utf8");
      const detail = JSON.parse(raw) as DetailRecord;
      if (!detail.external_listing_id || !detail.detail_url) {
        failed += 1;
        continue;
      }

      const quoteWindows = await loadQuoteWindowsForDetail(adapterRoot, detail);

      const cache = buildListingCache(
        detail,
        assumptions,
        options.fromDate,
        options.weeks,
        quoteWindows,
      );
      const cachePath = resolve(
        detailsPricingDir,
        `${detail.external_listing_id}.json`,
      );

      if (!options.dryRun) {
        await writeFile(
          cachePath,
          `${JSON.stringify(cache, null, 2)}\n`,
          "utf8",
        );
      }

      manifest.push({
        external_listing_id: detail.external_listing_id,
        cache_path: cachePath,
        generated_at: cache.generated_at,
        source_summary: cache.source_summary,
      });
      written += 1;
    } catch (error: unknown) {
      failed += 1;
      if (failureSamples.length < 10) {
        const reason = error instanceof Error ? error.message : String(error);
        failureSamples.push({ filename, reason });
      }
    }
  }

  if (!options.dryRun) {
    const manifestPath = resolve(detailsPricingDir, "index.json");
    await writeFile(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
  }

  console.log(
    [
      "adapter=360blue",
      `weeks=${options.weeks}`,
      `from_date=${options.fromDate}`,
      `selected=${selected.length}`,
      `written=${written}`,
      `failed=${failed}`,
      `dry_run=${options.dryRun ? "yes" : "no"}`,
    ].join(" "),
  );

  if (failureSamples.length > 0) {
    process.stderr.write(
      `failure_samples=${JSON.stringify(failureSamples, null, 2)}\n`,
    );
  }

  return failed > 0 ? 1 : 0;
}

let exiting = false;
process.on("SIGINT", () => {
  if (exiting) {
    process.exit(130);
  }
  exiting = true;
  process.stderr.write("Operation cancelled by user.\n");
  process.exit(130);
});

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `Failed to build 360blue listing pricing cache: ${message}\n`,
    );
    process.exit(1);
  });
