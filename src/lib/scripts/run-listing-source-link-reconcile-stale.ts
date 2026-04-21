import "@/core/tooling/env/load-env-profile";

import { and, eq, inArray, isNull } from "drizzle-orm";

import { pgDb } from "@/core/server/db";
import { listing_source_link } from "@/lib/db/schema-postgres";
import { loadCanonicalListings } from "@/lib/pricing/shared/canonical-index-listings";

type CliOptions = {
  adapterKeys: string[];
  allAdapters: boolean;
  dryRun: boolean;
  help: boolean;
};

type AdapterReconcileResult = {
  adapterKey: string;
  indexCount: number;
  activeCount: number;
  staleCount: number;
  deactivatedCount: number;
  staleSample: string[];
  errorMessage: string | null;
};

const SAMPLE_LIMIT = 20;
const UPDATE_CHUNK_SIZE = 500;

function printUsage(): void {
  console.log("Listing Source-Link Stale Reconciler");
  console.log("Usage:");
  console.log(
    "  tsx src/lib/scripts/run-listing-source-link-reconcile-stale.ts --adapter-key <key> [--adapter-key <key2>] [--dry-run]",
  );
  console.log(
    "  tsx src/lib/scripts/run-listing-source-link-reconcile-stale.ts --all-adapters [--dry-run]",
  );
  console.log("");
  console.log("Options:");
  console.log("  --adapter-key <key>  Adapter key to reconcile (repeatable)");
  console.log(
    "  --all-adapters       Reconcile all adapters found in index data",
  );
  console.log(
    "  --dry-run            Preview stale rows without writing updates",
  );
  console.log("  --help               Show help");
  console.log("");
  console.log("Exit codes:");
  console.log("  0 success, 1 handled failure, 130 cancelled");
}

function normalizeAdapterKeys(values: string[]): string[] {
  const out = new Set<string>();
  for (const value of values) {
    const normalized = value.trim().toLowerCase();
    if (normalized.length > 0) {
      out.add(normalized);
    }
  }
  return Array.from(out);
}

function parseArgs(argv: string[]): CliOptions {
  const adapterKeysRaw: string[] = [];
  let allAdapters = false;
  let dryRun = false;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const value = argv[i + 1];

    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }

    if (token === "--all-adapters") {
      allAdapters = true;
      continue;
    }

    if (token === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (token === "--adapter-key") {
      if (!value) {
        throw new Error("Missing value for --adapter-key");
      }
      adapterKeysRaw.push(value);
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  const adapterKeys = normalizeAdapterKeys(
    adapterKeysRaw.flatMap((value) => value.split(",")),
  );

  if (!help && !allAdapters && adapterKeys.length === 0) {
    throw new Error(
      "Provide --adapter-key <key> (repeatable) or --all-adapters.",
    );
  }

  if (allAdapters && adapterKeys.length > 0) {
    throw new Error("Use either --all-adapters or --adapter-key, not both.");
  }

  return {
    adapterKeys,
    allAdapters,
    dryRun,
    help,
  };
}

function chunkArray<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += size) {
    chunks.push(values.slice(i, i + size));
  }
  return chunks;
}

async function listIndexAdapters(rootDir = process.cwd()): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const baseDir = resolve(rootDir, "src", "lib", "data", "external-sources");
  const entries = await readdir(baseDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name.trim().toLowerCase())
    .filter((value) => value.length > 0)
    .sort((a, b) => a.localeCompare(b));
}

async function reconcileAdapter(
  adapterKey: string,
  dryRun: boolean,
): Promise<AdapterReconcileResult> {
  if (!pgDb) {
    throw new Error("Postgres database is not configured.");
  }

  const indexListings = await loadCanonicalListings(adapterKey);
  const indexSet = new Set(
    indexListings
      .map((listing) => listing.externalListingId.trim())
      .filter((value) => value.length > 0),
  );

  const activeRows = await pgDb
    .select({
      id: listing_source_link.id,
      externalListingId: listing_source_link.external_listing_id,
    })
    .from(listing_source_link)
    .where(
      and(
        eq(listing_source_link.adapter_key, adapterKey),
        eq(listing_source_link.source_status, "active"),
        isNull(listing_source_link.active_to),
      ),
    );

  const staleRows = activeRows.filter(
    (row) => !indexSet.has(row.externalListingId.trim()),
  );
  const staleIds = staleRows.map((row) => row.id);

  let deactivatedCount = 0;
  if (!dryRun && staleIds.length > 0) {
    const now = new Date().toISOString();
    const chunks = chunkArray(staleIds, UPDATE_CHUNK_SIZE);
    for (const ids of chunks) {
      await pgDb
        .update(listing_source_link)
        .set({
          source_status: "inactive",
          active_to: now,
          updated_at: now,
        })
        .where(inArray(listing_source_link.id, ids));
      deactivatedCount += ids.length;
    }
  }

  return {
    adapterKey,
    indexCount: indexSet.size,
    activeCount: activeRows.length,
    staleCount: staleRows.length,
    deactivatedCount,
    staleSample: staleRows
      .map((row) => row.externalListingId)
      .slice(0, SAMPLE_LIMIT),
    errorMessage: null,
  };
}

async function run(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printUsage();
    return 0;
  }

  if (!pgDb) {
    throw new Error("Postgres database is not configured.");
  }

  const adapterKeys = options.allAdapters
    ? await listIndexAdapters()
    : options.adapterKeys;

  console.log("listing_source_link_reconcile_start");
  console.log(
    `adapters=${adapterKeys.length} dry_run=${options.dryRun} mode=${options.allAdapters ? "all-adapters" : "selected-adapters"}`,
  );

  const results: AdapterReconcileResult[] = [];
  for (const adapterKey of adapterKeys) {
    console.log(`\n=== adapter ${adapterKey} ===`);
    try {
      const result = await reconcileAdapter(adapterKey, options.dryRun);
      results.push(result);
      console.log(
        [
          "listing_source_link_reconcile",
          `adapter=${adapterKey}`,
          `index_count=${result.indexCount}`,
          `active_count=${result.activeCount}`,
          `stale_count=${result.staleCount}`,
          `deactivated_count=${result.deactivatedCount}`,
          `dry_run=${options.dryRun}`,
        ].join(" "),
      );
      if (result.staleSample.length > 0) {
        console.log(
          `listing_source_link_reconcile_stale_sample adapter=${adapterKey} ids=${result.staleSample.join(",")}`,
        );
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        adapterKey,
        indexCount: 0,
        activeCount: 0,
        staleCount: 0,
        deactivatedCount: 0,
        staleSample: [],
        errorMessage: message,
      });
      console.log(
        `listing_source_link_reconcile adapter=${adapterKey} status=failed message=${message}`,
      );
    }
  }

  const failures = results.filter((result) => result.errorMessage !== null);
  const staleTotal = results.reduce(
    (sum, result) => sum + result.staleCount,
    0,
  );
  const deactivatedTotal = results.reduce(
    (sum, result) => sum + result.deactivatedCount,
    0,
  );

  console.log("\nListing Source-Link Reconcile Summary");
  console.log(
    `adapters_checked=${results.length} failed=${failures.length} stale_total=${staleTotal} deactivated_total=${deactivatedTotal} dry_run=${options.dryRun}`,
  );

  if (failures.length > 0) {
    console.log("failed_adapters:");
    for (const failure of failures) {
      console.log(`- ${failure.adapterKey}: ${failure.errorMessage}`);
    }
  }

  return failures.length > 0 ? 1 : 0;
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

run()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`listing source-link reconcile failed: ${message}`);
    process.exit(1);
  });
