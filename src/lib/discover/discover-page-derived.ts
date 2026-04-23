import type {
  DiscoverListing,
  DiscoverListingsPageResponse,
  DiscoverMapListing,
} from "@/lib/discover/discover-types";

export type DiscoverSortValue =
  | "recommended"
  | "price-low"
  | "price-high"
  | "sleeps-high"
  | "beach-pool-first";

export type DiscoverFilterState = {
  locationQuery: string;
  guestCount: number;
  minSleeps: number;
  minBedrooms: number;
  minBathrooms: number;
  minKingBeds: number;
  minQueenBeds: number;
  minBunkBeds: number;
  filterPool: boolean;
  filterGulffront: boolean;
  filterGolfCart: boolean;
};

export function filterDiscoverListings(
  sourceListings: ReadonlyArray<DiscoverListing>,
  filters: DiscoverFilterState,
): DiscoverListing[] {
  const normalizedQuery = filters.locationQuery.trim().toLowerCase();

  return sourceListings.filter((listing) => {
    const locationBlob =
      `${listing.beach} ${listing.area} ${listing.community} ${listing.name}`.toLowerCase();
    const passesLocation =
      normalizedQuery.length === 0 || locationBlob.includes(normalizedQuery);

    return (
      passesLocation &&
      listing.sleeps >= filters.guestCount &&
      listing.sleeps >= filters.minSleeps &&
      listing.bedrooms >= filters.minBedrooms &&
      listing.bathrooms >= filters.minBathrooms &&
      (listing.sleepingSummary?.bed_counts?.king ?? 0) >= filters.minKingBeds &&
      (listing.sleepingSummary?.bed_counts?.queen ?? 0) >=
        filters.minQueenBeds &&
      (listing.sleepingSummary?.bed_counts?.bunk_beds ?? 0) >=
        filters.minBunkBeds &&
      (!filters.filterPool || listing.privatePool) &&
      (!filters.filterGulffront || listing.gulffront) &&
      (!filters.filterGolfCart || listing.golfCart)
    );
  });
}

export function sortDiscoverListings(input: {
  listings: ReadonlyArray<DiscoverListing>;
  sortOption: DiscoverSortValue;
  nights: number;
}): DiscoverListing[] {
  const listings = [...input.listings];

  if (input.sortOption === "recommended") {
    return listings;
  }

  if (input.sortOption === "price-low") {
    return listings.sort((a, b) => {
      const aPrice = a.typicalAllInNightly * input.nights;
      const bPrice = b.typicalAllInNightly * input.nights;
      return aPrice - bPrice;
    });
  }

  if (input.sortOption === "price-high") {
    return listings.sort((a, b) => {
      const aPrice = a.typicalAllInNightly * input.nights;
      const bPrice = b.typicalAllInNightly * input.nights;
      return bPrice - aPrice;
    });
  }

  if (input.sortOption === "sleeps-high") {
    return listings.sort((a, b) => b.sleeps - a.sleeps);
  }

  return listings.sort((a, b) => {
    if (a.gulffront !== b.gulffront) {
      return Number(b.gulffront) - Number(a.gulffront);
    }
    if (a.privatePool !== b.privatePool) {
      return Number(b.privatePool) - Number(a.privatePool);
    }
    return b.sleeps - a.sleeps;
  });
}

export function buildDiscoverMapListings(input: {
  displayListings: ReadonlyArray<DiscoverListing>;
  hasClientSideNarrowing: boolean;
  mapSeedListings?: ReadonlyArray<DiscoverMapListing>;
  nights: number;
  getListingGeo: (listing: DiscoverListing) => { lat: number; lng: number };
}): Array<{
  id: string;
  name: string;
  lat: number;
  lng: number;
  hoverPriceAmount: string;
}> {
  if (
    !input.hasClientSideNarrowing &&
    Array.isArray(input.mapSeedListings) &&
    input.mapSeedListings.length > 0
  ) {
    return input.mapSeedListings.map((listing) => {
      const typicalTotal = Math.ceil(
        listing.typicalAllInNightly * input.nights,
      );
      return {
        id: listing.id,
        name: listing.name,
        lat: listing.lat,
        lng: listing.lng,
        hoverPriceAmount: `$${typicalTotal.toLocaleString("en-US")}`,
      };
    });
  }

  return input.displayListings.map((listing) => {
    const geoTarget = input.getListingGeo(listing);
    const typicalTotal = Math.ceil(listing.typicalAllInNightly * input.nights);
    return {
      id: listing.id,
      name: listing.name,
      lat: geoTarget.lat,
      lng: geoTarget.lng,
      hoverPriceAmount: `$${typicalTotal.toLocaleString("en-US")}`,
    };
  });
}

export type DiscoverFeatureCount = {
  code: "gulf_front" | "private_pool" | "golf_cart";
  label: string;
  count: number;
};

export function buildDiscoverFacetCounts(input: {
  filteredListings: ReadonlyArray<DiscoverListing>;
  knownAreas: ReadonlyArray<string>;
  knownBeaches: ReadonlyArray<string>;
  knownCommunities: ReadonlyArray<string>;
  getArea: (listing: DiscoverListing) => string | null | undefined;
  getBeach: (listing: DiscoverListing) => string | null | undefined;
}): {
  areaCounts: Array<readonly [string, number]>;
  beachCounts: Array<readonly [string, number]>;
  communityCounts: Array<readonly [string, number]>;
  featureCounts: DiscoverFeatureCount[];
} {
  const areaMap = new Map<string, number>();
  const beachMap = new Map<string, number>();
  const communityMap = new Map<string, number>();
  const communitySet = new Set(input.knownCommunities);
  const beachSet = new Set(input.knownBeaches);

  let privatePoolCount = 0;
  let beachfrontCount = 0;
  let golfCartCount = 0;

  for (const listing of input.filteredListings) {
    const normalizedArea = input.getArea(listing);
    if (normalizedArea) {
      areaMap.set(normalizedArea, (areaMap.get(normalizedArea) ?? 0) + 1);
    }

    const beachZone = input.getBeach(listing);
    if (beachZone && beachSet.has(beachZone)) {
      beachMap.set(beachZone, (beachMap.get(beachZone) ?? 0) + 1);
    }

    if (communitySet.has(listing.community)) {
      communityMap.set(
        listing.community,
        (communityMap.get(listing.community) ?? 0) + 1,
      );
    }

    if (listing.privatePool) {
      privatePoolCount += 1;
    }
    if (listing.gulffront) {
      beachfrontCount += 1;
    }
    if (listing.golfCart) {
      golfCartCount += 1;
    }
  }

  return {
    areaCounts: input.knownAreas.map((name) => [name, areaMap.get(name) ?? 0]),
    beachCounts: input.knownBeaches.map((name) => [
      name,
      beachMap.get(name) ?? 0,
    ]),
    communityCounts: input.knownCommunities.map((name) => [
      name,
      communityMap.get(name) ?? 0,
    ]),
    featureCounts: [
      { code: "gulf_front", label: "Gulf Front", count: beachfrontCount },
      {
        code: "private_pool",
        label: "Private Pool",
        count: privatePoolCount,
      },
      { code: "golf_cart", label: "Golf Cart", count: golfCartCount },
    ],
  };
}

export function buildEffectiveDiscoverFacetCounts(input: {
  hasClientSideNarrowing: boolean;
  initialListingsPage?: DiscoverListingsPageResponse;
  displayListingsLength: number;
  knownAreas: ReadonlyArray<string>;
  knownBeaches: ReadonlyArray<string>;
  knownCommunities: ReadonlyArray<string>;
  areaCounts: Array<readonly [string, number]>;
  beachCounts: Array<readonly [string, number]>;
  communityCounts: Array<readonly [string, number]>;
  featureCounts: DiscoverFeatureCount[];
}): {
  effectiveListingCount: number;
  effectiveAreaCounts: Array<readonly [string, number]>;
  effectiveBeachCounts: Array<readonly [string, number]>;
  effectiveCommunityCounts: Array<readonly [string, number]>;
  effectiveFeatureCounts: DiscoverFeatureCount[];
} {
  const metadata = input.initialListingsPage?.metadata;
  const shouldUseMetadata = !input.hasClientSideNarrowing && Boolean(metadata);

  if (!shouldUseMetadata || !metadata) {
    return {
      effectiveListingCount: input.displayListingsLength,
      effectiveAreaCounts: input.areaCounts,
      effectiveBeachCounts: input.beachCounts,
      effectiveCommunityCounts: input.communityCounts,
      effectiveFeatureCounts: input.featureCounts,
    };
  }

  const areaCountByLabel = new Map(
    Object.values(metadata.facets.areas).map(
      (item) => [item.label, item.count] as const,
    ),
  );
  const beachCountByLabel = new Map(
    Object.values(metadata.facets.beaches).map(
      (item) => [item.label, item.count] as const,
    ),
  );
  const communityCountByLabel = new Map(
    Object.values(metadata.facets.communities).map(
      (item) => [item.label, item.count] as const,
    ),
  );

  return {
    effectiveListingCount: metadata.totalCount,
    effectiveAreaCounts: input.knownAreas.map((name) => [
      name,
      areaCountByLabel.get(name) ?? 0,
    ]),
    effectiveBeachCounts: input.knownBeaches.map((name) => [
      name,
      beachCountByLabel.get(name) ?? 0,
    ]),
    effectiveCommunityCounts: input.knownCommunities.map((name) => [
      name,
      communityCountByLabel.get(name) ?? 0,
    ]),
    effectiveFeatureCounts: [
      {
        code: "gulf_front",
        label: "Gulf Front",
        count: metadata.facets.features.gulf_front?.count ?? 0,
      },
      {
        code: "private_pool",
        label: "Private Pool",
        count: metadata.facets.features.private_pool?.count ?? 0,
      },
      {
        code: "golf_cart",
        label: "Golf Cart",
        count: metadata.facets.features.golf_cart?.count ?? 0,
      },
    ],
  };
}
