import chalk from "chalk";
import { and, eq, isNull } from "drizzle-orm";

import { databaseProvider, pgDb } from "@/core/server/db";
import { listing_source_link } from "@/lib/db/schema-postgres";
import { getKnownAdapterKeys } from "@/lib/pricing/scraper-engine/adapter-registry";
import { loadCanonicalListings } from "@/lib/pricing/shared/canonical-index-listings";
import {
  ingestAdapterDetailsToCanonical,
  type IngestStats,
} from "./ingest-adapter-details";

type CliOptions = {
  adapterKey: string | null;
  allAdapters: boolean;
  allListings: boolean;
  listingId: string | null;
  maxListings: number | null;
  dryRun: boolean;
  failFast: boolean;
  help: boolean;
};

type AdapterRunResult = {
  adapterKey: string;
  stats: IngestStats | null;
  errorMessage: string | null;
  failureDetails: AdapterFailureDetails | null;
  countVerification: AdapterCountVerification | null;
};

type AdapterFailureDetails = {
  adapterKey: string;
  mode: "all-listings" | "listing-id" | "max-listings";
  listingId: string | null;
  maxListings: number | null;
  dryRun: boolean;
  errorMessage: string;
};

type AdapterCountVerification = {
  adapterKey: string;
  rawIndexCount: number;
  indexCount: number;
  duplicateIndexEntries: number;
  activeSourceLinkCount: number;
  pass: boolean;
  missingExternalIdsSample: string[];
  unexpectedExternalIdsSample: string[];
  missingExternalIdsTotal: number;
  unexpectedExternalIdsTotal: number;
};

const VERIFICATION_SAMPLE_LIMIT = 20;

function buildUsageText(entryPath: string): string {
  return [
    "Usage:",
    `  tsx ${entryPath} --adapter-key <key> [--all-listings] [--listing-id <id>] [--max-listings <n>] [--dry-run]`,
    `  tsx ${entryPath} --all-adapters [--all-listings] [--max-listings <n>] [--dry-run] [--fail-fast]`,
    "",
    "Options:",
    "  --adapter-key <key>   Ingest one adapter.",
    "  --all-adapters        Ingest all known adapters.",
    "  --all-listings        Use adapter details/index.json entries as the full active-listing ingest baseline.",
    "  --listing-id <id>     Restrict ingest to one listing id/slug (single adapter mode only).",
    "  --max-listings <n>    Cap listing scan count per adapter.",
    "  --dry-run             Compute ingest actions without writing DB rows.",
    "  --fail-fast           Stop on first adapter error in all-adapters mode.",
    "  --help                Show usage.",
    "",
    "Verification:",
    "  In all-listings mode (without --dry-run), verifies index count == active source-link count per adapter.",
    "",
    "Exit codes:",
    "  0 success, 1 handled failure, 130 cancelled",
  ].join("\n");
}

function isAllListingsMode(options: CliOptions): boolean {
  return (
    options.allListings ||
    (options.listingId === null && options.maxListings === null)
  );
}

function parseArgs(argv: string[]): CliOptions {
  let adapterKey: string | null = null;
  let allAdapters = false;
  let allListings = false;
  let listingId: string | null = null;
  let maxListings: number | null = null;
  let dryRun = false;
  let failFast = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];

    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }

    if (token === "--all-adapters") {
      allAdapters = true;
      continue;
    }

    if (token === "--all-listings") {
      allListings = true;
      continue;
    }

    if (token === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (token === "--fail-fast") {
      failFast = true;
      continue;
    }

    if (token === "--adapter-key" && value) {
      adapterKey = value.trim().toLowerCase() || null;
      index += 1;
      continue;
    }

    if (token === "--listing-id" && value) {
      listingId = value.trim() || null;
      index += 1;
      continue;
    }

    if (token === "--max-listings" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        maxListings = Math.floor(parsed);
      }
      index += 1;
      continue;
    }
  }

  if (!help && !allAdapters && !adapterKey) {
    throw new Error("Missing required --adapter-key (or use --all-adapters).");
  }

  if (allAdapters && adapterKey) {
    throw new Error("Use either --adapter-key or --all-adapters, not both.");
  }

  if (allAdapters && listingId) {
    throw new Error("--listing-id is only supported with --adapter-key mode.");
  }

  if (allListings && listingId) {
    throw new Error("--all-listings cannot be combined with --listing-id.");
  }

  if (allListings && maxListings !== null) {
    throw new Error("--all-listings cannot be combined with --max-listings.");
  }

  return {
    adapterKey,
    allAdapters,
    allListings,
    listingId,
    maxListings,
    dryRun,
    failFast,
    help,
  };
}

function renderAdapterStatLine(stats: IngestStats, dryRun: boolean): string {
  return [
    `adapter=${stats.adapterKey}`,
    `scanned=${stats.scanned}`,
    `inserted_listings=${stats.insertedListings}`,
    `updated_listings=${stats.updatedListings}`,
    `inserted_source_links=${stats.insertedSourceLinks}`,
    `updated_source_links=${stats.updatedSourceLinks}`,
    `skipped_missing_detail_json=${stats.skippedMissingDetailJson}`,
    `skipped_missing_name=${stats.skippedMissingName}`,
    `dry_run=${dryRun}`,
  ].join(" ");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function inferRunMode(
  options: CliOptions,
): "all-listings" | "listing-id" | "max-listings" {
  if (isAllListingsMode(options)) {
    return "all-listings";
  }
  if (options.listingId) {
    return "listing-id";
  }
  return "max-listings";
}

async function loadActiveSourceExternalIds(
  adapterKey: string,
): Promise<string[]> {
  if (!pgDb) {
    throw new Error("Postgres database is not configured.");
  }

  const rows = await pgDb
    .select({ externalListingId: listing_source_link.external_listing_id })
    .from(listing_source_link)
    .where(
      and(
        eq(listing_source_link.adapter_key, adapterKey),
        eq(listing_source_link.source_status, "active"),
        isNull(listing_source_link.active_to),
      ),
    );

  return rows
    .map((row) => row.externalListingId.trim())
    .filter((value) => value.length > 0);
}

async function verifyAdapterIndexToSourceLinkCount(
  adapterKey: string,
  indexListingIds: string[],
): Promise<AdapterCountVerification> {
  const activeSourceExternalIds = await loadActiveSourceExternalIds(adapterKey);
  const normalizedIndexListingIds = indexListingIds
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const indexUniqueListingIds = Array.from(new Set(normalizedIndexListingIds));
  const indexIdSet = new Set(indexUniqueListingIds);
  const activeIdSet = new Set(activeSourceExternalIds);

  const missingExternalIds = indexUniqueListingIds.filter(
    (externalListingId) => !activeIdSet.has(externalListingId),
  );
  const unexpectedExternalIds = activeSourceExternalIds.filter(
    (externalListingId) => !indexIdSet.has(externalListingId),
  );

  const rawIndexCount = normalizedIndexListingIds.length;
  const indexCount = indexUniqueListingIds.length;
  const duplicateIndexEntries = Math.max(0, rawIndexCount - indexCount);
  const activeSourceLinkCount = activeSourceExternalIds.length;

  return {
    adapterKey,
    rawIndexCount,
    indexCount,
    duplicateIndexEntries,
    activeSourceLinkCount,
    pass: activeSourceLinkCount === indexCount,
    missingExternalIdsSample: missingExternalIds.slice(
      0,
      VERIFICATION_SAMPLE_LIMIT,
    ),
    unexpectedExternalIdsSample: unexpectedExternalIds.slice(
      0,
      VERIFICATION_SAMPLE_LIMIT,
    ),
    missingExternalIdsTotal: missingExternalIds.length,
    unexpectedExternalIdsTotal: unexpectedExternalIds.length,
  };
}

function sumStats(results: AdapterRunResult[]): IngestStats {
  return results.reduce<IngestStats>(
    (acc, entry) => {
      if (!entry.stats) {
        return acc;
      }

      acc.scanned += entry.stats.scanned;
      acc.insertedListings += entry.stats.insertedListings;
      acc.updatedListings += entry.stats.updatedListings;
      acc.insertedSourceLinks += entry.stats.insertedSourceLinks;
      acc.updatedSourceLinks += entry.stats.updatedSourceLinks;
      acc.skippedMissingDetailJson += entry.stats.skippedMissingDetailJson;
      acc.skippedMissingName += entry.stats.skippedMissingName;
      return acc;
    },
    {
      adapterKey: "all",
      scanned: 0,
      insertedListings: 0,
      updatedListings: 0,
      insertedSourceLinks: 0,
      updatedSourceLinks: 0,
      skippedMissingDetailJson: 0,
      skippedMissingName: 0,
    },
  );
}

async function runAdapter(
  adapterKey: string,
  options: CliOptions,
): Promise<AdapterRunResult> {
  const useAllListings = isAllListingsMode(options);
  const mode = inferRunMode(options);

  try {
    const stats = await ingestAdapterDetailsToCanonical({
      adapterKey,
      listingId: useAllListings ? null : options.listingId,
      maxListings: useAllListings ? null : options.maxListings,
      dryRun: options.dryRun,
    });

    console.log(
      chalk.green(
        `canonical_listing_ingest ${renderAdapterStatLine(stats, options.dryRun)}`,
      ),
    );

    let countVerification: AdapterCountVerification | null = null;
    if (useAllListings && !options.dryRun) {
      const indexListings = await loadCanonicalListings(adapterKey);
      const indexListingIds = indexListings.map(
        (listing) => listing.externalListingId,
      );
      countVerification = await verifyAdapterIndexToSourceLinkCount(
        adapterKey,
        indexListingIds,
      );
      const verificationLine = [
        `index_raw_count=${countVerification.rawIndexCount}`,
        `index_count=${countVerification.indexCount}`,
        `index_duplicates=${countVerification.duplicateIndexEntries}`,
        `active_source_links=${countVerification.activeSourceLinkCount}`,
        `missing_total=${countVerification.missingExternalIdsTotal}`,
        `unexpected_total=${countVerification.unexpectedExternalIdsTotal}`,
      ].join(" ");
      console.log(
        countVerification.pass
          ? chalk.green(
              `count_verification adapter=${adapterKey} pass ${verificationLine}`,
            )
          : chalk.red(
              `count_verification adapter=${adapterKey} fail ${verificationLine}`,
            ),
      );

      if (countVerification.duplicateIndexEntries > 0) {
        console.log(
          chalk.yellow(
            `count_verification_warning adapter=${adapterKey} duplicate_index_entries=${countVerification.duplicateIndexEntries}`,
          ),
        );
      }

      if (!countVerification.pass) {
        if (countVerification.missingExternalIdsSample.length > 0) {
          console.log(
            chalk.red(
              `count_verification_missing_sample adapter=${adapterKey} ids=${countVerification.missingExternalIdsSample.join(",")}`,
            ),
          );
        }
        if (countVerification.unexpectedExternalIdsSample.length > 0) {
          console.log(
            chalk.red(
              `count_verification_unexpected_sample adapter=${adapterKey} ids=${countVerification.unexpectedExternalIdsSample.join(",")}`,
            ),
          );
        }
      }
    }

    return {
      adapterKey,
      stats,
      errorMessage: null,
      failureDetails: null,
      countVerification,
    };
  } catch (error: unknown) {
    const message = formatError(error);
    const failureDetails: AdapterFailureDetails = {
      adapterKey,
      mode,
      listingId: options.listingId,
      maxListings: options.maxListings,
      dryRun: options.dryRun,
      errorMessage: message,
    };
    console.log(
      chalk.red(
        `canonical_listing_ingest adapter=${adapterKey} status=failed message=${message}`,
      ),
    );
    console.log(
      chalk.red(
        `canonical_listing_ingest_failure_context adapter=${adapterKey} mode=${mode} listing_id=${options.listingId ?? "n/a"} max_listings=${options.maxListings ?? "all"} dry_run=${options.dryRun}`,
      ),
    );

    return {
      adapterKey,
      stats: null,
      errorMessage: message,
      failureDetails,
      countVerification: null,
    };
  }
}

export async function runCanonicalListingIngestCli(
  argv: string[] = process.argv.slice(2),
): Promise<number> {
  const options = parseArgs(argv);
  const entryPath = "src/lib/scripts/run-canonical-listing-ingest.ts";

  if (options.help) {
    console.log(buildUsageText(entryPath));
    return 0;
  }

  if (databaseProvider !== "postgres") {
    throw new Error(
      `Canonical listing ingest requires DATABASE_PROVIDER=postgres. Received '${databaseProvider}'.`,
    );
  }

  const adapterKeys = options.allAdapters
    ? getKnownAdapterKeys()
    : [options.adapterKey!];

  if (adapterKeys.length === 0) {
    console.error(chalk.red("No adapters found to ingest."));
    return 1;
  }

  console.log(chalk.bold("Canonical Listing Ingest"));
  const useAllListings = isAllListingsMode(options);
  const listingSelector = useAllListings
    ? "all-listings-from-index"
    : options.listingId
      ? `listing-id:${options.listingId}`
      : `max-listings:${options.maxListings}`;
  console.log(
    chalk.cyan(
      `mode=${options.allAdapters ? "all-adapters" : "single-adapter"} adapters=${adapterKeys.length} dry_run=${options.dryRun} listing_selector=${listingSelector}`,
    ),
  );

  const results: AdapterRunResult[] = [];
  for (const adapterKey of adapterKeys) {
    console.log(chalk.bold(`\n=== adapter ${adapterKey} ===`));
    const result = await runAdapter(adapterKey, options);
    results.push(result);

    if (result.errorMessage && options.failFast) {
      break;
    }
  }

  const failed = results.filter((entry) => entry.errorMessage !== null);
  const verificationFailed = results.filter(
    (entry) => entry.countVerification && !entry.countVerification.pass,
  );
  const passed = results.length - failed.length;
  const totals = sumStats(results);

  console.log(chalk.bold("\nCanonical Ingest Summary"));
  console.log(
    failed.length === 0 && verificationFailed.length === 0
      ? chalk.green(
          `adapters_checked=${results.length} passed=${passed} failed=0 verification_failed=0 dry_run=${options.dryRun}`,
        )
      : chalk.yellow(
          `adapters_checked=${results.length} passed=${passed} failed=${failed.length} verification_failed=${verificationFailed.length} dry_run=${options.dryRun}`,
        ),
  );
  console.log(
    `totals scanned=${totals.scanned} inserted_listings=${totals.insertedListings} updated_listings=${totals.updatedListings} inserted_source_links=${totals.insertedSourceLinks} updated_source_links=${totals.updatedSourceLinks} skipped_missing_detail_json=${totals.skippedMissingDetailJson} skipped_missing_name=${totals.skippedMissingName}`,
  );

  if (failed.length > 0) {
    console.log(chalk.red("failed_adapters:"));
    for (const entry of failed) {
      console.log(`- ${entry.adapterKey}: ${entry.errorMessage}`);
      if (entry.failureDetails) {
        console.log(
          `  details mode=${entry.failureDetails.mode} listing_id=${entry.failureDetails.listingId ?? "n/a"} max_listings=${entry.failureDetails.maxListings ?? "all"} dry_run=${entry.failureDetails.dryRun}`,
        );
      }
    }
  }

  if (verificationFailed.length > 0) {
    console.log(chalk.red("count_verification_failures:"));
    for (const entry of verificationFailed) {
      const verification = entry.countVerification!;
      console.log(
        `- ${verification.adapterKey}: index_raw_count=${verification.rawIndexCount} index_count=${verification.indexCount} index_duplicates=${verification.duplicateIndexEntries} active_source_links=${verification.activeSourceLinkCount} missing_total=${verification.missingExternalIdsTotal} unexpected_total=${verification.unexpectedExternalIdsTotal}`,
      );
      if (verification.missingExternalIdsSample.length > 0) {
        console.log(
          `  missing_sample=${verification.missingExternalIdsSample.join(",")}`,
        );
      }
      if (verification.unexpectedExternalIdsSample.length > 0) {
        console.log(
          `  unexpected_sample=${verification.unexpectedExternalIdsSample.join(",")}`,
        );
      }
    }
  }

  if (failed.length > 0 || verificationFailed.length > 0) {
    return 1;
  }

  return 0;
}
