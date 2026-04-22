import { pgDb } from "@/core/server/db";
import {
  listing,
  listing_pricing_summary,
  listing_source_link,
  listing_source_pricing,
  site,
} from "@/lib/db/schema-postgres";
import {
  and,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";

const DISCOVER_SITE_SLUG = "30acollections";
const DISCOVER_PRICING_SUMMARY_METHOD = "monthly_forward_avg_v1";
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

const hasPrivatePoolExpr = sql<boolean>`(
  exists (
    select 1
    from jsonb_array_elements(coalesce(${listing.traits}, '[]'::jsonb)) as trait
    where trait ->> 'key' = 'feature.private_pool'
      and trait ->> 'value_boolean' = 'true'
  )
  or coalesce(${listing.amenities_normalized}, '[]'::jsonb) ? 'private_pool'
)`;

const hasGolfCartExpr = sql<boolean>`(
  exists (
    select 1
    from jsonb_array_elements(coalesce(${listing.traits}, '[]'::jsonb)) as trait
    where trait ->> 'key' = 'feature.golf_cart'
      and trait ->> 'value_boolean' = 'true'
  )
  or coalesce(${listing.amenities_normalized}, '[]'::jsonb) ? 'golf_cart'
)`;

const discoverListingSummarySelectFields = {
  id: listing.id,
  slug: listing.slug,
  canonical_name: listing.canonical_name,
  listing_number: listing.listing_number,
  bedrooms: listing.bedrooms,
  bathrooms: listing.bathrooms,
  sleeps: listing.sleeps,
  lat: listing.lat,
  lng: listing.lng,
  city: listing.city,
  area: listing.area,
  area_name: listing.area_name,
  beach_area_name: listing.beach_area_name,
  community_name: listing.community_name,
  is_gulf_front: listing.is_gulf_front,
  has_private_pool_amenity: hasPrivatePoolExpr,
  has_golf_cart_amenity: hasGolfCartExpr,
  has_gulf_front_amenity: sql<boolean>`coalesce(${listing.amenities_normalized}, '[]'::jsonb) ? 'gulf_front'`,
  has_beachfront_amenity: sql<boolean>`coalesce(${listing.amenities_normalized}, '[]'::jsonb) ? 'beachfront'`,
  preview_image_urls: sql<unknown>`coalesce((
      select jsonb_agg(src)
      from (
        select nullif(trim(img ->> 'src'), '') as src
        from jsonb_array_elements(coalesce(${listing.images}, '[]'::jsonb)) with ordinality as images_elt(img, ord)
        where ord <= 5
      ) preview
      where src is not null
    ), '[]'::jsonb)`,
  image_count: sql<number>`coalesce(jsonb_array_length(coalesce(${listing.images}, '[]'::jsonb)), 0)::int`,
  sleeping_summary: listing.sleeping_summary,
  amenities_normalized: listing.amenities_normalized,
  traits: listing.traits,
} as const;

const discoverListingDetailSelectFields = {
  ...discoverListingSummarySelectFields,
  sleeping_summary: listing.sleeping_summary,
  amenities_normalized: listing.amenities_normalized,
  traits: listing.traits,
  images: listing.images,
  description_headline_plain: listing.description_headline_plain,
  description_short_plain: listing.description_short_plain,
  description_markdown: listing.description_markdown,
  highlights: listing.highlights,
  helpful_hints: listing.helpful_hints,
  sleeping_arrangements: listing.sleeping_arrangements,
} as const;

export type DiscoverListingRecordRow = {
  id: string;
  slug: string;
  canonical_name: string;
  listing_number: number | null;
  bedrooms: number | null;
  bathrooms: string | null;
  sleeps: number | null;
  lat: number | null;
  lng: number | null;
  city: string | null;
  area: string | null;
  area_name: string | null;
  beach_area_name: string | null;
  community_name: string | null;
  is_gulf_front: boolean;
  has_private_pool_amenity?: boolean;
  has_golf_cart_amenity?: boolean;
  has_gulf_front_amenity?: boolean;
  has_beachfront_amenity?: boolean;
  description_headline_plain?: string | null;
  description_short_plain?: string | null;
  description_markdown?: string | null;
  highlights?: unknown;
  helpful_hints?: unknown;
  sleeping_arrangements?: unknown;
  sleeping_summary: unknown;
  amenities_normalized: unknown;
  traits: unknown;
  preview_image_urls?: unknown;
  image_count?: number | null;
  images?: unknown;
};

type DiscoverListingFacetFilters = {
  selectedAreaCodes?: string[];
  selectedBeachCodes?: string[];
  selectedCommunityCodes?: string[];
  selectedFeatures?: Array<"gulf_front" | "private_pool" | "golf_cart">;
};

function buildDiscoverFacetWhere(filters?: DiscoverListingFacetFilters) {
  const selectedAreaCodes = filters?.selectedAreaCodes ?? [];
  const selectedBeachCodes = filters?.selectedBeachCodes ?? [];
  const selectedCommunityCodes = filters?.selectedCommunityCodes ?? [];
  const selectedFeatures = filters?.selectedFeatures ?? [];

  const selectedFeatureConditions = selectedFeatures
    .map((feature) => {
      if (feature === "gulf_front") {
        return eq(listing.is_gulf_front, true);
      }

      if (feature === "private_pool") {
        return hasPrivatePoolExpr;
      }

      if (feature === "golf_cart") {
        return hasGolfCartExpr;
      }

      return undefined;
    })
    .filter((condition): condition is NonNullable<typeof condition> =>
      Boolean(condition),
    );

  const locationOrConditions = [
    selectedAreaCodes.length > 0
      ? inArray(listing.area_name, selectedAreaCodes)
      : undefined,
    selectedBeachCodes.length > 0
      ? inArray(listing.beach_area_name, selectedBeachCodes)
      : undefined,
    selectedCommunityCodes.length > 0
      ? inArray(listing.community_name, selectedCommunityCodes)
      : undefined,
  ].filter((condition): condition is NonNullable<typeof condition> =>
    Boolean(condition),
  );

  const locationOrFilter =
    locationOrConditions.length > 0 ? or(...locationOrConditions) : undefined;

  if (!locationOrFilter && selectedFeatureConditions.length === 0) {
    return undefined;
  }

  return and(locationOrFilter, ...selectedFeatureConditions);
}

export async function queryDiscoverListingsRows(input?: {
  maxListings?: number | null;
  offset?: number;
  afterCursor?: {
    demoOrder: number;
    id: string;
  };
  filters?: DiscoverListingFacetFilters;
}): Promise<DiscoverListingRecordRow[]> {
  if (!pgDb) {
    return [];
  }

  const discoverSiteId = await resolveDiscoverSiteId();
  if (!discoverSiteId) {
    return [];
  }

  const maxListings = input?.maxListings;
  const offset =
    typeof input?.offset === "number" && Number.isFinite(input.offset)
      ? Math.max(0, Math.floor(input.offset))
      : 0;
  const afterCursor = input?.afterCursor;

  const query = pgDb
    .select({
      ...discoverListingSummarySelectFields,
    })
    .from(listing)
    .where(
      and(
        eq(listing.site_id, discoverSiteId),
        eq(listing.status, "active"),
        isNull(listing.visibility_disabled_reason),
        buildDiscoverFacetWhere(input?.filters),
        afterCursor
          ? or(
              gt(listing.listing_number, afterCursor.demoOrder),
              and(
                eq(listing.listing_number, afterCursor.demoOrder),
                gt(listing.slug, afterCursor.id),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(listing.listing_number, listing.slug);

  if (typeof maxListings === "number") {
    const limited = await query.offset(offset).limit(maxListings);
    return limited as DiscoverListingRecordRow[];
  }

  const rows = offset > 0 ? await query.offset(offset) : await query;
  return rows as DiscoverListingRecordRow[];
}

export async function queryDiscoverListingsCount(input?: {
  filters?: DiscoverListingFacetFilters;
}): Promise<number> {
  if (!pgDb) {
    return 0;
  }

  const discoverSiteId = await resolveDiscoverSiteId();
  if (!discoverSiteId) {
    return 0;
  }

  const rows = await pgDb
    .select({ count: sql<number>`count(*)::int` })
    .from(listing)
    .where(
      and(
        eq(listing.site_id, discoverSiteId),
        eq(listing.status, "active"),
        isNull(listing.visibility_disabled_reason),
        buildDiscoverFacetWhere(input?.filters),
      ),
    )
    .limit(1);

  return rows[0]?.count ?? 0;
}

export async function queryDiscoverListingDetailRowBySlug(input: {
  slug: string;
}): Promise<DiscoverListingRecordRow | null> {
  if (!pgDb) {
    return null;
  }

  const discoverSiteId = await resolveDiscoverSiteId();
  if (!discoverSiteId) {
    return null;
  }

  const rows = await pgDb
    .select({
      ...discoverListingDetailSelectFields,
    })
    .from(listing)
    .where(
      and(
        eq(listing.site_id, discoverSiteId),
        eq(listing.status, "active"),
        isNull(listing.visibility_disabled_reason),
        eq(listing.slug, input.slug),
      ),
    )
    .limit(1);

  const row = rows[0];
  return (row as DiscoverListingRecordRow | undefined) ?? null;
}

export async function queryDiscoverPricingSummaryRows(input: {
  listingIds: string[];
  monthStartDateIsoList: string[];
}): Promise<
  Array<{
    listing_id: string;
    month_start_date: string;
    recommended_all_in_nightly: string;
    computed_at: string;
    anchor_date: string;
  }>
> {
  if (!pgDb || input.listingIds.length === 0) {
    return [];
  }

  const rows = await pgDb
    .select({
      listing_id: listing_pricing_summary.listing_id,
      month_start_date: listing_pricing_summary.month_start_date,
      recommended_all_in_nightly:
        listing_pricing_summary.recommended_all_in_nightly,
      computed_at: listing_pricing_summary.computed_at,
      anchor_date: listing_pricing_summary.anchor_date,
    })
    .from(listing_pricing_summary)
    .where(
      and(
        inArray(listing_pricing_summary.listing_id, input.listingIds),
        eq(listing_pricing_summary.nights, 7),
        eq(listing_pricing_summary.method, DISCOVER_PRICING_SUMMARY_METHOD),
        inArray(
          listing_pricing_summary.month_start_date,
          input.monthStartDateIsoList,
        ),
      ),
    )
    .orderBy(
      listing_pricing_summary.listing_id,
      listing_pricing_summary.month_start_date,
      desc(listing_pricing_summary.computed_at),
      desc(listing_pricing_summary.anchor_date),
    );

  return rows as Array<{
    listing_id: string;
    month_start_date: string;
    recommended_all_in_nightly: string;
    computed_at: string;
    anchor_date: string;
  }>;
}

export async function queryDiscoverSourcePricingRows(input: {
  listingIds: string[];
  startDateIso: string;
  endDateIso: string;
}): Promise<
  Array<{
    listing_id: string;
    stay_date: string;
    is_available: boolean;
    availability_status_code: string | null;
    is_available_for_checkin: boolean | null;
    is_available_for_checkout: boolean | null;
    min_nights: number | null;
    all_in_nightly: string;
  }>
> {
  if (!pgDb || input.listingIds.length === 0) {
    return [];
  }

  const primarySourceRows = await pgDb
    .select({
      listing_id: listing_source_link.listing_id,
      source_link_id: listing_source_link.id,
    })
    .from(listing_source_link)
    .where(
      and(
        inArray(listing_source_link.listing_id, input.listingIds),
        eq(listing_source_link.source_status, "active"),
        eq(listing_source_link.is_primary_source, true),
        isNull(listing_source_link.active_to),
      ),
    );

  const sourceLinkIds = primarySourceRows.map((row) => row.source_link_id);
  if (sourceLinkIds.length === 0) {
    return [];
  }

  const rows = await pgDb
    .select({
      listing_id: listing_source_pricing.listing_id,
      stay_date: listing_source_pricing.stay_date,
      is_available: listing_source_pricing.is_available,
      availability_status_code: listing_source_pricing.availability_status_code,
      is_available_for_checkin: listing_source_pricing.is_available_for_checkin,
      is_available_for_checkout:
        listing_source_pricing.is_available_for_checkout,
      min_nights: listing_source_pricing.min_nights,
      all_in_nightly: listing_source_pricing.all_in_nightly,
    })
    .from(listing_source_pricing)
    .where(
      and(
        inArray(listing_source_pricing.source_link_id, sourceLinkIds),
        gte(listing_source_pricing.stay_date, input.startDateIso),
        lte(listing_source_pricing.stay_date, input.endDateIso),
      ),
    )
    .orderBy(
      listing_source_pricing.listing_id,
      listing_source_pricing.stay_date,
    );

  return rows as Array<{
    listing_id: string;
    stay_date: string;
    is_available: boolean;
    availability_status_code: string | null;
    is_available_for_checkin: boolean | null;
    is_available_for_checkout: boolean | null;
    min_nights: number | null;
    all_in_nightly: string;
  }>;
}
