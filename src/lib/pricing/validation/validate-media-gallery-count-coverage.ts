import { Chalk } from "chalk";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { selectCanonicalListings } from "@/lib/pricing/shared/canonical-index-listings";

type CliOptions = {
  adapterKey: string;
  listingId: string | null;
  maxListings: number | null;
  minImages: number;
  summaryOnly: boolean;
  strict: boolean;
};

type DetailRecord = {
  media_gallery?: {
    image_urls?: unknown;
  };
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

const chalk = new Chalk({ level: 1 });

function printUsage(): void {
  console.log("Validate media_gallery image coverage");
  console.log("Usage:");
  console.log(
    "  tsx src/lib/pricing/validation/validate-media-gallery-count-coverage.ts --adapter-key <key> [--listing-id <id>] [--max-listings <n>] [--min-images <n>] [--strict] [--summary-only]",
  );
  console.log("");
  console.log("Options:");
  console.log("  --adapter-key <key>  Required adapter key");
  console.log("  --listing-id <id>    Restrict to one listing");
  console.log("  --max-listings <n>   Limit selected listings");
  console.log("  --min-images <n>     Warning threshold (default 10)");
  console.log("  --strict             Fail if any listing is below threshold");
  console.log("  --summary-only       Suppress per-listing logs");
  console.log("  --help               Show help");
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return Math.floor(parsed);
}

function parseArgs(argv: string[]): CliOptions {
  let adapterKey: string | null = null;
  let listingId: string | null = null;
  let maxListings: number | null = null;
  let minImages = 10;
  let summaryOnly = false;
  let strict = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    if ((arg === "--help" || arg === "-h") && !value) {
      printUsage();
      process.exit(0);
    }

    if (arg === "--adapter-key" && value) {
      adapterKey = value.trim().toLowerCase();
      index += 1;
      continue;
    }

    if ((arg === "--listing-id" || arg === "--external-listing-id") && value) {
      listingId = value.trim() || null;
      index += 1;
      continue;
    }

    if (arg === "--max-listings" && value) {
      maxListings = parsePositiveInt(value, arg);
      index += 1;
      continue;
    }

    if (arg === "--min-images" && value) {
      minImages = parsePositiveInt(value, arg);
      index += 1;
      continue;
    }

    if (arg === "--summary-only") {
      summaryOnly = true;
      continue;
    }

    if (arg === "--strict") {
      strict = true;
      continue;
    }

    if (arg.startsWith("--")) {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!adapterKey) {
    throw new Error("Missing required --adapter-key <adapterKey>");
  }

  return {
    adapterKey,
    listingId,
    maxListings,
    minImages,
    summaryOnly,
    strict,
  };
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
}

function isNonBookableOnlineExempt(record: DetailRecord): boolean {
  if (record.listing_flags?.non_bookable_online === true) {
    return true;
  }

  if (
    record.listing_flags?.availability_validation_exempt === true ||
    record.normalized_availability?.validation_exempt === true
  ) {
    return true;
  }

  const reasonCandidates = [
    record.listing_flags?.availability_validation_exempt_reason_code,
    record.normalized_availability?.validation_exempt_reason_code,
  ];

  return reasonCandidates.some(
    (value) =>
      typeof value === "string" &&
      value.trim().toLowerCase() === "non_bookable_online",
  );
}

export async function runValidateMediaGalleryCountCoverageCli(
  argv: string[] = process.argv.slice(2),
): Promise<number> {
  const options = parseArgs(argv);

  const listings = await selectCanonicalListings({
    adapterKey: options.adapterKey,
    listingId: options.listingId,
    maxListings: options.maxListings,
  });

  if (listings.length === 0) {
    console.error(
      `No active listings selected for adapter=${options.adapterKey}`,
    );
    return 1;
  }

  const detailsDir = resolve(
    process.cwd(),
    "src",
    "lib",
    "data",
    "external-sources",
    options.adapterKey,
    "details",
    "json",
  );

  let belowThreshold = 0;
  let belowThresholdWaivedNonBookable = 0;
  let missingFile = 0;
  let processed = 0;

  if (!options.summaryOnly) {
    console.log(
      chalk.cyan(
        `media gallery count validation adapter=${options.adapterKey} selected=${listings.length} min_images=${options.minImages} strict=${options.strict}`,
      ),
    );
  }

  for (const listing of listings) {
    processed += 1;
    const candidateBases = Array.from(
      new Set([
        listing.fileId,
        listing.externalListingId,
        listing.detailFileBaseName,
      ]),
    ).filter(Boolean);

    let detail: DetailRecord | null = null;
    let fileName = "";

    for (const base of candidateBases) {
      const candidateName = `${base}.json`;
      try {
        const raw = await readFile(resolve(detailsDir, candidateName), "utf8");
        detail = JSON.parse(raw) as DetailRecord;
        fileName = candidateName;
        break;
      } catch {
        // try next base
      }
    }

    if (!detail) {
      missingFile += 1;
      if (!options.summaryOnly) {
        console.log(
          chalk.yellow(
            `[${processed}/${listings.length}] missing file listing=${listing.externalListingId}`,
          ),
        );
      }
      continue;
    }

    const count = asStringArray(detail.media_gallery?.image_urls).length;
    if (count < options.minImages) {
      if (isNonBookableOnlineExempt(detail)) {
        belowThresholdWaivedNonBookable += 1;
        if (!options.summaryOnly) {
          console.log(
            chalk.gray(
              `[${processed}/${listings.length}] waived low image count listing=${listing.externalListingId} file=${fileName} images=${count} reason=non_bookable_online`,
            ),
          );
        }
        continue;
      }

      belowThreshold += 1;
      if (!options.summaryOnly) {
        console.log(
          chalk.yellow(
            `[${processed}/${listings.length}] low image count listing=${listing.externalListingId} file=${fileName} images=${count} min=${options.minImages}`,
          ),
        );
      }
    }
  }

  console.log(chalk.bold("media_gallery_count_validation_summary"));
  console.log(`- adapter: ${options.adapterKey}`);
  console.log(`- listings_selected: ${listings.length}`);
  console.log(`- listings_missing_file: ${missingFile}`);
  console.log(`- listings_below_threshold: ${belowThreshold}`);
  console.log(
    `- listings_below_threshold_waived_non_bookable_online: ${belowThresholdWaivedNonBookable}`,
  );
  console.log(`- min_images_threshold: ${options.minImages}`);
  console.log(`- strict_mode: ${options.strict}`);

  if (missingFile > 0) {
    console.error(
      chalk.red(`Validation failed: missing detail files=${missingFile}`),
    );
    return 1;
  }

  if (options.strict && belowThreshold > 0) {
    console.error(
      chalk.red(
        `Validation failed: listings below image threshold=${belowThreshold}`,
      ),
    );
    return 1;
  }

  if (belowThreshold > 0) {
    console.log(
      chalk.yellow(
        `Validation warning: listings below image threshold=${belowThreshold}`,
      ),
    );
  }

  return 0;
}
