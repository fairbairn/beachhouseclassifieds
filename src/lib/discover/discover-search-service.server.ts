import {
  buildDiscoverListingsPagePayload,
  buildDiscoverListingsPayload,
} from "@/lib/discover/discover-listings-api.server";
import { getDiscoverCorpusMetadata } from "@/lib/discover/discover-listings.server";
import type {
  DiscoverFacetsRequest,
  DiscoverFacetsResponse,
  DiscoverListing,
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
        gulf_front: {
          label: "Gulf Front",
          count: listings.filter((listing) => listing.gulffront).length,
        },
        private_pool: {
          label: "Private Pool",
          count: listings.filter((listing) => listing.privatePool).length,
        },
        golf_cart: {
          label: "Golf Cart",
          count: listings.filter((listing) => listing.golfCart).length,
        },
      },
    },
  };
}

function sanitizeDiscoverFacetsRequest(
  request?: DiscoverFacetsRequest,
): DiscoverFacetsRequest {
  return {
    sortOption:
      typeof request?.sortOption === "string"
        ? request.sortOption.trim() || undefined
        : undefined,
    locationQuery:
      typeof request?.locationQuery === "string"
        ? request.locationQuery.trim() || undefined
        : undefined,
    minSleeps:
      typeof request?.minSleeps === "number" &&
      Number.isFinite(request.minSleeps)
        ? request.minSleeps
        : undefined,
    minBedrooms:
      typeof request?.minBedrooms === "number" &&
      Number.isFinite(request.minBedrooms)
        ? request.minBedrooms
        : undefined,
    minBathrooms:
      typeof request?.minBathrooms === "number" &&
      Number.isFinite(request.minBathrooms)
        ? request.minBathrooms
        : undefined,
    filterPool:
      typeof request?.filterPool === "boolean" ? request.filterPool : undefined,
    filterGulffront:
      typeof request?.filterGulffront === "boolean"
        ? request.filterGulffront
        : undefined,
    filterGolfCart:
      typeof request?.filterGolfCart === "boolean"
        ? request.filterGolfCart
        : undefined,
    probeReason:
      typeof request?.probeReason === "string"
        ? request.probeReason.trim() || undefined
        : undefined,
  };
}

export async function executeDiscoverFacets(
  request?: DiscoverFacetsRequest,
): Promise<DiscoverFacetsResponse> {
  const startedAtMs = Date.now();
  const sanitizedRequest = sanitizeDiscoverFacetsRequest(request);
  const metadata = await getDiscoverCorpusMetadata().catch(() => null);

  const response: DiscoverFacetsResponse = {
    totalCount: metadata?.totalCount ?? 0,
    facets: metadata?.facets ?? {
      areas: {},
      beaches: {},
      communities: {},
      features: {
        gulf_front: { label: "Gulf Front", count: 0 },
        private_pool: { label: "Private Pool", count: 0 },
        golf_cart: { label: "Golf Cart", count: 0 },
      },
    },
    _meta: {
      generatedAt: new Date().toISOString(),
      serverDurationMs: Math.max(0, Date.now() - startedAtMs),
      request: sanitizedRequest,
    },
  };

  return response;
}

export async function executeDiscoverSearch(
  request: DiscoverSearchRequest,
): Promise<DiscoverSearchResponse> {
  const includeSlug = request.includeSlug?.trim() || undefined;

  if (includeSlug) {
    const listings = await buildDiscoverListingsPayload({ includeSlug });

    return {
      _stats: {
        totalCount: listings.length,
        count: listings.length,
        requested: listings.length,
      },
      metadata: buildMetadataFromListings(listings),
      listings,
    };
  }

  const payload = await buildDiscoverListingsPagePayload({
    limit: request.limit,
    offset: request.offset,
    includeMetadata: request.includeMetadata,
  });

  return payload;
}
