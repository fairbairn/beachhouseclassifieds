import { pgDb } from "@/core/server/db";
import {
  listing_source_image,
  listing_source_link,
} from "@/lib/db/schema-postgres";
import { eq, sql } from "drizzle-orm";
import { promises as fs } from "node:fs";
import path from "node:path";

type CliOptions = {
  adapterKey: string | null;
  strict: boolean;
  requireDeclaredCount: boolean;
  skipDb: boolean;
  json: boolean;
};

type AdapterSummary = {
  adapter: string;
  files: number;
  declaredCountListings: number;
  missingDeclaredCountListings: number;
  mismatchListings: number;
  totalImageUrls: number;
  totalDeclaredImageCount: number;
  dbSourceImageRows: number;
  dbSourceLinkExpectedCount: number;
  dbSourceLinkIngestedCount: number;
  fileVsDbRowDelta: number;
  fileVsSourceLinkExpectedDelta: number;
  fileVsSourceLinkIngestedDelta: number;
};

export type SourceImageCountValidationSummary = {
  adaptersChecked: number;
  filesChecked: number;
  listingsWithDeclaredCount: number;
  listingsMissingDeclaredCount: number;
  listingsWithCountMismatch: number;
  totalImageUrls: number;
  totalDeclaredImageCount: number;
  totalDbSourceImageRows: number;
  totalDbSourceLinkExpectedCount: number;
  totalDbSourceLinkIngestedCount: number;
  dbAvailable: boolean;
  adaptersWithDbRowMismatch: number;
  adaptersWithSourceLinkExpectedMismatch: number;
  adaptersWithSourceLinkIngestedMismatch: number;
  adapters: AdapterSummary[];
};

function printUsage(): void {
  console.log("Validate Source Image Counts");
  console.log("Usage:");
  console.log(
    "  tsx src/lib/scripts/run-source-image-count-validation.ts [--adapter-key <key>] [--strict] [--require-declared-count] [--skip-db] [--json]",
  );
  console.log("");
  console.log("Options:");
  console.log("  --adapter-key <key>        Validate one adapter only");
  console.log(
    "  --strict                   Exit 1 on any count mismatch or missing declared count",
  );
  console.log(
    "  --require-declared-count   Exit 1 if any listing is missing declared image count",
  );
  console.log(
    "  --skip-db                  Disable DB-backed count comparisons",
  );
  console.log("  --json                     Output JSON summary");
  console.log("  --help                     Show help");
}

function parseArgs(argv: string[]): CliOptions {
  let adapterKey: string | null = null;
  let strict = false;
  let requireDeclaredCount = false;
  let skipDb = false;
  let json = false;

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

    if (arg === "--strict") {
      strict = true;
      continue;
    }

    if (arg === "--require-declared-count") {
      requireDeclaredCount = true;
      continue;
    }

    if (arg === "--skip-db") {
      skipDb = true;
      continue;
    }

    if (arg === "--json") {
      json = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    adapterKey,
    strict,
    requireDeclaredCount,
    skipDb,
    json,
  };
}

async function loadDbCountsByAdapter(adapter: string): Promise<{
  dbSourceImageRows: number;
  dbSourceLinkExpectedCount: number;
  dbSourceLinkIngestedCount: number;
}> {
  if (!pgDb) {
    return {
      dbSourceImageRows: 0,
      dbSourceLinkExpectedCount: 0,
      dbSourceLinkIngestedCount: 0,
    };
  }

  const sourceImageRows = await pgDb
    .select({ count: sql<number>`count(*)::int` })
    .from(listing_source_image)
    .innerJoin(
      listing_source_link,
      eq(listing_source_image.source_link_id, listing_source_link.id),
    )
    .where(eq(listing_source_link.adapter_key, adapter));

  const sourceLinkCounts = await pgDb
    .select({
      expected: sql<number>`coalesce(sum(${listing_source_link.source_image_count_expected}), 0)::int`,
      ingested: sql<number>`coalesce(sum(${listing_source_link.source_image_count_ingested}), 0)::int`,
    })
    .from(listing_source_link)
    .where(eq(listing_source_link.adapter_key, adapter));

  return {
    dbSourceImageRows: sourceImageRows[0]?.count ?? 0,
    dbSourceLinkExpectedCount: sourceLinkCounts[0]?.expected ?? 0,
    dbSourceLinkIngestedCount: sourceLinkCounts[0]?.ingested ?? 0,
  };
}

async function listAdapterDirs(externalSourcesRoot: string): Promise<string[]> {
  const entries = await fs.readdir(externalSourcesRoot, {
    withFileTypes: true,
  });

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith("."))
    .sort();
}

async function listDetailJsonFiles(jsonDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(jsonDir, { withFileTypes: true });

    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .filter((entry) => entry.name.toLowerCase() !== "index.json")
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function toObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function readImageUrlsCount(parsed: Record<string, unknown>): number {
  const mediaGallery = toObject(parsed.media_gallery);
  const imageUrls = mediaGallery.image_urls;
  if (!Array.isArray(imageUrls)) {
    return 0;
  }

  return imageUrls.reduce((count, value) => {
    return typeof value === "string" && value.trim().length > 0
      ? count + 1
      : count;
  }, 0);
}

function readDeclaredImageCount(
  parsed: Record<string, unknown>,
): number | null {
  const mediaGallery = toObject(parsed.media_gallery);

  const imageCount = mediaGallery.image_count;
  if (typeof imageCount === "number" && Number.isFinite(imageCount)) {
    return Math.max(0, Math.floor(imageCount));
  }

  if (typeof imageCount === "string" && imageCount.trim().length > 0) {
    const parsedNumber = Number(imageCount);
    if (Number.isFinite(parsedNumber)) {
      return Math.max(0, Math.floor(parsedNumber));
    }
  }

  return null;
}

async function validateAdapter(
  adapter: string,
  externalSourcesRoot: string,
  includeDb: boolean,
): Promise<AdapterSummary> {
  const jsonDir = path.join(externalSourcesRoot, adapter, "details", "json");
  const files = await listDetailJsonFiles(jsonDir);

  let declaredCountListings = 0;
  let missingDeclaredCountListings = 0;
  let mismatchListings = 0;
  let totalImageUrls = 0;
  let totalDeclaredImageCount = 0;
  let dbSourceImageRows = 0;
  let dbSourceLinkExpectedCount = 0;
  let dbSourceLinkIngestedCount = 0;

  for (const fileName of files) {
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

    const imageUrlsCount = readImageUrlsCount(parsed);
    const declaredImageCount = readDeclaredImageCount(parsed);

    totalImageUrls += imageUrlsCount;

    if (declaredImageCount === null) {
      missingDeclaredCountListings += 1;
      continue;
    }

    declaredCountListings += 1;
    totalDeclaredImageCount += declaredImageCount;

    if (declaredImageCount !== imageUrlsCount) {
      mismatchListings += 1;
    }
  }

  if (includeDb) {
    const dbCounts = await loadDbCountsByAdapter(adapter);
    dbSourceImageRows = dbCounts.dbSourceImageRows;
    dbSourceLinkExpectedCount = dbCounts.dbSourceLinkExpectedCount;
    dbSourceLinkIngestedCount = dbCounts.dbSourceLinkIngestedCount;
  }

  return {
    adapter,
    files: files.length,
    declaredCountListings,
    missingDeclaredCountListings,
    mismatchListings,
    totalImageUrls,
    totalDeclaredImageCount,
    dbSourceImageRows,
    dbSourceLinkExpectedCount,
    dbSourceLinkIngestedCount,
    fileVsDbRowDelta: totalImageUrls - dbSourceImageRows,
    fileVsSourceLinkExpectedDelta: totalImageUrls - dbSourceLinkExpectedCount,
    fileVsSourceLinkIngestedDelta: totalImageUrls - dbSourceLinkIngestedCount,
  };
}

export async function runValidateSourceImageCountsCli(
  argv: string[] = process.argv.slice(2),
): Promise<number> {
  const options = parseArgs(argv);
  const root = process.cwd();
  const externalSourcesRoot = path.join(
    root,
    "src",
    "lib",
    "data",
    "external-sources",
  );

  const includeDb = !options.skipDb && Boolean(pgDb);

  let adapters = await listAdapterDirs(externalSourcesRoot);
  if (options.adapterKey) {
    adapters = adapters.filter((adapter) => adapter === options.adapterKey);
  }

  if (adapters.length === 0) {
    console.error("No adapters found for source image count validation.");
    return 1;
  }

  const adapterSummaries: AdapterSummary[] = [];
  for (const adapter of adapters) {
    adapterSummaries.push(
      await validateAdapter(adapter, externalSourcesRoot, includeDb),
    );
  }

  const summary: SourceImageCountValidationSummary = {
    adaptersChecked: adapterSummaries.length,
    filesChecked: adapterSummaries.reduce((sum, row) => sum + row.files, 0),
    listingsWithDeclaredCount: adapterSummaries.reduce(
      (sum, row) => sum + row.declaredCountListings,
      0,
    ),
    listingsMissingDeclaredCount: adapterSummaries.reduce(
      (sum, row) => sum + row.missingDeclaredCountListings,
      0,
    ),
    listingsWithCountMismatch: adapterSummaries.reduce(
      (sum, row) => sum + row.mismatchListings,
      0,
    ),
    totalImageUrls: adapterSummaries.reduce(
      (sum, row) => sum + row.totalImageUrls,
      0,
    ),
    totalDeclaredImageCount: adapterSummaries.reduce(
      (sum, row) => sum + row.totalDeclaredImageCount,
      0,
    ),
    totalDbSourceImageRows: adapterSummaries.reduce(
      (sum, row) => sum + row.dbSourceImageRows,
      0,
    ),
    totalDbSourceLinkExpectedCount: adapterSummaries.reduce(
      (sum, row) => sum + row.dbSourceLinkExpectedCount,
      0,
    ),
    totalDbSourceLinkIngestedCount: adapterSummaries.reduce(
      (sum, row) => sum + row.dbSourceLinkIngestedCount,
      0,
    ),
    dbAvailable: includeDb,
    adaptersWithDbRowMismatch: adapterSummaries.filter(
      (row) => row.fileVsDbRowDelta !== 0,
    ).length,
    adaptersWithSourceLinkExpectedMismatch: adapterSummaries.filter(
      (row) => row.fileVsSourceLinkExpectedDelta !== 0,
    ).length,
    adaptersWithSourceLinkIngestedMismatch: adapterSummaries.filter(
      (row) => row.fileVsSourceLinkIngestedDelta !== 0,
    ).length,
    adapters: adapterSummaries,
  };

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log("source_image_count_validation_summary");
    console.log(`- adapters_checked: ${summary.adaptersChecked}`);
    console.log(`- files_checked: ${summary.filesChecked}`);
    console.log(
      `- listings_with_declared_count: ${summary.listingsWithDeclaredCount}`,
    );
    console.log(
      `- listings_missing_declared_count: ${summary.listingsMissingDeclaredCount}`,
    );
    console.log(
      `- listings_with_count_mismatch: ${summary.listingsWithCountMismatch}`,
    );
    console.log(`- total_image_urls: ${summary.totalImageUrls}`);
    console.log(
      `- total_declared_image_count: ${summary.totalDeclaredImageCount}`,
    );
    console.log(`- db_available: ${summary.dbAvailable}`);
    if (summary.dbAvailable) {
      console.log(
        `- total_db_source_image_rows: ${summary.totalDbSourceImageRows}`,
      );
      console.log(
        `- total_db_source_link_expected_count: ${summary.totalDbSourceLinkExpectedCount}`,
      );
      console.log(
        `- total_db_source_link_ingested_count: ${summary.totalDbSourceLinkIngestedCount}`,
      );
      console.log(
        `- adapters_with_db_row_mismatch: ${summary.adaptersWithDbRowMismatch}`,
      );
      console.log(
        `- adapters_with_source_link_expected_mismatch: ${summary.adaptersWithSourceLinkExpectedMismatch}`,
      );
      console.log(
        `- adapters_with_source_link_ingested_mismatch: ${summary.adaptersWithSourceLinkIngestedMismatch}`,
      );
    }
    console.log("");
    console.log("adapter_breakdown");
    for (const row of summary.adapters) {
      const dbPart = summary.dbAvailable
        ? ` db_rows=${row.dbSourceImageRows} db_expected=${row.dbSourceLinkExpectedCount} db_ingested=${row.dbSourceLinkIngestedCount} delta_file_vs_db_rows=${row.fileVsDbRowDelta} delta_file_vs_db_expected=${row.fileVsSourceLinkExpectedDelta} delta_file_vs_db_ingested=${row.fileVsSourceLinkIngestedDelta}`
        : "";
      console.log(
        `- ${row.adapter}: files=${row.files} image_urls=${row.totalImageUrls} declared_count=${row.totalDeclaredImageCount} missing_declared=${row.missingDeclaredCountListings} mismatches=${row.mismatchListings}${dbPart}`,
      );
    }
  }

  const hasMismatch = summary.listingsWithCountMismatch > 0;
  const hasMissingDeclaredCount = summary.listingsMissingDeclaredCount > 0;
  const hasDbMismatch =
    summary.dbAvailable &&
    (summary.adaptersWithDbRowMismatch > 0 ||
      summary.adaptersWithSourceLinkExpectedMismatch > 0 ||
      summary.adaptersWithSourceLinkIngestedMismatch > 0);

  if (
    options.strict &&
    (hasMismatch || hasMissingDeclaredCount || hasDbMismatch)
  ) {
    return 1;
  }

  if (options.requireDeclaredCount && hasMissingDeclaredCount) {
    return 1;
  }

  return 0;
}
