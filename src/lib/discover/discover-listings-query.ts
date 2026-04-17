import type { DiscoverListing } from "@/components/discover/discover-data";

export type DiscoverListingsMetadata = {
  totalCount: number;
  mapListings: Array<{
    id: string;
    name: string;
    lat: number;
    lng: number;
    typicalAllInNightly: number;
  }>;
  facets: {
    areas: Record<string, number>;
    beaches: Record<string, number>;
    communities: Record<string, number>;
    features: {
      gulfFront: number;
      privatePool: number;
      golfCart: number;
    };
  };
};

export const DISCOVER_LISTINGS_PAGE_SIZE = 24;
const DISCOVER_LISTINGS_PAGE_CACHE_TTL_MS = 30_000;

type DiscoverListingsPageCacheEntry = {
  payload: DiscoverListingsPageResponse;
  expiresAt: number;
};

const discoverListingsPageCache = new Map<
  string,
  DiscoverListingsPageCacheEntry
>();
const discoverListingsPageInFlight = new Map<
  string,
  Promise<DiscoverListingsPageResponse>
>();

export type DiscoverListingsPageResponse = {
  _stats: {
    nextCursor: string | null;
    hasMore: boolean;
    totalCount: number;
    metadata: DiscoverListingsMetadata;
  };
  listings: DiscoverListing[];
};

function emptyMetadata(): DiscoverListingsMetadata {
  return {
    totalCount: 0,
    mapListings: [],
    facets: {
      areas: {},
      beaches: {},
      communities: {},
      features: {
        gulfFront: 0,
        privatePool: 0,
        golfCart: 0,
      },
    },
  };
}

function normalizeMetadata(
  metadata: unknown,
  fallbackTotalCount: number,
): DiscoverListingsMetadata {
  if (!metadata || typeof metadata !== "object") {
    return {
      ...emptyMetadata(),
      totalCount: fallbackTotalCount,
    };
  }

  const candidate = metadata as Partial<DiscoverListingsMetadata>;

  return {
    totalCount: Number.isFinite(candidate.totalCount)
      ? (candidate.totalCount as number)
      : fallbackTotalCount,
    mapListings: Array.isArray(candidate.mapListings)
      ? candidate.mapListings
      : [],
    facets:
      candidate.facets && typeof candidate.facets === "object"
        ? {
            areas:
              candidate.facets.areas &&
              typeof candidate.facets.areas === "object"
                ? candidate.facets.areas
                : {},
            beaches:
              candidate.facets.beaches &&
              typeof candidate.facets.beaches === "object"
                ? candidate.facets.beaches
                : {},
            communities:
              candidate.facets.communities &&
              typeof candidate.facets.communities === "object"
                ? candidate.facets.communities
                : {},
            features:
              candidate.facets.features &&
              typeof candidate.facets.features === "object"
                ? {
                    gulfFront: Number.isFinite(
                      candidate.facets.features.gulfFront,
                    )
                      ? candidate.facets.features.gulfFront
                      : 0,
                    privatePool: Number.isFinite(
                      candidate.facets.features.privatePool,
                    )
                      ? candidate.facets.features.privatePool
                      : 0,
                    golfCart: Number.isFinite(
                      candidate.facets.features.golfCart,
                    )
                      ? candidate.facets.features.golfCart
                      : 0,
                  }
                : {
                    gulfFront: 0,
                    privatePool: 0,
                    golfCart: 0,
                  },
          }
        : emptyMetadata().facets,
  };
}

function resolveDiscoverListingsEndpoint(params: URLSearchParams): string {
  const path = `/api/discover/listings?${params.toString()}`;
  if (typeof window !== "undefined") {
    return path;
  }

  const baseUrl = (
    (import.meta.env.VITE_SITE_URL as string | undefined) ??
    "http://localhost:3000"
  ).replace(/\/$/, "");

  return `${baseUrl}${path}`;
}

function getPageQueryCacheKey(input?: { cursor?: string; limit?: number }) {
  const limit = Number.isFinite(input?.limit)
    ? String(input?.limit)
    : String(DISCOVER_LISTINGS_PAGE_SIZE);
  const cursor = input?.cursor?.trim() ?? "";
  return `limit=${limit}|cursor=${cursor}`;
}

export async function fetchDiscoverListingsPage(input?: {
  cursor?: string;
  limit?: number;
}): Promise<DiscoverListingsPageResponse> {
  const cacheKey = getPageQueryCacheKey(input);
  if (typeof window !== "undefined") {
    const cached = discoverListingsPageCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.payload;
    }

    const inFlight = discoverListingsPageInFlight.get(cacheKey);
    if (inFlight) {
      return inFlight;
    }
  }

  const params = new URLSearchParams();
  params.set("limit", String(input?.limit ?? DISCOVER_LISTINGS_PAGE_SIZE));
  if (input?.cursor) {
    params.set("cursor", input.cursor);
  }
  const requestPromise = (async (): Promise<DiscoverListingsPageResponse> => {
    const response = await fetch(resolveDiscoverListingsEndpoint(params));
    if (!response.ok) {
      return {
        _stats: {
          nextCursor: null,
          hasMore: false,
          totalCount: 0,
          metadata: emptyMetadata(),
        },
        listings: [],
      };
    }

    const payload = (await response
      .json()
      .catch(() => null)) as DiscoverListingsPageResponse | null;

    if (!payload || !Array.isArray(payload.listings)) {
      return {
        _stats: {
          nextCursor: null,
          hasMore: false,
          totalCount: 0,
          metadata: emptyMetadata(),
        },
        listings: [],
      };
    }

    const stats =
      payload._stats && typeof payload._stats === "object"
        ? payload._stats
        : {
            nextCursor:
              (payload as { nextCursor?: string | null }).nextCursor ?? null,
            hasMore: Boolean((payload as { hasMore?: boolean }).hasMore),
            totalCount: Number.isFinite(
              (payload as { totalCount?: number }).totalCount,
            )
              ? ((payload as { totalCount?: number }).totalCount as number)
              : payload.listings.length,
            metadata: normalizeMetadata(
              (payload as { metadata?: unknown }).metadata,
              payload.listings.length,
            ),
          };

    const normalizedPayload: DiscoverListingsPageResponse = {
      _stats: {
        nextCursor: stats.nextCursor ?? null,
        hasMore: Boolean(stats.hasMore),
        totalCount: Number.isFinite(stats.totalCount)
          ? stats.totalCount
          : payload.listings.length,
        metadata: normalizeMetadata(
          stats.metadata,
          Number.isFinite(stats.totalCount)
            ? stats.totalCount
            : payload.listings.length,
        ),
      },
      listings: payload.listings,
    };

    if (typeof window !== "undefined") {
      discoverListingsPageCache.set(cacheKey, {
        payload: normalizedPayload,
        expiresAt: Date.now() + DISCOVER_LISTINGS_PAGE_CACHE_TTL_MS,
      });
    }

    return normalizedPayload;
  })();

  if (typeof window !== "undefined") {
    discoverListingsPageInFlight.set(cacheKey, requestPromise);
  }

  try {
    return await requestPromise;
  } finally {
    if (typeof window !== "undefined") {
      discoverListingsPageInFlight.delete(cacheKey);
    }
  }
}
