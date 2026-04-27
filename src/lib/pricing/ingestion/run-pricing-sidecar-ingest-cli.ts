import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { pgDb } from "@/core/server/db";
import { createScrapeProgress } from "@/core/tooling/terminal/scrape-progress";
import {
  listing_source_link,
  listing_source_pricing,
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

type PricingDay = {
  date: string;
  is_available: boolean;
  availability_status_code: "A" | "U" | "I" | "O" | "X" | null;
  is_available_for_checkin: boolean | null;
  is_available_for_checkout: boolean | null;
  min_nights: number | null;
  base_nightly: string | null;
  estimated_fees_nightly: string | null;
  estimated_taxes_nightly: string | null;
  all_in_nightly: string;
  currency: string;
  price_source: string;
  confidence: string | null;
  value_origin:
    | "quote_anchor"
    | "scraped_rate"
    | "interpolated"
    | "assumptions_anchor"
    | "global_default"
    | null;
  quote_anchor_scope: "same_month" | "surrounding_months" | "none" | null;
  has_any_quote_observations: boolean | null;
  nearest_quote_observation_distance_days: number | null;
};

type PricingSidecarFile = {
  adapter_key: string;
  external_listing_id: string;
  generated_at: string | null;
  window_start_date: string | null;
  window_end_date: string | null;
  days: PricingDay[];
};

type PricingRowInsert = typeof listing_source_pricing.$inferInsert;

type IngestSummary = {
  adaptersScanned: number;
  filesScanned: number;
  matchedSourceLinks: number;
  unmatchedFiles: number;
  skippedNoDays: number;
  duplicateFileKeys: number;
  rowsPrepared: number;
  rowsUpserted: number;
};

const UPSERT_CHUNK_SIZE = 1500;

function printUsage(): void {
  console.log("Ingest Listing Source Pricing");
  console.log("Usage:");
  console.log(
    "  tsx src/lib/scripts/run-pricing-sidecar-ingest.ts [--adapter-key <key>] [--dry-run] [--progress-every-files <n>] [--write-progress-every-rows <n>] [--max-source-links <n>]",
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

function toOptionalNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function toNullableNumericString(value: unknown): string | null {
  const parsed = toOptionalNumber(value);
  if (parsed === null) {
    return null;
  }
  return parsed.toFixed(2);
}

function toAvailabilityStatusCode(
  value: unknown,
): "A" | "U" | "I" | "O" | "X" | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toUpperCase();
  if (
    normalized === "A" ||
    normalized === "U" ||
    normalized === "I" ||
    normalized === "O" ||
    normalized === "X"
  ) {
    return normalized;
  }
  return null;
}

function toOptionalBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  return null;
}

function toOptionalInteger(value: unknown): number | null {
  const parsed = toOptionalNumber(value);
  if (parsed === null) {
    return null;
  }
  return Math.floor(parsed);
}

function toValueOrigin(
  value: unknown,
):
  | "quote_anchor"
  | "scraped_rate"
  | "interpolated"
  | "assumptions_anchor"
  | "global_default"
  | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "quote_anchor" ||
    normalized === "scraped_rate" ||
    normalized === "interpolated" ||
    normalized === "assumptions_anchor" ||
    normalized === "global_default"
  ) {
    return normalized;
  }
  return null;
}

function toQuoteAnchorScope(
  value: unknown,
): "same_month" | "surrounding_months" | "none" | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "same_month" ||
    normalized === "surrounding_months" ||
    normalized === "none"
  ) {
    return normalized;
  }
  return null;
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

function readPricingSidecar(
  parsed: Record<string, unknown>,
  fallbackAdapterKey: string,
  fileName: string,
): PricingSidecarFile {
  const horizon = toObject(parsed.horizon);
  const adapter_key = canonicalizeAdapterKey(
    parsed.adapter_key,
    fallbackAdapterKey,
  );
  const external_listing_id = canonicalizeExternalId(
    parsed.external_listing_id,
    fileName,
  );
  const generated_at = toTimestamp(parsed.generated_at);
  const window_start_date = toIsoDate(horizon.from_date);
  const window_end_date = toIsoDate(horizon.to_date);

  const dayValues = Array.isArray(parsed.days) ? parsed.days : [];
  const days: PricingDay[] = [];

  for (const dayValue of dayValues) {
    const day = toObject(dayValue);
    const provenance = toObject(day.provenance);
    const date = toIsoDate(day.date);
    const allInNightly = toNullableNumericString(day.all_in_nightly);
    if (!date || !allInNightly) {
      continue;
    }

    const minNightsValue = toOptionalNumber(day.min_nights);
    const min_nights =
      minNightsValue === null ? null : Math.max(1, Math.floor(minNightsValue));

    days.push({
      date,
      is_available: Boolean(day.is_available),
      availability_status_code: toAvailabilityStatusCode(
        day.availability_status_code,
      ),
      is_available_for_checkin: toOptionalBoolean(day.is_available_for_checkin),
      is_available_for_checkout: toOptionalBoolean(
        day.is_available_for_checkout,
      ),
      min_nights,
      base_nightly: toNullableNumericString(day.base_nightly),
      estimated_fees_nightly: toNullableNumericString(
        day.estimated_fees_nightly,
      ),
      estimated_taxes_nightly: toNullableNumericString(
        day.estimated_taxes_nightly,
      ),
      all_in_nightly: allInNightly,
      currency:
        typeof day.currency === "string" && day.currency.trim().length > 0
          ? day.currency.trim().toUpperCase()
          : "USD",
      price_source:
        typeof day.source === "string" && day.source.trim().length > 0
          ? day.source.trim()
          : "unknown",
      confidence:
        typeof day.confidence === "string" && day.confidence.trim().length > 0
          ? day.confidence.trim()
          : null,
      value_origin: toValueOrigin(provenance.value_origin),
      quote_anchor_scope: toQuoteAnchorScope(provenance.quote_anchor_scope),
      has_any_quote_observations: toOptionalBoolean(
        provenance.has_any_quote_observations,
      ),
      nearest_quote_observation_distance_days: toOptionalInteger(
        provenance.nearest_quote_observation_distance_days,
      ),
    });
  }

  return {
    adapter_key,
    external_listing_id,
    generated_at,
    window_start_date,
    window_end_date,
    days,
  };
}

async function listAdapterKeys(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith("."))
    .sort();
}

async function listPricingJsonFiles(dirPath: string): Promise<string[]> {
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

export async function runPricingSidecarIngestCli(
  argv: string[] = process.argv.slice(2),
): Promise<number> {
  const options = parseArgs(argv);
  const progress = createScrapeProgress({ script: "pricing-sidecar-ingest" });

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

  const ingestRunId = `pricing_ing_${randomUUID().replace(/-/g, "")}`;

  let filesScanned = 0;
  let unmatchedFiles = 0;
  let skippedNoDays = 0;
  let duplicateFileKeys = 0;

  const matchedSourceLinkIds = new Set<string>();
  const rowsByUniqueKey = new Map<string, PricingRowInsert>();

  for (const adapterKey of adapterKeys) {
    const pricingDir = path.join(
      externalSourcesRoot,
      adapterKey,
      "details",
      "pricing",
    );
    const files = await listPricingJsonFiles(pricingDir);

    progress.info(`adapter=${adapterKey} pricing_files=${files.length}`);

    for (const fileName of files) {
      filesScanned += 1;
      if (filesScanned % options.progressEveryFiles === 0) {
        progress.progress(
          `files_scanned=${filesScanned} source_links_matched=${matchedSourceLinkIds.size} rows_prepared=${rowsByUniqueKey.size}`,
        );
      }

      const filePath = path.join(pricingDir, fileName);

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<
          string,
          unknown
        >;
      } catch {
        continue;
      }

      const sidecar = readPricingSidecar(parsed, adapterKey, fileName);
      const sourceLink = sourceLinkByKey.get(
        buildSourceKey(sidecar.adapter_key, sidecar.external_listing_id),
      );

      if (!sourceLink) {
        unmatchedFiles += 1;
        continue;
      }

      if (matchedSourceLinkIds.has(sourceLink.id)) {
        duplicateFileKeys += 1;
      }
      matchedSourceLinkIds.add(sourceLink.id);

      if (sidecar.days.length === 0) {
        skippedNoDays += 1;
        continue;
      }

      for (const day of sidecar.days) {
        const uniqueDayKey = `${sourceLink.id}::${day.date}`;

        rowsByUniqueKey.set(uniqueDayKey, {
          id: `${sourceLink.id}:${day.date}`,
          listing_id: sourceLink.listing_id,
          source_link_id: sourceLink.id,
          stay_date: day.date,
          is_available: day.is_available,
          availability_status_code: day.availability_status_code,
          is_available_for_checkin: day.is_available_for_checkin,
          is_available_for_checkout: day.is_available_for_checkout,
          min_nights: day.min_nights,
          base_nightly: day.base_nightly,
          estimated_fees_nightly: day.estimated_fees_nightly,
          estimated_taxes_nightly: day.estimated_taxes_nightly,
          all_in_nightly: day.all_in_nightly,
          currency: day.currency,
          price_source: day.price_source,
          confidence: day.confidence,
          value_origin: day.value_origin,
          quote_anchor_scope: day.quote_anchor_scope,
          has_any_quote_observations: day.has_any_quote_observations,
          nearest_quote_observation_distance_days:
            day.nearest_quote_observation_distance_days,
          scrape_observed_at: sidecar.generated_at,
          window_start_date: sidecar.window_start_date,
          window_end_date: sidecar.window_end_date,
          ingest_run_id: ingestRunId,
          is_current: true,
          updated_at: sql`now()`,
        });
      }

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

  const rowsPrepared = rowsByUniqueKey.size;
  const sourceLinkIds = Array.from(matchedSourceLinkIds);
  const rowsPreparedArray = Array.from(rowsByUniqueKey.values());

  progress.phase("preparing ingest summary");
  progress.info(
    `adapters_scanned=${adapterKeys.length} files_scanned=${filesScanned} matched_source_links=${sourceLinkIds.length} unmatched_files=${unmatchedFiles} skipped_no_days=${skippedNoDays} duplicate_file_keys=${duplicateFileKeys} rows_prepared=${rowsPrepared} dry_run=${options.dryRun} ingest_run_id=${ingestRunId}`,
  );

  let rowsUpserted = 0;

  if (
    !options.dryRun &&
    sourceLinkIds.length > 0 &&
    rowsPreparedArray.length > 0
  ) {
    progress.phase("writing pricing rows to postgres");
    progress.info(
      `write_plan rows_total=${rowsPreparedArray.length} chunk_size=${UPSERT_CHUNK_SIZE} write_progress_every_rows=${options.writeProgressEveryRows}`,
    );

    const chunks = chunkRows(rowsPreparedArray, UPSERT_CHUNK_SIZE);
    let nextWriteProgressAt = options.writeProgressEveryRows;
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];

      await pgDb
        .insert(listing_source_pricing)
        .values(chunk)
        .onConflictDoUpdate({
          target: [
            listing_source_pricing.source_link_id,
            listing_source_pricing.stay_date,
          ],
          set: {
            listing_id: sql`excluded.listing_id`,
            is_available: sql`excluded.is_available`,
            availability_status_code: sql`excluded.availability_status_code`,
            is_available_for_checkin: sql`excluded.is_available_for_checkin`,
            is_available_for_checkout: sql`excluded.is_available_for_checkout`,
            min_nights: sql`excluded.min_nights`,
            base_nightly: sql`excluded.base_nightly`,
            estimated_fees_nightly: sql`excluded.estimated_fees_nightly`,
            estimated_taxes_nightly: sql`excluded.estimated_taxes_nightly`,
            all_in_nightly: sql`excluded.all_in_nightly`,
            currency: sql`excluded.currency`,
            price_source: sql`excluded.price_source`,
            confidence: sql`excluded.confidence`,
            value_origin: sql`excluded.value_origin`,
            quote_anchor_scope: sql`excluded.quote_anchor_scope`,
            has_any_quote_observations: sql`excluded.has_any_quote_observations`,
            nearest_quote_observation_distance_days: sql`excluded.nearest_quote_observation_distance_days`,
            scrape_observed_at: sql`excluded.scrape_observed_at`,
            window_start_date: sql`excluded.window_start_date`,
            window_end_date: sql`excluded.window_end_date`,
            ingest_run_id: sql`excluded.ingest_run_id`,
            is_current: sql`excluded.is_current`,
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
    matchedSourceLinks: sourceLinkIds.length,
    unmatchedFiles,
    skippedNoDays,
    duplicateFileKeys,
    rowsPrepared,
    rowsUpserted,
  };

  progress.success(
    `ingest_complete adapters_scanned=${summary.adaptersScanned} files_scanned=${summary.filesScanned} matched_source_links=${summary.matchedSourceLinks} unmatched_files=${summary.unmatchedFiles} skipped_no_days=${summary.skippedNoDays} duplicate_file_keys=${summary.duplicateFileKeys} rows_prepared=${summary.rowsPrepared} rows_upserted=${summary.rowsUpserted} dry_run=${options.dryRun}`,
  );

  console.log("listing_source_pricing_ingest_complete");
  console.log(`- adapters_scanned: ${summary.adaptersScanned}`);
  console.log(`- files_scanned: ${summary.filesScanned}`);
  console.log(`- matched_source_links: ${summary.matchedSourceLinks}`);
  console.log(`- unmatched_files: ${summary.unmatchedFiles}`);
  console.log(`- skipped_no_days: ${summary.skippedNoDays}`);
  console.log(`- duplicate_file_keys: ${summary.duplicateFileKeys}`);
  console.log(`- rows_prepared: ${summary.rowsPrepared}`);
  console.log(`- rows_upserted: ${summary.rowsUpserted}`);
  console.log(`- dry_run: ${options.dryRun}`);
  console.log(`- ingest_run_id: ${ingestRunId}`);

  return 0;
}
