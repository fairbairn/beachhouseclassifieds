import {
  getDiscoverCorpusMetadata as getDiscoverCorpusMetadataFromPostgres,
  getDiscoverListings as getDiscoverListingsFromPostgres,
  getDiscoverListingsCount as getDiscoverListingsCountFromPostgres,
  type DiscoverCorpusMetadata,
} from "@/lib/discover/discover-listings-data-layer.server";
import {
  getDiscoverCorpusMetadata as getDiscoverCorpusMetadataFromMeilisearch,
  getDiscoverListings as getDiscoverListingsFromMeilisearch,
  getDiscoverListingsCount as getDiscoverListingsCountFromMeilisearch,
} from "@/lib/discover/discover-listings-meilisearch.server";
import { isMeilisearchBackendEnabled } from "@/lib/discover/meilisearch-client.server";

function shouldUseMeilisearchBackend(): boolean {
  return isMeilisearchBackendEnabled();
}

export async function getDiscoverListings(input?: {
  includeSlug?: string;
  onlySlug?: boolean;
  disableFallback?: boolean;
  maxListings?: number | null;
  offset?: number;
  afterCursor?: {
    demoOrder: number;
    id: string;
  };
  selectedAreas?: string[];
  selectedBeaches?: string[];
  selectedCommunities?: string[];
  selectedFeatures?: string[];
}) {
  if (shouldUseMeilisearchBackend()) {
    return getDiscoverListingsFromMeilisearch(input).catch(() =>
      getDiscoverListingsFromPostgres(input),
    );
  }

  return getDiscoverListingsFromPostgres(input);
}

export async function getDiscoverListingsCount(input?: {
  selectedAreas?: string[];
  selectedBeaches?: string[];
  selectedCommunities?: string[];
  selectedFeatures?: string[];
}) {
  if (shouldUseMeilisearchBackend()) {
    return getDiscoverListingsCountFromMeilisearch(input).catch(() =>
      getDiscoverListingsCountFromPostgres(input),
    );
  }

  return getDiscoverListingsCountFromPostgres(input);
}

export async function getDiscoverCorpusMetadata(input?: {
  selectedFeatures?: string[];
}): Promise<DiscoverCorpusMetadata | null> {
  if (shouldUseMeilisearchBackend()) {
    return getDiscoverCorpusMetadataFromMeilisearch(input).catch(() =>
      getDiscoverCorpusMetadataFromPostgres(input),
    );
  }

  return getDiscoverCorpusMetadataFromPostgres(input);
}

export type { DiscoverCorpusMetadata };
