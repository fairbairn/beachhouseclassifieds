import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type {
  CanonicalQuoteObservation,
  CanonicalQuotesSidecarRecord,
} from "@/lib/pricing/contracts/quote-observations-contract";

type CliOptions = {
  adapterKey: string;
  listingId: string | null;
  maxListings: number | null;
  dryRun: boolean;
};

type Assumptions = {
  avgFeePctOfBase: number;
  avgTaxPctOfBase: number;
  avgAllInMultiplier: number;
};

function parseArgs(argv: string[]): CliOptions {
  let adapterKey = "30aescapes";
  let listingId: string | null = null;
  let maxListings: number | null = null;
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    if (arg === "--adapter-key" && value) {
      adapterKey = value.trim().toLowerCase();
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

  return { adapterKey, listingId, maxListings, dryRun };
}

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

function safeRatio(numerator: number, denominator: number): number {
  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator <= 0
  ) {
    return 0;
  }
  return Number((numerator / denominator).toFixed(6));
}

function finitePositive(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? roundCurrency(parsed) : null;
}

function finiteNonNegative(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? roundCurrency(parsed) : null;
}

function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
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

async function readAssumptions(adapterRoot: string): Promise<Assumptions> {
  const assumptionsPath = resolve(adapterRoot, "pricing-assumptions.json");
  try {
    const raw = await readFile(assumptionsPath, "utf8");
    const parsed = JSON.parse(raw) as {
      assumptions?: {
        avg_fee_pct_of_base?: number;
        avg_tax_pct_of_base?: number;
        avg_all_in_multiplier?: number;
      };
    };

    const feePct = Math.max(
      0,
      Number(parsed.assumptions?.avg_fee_pct_of_base ?? 0) || 0,
    );
    const taxPct = Math.max(
      0,
      Number(parsed.assumptions?.avg_tax_pct_of_base ?? 0) || 0,
    );
    const allInMultiplier = Math.max(
      1,
      Number(parsed.assumptions?.avg_all_in_multiplier ?? 0) ||
        1 + feePct + taxPct,
    );

    return {
      avgFeePctOfBase: feePct,
      avgTaxPctOfBase: taxPct,
      avgAllInMultiplier: allInMultiplier,
    };
  } catch {
    return {
      avgFeePctOfBase: 0.09,
      avgTaxPctOfBase: 0.12,
      avgAllInMultiplier: 1.21,
    };
  }
}

function needsBackfill(observation: CanonicalQuoteObservation): boolean {
  return (
    finitePositive(observation.base_nightly) === null ||
    finitePositive(observation.all_in_nightly) === null ||
    finitePositive(observation.base_total) === null ||
    finitePositive(observation.grand_total) === null ||
    finitePositive(observation.quoted_total) === null ||
    finitePositive(observation.all_in_multiplier) === null ||
    finiteNonNegative(observation.taxes_total) === null ||
    finiteNonNegative(observation.fees_total_excl_taxes) === null ||
    finiteNonNegative(observation.fee_pct_of_base) === null ||
    finiteNonNegative(observation.tax_pct_of_base) === null ||
    finiteNonNegative(observation.non_base_pct_of_total) === null
  );
}

function backfillObservation(
  observation: CanonicalQuoteObservation,
  index: number,
  baseNightlySeries: Array<number | null>,
  assumptions: Assumptions,
): { updated: CanonicalQuoteObservation; changed: boolean } {
  if (!needsBackfill(observation)) {
    return { updated: observation, changed: false };
  }

  const nights = Math.max(1, Number(observation.nights) || 7);
  const interpolatedNightly = interpolateValue(baseNightlySeries, index);
  const medianNightly = median(
    baseNightlySeries.filter(
      (value): value is number => value !== null && value > 0,
    ),
  );
  const fallbackNightly = medianNightly ?? 650;

  const baseNightly =
    finitePositive(observation.base_nightly) ??
    interpolatedNightly ??
    fallbackNightly;
  const baseTotal =
    finitePositive(observation.base_total) ??
    roundCurrency(baseNightly * nights);

  const taxesTotal =
    finiteNonNegative(observation.taxes_total) ??
    roundCurrency(baseTotal * assumptions.avgTaxPctOfBase);
  const feesTotal =
    finiteNonNegative(observation.fees_total_excl_taxes) ??
    roundCurrency(baseTotal * assumptions.avgFeePctOfBase);

  const computedGrand = roundCurrency(baseTotal + taxesTotal + feesTotal);
  const multiplierGrand = roundCurrency(
    baseTotal * assumptions.avgAllInMultiplier,
  );
  const grandTotal =
    finitePositive(observation.grand_total) ??
    finitePositive(observation.quoted_total) ??
    Math.max(computedGrand, multiplierGrand);

  const allInNightly =
    finitePositive(observation.all_in_nightly) ??
    roundCurrency(grandTotal / nights);

  const feePctOfBase =
    finiteNonNegative(observation.fee_pct_of_base) ??
    safeRatio(feesTotal, baseTotal);
  const taxPctOfBase =
    finiteNonNegative(observation.tax_pct_of_base) ??
    safeRatio(taxesTotal, baseTotal);
  const nonBasePctOfTotal =
    finiteNonNegative(observation.non_base_pct_of_total) ??
    safeRatio(Math.max(0, grandTotal - baseTotal), grandTotal);
  const allInMultiplier =
    finitePositive(observation.all_in_multiplier) ??
    safeRatio(grandTotal, baseTotal);

  const updated: CanonicalQuoteObservation = {
    ...observation,
    base_nightly: baseNightly,
    all_in_nightly: allInNightly,
    base_total: baseTotal,
    taxes_total: taxesTotal,
    fees_total_excl_taxes: feesTotal,
    grand_total: grandTotal,
    quoted_total: grandTotal,
    fee_pct_of_base: feePctOfBase,
    tax_pct_of_base: taxPctOfBase,
    non_base_pct_of_total: nonBasePctOfTotal,
    all_in_multiplier: allInMultiplier,
    fee_lines: Array.isArray(observation.fee_lines)
      ? observation.fee_lines
      : [],
  };

  return { updated, changed: true };
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
    options.adapterKey,
  );
  const quotesDir = resolve(adapterRoot, "details", "quotes");
  const assumptions = await readAssumptions(adapterRoot);

  const entries = await readdir(quotesDir, { withFileTypes: true });
  const allFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();

  let selected = allFiles;
  if (options.listingId) {
    selected = selected.filter((name) => name === `${options.listingId}.json`);
  }
  if (options.maxListings !== null) {
    selected = selected.slice(0, options.maxListings);
  }

  let listingsChanged = 0;
  let observationsBackfilled = 0;

  for (const fileName of selected) {
    const filePath = resolve(quotesDir, fileName);
    const raw = await readFile(filePath, "utf8");
    const sidecar = JSON.parse(raw) as CanonicalQuotesSidecarRecord;

    const baseNightlySeries = sidecar.observations.map((observation) =>
      finitePositive(observation.base_nightly),
    );

    let listingChanged = false;
    const updatedObservations = sidecar.observations.map(
      (observation, index) => {
        const result = backfillObservation(
          observation,
          index,
          baseNightlySeries,
          assumptions,
        );
        if (result.changed) {
          listingChanged = true;
          observationsBackfilled += 1;
        }
        return result.updated;
      },
    );

    if (!listingChanged) {
      continue;
    }

    listingsChanged += 1;
    if (!options.dryRun) {
      const updatedSidecar: CanonicalQuotesSidecarRecord = {
        ...sidecar,
        captured_at: new Date().toISOString(),
        observations: updatedObservations,
      };
      await writeFile(
        filePath,
        `${JSON.stringify(updatedSidecar, null, 2)}\n`,
        "utf8",
      );
    }
  }

  console.log(
    `quote sidecar pricing backfill complete adapter=${options.adapterKey}`,
  );
  console.log(`- listings_selected: ${selected.length}`);
  console.log(`- listings_changed: ${listingsChanged}`);
  console.log(`- observations_backfilled: ${observationsBackfilled}`);
  console.log(`- dry_run: ${options.dryRun}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to backfill quote sidecar pricing: ${message}`);
  process.exit(1);
});
