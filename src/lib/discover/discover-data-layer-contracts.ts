export type DiscoverFeatureFilter =
  | "gulf_front"
  | "private_pool"
  | "golf_cart"
  | "pet_friendly"
  | "accessible"
  | "elevator";

export type DiscoverSelectionFilters = {
  selectedAreas?: string[];
  selectedBeaches?: string[];
  selectedCommunities?: string[];
  selectedFeatures?: string[];
};

export type DiscoverResolvedFilters = {
  selectedAreaCodes: string[];
  selectedBeachCodes: string[];
  selectedCommunityCodes: string[];
  selectedFeatures: DiscoverFeatureFilter[];
};

export type DiscoverCorpusMetadata = {
  totalCount: number;
  facets: {
    areas: Record<string, { label: string; count: number }>;
    beaches: Record<string, { label: string; count: number }>;
    communities: Record<string, { label: string; count: number }>;
    features: Record<string, { label: string; count: number }>;
  };
};
