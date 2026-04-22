import {
  getDiscoverListings,
  getDiscoverListingsCount,
} from "@/lib/discover/discover-listings-data-layer.server";
import {
  getDiscoverMeilisearchIndex,
  getMeilisearchClient,
} from "@/lib/discover/meilisearch-client.server";
import {
  toDiscoverSearchDocument,
  type DiscoverSearchDocument,
} from "@/lib/discover/meilisearch-discover-documents.server";

const DEFAULT_BATCH_SIZE = 500;

type ParsedArgs = {
  batchSize: number;
  dryRun: boolean;
};

function printUsage(): void {
  console.log("Sync discover listings into Meilisearch");
  console.log("Usage:");
  console.log(
    "  tsx src/lib/scripts/run-discover-meilisearch-sync.ts [--batch-size <number>] [--dry-run]",
  );
}

function parseArgs(argv: string[]): ParsedArgs {
  let batchSize = DEFAULT_BATCH_SIZE;
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }

    if (arg === "--batch-size" && next) {
      const parsed = Number(next);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("--batch-size must be a positive integer.");
      }
      batchSize = Math.floor(parsed);
      index += 1;
      continue;
    }

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    batchSize,
    dryRun,
  };
}

async function ensureIndexSettings(): Promise<void> {
  const index = getDiscoverMeilisearchIndex();

  const task = await index.updateSettings({
    pagination: {
      maxTotalHits: 20000,
    },
    filterableAttributes: [
      "areaCode",
      "beachCode",
      "communityCode",
      "privatePool",
      "gulffront",
      "golfCart",
      "bedrooms",
      "bathrooms",
      "sleeps",
      "typicalAllInNightly",
    ],
    sortableAttributes: [
      "typicalAllInNightly",
      "bedrooms",
      "bathrooms",
      "sleeps",
    ],
    searchableAttributes: ["name", "area", "beach", "community"],
    displayedAttributes: [
      "id",
      "name",
      "area",
      "areaCode",
      "beach",
      "beachCode",
      "community",
      "communityCode",
      "lat",
      "lng",
      "bedrooms",
      "bathrooms",
      "sleeps",
      "privatePool",
      "gulffront",
      "golfCart",
      "previewImages",
      "typicalPricingMonth",
      "typicalBaseNightly",
      "typicalAllInNightly",
    ],
  });

  await getMeilisearchClient().tasks.waitForTask(task);
}

async function syncDocuments(
  batchSize: number,
  dryRun: boolean,
): Promise<void> {
  const sourceCount = await getDiscoverListingsCount();
  const index = getDiscoverMeilisearchIndex();

  if (dryRun) {
    console.log(
      `discover_meilisearch_sync dry_run=true source_count=${sourceCount} batch_size=${batchSize}`,
    );
    return;
  }

  const deleteTask = await index.deleteAllDocuments();
  await getMeilisearchClient().tasks.waitForTask(deleteTask);

  let syncedCount = 0;
  let offset = 0;

  while (offset < sourceCount) {
    const listings = await getDiscoverListings({
      maxListings: batchSize,
      offset,
      disableFallback: true,
    });

    if (listings.length === 0) {
      break;
    }

    const documents: DiscoverSearchDocument[] = listings.map((listing) =>
      toDiscoverSearchDocument(listing),
    );

    const task = await index.addDocuments(documents, { primaryKey: "id" });
    await getMeilisearchClient().tasks.waitForTask(task);

    syncedCount += documents.length;
    offset += listings.length;

    console.log(
      `discover_meilisearch_sync progress synced=${syncedCount} source=${sourceCount}`,
    );
  }

  console.log(
    `discover_meilisearch_sync complete synced=${syncedCount} source=${sourceCount}`,
  );
}

async function run(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  await ensureIndexSettings();
  await syncDocuments(args.batchSize, args.dryRun);

  return 0;
}

run()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`discover meilisearch sync failed: ${message}`);
    process.exit(1);
  });
