import {
  sampleListings,
  type DiscoverListing,
} from "@/components/discover/discover-data";
import {
  getAreaFromListing,
  getBeachZoneFromListing,
  verifyGulfFrontClaim,
} from "@/components/discover/discover-utils";
import { normalizeDiscoverListings } from "@/lib/discover/community-normalization";
import { getDiscoverListings } from "@/lib/discover/discover-listings.server";

const DEFAULT_DISCOVER_PAGE_SIZE = 24;
const MAX_DISCOVER_PAGE_SIZE = 96;

export type DiscoverListingsPagePayload = {
  _stats: {
    nextCursor: string | null;
    hasMore: boolean;
    totalCount: number;
    metadata?: DiscoverListingsMetadata;
  };
  listings: DiscoverListing[];
};

export type DiscoverListingDetailPayload = {
  listing: DiscoverListing | null;
  _stats?: {
    images: {
      imageCount: number;
      previewImageCount: number;
    };
  };
};

export type DiscoverListingsMetadata = {
  totalCount: number;
  mapListings: Array<{
    id: string;
    name: string;
    lat: number;
    lng: number;
    typicalAllInNightly: number;
  }>;
  facets: {
    areas: Record<string, number>;
    beaches: Record<string, number>;
    communities: Record<string, number>;
    features: {
      gulfFront: number;
      privatePool: number;
      golfCart: number;
    };
  };
};

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

  return [...normalizedListings].sort((a, b) => {
    if (a.demoOrder !== b.demoOrder) {
      return a.demoOrder - b.demoOrder;
    }
    return a.id.localeCompare(b.id);
  });
}

function toSummaryListing(listing: DiscoverListing): DiscoverListing {
  return {
    id: listing.id,
    name: listing.name,
    demoOrder: listing.demoOrder,
    area: listing.area,
    community: listing.community,
    lat: listing.lat,
    lng: listing.lng,
    bedrooms: listing.bedrooms,
    bathrooms: listing.bathrooms,
    sleeps: listing.sleeps,
    kingBeds: listing.kingBeds,
    queenBeds: listing.queenBeds,
    privatePool: listing.privatePool,
    beachfront: listing.beachfront,
    gulfView: listing.gulfView,
    golfCart: listing.golfCart,
    petsAllowed: listing.petsAllowed,
    accessible: listing.accessible,
    elevator: listing.elevator,
    previewImages: listing.previewImages,
    typicalPricingMonth: listing.typicalPricingMonth,
    typicalBaseNightly: listing.typicalBaseNightly,
    typicalAllInNightly: listing.typicalAllInNightly,
  };
}

function encodeCursor(listing: DiscoverListing): string {
  return `${listing.demoOrder}|${encodeURIComponent(listing.id)}`;
}

function parseCursor(cursor: string | undefined): {
  demoOrder: number;
  id: string;
} | null {
  if (!cursor) {
    return null;
  }

  const [demoOrderRaw, ...idParts] = cursor.split("|");
  if (!demoOrderRaw || idParts.length === 0) {
    return null;
  }

  const demoOrder = Number(demoOrderRaw);
  if (!Number.isFinite(demoOrder)) {
    return null;
  }

  const encodedId = idParts.join("|");
  if (!encodedId) {
    return null;
  }

  try {
    return {
      demoOrder,
      id: decodeURIComponent(encodedId),
    };
  } catch {
    return null;
  }
}

function resolvePageSize(limit: number | undefined): number {
  if (!Number.isFinite(limit)) {
    return DEFAULT_DISCOVER_PAGE_SIZE;
  }

  return Math.max(1, Math.min(MAX_DISCOVER_PAGE_SIZE, Math.floor(limit)));
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
    mapListings: listings.map((listing) => ({
      id: listing.id,
      name: listing.name,
      lat: listing.lat,
      lng: listing.lng,
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
  cursor?: string;
}): Promise<DiscoverListingsPagePayload> {
  const allListings = await buildDiscoverListingsPayload();
  const totalCount = allListings.length;
  const includeMetadata = !input?.cursor;
  const metadata = includeMetadata
    ? buildDiscoverListingsMetadata(allListings)
    : undefined;

  const pageSize = resolvePageSize(input?.limit);
  const parsedCursor = parseCursor(input?.cursor);

  const startIndex = parsedCursor
    ? allListings.findIndex(
        (listing) =>
          listing.demoOrder > parsedCursor.demoOrder ||
          (listing.demoOrder === parsedCursor.demoOrder &&
            listing.id > parsedCursor.id),
      )
    : 0;

  const safeStartIndex = startIndex >= 0 ? startIndex : totalCount;
  const pageItems = allListings.slice(
    safeStartIndex,
    safeStartIndex + pageSize,
  );
  const hasMore = safeStartIndex + pageItems.length < totalCount;
  const nextCursor = hasMore
    ? encodeCursor(pageItems[pageItems.length - 1] as DiscoverListing)
    : null;

  return {
    _stats: {
      nextCursor,
      hasMore,
      totalCount,
      ...(metadata ? { metadata } : {}),
    },
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

  const resolvedSourceListings = includeSlug
    ? sourceListings
    : sourceListings.length > 0
      ? sourceListings
      : sampleListings;

  return normalizeDiscoverListingsForApi(resolvedSourceListings);
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
