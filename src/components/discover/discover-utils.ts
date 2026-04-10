import {
  communityBeachAreaMap,
  geoByArea,
  geoByCommunity,
  geoByRegion,
  known30ACommunities,
  type DiscoverListing,
} from "@/components/discover/discover-data";

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

export function getAreaFromListing(listing: DiscoverListing) {
  const areaName = `${listing.area} ${listing.community}`.toLowerCase();

  const east30AKeywords = ["rosemary", "seacrest", "alys", "inlet"];
  const west30AKeywords = ["blue mountain", "grayton", "santa rosa"];
  const central30AKeywords = [
    "seagrove",
    "seaside",
    "watercolor",
    "watersound",
    "prominence",
  ];

  if (east30AKeywords.some((keyword) => areaName.includes(keyword))) {
    return "East 30A";
  }
  if (west30AKeywords.some((keyword) => areaName.includes(keyword))) {
    return "West 30A";
  }
  if (central30AKeywords.some((keyword) => areaName.includes(keyword))) {
    return "Central 30A";
  }

  return "Central 30A";
}

export function getLocationPresentation(listing: DiscoverListing) {
  const isPlannedCommunity = known30ACommunities.includes(listing.community);
  const listedArea = listing.area.trim();
  const beachArea =
    (communityBeachAreaMap[listing.community] ?? listedArea) || null;
  const region = getAreaFromListing(listing);

  if (isPlannedCommunity) {
    return {
      isPlannedCommunity: true,
      locationChip: listing.community,
      subline: beachArea ? `${beachArea} • ${region}` : region,
    };
  }

  if (beachArea) {
    return {
      isPlannedCommunity: false,
      locationChip: beachArea,
      subline: region,
    };
  }

  return {
    isPlannedCommunity: false,
    locationChip: region,
    subline: region,
  };
}

export function getListingGeoTarget(listing: DiscoverListing) {
  if (
    Number.isFinite(listing.lat) &&
    Number.isFinite(listing.lng) &&
    listing.lat !== undefined &&
    listing.lng !== undefined
  ) {
    return { lat: listing.lat, lng: listing.lng };
  }

  const location = getLocationPresentation(listing);
  const region = getAreaFromListing(listing);

  if (geoByCommunity[listing.community]) {
    return geoByCommunity[listing.community];
  }
  if (geoByArea[location.locationChip]) {
    return geoByArea[location.locationChip];
  }
  if (geoByArea[listing.area]) {
    return geoByArea[listing.area];
  }

  return geoByRegion[region] ?? { lat: 30.3158, lng: -86.1186 };
}
