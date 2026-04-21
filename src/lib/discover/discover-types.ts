export type DiscoverListing = {
  id: string;
  name: string;
  demoOrder: number;
  area: string;
  community: string;
  lat?: number;
  lng?: number;
  bedrooms: number;
  bathrooms: number;
  sleeps: number;
  kingBeds: number;
  queenBeds: number;
  privatePool: boolean;
  beachfront: boolean;
  gulfView?: boolean;
  golfCart: boolean;
  petsAllowed: boolean;
  accessible: boolean;
  elevator: boolean;
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

export type DiscoverFeatureFacets = {
  gulfFront: number;
  privatePool: number;
  golfCart: number;
};

export type DiscoverFacetGroups = {
  areas: Record<string, number>;
  beaches: Record<string, number>;
  communities: Record<string, number>;
  features: DiscoverFeatureFacets;
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

export type DiscoverPageStats<TMetadata = DiscoverSearchMetadata> = {
  nextCursor: string | null;
  hasMore: boolean;
  totalCount: number;
  metadata: TMetadata;
};

export type DiscoverPageStatsWithOptionalMetadata<
  TMetadata = DiscoverSearchMetadata,
> = Omit<DiscoverPageStats<TMetadata>, "metadata"> & {
  metadata?: TMetadata;
};

export type DiscoverSearchRequest = {
  includeSlug?: string;
  cursor?: string;
  limit?: number;
};

export type DiscoverSearchResponse = {
  _stats: DiscoverPageStats;
  listings: DiscoverListing[];
};

export type DiscoverListingsPagePayload = {
  _stats: DiscoverPageStatsWithOptionalMetadata;
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
