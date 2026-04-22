import { Chalk } from "chalk";
import { promises as fs } from "node:fs";
import path from "node:path";

type CliOptions = {
  adapterKey: string;
  apply: boolean;
  minDuplicateCount: number;
  minDuplicateRatio: number;
  minImagesRetained: number;
  maxResults: number;
};

type DetailJson = {
  media_gallery?: {
    image_count?: unknown;
    image_urls?: unknown;
  };
};

type ListingRecord = {
  fileName: string;
  filePath: string;
  urls: string[];
  parsed: DetailJson;
};

const chalk = new Chalk({ level: 1 });

function printUsage(): void {
  console.log(
    "Prune highly duplicated image URLs across listings for one adapter",
  );
  console.log("Usage:");
  console.log(
    "  tsx src/lib/scripts/run-prune-duplicate-image-urls.ts --adapter-key <adapterKey> [--apply] [--min-duplicate-count <n>] [--min-duplicate-ratio <r>] [--min-images-retained <n>] [--max-results <n>]",
  );
  console.log("");
  console.log("Options:");
  console.log("  --adapter-key <key>         Required adapter key");
  console.log(
    "  --apply                     Write changes (default is dry-run)",
  );
  console.log(
    "  --min-duplicate-count <n>   Candidate threshold by listing count (default 25)",
  );
  console.log(
    "  --min-duplicate-ratio <r>   Candidate threshold by listing ratio 0-1 (default 0.20)",
  );
  console.log(
    "  --min-images-retained <n>   Never prune below this per listing (default 10)",
  );
  console.log(
    "  --max-results <n>           Max candidate URLs to print (default 20)",
  );
  console.log("  --help                      Show help");
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive number`);
  }
  return Math.floor(parsed);
}

function parseRatio(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    throw new Error(`${flag} must be > 0 and <= 1`);
  }
  return parsed;
}

function parseArgs(argv: string[]): CliOptions {
  let adapterKey = "";
  let apply = false;
  let minDuplicateCount = 25;
  let minDuplicateRatio = 0.2;
  let minImagesRetained = 10;
  let maxResults = 20;

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

    if (arg === "--apply") {
      apply = true;
      continue;
    }

    if (arg === "--min-duplicate-count" && next) {
      minDuplicateCount = parsePositiveInt(next, arg);
      i += 1;
      continue;
    }

    if (arg === "--min-duplicate-ratio" && next) {
      minDuplicateRatio = parseRatio(next, arg);
      i += 1;
      continue;
    }

    if (arg === "--min-images-retained" && next) {
      minImagesRetained = parsePositiveInt(next, arg);
      i += 1;
      continue;
    }

    if (arg === "--max-results" && next) {
      maxResults = parsePositiveInt(next, arg);
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!adapterKey) {
    throw new Error("Missing required --adapter-key <adapterKey>");
  }

  return {
    adapterKey,
    apply,
    minDuplicateCount,
    minDuplicateRatio,
    minImagesRetained,
    maxResults,
  };
}

function asImageUrls(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.startsWith("https://"));
}

async function loadListingRecords(
  detailsDir: string,
): Promise<ListingRecord[]> {
  const fileNames = (await fs.readdir(detailsDir))
    .filter((name) => name.endsWith(".json"))
    .filter((name) => name.toLowerCase() !== "index.json")
    .sort();

  const out: ListingRecord[] = [];

  for (const fileName of fileNames) {
    const filePath = path.join(detailsDir, fileName);
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as DetailJson;
      const urls = asImageUrls(parsed.media_gallery?.image_urls);
      out.push({ fileName, filePath, urls, parsed });
    } catch {
      continue;
    }
  }

  return out;
}

function pickRemovals(input: {
  urls: string[];
  candidateUrls: Set<string>;
  minImagesRetained: number;
}): { kept: string[]; removed: string[] } {
  const kept = [...input.urls];
  const removed: string[] = [];

  for (let i = kept.length - 1; i >= 0; i -= 1) {
    if (kept.length <= input.minImagesRetained) {
      break;
    }

    const url = kept[i];
    if (!url || !input.candidateUrls.has(url)) {
      continue;
    }

    removed.push(url);
    kept.splice(i, 1);
  }

  return { kept, removed: removed.reverse() };
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));

  const detailsDir = path.join(
    process.cwd(),
    "src",
    "lib",
    "data",
    "external-sources",
    options.adapterKey,
    "details",
    "json",
  );

  let records: ListingRecord[];
  try {
    records = await loadListingRecords(detailsDir);
  } catch {
    throw new Error(`Unable to read adapter details directory: ${detailsDir}`);
  }

  const totalListings = records.length;
  if (totalListings === 0) {
    console.log(
      chalk.yellow(
        `No listing JSON records found for adapter=${options.adapterKey}`,
      ),
    );
    return 1;
  }

  const urlToListingCount = new Map<string, number>();
  for (const record of records) {
    const unique = new Set(record.urls);
    for (const url of unique) {
      urlToListingCount.set(url, (urlToListingCount.get(url) ?? 0) + 1);
    }
  }

  const candidates = Array.from(urlToListingCount.entries())
    .filter(([, count]) => {
      const ratio = count / totalListings;
      return (
        count >= options.minDuplicateCount && ratio >= options.minDuplicateRatio
      );
    })
    .sort((a, b) => b[1] - a[1]);

  const candidateUrls = new Set(candidates.map(([url]) => url));

  let affectedListings = 0;
  let removedTotal = 0;

  for (const record of records) {
    if (record.urls.length === 0) {
      continue;
    }

    const { kept, removed } = pickRemovals({
      urls: record.urls,
      candidateUrls,
      minImagesRetained: options.minImagesRetained,
    });

    if (removed.length === 0) {
      continue;
    }

    affectedListings += 1;
    removedTotal += removed.length;

    if (options.apply) {
      record.parsed.media_gallery = {
        ...(record.parsed.media_gallery ?? {}),
        image_count: kept.length,
        image_urls: kept,
      };
      await fs.writeFile(
        `${record.filePath}`,
        `${JSON.stringify(record.parsed, null, 2)}\n`,
        "utf8",
      );
    }
  }

  console.log(chalk.bold("duplicate_image_prune_report"));
  console.log(`- adapter: ${options.adapterKey}`);
  console.log(`- mode: ${options.apply ? "apply" : "dry-run"}`);
  console.log(`- listings_processed: ${totalListings}`);
  console.log(`- candidate_duplicate_urls: ${candidates.length}`);
  console.log(`- affected_listings: ${affectedListings}`);
  console.log(`- removed_image_refs: ${removedTotal}`);
  console.log(`- min_duplicate_count: ${options.minDuplicateCount}`);
  console.log(`- min_duplicate_ratio: ${options.minDuplicateRatio}`);
  console.log(`- min_images_retained: ${options.minImagesRetained}`);

  if (candidates.length > 0) {
    console.log("- top_candidate_urls:");
    for (const [url, count] of candidates.slice(0, options.maxResults)) {
      const ratio = (count / totalListings).toFixed(4);
      console.log(`  - count=${count} ratio=${ratio} url=${url}`);
    }
  }

  if (!options.apply) {
    console.log(
      chalk.cyan("- note: dry-run only; add --apply to persist changes"),
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
    console.error(chalk.red(`duplicate image prune failed: ${message}`));
    process.exit(1);
  });
