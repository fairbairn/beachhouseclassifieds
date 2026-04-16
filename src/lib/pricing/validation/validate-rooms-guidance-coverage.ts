import { Chalk } from "chalk";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { selectCanonicalArtifactFiles } from "@/lib/pricing/shared/canonical-index-listings";

type CliOptions = {
  adapterKey: string;
  listingId: string | null;
  maxListings: number | null;
  summaryOnly: boolean;
  strict: boolean;
};

type DetailRecord = {
  external_listing_id?: unknown;
  rooms_guidance?: unknown;
};

type ListingValidationFailure = {
  listingId: string;
  fileName: string;
  issues: string[];
};

const chalk = new Chalk({ level: 1 });

function parseArgs(argv: string[]): CliOptions {
  let adapterKey: string | null = null;
  let listingId: string | null = null;
  let maxListings: number | null = null;
  let summaryOnly = false;
  let strict = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    if ((arg === "--adapter-key" || arg === "-a") && value) {
      adapterKey = value.trim().toLowerCase();
      index += 1;
      continue;
    }

    if ((arg === "--listing-id" || arg === "--external-listing-id") && value) {
      listingId = value.trim() || null;
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

    if (arg === "--summary-only") {
      summaryOnly = true;
      continue;
    }

    if (arg === "--strict") {
      strict = true;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!adapterKey) {
    throw new Error("Missing required --adapter-key <adapterKey>");
  }

  return {
    adapterKey,
    listingId,
    maxListings,
    summaryOnly,
    strict,
  };
}

function printUsage(): void {
  console.log("Validate Rooms Guidance Coverage");
  console.log("Usage:");
  console.log(
    "  tsx src/lib/pricing/validation/validate-rooms-guidance-coverage.ts --adapter-key <key> [--listing-id <id>] [--max-listings <n>] [--strict] [--summary-only]",
  );
  console.log("");
  console.log("Options:");
  console.log("  --adapter-key <key>       Restrict to one adapter (required)");
  console.log("  --listing-id <id>         Restrict to one listing id");
  console.log("  --max-listings <n>        Limit selected listings");
  console.log(
    "  --strict                  Fail when rooms_guidance has only one line",
  );
  console.log("  --summary-only            Print only aggregate summary");
  console.log("  --help                    Show help");
  console.log("");
  console.log("Exit codes:");
  console.log("  0 success");
  console.log("  1 missing/invalid coverage detected");
  console.log("  130 cancelled");
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) =>
      typeof entry === "string" ? entry.replace(/\s+/g, " ").trim() : "",
    )
    .filter(Boolean);
}

function printListingStatus(input: {
  index: number;
  total: number;
  listingId: string;
  fileName: string;
  status: "PASS" | "FAIL" | "MISSING";
  details?: string;
}): void {
  const counter = chalk.gray(`[${input.index}/${input.total}]`);
  const listing = `${chalk.bold(input.listingId)} (${input.fileName})`;

  if (input.status === "PASS") {
    console.log(
      `${counter} ${chalk.green("PASS")} ${listing}${input.details ? ` ${input.details}` : ""}`,
    );
    return;
  }

  const label =
    input.status === "MISSING" ? chalk.yellow("MISSING") : chalk.red("FAIL");
  console.log(
    `${counter} ${label} ${listing}${input.details ? ` ${input.details}` : ""}`,
  );
}

function printFailureSummary(failures: ListingValidationFailure[]): void {
  for (const failure of failures.slice(0, 40)) {
    console.error(
      `${chalk.red("listing=")}${chalk.bold(failure.listingId)} ${chalk.red("file=")}${chalk.bold(failure.fileName)}`,
    );
    for (const issue of failure.issues.slice(0, 8)) {
      console.error(`  ${chalk.red("-")} ${issue}`);
    }
    if (failure.issues.length > 8) {
      console.error(
        `  ${chalk.yellow("-")} ... ${failure.issues.length - 8} more issue(s)`,
      );
    }
  }

  if (failures.length > 40) {
    console.error(
      chalk.yellow(`... ${failures.length - 40} more failing listing(s)`),
    );
  }
}

export async function runValidateRoomsGuidanceCoverageCli(
  argv: string[] = process.argv.slice(2),
): Promise<number> {
  const options = parseArgs(argv);
  const root = process.cwd();
  const detailsJsonDir = resolve(
    root,
    "src",
    "lib",
    "data",
    "external-sources",
    options.adapterKey,
    "details",
    "json",
  );

  const files = await selectCanonicalArtifactFiles({
    adapterKey: options.adapterKey,
    listingId: options.listingId,
    maxListings: options.maxListings,
    artifactDir: detailsJsonDir,
  });

  if (files.listingIds.length === 0) {
    console.error(
      `No active listings selected from canonical index for adapter=${options.adapterKey}.`,
    );
    return 1;
  }

  const validated = files.listingIds.length;
  let processedItems = 0;
  const totalItems = files.fileNames.length + files.missingListingIds.length;

  let failed = 0;
  let passed = 0;
  let missingFile = 0;
  let missingField = 0;
  let emptyArray = 0;
  let emptyAfterNormalization = 0;
  let strictLowSignal = 0;
  let totalGuidanceEntries = 0;

  const failures: ListingValidationFailure[] = [];

  if (!options.summaryOnly) {
    console.log(
      chalk.cyan(
        `Rooms guidance validation adapter=${options.adapterKey} selected=${validated} files=${files.fileNames.length} missing_files=${files.missingListingIds.length} strict=${options.strict}`,
      ),
    );
  }

  for (const missingListingId of files.missingListingIds) {
    const missingFailure: ListingValidationFailure = {
      listingId: missingListingId,
      fileName: `${missingListingId}.json`,
      issues: ["detail json file missing for active canonical listing"],
    };

    failures.push(missingFailure);
    missingFile += 1;
    failed += 1;
    processedItems += 1;

    if (!options.summaryOnly) {
      printListingStatus({
        index: processedItems,
        total: totalItems,
        listingId: missingFailure.listingId,
        fileName: missingFailure.fileName,
        status: "MISSING",
        details: missingFailure.issues[0],
      });
    }
  }

  for (const fileName of files.fileNames) {
    const filePath = resolve(detailsJsonDir, fileName);
    const fallbackListingId = fileName.replace(/\.json$/i, "");

    let parsed: DetailRecord;
    try {
      const raw = await readFile(filePath, "utf8");
      parsed = JSON.parse(raw) as DetailRecord;
    } catch (error: unknown) {
      failed += 1;
      processedItems += 1;

      const invalidFailure: ListingValidationFailure = {
        listingId: fallbackListingId,
        fileName,
        issues: [
          `invalid_json: ${error instanceof Error ? error.message : String(error)}`,
        ],
      };
      failures.push(invalidFailure);

      if (!options.summaryOnly) {
        printListingStatus({
          index: processedItems,
          total: totalItems,
          listingId: invalidFailure.listingId,
          fileName,
          status: "FAIL",
          details: invalidFailure.issues[0],
        });
      }
      continue;
    }

    const listingId =
      typeof parsed.external_listing_id === "string" &&
      parsed.external_listing_id.trim().length > 0
        ? parsed.external_listing_id.trim()
        : fallbackListingId;

    const issues: string[] = [];
    if (!("rooms_guidance" in parsed)) {
      issues.push("missing rooms_guidance field");
      missingField += 1;
    } else if (!Array.isArray(parsed.rooms_guidance)) {
      issues.push("rooms_guidance is not an array");
      missingField += 1;
    } else if (parsed.rooms_guidance.length === 0) {
      issues.push("rooms_guidance array is empty");
      emptyArray += 1;
    } else {
      const normalized = asStringArray(parsed.rooms_guidance);
      totalGuidanceEntries += normalized.length;
      if (normalized.length === 0) {
        issues.push("rooms_guidance has no non-empty string entries");
        emptyAfterNormalization += 1;
      } else if (options.strict && normalized.length < 2) {
        issues.push(
          "rooms_guidance has low signal (<2 entries) in strict mode",
        );
        strictLowSignal += 1;
      }
    }

    processedItems += 1;
    if (issues.length > 0) {
      failed += 1;
      failures.push({ listingId, fileName, issues });
      if (!options.summaryOnly) {
        printListingStatus({
          index: processedItems,
          total: totalItems,
          listingId,
          fileName,
          status: "FAIL",
          details: issues[0],
        });
      }
      continue;
    }

    passed += 1;
    if (!options.summaryOnly) {
      printListingStatus({
        index: processedItems,
        total: totalItems,
        listingId,
        fileName,
        status: "PASS",
      });
    }
  }

  const coveragePct =
    validated > 0 ? Number(((passed / validated) * 100).toFixed(1)) : 0;
  const avgEntriesPerPassing =
    passed > 0 ? Number((totalGuidanceEntries / passed).toFixed(2)) : 0;

  console.log("rooms_guidance_validation_summary");
  console.log(`- adapter_key: ${options.adapterKey}`);
  console.log(`- selected: ${validated}`);
  console.log(`- passed: ${passed}`);
  console.log(`- failed: ${failed}`);
  console.log(`- coverage_pct: ${coveragePct}`);
  console.log(`- avg_entries_per_passing_listing: ${avgEntriesPerPassing}`);
  console.log(`- missing_files: ${missingFile}`);
  console.log(`- missing_or_invalid_field: ${missingField}`);
  console.log(`- empty_array: ${emptyArray}`);
  console.log(`- empty_after_normalization: ${emptyAfterNormalization}`);
  console.log(`- strict_low_signal: ${strictLowSignal}`);

  if (failed > 0) {
    console.error(
      chalk.red(
        `Rooms guidance validator failed for adapter=${options.adapterKey} selected=${validated} failed=${failed}`,
      ),
    );
    printFailureSummary(failures);
    return 1;
  }

  console.log(
    chalk.green(
      `Rooms guidance validator passed for adapter=${options.adapterKey} selected=${validated} failed=0`,
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
  runValidateRoomsGuidanceCoverageCli()
    .then((code) => {
      process.exit(code);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Rooms guidance validator failed: ${message}\n`);
      process.exit(1);
    });
}
