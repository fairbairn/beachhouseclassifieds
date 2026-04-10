import type { DiscoverListing } from "@/components/discover/discover-data";
import {
  resolvePlannedCommunity,
  type CommunityCandidateScore,
  type CommunityResolutionResult,
} from "@/lib/discover/community-resolution";

export type DiscoverCommunityNormalizationDecision = {
  id: string;
  name: string;
  originalCommunity: string;
  normalizedCommunity: string;
  changed: boolean;
  reason:
    | "polygon-inside-unique"
    | "polygon-inside-multiple"
    | "no-polygon-match"
    | "missing-coordinates";
  insideCommunities: string[];
  testedCommunities: Array<{
    community: string;
    polygonInside: boolean;
    score: number;
    distanceKm: number | null;
    reasons: string[];
  }>;
  resolution: CommunityResolutionResult;
};

function getInsideCommunities(candidates: CommunityCandidateScore[]): string[] {
  return candidates
    .filter((candidate) => candidate.reasons.includes("polygon:inside"))
    .map((candidate) => candidate.community);
}

export function normalizeDiscoverListingCommunity(listing: DiscoverListing): {
  listing: DiscoverListing;
  decision: DiscoverCommunityNormalizationDecision;
} {
  const hasCoordinates =
    typeof listing.lat === "number" &&
    Number.isFinite(listing.lat) &&
    typeof listing.lng === "number" &&
    Number.isFinite(listing.lng);

  const resolution = resolvePlannedCommunity({
    id: listing.id,
    name: listing.name,
    area: listing.area,
    community: listing.community,
    lat: hasCoordinates ? listing.lat : undefined,
    lng: hasCoordinates ? listing.lng : undefined,
  });

  const insideCommunities = getInsideCommunities(resolution.allCandidates);
  const testedCommunities = resolution.allCandidates.map((candidate) => ({
    community: candidate.community,
    polygonInside: candidate.reasons.includes("polygon:inside"),
    score: candidate.score,
    distanceKm: candidate.distanceKm,
    reasons: candidate.reasons,
  }));

  let normalizedCommunity = listing.community;
  let reason: DiscoverCommunityNormalizationDecision["reason"];

  if (!hasCoordinates) {
    normalizedCommunity = listing.area;
    reason = "missing-coordinates";
  } else if (insideCommunities.length === 1) {
    normalizedCommunity = insideCommunities[0];
    reason = "polygon-inside-unique";
  } else if (insideCommunities.length > 1) {
    if (insideCommunities.includes(listing.community)) {
      normalizedCommunity = listing.community;
    } else {
      normalizedCommunity = listing.area;
    }
    reason = "polygon-inside-multiple";
  } else {
    normalizedCommunity = listing.area;
    reason = "no-polygon-match";
  }

  const changed = normalizedCommunity !== listing.community;

  const normalizedListing = changed
    ? {
        ...listing,
        community: normalizedCommunity,
      }
    : listing;

  return {
    listing: normalizedListing,
    decision: {
      id: listing.id,
      name: listing.name,
      originalCommunity: listing.community,
      normalizedCommunity,
      changed,
      reason,
      insideCommunities,
      testedCommunities,
      resolution,
    },
  };
}

export function normalizeDiscoverListings(
  listings: DiscoverListing[],
): DiscoverListing[] {
  return listings.map(
    (listing) => normalizeDiscoverListingCommunity(listing).listing,
  );
}

export function normalizeDiscoverListingsWithDiagnostics(
  listings: DiscoverListing[],
): {
  listings: DiscoverListing[];
  decisions: DiscoverCommunityNormalizationDecision[];
} {
  const decisions: DiscoverCommunityNormalizationDecision[] = [];
  const normalizedListings = listings.map((listing) => {
    const normalized = normalizeDiscoverListingCommunity(listing);
    decisions.push(normalized.decision);
    return normalized.listing;
  });

  return {
    listings: normalizedListings,
    decisions,
  };
}
