export type DiscoverListing = {
  id: string;
  name: string;
  area: string;
  beach: string;
  community: string;
  lat?: number;
  lng?: number;
  bedrooms: number;
  bathrooms: number;
  sleeps: number;
  privatePool: boolean;
  gulffront: boolean;
  golfCart: boolean;
  previewImages: string[];
  imageCount?: number;
  typicalPrice?: string;
  typicalPricingMonth: string;
  typicalBaseNightly: number;
  typicalAllInNightly: number;
  upcomingTypicalPricingMonths?: Array<{
    monthLabel: string;
    monthStartDate: string;
    typicalAllInNightly: number;
  }>;
  descriptionHeadline?: string;
  descriptionMarkdown?: string;
  description?: string;
  highlightsList?: string[];
  helpfulHints?: string[];
  sleepingArrangements?: string[];
  amenitiesList?: string[];
  nearbyPoints?: string[];
  checkInTime?: string;
  checkOutTime?: string;
  imageGallery?: Array<{
    name: string;
    url: string;
  }>;
  availabilityCalendarStatus?: Record<
    string,
    {
      dayType: "available" | "checkin_only" | "checkout_only" | "unavailable";
      isNightAvailable: boolean;
      isCheckInAllowed: boolean;
      isCheckOutAllowed: boolean;
      minNights: number | null;
      allInNightly: number | null;
      statusConfidence: "observed" | "derived";
    }
  >;
  sleepingSummary?: {
    bed_counts?: {
      king?: number;
      queen?: number;
      full?: number;
      twin_standalone?: number;
      bunk_beds?: number;
    };
  };
};

export type DiscoverFacetBucketEntry = {
  label?: string;
  count: number;
};

export type DiscoverFacetBucket = Record<string, DiscoverFacetBucketEntry>;

export type DiscoverFacetGroups = {
  areas: DiscoverFacetBucket;
  beaches: DiscoverFacetBucket;
  communities: DiscoverFacetBucket;
  features: DiscoverFacetBucket;
};

export type DiscoverMapListing = {
  id: string;
  name: string;
  lat: number;
  lng: number;
  typicalAllInNightly: number;
};

export type DiscoverSearchMetadata = {
  totalCount: number;
  mapListings: DiscoverMapListing[];
  facets: DiscoverFacetGroups;
};

export type DiscoverListingsMetadata = DiscoverSearchMetadata;

export type DiscoverPageStats = {
  totalCount: number;
  count: number;
  requested: number;
};

export type DiscoverSearchRequest = {
  includeSlug?: string;
  limit?: number;
  offset?: number;
  includeMetadata?: boolean;
};

export type DiscoverFacetsRequest = {
  sortOption?: string;
  locationQuery?: string;
  minSleeps?: number;
  minBedrooms?: number;
  minBathrooms?: number;
  filterPool?: boolean;
  filterGulffront?: boolean;
  filterGolfCart?: boolean;
  probeReason?: string;
};

export type DiscoverListingsStats = DiscoverPageStats;

export type DiscoverSearchResponse = {
  _stats: DiscoverListingsStats;
  metadata?: DiscoverListingsMetadata;
  listings: DiscoverListing[];
};

export type DiscoverListingsPagePayload = {
  _stats: DiscoverListingsStats;
  metadata?: DiscoverListingsMetadata;
  listings: DiscoverListing[];
};

export type DiscoverListingsPageResponse = DiscoverSearchResponse;

export type DiscoverListingDetailPayload = {
  listing: DiscoverListing | null;
  _stats?: {
    images: {
      imageCount: number;
      previewImageCount: number;
    };
  };
};

export type DiscoverFacetsPayload = {
  totalCount: number;
  facets: DiscoverFacetGroups;
};

export type DiscoverFacetsResponse = DiscoverFacetsPayload & {
  _meta: {
    generatedAt: string;
    serverDurationMs: number;
    request: DiscoverFacetsRequest;
  };
};
