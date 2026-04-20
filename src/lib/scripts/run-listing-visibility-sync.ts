import "@/core/tooling/env/load-env-profile";

import { sql } from "drizzle-orm";

import { pgDb } from "@/core/server/db";
import {
  LISTING_VISIBILITY_REASON_CODES,
  LISTING_VISIBILITY_RULES,
} from "@/lib/listings/visibility/visibility-rules";

type CliOptions = {
  dryRun: boolean;
};

type VisibilityRollupRow = {
  total_active: number;
  visible_count: number;
  disabled_count: number;
  manual_listing_hidden: number;
  manual_adapter_hidden: number;
  missing_images: number;
  missing_description_markdown: number;
  missing_area_name: number;
  missing_beach_area_name: number;
  missing_lat_lng: number;
  excluded_by_source_link: number;
  missing_active_source_link: number;
};

function printUsage(): void {
  console.log("Listing Visibility Sync");
  console.log("Usage:");
  console.log("  tsx src/lib/scripts/run-listing-visibility-sync.ts [options]");
  console.log("");
  console.log("Options:");
  console.log(
    "  --dry-run   Compute visibility reasons without writing listing rows",
  );
  console.log("  --help      Show help");
}

function parseArgs(argv: string[]): CliOptions {
  let dryRun = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { dryRun };
}

function normalizeNonEmptyValues(values: readonly string[]): string[] {
  return Array.from(
    new Set(
      values.map((value) => value.trim()).filter((value) => value.length > 0),
    ),
  );
}

function normalizeLowercaseNonEmptyValues(values: readonly string[]): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => value.trim().toLowerCase())
        .filter((value) => value.length > 0),
    ),
  );
}

function asTextArraySql(values: string[]) {
  return values.length > 0 ? sql`${values}::text[]` : sql`array[]::text[]`;
}

async function run(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));

  if (!pgDb) {
    throw new Error("Postgres database is not configured.");
  }

  const manualListingIds = normalizeNonEmptyValues(
    LISTING_VISIBILITY_RULES.manuallyHiddenListingIds,
  );
  const manualListingSlugs = normalizeLowercaseNonEmptyValues(
    LISTING_VISIBILITY_RULES.manuallyHiddenListingSlugs,
  );
  const manualAdapterKeys = normalizeLowercaseNonEmptyValues(
    LISTING_VISIBILITY_RULES.manuallyHiddenAdapterKeys,
  );
  const manualListingIdsSql = asTextArraySql(manualListingIds);
  const manualListingSlugsSql = asTextArraySql(manualListingSlugs);
  const manualAdapterKeysSql = asTextArraySql(manualAdapterKeys);

  console.log(
    [
      "listing_visibility_sync_start",
      `dry_run=${options.dryRun}`,
      `manual_listing_ids=${manualListingIds.length}`,
      `manual_listing_slugs=${manualListingSlugs.length}`,
      `manual_adapter_keys=${manualAdapterKeys.length}`,
    ].join(" "),
  );

  const disabledReasonSql = sql<string | null>`
    case
      when (
        (${manualListingIds.length} > 0 and l.id = any(${manualListingIdsSql}))
        or (${manualListingSlugs.length} > 0 and lower(l.slug) = any(${manualListingSlugsSql}))
      ) then ${LISTING_VISIBILITY_REASON_CODES.manualListingHidden}

      when (
        ${manualAdapterKeys.length} > 0
        and exists (
          select 1
          from listing_source_link lsl
          where lsl.listing_id = l.id
            and lsl.source_status = 'active'
            and lsl.active_to is null
            and lsl.excluded_by_match = false
            and lower(lsl.adapter_key) = any(${manualAdapterKeysSql})
        )
      ) then ${LISTING_VISIBILITY_REASON_CODES.manualAdapterHidden}

      when (
        jsonb_typeof(l.images) <> 'array'
        or jsonb_array_length(l.images) = 0
        or coalesce(l.image_count, 0) <= 0
      ) then ${LISTING_VISIBILITY_REASON_CODES.missingImages}

      when (l.description_markdown is null or btrim(l.description_markdown) = '')
      then ${LISTING_VISIBILITY_REASON_CODES.missingDescriptionMarkdown}

      when (l.area_name is null or btrim(l.area_name) = '')
      then ${LISTING_VISIBILITY_REASON_CODES.missingAreaName}

      when (l.beach_area_name is null or btrim(l.beach_area_name) = '')
      then ${LISTING_VISIBILITY_REASON_CODES.missingBeachAreaName}

      when (l.lat is null or l.lng is null)
      then ${LISTING_VISIBILITY_REASON_CODES.missingLatLng}

      when (
        not exists (
          select 1
          from listing_source_link lsl
          where lsl.listing_id = l.id
            and lsl.source_status = 'active'
            and lsl.active_to is null
            and lsl.excluded_by_match = false
        )
        and exists (
          select 1
          from listing_source_link lsl
          where lsl.listing_id = l.id
            and lsl.source_status = 'active'
            and lsl.active_to is null
            and lsl.excluded_by_match = true
        )
      ) then ${LISTING_VISIBILITY_REASON_CODES.excludedBySourceLink}

      when not exists (
        select 1
        from listing_source_link lsl
        where lsl.listing_id = l.id
          and lsl.source_status = 'active'
          and lsl.active_to is null
          and lsl.excluded_by_match = false
      ) then ${LISTING_VISIBILITY_REASON_CODES.missingActiveSourceLink}

      else null
    end
  `;

  const previewRows = await pgDb.execute<{
    id: string;
    next_reason: string | null;
    current_reason: string | null;
  }>(sql`
    select
      l.id,
      ${disabledReasonSql} as next_reason,
      l.visibility_disabled_reason as current_reason
    from listing l
    where l.status = 'active'
  `);

  const changedRows = previewRows.rows.filter(
    (row) => (row.current_reason ?? null) !== (row.next_reason ?? null),
  );

  if (!options.dryRun && changedRows.length > 0) {
    await pgDb.execute(sql`
      update listing as l
      set
        visibility_disabled_reason = ${disabledReasonSql},
        updated_at = now()
      where l.status = 'active'
        and l.visibility_disabled_reason is distinct from ${disabledReasonSql}
    `);
  }

  const rollup = await pgDb.execute<VisibilityRollupRow>(sql`
    with computed as (
      select
        ${disabledReasonSql} as reason
      from listing l
      where l.status = 'active'
    )
    select
      count(*)::int as total_active,
      sum((reason is null)::int)::int as visible_count,
      sum((reason is not null)::int)::int as disabled_count,
      sum((reason = ${LISTING_VISIBILITY_REASON_CODES.manualListingHidden})::int)::int as manual_listing_hidden,
      sum((reason = ${LISTING_VISIBILITY_REASON_CODES.manualAdapterHidden})::int)::int as manual_adapter_hidden,
      sum((reason = ${LISTING_VISIBILITY_REASON_CODES.missingImages})::int)::int as missing_images,
      sum((reason = ${LISTING_VISIBILITY_REASON_CODES.missingDescriptionMarkdown})::int)::int as missing_description_markdown,
      sum((reason = ${LISTING_VISIBILITY_REASON_CODES.missingAreaName})::int)::int as missing_area_name,
      sum((reason = ${LISTING_VISIBILITY_REASON_CODES.missingBeachAreaName})::int)::int as missing_beach_area_name,
      sum((reason = ${LISTING_VISIBILITY_REASON_CODES.missingLatLng})::int)::int as missing_lat_lng,
      sum((reason = ${LISTING_VISIBILITY_REASON_CODES.excludedBySourceLink})::int)::int as excluded_by_source_link,
      sum((reason = ${LISTING_VISIBILITY_REASON_CODES.missingActiveSourceLink})::int)::int as missing_active_source_link
    from computed
  `);

  const row = rollup.rows[0];

  if (!row) {
    console.log("listing_visibility_sync no_active_listings");
    return 0;
  }

  console.log(
    [
      "listing_visibility_sync_complete",
      `dry_run=${options.dryRun}`,
      `changed=${changedRows.length}`,
      `total_active=${row.total_active}`,
      `visible=${row.visible_count}`,
      `disabled=${row.disabled_count}`,
      `manual_listing_hidden=${row.manual_listing_hidden}`,
      `manual_adapter_hidden=${row.manual_adapter_hidden}`,
      `missing_images=${row.missing_images}`,
      `missing_description_markdown=${row.missing_description_markdown}`,
      `missing_area_name=${row.missing_area_name}`,
      `missing_beach_area_name=${row.missing_beach_area_name}`,
      `missing_lat_lng=${row.missing_lat_lng}`,
      `excluded_by_source_link=${row.excluded_by_source_link}`,
      `missing_active_source_link=${row.missing_active_source_link}`,
    ].join(" "),
  );

  return 0;
}

run()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`listing visibility sync failed: ${message}`);
    process.exit(1);
  });
