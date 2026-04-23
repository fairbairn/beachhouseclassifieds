import { AVAILABILITY_INDEX_MAX_STAY_NIGHTS } from "@/lib/discover/availability-window-index";
import type { DiscoverListing } from "@/lib/discover/discover-types";
import {
  getDiscoverMeilisearchIndex,
  getMeilisearchClient,
} from "@/lib/discover/meilisearch-client.server";
import {
  toDiscoverSearchDocument,
  type DiscoverSearchDocument,
} from "@/lib/discover/meilisearch-discover-documents.server";

const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_DETAIL_ENRICH_CONCURRENCY = 20;
const MEILI_TASK_TIMEOUT_MS = 120_000;

type ParsedArgs = {
  batchSize: number;
  dryRun: boolean;
};

function availabilityFieldNames(
  maxStayNights = AVAILABILITY_INDEX_MAX_STAY_NIGHTS,
): string[] {
  const out: string[] = [];
  for (let nights = 1; nights <= maxStayNights; nights += 1) {
    out.push(`avail_${nights}`);
  }
  return out;
}

async function enrichListingsWithAvailability(input: {
  listings: DiscoverListing[];
}): Promise<typeof input.listings> {
  const { getDiscoverListings } =
    await import("@/lib/discover/discover-listings-data-layer.server");

  const output = [...input.listings];
  const concurrency = DEFAULT_DETAIL_ENRICH_CONCURRENCY;

  for (let start = 0; start < output.length; start += concurrency) {
    const slice = output.slice(start, start + concurrency);
    const enrichedSlice = await Promise.all(
      slice.map(async (listing) => {
        const detailRows = await getDiscoverListings({
          includeSlug: listing.id,
          onlySlug: true,
          maxListings: 1,
          disableFallback: true,
        });
        const detail = detailRows.find((row) => row.id === listing.id);
        return detail ?? listing;
      }),
    );

    for (let index = 0; index < enrichedSlice.length; index += 1) {
      output[start + index] = enrichedSlice[index];
    }
  }

  return output;
}

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
  const availabilityFields = availabilityFieldNames();

  const task = await index.updateSettings({
    pagination: {
      maxTotalHits: 20000,
    },
    filterableAttributes: [
      "area_name",
      "beach_area_name",
      "community_name",
      "private_pool",
      "gulf_front",
      "golf_cart",
      "pet_friendly",
      "accessible",
      "elevator",
      "king_bed_count",
      "queen_bed_count",
      "bunk_bed_count",
      "bedrooms",
      "bathrooms",
      "sleeps",
      "typical_all_in_nightly",
      ...availabilityFields,
    ],
    sortableAttributes: [
      "typical_all_in_nightly",
      "bedrooms",
      "bathrooms",
      "sleeps",
      "king_bed_count",
      "queen_bed_count",
      "bunk_bed_count",
    ],
    searchableAttributes: [
      "name",
      "area_name",
      "beach_area_name",
      "community_name",
      "area",
      "beach",
      "community",
    ],
    displayedAttributes: [
      "id",
      "name",
      "area_name",
      "beach_area_name",
      "community_name",
      "area",
      "beach",
      "community",
      "lat",
      "lng",
      "bedrooms",
      "bathrooms",
      "sleeps",
      "private_pool",
      "gulf_front",
      "golf_cart",
      "pet_friendly",
      "accessible",
      "elevator",
      "king_bed_count",
      "queen_bed_count",
      "bunk_bed_count",
      "preview_images",
      "poster",
      "typical_pricing_month",
      "typical_base_nightly",
      "typical_all_in_nightly",
      ...availabilityFields,
    ],
  });

  await getMeilisearchClient().tasks.waitForTask(task, {
    timeout: MEILI_TASK_TIMEOUT_MS,
  });
}

async function syncDocuments(
  batchSize: number,
  dryRun: boolean,
): Promise<void> {
  const { getDiscoverListings, getDiscoverListingsCount } =
    await import("@/lib/discover/discover-listings-data-layer.server");

  const sourceCount = await getDiscoverListingsCount();
  const index = getDiscoverMeilisearchIndex();

  if (dryRun) {
    console.log(
      `discover_meilisearch_sync dry_run=true source_count=${sourceCount} batch_size=${batchSize}`,
    );
    return;
  }

  const deleteTask = await index.deleteAllDocuments();
  await getMeilisearchClient().tasks.waitForTask(deleteTask, {
    timeout: MEILI_TASK_TIMEOUT_MS,
  });

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

    const enrichedListings = await enrichListingsWithAvailability({
      listings,
    });

    const documents: DiscoverSearchDocument[] = enrichedListings.map(
      (listing) => toDiscoverSearchDocument(listing),
    );

    const task = await index.addDocuments(documents, { primaryKey: "id" });
    await getMeilisearchClient().tasks.waitForTask(task, {
      timeout: MEILI_TASK_TIMEOUT_MS,
    });

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
