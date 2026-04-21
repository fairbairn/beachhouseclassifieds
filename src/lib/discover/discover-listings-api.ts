import {
  getAreaFromListing,
  getBeachZoneFromListing,
  verifyGulfFrontClaim,
} from "@/components/discover/discover-utils";
import { normalizeDiscoverListings } from "@/lib/discover/community-normalization";
import { getDiscoverListings } from "@/lib/discover/discover-listings.server";
import type {
  DiscoverListing,
  DiscoverListingDetailPayload,
  DiscoverListingsMetadata,
  DiscoverListingsPagePayload,
} from "@/lib/discover/discover-types";

const DEFAULT_DISCOVER_PAGE_SIZE = 24;
const MAX_DISCOVER_PAGE_SIZE = 96;

function normalizeDiscoverListingsForApi(listings: DiscoverListing[]) {
  const locationAlignedListings = listings.map((listing) => {
    const beachZone = getBeachZoneFromListing(listing);
    if (!beachZone) {
      return verifyGulfFrontClaim(listing);
    }

    return verifyGulfFrontClaim({
      ...listing,
      area: beachZone,
    });
  });

  const normalizedListings = normalizeDiscoverListings(locationAlignedListings);

  return normalizedListings;
}

function toSummaryListing(listing: DiscoverListing): DiscoverListing {
  return {
    id: listing.id,
    name: listing.name,
    area: listing.area,
    beach: listing.beach,
    community: listing.community,
    lat: listing.lat,
    lng: listing.lng,
    bedrooms: listing.bedrooms,
    bathrooms: listing.bathrooms,
    sleeps: listing.sleeps,
    privatePool: listing.privatePool,
    gulffront: listing.gulffront,
    golfCart: listing.golfCart,
    previewImages: listing.previewImages,
    typicalPricingMonth: listing.typicalPricingMonth,
    typicalBaseNightly: listing.typicalBaseNightly,
    typicalAllInNightly: listing.typicalAllInNightly,
  };
}

function resolvePageSize(limit: number | undefined): number {
  const resolvedLimit = typeof limit === "number" ? limit : Number.NaN;
  if (!Number.isFinite(resolvedLimit)) {
    return DEFAULT_DISCOVER_PAGE_SIZE;
  }

  return Math.max(
    1,
    Math.min(MAX_DISCOVER_PAGE_SIZE, Math.floor(resolvedLimit)),
  );
}

function buildDiscoverListingsMetadata(
  listings: DiscoverListing[],
): DiscoverListingsMetadata {
  const areas: Record<string, number> = {};
  const beaches: Record<string, number> = {};
  const communities: Record<string, number> = {};

  let gulfFront = 0;
  let privatePool = 0;
  let golfCart = 0;

  for (const listing of listings) {
    const normalizedArea = getAreaFromListing(listing);
    if (normalizedArea) {
      areas[normalizedArea] = (areas[normalizedArea] ?? 0) + 1;
    }

    const beachZone = getBeachZoneFromListing(listing);
    if (beachZone) {
      beaches[beachZone] = (beaches[beachZone] ?? 0) + 1;
    }

    if (listing.community) {
      communities[listing.community] =
        (communities[listing.community] ?? 0) + 1;
    }

    if (listing.beachfront) {
      gulfFront += 1;
    }
    if (listing.privatePool) {
      privatePool += 1;
    }
    if (listing.golfCart) {
      golfCart += 1;
    }
  }

  return {
    totalCount: listings.length,
    mapListings: listings
      .filter(
        (listing) =>
          typeof listing.lat === "number" && typeof listing.lng === "number",
      )
      .map((listing) => ({
        id: listing.id,
        name: listing.name,
        lat: listing.lat as number,
        lng: listing.lng as number,
        typicalAllInNightly: listing.typicalAllInNightly,
      })),
    facets: {
      areas,
      beaches,
      communities,
      features: {
        gulfFront,
        privatePool,
        golfCart,
      },
    },
  };
}

export async function buildDiscoverListingsPagePayload(input?: {
  limit?: number;
}): Promise<DiscoverListingsPagePayload> {
  const allListings = await buildDiscoverListingsPayload();
  const totalCount = allListings.length;
  const metadata = buildDiscoverListingsMetadata(allListings);

  const pageSize = resolvePageSize(input?.limit);
  const pageItems = allListings.slice(0, pageSize);

  return {
    _stats: {
      totalCount,
      count: pageItems.length,
      requested: pageSize,
    },
    metadata,
    listings: pageItems.map(toSummaryListing),
  };
}

export async function buildDiscoverListingsPayload(input?: {
  includeSlug?: string;
}): Promise<DiscoverListing[]> {
  const includeSlug = input?.includeSlug?.trim() || undefined;

  const sourceListings = await getDiscoverListings({
    includeSlug,
    onlySlug: Boolean(includeSlug),
    disableFallback: true,
  }).catch(() => []);

  return normalizeDiscoverListingsForApi(sourceListings);
}

export async function buildDiscoverListingDetailPayload(input: {
  slug?: string;
}): Promise<DiscoverListingDetailPayload> {
  const slug = input.slug?.trim() ?? "";
  if (!slug) {
    return { listing: null };
  }

  const listings = await buildDiscoverListingsPayload({ includeSlug: slug });
  const listing = listings.find((candidate) => candidate.id === slug) ?? null;

  if (!listing) {
    return { listing: null };
  }

  return {
    listing,
    _stats: {
      images: {
        imageCount: Math.max(0, Math.round(listing.imageCount ?? 0)),
        previewImageCount: listing.previewImages.length,
      },
    },
  };
}
