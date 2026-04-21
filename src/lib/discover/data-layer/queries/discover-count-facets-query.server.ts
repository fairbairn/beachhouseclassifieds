import { pgDb } from "@/core/server/db";
import { listing, site } from "@/lib/db/schema-postgres";
import { and, eq, isNull, sql } from "drizzle-orm";

const DISCOVER_SITE_SLUG = "30acollections";
let discoverSiteIdCache: string | null | undefined;

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

export async function queryDiscoverCountAndFacets(): Promise<{
  total_count: number;
  gulf_front_count: number;
  private_pool_count: number;
  golf_cart_count: number;
  areas: unknown;
  beaches: unknown;
  communities: unknown;
} | null> {
  if (!pgDb) {
    return null;
  }

  const discoverSiteId = await resolveDiscoverSiteId();
  if (!discoverSiteId) {
    return null;
  }

  const metadataResult = await pgDb.execute<{
    total_count: number;
    gulf_front_count: number;
    private_pool_count: number;
    golf_cart_count: number;
    areas: unknown;
    beaches: unknown;
    communities: unknown;
  }>(sql`
    with eligible as materialized (
      select
        coalesce(
          nullif(trim(${listing.beach_area_name}), ''),
          nullif(trim(${listing.area_name}), ''),
          nullif(trim(${listing.area}), ''),
          '30A'
        ) as area_name,
        coalesce(
          nullif(trim(${listing.beach_area_name}), ''),
          nullif(trim(${listing.area_name}), '')
        ) as beach_name,
        coalesce(
          nullif(trim(${listing.community_name}), ''),
          nullif(trim(${listing.area_name}), ''),
          nullif(trim(${listing.beach_area_name}), ''),
          '30A'
        ) as community_name,
        ${listing.is_gulf_front} as is_gulf_front,
        coalesce(${listing.amenities_normalized}, '[]'::jsonb) as amenities_normalized
      from ${listing}
      where ${and(
        eq(listing.site_id, discoverSiteId),
        eq(listing.status, "active"),
        isNull(listing.visibility_disabled_reason),
      )}
    ),
    areas as (
      select coalesce(jsonb_object_agg(name, count), '{}'::jsonb) as facets
      from (
        select area_name as name, count(*)::int as count
        from eligible
        where area_name is not null
        group by area_name
      ) grouped
    ),
    beaches as (
      select coalesce(jsonb_object_agg(name, count), '{}'::jsonb) as facets
      from (
        select beach_name as name, count(*)::int as count
        from eligible
        where beach_name is not null
        group by beach_name
      ) grouped
    ),
    communities as (
      select coalesce(jsonb_object_agg(name, count), '{}'::jsonb) as facets
      from (
        select community_name as name, count(*)::int as count
        from eligible
        where community_name is not null
        group by community_name
      ) grouped
    )
    select
      (select count(*)::int from eligible) as total_count,
      coalesce(
        (select sum((is_gulf_front = true)::int)::int from eligible),
        0
      ) as gulf_front_count,
      coalesce(
        (
          select
            sum(
              (
                amenities_normalized ? 'private_pool'
              )::int
            )::int
          from eligible
        ),
        0
      ) as private_pool_count,
      coalesce(
        (
          select
            sum(
              (
                amenities_normalized ? 'golf_cart'
              )::int
            )::int
          from eligible
        ),
        0
      ) as golf_cart_count,
      (select facets from areas) as areas,
      (select facets from beaches) as beaches,
      (select facets from communities) as communities
  `);

  return metadataResult.rows[0] ?? null;
}
