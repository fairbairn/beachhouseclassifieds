import type {
  DiscoverListing,
  DiscoverListingDetailPayload,
} from "@/lib/discover/discover-types";

type CacheEntry = {
  listings: DiscoverListing[];
  expiresAt: number;
};

type DetailCacheEntry = {
  payload: DiscoverListingDetailPayload;
  expiresAt: number;
};

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DETAIL_CACHE_SCHEMA_VERSION = 2;
const ALL_LISTINGS_KEY = "__all__";
const listingsCache = new Map<string, CacheEntry>();
const listingDetailCache = new Map<string, DetailCacheEntry>();
const inFlightRequests = new Map<string, Promise<DiscoverListing[]>>();
const inFlightDetailRequests = new Map<
  string,
  Promise<DiscoverListingDetailPayload>
>();

function buildDetailImageStats(listing: DiscoverListing) {
  const imageCount = Math.max(
    0,
    Math.round(listing.imageCount ?? listing.imageGallery?.length ?? 0),
  );
  const previewImageCount = Math.max(
    0,
    Math.round(listing.previewImages.length),
  );

  return {
    imageCount,
    previewImageCount,
  };
}

function getCacheKey(includeSlug?: string) {
  return includeSlug?.trim() || ALL_LISTINGS_KEY;
}

function getDetailCacheKey(slug: string) {
  return `${slug.trim()}::v${DETAIL_CACHE_SCHEMA_VERSION}`;
}

function isBrowserRuntime() {
  return typeof window !== "undefined";
}

async function fetchDiscoverListingsFromApi(includeSlug?: string) {
  const path = includeSlug
    ? `/api/discover/listings?include=${encodeURIComponent(includeSlug)}`
    : "/api/discover/listings";

  const endpoint = isBrowserRuntime()
    ? path
    : `${(
        (import.meta.env.VITE_SITE_URL as string | undefined) ??
        "http://localhost:3000"
      ).replace(/\/$/, "")}${path}`;

  const response = await fetch(endpoint);
  if (!response.ok) {
    return [] as DiscoverListing[];
  }

  const payload = (await response.json().catch(() => null)) as {
    listings?: unknown;
  } | null;

  return Array.isArray(payload?.listings)
    ? (payload.listings as DiscoverListing[])
    : ([] as DiscoverListing[]);
}

async function fetchDiscoverListingDetailFromApi(slug: string) {
  const path = `/api/discover/listings/${encodeURIComponent(slug)}`;

  const endpoint = isBrowserRuntime()
    ? path
    : `${(
        (import.meta.env.VITE_SITE_URL as string | undefined) ??
        "http://localhost:3000"
      ).replace(/\/$/, "")}${path}`;

  const response = await fetch(endpoint);
  if (!response.ok) {
    return { listing: null } as DiscoverListingDetailPayload;
  }

  const payload = (await response.json().catch(() => null)) as {
    listing?: unknown;
    _stats?: {
      images?: {
        imageCount?: unknown;
        previewImageCount?: unknown;
      };
    };
  } | null;

  if (!payload?.listing || typeof payload.listing !== "object") {
    return {
      listing: null,
    } as DiscoverListingDetailPayload;
  }

  const listing = payload.listing as DiscoverListing;
  const fallbackStats = buildDetailImageStats(listing);
  const rawImageCount = payload._stats?.images?.imageCount;
  const rawPreviewImageCount = payload._stats?.images?.previewImageCount;

  const imageCount =
    typeof rawImageCount === "number" && Number.isFinite(rawImageCount)
      ? Math.max(0, Math.round(rawImageCount))
      : fallbackStats.imageCount;
  const previewImageCount =
    typeof rawPreviewImageCount === "number" &&
    Number.isFinite(rawPreviewImageCount)
      ? Math.max(0, Math.round(rawPreviewImageCount))
      : fallbackStats.previewImageCount;

  return {
    listing,
    _stats: {
      images: {
        imageCount,
        previewImageCount,
      },
    },
  } as DiscoverListingDetailPayload;
}

export function primeDiscoverListingsCache(input: {
  includeSlug?: string;
  listings: DiscoverListing[];
  ttlMs?: number;
}) {
  if (!isBrowserRuntime()) {
    return;
  }

  if (input.listings.length === 0) {
    return;
  }

  const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;
  const key = getCacheKey(input.includeSlug);
  listingsCache.set(key, {
    listings: input.listings,
    expiresAt: Date.now() + ttlMs,
  });
}

export function primeDiscoverListingDetailCache(input: {
  slug: string;
  listing: DiscoverListing;
  _stats?: DiscoverListingDetailPayload["_stats"];
  ttlMs?: number;
}) {
  if (!isBrowserRuntime()) {
    return;
  }

  const slug = input.slug.trim();
  if (!slug) {
    return;
  }

  const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;
  const stats = input._stats ?? {
    images: buildDetailImageStats(input.listing),
  };

  const detailKey = getDetailCacheKey(slug);
  listingDetailCache.set(detailKey, {
    payload: {
      listing: input.listing,
      _stats: stats,
    },
    expiresAt: Date.now() + ttlMs,
  });
}

export async function fetchDiscoverListingsWithCache(input?: {
  includeSlug?: string;
  ttlMs?: number;
}) {
  const includeSlug = input?.includeSlug?.trim() || undefined;
  const ttlMs = input?.ttlMs ?? DEFAULT_TTL_MS;

  if (!isBrowserRuntime()) {
    return fetchDiscoverListingsFromApi(includeSlug);
  }

  const key = getCacheKey(includeSlug);
  const cached = listingsCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.listings;
  }

  const existingRequest = inFlightRequests.get(key);
  if (existingRequest) {
    return existingRequest;
  }

  const request = fetchDiscoverListingsFromApi(includeSlug)
    .then((listings) => {
      if (listings.length > 0) {
        listingsCache.set(key, {
          listings,
          expiresAt: Date.now() + ttlMs,
        });
      }
      inFlightRequests.delete(key);
      return listings;
    })
    .catch(() => {
      inFlightRequests.delete(key);
      return [] as DiscoverListing[];
    });

  inFlightRequests.set(key, request);
  return request;
}

export async function fetchDiscoverListingDetailWithCache(input: {
  slug: string;
  ttlMs?: number;
}) {
  const payload = await fetchDiscoverListingDetailPayloadWithCache(input);
  return payload.listing;
}

export async function fetchDiscoverListingDetailPayloadWithCache(input: {
  slug: string;
  ttlMs?: number;
}) {
  const slug = input.slug.trim();
  if (!slug) {
    return {
      listing: null,
    } as DiscoverListingDetailPayload;
  }

  const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;

  if (!isBrowserRuntime()) {
    return fetchDiscoverListingDetailFromApi(slug);
  }

  const detailKey = getDetailCacheKey(slug);
  const cached = listingDetailCache.get(detailKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.payload;
  }

  const existingRequest = inFlightDetailRequests.get(detailKey);
  if (existingRequest) {
    return existingRequest;
  }

  const request = fetchDiscoverListingDetailFromApi(slug)
    .then((payload) => {
      if (payload.listing) {
        listingDetailCache.set(detailKey, {
          payload,
          expiresAt: Date.now() + ttlMs,
        });
      }
      inFlightDetailRequests.delete(detailKey);
      return payload;
    })
    .catch(() => {
      inFlightDetailRequests.delete(detailKey);
      return {
        listing: null,
      } as DiscoverListingDetailPayload;
    });

  inFlightDetailRequests.set(detailKey, request);
  return request;
}
