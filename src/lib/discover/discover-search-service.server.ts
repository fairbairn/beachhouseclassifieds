import type { DiscoverListing } from "@/lib/discover/discover-types";
import {
  buildDiscoverListingsPagePayload,
  buildDiscoverListingsPayload,
} from "@/lib/discover/discover-listings-api.server";
import type {
  DiscoverSearchMetadata,
  DiscoverSearchRequest,
  DiscoverSearchResponse,
} from "@/lib/discover/discover-types";

function buildMetadataFromListings(
  listings: DiscoverListing[],
): DiscoverSearchMetadata {
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
      areas: {},
      beaches: {},
      communities: {},
      features: {
        gulfFront: listings.filter((listing) => listing.beachfront).length,
        privatePool: listings.filter((listing) => listing.privatePool).length,
        golfCart: listings.filter((listing) => listing.golfCart).length,
      },
    },
  };
}

export async function executeDiscoverSearch(
  request: DiscoverSearchRequest,
): Promise<DiscoverSearchResponse> {
  const includeSlug = request.includeSlug?.trim() || undefined;

  if (includeSlug) {
    const listings = await buildDiscoverListingsPayload({ includeSlug });

    return {
      _stats: {
        nextCursor: null,
        hasMore: false,
        totalCount: listings.length,
        metadata: buildMetadataFromListings(listings),
      },
      listings,
    };
  }

  const payload = await buildDiscoverListingsPagePayload({
    limit: request.limit,
    cursor: request.cursor,
  });

  return {
    _stats: {
      nextCursor: payload._stats.nextCursor,
      hasMore: payload._stats.hasMore,
      totalCount: payload._stats.totalCount,
      metadata:
        payload._stats.metadata ?? buildMetadataFromListings(payload.listings),
    },
    listings: payload.listings,
  };
}
