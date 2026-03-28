import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

type CliOptions = {
  targetSamples: number;
  maxListings: number;
  fromDate: string;
  windowNights: number;
};

type KeycoDetailRecord = {
  external_listing_id: string;
  normalized_availability?: {
    days?: Array<{
      date: string;
      is_available: boolean;
      min_nights_required?: number | null;
    }>;
  };
};

type PricingResponse = {
  pricing?: {
    totalBaseRate?: number | null;
    taxes?: number | null;
    pricingFees?: Array<{
      amount?: number | null;
      description?: string | null;
    }> | null;
  } | null;
  bookingState?: {
    availability?: {
      isAvailable?: boolean;
    };
  };
};

type AssumptionSample = {
  captured_at: string;
  source_listing_id: string;
  currency: "USD";
  check_in_date: string;
  check_out_date: string;
  nights: number;
  base_total: number;
  taxes_total: number;
  fee_lines: Array<{
    name: string;
    amount: number;
  }>;
  fees_total_excl_taxes: number;
  grand_total: number;
  fee_pct_of_base: number;
  tax_pct_of_base: number;
  non_base_pct_of_total: number;
  all_in_multiplier: number;
};

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundRatio(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
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

function parseArgs(argv: string[]): CliOptions {
  let targetSamples = 5;
  let maxListings = 80;
  let fromDate = toIsoDate(new Date());
  let windowNights = 6;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    if (arg === "--target-samples" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed >= 3 && parsed <= 20) {
        targetSamples = Math.floor(parsed);
      }
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

    if (arg === "--from-date" && value) {
      fromDate = toIsoDate(value);
      index += 1;
      continue;
    }

    if (arg === "--window-nights" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed >= 2 && parsed <= 14) {
        windowNights = Math.floor(parsed);
      }
      index += 1;
    }
  }

  return { targetSamples, maxListings, fromDate, windowNights };
}

async function fetchPricingSample(
  listingId: string,
  checkInDate: string,
  checkOutDate: string,
): Promise<AssumptionSample | null> {
  const endpoint = new URL(`/api/listing/${listingId}/pricing-context`, "https://key.co");
  endpoint.search = new URLSearchParams({
    startDate: checkInDate,
    endDate: checkOutDate,
    adultCount: "1",
    childCount: "0",
    infantCount: "0",
    petCount: "0",
  }).toString();

  const response = await fetch(endpoint.toString(), {
    method: "GET",
    headers: {
      accept: "application/json, text/plain, */*",
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
    },
  });

  if (!response.ok) {
    return null;
  }

  const payload = (await response.json()) as PricingResponse;
  const pricingNode = payload.pricing && typeof payload.pricing === "object" ? payload.pricing : null;
  const baseTotalRaw = Number(pricingNode?.totalBaseRate);
  const taxesTotalRaw = Number(pricingNode?.taxes);

  const feeLines = Array.isArray(pricingNode?.pricingFees)
    ? pricingNode.pricingFees
        .map((line) => {
          const name = String(line?.description ?? "").trim();
          const amount = Number(line?.amount);
          if (!name || !Number.isFinite(amount) || amount < 0) {
            return null;
          }
          return { name, amount: roundCurrency(amount) };
        })
        .filter(
          (
            line,
          ): line is {
            name: string;
            amount: number;
          } => Boolean(line),
        )
    : [];

  const baseTotal = Number.isFinite(baseTotalRaw) && baseTotalRaw > 0 ? baseTotalRaw : null;
  const taxesTotal = Number.isFinite(taxesTotalRaw) && taxesTotalRaw >= 0 ? taxesTotalRaw : null;
  const feesTotal = feeLines.length
    ? roundCurrency(feeLines.reduce((sum, line) => sum + line.amount, 0))
    : 0;

  if (baseTotal === null || taxesTotal === null) {
    return null;
  }

  const nights = Math.max(
    1,
    Math.round((Date.parse(`${checkOutDate}T00:00:00.000Z`) - Date.parse(`${checkInDate}T00:00:00.000Z`)) / 86_400_000),
  );
  const grandTotal = roundCurrency(baseTotal + taxesTotal + feesTotal);
  if (!Number.isFinite(grandTotal) || grandTotal <= 0) {
    return null;
  }

  return {
    captured_at: new Date().toISOString(),
    source_listing_id: listingId,
    currency: "USD",
    check_in_date: checkInDate,
    check_out_date: checkOutDate,
    nights,
    base_total: roundCurrency(baseTotal),
    taxes_total: roundCurrency(taxesTotal),
    fee_lines: feeLines,
    fees_total_excl_taxes: roundCurrency(feesTotal),
    grand_total: grandTotal,
    fee_pct_of_base: roundRatio(feesTotal / baseTotal),
    tax_pct_of_base: roundRatio(taxesTotal / baseTotal),
    non_base_pct_of_total: roundRatio((feesTotal + taxesTotal) / grandTotal),
    all_in_multiplier: roundRatio(grandTotal / baseTotal),
  };
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
    "keyco30a",
  );
  const detailsJsonDir = resolve(adapterRoot, "details", "json");
  const assumptionsPath = resolve(adapterRoot, "pricing-assumptions.json");
  const reportsDir = resolve(root, ".tmp", "reports");

  await mkdir(reportsDir, { recursive: true });

  const detailEntries = await readdir(detailsJsonDir, { withFileTypes: true });
  const detailFiles = detailEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort()
    .slice(0, options.maxListings);

  const samples: AssumptionSample[] = [];
  const attempts: Array<{
    listing_id: string;
    check_in_date: string;
    check_out_date: string;
    sampled: boolean;
  }> = [];

  for (const detailFile of detailFiles) {
    if (samples.length >= options.targetSamples) {
      break;
    }

    const detailPath = resolve(detailsJsonDir, detailFile);
    const detailRaw = await readFile(detailPath, "utf8");
    const detail = JSON.parse(detailRaw) as KeycoDetailRecord;

    const availability = (detail.normalized_availability?.days ?? []).filter(
      (day) => day.date >= options.fromDate,
    );
    const firstAvailable = availability.find((day) => day.is_available);
    if (!firstAvailable?.date) {
      continue;
    }

    const nights = Math.max(2, firstAvailable.min_nights_required ?? options.windowNights);
    const checkInDate = firstAvailable.date;
    const checkOutDate = addDays(checkInDate, nights);

    const sample = await fetchPricingSample(
      detail.external_listing_id,
      checkInDate,
      checkOutDate,
    );

    attempts.push({
      listing_id: detail.external_listing_id,
      check_in_date: checkInDate,
      check_out_date: checkOutDate,
      sampled: sample !== null,
    });

    if (sample) {
      samples.push(sample);
    }
  }

  if (samples.length < 3) {
    throw new Error(
      `Unable to collect enough pricing samples for keyco30a (got ${samples.length}, need at least 3).`,
    );
  }

  const avgFeePct = roundRatio(
    samples.reduce((sum, sample) => sum + sample.fee_pct_of_base, 0) / samples.length,
  );
  const avgTaxPct = roundRatio(
    samples.reduce((sum, sample) => sum + sample.tax_pct_of_base, 0) / samples.length,
  );
  const avgNonBasePct = roundRatio(
    samples.reduce((sum, sample) => sum + sample.non_base_pct_of_total, 0) /
      samples.length,
  );
  const avgAllInMultiplier = roundRatio(
    samples.reduce((sum, sample) => sum + sample.all_in_multiplier, 0) /
      samples.length,
  );

  const feeLineBuckets = new Map<string, { sample_count: number; total_amount: number; total_pct_of_base: number }>();
  for (const sample of samples) {
    for (const feeLine of sample.fee_lines) {
      const bucket = feeLineBuckets.get(feeLine.name) ?? {
        sample_count: 0,
        total_amount: 0,
        total_pct_of_base: 0,
      };
      bucket.sample_count += 1;
      bucket.total_amount += feeLine.amount;
      bucket.total_pct_of_base += sample.base_total > 0 ? feeLine.amount / sample.base_total : 0;
      feeLineBuckets.set(feeLine.name, bucket);
    }
  }

  const feeLines = Array.from(feeLineBuckets.entries())
    .map(([name, bucket]) => ({
      name,
      sample_count: bucket.sample_count,
      avg_amount: roundCurrency(bucket.total_amount / bucket.sample_count),
      avg_pct_of_base: roundRatio(bucket.total_pct_of_base / bucket.sample_count),
    }))
    .sort((left, right) => right.sample_count - left.sample_count);

  const payload = {
    adapter_key: "keyco30a",
    updated_at: new Date().toISOString(),
    currency: "USD",
    assumptions: {
      sample_count: samples.length,
      avg_fee_pct_of_base: avgFeePct,
      avg_tax_pct_of_base: avgTaxPct,
      avg_non_base_pct_of_total: avgNonBasePct,
      avg_all_in_multiplier: avgAllInMultiplier,
      fee_lines: feeLines,
    },
    samples,
  };

  await writeFile(assumptionsPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  const reportPath = resolve(reportsDir, "keyco30a-pricing-assumptions-refresh.json");
  await writeFile(
    reportPath,
    `${JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        target_samples: options.targetSamples,
        samples_collected: samples.length,
        attempts,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  console.log("keyco30a pricing assumptions refresh complete.");
  console.log(`- samples_collected: ${samples.length}`);
  console.log(`- assumptions_path: ${assumptionsPath}`);
  console.log(`- report_path: ${reportPath}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to refresh keyco30a pricing assumptions: ${message}`);
  process.exit(1);
});
