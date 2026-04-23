import { known30ACommunities } from "@/components/discover/discover-data";
import type { DiscoverListing } from "@/lib/discover/discover-types";

type BroadArea = "West 30A" | "Central 30A" | "East 30A";

export function formatNights(nights: number) {
  return `${nights} ${nights === 1 ? "Night" : "Nights"}`;
}

export function formatBathrooms(value: number) {
  if (Number.isInteger(value)) {
    return String(value);
  }

  return value.toFixed(1).replace(/\.0$/, "");
}

export function getTypicalPriceBounds(priceLabel: string) {
  const values = Array.from(
    priceLabel.matchAll(/\$([\d.]+)k/gi),
    (match) => Number(match[1]) * 1000,
  );

  if (values.length === 0) {
    return { low: 0, high: 0 };
  }

  return {
    low: Math.min(...values),
    high: Math.max(...values),
  };
}

export function getAreaFromListing(listing: DiscoverListing): BroadArea {
  const explicitArea = listing.area.trim();
  if (
    explicitArea === "West 30A" ||
    explicitArea === "Central 30A" ||
    explicitArea === "East 30A"
  ) {
    return explicitArea;
  }

  return "Central 30A";
}

export function getBeachZoneFromListing(
  listing: DiscoverListing,
): string | null {
  const explicitBeach = listing.beach.trim();
  return explicitBeach.length > 0 ? explicitBeach : null;
}

export function getLocationPresentation(listing: DiscoverListing) {
  const communityName = listing.community.trim();
  const beach = listing.beach.trim();
  const area = listing.area.trim();

  const isPlannedCommunity =
    communityName.length > 0 && known30ACommunities.includes(communityName);

  const fallbackArea = area.length > 0 ? area : "Central 30A";
  const subline =
    beach.length > 0 ? `${beach} • ${fallbackArea}` : fallbackArea;

  if (isPlannedCommunity) {
    return {
      isPlannedCommunity: true,
      locationChip: communityName,
      subline,
    };
  }

  return {
    isPlannedCommunity: false,
    locationChip: beach.length > 0 ? beach : fallbackArea,
    subline,
  };
}

export function getListingGeoTarget(listing: DiscoverListing) {
  return {
    lat:
      typeof listing.lat === "number" && Number.isFinite(listing.lat)
        ? listing.lat
        : 30.3158,
    lng:
      typeof listing.lng === "number" && Number.isFinite(listing.lng)
        ? listing.lng
        : -86.1186,
  };
}

export function verifyGulfFrontClaim(
  listing: DiscoverListing,
): DiscoverListing {
  return listing;
}
