import {
  getDiscoverCorpusMetadata,
  getDiscoverListings,
  getDiscoverListingsCount,
} from "@/lib/discover/discover-listings-meilisearch.server";

function printUsage(): void {
  console.log("Probe discover query results from Meilisearch index");
  console.log("Usage:");
  console.log(
    "  tsx src/lib/scripts/run-discover-meilisearch-query-probe.ts [--limit <number>] [--feature <feature>]",
  );
  console.log("Features: gulf_front | private_pool | golf_cart");
}

function parseFeatureValue(
  value: string,
): "gulf_front" | "private_pool" | "golf_cart" | null {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (normalized === "gulf_front" || normalized === "gulffront") {
    return "gulf_front";
  }
  if (normalized === "private_pool" || normalized === "privatepool") {
    return "private_pool";
  }
  if (normalized === "golf_cart" || normalized === "golfcart") {
    return "golf_cart";
  }

  return null;
}

function parseArgs(argv: string[]): {
  limit: number;
  selectedFeatures: Array<"gulf_front" | "private_pool" | "golf_cart">;
} {
  let limit = 5;
  const selectedFeatures = new Set<
    "gulf_front" | "private_pool" | "golf_cart"
  >();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }

    if (arg === "--limit" && next) {
      const parsed = Number(next);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("--limit must be a positive integer.");
      }
      limit = Math.floor(parsed);
      index += 1;
      continue;
    }

    if (arg === "--feature" && next) {
      const feature = parseFeatureValue(next);
      if (!feature) {
        throw new Error(`Unsupported feature: ${next}`);
      }
      selectedFeatures.add(feature);
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    limit,
    selectedFeatures: Array.from(selectedFeatures.values()),
  };
}

async function run(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  const [totalCount, metadata, listings] = await Promise.all([
    getDiscoverListingsCount({ selectedFeatures: args.selectedFeatures }),
    getDiscoverCorpusMetadata({ selectedFeatures: args.selectedFeatures }),
    getDiscoverListings({
      maxListings: args.limit,
      offset: 0,
      selectedFeatures: args.selectedFeatures,
    }),
  ]);

  const sample = listings.slice(0, args.limit).map((listing) => ({
    id: listing.id,
    name: listing.name,
    area: listing.area,
    beach: listing.beach,
    community: listing.community,
    privatePool: listing.privatePool,
    gulffront: listing.gulffront,
    golfCart: listing.golfCart,
    typicalAllInNightly: listing.typicalAllInNightly,
  }));

  console.log(
    JSON.stringify(
      {
        meilisearchProbe: {
          selectedFeatures: args.selectedFeatures,
          totalCount,
          facetCounts: metadata?.facets.features ?? {},
          sample,
        },
      },
      null,
      2,
    ),
  );

  return 0;
}

run()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`discover meilisearch query probe failed: ${message}`);
    process.exit(1);
  });
