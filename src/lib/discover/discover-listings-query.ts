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
      features: {},
    },
  };
}

function normalizeFacetBucket(
  value: unknown,
): DiscoverListingsMetadata["facets"]["areas"] {
  const out: DiscoverListingsMetadata["facets"]["areas"] = {};

  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!entry || typeof entry !== "object") {
        continue;
      }

      const candidate = entry as {
        code?: unknown;
        label?: unknown;
        count?: unknown;
      };
      const code =
        typeof candidate.code === "string" ? candidate.code.trim() : "";
      const label =
        typeof candidate.label === "string"
          ? candidate.label.trim()
          : undefined;
      const countValue =
        typeof candidate.count === "number"
          ? candidate.count
          : typeof candidate.count === "string"
            ? Number(candidate.count)
            : Number.NaN;

      if (!code || !Number.isFinite(countValue)) {
        continue;
      }

      out[code] = {
        ...(label ? { label } : {}),
        count: Math.max(0, Math.round(countValue)),
      };
    }
    return out;
  }

  if (value && typeof value === "object") {
    for (const [rawCode, rawValue] of Object.entries(
      value as Record<string, unknown>,
    )) {
      const code = rawCode.trim();
      if (!code) {
        continue;
      }

      if (rawValue && typeof rawValue === "object") {
        const entry = rawValue as { label?: unknown; count?: unknown };
        const label =
          typeof entry.label === "string" ? entry.label.trim() : undefined;
        const countValue =
          typeof entry.count === "number"
            ? entry.count
            : typeof entry.count === "string"
              ? Number(entry.count)
              : Number.NaN;
        if (!Number.isFinite(countValue)) {
          continue;
        }

        out[code] = {
          ...(label ? { label } : {}),
          count: Math.max(0, Math.round(countValue)),
        };
        continue;
      }

      const countValue =
        typeof rawValue === "number"
          ? rawValue
          : typeof rawValue === "string"
            ? Number(rawValue)
            : Number.NaN;
      if (!Number.isFinite(countValue)) {
        continue;
      }

      out[code] = {
        count: Math.max(0, Math.round(countValue)),
      };
    }

    return out;
  }

  return out;
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
            areas: normalizeFacetBucket(candidate.facets.areas),
            beaches: normalizeFacetBucket(candidate.facets.beaches),
            communities: normalizeFacetBucket(candidate.facets.communities),
            features: normalizeFacetBucket(candidate.facets.features),
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
  selectedAreas?: string[];
  selectedBeaches?: string[];
  selectedCommunities?: string[];
  selectedFeatures?: string[];
  minKingBeds?: number;
  minQueenBeds?: number;
  minBunkBeds?: number;
}) {
  const limit = Number.isFinite(input?.limit)
    ? String(input?.limit)
    : String(DISCOVER_LISTINGS_PAGE_SIZE);
  const offset = Number.isFinite(input?.offset) ? String(input?.offset) : "0";
  const includeMetadata = input?.includeMetadata === false ? "0" : "1";
  const selectedAreas = (input?.selectedAreas ?? []).slice().sort().join(",");
  const selectedBeaches = (input?.selectedBeaches ?? [])
    .slice()
    .sort()
    .join(",");
  const selectedCommunities = (input?.selectedCommunities ?? [])
    .slice()
    .sort()
    .join(",");
  const selectedFeatures = (input?.selectedFeatures ?? [])
    .slice()
    .sort()
    .join(",");
  const minKingBeds = Number.isFinite(input?.minKingBeds)
    ? String(input?.minKingBeds)
    : "0";
  const minQueenBeds = Number.isFinite(input?.minQueenBeds)
    ? String(input?.minQueenBeds)
    : "0";
  const minBunkBeds = Number.isFinite(input?.minBunkBeds)
    ? String(input?.minBunkBeds)
    : "0";

  return `limit=${limit}|offset=${offset}|metadata=${includeMetadata}|areas=${selectedAreas}|beaches=${selectedBeaches}|communities=${selectedCommunities}|features=${selectedFeatures}|king=${minKingBeds}|queen=${minQueenBeds}|bunk=${minBunkBeds}`;
}

export async function fetchDiscoverListingsPage(input?: {
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
    selectedAreas: input?.selectedAreas,
    selectedBeaches: input?.selectedBeaches,
    selectedCommunities: input?.selectedCommunities,
    selectedFeatures: input?.selectedFeatures,
    minKingBeds: input?.minKingBeds,
    minQueenBeds: input?.minQueenBeds,
    minBunkBeds: input?.minBunkBeds,
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
      source:
        payload.source === "meilisearch" || payload.source === "postgres"
          ? payload.source
          : undefined,
      _meta:
        payload._meta && typeof payload._meta === "object"
          ? payload._meta
          : undefined,
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
