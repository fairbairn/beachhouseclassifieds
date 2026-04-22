import { pgDb } from "@/core/server/db";
import { listing, site } from "@/lib/db/schema-postgres";
import { and, eq, isNull, sql } from "drizzle-orm";

const DISCOVER_SITE_SLUG = "30acollections";
let discoverSiteIdCache: string | null | undefined;

type DiscoverCountAndFacetsRow = {
  total_count: number;
  gulf_front_count: number;
  private_pool_count: number;
  golf_cart_count: number;
  areas: unknown;
  beaches: unknown;
  communities: unknown;
};

async function resolveDiscoverSiteId(): Promise<string | null> {
  if (!pgDb) {
    return null;
  }

  if (discoverSiteIdCache !== undefined) {
    return discoverSiteIdCache;
  }

  const rows = await pgDb
    .select({ id: site.id })
    .from(site)
    .where(eq(site.slug, DISCOVER_SITE_SLUG))
    .limit(1);

  discoverSiteIdCache = rows[0]?.id ?? null;
  return discoverSiteIdCache;
}

function toFeatureSet(input?: string[]): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(input)) {
    return out;
  }

  for (const raw of input) {
    if (typeof raw !== "string") {
      continue;
    }

    const normalized = raw
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    if (normalized) {
      out.add(normalized);
    }
  }

  return out;
}

export async function queryDiscoverCountAndFacets(input?: {
  selectedFeatures?: string[];
}): Promise<DiscoverCountAndFacetsRow | null> {
  if (!pgDb) {
    return null;
  }

  const discoverSiteId = await resolveDiscoverSiteId();
  if (!discoverSiteId) {
    return null;
  }

  const hasPrivatePool = sql<boolean>`(
    exists (
      select 1
      from jsonb_array_elements(coalesce(${listing.traits}, '[]'::jsonb)) as trait
      where trait ->> 'key' = 'feature.private_pool'
        and trait ->> 'value_boolean' = 'true'
    )
    or coalesce(${listing.amenities_normalized}, '[]'::jsonb) ? 'private_pool'
  )`;

  const hasGolfCart = sql<boolean>`(
    exists (
      select 1
      from jsonb_array_elements(coalesce(${listing.traits}, '[]'::jsonb)) as trait
      where trait ->> 'key' = 'feature.golf_cart'
        and trait ->> 'value_boolean' = 'true'
    )
    or coalesce(${listing.amenities_normalized}, '[]'::jsonb) ? 'golf_cart'
  )`;

  const selectedFeatureSet = toFeatureSet(input?.selectedFeatures);
  const selectedFeatureWhere = and(
    selectedFeatureSet.has("gulf_front")
      ? eq(listing.is_gulf_front, true)
      : undefined,
    selectedFeatureSet.has("private_pool") ? hasPrivatePool : undefined,
    selectedFeatureSet.has("golf_cart") ? hasGolfCart : undefined,
  );

  const summaryResult = await pgDb.execute<{
    total_count: number;
    gulf_front_count: number;
    private_pool_count: number;
    golf_cart_count: number;
  }>(sql`
    select
      count(*)::int as total_count,
      count(*) filter (where ${listing.is_gulf_front})::int as gulf_front_count,
      count(*) filter (where ${hasPrivatePool})::int as private_pool_count,
      count(*) filter (where ${hasGolfCart})::int as golf_cart_count
    from ${listing}
    where ${and(
      eq(listing.site_id, discoverSiteId),
      eq(listing.status, "active"),
      isNull(listing.visibility_disabled_reason),
      selectedFeatureWhere,
    )}
  `);

  const facetRowsResult = await pgDb.execute<{
    section: "area" | "beach" | "community";
    code: string;
    count: number;
  }>(sql`
    with eligible as (
      select
        nullif(trim(${listing.area_name}), '') as area_code,
        nullif(trim(${listing.beach_area_name}), '') as beach_code,
        coalesce(
          nullif(trim(${listing.community_name}), ''),
          case
            when nullif(trim(${listing.beach_area_name}), '') = 'seacrest_beach' then 'seacrest'
            else null
          end
        ) as community_code
      from ${listing}
      where ${and(
        eq(listing.site_id, discoverSiteId),
        eq(listing.status, "active"),
        isNull(listing.visibility_disabled_reason),
        selectedFeatureWhere,
      )}
    )
    select
      facet.section,
      facet.code,
      count(*)::int as count
    from eligible
    cross join lateral (
      values
        ('area'::text, area_code),
        ('beach'::text, beach_code),
        ('community'::text, community_code)
    ) as facet(section, code)
    where facet.code is not null
    group by facet.section, facet.code
  `);

  const summary = summaryResult.rows[0];
  if (!summary) {
    return null;
  }

  const areas: Record<string, number> = {};
  const beaches: Record<string, number> = {};
  const communities: Record<string, number> = {};

  for (const row of facetRowsResult.rows) {
    const code = typeof row.code === "string" ? row.code.trim() : "";
    const count = Number.isFinite(row.count) ? Math.max(0, row.count) : 0;
    if (!code) {
      continue;
    }

    if (row.section === "area") {
      areas[code] = count;
      continue;
    }

    if (row.section === "beach") {
      beaches[code] = count;
      continue;
    }

    communities[code] = count;
  }

  return {
    total_count: summary.total_count,
    gulf_front_count: summary.gulf_front_count,
    private_pool_count: summary.private_pool_count,
    golf_cart_count: summary.golf_cart_count,
    areas,
    beaches,
    communities,
  };
}
