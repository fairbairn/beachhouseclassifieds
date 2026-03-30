import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { CanonicalQuotesSidecarRecord } from "@/lib/pricing/contracts/quote-observations-contract";
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
  quotesDir: string,
  listingId: string | null,
  maxListings: number | null,
): Promise<string[]> {
  const entries = await readdir(quotesDir, { withFileTypes: true });
  const jsonFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();

  let selected = jsonFiles;
  if (listingId) {
    const byFileName = `${listingId}.json`;
    selected = jsonFiles.filter((name) => name === byFileName);
  }

  if (maxListings !== null) {
    selected = selected.slice(0, maxListings);
  }

  return selected;
}

function printFailureSummary(failures: ListingValidationFailure[]): void {
  for (const failure of failures.slice(0, 25)) {
    console.error(`listing=${failure.listingId} file=${failure.fileName}`);
    for (const issue of failure.issues.slice(0, 12)) {
      console.error(`  - [${issue.code}] ${issue.message}`);
    }
    if (failure.issues.length > 12) {
      console.error(`  - ... ${failure.issues.length - 12} more issue(s)`);
    }
  }

  if (failures.length > 25) {
    console.error(`... ${failures.length - 25} more failing listing(s)`);
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
    quotesDir,
    options.listingId,
    options.maxListings,
  );

  if (files.length === 0) {
    console.error(
      `No quote sidecar files selected for adapter=${options.adapterKey}.`,
    );
    return 1;
  }

  let validated = 0;
  let failed = 0;
  const failures: ListingValidationFailure[] = [];

  for (const fileName of files) {
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

    validated += 1;
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
      `Quote validator failed for adapter=${options.adapterKey} validated=${validated} failed=${failed}`,
    );
    printFailureSummary(failures);
    return 1;
  }

  console.log(
    `Quote validator passed for adapter=${options.adapterKey} validated=${validated} failed=0`,
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
