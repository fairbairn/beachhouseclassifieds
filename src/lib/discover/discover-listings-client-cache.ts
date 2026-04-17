import type { DiscoverListing } from "@/components/discover/discover-data";

type CacheEntry = {
  listings: DiscoverListing[];
  expiresAt: number;
};

type DetailCacheEntry = {
  listing: DiscoverListing;
  expiresAt: number;
};

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const ALL_LISTINGS_KEY = "__all__";
const listingsCache = new Map<string, CacheEntry>();
const listingDetailCache = new Map<string, DetailCacheEntry>();
const inFlightRequests = new Map<string, Promise<DiscoverListing[]>>();
const inFlightDetailRequests = new Map<
  string,
  Promise<DiscoverListing | null>
>();

function getCacheKey(includeSlug?: string) {
  return includeSlug?.trim() || ALL_LISTINGS_KEY;
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
    return null;
  }

  const payload = (await response.json().catch(() => null)) as {
    listing?: unknown;
  } | null;

  return payload?.listing && typeof payload.listing === "object"
    ? (payload.listing as DiscoverListing)
    : null;
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
  listingDetailCache.set(slug, {
    listing: input.listing,
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
  const slug = input.slug.trim();
  if (!slug) {
    return null;
  }

  const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;

  if (!isBrowserRuntime()) {
    return fetchDiscoverListingDetailFromApi(slug);
  }

  const cached = listingDetailCache.get(slug);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.listing;
  }

  const existingRequest = inFlightDetailRequests.get(slug);
  if (existingRequest) {
    return existingRequest;
  }

  const request = fetchDiscoverListingDetailFromApi(slug)
    .then((listing) => {
      if (listing) {
        listingDetailCache.set(slug, {
          listing,
          expiresAt: Date.now() + ttlMs,
        });
      }
      inFlightDetailRequests.delete(slug);
      return listing;
    })
    .catch(() => {
      inFlightDetailRequests.delete(slug);
      return null;
    });

  inFlightDetailRequests.set(slug, request);
  return request;
}
