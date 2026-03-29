import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  buildCheckoutSample,
  createEmptyAssumptionsStore,
  upsertCheckoutSample,
  type AdapterPricingAssumptionsStore,
  type CheckoutFeeLine,
} from "@/lib/pricing/contracts/adapter-pricing-assumptions-contract";

type CliOptions = {
  adapterKey: string;
  inputFile: string;
  maxSamples: number;
  dryRun: boolean;
};

type CheckoutInput = {
  source_listing_id?: unknown;
  currency?: unknown;
  check_in_date?: unknown;
  check_out_date?: unknown;
  nights?: unknown;
  base_total?: unknown;
  taxes_total?: unknown;
  fee_lines?: unknown;
  grand_total?: unknown;
  captured_at?: unknown;
};

function parseArgs(argv: string[]): CliOptions {
  let adapterKey = "";
  let inputFile = "";
  let maxSamples = 120;
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    if (arg === "--adapter-key" && value) {
      adapterKey = value.trim();
      index += 1;
      continue;
    }

    if (arg === "--input-file" && value) {
      inputFile = value.trim();
      index += 1;
      continue;
    }

    if (arg === "--max-samples" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        maxSamples = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--dry-run") {
      dryRun = true;
    }
  }

  if (!adapterKey) {
    throw new Error("Missing required --adapter-key value.");
  }
  if (!inputFile) {
    throw new Error("Missing required --input-file value.");
  }

  return { adapterKey, inputFile, maxSamples, dryRun };
}

function toNumber(value: unknown, fieldName: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric value for ${fieldName}.`);
  }
  return parsed;
}

function toStringValue(value: unknown, fieldName: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new Error(`Missing required value for ${fieldName}.`);
  }
  return normalized;
}

function parseFeeLines(value: unknown): CheckoutFeeLine[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const lines: CheckoutFeeLine[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const maybeName = String((entry as { name?: unknown }).name ?? "").trim();
    const maybeAmount = Number((entry as { amount?: unknown }).amount);
    if (!maybeName || !Number.isFinite(maybeAmount)) {
      continue;
    }

    lines.push({
      name: maybeName,
      amount: maybeAmount,
    });
  }

  return lines;
}

async function loadStore(
  filePath: string,
  adapterKey: string,
): Promise<AdapterPricingAssumptionsStore> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as AdapterPricingAssumptionsStore;
    if (
      !parsed ||
      parsed.adapter_key !== adapterKey ||
      !Array.isArray(parsed.samples)
    ) {
      throw new Error("Store file does not match expected shape.");
    }
    return parsed;
  } catch {
    return createEmptyAssumptionsStore(adapterKey, "USD");
  }
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const inputRaw = await readFile(
    resolve(process.cwd(), options.inputFile),
    "utf8",
  );
  const input = JSON.parse(inputRaw) as CheckoutInput;

  const sourceListingId = toStringValue(
    input.source_listing_id,
    "source_listing_id",
  );
  const currency = String(input.currency ?? "USD").trim() || "USD";
  const checkInDate = toStringValue(input.check_in_date, "check_in_date");
  const checkOutDate = toStringValue(input.check_out_date, "check_out_date");
  const nights = toNumber(input.nights, "nights");
  const baseTotal = toNumber(input.base_total, "base_total");
  const taxesTotal = toNumber(input.taxes_total ?? 0, "taxes_total");
  const grandTotal = toNumber(input.grand_total, "grand_total");
  const feeLines = parseFeeLines(input.fee_lines);

  const sample = buildCheckoutSample({
    sourceListingId,
    currency,
    checkInDate,
    checkOutDate,
    nights,
    baseTotal,
    taxesTotal,
    feeLines,
    grandTotal,
    capturedAt:
      typeof input.captured_at === "string" ? input.captured_at : undefined,
  });

  const assumptionsPath = resolve(
    process.cwd(),
    "src",
    "lib",
    "data",
    "external-sources",
    options.adapterKey,
    "pricing-assumptions.json",
  );

  const existing = await loadStore(assumptionsPath, options.adapterKey);
  const updated = upsertCheckoutSample(existing, sample, options.maxSamples);

  if (!options.dryRun) {
    await mkdir(dirname(assumptionsPath), { recursive: true });
    await writeFile(
      assumptionsPath,
      `${JSON.stringify(updated, null, 2)}\n`,
      "utf8",
    );
  }

  console.log(
    [
      `adapter=${options.adapterKey}`,
      `samples=${updated.assumptions.sample_count}`,
      `avg_fee_pct_of_base=${updated.assumptions.avg_fee_pct_of_base.toFixed(6)}`,
      `avg_tax_pct_of_base=${updated.assumptions.avg_tax_pct_of_base.toFixed(6)}`,
      `all_in_multiplier=${updated.assumptions.avg_all_in_multiplier.toFixed(6)}`,
      `dry_run=${options.dryRun ? "yes" : "no"}`,
    ].join(" "),
  );

  return 0;
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
    process.stderr.write(`Failed to record checkout assumption: ${message}\n`);
    process.exit(1);
  });
