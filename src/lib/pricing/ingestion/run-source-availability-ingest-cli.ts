import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { pgDb } from "@/core/server/db";
import { createScrapeProgress } from "@/core/tooling/terminal/scrape-progress";
import {
  listing_source_availability,
  listing_source_link,
} from "@/lib/db/schema-postgres";
import { canonicalizeExternalListingId } from "@/lib/pricing/shared/external-listing-id";
import { and, eq, sql } from "drizzle-orm";

type CliOptions = {
  adapterKey: string | null;
  dryRun: boolean;
  progressEveryFiles: number;
  writeProgressEveryRows: number;
  maxSourceLinks: number | null;
};

type SourceLinkRow = {
  id: string;
  listing_id: string;
  adapter_key: string;
  external_listing_id: string;
};

type AvailabilityFile = {
  adapter_key: string;
  external_listing_id: string;
  has_normalized_availability: boolean;
  captured_at: string | null;
  window_start_date: string | null;
  window_end_date: string | null;
  status_code_string: string;
  days_count: number;
};

type AvailabilityRowInsert = typeof listing_source_availability.$inferInsert;

type IngestSummary = {
  adaptersScanned: number;
  filesScanned: number;
  matchedSourceLinks: number;
  unmatchedFiles: number;
  skippedMissingAvailability: number;
  skippedMissingWindow: number;
  skippedInvalidStatusStream: number;
  duplicateFileKeys: number;
  rowsPrepared: number;
  rowsUpserted: number;
};

const UPSERT_CHUNK_SIZE = 1500;

function printUsage(): void {
  console.log("Ingest Listing Source Availability");
  console.log("Usage:");
  console.log(
    "  tsx src/lib/scripts/run-source-availability-ingest.ts [--adapter-key <key>] [--dry-run] [--progress-every-files <n>] [--write-progress-every-rows <n>] [--max-source-links <n>]",
  );
  console.log("");
  console.log("Options:");
  console.log("  --adapter-key <key>      Restrict to one adapter");
  console.log("  --dry-run                Parse and report only; no DB writes");
  console.log(
    "  --progress-every-files <n> Emit progress line every n files scanned (default 100)",
  );
  console.log(
    "  --write-progress-every-rows <n> Emit progress line every n rows upserted (default 10000)",
  );
  console.log(
    "  --max-source-links <n>   Cap number of matched source links to ingest",
  );
  console.log("  --help                   Show help");
  console.log("");
  console.log("Exit codes: 0 success, 1 handled failure, 130 cancelled");
}

function parseArgs(argv: string[]): CliOptions {
  let adapterKey: string | null = null;
  let dryRun = false;
  let progressEveryFiles = 100;
  let writeProgressEveryRows = 10_000;
  let maxSourceLinks: number | null = null;

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

    if (
      (arg === "--progress-every" || arg === "--progress-every-files") &&
      next
    ) {
      const parsed = Number(next);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("--progress-every-files must be a positive integer");
      }
      progressEveryFiles = Math.floor(parsed);
      i += 1;
      continue;
    }

    if (arg === "--write-progress-every-rows" && next) {
      const parsed = Number(next);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(
          "--write-progress-every-rows must be a positive integer",
        );
      }
      writeProgressEveryRows = Math.floor(parsed);
      i += 1;
      continue;
    }

    if (arg === "--max-source-links" && next) {
      const parsed = Number(next);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("--max-source-links must be a positive integer");
      }
      maxSourceLinks = Math.floor(parsed);
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    adapterKey,
    dryRun,
    progressEveryFiles,
    writeProgressEveryRows,
    maxSourceLinks,
  };
}

function toObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function toIsoDate(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }
  return null;
}

function toTimestamp(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString();
}

function canonicalizeAdapterKey(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return text.length > 0 ? text : fallback;
}

function canonicalizeExternalId(value: unknown, fileName: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length > 0) {
    return canonicalizeExternalListingId(text);
  }
  const baseName = fileName.endsWith(".json")
    ? fileName.slice(0, -".json".length)
    : fileName;
  return canonicalizeExternalListingId(baseName);
}

function toStatusCodeString(daysRaw: unknown): string {
  if (!Array.isArray(daysRaw) || daysRaw.length === 0) {
    return "";
  }

  let output = "";

  for (const entryRaw of daysRaw) {
    const entry = toObject(entryRaw);
    const statusCodeRaw = entry.status_code;
    const statusCode =
      typeof statusCodeRaw === "string"
        ? statusCodeRaw.trim().toUpperCase()
        : "";

    if (
      statusCode === "A" ||
      statusCode === "U" ||
      statusCode === "I" ||
      statusCode === "O" ||
      statusCode === "X"
    ) {
      output += statusCode;
      continue;
    }

    return "";
  }

  return output;
}

function readAvailabilityFile(
  parsed: Record<string, unknown>,
  fallbackAdapterKey: string,
  fileName: string,
): AvailabilityFile {
  const normalizedAvailability = toObject(parsed.normalized_availability);
  const adapter_key = canonicalizeAdapterKey(
    parsed.adapter_key,
    fallbackAdapterKey,
  );
  const external_listing_id = canonicalizeExternalId(
    parsed.external_listing_id ?? normalizedAvailability.external_listing_id,
    fileName,
  );

  const captured_at =
    toTimestamp(normalizedAvailability.captured_at) ??
    toTimestamp(parsed.generated_at);

  const window_start_date = toIsoDate(normalizedAvailability.window_start);
  const window_end_date = toIsoDate(normalizedAvailability.window_end);
  const status_code_string = toStatusCodeString(normalizedAvailability.days);

  const days_count = status_code_string.length;

  return {
    adapter_key,
    external_listing_id,
    has_normalized_availability: Object.keys(normalizedAvailability).length > 0,
    captured_at,
    window_start_date,
    window_end_date,
    status_code_string,
    days_count,
  };
}

function daySpanInclusive(startIso: string, endIso: string): number {
  const start = new Date(`${startIso}T00:00:00.000Z`);
  const end = new Date(`${endIso}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return 0;
  }
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  return Math.floor((end.getTime() - start.getTime()) / MS_PER_DAY) + 1;
}

async function listAdapterKeys(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith("."))
    .sort();
}

async function listDetailJsonFiles(dirPath: string): Promise<string[]> {
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

function buildSourceKey(adapterKey: string, externalListingId: string): string {
  return `${adapterKey}::${canonicalizeExternalListingId(externalListingId)}`;
}

function chunkRows<T>(rows: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += size) {
    chunks.push(rows.slice(i, i + size));
  }
  return chunks;
}

export async function runSourceAvailabilityIngestCli(
  argv: string[] = process.argv.slice(2),
): Promise<number> {
  const options = parseArgs(argv);
  const progress = createScrapeProgress({
    script: "source-availability-ingest",
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

  progress.phase("loading source links from postgres");

  const sourceLinks: SourceLinkRow[] = await pgDb
    .select({
      id: listing_source_link.id,
      listing_id: listing_source_link.listing_id,
      adapter_key: listing_source_link.adapter_key,
      external_listing_id: listing_source_link.external_listing_id,
    })
    .from(listing_source_link)
    .where(
      and(
        options.adapterKey
          ? eq(listing_source_link.adapter_key, options.adapterKey)
          : sql`true`,
        eq(listing_source_link.source_status, "active"),
      ),
    );

  const sourceLinkByKey = new Map<string, SourceLinkRow>();
  for (const row of sourceLinks) {
    const key = buildSourceKey(row.adapter_key, row.external_listing_id);
    if (!sourceLinkByKey.has(key)) {
      sourceLinkByKey.set(key, row);
    }
  }

  progress.info(
    `source_links_loaded=${sourceLinks.length} adapter_scope=${options.adapterKey ?? "all"}`,
  );

  const ingestRunId = `src_avail_ing_${randomUUID().replace(/-/g, "")}`;

  let filesScanned = 0;
  let unmatchedFiles = 0;
  let skippedMissingAvailability = 0;
  let skippedMissingWindow = 0;
  let skippedInvalidStatusStream = 0;
  let duplicateFileKeys = 0;

  const matchedSourceLinkIds = new Set<string>();
  const rowsBySourceLinkId = new Map<string, AvailabilityRowInsert>();

  for (const adapterKey of adapterKeys) {
    const detailsJsonDir = path.join(
      externalSourcesRoot,
      adapterKey,
      "details",
      "json",
    );
    const files = await listDetailJsonFiles(detailsJsonDir);

    progress.info(`adapter=${adapterKey} detail_json_files=${files.length}`);

    for (const fileName of files) {
      filesScanned += 1;
      if (filesScanned % options.progressEveryFiles === 0) {
        progress.progress(
          `files_scanned=${filesScanned} source_links_matched=${matchedSourceLinkIds.size} rows_prepared=${rowsBySourceLinkId.size}`,
        );
      }

      const filePath = path.join(detailsJsonDir, fileName);

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<
          string,
          unknown
        >;
      } catch {
        continue;
      }

      const availability = readAvailabilityFile(parsed, adapterKey, fileName);

      if (!availability.has_normalized_availability) {
        skippedMissingAvailability += 1;
        continue;
      }

      if (!availability.window_start_date || !availability.window_end_date) {
        skippedMissingWindow += 1;
        continue;
      }

      const expectedDaysCount = daySpanInclusive(
        availability.window_start_date,
        availability.window_end_date,
      );
      if (
        availability.status_code_string.length === 0 ||
        availability.days_count !== expectedDaysCount
      ) {
        skippedInvalidStatusStream += 1;
        continue;
      }

      const sourceLink = sourceLinkByKey.get(
        buildSourceKey(
          availability.adapter_key,
          availability.external_listing_id,
        ),
      );

      if (!sourceLink) {
        unmatchedFiles += 1;
        continue;
      }

      if (matchedSourceLinkIds.has(sourceLink.id)) {
        duplicateFileKeys += 1;
      }
      matchedSourceLinkIds.add(sourceLink.id);

      rowsBySourceLinkId.set(sourceLink.id, {
        id: `${sourceLink.id}:availability`,
        listing_id: sourceLink.listing_id,
        source_link_id: sourceLink.id,
        window_start_date: availability.window_start_date,
        window_end_date: availability.window_end_date,
        status_code_string: availability.status_code_string,
        days_count: availability.days_count,
        captured_at: availability.captured_at,
        ingest_run_id: ingestRunId,
        updated_at: sql`now()`,
      });

      if (
        options.maxSourceLinks !== null &&
        matchedSourceLinkIds.size >= options.maxSourceLinks
      ) {
        break;
      }
    }

    if (
      options.maxSourceLinks !== null &&
      matchedSourceLinkIds.size >= options.maxSourceLinks
    ) {
      break;
    }
  }

  const rowsPreparedArray = Array.from(rowsBySourceLinkId.values());

  progress.phase("preparing ingest summary");
  progress.info(
    `adapters_scanned=${adapterKeys.length} files_scanned=${filesScanned} matched_source_links=${matchedSourceLinkIds.size} unmatched_files=${unmatchedFiles} skipped_missing_window=${skippedMissingWindow} skipped_invalid_status_stream=${skippedInvalidStatusStream} duplicate_file_keys=${duplicateFileKeys} rows_prepared=${rowsPreparedArray.length} dry_run=${options.dryRun} ingest_run_id=${ingestRunId}`,
  );

  let rowsUpserted = 0;

  if (!options.dryRun && rowsPreparedArray.length > 0) {
    progress.phase("writing availability rows to postgres");
    progress.info(
      `write_plan rows_total=${rowsPreparedArray.length} chunk_size=${UPSERT_CHUNK_SIZE} write_progress_every_rows=${options.writeProgressEveryRows}`,
    );

    const chunks = chunkRows(rowsPreparedArray, UPSERT_CHUNK_SIZE);
    let nextWriteProgressAt = options.writeProgressEveryRows;

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];

      await pgDb
        .insert(listing_source_availability)
        .values(chunk)
        .onConflictDoUpdate({
          target: [listing_source_availability.source_link_id],
          set: {
            listing_id: sql`excluded.listing_id`,
            window_start_date: sql`excluded.window_start_date`,
            window_end_date: sql`excluded.window_end_date`,
            status_code_string: sql`excluded.status_code_string`,
            days_count: sql`excluded.days_count`,
            captured_at: sql`excluded.captured_at`,
            ingest_run_id: sql`excluded.ingest_run_id`,
            updated_at: sql`now()`,
          },
        });

      rowsUpserted += chunk.length;

      if (rowsUpserted >= nextWriteProgressAt || index === chunks.length - 1) {
        const pct = ((rowsUpserted / rowsPreparedArray.length) * 100).toFixed(
          1,
        );
        progress.progress(
          `upserted_chunks=${index + 1}/${chunks.length} rows_upserted=${rowsUpserted}/${rowsPreparedArray.length} pct=${pct}%`,
        );
        while (rowsUpserted >= nextWriteProgressAt) {
          nextWriteProgressAt += options.writeProgressEveryRows;
        }
      }
    }
  }

  const summary: IngestSummary = {
    adaptersScanned: adapterKeys.length,
    filesScanned,
    matchedSourceLinks: matchedSourceLinkIds.size,
    unmatchedFiles,
    skippedMissingAvailability,
    skippedMissingWindow,
    skippedInvalidStatusStream,
    duplicateFileKeys,
    rowsPrepared: rowsPreparedArray.length,
    rowsUpserted,
  };

  progress.success(
    `ingest_complete adapters_scanned=${summary.adaptersScanned} files_scanned=${summary.filesScanned} matched_source_links=${summary.matchedSourceLinks} unmatched_files=${summary.unmatchedFiles} skipped_missing_availability=${summary.skippedMissingAvailability} skipped_missing_window=${summary.skippedMissingWindow} skipped_invalid_status_stream=${summary.skippedInvalidStatusStream} duplicate_file_keys=${summary.duplicateFileKeys} rows_prepared=${summary.rowsPrepared} rows_upserted=${summary.rowsUpserted} dry_run=${options.dryRun}`,
  );

  console.log("listing_source_availability_ingest_complete");
  console.log(`- adapters_scanned: ${summary.adaptersScanned}`);
  console.log(`- files_scanned: ${summary.filesScanned}`);
  console.log(`- matched_source_links: ${summary.matchedSourceLinks}`);
  console.log(`- unmatched_files: ${summary.unmatchedFiles}`);
  console.log(
    `- skipped_missing_availability: ${summary.skippedMissingAvailability}`,
  );
  console.log(`- skipped_missing_window: ${summary.skippedMissingWindow}`);
  console.log(
    `- skipped_invalid_status_stream: ${summary.skippedInvalidStatusStream}`,
  );
  console.log(`- duplicate_file_keys: ${summary.duplicateFileKeys}`);
  console.log(`- rows_prepared: ${summary.rowsPrepared}`);
  console.log(`- rows_upserted: ${summary.rowsUpserted}`);
  console.log(`- dry_run: ${options.dryRun}`);
  console.log(`- ingest_run_id: ${ingestRunId}`);

  return 0;
}
