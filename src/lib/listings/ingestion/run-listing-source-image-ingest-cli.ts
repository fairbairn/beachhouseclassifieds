import { pgDb } from "@/core/server/db";
import { createScrapeProgress } from "@/core/tooling/terminal/scrape-progress";
import {
  listing_source_image,
  listing_source_link,
} from "@/lib/db/schema-postgres";
import {
  canonicalizeExternalListingId,
  externalListingIdFromDetailUrl,
} from "@/lib/pricing/shared/external-listing-id";
import { eq, sql } from "drizzle-orm";
import { promises as fs } from "node:fs";
import path from "node:path";

type CliOptions = {
  adapterKey: string | null;
  dryRun: boolean;
  progressEvery: number;
  maxListings: number | null;
};

type SourceLinkRow = {
  id: string;
  adapter_key: string;
  external_listing_id: string;
};

type IngestCandidate = {
  sourceLinkId: string;
  adapterKey: string;
  externalListingId: string;
  imageUrls: string[];
  expectedCount: number | null;
  sourceFile: string;
};

type IngestSummary = {
  adaptersScanned: number;
  filesScanned: number;
  candidatesMatched: number;
  candidatesUnmatched: number;
  candidatesDuplicateKey: number;
  rowsPrepared: number;
  sourceLinkRowsUpdated: number;
};

function printUsage(): void {
  console.log("Ingest Listing Source Images");
  console.log("Usage:");
  console.log(
    "  tsx src/lib/scripts/run-listing-source-image-ingest.ts [--adapter-key <key>] [--dry-run] [--progress-every <n>] [--max-listings <n>]",
  );
  console.log("");
  console.log("Options:");
  console.log("  --adapter-key <key>     Restrict to one adapter");
  console.log("  --dry-run               Parse and report only; no DB writes");
  console.log(
    "  --progress-every <n>    Emit progress line every n files (default 100)",
  );
  console.log(
    "  --max-listings <n>      Limit number of matched source links to apply",
  );
  console.log("  --help                  Show help");
}

function parseArgs(argv: string[]): CliOptions {
  let adapterKey: string | null = null;
  let dryRun = false;
  let progressEvery = 100;
  let maxListings: number | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }

    if (arg === "--adapter-key" && next) {
      adapterKey = next.trim().toLowerCase() || null;
      i += 1;
      continue;
    }

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (arg === "--progress-every" && next) {
      const parsed = Number(next);
      if (Number.isFinite(parsed) && parsed > 0) {
        progressEvery = Math.floor(parsed);
      } else {
        throw new Error("--progress-every must be a positive integer");
      }
      i += 1;
      continue;
    }

    if (arg === "--max-listings" && next) {
      const parsed = Number(next);
      if (Number.isFinite(parsed) && parsed > 0) {
        maxListings = Math.floor(parsed);
      } else {
        throw new Error("--max-listings must be a positive integer");
      }
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    adapterKey,
    dryRun,
    progressEvery,
    maxListings,
  };
}

function toObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function readExpectedImageCount(
  parsed: Record<string, unknown>,
): number | null {
  const mediaGallery = toObject(parsed.media_gallery);
  const countValue = mediaGallery.image_count;

  if (typeof countValue === "number" && Number.isFinite(countValue)) {
    return Math.max(0, Math.floor(countValue));
  }

  if (typeof countValue === "string" && countValue.trim().length > 0) {
    const parsedNumber = Number(countValue);
    if (Number.isFinite(parsedNumber)) {
      return Math.max(0, Math.floor(parsedNumber));
    }
  }

  return null;
}

function readImageUrls(parsed: Record<string, unknown>): string[] {
  const mediaGallery = toObject(parsed.media_gallery);
  const imageUrls = mediaGallery.image_urls;
  if (!Array.isArray(imageUrls)) {
    return [];
  }

  return imageUrls
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => value.length > 0);
}

function resolveDetailExternalListingId(
  parsed: Record<string, unknown>,
  fileName: string,
): string {
  const externalListingId =
    typeof parsed.external_listing_id === "string"
      ? parsed.external_listing_id.trim()
      : "";

  if (externalListingId.length > 0) {
    return canonicalizeExternalListingId(externalListingId);
  }

  const detailUrl =
    typeof parsed.detail_url === "string" ? parsed.detail_url.trim() : "";
  if (detailUrl.length > 0) {
    const derived = externalListingIdFromDetailUrl(detailUrl);
    if (derived.length > 0) {
      return derived;
    }
  }

  const baseName = fileName.endsWith(".json")
    ? fileName.slice(0, -".json".length)
    : fileName;
  return canonicalizeExternalListingId(baseName);
}

async function listAdapterKeys(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith("."))
    .sort();
}

async function listJsonFiles(dirPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .filter((entry) => entry.name.toLowerCase() !== "index.json")
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function buildSourceLinkKey(
  adapterKey: string,
  externalListingId: string,
): string {
  return `${adapterKey}::${canonicalizeExternalListingId(externalListingId)}`;
}

export async function runListingSourceImageIngestCli(
  argv: string[] = process.argv.slice(2),
): Promise<number> {
  const options = parseArgs(argv);
  const progress = createScrapeProgress({
    script: "listing-source-image-ingest",
  });

  if (!pgDb) {
    progress.failure("Postgres DB is not configured for this environment.");
    return 1;
  }

  const root = process.cwd();
  const externalSourcesRoot = path.join(
    root,
    "src",
    "lib",
    "data",
    "external-sources",
  );

  let adapterKeys = await listAdapterKeys(externalSourcesRoot);
  if (options.adapterKey) {
    adapterKeys = adapterKeys.filter((key) => key === options.adapterKey);
  }

  if (adapterKeys.length === 0) {
    progress.failure("No adapters found to ingest.");
    return 1;
  }

  progress.phase("loading listing source links from postgres");

  const sourceLinks: SourceLinkRow[] = await pgDb
    .select({
      id: listing_source_link.id,
      adapter_key: listing_source_link.adapter_key,
      external_listing_id: listing_source_link.external_listing_id,
    })
    .from(listing_source_link)
    .where(
      options.adapterKey
        ? eq(listing_source_link.adapter_key, options.adapterKey)
        : sql`true`,
    );

  const sourceLinkByKey = new Map<string, SourceLinkRow>();
  for (const link of sourceLinks) {
    const key = buildSourceLinkKey(link.adapter_key, link.external_listing_id);
    if (!sourceLinkByKey.has(key)) {
      sourceLinkByKey.set(key, link);
    }
  }

  progress.info(
    `source_links_loaded=${sourceLinks.length} adapter_scope=${options.adapterKey ?? "all"}`,
  );

  const candidateBySourceLinkId = new Map<string, IngestCandidate>();
  let filesScanned = 0;
  let candidatesUnmatched = 0;
  let candidatesDuplicateKey = 0;

  for (const adapterKey of adapterKeys) {
    const jsonDir = path.join(
      externalSourcesRoot,
      adapterKey,
      "details",
      "json",
    );
    const files = await listJsonFiles(jsonDir);

    progress.info(`adapter=${adapterKey} detail_json_files=${files.length}`);

    for (const fileName of files) {
      filesScanned += 1;
      if (filesScanned % options.progressEvery === 0) {
        progress.progress(
          `files_scanned=${filesScanned} matched=${candidateBySourceLinkId.size}`,
        );
      }

      const filePath = path.join(jsonDir, fileName);

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<
          string,
          unknown
        >;
      } catch {
        continue;
      }

      const externalListingId = resolveDetailExternalListingId(
        parsed,
        fileName,
      );
      if (!externalListingId) {
        continue;
      }

      const sourceLink = sourceLinkByKey.get(
        buildSourceLinkKey(adapterKey, externalListingId),
      );
      if (!sourceLink) {
        candidatesUnmatched += 1;
        continue;
      }

      const imageUrls = readImageUrls(parsed);
      const expectedCount = readExpectedImageCount(parsed);

      if (candidateBySourceLinkId.has(sourceLink.id)) {
        candidatesDuplicateKey += 1;
      }

      candidateBySourceLinkId.set(sourceLink.id, {
        sourceLinkId: sourceLink.id,
        adapterKey,
        externalListingId,
        imageUrls,
        expectedCount,
        sourceFile: filePath,
      });
    }
  }

  let candidates = Array.from(candidateBySourceLinkId.values());
  if (options.maxListings !== null) {
    candidates = candidates.slice(0, options.maxListings);
  }

  const rowsPrepared = candidates.reduce(
    (sum, candidate) => sum + candidate.imageUrls.length,
    0,
  );

  progress.phase("preparing ingest summary");
  progress.info(
    `adapters_scanned=${adapterKeys.length} files_scanned=${filesScanned} matched_candidates=${candidates.length} unmatched_candidates=${candidatesUnmatched} duplicate_candidate_keys=${candidatesDuplicateKey} rows_prepared=${rowsPrepared} dry_run=${options.dryRun}`,
  );

  if (!options.dryRun && candidates.length > 0) {
    progress.phase("writing listing_source_image rows and source_link counts");

    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];

      if ((index + 1) % options.progressEvery === 0) {
        progress.progress(
          `candidates_processed=${index + 1}/${candidates.length} source_link_id=${candidate.sourceLinkId}`,
        );
      }

      await pgDb.transaction(async (tx) => {
        await tx
          .delete(listing_source_image)
          .where(
            eq(listing_source_image.source_link_id, candidate.sourceLinkId),
          );

        if (candidate.imageUrls.length > 0) {
          await tx.insert(listing_source_image).values(
            candidate.imageUrls.map((sourceImageUrl, sourceOrder) => ({
              id: `${candidate.sourceLinkId}:${sourceOrder}`,
              source_link_id: candidate.sourceLinkId,
              source_image_url: sourceImageUrl,
              source_order: sourceOrder,
              source_content_hash: null,
              site_image: null,
              status: "ready_source",
              error_payload: {},
            })),
          );
        }

        await tx
          .update(listing_source_link)
          .set({
            source_image_count_expected: candidate.expectedCount,
            source_image_count_ingested: candidate.imageUrls.length,
            source_image_count_verified_at: sql`now()`,
            updated_at: sql`now()`,
          })
          .where(eq(listing_source_link.id, candidate.sourceLinkId));
      });
    }
  }

  const summary: IngestSummary = {
    adaptersScanned: adapterKeys.length,
    filesScanned,
    candidatesMatched: candidates.length,
    candidatesUnmatched,
    candidatesDuplicateKey,
    rowsPrepared,
    sourceLinkRowsUpdated: candidates.length,
  };

  progress.success(
    `ingest_complete adapters_scanned=${summary.adaptersScanned} files_scanned=${summary.filesScanned} matched=${summary.candidatesMatched} unmatched=${summary.candidatesUnmatched} duplicate_keys=${summary.candidatesDuplicateKey} source_image_rows=${summary.rowsPrepared} source_link_rows_updated=${summary.sourceLinkRowsUpdated} dry_run=${options.dryRun}`,
  );

  console.log("listing_source_image_ingest_complete");
  console.log(`- adapters_scanned: ${summary.adaptersScanned}`);
  console.log(`- files_scanned: ${summary.filesScanned}`);
  console.log(`- matched_candidates: ${summary.candidatesMatched}`);
  console.log(`- unmatched_candidates: ${summary.candidatesUnmatched}`);
  console.log(`- duplicate_candidate_keys: ${summary.candidatesDuplicateKey}`);
  console.log(`- source_image_rows_prepared: ${summary.rowsPrepared}`);
  console.log(`- source_link_rows_updated: ${summary.sourceLinkRowsUpdated}`);
  console.log(`- dry_run: ${options.dryRun}`);

  return 0;
}
