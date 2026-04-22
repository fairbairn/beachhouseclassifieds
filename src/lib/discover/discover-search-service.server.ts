import {
  buildDiscoverListingsPagePayload,
  buildDiscoverListingsPayload,
} from "@/lib/discover/discover-listings-api.server";
import {
  getDiscoverCorpusMetadata,
  getDiscoverSearchSource,
} from "@/lib/discover/discover-listings.server";
import type {
  DiscoverFacetsRequest,
  DiscoverFacetsResponse,
  DiscoverListing,
  DiscoverSearchMetadata,
  DiscoverSearchResponseMeta,
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
  const selectedFeatures = Array.isArray(request?.selectedFeatures)
    ? request.selectedFeatures
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter((entry) => entry.length > 0)
    : [];

  if (request?.filterGulffront) {
    selectedFeatures.push("gulf_front");
  }
  if (request?.filterPool) {
    selectedFeatures.push("private_pool");
  }
  if (request?.filterGolfCart) {
    selectedFeatures.push("golf_cart");
  }

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
    selectedFeatures:
      selectedFeatures.length > 0
        ? Array.from(new Set(selectedFeatures))
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

function sanitizeDiscoverSearchRequest(
  request?: DiscoverSearchRequest,
): DiscoverSearchRequest {
  const toStringArray = (value: unknown): string[] | undefined => {
    if (!Array.isArray(value)) {
      return undefined;
    }

    const out = value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => entry.length > 0);

    return out.length > 0 ? out : undefined;
  };

  const includeSlug =
    typeof request?.includeSlug === "string"
      ? request.includeSlug.trim() || undefined
      : undefined;
  const limit =
    typeof request?.limit === "number" && Number.isFinite(request.limit)
      ? request.limit
      : undefined;
  const offset =
    typeof request?.offset === "number" && Number.isFinite(request.offset)
      ? request.offset
      : undefined;
  const minKingBeds =
    typeof request?.minKingBeds === "number" &&
    Number.isFinite(request.minKingBeds)
      ? request.minKingBeds
      : undefined;
  const minQueenBeds =
    typeof request?.minQueenBeds === "number" &&
    Number.isFinite(request.minQueenBeds)
      ? request.minQueenBeds
      : undefined;
  const minBunkBeds =
    typeof request?.minBunkBeds === "number" &&
    Number.isFinite(request.minBunkBeds)
      ? request.minBunkBeds
      : undefined;

  return {
    includeSlug,
    limit,
    offset,
    includeMetadata:
      typeof request?.includeMetadata === "boolean"
        ? request.includeMetadata
        : undefined,
    selectedAreas: toStringArray(request?.selectedAreas),
    selectedBeaches: toStringArray(request?.selectedBeaches),
    selectedCommunities: toStringArray(request?.selectedCommunities),
    selectedFeatures: toStringArray(request?.selectedFeatures),
    minKingBeds,
    minQueenBeds,
    minBunkBeds,
  };
}

function buildDiscoverSearchMeta(input: {
  startedAtMs: number;
  request: DiscoverSearchRequest;
}): DiscoverSearchResponseMeta {
  return {
    generatedAt: new Date().toISOString(),
    serverDurationMs: Math.max(0, Date.now() - input.startedAtMs),
    request: sanitizeDiscoverSearchRequest(input.request),
  };
}

export async function executeDiscoverFacets(
  request?: DiscoverFacetsRequest,
): Promise<DiscoverFacetsResponse> {
  const startedAtMs = Date.now();
  const sanitizedRequest = sanitizeDiscoverFacetsRequest(request);
  const metadata = await getDiscoverCorpusMetadata({
    selectedFeatures: sanitizedRequest.selectedFeatures,
  });

  const response: DiscoverFacetsResponse = {
    source: getDiscoverSearchSource(),
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
  const startedAtMs = Date.now();
  const includeSlug = request.includeSlug?.trim() || undefined;

  if (includeSlug) {
    const listings = await buildDiscoverListingsPayload({ includeSlug });

    return {
      source: "postgres",
      _meta: buildDiscoverSearchMeta({ startedAtMs, request }),
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
    selectedAreas: request.selectedAreas,
    selectedBeaches: request.selectedBeaches,
    selectedCommunities: request.selectedCommunities,
    selectedFeatures: request.selectedFeatures,
    minKingBeds: request.minKingBeds,
    minQueenBeds: request.minQueenBeds,
    minBunkBeds: request.minBunkBeds,
  });

  return {
    ...payload,
    _meta: buildDiscoverSearchMeta({ startedAtMs, request }),
  };
}
