import { promises as fs } from "node:fs";
import path from "node:path";

type CliOptions = {
  adapterKey: string | null;
  allAdapters: boolean;
  maxResults: number;
  topAdapters: number;
};

type DetailJson = {
  external_listing_id?: unknown;
  media_gallery?: {
    image_urls?: unknown;
  };
};

type DuplicateEntry = {
  url: string;
  count: number;
};

type AdapterDuplicateReport = {
  adapterKey: string;
  listingsProcessed: number;
  totalImageUrls: number;
  uniqueImageUrls: number;
  duplicates: DuplicateEntry[];
};

function printUsage(): void {
  console.log("Detect duplicate image URLs across listings for an adapter");
  console.log("Usage:");
  console.log(
    "  tsx src/lib/scripts/run-detect-duplicate-image-urls.ts --adapter-key <adapterKey> [--max-results <n>]",
  );
  console.log(
    "  tsx src/lib/scripts/run-detect-duplicate-image-urls.ts --all-adapters [--top-adapters <n>] [--max-results <n>]",
  );
  console.log("");
  console.log("Options:");
  console.log("  --adapter-key <key>   One adapter key (example: elp30a)");
  console.log("  --all-adapters        Scan all adapters under external-sources");
  console.log(
    "  --max-results <n>     Max duplicate URLs to print (default 50)",
  );
  console.log(
    "  --top-adapters <n>    In all-adapters mode, max ranked adapters to print (default 20)",
  );
  console.log("  --help                Show help");
}

function parseArgs(argv: string[]): CliOptions {
  let adapterKey: string | null = null;
  let allAdapters = false;
  let maxResults = 50;
  let topAdapters = 20;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }

    if (arg === "--adapter-key" && next) {
      adapterKey = next.trim().toLowerCase();
      i += 1;
      continue;
    }

    if (arg === "--all-adapters") {
      allAdapters = true;
      continue;
    }

    if (arg === "--max-results" && next) {
      const parsed = Number(next);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("--max-results must be a positive integer");
      }
      maxResults = Math.floor(parsed);
      i += 1;
      continue;
    }

    if (arg === "--top-adapters" && next) {
      const parsed = Number(next);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("--top-adapters must be a positive integer");
      }
      topAdapters = Math.floor(parsed);
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!allAdapters && !adapterKey) {
    throw new Error(
      "Missing required target. Use --adapter-key <adapterKey> or --all-adapters",
    );
  }

  if (allAdapters && adapterKey) {
    throw new Error("Use either --adapter-key or --all-adapters, not both");
  }

  return {
    adapterKey,
    allAdapters,
    maxResults,
    topAdapters,
  };
}

function toObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
}

function resolveListingId(parsed: DetailJson, fileName: string): string {
  if (typeof parsed.external_listing_id === "string") {
    const id = parsed.external_listing_id.trim();
    if (id.length > 0) {
      return id;
    }
  }

  return fileName.replace(/\.json$/i, "");
}

async function analyzeAdapter(input: {
  adapterKey: string;
  maxResults: number;
}): Promise<AdapterDuplicateReport> {
  const detailsDir = path.join(
    process.cwd(),
    "src",
    "lib",
    "data",
    "external-sources",
    input.adapterKey,
    "details",
    "json",
  );

  let files: string[];
  try {
    files = (await fs.readdir(detailsDir))
      .filter((name) => name.endsWith(".json"))
      .filter((name) => name.toLowerCase() !== "index.json")
      .sort();
  } catch {
    throw new Error(`Missing details/json directory for adapter=${input.adapterKey}`);
  }

  const urlToListings = new Map<string, Set<string>>();
  let listingsProcessed = 0;
  let totalImageUrls = 0;

  for (const fileName of files) {
    const filePath = path.join(detailsDir, fileName);

    let parsed: DetailJson;
    try {
      parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as DetailJson;
    } catch {
      continue;
    }

    const listingId = resolveListingId(parsed, fileName);
    const gallery = toObject(parsed.media_gallery);
    const imageUrls = asStringArray(gallery.image_urls);

    listingsProcessed += 1;
    totalImageUrls += imageUrls.length;

    for (const url of imageUrls) {
      const listings = urlToListings.get(url) ?? new Set<string>();
      listings.add(listingId);
      urlToListings.set(url, listings);
    }
  }

  const duplicates: DuplicateEntry[] = [];
  for (const [url, listingSet] of urlToListings.entries()) {
    if (listingSet.size <= 1) {
      continue;
    }
    duplicates.push({
      url,
      count: listingSet.size,
    });
  }

  duplicates.sort((a, b) => {
    const sizeDiff = b.count - a.count;
    if (sizeDiff !== 0) {
      return sizeDiff;
    }
    return a.url.localeCompare(b.url);
  });

  return {
    adapterKey: input.adapterKey,
    listingsProcessed,
    totalImageUrls,
    uniqueImageUrls: urlToListings.size,
    duplicates: duplicates.slice(0, Math.max(input.maxResults, duplicates.length)),
  };
}

async function listAdapterKeysWithDetailsJson(): Promise<string[]> {
  const root = path.join(
    process.cwd(),
    "src",
    "lib",
    "data",
    "external-sources",
  );

  const entries = await fs.readdir(root, { withFileTypes: true });
  const adapters: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const detailsDir = path.join(root, entry.name, "details", "json");
    try {
      const stat = await fs.stat(detailsDir);
      if (stat.isDirectory()) {
        adapters.push(entry.name);
      }
    } catch {
      continue;
    }
  }

  return adapters.sort((a, b) => a.localeCompare(b));
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));

  if (options.allAdapters) {
    const adapterKeys = await listAdapterKeysWithDetailsJson();
    const reports: AdapterDuplicateReport[] = [];

    for (const adapterKey of adapterKeys) {
      try {
        reports.push(
          await analyzeAdapter({
            adapterKey,
            maxResults: options.maxResults,
          }),
        );
      } catch {
        continue;
      }
    }

    reports.sort((a, b) => {
      const duplicateDiff = b.duplicates.length - a.duplicates.length;
      if (duplicateDiff !== 0) {
        return duplicateDiff;
      }
      return a.adapterKey.localeCompare(b.adapterKey);
    });

    console.log("duplicate_image_url_report_all_adapters");
    console.log(`- adapters_scanned: ${reports.length}`);
    console.log(`- ranked_by: duplicate_urls_across_listings`);
    console.log("- leaderboard:");

    for (const report of reports.slice(0, options.topAdapters)) {
      const topCluster = report.duplicates[0]?.count ?? 0;
      console.log(
        `  - adapter=${report.adapterKey} duplicate_urls_across_listings=${report.duplicates.length} top_cluster_count=${topCluster} listings_processed=${report.listingsProcessed} total_image_urls=${report.totalImageUrls}`,
      );
    }

    if (reports.length > options.topAdapters) {
      console.log(
        `- truncated: printed=${options.topAdapters} total=${reports.length}`,
      );
    }

    return 0;
  }

  const report = await analyzeAdapter({
    adapterKey: options.adapterKey as string,
    maxResults: options.maxResults,
  });

  console.log("duplicate_image_url_report");
  console.log(`- adapter: ${report.adapterKey}`);
  console.log(`- listings_processed: ${report.listingsProcessed}`);
  console.log(`- total_image_urls: ${report.totalImageUrls}`);
  console.log(`- unique_image_urls: ${report.uniqueImageUrls}`);
  console.log(`- duplicate_urls_across_listings: ${report.duplicates.length}`);

  if (report.duplicates.length === 0) {
    console.log(
      "- details: no duplicated URLs found across different listings",
    );
    return 0;
  }

  console.log("- top_duplicates:");
  for (const entry of report.duplicates.slice(0, options.maxResults)) {
    console.log(`  - count=${entry.count} url=${entry.url}`);
  }

  if (report.duplicates.length > options.maxResults) {
    console.log(
      `- truncated: printed=${options.maxResults} total=${report.duplicates.length}`,
    );
  }

  return 0;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`duplicate image URL detection failed: ${message}`);
    process.exit(1);
  });
