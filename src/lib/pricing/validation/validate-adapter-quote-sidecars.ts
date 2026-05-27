import { Chalk } from "chalk";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const chalk = new Chalk({ level: 1 });

import type { CanonicalQuotesSidecarRecord } from "@/lib/pricing/contracts/quote-observations-contract";
import { selectCanonicalArtifactFiles } from "@/lib/pricing/shared/canonical-index-listings";
import { canonicalizeExternalListingId } from "@/lib/pricing/shared/external-listing-id";
import {
  validateCanonicalQuoteSidecar,
  type QuoteValidationIssue,
} from "@/lib/pricing/validation/quote-sidecar-validator";

type CliOptions = {
  adapterKey: string;
  listingId: string | null;
  maxListings: number | null;
  allowNullPricingFields: boolean;
  summaryOnly: boolean;
};

type ListingValidationFailure = {
  listingId: string;
  fileName: string;
  issues: QuoteValidationIssue[];
};

type DetailRecord = {
  listing_flags?: {
    non_bookable_online?: unknown;
    availability_validation_exempt?: unknown;
    availability_validation_exempt_reason_code?: unknown;
  };
  normalized_availability?: {
    validation_exempt?: unknown;
    validation_exempt_reason_code?: unknown;
  };
};

const WAIVABLE_UNAVAILABLE_QUOTE_ISSUES = new Set([
  "invalid_quote_max_queries",
  "invalid_observation_count",
  "missing_observations",
]);

function printListingStatus(input: {
  index: number;
  total: number;
  listingId: string;
  fileName: string;
  status: "PASS" | "FAIL" | "MISSING" | "WAIVED";
  issueCount?: number;
  firstIssue?: QuoteValidationIssue;
}): void {
  const counter = chalk.gray(`[${input.index}/${input.total}]`);
  const listing = `${chalk.bold(input.listingId)} (${input.fileName})`;

  if (input.status === "PASS") {
    console.log(`${counter} ${chalk.green("PASS")} ${listing}`);
    return;
  }

  if (input.status === "WAIVED") {
    console.log(
      `${counter} ${chalk.yellow("WAIVED")} ${listing} ${chalk.gray("(non_bookable_online exemption)")}`,
    );
    return;
  }

  const issueCount = Math.max(1, input.issueCount ?? 1);
  const issueSummary = input.firstIssue
    ? `${chalk.yellow(`[${input.firstIssue.code}]`)} ${input.firstIssue.message}`
    : chalk.yellow("no issue details");
  const label =
    input.status === "MISSING" ? chalk.yellow("MISSING") : chalk.red("FAIL");
  console.log(
    `${counter} ${label} ${listing} issues=${issueCount} ${issueSummary}`,
  );
}

function isNonBookableOnlineExempt(detail: DetailRecord | null): boolean {
  if (!detail) {
    return false;
  }

  if (detail.listing_flags?.non_bookable_online === true) {
    return true;
  }

  if (
    detail.listing_flags?.availability_validation_exempt === true ||
    detail.normalized_availability?.validation_exempt === true
  ) {
    return true;
  }

  const reasonCandidates = [
    detail.listing_flags?.availability_validation_exempt_reason_code,
    detail.normalized_availability?.validation_exempt_reason_code,
  ];

  return reasonCandidates.some(
    (value) =>
      typeof value === "string" &&
      value.trim().toLowerCase() === "non_bookable_online",
  );
}

async function loadDetailRecordForListing(input: {
  detailsJsonDir: string;
  listingIdOrFileBase: string;
}): Promise<DetailRecord | null> {
  const canonicalFileBase = canonicalizeExternalListingId(
    input.listingIdOrFileBase,
  );
  if (!canonicalFileBase) {
    return null;
  }

  const detailPath = resolve(input.detailsJsonDir, `${canonicalFileBase}.json`);
  try {
    const raw = await readFile(detailPath, "utf8");
    return JSON.parse(raw) as DetailRecord;
  } catch {
    return null;
  }
}

function isWaivableUnavailableIssueSet(
  issues: QuoteValidationIssue[],
): boolean {
  return (
    issues.length > 0 &&
    issues.every((issue) => WAIVABLE_UNAVAILABLE_QUOTE_ISSUES.has(issue.code))
  );
}

function parseArgs(argv: string[]): CliOptions {
  let adapterKey = "360blue";
  let listingId: string | null = null;
  let maxListings: number | null = null;
  let allowNullPricingFields = false;
  let summaryOnly = false;

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

    if (arg === "--summary-only") {
      summaryOnly = true;
    }
  }

  return {
    adapterKey,
    listingId,
    maxListings,
    allowNullPricingFields,
    summaryOnly,
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

  const validated = files.listingIds.length;
  let failed = files.missingListingIds.length;
  let waived = 0;
  const failures: ListingValidationFailure[] = [];
  const totalItems = files.missingListingIds.length + files.fileNames.length;
  let processedItems = 0;

  if (!options.summaryOnly) {
    console.log(
      chalk.cyan(
        `Streaming quote validation adapter=${options.adapterKey} selected=${validated} files=${files.fileNames.length} missing=${files.missingListingIds.length}`,
      ),
    );
  }

  for (const missingListingId of files.missingListingIds) {
    const detail = await loadDetailRecordForListing({
      detailsJsonDir,
      listingIdOrFileBase: missingListingId,
    });
    if (isNonBookableOnlineExempt(detail)) {
      failed -= 1;
      waived += 1;
      processedItems += 1;
      if (!options.summaryOnly) {
        printListingStatus({
          index: processedItems,
          total: totalItems,
          listingId: missingListingId,
          fileName: `${missingListingId}.json`,
          status: "WAIVED",
        });
      }
      continue;
    }

    const missingFailure: ListingValidationFailure = {
      listingId: missingListingId,
      fileName: `${missingListingId}.json`,
      issues: [
        {
          code: "missing_sidecar",
          message: `missing quote sidecar for active listing '${missingListingId}'`,
        },
      ],
    };
    failures.push(missingFailure);
    processedItems += 1;
    if (!options.summaryOnly) {
      printListingStatus({
        index: processedItems,
        total: totalItems,
        listingId: missingFailure.listingId,
        fileName: missingFailure.fileName,
        status: "MISSING",
        issueCount: missingFailure.issues.length,
        firstIssue: missingFailure.issues[0],
      });
    }
  }

  for (const fileName of files.fileNames) {
    const filePath = resolve(quotesDir, fileName);
    const raw = await readFile(filePath, "utf8");
    const fallbackListingId = fileName.replace(/\.json$/i, "");

    let parsed: CanonicalQuotesSidecarRecord;
    try {
      parsed = JSON.parse(raw) as CanonicalQuotesSidecarRecord;
    } catch (error: unknown) {
      failed += 1;
      const invalidJsonFailure: ListingValidationFailure = {
        listingId: fallbackListingId,
        fileName,
        issues: [
          {
            code: "invalid_json",
            message: error instanceof Error ? error.message : String(error),
          },
        ],
      };
      failures.push(invalidJsonFailure);
      processedItems += 1;
      if (!options.summaryOnly) {
        printListingStatus({
          index: processedItems,
          total: totalItems,
          listingId: invalidJsonFailure.listingId,
          fileName,
          status: "FAIL",
          issueCount: invalidJsonFailure.issues.length,
          firstIssue: invalidJsonFailure.issues[0],
        });
      }
      continue;
    }

    const listingId = parsed.external_listing_id || fallbackListingId;
    const detail = await loadDetailRecordForListing({
      detailsJsonDir,
      listingIdOrFileBase: listingId,
    });
    const nonBookableOnlineExempt = isNonBookableOnlineExempt(detail);

    const issues = validateCanonicalQuoteSidecar(parsed, {
      expectedNights: 7,
      requireNonNullPricingFields: !options.allowNullPricingFields,
    });

    if (issues.length > 0 && nonBookableOnlineExempt) {
      if (isWaivableUnavailableIssueSet(issues)) {
        waived += 1;
        processedItems += 1;
        if (!options.summaryOnly) {
          printListingStatus({
            index: processedItems,
            total: totalItems,
            listingId,
            fileName,
            status: "WAIVED",
          });
        }
        continue;
      }
    }

    if (issues.length > 0) {
      failed += 1;
      const listingFailure: ListingValidationFailure = {
        listingId,
        fileName,
        issues,
      };
      failures.push(listingFailure);
      processedItems += 1;
      if (!options.summaryOnly) {
        printListingStatus({
          index: processedItems,
          total: totalItems,
          listingId,
          fileName,
          status: "FAIL",
          issueCount: issues.length,
          firstIssue: issues[0],
        });
      }
      continue;
    }

    processedItems += 1;
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
      `Quote validator passed for adapter=${options.adapterKey} validated=${validated} failed=0 waived=${waived}`,
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
