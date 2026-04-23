import {
  AVAILABILITY_WINDOW_DAYS_LIMIT,
  DEFAULT_MAX_STAY_NIGHTS,
  validateAvailabilityWindowInput,
} from "@/lib/discover/availability-window-index";
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
  DiscoverSearchRequest,
  DiscoverSearchResponse,
  DiscoverSearchResponseMeta,
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
  const sortOption =
    typeof request?.sortOption === "string"
      ? request.sortOption.trim() || undefined
      : undefined;
  const limit =
    typeof request?.limit === "number" && Number.isFinite(request.limit)
      ? request.limit
      : undefined;
  const offset =
    typeof request?.offset === "number" && Number.isFinite(request.offset)
      ? request.offset
      : undefined;
  const locationQuery =
    typeof request?.locationQuery === "string"
      ? request.locationQuery.trim() || undefined
      : undefined;
  const minSleeps =
    typeof request?.minSleeps === "number" &&
    Number.isFinite(request.minSleeps) &&
    request.minSleeps > 0
      ? request.minSleeps
      : undefined;
  const minBedrooms =
    typeof request?.minBedrooms === "number" &&
    Number.isFinite(request.minBedrooms) &&
    request.minBedrooms > 0
      ? request.minBedrooms
      : undefined;
  const minBathrooms =
    typeof request?.minBathrooms === "number" &&
    Number.isFinite(request.minBathrooms) &&
    request.minBathrooms > 0
      ? request.minBathrooms
      : undefined;
  const minKingBeds =
    typeof request?.minKingBeds === "number" &&
    Number.isFinite(request.minKingBeds) &&
    request.minKingBeds > 0
      ? request.minKingBeds
      : undefined;
  const minQueenBeds =
    typeof request?.minQueenBeds === "number" &&
    Number.isFinite(request.minQueenBeds) &&
    request.minQueenBeds > 0
      ? request.minQueenBeds
      : undefined;
  const minBunkBeds =
    typeof request?.minBunkBeds === "number" &&
    Number.isFinite(request.minBunkBeds) &&
    request.minBunkBeds > 0
      ? request.minBunkBeds
      : undefined;
  const availabilityWindowStartDayInt =
    typeof request?.availabilityWindowStartDayInt === "number" &&
    Number.isFinite(request.availabilityWindowStartDayInt)
      ? Math.floor(request.availabilityWindowStartDayInt)
      : undefined;
  const availabilityWindowEndDayInt =
    typeof request?.availabilityWindowEndDayInt === "number" &&
    Number.isFinite(request.availabilityWindowEndDayInt)
      ? Math.floor(request.availabilityWindowEndDayInt)
      : undefined;
  const availabilityStayNights =
    typeof request?.availabilityStayNights === "number" &&
    Number.isFinite(request.availabilityStayNights)
      ? Math.floor(request.availabilityStayNights)
      : undefined;
  const includeMapListings =
    typeof request?.includeMapListings === "boolean"
      ? request.includeMapListings
      : undefined;
  const includeMetadata =
    typeof request?.includeMetadata === "boolean"
      ? request.includeMetadata
      : undefined;
  const selectedAreas = toStringArray(request?.selectedAreas);
  const selectedBeaches = toStringArray(request?.selectedBeaches);
  const selectedCommunities = toStringArray(request?.selectedCommunities);
  const selectedFeatures = toStringArray(request?.selectedFeatures);

  const sanitizedRequest: DiscoverSearchRequest = {};

  if (includeSlug !== undefined) {
    sanitizedRequest.includeSlug = includeSlug;
  }
  if (sortOption !== undefined) {
    sanitizedRequest.sortOption =
      sortOption as DiscoverSearchRequest["sortOption"];
  }
  if (limit !== undefined) {
    sanitizedRequest.limit = limit;
  }
  if (offset !== undefined) {
    sanitizedRequest.offset = offset;
  }
  if (locationQuery !== undefined) {
    sanitizedRequest.locationQuery = locationQuery;
  }
  if (minSleeps !== undefined) {
    sanitizedRequest.minSleeps = minSleeps;
  }
  if (minBedrooms !== undefined) {
    sanitizedRequest.minBedrooms = minBedrooms;
  }
  if (minBathrooms !== undefined) {
    sanitizedRequest.minBathrooms = minBathrooms;
  }
  if (includeMapListings !== undefined) {
    sanitizedRequest.includeMapListings = includeMapListings;
  }
  if (includeMetadata !== undefined) {
    sanitizedRequest.includeMetadata = includeMetadata;
  }
  if (selectedAreas !== undefined) {
    sanitizedRequest.selectedAreas = selectedAreas;
  }
  if (selectedBeaches !== undefined) {
    sanitizedRequest.selectedBeaches = selectedBeaches;
  }
  if (selectedCommunities !== undefined) {
    sanitizedRequest.selectedCommunities = selectedCommunities;
  }
  if (selectedFeatures !== undefined) {
    sanitizedRequest.selectedFeatures = selectedFeatures;
  }
  if (minKingBeds !== undefined) {
    sanitizedRequest.minKingBeds = minKingBeds;
  }
  if (minQueenBeds !== undefined) {
    sanitizedRequest.minQueenBeds = minQueenBeds;
  }
  if (minBunkBeds !== undefined) {
    sanitizedRequest.minBunkBeds = minBunkBeds;
  }

  const availabilityValidation = validateAvailabilityWindowInput({
    windowStartDayInt: availabilityWindowStartDayInt,
    windowEndDayInt: availabilityWindowEndDayInt,
    stayNights: availabilityStayNights,
    maxWindowDays: AVAILABILITY_WINDOW_DAYS_LIMIT,
    maxStayNights: DEFAULT_MAX_STAY_NIGHTS,
  });

  if (availabilityValidation.isValid) {
    if (availabilityWindowStartDayInt !== undefined) {
      sanitizedRequest.availabilityWindowStartDayInt =
        availabilityWindowStartDayInt;
    }
    if (availabilityWindowEndDayInt !== undefined) {
      sanitizedRequest.availabilityWindowEndDayInt =
        availabilityWindowEndDayInt;
    }
    if (availabilityStayNights !== undefined) {
      sanitizedRequest.availabilityStayNights = availabilityStayNights;
    }
  }

  return sanitizedRequest;
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
  const sanitizedRequest = sanitizeDiscoverSearchRequest(request);
  const includeSlug = sanitizedRequest.includeSlug?.trim() || undefined;

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
    sortOption: sanitizedRequest.sortOption,
    limit: sanitizedRequest.limit,
    offset: sanitizedRequest.offset,
    includeMetadata: sanitizedRequest.includeMetadata,
    includeMapListings: sanitizedRequest.includeMapListings,
    locationQuery: sanitizedRequest.locationQuery,
    minSleeps: sanitizedRequest.minSleeps,
    minBedrooms: sanitizedRequest.minBedrooms,
    minBathrooms: sanitizedRequest.minBathrooms,
    selectedAreas: sanitizedRequest.selectedAreas,
    selectedBeaches: sanitizedRequest.selectedBeaches,
    selectedCommunities: sanitizedRequest.selectedCommunities,
    selectedFeatures: sanitizedRequest.selectedFeatures,
    minKingBeds: sanitizedRequest.minKingBeds,
    minQueenBeds: sanitizedRequest.minQueenBeds,
    minBunkBeds: sanitizedRequest.minBunkBeds,
    availabilityWindowStartDayInt:
      sanitizedRequest.availabilityWindowStartDayInt,
    availabilityWindowEndDayInt: sanitizedRequest.availabilityWindowEndDayInt,
    availabilityStayNights: sanitizedRequest.availabilityStayNights,
  });

  return {
    ...payload,
    _meta: buildDiscoverSearchMeta({ startedAtMs, request: sanitizedRequest }),
  };
}
