import { Chalk } from "chalk";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const chalk = new Chalk({ level: 1 });

import type { CanonicalQuotesSidecarRecord } from "@/lib/pricing/contracts/quote-observations-contract";
import { selectCanonicalArtifactFiles } from "@/lib/pricing/shared/canonical-index-listings";
import {
  validateCanonicalQuoteSidecar,
  type QuoteValidationIssue,
} from "@/lib/pricing/validation/quote-sidecar-validator";

type CliOptions = {
  adapterKey: string;
  listingId: string | null;
  maxListings: number | null;
  allowNullPricingFields: boolean;
};

type ListingValidationFailure = {
  listingId: string;
  fileName: string;
  issues: QuoteValidationIssue[];
};

function parseArgs(argv: string[]): CliOptions {
  let adapterKey = "360blue";
  let listingId: string | null = null;
  let maxListings: number | null = null;
  let allowNullPricingFields = false;

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

    if (arg === "--allow-null-pricing-fields") {
      allowNullPricingFields = true;
    }
  }

  return {
    adapterKey,
    listingId,
    maxListings,
    allowNullPricingFields,
  };
}

async function collectQuoteFiles(
  adapterKey: string,
  quotesDir: string,
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
    artifactDir: quotesDir,
  });
}

function printFailureSummary(failures: ListingValidationFailure[]): void {
  for (const failure of failures.slice(0, 25)) {
    console.error(
      `${chalk.red("listing=")}${chalk.bold(failure.listingId)} ${chalk.red("file=")}${chalk.bold(failure.fileName)}`,
    );
    for (const issue of failure.issues.slice(0, 12)) {
      console.error(
        `  ${chalk.red("-")} ${chalk.yellow(`[${issue.code}]`)} ${issue.message}`,
      );
    }
    if (failure.issues.length > 12) {
      console.error(
        `  ${chalk.yellow("-")} ... ${failure.issues.length - 12} more issue(s)`,
      );
    }
  }

  if (failures.length > 25) {
    console.error(
      chalk.yellow(`... ${failures.length - 25} more failing listing(s)`),
    );
  }
}

export async function runValidateAdapterQuoteSidecarsCli(
  argv: string[] = process.argv.slice(2),
): Promise<number> {
  const options = parseArgs(argv);
  const root = process.cwd();
  const quotesDir = resolve(
    root,
    "src",
    "lib",
    "data",
    "external-sources",
    options.adapterKey,
    "details",
    "quotes",
  );

  const files = await collectQuoteFiles(
    options.adapterKey,
    quotesDir,
    options.listingId,
    options.maxListings,
  );

  if (files.listingIds.length === 0) {
    console.error(
      `No active listings selected from canonical index for adapter=${options.adapterKey}.`,
    );
    return 1;
  }

  let validated = files.listingIds.length;
  let failed = files.missingListingIds.length;
  const failures: ListingValidationFailure[] = [];

  for (const missingListingId of files.missingListingIds) {
    failures.push({
      listingId: missingListingId,
      fileName: `${missingListingId}.json`,
      issues: [
        {
          code: "missing_sidecar",
          message: `missing quote sidecar for active listing '${missingListingId}'`,
        },
      ],
    });
  }

  for (const fileName of files.fileNames) {
    const filePath = resolve(quotesDir, fileName);
    const raw = await readFile(filePath, "utf8");

    let parsed: CanonicalQuotesSidecarRecord;
    try {
      parsed = JSON.parse(raw) as CanonicalQuotesSidecarRecord;
    } catch (error: unknown) {
      failed += 1;
      failures.push({
        listingId: fileName.replace(/\.json$/i, ""),
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

    const issues = validateCanonicalQuoteSidecar(parsed, {
      expectedNights: 7,
      requireNonNullPricingFields: !options.allowNullPricingFields,
    });

    if (issues.length > 0) {
      failed += 1;
      failures.push({
        listingId:
          parsed.external_listing_id || fileName.replace(/\.json$/i, ""),
        fileName,
        issues,
      });
    }
  }

  if (failed > 0) {
    console.error(
      chalk.red(
        `Quote validator failed for adapter=${options.adapterKey} validated=${validated} failed=${failed}`,
      ),
    );
    printFailureSummary(failures);
    return 1;
  }

  console.log(
    chalk.green(
      `Quote validator passed for adapter=${options.adapterKey} validated=${validated} failed=0`,
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
  runValidateAdapterQuoteSidecarsCli()
    .then((code) => {
      process.exit(code);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Quote validator failed: ${message}\n`);
      process.exit(1);
    });
}
