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
}): DiscoverListingsMetadata {
  return {
    totalCount: input.totalCount,
    mapListings: input.listings
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
  limit?: number;
  offset?: number;
  includeMetadata?: boolean;
  selectedAreas?: string[];
  selectedBeaches?: string[];
  selectedCommunities?: string[];
  selectedFeatures?: string[];
  minKingBeds?: number;
  minQueenBeds?: number;
  minBunkBeds?: number;
}): Promise<DiscoverListingsPagePayload> {
  const pageSize = resolvePageSize(input?.limit);
  const offset =
    typeof input?.offset === "number" && Number.isFinite(input.offset)
      ? Math.max(0, Math.floor(input.offset))
      : 0;
  const includeMetadata = input?.includeMetadata ?? offset === 0;
  const hasSelectedFacetFilters = Boolean(
    (input?.selectedAreas?.length ?? 0) > 0 ||
    (input?.selectedBeaches?.length ?? 0) > 0 ||
    (input?.selectedCommunities?.length ?? 0) > 0 ||
    (input?.selectedFeatures?.length ?? 0) > 0,
  );

  if (includeMetadata && offset === 0) {
    const snapshot = await getDiscoverListingsSnapshot({
      pageLimit: pageSize,
      mapLimit: DISCOVER_MAP_SEED_MAX,
      selectedAreas: input?.selectedAreas,
      selectedBeaches: input?.selectedBeaches,
      selectedCommunities: input?.selectedCommunities,
      selectedFeatures: input?.selectedFeatures,
      minKingBeds: input?.minKingBeds,
      minQueenBeds: input?.minQueenBeds,
      minBunkBeds: input?.minBunkBeds,
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
        mapListings: snapshot.mapListings,
        facets: snapshot.facets,
      },
      listings: pageItems.map(toSummaryListing),
    };
  }

  const [pageItems, filteredTotalCount, corpusMetadata] = await Promise.all([
    buildDiscoverListingsPayload({
      maxListings: pageSize,
      offset,
      selectedAreas: input?.selectedAreas,
      selectedBeaches: input?.selectedBeaches,
      selectedCommunities: input?.selectedCommunities,
      selectedFeatures: input?.selectedFeatures,
      minKingBeds: input?.minKingBeds,
      minQueenBeds: input?.minQueenBeds,
      minBunkBeds: input?.minBunkBeds,
    }),
    getDiscoverListingsCount({
      selectedAreas: input?.selectedAreas,
      selectedBeaches: input?.selectedBeaches,
      selectedCommunities: input?.selectedCommunities,
      selectedFeatures: input?.selectedFeatures,
      minKingBeds: input?.minKingBeds,
      minQueenBeds: input?.minQueenBeds,
      minBunkBeds: input?.minBunkBeds,
    }),
    includeMetadata
      ? getDiscoverCorpusMetadata({
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
      offset > 0 ||
      pageItems.length < Math.min(DISCOVER_MAP_SEED_MAX, totalCount);

    if (needsMapSeedFetch) {
      metadataListings = await buildDiscoverListingsPayload({
        maxListings: DISCOVER_MAP_SEED_MAX,
        offset: 0,
        selectedAreas: input?.selectedAreas,
        selectedBeaches: input?.selectedBeaches,
        selectedCommunities: input?.selectedCommunities,
        selectedFeatures: input?.selectedFeatures,
        minKingBeds: input?.minKingBeds,
        minQueenBeds: input?.minQueenBeds,
        minBunkBeds: input?.minBunkBeds,
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
          }),
        }
      : {}),
    listings: pageItems.map(toSummaryListing),
  };
}

export async function buildDiscoverListingsPayload(input?: {
  includeSlug?: string;
  maxListings?: number | null;
  offset?: number;
  selectedAreas?: string[];
  selectedBeaches?: string[];
  selectedCommunities?: string[];
  selectedFeatures?: string[];
  minKingBeds?: number;
  minQueenBeds?: number;
  minBunkBeds?: number;
}): Promise<DiscoverListing[]> {
  const includeSlug = input?.includeSlug?.trim() || undefined;

  const sourceListings = await getDiscoverListings({
    includeSlug,
    onlySlug: Boolean(includeSlug),
    disableFallback: true,
    maxListings: includeSlug ? 1 : input?.maxListings,
    offset: includeSlug ? undefined : input?.offset,
    selectedAreas: input?.selectedAreas,
    selectedBeaches: input?.selectedBeaches,
    selectedCommunities: input?.selectedCommunities,
    selectedFeatures: input?.selectedFeatures,
    minKingBeds: input?.minKingBeds,
    minQueenBeds: input?.minQueenBeds,
    minBunkBeds: input?.minBunkBeds,
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
