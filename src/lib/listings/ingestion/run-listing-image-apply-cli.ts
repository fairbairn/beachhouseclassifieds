import { pgDb } from "@/core/server/db";
import { createScrapeProgress } from "@/core/tooling/terminal/scrape-progress";
import {
  listing,
  listing_source_image,
  listing_source_link,
} from "@/lib/db/schema-postgres";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

type CliOptions = {
  adapterKey: string | null;
  dryRun: boolean;
  progressEvery: number;
  maxListings: number | null;
  allowEmpty: boolean;
};

type SourceLinkSelection = {
  listingId: string;
  sourceLinkId: string;
  adapterKey: string;
  isPrimarySource: boolean;
  confidenceScore: string | null;
  updatedAt: string;
};

type SourceImageRow = {
  sourceLinkId: string;
  sourceImageUrl: string;
  sourceOrder: number;
  sourceContentHash: string | null;
};

type ListingRow = {
  id: string;
  images: unknown;
  imageCount: number;
  imagesVersion: number;
};

type RuntimeImage = {
  src: string;
  sort_order: number;
  alt: string | null;
  content_hash: string | null;
  source: "source" | "site";
};

type ApplySummary = {
  sourceLinksConsidered: number;
  listingCandidates: number;
  listingsEvaluated: number;
  listingsUpdated: number;
  listingsNoChange: number;
  listingsSkippedEmpty: number;
};

function printUsage(): void {
  console.log("Apply Listing Image Projection");
  console.log("Usage:");
  console.log(
    "  tsx src/lib/scripts/run-listing-image-apply.ts [--adapter-key <key>] [--dry-run] [--progress-every <n>] [--max-listings <n>] [--allow-empty]",
  );
  console.log("");
  console.log("Options:");
  console.log("  --adapter-key <key>     Restrict to one adapter");
  console.log("  --dry-run               Evaluate only; no DB writes");
  console.log(
    "  --progress-every <n>    Emit progress line every n listings (default 100)",
  );
  console.log("  --max-listings <n>      Limit listing candidates to apply");
  console.log(
    "  --allow-empty           Allow writing empty image projections",
  );
  console.log("  --help                  Show help");
}

function parseArgs(argv: string[]): CliOptions {
  let adapterKey: string | null = null;
  let dryRun = false;
  let progressEvery = 100;
  let maxListings: number | null = null;
  let allowEmpty = false;

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
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("--progress-every must be a positive integer");
      }
      progressEvery = Math.floor(parsed);
      i += 1;
      continue;
    }

    if (arg === "--max-listings" && next) {
      const parsed = Number(next);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("--max-listings must be a positive integer");
      }
      maxListings = Math.floor(parsed);
      i += 1;
      continue;
    }

    if (arg === "--allow-empty") {
      allowEmpty = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    adapterKey,
    dryRun,
    progressEvery,
    maxListings,
    allowEmpty,
  };
}

function parseConfidence(value: string | null): number {
  if (!value) {
    return -1;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : -1;
}

function chooseBestSourceLink(
  links: SourceLinkSelection[],
): SourceLinkSelection | null {
  if (links.length === 0) {
    return null;
  }

  const sorted = [...links].sort((a, b) => {
    if (a.isPrimarySource !== b.isPrimarySource) {
      return a.isPrimarySource ? -1 : 1;
    }

    const confidenceDiff =
      parseConfidence(b.confidenceScore) - parseConfidence(a.confidenceScore);
    if (confidenceDiff !== 0) {
      return confidenceDiff;
    }

    return b.updatedAt.localeCompare(a.updatedAt);
  });

  return sorted[0] ?? null;
}

function asRuntimeImages(value: unknown): RuntimeImage[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const out: RuntimeImage[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }

    const item = entry as Record<string, unknown>;
    const src = typeof item.src === "string" ? item.src.trim() : "";
    if (!src) {
      continue;
    }

    const sortOrderRaw = item.sort_order;
    const sortOrder =
      typeof sortOrderRaw === "number" && Number.isFinite(sortOrderRaw)
        ? Math.floor(sortOrderRaw)
        : out.length;

    const sourceRaw = typeof item.source === "string" ? item.source : "source";
    out.push({
      src,
      sort_order: sortOrder,
      alt: typeof item.alt === "string" ? item.alt : null,
      content_hash:
        typeof item.content_hash === "string" ? item.content_hash : null,
      source: sourceRaw === "site" ? "site" : "source",
    });
  }

  return out.sort((a, b) => a.sort_order - b.sort_order);
}

function buildRuntimeImages(rows: SourceImageRow[]): RuntimeImage[] {
  return [...rows]
    .sort((a, b) => a.sourceOrder - b.sourceOrder)
    .map((row) => ({
      src: row.sourceImageUrl,
      sort_order: row.sourceOrder,
      alt: null,
      content_hash: row.sourceContentHash,
      source: "source",
    }));
}

function isSameProjection(a: RuntimeImage[], b: RuntimeImage[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export async function runListingImageApplyCli(
  argv: string[] = process.argv.slice(2),
): Promise<number> {
  const options = parseArgs(argv);
  const progress = createScrapeProgress({ script: "listing-image-apply" });

  if (!pgDb) {
    progress.failure("Postgres DB is not configured for this environment.");
    return 1;
  }

  progress.phase("loading active source links");

  const sourceLinks = await pgDb
    .select({
      listingId: listing_source_link.listing_id,
      sourceLinkId: listing_source_link.id,
      adapterKey: listing_source_link.adapter_key,
      isPrimarySource: listing_source_link.is_primary_source,
      confidenceScore: listing_source_link.confidence_score,
      updatedAt: listing_source_link.updated_at,
    })
    .from(listing_source_link)
    .where(
      and(
        eq(listing_source_link.source_status, "active"),
        isNull(listing_source_link.active_to),
        options.adapterKey
          ? eq(listing_source_link.adapter_key, options.adapterKey)
          : sql`true`,
      ),
    );

  const linksByListing = new Map<string, SourceLinkSelection[]>();
  for (const link of sourceLinks) {
    const bucket = linksByListing.get(link.listingId) ?? [];
    bucket.push(link);
    linksByListing.set(link.listingId, bucket);
  }

  const chosenLinks: SourceLinkSelection[] = [];
  for (const [listingId, links] of linksByListing.entries()) {
    const chosen = chooseBestSourceLink(links);
    if (!chosen) {
      continue;
    }
    chosenLinks.push({ ...chosen, listingId });
  }

  chosenLinks.sort((a, b) => a.listingId.localeCompare(b.listingId));

  let candidates = chosenLinks;
  if (options.maxListings !== null) {
    candidates = candidates.slice(0, options.maxListings);
  }

  if (candidates.length === 0) {
    progress.failure("No listing source-link candidates found to apply.");
    return 1;
  }

  const sourceLinkIds = candidates.map((entry) => entry.sourceLinkId);
  const listingIds = candidates.map((entry) => entry.listingId);

  progress.phase("loading source images and listing projection state");

  const sourceImageRows = await pgDb
    .select({
      sourceLinkId: listing_source_image.source_link_id,
      sourceImageUrl: listing_source_image.source_image_url,
      sourceOrder: listing_source_image.source_order,
      sourceContentHash: listing_source_image.source_content_hash,
    })
    .from(listing_source_image)
    .where(inArray(listing_source_image.source_link_id, sourceLinkIds));

  const imageRowsBySourceLink = new Map<string, SourceImageRow[]>();
  for (const row of sourceImageRows) {
    const bucket = imageRowsBySourceLink.get(row.sourceLinkId) ?? [];
    bucket.push(row);
    imageRowsBySourceLink.set(row.sourceLinkId, bucket);
  }

  const listingRows = await pgDb
    .select({
      id: listing.id,
      images: listing.images,
      imageCount: listing.image_count,
      imagesVersion: listing.images_version,
    })
    .from(listing)
    .where(inArray(listing.id, listingIds));

  const listingById = new Map<string, ListingRow>();
  for (const row of listingRows) {
    listingById.set(row.id, row);
  }

  progress.info(
    `source_links_considered=${sourceLinks.length} listing_candidates=${candidates.length} dry_run=${options.dryRun}`,
  );

  let listingsEvaluated = 0;
  let listingsUpdated = 0;
  let listingsNoChange = 0;
  let listingsSkippedEmpty = 0;

  for (const candidate of candidates) {
    listingsEvaluated += 1;
    if (listingsEvaluated % options.progressEvery === 0) {
      progress.progress(
        `listings_processed=${listingsEvaluated}/${candidates.length} updated=${listingsUpdated} unchanged=${listingsNoChange} skipped_empty=${listingsSkippedEmpty}`,
      );
    }

    const row = listingById.get(candidate.listingId);
    if (!row) {
      continue;
    }

    const sourceRows = imageRowsBySourceLink.get(candidate.sourceLinkId) ?? [];
    const nextImages = buildRuntimeImages(sourceRows);

    if (nextImages.length === 0 && !options.allowEmpty) {
      listingsSkippedEmpty += 1;
      continue;
    }

    const currentImages = asRuntimeImages(row.images);
    if (isSameProjection(currentImages, nextImages)) {
      listingsNoChange += 1;
      continue;
    }

    listingsUpdated += 1;
    if (options.dryRun) {
      continue;
    }

    await pgDb
      .update(listing)
      .set({
        images: nextImages,
        image_count: nextImages.length,
        images_version: Math.max(1, row.imagesVersion + 1),
        updated_at: sql`now()`,
      })
      .where(eq(listing.id, candidate.listingId));
  }

  const summary: ApplySummary = {
    sourceLinksConsidered: sourceLinks.length,
    listingCandidates: candidates.length,
    listingsEvaluated,
    listingsUpdated,
    listingsNoChange,
    listingsSkippedEmpty,
  };

  progress.success(
    `apply_complete source_links_considered=${summary.sourceLinksConsidered} listing_candidates=${summary.listingCandidates} evaluated=${summary.listingsEvaluated} updated=${summary.listingsUpdated} unchanged=${summary.listingsNoChange} skipped_empty=${summary.listingsSkippedEmpty} dry_run=${options.dryRun}`,
  );

  console.log("listing_image_apply_complete");
  console.log(`- source_links_considered: ${summary.sourceLinksConsidered}`);
  console.log(`- listing_candidates: ${summary.listingCandidates}`);
  console.log(`- listings_evaluated: ${summary.listingsEvaluated}`);
  console.log(`- listings_updated: ${summary.listingsUpdated}`);
  console.log(`- listings_unchanged: ${summary.listingsNoChange}`);
  console.log(`- listings_skipped_empty: ${summary.listingsSkippedEmpty}`);
  console.log(`- dry_run: ${options.dryRun}`);

  return 0;
}
