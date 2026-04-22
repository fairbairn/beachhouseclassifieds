import {
  communityBeachAreaMap,
  geoByArea,
  geoByCommunity,
  geoByRegion,
  known30ACommunities,
} from "@/components/discover/discover-data";
import { GULF_FRONT_VERIFICATION_POLYGON } from "@/components/discover/gulf-front-polygon";
import type { DiscoverListing } from "@/lib/discover/discover-types";

type BroadArea = "West 30A" | "Central 30A" | "East 30A";

const PRIMARY_BEACH_ZONES = [
  "Dune Allen Beach",
  "Blue Mountain Beach",
  "Grayton Beach",
  "Seagrove Beach",
  "WaterSound Beach",
  "Seacrest Beach",
  "Rosemary Beach",
] as const;

const SECONDARY_BEACH_ZONES = ["Santa Rosa Beach", "Inlet Beach"] as const;

type SpecificBeachZone =
  | (typeof PRIMARY_BEACH_ZONES)[number]
  | (typeof SECONDARY_BEACH_ZONES)[number];

const ALL_SPECIFIC_BEACH_ZONES = [
  ...PRIMARY_BEACH_ZONES,
  ...SECONDARY_BEACH_ZONES,
] as const;

const BEACH_ZONE_POLYGONS: Partial<
  Record<SpecificBeachZone, Array<{ lat: number; lng: number }>>
> = {
  "Inlet Beach": [
    { lat: 30.27412219178902, lng: -86.00992153493961 },
    { lat: 30.27199023807603, lng: -86.0029448452862 },
    { lat: 30.26917569363175, lng: -85.9957844718264 },
    { lat: 30.31132313224923, lng: -85.99470096253722 },
    { lat: 30.317140500281283, lng: -86.00836299444923 },
    { lat: 30.34431608836995, lng: -86.02697580440956 },
    { lat: 30.350920217541812, lng: -86.03967378516693 },
    { lat: 30.354673062976076, lng: -86.07307042346557 },
    { lat: 30.332606577568797, lng: -86.06019823302029 },
    { lat: 30.279439081116195, lng: -86.00957917871806 },
    { lat: 30.27412219178902, lng: -86.00992153493961 },
  ],
  "WaterSound Beach": [
    { lat: 30.33279368542925, lng: -86.05987604248523 },
    { lat: 30.298010029971863, lng: -86.07716188857569 },
    { lat: 30.293767061012076, lng: -86.06483790408446 },
    { lat: 30.29581040845393, lng: -86.05556581921546 },
    { lat: 30.3195464893671, lng: -86.04712528693167 },
    { lat: 30.33279368542925, lng: -86.05987604248523 },
  ],
  "Seagrove Beach": [
    { lat: 30.318854763519624, lng: -86.14648578450826 },
    { lat: 30.29800443110517, lng: -86.07718801837291 },
    { lat: 30.33277400306234, lng: -86.05982832183034 },
    { lat: 30.355066908123888, lng: -86.09747699526912 },
    { lat: 30.356441202242507, lng: -86.14410078783466 },
    { lat: 30.318854763519624, lng: -86.14648578450826 },
  ],
  "Grayton Beach": [
    { lat: 30.34017675005377, lng: -86.19655321053267 },
    { lat: 30.336907928294124, lng: -86.19244135845905 },
    { lat: 30.334721199412193, lng: -86.19152228240345 },
    { lat: 30.33239339561591, lng: -86.18365644033635 },
    { lat: 30.31884964572356, lng: -86.14651237155411 },
    { lat: 30.356488765411953, lng: -86.14410661047934 },
    { lat: 30.365873186024665, lng: -86.18504397650483 },
    { lat: 30.33962395366827, lng: -86.18523118969047 },
    { lat: 30.34017675005377, lng: -86.19655321053267 },
  ],
  "Dune Allen Beach": [
    { lat: 30.347729690218713, lng: -86.23736632502414 },
    { lat: 30.37168602665642, lng: -86.23648825454285 },
    { lat: 30.374729002827408, lng: -86.27609537961973 },
    { lat: 30.356340367239966, lng: -86.27093916262795 },
    { lat: 30.347729690218713, lng: -86.23736632502414 },
  ],
  "Santa Rosa Beach": [
    { lat: 30.34772233336146, lng: -86.23731252489573 },
    { lat: 30.338415151215898, lng: -86.20476947639881 },
    { lat: 30.340677880717806, lng: -86.20468208335183 },
    { lat: 30.339584234655803, lng: -86.18528082692542 },
    { lat: 30.366120770543873, lng: -86.18501969640899 },
    { lat: 30.371778364329202, lng: -86.23650761531415 },
    { lat: 30.34772233336146, lng: -86.23731252489573 },
  ],
  "Seacrest Beach": [
    { lat: 30.293748829005125, lng: -86.06489519930663 },
    { lat: 30.277639373721286, lng: -86.01931415024751 },
    { lat: 30.285279238992814, lng: -86.0156599733186 },
    { lat: 30.319784350086465, lng: -86.04697526265949 },
    { lat: 30.295769244068623, lng: -86.05556743188328 },
    { lat: 30.293748829005125, lng: -86.06489519930663 },
  ],
  "Rosemary Beach": [
    { lat: 30.285248921299328, lng: -86.01567075132394 },
    { lat: 30.27760905366793, lng: -86.0193249282528 },
    { lat: 30.274144615537224, lng: -86.00992579757758 },
    { lat: 30.279268009901855, lng: -86.00964568621566 },
    { lat: 30.285248921299328, lng: -86.01567075132394 },
  ],
  "Blue Mountain Beach": [
    { lat: 30.340681621369924, lng: -86.20462299123126 },
    { lat: 30.338397968836418, lng: -86.2047147612119 },
    { lat: 30.33482468094624, lng: -86.19190107954137 },
    { lat: 30.336872956380248, lng: -86.19236610117721 },
    { lat: 30.34029376962355, lng: -86.19702346634294 },
    { lat: 30.340681621369924, lng: -86.20462299123126 },
  ],
};

const SPECIFIC_AREA_TO_BROAD_AREA: Record<string, BroadArea> = {
  "Dune Allen Beach": "West 30A",
  "Blue Mountain Beach": "West 30A",
  "Grayton Beach": "West 30A",
  "Seagrove Beach": "Central 30A",
  "WaterSound Beach": "East 30A",
  "Seacrest Beach": "East 30A",
  "Rosemary Beach": "East 30A",
  "Inlet Beach": "East 30A",
  "Santa Rosa Beach": "West 30A",
};

const AREA_ALIAS_TO_SPECIFIC_ZONE: Record<string, SpecificBeachZone> = {
  seaside: "Seagrove Beach",
  watercolor: "Seagrove Beach",
  "old seagrove": "Seagrove Beach",
  "eastern lake": "Seagrove Beach",
  watersound: "WaterSound Beach",
  "watersound west beach": "WaterSound Beach",
  "watersound west": "WaterSound Beach",
  "watersound bridges": "WaterSound Beach",
  "watersound bridge": "WaterSound Beach",
  seacrest: "Seacrest Beach",
  "gulf place": "Santa Rosa Beach",
  "watersound origins": "Inlet Beach",
  "kaiya beach resort": "Inlet Beach",
  "alys beach": "Inlet Beach",
  alys: "Inlet Beach",
  "rosemary inlet beach": "Rosemary Beach",
};

const AREA_TOKEN_CANDIDATES: Array<{
  area: SpecificBeachZone;
  tokens: string[];
}> = [
  { area: "Dune Allen Beach", tokens: ["dune allen"] },
  { area: "Blue Mountain Beach", tokens: ["blue mountain"] },
  { area: "Grayton Beach", tokens: ["grayton"] },
  {
    area: "Seagrove Beach",
    tokens: [
      "seagrove",
      "old seagrove",
      "eastern lake",
      "seaside",
      "watercolor",
    ],
  },
  {
    area: "WaterSound Beach",
    tokens: [
      "watersound beach",
      "watersound west",
      "watersound bridges",
      "watersound bridge",
      "watersound",
    ],
  },
  { area: "Seacrest Beach", tokens: ["seacrest beach", "seacrest"] },
  { area: "Inlet Beach", tokens: ["alys", "alys beach"] },
  { area: "Rosemary Beach", tokens: ["rosemary"] },
  { area: "Santa Rosa Beach", tokens: ["santa rosa", "gulf place"] },
  {
    area: "Inlet Beach",
    tokens: ["inlet", "kaiya", "watersound origins"],
  },
];

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/[-_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalizeSpecificZone(value: string): SpecificBeachZone | null {
  const normalized = normalizeText(value);

  for (const zone of ALL_SPECIFIC_BEACH_ZONES) {
    if (normalizeText(zone) === normalized) {
      return zone;
    }
  }

  if (AREA_ALIAS_TO_SPECIFIC_ZONE[normalized]) {
    return AREA_ALIAS_TO_SPECIFIC_ZONE[normalized];
  }

  return null;
}

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function haversineKm(
  left: { lat: number; lng: number },
  right: { lat: number; lng: number },
): number {
  const earthRadiusKm = 6371;
  const dLat = toRadians(right.lat - left.lat);
  const dLng = toRadians(right.lng - left.lng);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(left.lat)) *
      Math.cos(toRadians(right.lat)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function pointInPolygon(
  point: { lat: number; lng: number },
  polygon: Array<{ lat: number; lng: number }>,
): boolean {
  if (polygon.length < 3) {
    return false;
  }

  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].lng;
    const yi = polygon[i].lat;
    const xj = polygon[j].lng;
    const yj = polygon[j].lat;

    const intersects =
      yi > point.lat !== yj > point.lat &&
      point.lng < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi;

    if (intersects) {
      inside = !inside;
    }
  }

  return inside;
}

function inferSpecificAreaFromText(listing: DiscoverListing): string | null {
  const searchableText = normalizeText(
    `${listing.name} ${listing.id} ${listing.beach} ${listing.area} ${listing.community}`,
  );

  for (const candidate of AREA_TOKEN_CANDIDATES) {
    if (candidate.tokens.some((token) => searchableText.includes(token))) {
      return candidate.area;
    }
  }

  return null;
}

function inferSpecificAreaFromCoordinates(
  lat: number,
  lng: number,
): string | null {
  for (const [zone, polygon] of Object.entries(BEACH_ZONE_POLYGONS)) {
    if (polygon && pointInPolygon({ lat, lng }, polygon)) {
      return zone;
    }
  }

  // East-side gap between Watersound and Rosemary polygons falls to Inlet Beach.
  if (lng > -86.055 && lng <= -86.012) {
    return "Inlet Beach";
  }

  // West-to-central corridor falls to Santa Rosa Beach before broad-region fallback.
  return "Santa Rosa Beach";

  let bestArea: SpecificBeachZone | null = null;
  let bestDistanceKm = Number.POSITIVE_INFINITY;

  for (const area of ALL_SPECIFIC_BEACH_ZONES) {
    const point = geoByArea[area];
    if (!point) {
      continue;
    }

    const distanceKm = haversineKm({ lat, lng }, point);
    if (distanceKm < bestDistanceKm) {
      bestDistanceKm = distanceKm;
      bestArea = area;
    }
  }

  // If the closest known area center is still too far away, keep broad-region fallback.
  if (!bestArea || bestDistanceKm > 8) {
    return null;
  }

  return bestArea;
}

function resolveSpecificArea(listing: DiscoverListing): string | null {
  if (
    Number.isFinite(listing.lat) &&
    Number.isFinite(listing.lng) &&
    listing.lat !== undefined &&
    listing.lng !== undefined
  ) {
    const inferredByCoordinates = inferSpecificAreaFromCoordinates(
      listing.lat,
      listing.lng,
    );
    if (inferredByCoordinates) {
      return inferredByCoordinates;
    }
  }

  const mappedCommunityArea = communityBeachAreaMap[listing.community];
  if (mappedCommunityArea) {
    const canonicalMappedArea = canonicalizeSpecificZone(mappedCommunityArea);
    if (canonicalMappedArea) {
      return canonicalMappedArea;
    }
  }

  const listedArea = listing.area.trim();
  const canonicalListedArea = canonicalizeSpecificZone(listedArea);
  if (canonicalListedArea) {
    return canonicalListedArea;
  }

  const inferredByText = inferSpecificAreaFromText(listing);
  if (inferredByText) {
    return inferredByText;
  }

  return null;
}

function getBroadAreaFromText(listing: DiscoverListing): BroadArea {
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
  const explicitArea = listing.area.trim();
  if (
    explicitArea === "West 30A" ||
    explicitArea === "Central 30A" ||
    explicitArea === "East 30A"
  ) {
    return explicitArea;
  }

  const specificArea = resolveSpecificArea(listing);
  if (specificArea && specificArea in SPECIFIC_AREA_TO_BROAD_AREA) {
    return SPECIFIC_AREA_TO_BROAD_AREA[specificArea];
  }

  return getBroadAreaFromText(listing);
}

export function getBeachZoneFromListing(
  listing: DiscoverListing,
): string | null {
  const explicitBeach = listing.beach.trim();
  if (explicitBeach.length > 0) {
    return explicitBeach;
  }

  return resolveSpecificArea(listing);
}

export function getLocationPresentation(listing: DiscoverListing) {
  const communityName = listing.community.trim();
  const isPlannedCommunity =
    communityName.length > 0 && known30ACommunities.includes(communityName);
  const specificArea = getBeachZoneFromListing(listing);
  const region = getAreaFromListing(listing);

  if (isPlannedCommunity) {
    return {
      isPlannedCommunity: true,
      locationChip: communityName,
      subline: specificArea ? `${specificArea} • ${region}` : region,
    };
  }

  if (specificArea) {
    return {
      isPlannedCommunity: false,
      locationChip: specificArea,
      subline: `${specificArea} • ${region}`,
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

export function verifyGulfFrontClaim(
  listing: DiscoverListing,
): DiscoverListing {
  if (!listing.gulffront) {
    return listing;
  }

  if (
    !Number.isFinite(listing.lat) ||
    !Number.isFinite(listing.lng) ||
    listing.lat === undefined ||
    listing.lng === undefined
  ) {
    return {
      ...listing,
      gulffront: false,
    };
  }

  const isInsideGulfFrontPolygon = pointInPolygon(
    { lat: listing.lat, lng: listing.lng },
    GULF_FRONT_VERIFICATION_POLYGON,
  );

  if (isInsideGulfFrontPolygon) {
    return listing;
  }

  return {
    ...listing,
    gulffront: false,
  };
}
