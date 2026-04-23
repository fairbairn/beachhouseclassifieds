import { normalizeDiscoverListings } from "@/lib/discover/community-normalization";
import {
  getDiscoverCorpusMetadata,
  getDiscoverListings,
  getDiscoverListingsCount,
  getDiscoverListingsSnapshot,
  getDiscoverSearchSource,
} from "@/lib/discover/discover-listings.server";
import type {
  DiscoverListing,
  DiscoverListingDetailPayload,
  DiscoverListingsMetadata,
  DiscoverListingsPagePayload,
} from "@/lib/discover/discover-types";

const DEFAULT_DISCOVER_PAGE_SIZE = 96;
const MAX_DISCOVER_PAGE_SIZE = 96;
const DISCOVER_MAP_SEED_MAX = 96;

function normalizeDiscoverListingsForApi(listings: DiscoverListing[]) {
  const normalizedListings = normalizeDiscoverListings(listings);

  // Server discover payloads should remain independent of UI utility modules.
  const resolveArea = (listing: DiscoverListing): string => {
    const area = listing.area.trim();
    return area.length > 0 ? area : "30A";
  };

  const locationAlignedListings = normalizedListings.map((listing) => ({
    ...listing,
    area: resolveArea(listing),
  }));

  return locationAlignedListings;
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
    petFriendly: listing.petFriendly,
    accessible: listing.accessible,
    elevator: listing.elevator,
    sleepingSummary: listing.sleepingSummary,
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

function buildMetadataFromListings(input: {
  listings: DiscoverListing[];
  totalCount: number;
  facets?: DiscoverListingsMetadata["facets"];
  includeMapListings?: boolean;
}): DiscoverListingsMetadata {
  const includeMapListings = input.includeMapListings !== false;

  return {
    totalCount: input.totalCount,
    mapListings: includeMapListings
      ? input.listings
          .filter(
            (listing) =>
              typeof listing.lat === "number" &&
              typeof listing.lng === "number",
          )
          .map((listing) => ({
            id: listing.id,
            name: listing.name,
            lat: listing.lat as number,
            lng: listing.lng as number,
            typicalAllInNightly: listing.typicalAllInNightly,
          }))
      : [],
    facets: input.facets ?? {
      areas: {},
      beaches: {},
      communities: {},
      features: {
        gulf_front: {
          label: "Gulf Front",
          count: input.listings.filter((listing) => listing.gulffront).length,
        },
        private_pool: {
          label: "Private Pool",
          count: input.listings.filter((listing) => listing.privatePool).length,
        },
        golf_cart: {
          label: "Golf Cart",
          count: input.listings.filter((listing) => listing.golfCart).length,
        },
      },
    },
  };
}

export async function buildDiscoverListingsPagePayload(input?: {
  sortOption?:
    | "recommended"
    | "price-low"
    | "price-high"
    | "sleeps-high"
    | "beach-pool-first";
  limit?: number;
  offset?: number;
  includeMetadata?: boolean;
  includeMapListings?: boolean;
  locationQuery?: string;
  minSleeps?: number;
  minBedrooms?: number;
  minBathrooms?: number;
  selectedAreas?: string[];
  selectedBeaches?: string[];
  selectedCommunities?: string[];
  selectedFeatures?: string[];
  minKingBeds?: number;
  minQueenBeds?: number;
  minBunkBeds?: number;
  availabilityWindowStartDayInt?: number;
  availabilityWindowEndDayInt?: number;
  availabilityStayNights?: number;
}): Promise<DiscoverListingsPagePayload> {
  const pageSize = resolvePageSize(input?.limit);
  const offset =
    typeof input?.offset === "number" && Number.isFinite(input.offset)
      ? Math.max(0, Math.floor(input.offset))
      : 0;
  const includeMetadata = input?.includeMetadata ?? offset === 0;
  const includeMapListings = input?.includeMapListings ?? includeMetadata;
  const hasSelectedFacetFilters = Boolean(
    (input?.selectedAreas?.length ?? 0) > 0 ||
    (input?.selectedBeaches?.length ?? 0) > 0 ||
    (input?.selectedCommunities?.length ?? 0) > 0 ||
    (input?.selectedFeatures?.length ?? 0) > 0,
  );

  if (includeMetadata && offset === 0) {
    const snapshot = await getDiscoverListingsSnapshot({
      sortOption: input?.sortOption,
      pageLimit: pageSize,
      mapLimit: includeMapListings ? DISCOVER_MAP_SEED_MAX : pageSize,
      locationQuery: input?.locationQuery,
      minSleeps: input?.minSleeps,
      minBedrooms: input?.minBedrooms,
      minBathrooms: input?.minBathrooms,
      selectedAreas: input?.selectedAreas,
      selectedBeaches: input?.selectedBeaches,
      selectedCommunities: input?.selectedCommunities,
      selectedFeatures: input?.selectedFeatures,
      minKingBeds: input?.minKingBeds,
      minQueenBeds: input?.minQueenBeds,
      minBunkBeds: input?.minBunkBeds,
      availabilityWindowStartDayInt: input?.availabilityWindowStartDayInt,
      availabilityWindowEndDayInt: input?.availabilityWindowEndDayInt,
      availabilityStayNights: input?.availabilityStayNights,
    });
    const pageItems = normalizeDiscoverListingsForApi(snapshot.pageListings);
    const totalCount = hasSelectedFacetFilters
      ? Math.max(0, snapshot.totalCount)
      : Math.max(snapshot.totalCount, pageItems.length);

    return {
      source: "meilisearch",
      _stats: {
        totalCount,
        count: pageItems.length,
        requested: pageSize,
      },
      metadata: {
        totalCount,
        mapListings: includeMapListings ? snapshot.mapListings : [],
        facets: snapshot.facets,
      },
      listings: pageItems.map(toSummaryListing),
    };
  }

  const [pageItems, filteredTotalCount, corpusMetadata] = await Promise.all([
    buildDiscoverListingsPayload({
      sortOption: input?.sortOption,
      maxListings: pageSize,
      offset,
      locationQuery: input?.locationQuery,
      minSleeps: input?.minSleeps,
      minBedrooms: input?.minBedrooms,
      minBathrooms: input?.minBathrooms,
      selectedAreas: input?.selectedAreas,
      selectedBeaches: input?.selectedBeaches,
      selectedCommunities: input?.selectedCommunities,
      selectedFeatures: input?.selectedFeatures,
      minKingBeds: input?.minKingBeds,
      minQueenBeds: input?.minQueenBeds,
      minBunkBeds: input?.minBunkBeds,
      availabilityWindowStartDayInt: input?.availabilityWindowStartDayInt,
      availabilityWindowEndDayInt: input?.availabilityWindowEndDayInt,
      availabilityStayNights: input?.availabilityStayNights,
    }),
    getDiscoverListingsCount({
      locationQuery: input?.locationQuery,
      minSleeps: input?.minSleeps,
      minBedrooms: input?.minBedrooms,
      minBathrooms: input?.minBathrooms,
      selectedAreas: input?.selectedAreas,
      selectedBeaches: input?.selectedBeaches,
      selectedCommunities: input?.selectedCommunities,
      selectedFeatures: input?.selectedFeatures,
      minKingBeds: input?.minKingBeds,
      minQueenBeds: input?.minQueenBeds,
      minBunkBeds: input?.minBunkBeds,
      availabilityWindowStartDayInt: input?.availabilityWindowStartDayInt,
      availabilityWindowEndDayInt: input?.availabilityWindowEndDayInt,
      availabilityStayNights: input?.availabilityStayNights,
    }),
    includeMetadata
      ? getDiscoverCorpusMetadata({
          locationQuery: input?.locationQuery,
          minSleeps: input?.minSleeps,
          minBedrooms: input?.minBedrooms,
          minBathrooms: input?.minBathrooms,
          selectedFeatures: input?.selectedFeatures,
          minKingBeds: input?.minKingBeds,
          minQueenBeds: input?.minQueenBeds,
          minBunkBeds: input?.minBunkBeds,
        })
      : null,
  ]);

  const totalCount = hasSelectedFacetFilters
    ? Math.max(0, filteredTotalCount)
    : Math.max(corpusMetadata?.totalCount ?? 0, offset + pageItems.length);

  let metadataListings = pageItems;
  if (includeMetadata) {
    const needsMapSeedFetch =
      includeMapListings &&
      (offset > 0 ||
        pageItems.length < Math.min(DISCOVER_MAP_SEED_MAX, totalCount));

    if (needsMapSeedFetch) {
      metadataListings = await buildDiscoverListingsPayload({
        sortOption: input?.sortOption,
        maxListings: DISCOVER_MAP_SEED_MAX,
        offset: 0,
        locationQuery: input?.locationQuery,
        minSleeps: input?.minSleeps,
        minBedrooms: input?.minBedrooms,
        minBathrooms: input?.minBathrooms,
        selectedAreas: input?.selectedAreas,
        selectedBeaches: input?.selectedBeaches,
        selectedCommunities: input?.selectedCommunities,
        selectedFeatures: input?.selectedFeatures,
        minKingBeds: input?.minKingBeds,
        minQueenBeds: input?.minQueenBeds,
        minBunkBeds: input?.minBunkBeds,
        availabilityWindowStartDayInt: input?.availabilityWindowStartDayInt,
        availabilityWindowEndDayInt: input?.availabilityWindowEndDayInt,
        availabilityStayNights: input?.availabilityStayNights,
      });
    }
  }

  return {
    source: getDiscoverSearchSource(),
    _stats: {
      totalCount,
      count: pageItems.length,
      requested: pageSize,
    },
    ...(includeMetadata
      ? {
          metadata: buildMetadataFromListings({
            listings: metadataListings,
            totalCount,
            facets: corpusMetadata?.facets,
            includeMapListings,
          }),
        }
      : {}),
    listings: pageItems.map(toSummaryListing),
  };
}

export async function buildDiscoverListingsPayload(input?: {
  sortOption?:
    | "recommended"
    | "price-low"
    | "price-high"
    | "sleeps-high"
    | "beach-pool-first";
  includeSlug?: string;
  maxListings?: number | null;
  offset?: number;
  locationQuery?: string;
  minSleeps?: number;
  minBedrooms?: number;
  minBathrooms?: number;
  selectedAreas?: string[];
  selectedBeaches?: string[];
  selectedCommunities?: string[];
  selectedFeatures?: string[];
  minKingBeds?: number;
  minQueenBeds?: number;
  minBunkBeds?: number;
  availabilityWindowStartDayInt?: number;
  availabilityWindowEndDayInt?: number;
  availabilityStayNights?: number;
}): Promise<DiscoverListing[]> {
  const includeSlug = input?.includeSlug?.trim() || undefined;

  const sourceListings = await getDiscoverListings({
    sortOption: input?.sortOption,
    includeSlug,
    onlySlug: Boolean(includeSlug),
    disableFallback: true,
    maxListings: includeSlug ? 1 : input?.maxListings,
    offset: includeSlug ? undefined : input?.offset,
    locationQuery: input?.locationQuery,
    minSleeps: input?.minSleeps,
    minBedrooms: input?.minBedrooms,
    minBathrooms: input?.minBathrooms,
    selectedAreas: input?.selectedAreas,
    selectedBeaches: input?.selectedBeaches,
    selectedCommunities: input?.selectedCommunities,
    selectedFeatures: input?.selectedFeatures,
    minKingBeds: input?.minKingBeds,
    minQueenBeds: input?.minQueenBeds,
    minBunkBeds: input?.minBunkBeds,
    availabilityWindowStartDayInt: input?.availabilityWindowStartDayInt,
    availabilityWindowEndDayInt: input?.availabilityWindowEndDayInt,
    availabilityStayNights: input?.availabilityStayNights,
  });

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
