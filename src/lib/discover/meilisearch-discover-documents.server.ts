import type { DiscoverListing } from "@/lib/discover/discover-types";
import {
  toAreaCodeFromLabel,
  toBeachAreaCodeFromLabel,
  toCommunityCodeFromLabel,
} from "@/lib/listings/taxonomy/location-taxonomy";

export type DiscoverSearchDocument = {
  id: string;
  name: string;
  area: string;
  areaCode: string;
  beach: string;
  beachCode: string;
  community: string;
  communityCode: string;
  lat: number | null;
  lng: number | null;
  bedrooms: number;
  bathrooms: number;
  sleeps: number;
  privatePool: boolean;
  gulffront: boolean;
  golfCart: boolean;
  previewImages: string[];
  typicalPricingMonth: string;
  typicalBaseNightly: number;
  typicalAllInNightly: number;
};

function normalizeCode(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function asNumberOrZero(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}

function asNullableNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

export function toDiscoverSearchDocument(
  listing: DiscoverListing,
): DiscoverSearchDocument {
  const area = listing.area.trim();
  const beach = listing.beach.trim();
  const community = listing.community.trim();

  const areaCode =
    toAreaCodeFromLabel(area) ??
    (area.length > 0 ? normalizeCode(area) : "unknown");
  const beachCode =
    toBeachAreaCodeFromLabel(beach) ??
    (beach.length > 0 ? normalizeCode(beach) : "unknown");
  const communityCode =
    toCommunityCodeFromLabel(community) ??
    (community.length > 0 ? normalizeCode(community) : "unknown");

  return {
    id: listing.id,
    name: listing.name,
    area,
    areaCode,
    beach,
    beachCode,
    community,
    communityCode,
    lat: typeof listing.lat === "number" ? listing.lat : null,
    lng: typeof listing.lng === "number" ? listing.lng : null,
    bedrooms: Math.max(0, Math.round(listing.bedrooms)),
    bathrooms: Math.max(0, listing.bathrooms),
    sleeps: Math.max(0, Math.round(listing.sleeps)),
    privatePool: Boolean(listing.privatePool),
    gulffront: Boolean(listing.gulffront),
    golfCart: Boolean(listing.golfCart),
    previewImages: Array.isArray(listing.previewImages)
      ? listing.previewImages.slice(0, 20)
      : [],
    typicalPricingMonth: listing.typicalPricingMonth,
    typicalBaseNightly: Math.max(0, listing.typicalBaseNightly),
    typicalAllInNightly: Math.max(0, listing.typicalAllInNightly),
  };
}

export function discoverSearchDocumentToListing(
  document: Partial<DiscoverSearchDocument>,
): DiscoverListing {
  return {
    id: asString(document.id),
    name: asString(document.name),
    area: asString(document.area),
    beach: asString(document.beach),
    community: asString(document.community),
    lat: asNullableNumber(document.lat),
    lng: asNullableNumber(document.lng),
    bedrooms: Math.max(0, Math.round(asNumberOrZero(document.bedrooms))),
    bathrooms: Math.max(0, asNumberOrZero(document.bathrooms)),
    sleeps: Math.max(0, Math.round(asNumberOrZero(document.sleeps))),
    privatePool: asBoolean(document.privatePool),
    gulffront: asBoolean(document.gulffront),
    golfCart: asBoolean(document.golfCart),
    previewImages: asStringArray(document.previewImages),
    typicalPricingMonth: asString(document.typicalPricingMonth),
    typicalBaseNightly: Math.max(
      0,
      asNumberOrZero(document.typicalBaseNightly),
    ),
    typicalAllInNightly: Math.max(
      0,
      asNumberOrZero(document.typicalAllInNightly),
    ),
  };
}
