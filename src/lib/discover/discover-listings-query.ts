import type {
  DiscoverListingsMetadata,
  DiscoverListingsPageResponse,
} from "@/lib/discover/discover-types";

export type { DiscoverListingsPageResponse } from "@/lib/discover/discover-types";

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

function resolveDiscoverListingsEndpoint(): string {
  const path = "/api/discover/listings";
  if (typeof window !== "undefined") {
    return path;
  }

  const baseUrl = (
    (import.meta.env.VITE_SITE_URL as string | undefined) ??
    "http://localhost:3000"
  ).replace(/\/$/, "");

  return `${baseUrl}${path}`;
}

function getPageQueryCacheKey(input?: {
  limit?: number;
  offset?: number;
  includeMetadata?: boolean;
}) {
  const limit = Number.isFinite(input?.limit)
    ? String(input?.limit)
    : String(DISCOVER_LISTINGS_PAGE_SIZE);
  const offset = Number.isFinite(input?.offset) ? String(input?.offset) : "0";
  const includeMetadata = input?.includeMetadata === false ? "0" : "1";
  return `limit=${limit}|offset=${offset}|metadata=${includeMetadata}`;
}

export async function fetchDiscoverListingsPage(input?: {
  limit?: number;
  offset?: number;
  includeMetadata?: boolean;
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

  const requestBody = {
    limit: input?.limit ?? DISCOVER_LISTINGS_PAGE_SIZE,
    offset: input?.offset,
    includeMetadata: input?.includeMetadata,
  };
  const requestPromise = (async (): Promise<DiscoverListingsPageResponse> => {
    const response = await fetch(resolveDiscoverListingsEndpoint(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });
    if (!response.ok) {
      return {
        _stats: {
          totalCount: 0,
          count: 0,
          requested: input?.limit ?? DISCOVER_LISTINGS_PAGE_SIZE,
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
          totalCount: 0,
          count: 0,
          requested: input?.limit ?? DISCOVER_LISTINGS_PAGE_SIZE,
        },
        listings: [],
      };
    }

    const stats = payload._stats;
    const totalCount = Number.isFinite(stats?.totalCount)
      ? stats.totalCount
      : payload.listings.length;
    const count = Number.isFinite(stats?.count)
      ? stats.count
      : payload.listings.length;
    const requested = Number.isFinite(stats?.requested)
      ? stats.requested
      : (input?.limit ?? DISCOVER_LISTINGS_PAGE_SIZE);
    const metadataRaw = (payload as { metadata?: unknown }).metadata;
    const includeMetadataInResponse =
      metadataRaw !== undefined && metadataRaw !== null;
    const metadata = includeMetadataInResponse
      ? normalizeMetadata(metadataRaw, totalCount)
      : undefined;

    const normalizedPayload: DiscoverListingsPageResponse = {
      _stats: {
        totalCount,
        count,
        requested,
      },
      ...(metadata ? { metadata } : {}),
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
