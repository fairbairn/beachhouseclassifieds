import {
  getDiscoverListings as getDiscoverListingsFromPostgres,
  type DiscoverCorpusMetadata,
} from "@/lib/discover/discover-listings-data-layer.server";
import {
  getDiscoverCorpusMetadata as getDiscoverCorpusMetadataFromMeilisearch,
  getDiscoverListingsCount as getDiscoverListingsCountFromMeilisearch,
  getDiscoverListings as getDiscoverListingsFromMeilisearch,
  getDiscoverListingsSnapshot as getDiscoverListingsSnapshotFromMeilisearch,
} from "@/lib/discover/discover-listings-meilisearch.server";
import type { DiscoverMapListing } from "@/lib/discover/discover-types";
import { isMeilisearchBackendEnabled } from "@/lib/discover/meilisearch-client.server";

function shouldUseMeilisearchBackend(): boolean {
  return isMeilisearchBackendEnabled();
}

export function getDiscoverSearchSource(): "meilisearch" | "postgres" {
  return shouldUseMeilisearchBackend() ? "meilisearch" : "postgres";
}

export async function getDiscoverListings(input?: {
  sortOption?:
    | "recommended"
    | "price-low"
    | "price-high"
    | "sleeps-high"
    | "beach-pool-first";
  includeSlug?: string;
  onlySlug?: boolean;
  disableFallback?: boolean;
  maxListings?: number | null;
  offset?: number;
  afterCursor?: {
    demoOrder: number;
    id: string;
  };
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
}) {
  if (input?.includeSlug?.trim() || input?.onlySlug) {
    return getDiscoverListingsFromPostgres(input);
  }

  if (!shouldUseMeilisearchBackend()) {
    throw new Error(
      "Discover listings search requires DISCOVER_SEARCH_BACKEND=meilisearch. Postgres fallback is disabled for listings queries.",
    );
  }

  return getDiscoverListingsFromMeilisearch(input);
}

export async function getDiscoverListingsCount(input?: {
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
}) {
  if (!shouldUseMeilisearchBackend()) {
    throw new Error(
      "Discover listings count requires DISCOVER_SEARCH_BACKEND=meilisearch. Postgres fallback is disabled for listings queries.",
    );
  }

  return getDiscoverListingsCountFromMeilisearch(input);
}

export async function getDiscoverCorpusMetadata(input?: {
  locationQuery?: string;
  minSleeps?: number;
  minBedrooms?: number;
  minBathrooms?: number;
  selectedFeatures?: string[];
  minKingBeds?: number;
  minQueenBeds?: number;
  minBunkBeds?: number;
}): Promise<DiscoverCorpusMetadata | null> {
  if (!shouldUseMeilisearchBackend()) {
    throw new Error(
      "Discover facets metadata requires DISCOVER_SEARCH_BACKEND=meilisearch. Postgres fallback is disabled for listings queries.",
    );
  }

  return getDiscoverCorpusMetadataFromMeilisearch(input);
}

export async function getDiscoverListingsSnapshot(input?: {
  sortOption?:
    | "recommended"
    | "price-low"
    | "price-high"
    | "sleeps-high"
    | "beach-pool-first";
  pageLimit?: number;
  mapLimit?: number;
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
}): Promise<{
  totalCount: number;
  facets: DiscoverCorpusMetadata["facets"];
  pageListings: Awaited<ReturnType<typeof getDiscoverListings>>;
  mapListings: DiscoverMapListing[];
}> {
  if (!shouldUseMeilisearchBackend()) {
    throw new Error(
      "Discover listings snapshot requires DISCOVER_SEARCH_BACKEND=meilisearch. Postgres fallback is disabled for listings queries.",
    );
  }

  return getDiscoverListingsSnapshotFromMeilisearch(input);
}

export type { DiscoverCorpusMetadata };
