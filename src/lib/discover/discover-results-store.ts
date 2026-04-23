import { Store } from "@tanstack/store";

import type {
  DiscoverListing,
  DiscoverListingsMetadata,
  DiscoverListingsPageResponse,
} from "@/lib/discover/discover-types";

export type DiscoverResultsState = {
  listings: DiscoverListing[];
  metadata: DiscoverListingsMetadata | undefined;
  totalCount: number;
};

export function mergeDiscoverListings(input: {
  current: DiscoverListing[];
  next: DiscoverListing[];
  mode: "append" | "replace";
}): DiscoverListing[] {
  if (input.mode === "replace") {
    return input.next;
  }

  if (input.current.length === 0) {
    return input.next;
  }

  if (input.next.length === 0) {
    return input.current;
  }

  const seenIds = new Set(input.current.map((listing) => listing.id));
  const merged = [...input.current];

  for (const listing of input.next) {
    if (seenIds.has(listing.id)) {
      continue;
    }
    seenIds.add(listing.id);
    merged.push(listing);
  }

  return merged;
}

export function resolveDiscoverTotalCount(input: {
  payload?: DiscoverListingsPageResponse;
  fallbackListingsLength: number;
}): number {
  const totalFromStats = input.payload?._stats?.totalCount;
  if (typeof totalFromStats === "number" && Number.isFinite(totalFromStats)) {
    return Math.max(0, Math.round(totalFromStats));
  }

  return Math.max(0, input.fallbackListingsLength);
}

export function createDiscoverResultsStore(input: {
  initialListings: DiscoverListing[];
  initialMetadata?: DiscoverListingsMetadata;
  initialTotalCount: number;
}) {
  return new Store<DiscoverResultsState>({
    listings: input.initialListings,
    metadata: input.initialMetadata,
    totalCount: Math.max(0, Math.round(input.initialTotalCount)),
  });
}
