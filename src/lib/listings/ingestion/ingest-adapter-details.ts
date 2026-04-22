import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { and, eq, isNull, sql } from "drizzle-orm";

import { GULF_FRONT_VERIFICATION_POLYGON } from "@/components/discover/gulf-front-polygon";
import { pgDb } from "@/core/server/db";
import {
  listing,
  listing_source_link,
  site,
  type listing as listing_table,
} from "@/lib/db/schema-postgres";
import { resolvePlannedCommunity } from "@/lib/discover/community-resolution";
import type { ListingAiEnrichmentSourceSnapshotPayload } from "@/lib/listings/enrichment/contracts";
import { seedListingAiEnrichmentFromIngest } from "@/lib/listings/enrichment/listing-ai-enrichment-service";
import {
  computeSourceContentHashFromDescription,
  stripDescriptionUiArtifacts,
} from "@/lib/listings/enrichment/source-content-hash";
import {
  toAreaCodeFromLabel,
  toBeachAreaCodeFromLabel,
  toCommunityCodeFromLabel,
} from "@/lib/listings/taxonomy/location-taxonomy";
import { selectCanonicalListings } from "@/lib/pricing/shared/canonical-index-listings";

const BASELINE_SITE_SLUG = "30acollections";

type IngestOptions = {
  adapterKey: string;
  listingId?: string | null;
  maxListings?: number | null;
  dryRun?: boolean;
  rootDir?: string;
};

export type IngestStats = {
  adapterKey: string;
  scanned: number;
  insertedListings: number;
  updatedListings: number;
  insertedSourceLinks: number;
  updatedSourceLinks: number;
  skippedExcludedByMatch: number;
  skippedMissingDetailJson: number;
  skippedMissingName: number;
};

type CanonicalDetailRecord = {
  external_listing_id?: unknown;
  detail_url?: unknown;
  title?: unknown;
  h1?: unknown;
  description_expanded?: unknown;
  meta_description?: unknown;
  rooms_guidance?: unknown;
  amenities?: unknown;
  property_profile?: unknown;
  location?: unknown;
  quote_context?: unknown;
};

type BroadArea = "West 30A" | "Central 30A" | "East 30A";

type SpecificBeachZone =
  | "Dune Allen Beach"
  | "Blue Mountain Beach"
  | "Grayton Beach"
  | "Seagrove Beach"
  | "WaterSound Beach"
  | "Seacrest Beach"
  | "Rosemary Beach"
  | "Santa Rosa Beach"
  | "Inlet Beach";

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

const AREA_NAME_POLYGONS: Record<
  BroadArea,
  Array<Array<{ lat: number; lng: number }>>
> = {
  "East 30A": [
    [
      { lat: 30.332883721349134, lng: -86.05993806721304 },
      { lat: 30.298010029971863, lng: -86.07716188857569 },
      { lat: 30.293767061012076, lng: -86.06483790408446 },
      { lat: 30.29581040845393, lng: -86.05556581921546 },
      { lat: 30.319471328634677, lng: -86.04618017024931 },
      { lat: 30.332883721349134, lng: -86.05993806721304 },
    ],
    [
      { lat: 30.293748829005125, lng: -86.06489519930663 },
      { lat: 30.277639373721286, lng: -86.01931415024751 },
      { lat: 30.285279238992814, lng: -86.0156599733186 },
      { lat: 30.31950175718022, lng: -86.04635553381408 },
      { lat: 30.295769244068623, lng: -86.05556743188328 },
      { lat: 30.293748829005125, lng: -86.06489519930663 },
    ],
    [
      { lat: 30.285248921299328, lng: -86.01567075132394 },
      { lat: 30.27760905366793, lng: -86.0193249282528 },
      { lat: 30.274951568976988, lng: -86.01233711623102 },
      { lat: 30.28163666671793, lng: -86.01193643893637 },
      { lat: 30.285248921299328, lng: -86.01567075132394 },
    ],
  ],
  "West 30A": [
    [
      { lat: 30.34772233336146, lng: -86.23731252489573 },
      { lat: 30.338415151215898, lng: -86.20476947639881 },
      { lat: 30.340677880717806, lng: -86.20468208335183 },
      { lat: 30.336823231750273, lng: -86.14540162628832 },
      { lat: 30.356199724803204, lng: -86.1437473041687 },
      { lat: 30.373741291238275, lng: -86.23656553453812 },
      { lat: 30.34772233336146, lng: -86.23731252489573 },
    ],
    [
      { lat: 30.347729690218713, lng: -86.23736632502414 },
      { lat: 30.37354237666551, lng: -86.23660791538961 },
      { lat: 30.374980656972, lng: -86.27589296474666 },
      { lat: 30.358737996878446, lng: -86.27731991604924 },
      { lat: 30.347729690218713, lng: -86.23736632502414 },
    ],
    [
      { lat: 30.340681621369924, lng: -86.20462299123126 },
      { lat: 30.338397968836418, lng: -86.2047147612119 },
      { lat: 30.337328725930377, lng: -86.20089101202714 },
      { lat: 30.340576020115364, lng: -86.20078394705003 },
      { lat: 30.340681621369924, lng: -86.20462299123126 },
    ],
    [
      { lat: 30.34059995024859, lng: -86.20092558678674 },
      { lat: 30.3373311423627, lng: -86.20090006766108 },
      { lat: 30.31884964572356, lng: -86.14651237155411 },
      { lat: 30.336870102146293, lng: -86.14516619493546 },
      { lat: 30.34059995024859, lng: -86.20092558678674 },
    ],
  ],
  "Central 30A": [
    [
      { lat: 30.318854763519624, lng: -86.14648578450826 },
      { lat: 30.29800443110517, lng: -86.07718801837291 },
      { lat: 30.332933287445925, lng: -86.05975281679308 },
      { lat: 30.355081927340244, lng: -86.09522448104649 },
      { lat: 30.35636293511473, lng: -86.1437622080446 },
      { lat: 30.318854763519624, lng: -86.14648578450826 },
    ],
  ],
};

const SPECIFIC_AREA_TO_BROAD_AREA: Record<SpecificBeachZone, BroadArea> = {
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

const US_STATE_CODES = new Set([
  "AL",
  "AK",
  "AZ",
  "AR",
  "CA",
  "CO",
  "CT",
  "DE",
  "FL",
  "GA",
  "HI",
  "ID",
  "IL",
  "IN",
  "IA",
  "KS",
  "KY",
  "LA",
  "ME",
  "MD",
  "MA",
  "MI",
  "MN",
  "MS",
  "MO",
  "MT",
  "NE",
  "NV",
  "NH",
  "NJ",
  "NM",
  "NY",
  "NC",
  "ND",
  "OH",
  "OK",
  "OR",
  "PA",
  "RI",
  "SC",
  "SD",
  "TN",
  "TX",
  "UT",
  "VT",
  "VA",
  "WA",
  "WV",
  "WI",
  "WY",
  "DC",
]);

const US_STATE_NAME_TO_CODE: Record<string, string> = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY",
  "district of columbia": "DC",
};

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeUsStateCode(value: string | null): string | null {
  const text = asString(value);
  if (!text) {
    return null;
  }

  const upper = text.toUpperCase();
  if (US_STATE_CODES.has(upper)) {
    return upper;
  }

  return US_STATE_NAME_TO_CODE[text.toLowerCase()] ?? null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value.replace(/,/g, "").trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function hashHex(value: string, length: number): string {
  return createHash("sha1").update(value).digest("hex").slice(0, length);
}

function buildSourceContentHash(input: {
  descriptionExpanded: string;
}): string {
  // Enrichment rerun signal is intentionally description-driven to avoid
  // expensive recomputation for unrelated source field drift.
  return computeSourceContentHashFromDescription(input.descriptionExpanded);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function toTitleCase(value: string): string {
  const lowered = value.toLowerCase();
  const result = lowered.replace(/\b([a-z])/g, (_match, chr: string) =>
    chr.toUpperCase(),
  );

  return result
    .replace(/\b30a\b/g, "30A")
    .replace(/\bLsv\b/g, "LSV")
    .replace(/\bUsa\b/g, "USA")
    .replace(/\bFl\b/g, "FL");
}

function normalizeListingName(input: string, fallbackId: string): string {
  const raw = input.trim();
  const base = raw || fallbackId;
  const stripped = base.replace(/\s*\|\s*[^|]+$/, "").trim();
  const lettersOnly = stripped.replace(/[^A-Za-z]/g, "");
  const mostlyUppercase =
    stripped.length > 0 &&
    lettersOnly.length > 0 &&
    lettersOnly === lettersOnly.toUpperCase();

  return mostlyUppercase ? toTitleCase(stripped) : stripped;
}

function extractQuotedPropertyName(input: string): string {
  const quoteMatch = input.match(/["“]([^"”]{2,120})["”]/);
  return quoteMatch?.[1]?.trim() ?? "";
}

function buildSlugParts(input: {
  canonicalName: string;
  communityName?: string | null;
  beachAreaName?: string | null;
  areaName?: string | null;
  stableKey: string;
}) {
  const slug_base = slugify(input.canonicalName) || "listing";
  const qualifierSource =
    asString(input.communityName ?? "") ||
    asString(input.beachAreaName ?? "") ||
    asString(input.areaName ?? "");
  const slug_qualifier = qualifierSource ? slugify(qualifierSource) : null;
  const slug_hash8 = hashHex(input.stableKey, 8);
  const slug = slug_qualifier
    ? `${slug_base}-in-${slug_qualifier}-${slug_hash8}-at-30a-collections`
    : `${slug_base}-${slug_hash8}-at-30a-collections`;

  return {
    slug,
    slug_base,
    slug_qualifier,
    slug_hash8,
  };
}

function buildDeterministicListingNumber(stableKey: string): number {
  const digest = createHash("sha1").update(stableKey).digest();
  const raw = digest.readUInt32BE(0);
  return 100000000 + (raw % 900000000);
}

function buildCanonicalName(
  detail: CanonicalDetailRecord,
  fallbackId: string,
): string {
  const h1 = asString(detail.h1);
  const quotedFromH1 = extractQuotedPropertyName(h1);
  if (quotedFromH1) {
    return normalizeListingName(quotedFromH1, fallbackId);
  }

  if (h1) {
    return normalizeListingName(h1, fallbackId);
  }

  const title = asString(detail.title);
  if (title) {
    return normalizeListingName(title, fallbackId);
  }

  return normalizeListingName(fallbackId, fallbackId);
}

function normalizePositiveInteger(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }

  const rounded = Math.round(value);
  return rounded > 0 ? rounded : null;
}

function normalizePositiveDecimalString(value: number | null): string | null {
  if (value === null || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return value.toString();
}

function parseCount(text: string, regex: RegExp): number | null {
  const match = text.match(regex);
  if (!match?.[1]) {
    return null;
  }

  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}

function inferBedroomCount(
  profileBeds: number | null,
  detail: CanonicalDetailRecord,
): number | null {
  const direct = normalizePositiveInteger(profileBeds);
  if (direct !== null) {
    return direct;
  }

  const textBlob = [
    asString(detail.h1),
    asString(detail.title),
    asString(detail.description_expanded),
    asString(detail.meta_description),
  ]
    .filter(Boolean)
    .join("\n");

  const fromBedrooms = parseCount(textBlob, /(\d+)\s*bed(?:room)?s?/i);
  if (fromBedrooms !== null) {
    return fromBedrooms;
  }

  const fromSleeps = parseCount(textBlob, /sleeps\s*(\d+)/i);
  if (fromSleeps !== null) {
    const estimated = Math.floor(fromSleeps / 2);
    return estimated > 0 ? estimated : null;
  }

  return null;
}

function inferSleepsCount(
  profileSleeps: number | null,
  detail: CanonicalDetailRecord,
): number | null {
  const direct = normalizePositiveInteger(profileSleeps);
  if (direct !== null) {
    return direct;
  }

  const textBlob = [
    asString(detail.h1),
    asString(detail.title),
    asString(detail.description_expanded),
    asString(detail.meta_description),
  ]
    .filter(Boolean)
    .join("\n");

  return parseCount(textBlob, /sleeps\s*(\d+)/i);
}

function inferCanonicalPropertyType(input: {
  detail: CanonicalDetailRecord;
  canonicalName: string;
  externalListingId: string;
  bedrooms: number | null;
}): "condo" | "cottage" | "carriage" | "townhome" | "house" {
  const profile = asObject(input.detail.property_profile);
  const sourcePropertyType = asString(profile?.property_type).toLowerCase();
  const rawSourceTitle = asString(input.detail.title);

  const bedrooms = input.bedrooms ?? 0;

  const descriptionBlob = [
    asString(input.detail.description_expanded),
    asString(input.detail.meta_description),
  ]
    .filter(Boolean)
    .join("\n");

  const hasTownhomeSignal = /\btown(?:home|house)s?\b/i.test(descriptionBlob);
  const hasCondoSignal = /\bcondo(?:minium)?s?\b/i.test(descriptionBlob);

  const hasCarriageSignal = /\bcarriage\s+house\b|\bcarriage\b/i.test(
    rawSourceTitle,
  );
  const hasCottageSignal = /\bcottage\b/i.test(rawSourceTitle);

  // Carriage/cottage retain classification only when explicitly present in the actual source title.
  if (hasCarriageSignal) {
    return "carriage";
  }
  if (hasCottageSignal) {
    return "cottage";
  }

  // Condo requires explicit condo wording in source description/meta text.
  if (hasCondoSignal) {
    if (bedrooms > 3) {
      return "house";
    }
    return "condo";
  }

  // Townhome requires explicit description signal and a strict bedroom cap.
  if (hasTownhomeSignal) {
    if (bedrooms >= 4) {
      return "house";
    }
    return "townhome";
  }

  if (bedrooms >= 3) {
    return "house";
  }

  if (/\b(vacation\s+home|house|home|villa)\b/i.test(sourcePropertyType)) {
    return "house";
  }

  return "house";
}

function inferIsGulfFront(input: {
  lat: number | null;
  lng: number | null;
}): boolean {
  if (input.lat === null || input.lng === null) {
    return false;
  }

  return pointInPolygon(
    {
      lat: input.lat,
      lng: input.lng,
    },
    GULF_FRONT_VERIFICATION_POLYGON,
  );
}

function extractAmenities(detail: CanonicalDetailRecord): string[] {
  const amenities = asObject(detail.amenities);
  if (!amenities) {
    return [];
  }

  const all = Array.isArray(amenities.all) ? amenities.all : [];
  const categories = asObject(amenities.categories);
  const categoryValues = categories
    ? Object.values(categories)
        .flatMap((value) => (Array.isArray(value) ? value : []))
        .map((entry) => asString(entry))
    : [];

  return Array.from(
    new Set(
      [...all, ...categoryValues]
        .map((entry) => asString(entry))
        .filter(Boolean),
    ),
  );
}

function extractRoomsGuidance(detail: CanonicalDetailRecord): string[] {
  if (!Array.isArray(detail.rooms_guidance)) {
    return [];
  }

  return Array.from(
    new Set(
      detail.rooms_guidance
        .map((entry) => asString(entry))
        .map((entry) => entry.replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .filter((entry) => entry.length >= 6 && entry.length <= 240),
    ),
  ).slice(0, 80);
}

function toTraitObjects(detail: CanonicalDetailRecord, amenities: string[]) {
  const amenityHaystack = amenities.join("\n").toLowerCase();
  const textHaystack = [
    asString(detail.title),
    asString(detail.h1),
    asString(detail.description_expanded),
    asString(detail.meta_description),
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  const combinedHaystack = `${amenityHaystack}\n${textHaystack}`;

  const hasAny = (patterns: RegExp[]) =>
    patterns.some((pattern) => pattern.test(combinedHaystack));
  const hasAnyAmenity = (patterns: RegExp[]) =>
    patterns.some((pattern) => pattern.test(amenityHaystack));

  const boolTrait = (key: string, value: boolean) => ({
    key,
    value_type: "boolean",
    value_boolean: value,
    extraction_method: "rule",
    confidence_score: value ? 0.9 : 0.75,
    sources: [
      {
        source: "amenities",
      },
    ],
  });

  return [
    boolTrait(
      "feature.private_pool",
      !hasAny([
        /\bno\s+private\s+pool\b/,
        /\bnot\s+a?\s*private\s+pool\b/,
        /\bwithout\s+a?\s*private\s+pool\b/,
      ]) &&
        (hasAnyAmenity([/\bprivate\s+pool\b/, /\bpool\s*\(private\)\b/]) ||
          hasAny([/\bprivate\s+pool\b/])),
    ),
    boolTrait(
      "feature.pets_allowed",
      !hasAny([/\bno\s+pets?\s+allowed\b/, /\bpets?\s+not\s+allowed\b/]) &&
        hasAny([/\bpets?\s+allowed\b/, /\bpet[-\s]?friendly\b/]),
    ),
    boolTrait(
      "feature.golf_cart",
      !hasAny([
        /\bno\s+golf\s*cart\b/,
        /\bwithout\s+golf\s*cart\b/,
        /\bgolf\s*cart\s+not\s+included\b/,
      ]) && hasAny([/\bgolf\s*cart\b/, /\blsv\b/]),
    ),
    boolTrait(
      "feature.accessible",
      hasAny([/\baccessible\b/, /\bwheelchair\b/, /\bmobility\b/]),
    ),
    boolTrait("feature.elevator", hasAny([/\belevator\b/])),
  ];
}

function parseCityState(detail: CanonicalDetailRecord): {
  city: string | null;
  state: string | null;
} {
  const profile = asObject(detail.property_profile);
  const location = asObject(detail.location);
  const profileCity = asString(profile?.city);
  const profileState = asString(profile?.state);

  if (profileCity || profileState) {
    return {
      city: profileCity || null,
      state: normalizeUsStateCode(profileState),
    };
  }

  const candidates: Array<{ city: string | null; state: string | null }> = [];

  const walk = (value: unknown) => {
    if (!value || typeof value !== "object") {
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item);
      }
      return;
    }

    const objectValue = value as Record<string, unknown>;
    const city =
      asString(objectValue.city) ||
      asString(objectValue.locality) ||
      asString(objectValue.town) ||
      null;
    const state =
      asString(objectValue.state) ||
      asString(objectValue.province) ||
      asString(objectValue.region) ||
      null;
    if (city || state) {
      candidates.push({ city, state });
    }

    for (const nested of Object.values(objectValue)) {
      walk(nested);
    }
  };

  walk(detail.property_profile);
  walk(detail.location);
  walk(detail.quote_context);

  const bestNested = candidates.find((entry) => entry.city || entry.state);
  if (bestNested) {
    return {
      city: bestNested.city,
      state: normalizeUsStateCode(bestNested.state),
    };
  }

  const label = asString(location?.location_label);
  const parts = label
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length >= 2) {
    const stateToken = parts[1]?.split(/\s+/)[0]?.trim() || null;
    return {
      city: parts[0] || null,
      state: normalizeUsStateCode(stateToken),
    };
  }

  return { city: null, state: null };
}

function normalizePostalCode(value: string): string | null {
  const text = value.trim();
  if (!text) {
    return null;
  }

  const us = text.match(/\b\d{5}(?:-\d{4})?\b/);
  if (us) {
    return us[0];
  }

  return text;
}

function inferPostalCode(detail: CanonicalDetailRecord): string | null {
  const candidates: string[] = [];
  const visited = new Set<unknown>();

  const walk = (value: unknown) => {
    if (!value || typeof value !== "object") {
      return;
    }

    if (visited.has(value)) {
      return;
    }
    visited.add(value);

    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item);
      }
      return;
    }

    for (const [key, nested] of Object.entries(value)) {
      if (/(postal|postcode|zip)/i.test(key)) {
        const maybe = asString(nested);
        if (maybe) {
          candidates.push(maybe);
        }
      }

      if (/(address|location|label)/i.test(key)) {
        const maybe = asString(nested);
        if (maybe) {
          candidates.push(maybe);
        }
      }

      walk(nested);
    }
  };

  walk(detail.property_profile);
  walk(detail.location);
  walk(detail.quote_context);

  const label = asString(asObject(detail.location)?.location_label);
  if (label) {
    candidates.push(label);
  }

  const textBlob = [
    asString(detail.h1),
    asString(detail.title),
    asString(detail.description_expanded),
    asString(detail.meta_description),
  ]
    .filter(Boolean)
    .join("\n");
  if (textBlob) {
    candidates.push(textBlob);
  }

  for (const candidate of candidates) {
    const normalized = normalizePostalCode(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/[-_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

const EDGE_FALLBACK_METERS = 250;
const METERS_PER_MILE = 1609.344;

function toXYMiles(
  point: { lat: number; lng: number },
  referenceLatDeg: number,
): { x: number; y: number } {
  const milesPerLatDeg = 69.0;
  const milesPerLngDeg = 69.172 * Math.cos((referenceLatDeg * Math.PI) / 180);
  return {
    x: point.lng * milesPerLngDeg,
    y: point.lat * milesPerLatDeg,
  };
}

function pointToSegmentDistanceMiles(
  point: { lat: number; lng: number },
  start: { lat: number; lng: number },
  end: { lat: number; lng: number },
): number {
  const refLat = (point.lat + start.lat + end.lat) / 3;
  const p = toXYMiles(point, refLat);
  const a = toXYMiles(start, refLat);
  const b = toXYMiles(end, refLat);

  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;

  if (lengthSq === 0) {
    return Math.hypot(p.x - a.x, p.y - a.y);
  }

  const t = Math.max(
    0,
    Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq),
  );
  const projX = a.x + t * dx;
  const projY = a.y + t * dy;
  return Math.hypot(p.x - projX, p.y - projY);
}

function pointToPolygonEdgeDistanceMeters(
  point: { lat: number; lng: number },
  polygon: Array<{ lat: number; lng: number }>,
): number {
  if (polygon.length < 2) {
    return Number.POSITIVE_INFINITY;
  }

  let bestMiles = Number.POSITIVE_INFINITY;
  for (let i = 0; i < polygon.length - 1; i += 1) {
    const miles = pointToSegmentDistanceMiles(
      point,
      polygon[i],
      polygon[i + 1],
    );
    if (miles < bestMiles) {
      bestMiles = miles;
    }
  }

  return bestMiles * METERS_PER_MILE;
}

function inferSpecificAreaFromCoordinates(
  lat: number,
  lng: number,
): SpecificBeachZone | null {
  for (const [zone, polygon] of Object.entries(BEACH_ZONE_POLYGONS)) {
    if (polygon && pointInPolygon({ lat, lng }, polygon)) {
      return zone as SpecificBeachZone;
    }
  }

  return null;
}

function inferSpecificAreaFromCoordinatesEdgeBuffer(
  lat: number,
  lng: number,
  maxDistanceMeters: number,
): SpecificBeachZone | null {
  const point = { lat, lng };
  let bestZone: SpecificBeachZone | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const [zone, polygon] of Object.entries(BEACH_ZONE_POLYGONS)) {
    if (!polygon || polygon.length < 2) {
      continue;
    }
    const distanceMeters = pointToPolygonEdgeDistanceMeters(point, polygon);
    if (distanceMeters < bestDistance) {
      bestDistance = distanceMeters;
      bestZone = zone as SpecificBeachZone;
    }
  }

  if (bestZone && bestDistance <= maxDistanceMeters) {
    return bestZone;
  }

  return null;
}

function inferBroadAreaFromCoordinates(
  lat: number,
  lng: number,
): BroadArea | null {
  for (const [area, polygons] of Object.entries(AREA_NAME_POLYGONS)) {
    const isInsideAny = polygons.some((polygon) =>
      pointInPolygon({ lat, lng }, polygon),
    );
    if (isInsideAny) {
      return area as BroadArea;
    }
  }

  return null;
}

function inferBroadAreaFromCoordinatesEdgeBuffer(
  lat: number,
  lng: number,
  maxDistanceMeters: number,
): BroadArea | null {
  const point = { lat, lng };
  let bestArea: BroadArea | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const [area, polygons] of Object.entries(AREA_NAME_POLYGONS)) {
    for (const polygon of polygons) {
      const distanceMeters = pointToPolygonEdgeDistanceMeters(point, polygon);
      if (distanceMeters < bestDistance) {
        bestDistance = distanceMeters;
        bestArea = area as BroadArea;
      }
    }
  }

  if (bestArea && bestDistance <= maxDistanceMeters) {
    return bestArea;
  }

  return null;
}

function inferSpecificAreaFromSourceArea(
  sourceAreaName: string | null,
): SpecificBeachZone | null {
  if (!sourceAreaName) {
    return null;
  }

  const normalized = normalizeText(sourceAreaName);
  return AREA_ALIAS_TO_SPECIFIC_ZONE[normalized] ?? null;
}

function resolveBeachAreaName(input: {
  lat: number | null;
  lng: number | null;
  sourceAreaName: string | null;
}): SpecificBeachZone | null {
  if (input.lat !== null && input.lng !== null) {
    const specificByPolygon = inferSpecificAreaFromCoordinates(
      input.lat,
      input.lng,
    );
    if (specificByPolygon) {
      return specificByPolygon;
    }

    return inferSpecificAreaFromCoordinatesEdgeBuffer(
      input.lat,
      input.lng,
      EDGE_FALLBACK_METERS,
    );
  }

  return inferSpecificAreaFromSourceArea(input.sourceAreaName);
}

function resolveBroadAreaName(input: {
  lat: number | null;
  lng: number | null;
  sourceAreaName: string | null;
}): BroadArea | null {
  if (input.lat !== null && input.lng !== null) {
    const broadByPolygon = inferBroadAreaFromCoordinates(input.lat, input.lng);
    if (broadByPolygon) {
      return broadByPolygon;
    }

    return inferBroadAreaFromCoordinatesEdgeBuffer(
      input.lat,
      input.lng,
      EDGE_FALLBACK_METERS,
    );
  }

  const specificBySourceArea = inferSpecificAreaFromSourceArea(
    input.sourceAreaName,
  );
  if (specificBySourceArea) {
    return SPECIFIC_AREA_TO_BROAD_AREA[specificBySourceArea];
  }

  return null;
}

function resolveCommunityName(input: {
  externalListingId: string;
  canonicalName: string;
  sourceAreaName: string | null;
  beachAreaName: string | null;
  city: string | null;
  state: string | null;
  lat: number | null;
  lng: number | null;
}): string | null {
  const result = resolvePlannedCommunity({
    id: input.externalListingId,
    name: input.canonicalName,
    area: input.beachAreaName ?? input.sourceAreaName ?? "",
    community: input.sourceAreaName ?? "",
    addressText: [input.city, input.state].filter(Boolean).join(", "),
    lat: input.lat ?? undefined,
    lng: input.lng ?? undefined,
  });

  const top = result.topCandidate;
  if (!top) {
    return null;
  }

  if (top.reasons.includes("polygon:inside")) {
    return top.community;
  }

  return null;
}

async function resolveBaselineSiteId(): Promise<string> {
  if (!pgDb) {
    throw new Error("Postgres database is not configured.");
  }

  const found = await pgDb
    .select({ id: site.id })
    .from(site)
    .where(eq(site.slug, BASELINE_SITE_SLUG))
    .limit(1);

  if (found.length === 0) {
    throw new Error(
      `Baseline site '${BASELINE_SITE_SLUG}' is missing. Run db:setup:postgres:raw first.`,
    );
  }

  return found[0].id;
}

async function readDetailJson(
  rootDir: string,
  adapterKey: string,
  fileBaseNames: string[],
): Promise<{
  detail: CanonicalDetailRecord;
  resolvedFileBaseName: string;
} | null> {
  for (const fileBaseName of fileBaseNames) {
    if (!fileBaseName.trim()) {
      continue;
    }

    const filePath = resolve(
      rootDir,
      "src",
      "lib",
      "data",
      "external-sources",
      adapterKey,
      "details",
      "json",
      `${fileBaseName}.json`,
    );

    try {
      const raw = await readFile(filePath, "utf8");
      return {
        detail: JSON.parse(raw) as CanonicalDetailRecord,
        resolvedFileBaseName: fileBaseName,
      };
    } catch {
      // Try next candidate filename.
    }
  }

  return null;
}

export async function ingestAdapterDetailsToCanonical(
  options: IngestOptions,
): Promise<IngestStats> {
  if (!pgDb) {
    throw new Error("Postgres database is not configured.");
  }

  const rootDir = options.rootDir ?? process.cwd();
  const siteId = await resolveBaselineSiteId();
  const canonicalListings = await selectCanonicalListings({
    adapterKey: options.adapterKey,
    listingId: options.listingId,
    maxListings: options.maxListings,
    rootDir,
  });

  const excludedSourceLinks = await pgDb
    .select({
      externalListingId: listing_source_link.external_listing_id,
    })
    .from(listing_source_link)
    .where(
      and(
        eq(listing_source_link.adapter_key, options.adapterKey),
        eq(listing_source_link.is_primary_source, true),
        eq(listing_source_link.source_status, "active"),
        isNull(listing_source_link.active_to),
        eq(listing_source_link.excluded_by_match, true),
      ),
    );

  const excludedExternalListingIds = new Set(
    excludedSourceLinks
      .map((row) => row.externalListingId.trim())
      .filter((value) => value.length > 0),
  );

  const stats: IngestStats = {
    adapterKey: options.adapterKey,
    scanned: 0,
    insertedListings: 0,
    updatedListings: 0,
    insertedSourceLinks: 0,
    updatedSourceLinks: 0,
    skippedExcludedByMatch: 0,
    skippedMissingDetailJson: 0,
    skippedMissingName: 0,
  };

  for (const candidate of canonicalListings) {
    stats.scanned += 1;

    if (excludedExternalListingIds.has(candidate.externalListingId)) {
      stats.skippedExcludedByMatch += 1;
      continue;
    }

    const detailResolution = await readDetailJson(rootDir, options.adapterKey, [
      candidate.detailFileBaseName,
      candidate.externalListingId,
    ]);

    if (!detailResolution) {
      stats.skippedMissingDetailJson += 1;
      continue;
    }
    const detail = detailResolution.detail;

    const stableKey = `${options.adapterKey}:${candidate.externalListingId}`;
    const canonicalName = buildCanonicalName(
      detail,
      candidate.externalListingId,
    );
    if (!canonicalName) {
      stats.skippedMissingName += 1;
      continue;
    }

    const parsedCityState = parseCityState(detail);
    const profile = asObject(detail.property_profile);
    const location = asObject(detail.location);
    const lat = asNumber(location?.latitude);
    const lng = asNumber(location?.longitude);
    const sourceAreaName = asString(profile?.area) || null;
    const beachAreaName = resolveBeachAreaName({
      lat,
      lng,
      sourceAreaName,
    });
    const areaName = resolveBroadAreaName({
      lat,
      lng,
      sourceAreaName,
    });
    const communityName = resolveCommunityName({
      externalListingId: candidate.externalListingId,
      canonicalName,
      sourceAreaName,
      beachAreaName,
      city: parsedCityState.city,
      state: parsedCityState.state,
      lat,
      lng,
    });
    const areaCode = toAreaCodeFromLabel(areaName);
    const beachAreaCode = toBeachAreaCodeFromLabel(beachAreaName);
    const communityCode = toCommunityCodeFromLabel(communityName);
    const amenities = extractAmenities(detail);
    const roomsGuidance = extractRoomsGuidance(detail);
    const traits = toTraitObjects(detail, amenities);
    const bedrooms = inferBedroomCount(asNumber(profile?.beds), detail);
    const sleeps = inferSleepsCount(asNumber(profile?.sleeps), detail);
    const bathrooms = normalizePositiveDecimalString(asNumber(profile?.baths));
    const descriptionExpanded = stripDescriptionUiArtifacts(
      asString(detail.description_expanded),
    );
    const metaDescription = asString(detail.meta_description);
    const sourceContentHash = buildSourceContentHash({
      descriptionExpanded,
    });
    const slugParts = buildSlugParts({
      canonicalName,
      communityName,
      beachAreaName,
      areaName,
      stableKey,
    });
    const listingId = `lst_${hashHex(stableKey, 20)}`;
    const listingNumber = buildDeterministicListingNumber(stableKey);
    const externalQuoteContext = asObject(candidate.quoteContext);
    const detailQuoteContext = asObject(detail.quote_context);
    const quoteContext = externalQuoteContext ?? detailQuoteContext ?? {};
    const detailUrl =
      candidate.detailUrl || asString(detail.detail_url) || null;
    const inferredPostalCode = inferPostalCode(detail);
    const city = parsedCityState.city;
    const state = parsedCityState.state;
    const postalCode = inferredPostalCode;
    const now = new Date().toISOString();

    const listingValues: typeof listing_table.$inferInsert = {
      id: listingId,
      listing_number: listingNumber,
      site_id: siteId,
      status: "active",
      slug: slugParts.slug,
      slug_base: slugParts.slug_base,
      slug_qualifier: slugParts.slug_qualifier,
      slug_hash8: slugParts.slug_hash8,
      canonical_name: canonicalName,
      // Canonical ingest should never persist zero bedrooms/sleeps values.
      property_type: inferCanonicalPropertyType({
        detail,
        canonicalName,
        externalListingId: candidate.externalListingId,
        bedrooms,
      }),
      bedrooms,
      bathrooms,
      sleeps,
      // AI-owned content field: keep null during canonical source ingest.
      description_markdown: null,
      lat,
      lng,
      city,
      state,
      postal_code: postalCode,
      country_code: "US",
      area: sourceAreaName,
      area_name: areaCode,
      beach_area_name: beachAreaCode,
      community_name: communityCode,
      is_gulf_front: inferIsGulfFront({ lat, lng }),
      traits,
      amenities_normalized: amenities,
      updated_at: now,
    };

    const sourceLinkId = `lsl_${hashHex(stableKey, 20)}`;
    const sourceSnapshotPayload: ListingAiEnrichmentSourceSnapshotPayload = {
      canonical_name: canonicalName,
      description_expanded: descriptionExpanded || null,
      meta_description: metaDescription || null,
      rooms_guidance: roomsGuidance,
      property_type: listingValues.property_type ?? null,
      amenities,
      area: sourceAreaName,
      bedrooms,
      bathrooms,
      sleeps,
      lat,
      lng,
    };

    const existingSourceLink = await pgDb
      .select({ id: listing_source_link.id })
      .from(listing_source_link)
      .where(
        and(
          eq(listing_source_link.adapter_key, options.adapterKey),
          eq(
            listing_source_link.external_listing_id,
            candidate.externalListingId,
          ),
        ),
      )
      .limit(1);

    if (!options.dryRun) {
      await pgDb
        .insert(listing)
        .values(listingValues)
        .onConflictDoUpdate({
          target: listing.id,
          set: {
            site_id: listingValues.site_id,
            status: listingValues.status,
            slug: listingValues.slug,
            slug_base: listingValues.slug_base,
            slug_qualifier: listingValues.slug_qualifier,
            slug_hash8: listingValues.slug_hash8,
            canonical_name: listingValues.canonical_name,
            property_type: listingValues.property_type,
            bedrooms: sql`coalesce(${listingValues.bedrooms}, ${listing.bedrooms})`,
            bathrooms: sql`coalesce(${listingValues.bathrooms}, ${listing.bathrooms})`,
            sleeps: sql`coalesce(${listingValues.sleeps}, ${listing.sleeps})`,
            lat: listingValues.lat,
            lng: listingValues.lng,
            city: listingValues.city,
            state: listingValues.state,
            area: listingValues.area,
            area_name: listingValues.area_name,
            beach_area_name: listingValues.beach_area_name,
            community_name: listingValues.community_name,
            is_gulf_front: listingValues.is_gulf_front,
            traits: listingValues.traits,
            amenities_normalized: listingValues.amenities_normalized,
            updated_at: now,
          },
        });

      await pgDb
        .insert(listing_source_link)
        .values({
          id: sourceLinkId,
          listing_id: listingId,
          adapter_key: options.adapterKey,
          external_listing_id: candidate.externalListingId,
          details_url: detailUrl,
          quote_context: quoteContext,
          is_primary_source: true,
          source_status: "active",
          confidence_score: "1.0000",
          first_seen_at: now,
          last_seen_at: now,
          active_from: now,
          active_to: null,
          match_method: "adapter_external_listing_id",
          match_evidence: {
            source: "adapter_details_json",
            detail_file_base_name: detailResolution.resolvedFileBaseName,
            source_content_hash: sourceContentHash,
            source_snapshot: {
              ...sourceSnapshotPayload,
            },
          },
          updated_at: now,
        })
        .onConflictDoUpdate({
          target: [
            listing_source_link.adapter_key,
            listing_source_link.external_listing_id,
          ],
          set: {
            listing_id: listingId,
            details_url: detailUrl,
            quote_context: quoteContext,
            source_status: "active",
            is_primary_source: true,
            last_seen_at: now,
            active_to: null,
            match_method: "adapter_external_listing_id",
            match_evidence: {
              source: "adapter_details_json",
              detail_file_base_name: detailResolution.resolvedFileBaseName,
              source_content_hash: sourceContentHash,
              source_snapshot: {
                ...sourceSnapshotPayload,
              },
            },
            updated_at: now,
          },
        });

      await seedListingAiEnrichmentFromIngest({
        listingId,
        sourceLinkId,
        adapterKey: options.adapterKey,
        sourceContentHash,
        sourceSnapshot: {
          ...sourceSnapshotPayload,
        },
      });
    }

    if (existingSourceLink.length > 0) {
      stats.updatedSourceLinks += 1;
      stats.updatedListings += 1;
    } else {
      stats.insertedSourceLinks += 1;
      stats.insertedListings += 1;
    }
  }

  return stats;
}
