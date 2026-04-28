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
  petFriendly?: boolean;
  accessible?: boolean;
  elevator?: boolean;
  previewImages: string[];
  imageCount?: number;
  typicalPrice?: string;
  typicalPricingMonth: string;
  typicalBaseNightly: number;
  typicalAllInNightly: number;
  typicalPricingStatus?:
    | "grounded"
    | "estimated"
    | "no_truth"
    | "not_available";
  upcomingTypicalPricingMonths?: Array<{
    monthLabel: string;
    monthStartDate: string;
    typicalAllInNightly: number;
    pricingStatus?: "grounded" | "estimated" | "no_truth" | "not_available";
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
  images?: Array<{
    name: string;
    url: string;
  }>;
  seoMetaTitle?: string;
  seoMetaDescription?: string;
  seoHiddenSummaryPlain?: string;
  statusCodeString?: string;
  availabilityWindowStartDate?: string;
  availabilityDaysCount?: number;
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

export type DiscoverSearchSource = "meilisearch" | "postgres";

export type DiscoverListingsMetadata = DiscoverSearchMetadata;

export type DiscoverPageStats = {
  totalCount: number;
  count: number;
  requested: number;
};

export type DiscoverSearchRequest = {
  includeSlug?: string;
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
};

export type DiscoverSearchResponseMeta = {
  generatedAt: string;
  serverDurationMs: number;
  request: DiscoverSearchRequest;
};

export type DiscoverFacetsRequest = {
  sortOption?: string;
  locationQuery?: string;
  minSleeps?: number;
  minBedrooms?: number;
  minBathrooms?: number;
  selectedFeatures?: string[];
  filterPool?: boolean;
  filterGulffront?: boolean;
  filterGolfCart?: boolean;
  probeReason?: string;
};

export type DiscoverListingsStats = DiscoverPageStats;

export type DiscoverSearchResponse = {
  source?: DiscoverSearchSource;
  _meta?: DiscoverSearchResponseMeta;
  _stats: DiscoverListingsStats;
  metadata?: DiscoverListingsMetadata;
  listings: DiscoverListing[];
};

export type DiscoverListingsPagePayload = {
  source?: DiscoverSearchSource;
  _meta?: DiscoverSearchResponseMeta;
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

export type DiscoverQuoteRequest = {
  slug: string;
  in: string;
  out: string;
  adults?: number;
  kids?: number;
};

export type DiscoverQuoteSuccess = {
  ok: true;
  subtotal: number;
  taxes: number;
  total: number;
  detail: string | null;
  handoff: string | null;
  canCheckoutDirect?: boolean;
  cached?: boolean;
};

export type DiscoverQuoteFailure = {
  ok: false;
  code: string;
  msg: string;
};

export type DiscoverQuoteResponse = DiscoverQuoteSuccess | DiscoverQuoteFailure;

export type DiscoverFacetsPayload = {
  totalCount: number;
  facets: DiscoverFacetGroups;
};

export type DiscoverFacetsResponse = DiscoverFacetsPayload & {
  source?: DiscoverSearchSource;
  _meta: {
    generatedAt: string;
    serverDurationMs: number;
    request: DiscoverFacetsRequest;
  };
};
