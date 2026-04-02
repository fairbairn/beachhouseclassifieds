import { Chalk } from "chalk";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  assertListingPricingCacheRecord,
  type ListingPricingCacheRecord,
} from "@/lib/pricing/contracts/listing-pricing-cache-contract";
import { selectCanonicalArtifactFiles } from "@/lib/pricing/shared/canonical-index-listings";

const chalk = new Chalk({ level: 1 });

type DetailAvailabilityDay = {
  date: string;
  is_available: boolean;
};

type DetailRecord = {
  external_listing_id: string;
  normalized_availability?: {
    days?: DetailAvailabilityDay[];
  };
};

type CliOptions = {
  adapterKey: string;
  listingId: string | null;
  maxListings: number | null;
  allowMissingAvailabilityDays: boolean;
};

type ListingValidationIssue = {
  code:
    | "invalid_json"
    | "contract_validation_failed"
    | "pricing_missing"
    | "detail_missing"
    | "availability_mismatch"
    | "missing_availability_day";
  message: string;
};

type ListingValidationFailure = {
  listingId: string;
  fileName: string;
  issues: ListingValidationIssue[];
};

function getCurrentUtcDateYmd(): string {
  return new Date().toISOString().slice(0, 10);
}

function shouldAllowAdapterMissingAvailabilityDay(
  adapterKey: string,
  date: string,
  currentUtcDateYmd: string,
): boolean {
  if (adapterKey !== "oversee30a") {
    return false;
  }

  return date === currentUtcDateYmd;
}

function parseArgs(argv: string[]): CliOptions {
  let adapterKey = "360blue";
  let listingId: string | null = null;
  let maxListings: number | null = null;
  let allowMissingAvailabilityDays = false;

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

    if (arg === "--allow-missing-availability-days") {
      allowMissingAvailabilityDays = true;
    }
  }

  return {
    adapterKey,
    listingId,
    maxListings,
    allowMissingAvailabilityDays,
  };
}

async function collectPricingFiles(
  adapterKey: string,
  pricingDir: string,
  listingId: string | null,
  maxListings: number | null,
): Promise<{
  listingIds: string[];
  fileNames: string[];
  missingListingIds: string[];
}> {
  return selectCanonicalArtifactFiles({
    adapterKey,
    listingId,
    maxListings,
    artifactDir: pricingDir,
  });
}

function printFailureSummary(failures: ListingValidationFailure[]): void {
  for (const failure of failures.slice(0, 25)) {
    console.error(
      `${chalk.red("listing=")}${chalk.bold(failure.listingId)} ${chalk.red("file=")}${chalk.bold(failure.fileName)}`,
    );
    for (const issue of failure.issues.slice(0, 15)) {
      console.error(
        `  ${chalk.red("-")} ${chalk.yellow(`[${issue.code}]`)} ${issue.message}`,
      );
    }
    if (failure.issues.length > 15) {
      console.error(
        `  ${chalk.yellow("-")} ... ${failure.issues.length - 15} more issue(s)`,
      );
    }
  }

  if (failures.length > 25) {
    console.error(
      chalk.yellow(`... ${failures.length - 25} more failing listing(s)`),
    );
  }
}

export async function runValidatePricingCacheAlignmentCli(
  argv: string[] = process.argv.slice(2),
): Promise<number> {
  const options = parseArgs(argv);
  const root = process.cwd();
  const adapterRoot = resolve(
    root,
    "src",
    "lib",
    "data",
    "external-sources",
    options.adapterKey,
  );
  const detailsJsonDir = resolve(adapterRoot, "details", "json");
  const pricingDir = resolve(adapterRoot, "details", "pricing");

  let files: string[];
  try {
    files = await collectPricingFiles(
      options.adapterKey,
      pricingDir,
      options.listingId,
      options.maxListings,
    );
  } catch {
    console.error(
      `No pricing directory found for adapter=${options.adapterKey}. Expected: ${pricingDir}`,
    );
    return 1;
  }

  if (files.listingIds.length === 0) {
    console.error(
      `No active listings selected from canonical index for adapter=${options.adapterKey}.`,
    );
    return 1;
  }

  let validated = files.listingIds.length;
  let failed = files.missingListingIds.length;
  const failures: ListingValidationFailure[] = [];
  const currentUtcDateYmd = getCurrentUtcDateYmd();

  for (const missingListingId of files.missingListingIds) {
    failures.push({
      listingId: missingListingId,
      fileName: `${missingListingId}.json`,
      issues: [
        {
          code: "pricing_missing",
          message: `missing pricing cache for active listing ${missingListingId}`,
        },
      ],
    });
  }

  for (const fileName of files.fileNames) {
    const listingId = fileName.replace(/\.json$/i, "");
    const filePath = resolve(pricingDir, fileName);
    const issues: ListingValidationIssue[] = [];

    let pricing: ListingPricingCacheRecord;
    try {
      pricing = JSON.parse(
        await readFile(filePath, "utf8"),
      ) as ListingPricingCacheRecord;
    } catch (error: unknown) {
      failed += 1;
      failures.push({
        listingId,
        fileName,
        issues: [
          {
            code: "invalid_json",
            message: error instanceof Error ? error.message : String(error),
          },
        ],
      });
      continue;
    }

    try {
      assertListingPricingCacheRecord(pricing);
    } catch (error: unknown) {
      issues.push({
        code: "contract_validation_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }

    let detail: DetailRecord | null = null;
    try {
      const detailPath = resolve(detailsJsonDir, `${listingId}.json`);
      detail = JSON.parse(await readFile(detailPath, "utf8")) as DetailRecord;
    } catch {
      issues.push({
        code: "detail_missing",
        message: `detail json missing for listing ${listingId}`,
      });
    }

    const availabilityByDate = new Map<string, boolean>();
    for (const day of detail?.normalized_availability?.days ?? []) {
      if (
        typeof day?.date === "string" &&
        typeof day?.is_available === "boolean"
      ) {
        availabilityByDate.set(day.date, day.is_available);
      }
    }

    for (const day of pricing.days ?? []) {
      const expected = availabilityByDate.get(day.date);
      if (typeof expected !== "boolean") {
        const allowAdapterMissingDay = shouldAllowAdapterMissingAvailabilityDay(
          options.adapterKey,
          day.date,
          currentUtcDateYmd,
        );

        if (allowAdapterMissingDay) {
          continue;
        }

        if (!options.allowMissingAvailabilityDays) {
          issues.push({
            code: "missing_availability_day",
            message: `date=${day.date} missing from detail normalized_availability.days`,
          });
        }
        continue;
      }

      if (day.is_available !== expected) {
        issues.push({
          code: "availability_mismatch",
          message: `date=${day.date} pricing.is_available=${String(day.is_available)} detail.is_available=${String(expected)}`,
        });
      }
    }

    if (issues.length > 0) {
      failed += 1;
      failures.push({
        listingId,
        fileName,
        issues,
      });
    }
  }

  if (failed > 0) {
    console.error(
      chalk.red(
        `Pricing alignment validator failed for adapter=${options.adapterKey} validated=${validated} failed=${failed}`,
      ),
    );
    printFailureSummary(failures);
    return 1;
  }

  console.log(
    chalk.green(
      `Pricing alignment validator passed for adapter=${options.adapterKey} validated=${validated} failed=0`,
    ),
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runValidatePricingCacheAlignmentCli()
    .then((code) => {
      process.exit(code);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Pricing alignment validator failed: ${message}\n`);
      process.exit(1);
    });
}
