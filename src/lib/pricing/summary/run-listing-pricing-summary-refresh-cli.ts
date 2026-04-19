import { randomUUID } from "node:crypto";

import { pgDb } from "@/core/server/db";
import { createScrapeProgress } from "@/core/tooling/terminal/scrape-progress";
import {
  listing,
  listing_pricing_summary,
  listing_source_link,
  listing_source_pricing,
} from "@/lib/db/schema-postgres";
import { and, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";

type CliOptions = {
  adapterKey: string | null;
  listingSlug: string | null;
  dryRun: boolean;
  maxListings: number | null;
  nights: number;
  horizonDays: number;
  monthsForward: number;
  method: string;
};

type SourceLinkPick = {
  id: string;
  listing_id: string;
  is_primary_source: boolean;
};

type SummaryAggregateRow = {
  source_link_id: string;
  month_start_date: string;
  sample_nights_total: number;
  sample_nights_available: number;
  avg_all_in_nightly: string;
  avg_all_in_nightly_available: string | null;
  pricing_max_updated_at: string | null;
};

type SummaryInsert = typeof listing_pricing_summary.$inferInsert;

const UPSERT_CHUNK_SIZE = 1000;
const DEFAULT_METHOD = "monthly_forward_avg_v1";

function printUsage(): void {
  console.log("Refresh Listing Pricing Summary");
  console.log("Usage:");
  console.log(
    "  tsx src/lib/scripts/run-listing-pricing-summary-refresh.ts [--adapter-key <key>] [--listing-slug <slug>] [--max-listings <n>] [--nights <n>] [--horizon-days <n>] [--months-forward <n>] [--method <name>] [--dry-run]",
  );
  console.log("");
  console.log("Options:");
  console.log("  --adapter-key <key>      Restrict to one adapter");
  console.log("  --listing-slug <slug>    Restrict to one listing slug");
  console.log(
    "  --max-listings <n>       Cap listing count after source-link selection",
  );
  console.log(
    "  --nights <n>             Length of stay for estimate (default 7)",
  );
  console.log(
    "  --horizon-days <n>       Anchor offset from today in days (default 45)",
  );
  console.log(
    "  --months-forward <n>     Number of forward months to summarize (default 3)",
  );
  console.log(
    `  --method <name>          Summary method label (default ${DEFAULT_METHOD})`,
  );
  console.log(
    "  --dry-run                Calculate and report only; no DB writes",
  );
  console.log("  --help                   Show help");
  console.log("");
  console.log("Exit codes: 0 success, 1 handled failure, 130 cancelled");
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function parseArgs(argv: string[]): CliOptions {
  let adapterKey: string | null = null;
  let listingSlug: string | null = null;
  let dryRun = false;
  let maxListings: number | null = null;
  let nights = 7;
  let horizonDays = 45;
  let monthsForward = 3;
  let method = DEFAULT_METHOD;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }

    if (arg === "--adapter-key" && next) {
      adapterKey = next.trim().toLowerCase() || null;
      index += 1;
      continue;
    }

    if (arg === "--listing-slug" && next) {
      listingSlug = next.trim() || null;
      index += 1;
      continue;
    }

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (arg === "--max-listings" && next) {
      maxListings = parsePositiveInt(next, "--max-listings");
      index += 1;
      continue;
    }

    if (arg === "--nights" && next) {
      nights = parsePositiveInt(next, "--nights");
      index += 1;
      continue;
    }

    if (arg === "--horizon-days" && next) {
      horizonDays = parsePositiveInt(next, "--horizon-days");
      index += 1;
      continue;
    }

    if (arg === "--months-forward" && next) {
      monthsForward = parsePositiveInt(next, "--months-forward");
      index += 1;
      continue;
    }

    if (arg === "--method" && next) {
      method = next.trim();
      if (!method) {
        throw new Error("--method cannot be empty");
      }
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    adapterKey,
    listingSlug,
    dryRun,
    maxListings,
    nights,
    horizonDays,
    monthsForward,
    method,
  };
}

function toIsoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function addMonths(start: Date, count: number): Date {
  const out = new Date(start);
  out.setUTCMonth(out.getUTCMonth() + count);
  return out;
}

function startOfMonth(input: Date): Date {
  return new Date(Date.UTC(input.getUTCFullYear(), input.getUTCMonth(), 1));
}

function endOfMonth(input: Date): Date {
  const monthStart = startOfMonth(input);
  const nextMonthStart = addMonths(monthStart, 1);
  const out = new Date(nextMonthStart);
  out.setUTCDate(0);
  return out;
}

function toRoundedCents(value: number): string {
  return value.toFixed(2);
}

function toNumber(value: string | number | null): number | null {
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

function chunkRows<T>(rows: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }
  return chunks;
}

function freshnessStatus(maxUpdatedAt: string | null, nowMs: number): string {
  if (!maxUpdatedAt) {
    return "unknown";
  }
  const timestamp = Date.parse(maxUpdatedAt);
  if (Number.isNaN(timestamp)) {
    return "unknown";
  }
  const ageMs = Math.max(0, nowMs - timestamp);
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  return ageDays <= 21 ? "fresh" : "stale";
}

export async function runListingPricingSummaryRefreshCli(
  argv: string[] = process.argv.slice(2),
): Promise<number> {
  const options = parseArgs(argv);
  const progress = createScrapeProgress({ script: "pricing-summary-refresh" });

  if (!pgDb) {
    progress.failure("Postgres DB is not configured for this environment.");
    return 1;
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const anchorDate = new Date(today);
  anchorDate.setDate(anchorDate.getDate() + options.horizonDays);
  const anchorDateIso = toIsoDate(anchorDate);

  const nextMonthStart = new Date(today);
  nextMonthStart.setDate(1);
  nextMonthStart.setMonth(nextMonthStart.getMonth() + 1);
  const targetMonthStart = startOfMonth(nextMonthStart);
  const monthStarts = Array.from({ length: options.monthsForward }, (_, idx) =>
    toIsoDate(addMonths(targetMonthStart, idx)),
  );

  const firstMonthStartIso = monthStarts[0];
  const finalMonthEndIso = toIsoDate(
    endOfMonth(addMonths(targetMonthStart, options.monthsForward - 1)),
  );

  progress.info(
    `anchor_date=${anchorDateIso} months_forward=${options.monthsForward} nights=${options.nights} method=${options.method} dry_run=${options.dryRun}`,
  );

  const listingRows = await pgDb
    .select({
      id: listing.id,
      slug: listing.slug,
    })
    .from(listing)
    .where(
      and(
        options.listingSlug ? eq(listing.slug, options.listingSlug) : sql`true`,
        eq(listing.status, "active"),
      ),
    );

  if (listingRows.length === 0) {
    progress.failure("No matching active listings were found.");
    return 1;
  }

  const listingIds = listingRows.map((row) => row.id);
  const sourceLinkRows = await pgDb
    .select({
      id: listing_source_link.id,
      listing_id: listing_source_link.listing_id,
      is_primary_source: listing_source_link.is_primary_source,
    })
    .from(listing_source_link)
    .where(
      and(
        inArray(listing_source_link.listing_id, listingIds),
        options.adapterKey
          ? eq(listing_source_link.adapter_key, options.adapterKey)
          : sql`true`,
        eq(listing_source_link.source_status, "active"),
        isNull(listing_source_link.active_to),
      ),
    );

  const sourceByListingId = new Map<string, SourceLinkPick>();
  for (const row of sourceLinkRows) {
    const existing = sourceByListingId.get(row.listing_id);
    if (!existing || row.is_primary_source) {
      sourceByListingId.set(row.listing_id, row);
    }
  }

  const pickedLinks = Array.from(sourceByListingId.values());
  const limitedLinks =
    options.maxListings === null
      ? pickedLinks
      : pickedLinks.slice(0, options.maxListings);

  if (limitedLinks.length === 0) {
    progress.failure("No active source links matched the requested scope.");
    return 1;
  }

  const sourceLinkIds = limitedLinks.map((row) => row.id);

  progress.phase("aggregating nightly pricing by month");

  const monthBucketExpr = sql`date_trunc('month', ${listing_source_pricing.stay_date}::date)`;
  const aggregateRows = (await pgDb
    .select({
      source_link_id: listing_source_pricing.source_link_id,
      month_start_date: sql<string>`to_char(${monthBucketExpr}, 'YYYY-MM-DD')`,
      sample_nights_total: sql<number>`count(*)::int`,
      sample_nights_available: sql<number>`sum(case when ${listing_source_pricing.is_available} then 1 else 0 end)::int`,
      avg_all_in_nightly: sql<string>`round(avg(${listing_source_pricing.all_in_nightly}), 2)::text`,
      avg_all_in_nightly_available: sql<
        string | null
      >`round(avg(case when ${listing_source_pricing.is_available} then ${listing_source_pricing.all_in_nightly} end), 2)::text`,
      pricing_max_updated_at: sql<
        string | null
      >`max(${listing_source_pricing.updated_at})`,
    })
    .from(listing_source_pricing)
    .where(
      and(
        inArray(listing_source_pricing.source_link_id, sourceLinkIds),
        gte(listing_source_pricing.stay_date, firstMonthStartIso),
        lte(listing_source_pricing.stay_date, finalMonthEndIso),
      ),
    )
    .groupBy(listing_source_pricing.source_link_id, monthBucketExpr)) as
    | SummaryAggregateRow[]
    | [];

  const aggregateBySourceMonth = new Map<string, SummaryAggregateRow>();
  for (const row of aggregateRows) {
    aggregateBySourceMonth.set(
      `${row.source_link_id}::${row.month_start_date}`,
      row,
    );
  }

  const nowMs = Date.now();
  const runId = `pricing_sum_${randomUUID().replace(/-/g, "")}`;
  const summaryRows: SummaryInsert[] = [];

  for (const sourceLink of limitedLinks) {
    for (const monthStartIso of monthStarts) {
      const aggregate = aggregateBySourceMonth.get(
        `${sourceLink.id}::${monthStartIso}`,
      );
      if (!aggregate) {
        continue;
      }

      const avgAllIn = toNumber(aggregate.avg_all_in_nightly);
      if (avgAllIn === null) {
        continue;
      }

      const avgAllInAvailable = toNumber(
        aggregate.avg_all_in_nightly_available,
      );
      const recommended = avgAllInAvailable ?? avgAllIn;
      const monthStartDate = new Date(`${monthStartIso}T00:00:00.000Z`);
      const monthEndIso = toIsoDate(endOfMonth(monthStartDate));

      summaryRows.push({
        id: `lps_${randomUUID().replace(/-/g, "")}`,
        listing_id: sourceLink.listing_id,
        source_link_id: sourceLink.id,
        anchor_date: anchorDateIso,
        nights: options.nights,
        horizon_days: options.horizonDays,
        method: options.method,
        month_start_date: monthStartIso,
        month_end_date: monthEndIso,
        sample_nights_total: aggregate.sample_nights_total,
        sample_nights_available: aggregate.sample_nights_available,
        avg_all_in_nightly: toRoundedCents(avgAllIn),
        avg_all_in_nightly_available:
          avgAllInAvailable === null ? null : toRoundedCents(avgAllInAvailable),
        recommended_all_in_nightly: toRoundedCents(recommended),
        estimated_total_for_nights: toRoundedCents(
          recommended * options.nights,
        ),
        pricing_max_updated_at: aggregate.pricing_max_updated_at,
        freshness_status: freshnessStatus(
          aggregate.pricing_max_updated_at,
          nowMs,
        ),
        run_id: runId,
        computed_at: sql`now()`,
        updated_at: sql`now()`,
      });
    }
  }

  progress.info(
    `listings_scoped=${limitedLinks.length} aggregates_found=${aggregateRows.length} rows_prepared=${summaryRows.length}`,
  );

  if (summaryRows.length === 0) {
    progress.failure(
      "No summary rows were prepared from available pricing data.",
    );
    return 1;
  }

  let rowsUpserted = 0;

  if (!options.dryRun) {
    progress.phase("writing pricing summary rows");

    const chunks = chunkRows(summaryRows, UPSERT_CHUNK_SIZE);
    for (const chunk of chunks) {
      await pgDb
        .insert(listing_pricing_summary)
        .values(chunk)
        .onConflictDoUpdate({
          target: [
            listing_pricing_summary.listing_id,
            listing_pricing_summary.anchor_date,
            listing_pricing_summary.nights,
            listing_pricing_summary.method,
            listing_pricing_summary.month_start_date,
          ],
          set: {
            source_link_id: sql`excluded.source_link_id`,
            horizon_days: sql`excluded.horizon_days`,
            month_end_date: sql`excluded.month_end_date`,
            sample_nights_total: sql`excluded.sample_nights_total`,
            sample_nights_available: sql`excluded.sample_nights_available`,
            avg_all_in_nightly: sql`excluded.avg_all_in_nightly`,
            avg_all_in_nightly_available: sql`excluded.avg_all_in_nightly_available`,
            recommended_all_in_nightly: sql`excluded.recommended_all_in_nightly`,
            estimated_total_for_nights: sql`excluded.estimated_total_for_nights`,
            pricing_max_updated_at: sql`excluded.pricing_max_updated_at`,
            freshness_status: sql`excluded.freshness_status`,
            run_id: sql`excluded.run_id`,
            computed_at: sql`now()`,
            updated_at: sql`now()`,
          },
        });

      rowsUpserted += chunk.length;
    }
  }

  progress.success(
    `pricing_summary_refresh_complete listings_scoped=${limitedLinks.length} rows_prepared=${summaryRows.length} rows_upserted=${rowsUpserted} dry_run=${options.dryRun} run_id=${runId}`,
  );

  console.log("listing_pricing_summary_refresh_complete");
  console.log(`- anchor_date: ${anchorDateIso}`);
  console.log(`- months_forward: ${options.monthsForward}`);
  console.log(`- listings_scoped: ${limitedLinks.length}`);
  console.log(`- rows_prepared: ${summaryRows.length}`);
  console.log(`- rows_upserted: ${rowsUpserted}`);
  console.log(`- dry_run: ${options.dryRun}`);
  console.log(`- run_id: ${runId}`);

  return 0;
}
