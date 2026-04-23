import {
  AVAILABILITY_INDEX_MAX_STAY_NIGHTS,
  buildAvailabilityStartIndex,
  dayIntFromIsoDateString,
} from "@/lib/discover/availability-window-index";
import type { DiscoverListing } from "@/lib/discover/discover-types";
import {
  areaLabelFromCode,
  beachAreaLabelFromCode,
  communityLabelFromCode,
  toAreaCodeFromLabel,
  toBeachAreaCodeFromLabel,
  toCommunityCodeFromLabel,
} from "@/lib/listings/taxonomy/location-taxonomy";

export type DiscoverSearchDocument = {
  id: string;
  name: string;
  area_name: string | null;
  beach_area_name: string | null;
  community_name: string | null;
  area: string;
  beach: string;
  community: string;
  lat: number | null;
  lng: number | null;
  bedrooms: number;
  bathrooms: number;
  sleeps: number;
  private_pool: boolean;
  gulf_front: boolean;
  golf_cart: boolean;
  pet_friendly: boolean;
  accessible: boolean;
  elevator: boolean;
  king_bed_count: number;
  queen_bed_count: number;
  bunk_bed_count: number;
  preview_images: string[];
  poster: string | null;
  images: Array<{ name: string; url: string }>;
  image_count: number;
  description_headline: string | null;
  description_markdown: string | null;
  description_plain: string | null;
  highlights_list: string[];
  helpful_hints: string[];
  sleeping_arrangements: string[];
  amenities_list: string[];
  seo_meta_title: string | null;
  seo_meta_description: string | null;
  seo_hidden_summary_plain: string | null;
  status_code_string: string | null;
  upcoming_typical_pricing_months: Array<{
    monthLabel: string;
    monthStartDate: string;
    typicalAllInNightly: number;
  }>;
  typical_pricing_month: string;
  typical_base_nightly: number;
  typical_all_in_nightly: number;
} & Partial<Record<`avail_${number}`, number[]>>;

function utcTodayDayInt(): number {
  const now = new Date();
  const year = String(now.getUTCFullYear()).padStart(4, "0");
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  return Number(`${year}${month}${day}`);
}

function availabilityFieldNames(
  maxStayNights = AVAILABILITY_INDEX_MAX_STAY_NIGHTS,
): string[] {
  const out: string[] = [];
  for (let nights = 1; nights <= maxStayNights; nights += 1) {
    out.push(`avail_${nights}`);
  }
  return out;
}

function buildAvailabilityFields(
  listing: DiscoverListing,
): Record<string, number[]> {
  const fieldNames = availabilityFieldNames(AVAILABILITY_INDEX_MAX_STAY_NIGHTS);
  const fallback = Object.fromEntries(
    fieldNames.map((name) => [name, []]),
  ) as Record<string, number[]>;
  const calendarStatus = listing.availabilityCalendarStatus;
  if (!calendarStatus || typeof calendarStatus !== "object") {
    return fallback;
  }

  const dayRows = Object.entries(calendarStatus)
    .map(([rawDate, status]) => {
      const dayInt = dayIntFromIsoDateString(rawDate);
      if (dayInt === null) {
        return null;
      }
      return {
        dayInt,
        isNightAvailable: status?.isNightAvailable === true,
      };
    })
    .filter(
      (
        row,
      ): row is {
        dayInt: number;
        isNightAvailable: boolean;
      } => row !== null,
    )
    .sort((a, b) => a.dayInt - b.dayInt);

  if (dayRows.length === 0) {
    return fallback;
  }

  const dayInts = dayRows.map((row) => row.dayInt);
  const availabilityFlags = dayRows.map((row) =>
    row.isNightAvailable ? 1 : 0,
  ) as Array<0 | 1>;

  const index = buildAvailabilityStartIndex({
    dayInts,
    availabilityFlags,
    maxStayNights: AVAILABILITY_INDEX_MAX_STAY_NIGHTS,
  });

  return {
    ...fallback,
    ...index,
  };
}

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

function asImageArray(value: unknown): Array<{ name: string; url: string }> {
  if (!Array.isArray(value)) {
    return [];
  }

  const out: Array<{ name: string; url: string }> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const row = entry as Record<string, unknown>;
    const url = asString(row.url);
    if (!url) {
      continue;
    }
    const name = asString(row.name) || `Photo ${out.length + 1}`;
    out.push({ name, url });
  }

  return out;
}

function asUpcomingPricingMonths(value: unknown): Array<{
  monthLabel: string;
  monthStartDate: string;
  typicalAllInNightly: number;
}> {
  if (!Array.isArray(value)) {
    return [];
  }

  const out: Array<{
    monthLabel: string;
    monthStartDate: string;
    typicalAllInNightly: number;
  }> = [];

  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const row = entry as Record<string, unknown>;
    const monthLabel = asString(row.monthLabel);
    const monthStartDate = asString(row.monthStartDate);
    const nightly = asNumberOrZero(row.typicalAllInNightly);
    if (!monthLabel || !monthStartDate) {
      continue;
    }
    out.push({
      monthLabel,
      monthStartDate,
      typicalAllInNightly: Math.max(0, Math.round(nightly)),
    });
  }

  return out;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asBedCount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.floor(parsed));
    }
  }
  return 0;
}

function normalizeTextForPolicy(value: string): string {
  return value
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function includesToken(tokens: Set<string>, value: string): boolean {
  return tokens.has(
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, ""),
  );
}

export function toDiscoverSearchDocument(
  listing: DiscoverListing,
): DiscoverSearchDocument {
  const area = listing.area.trim();
  const beach = listing.beach.trim();
  const community = listing.community.trim();

  const areaCode =
    toAreaCodeFromLabel(area) ?? (area.length > 0 ? normalizeCode(area) : "");
  const beachCode =
    toBeachAreaCodeFromLabel(beach) ??
    (beach.length > 0 ? normalizeCode(beach) : "");
  const communityCode =
    toCommunityCodeFromLabel(community) ??
    (community.length > 0 ? normalizeCode(community) : "");

  const previewImages = Array.isArray(listing.previewImages)
    ? listing.previewImages.slice(0, 20)
    : [];

  const amenities = Array.isArray(listing.amenitiesList)
    ? listing.amenitiesList
    : [];
  const normalizedAmenityTokens = new Set(
    amenities
      .map((entry) =>
        entry
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_+|_+$/g, ""),
      )
      .filter(Boolean),
  );

  const textBlob = normalizeTextForPolicy(
    [
      listing.name,
      listing.descriptionHeadline,
      listing.descriptionMarkdown,
      listing.description,
      ...(listing.highlightsList ?? []),
      ...(listing.helpfulHints ?? []),
      ...amenities,
    ]
      .filter((value): value is string => typeof value === "string")
      .join(" "),
  );

  const hasNoPets = /\bno\s+pets?\b|\bpets?\s+not\s+allowed\b/.test(textBlob);
  const petFriendly =
    !hasNoPets &&
    (includesToken(normalizedAmenityTokens, "pet_friendly") ||
      /\bpet\s+friendly\b|\bpets?\s+allowed\b|\bdog\s+friendly\b/.test(
        textBlob,
      ));

  const accessible =
    includesToken(normalizedAmenityTokens, "accessible") ||
    includesToken(normalizedAmenityTokens, "wheelchair_accessible") ||
    /\bwheelchair\s+accessible\b|\baccessible\b|\bstep\s*free\b|\bmobility\b/.test(
      textBlob,
    );

  const hasNoElevator =
    /\bno\s+elevators?\b|\bdoes\s+not\s+have\s+elevators?\b|\bno\s+elevator\b/.test(
      textBlob,
    );
  const elevator =
    !hasNoElevator &&
    (includesToken(normalizedAmenityTokens, "elevator") ||
      includesToken(normalizedAmenityTokens, "lift") ||
      /\belevator\b|\blift\b/.test(textBlob));

  const bedCounts = listing.sleepingSummary?.bed_counts;
  const kingBedCount = asBedCount(bedCounts?.king);
  const queenBedCount = asBedCount(bedCounts?.queen);
  const bunkBedCount = asBedCount(bedCounts?.bunk_beds);
  const availabilityFields = buildAvailabilityFields(listing);

  return {
    id: listing.id,
    name: listing.name,
    // Keep *_name aligned to source-table semantics (code-driven values).
    area_name: areaCode || null,
    beach_area_name: beachCode || null,
    community_name: communityCode || null,
    area,
    beach,
    community,
    lat: typeof listing.lat === "number" ? listing.lat : null,
    lng: typeof listing.lng === "number" ? listing.lng : null,
    bedrooms: Math.max(0, Math.round(listing.bedrooms)),
    bathrooms: Math.max(0, listing.bathrooms),
    sleeps: Math.max(0, Math.round(listing.sleeps)),
    private_pool: Boolean(listing.privatePool),
    gulf_front: Boolean(listing.gulffront),
    golf_cart: Boolean(listing.golfCart),
    pet_friendly: petFriendly,
    accessible,
    elevator,
    king_bed_count: kingBedCount,
    queen_bed_count: queenBedCount,
    bunk_bed_count: bunkBedCount,
    preview_images: previewImages,
    // Optional MS-only convenience field for Admin UI cards.
    poster: previewImages[0] ?? null,
    images: Array.isArray(listing.images)
      ? listing.images.slice(0, 120)
      : Array.isArray(listing.imageGallery)
        ? listing.imageGallery.slice(0, 120)
        : [],
    image_count: Math.max(
      0,
      Math.round(
        typeof listing.imageCount === "number"
          ? listing.imageCount
          : Array.isArray(listing.images)
            ? listing.images.length
            : Array.isArray(listing.imageGallery)
              ? listing.imageGallery.length
              : previewImages.length,
      ),
    ),
    description_headline: listing.descriptionHeadline ?? null,
    description_markdown: listing.descriptionMarkdown ?? null,
    description_plain: listing.description ?? null,
    highlights_list: Array.isArray(listing.highlightsList)
      ? listing.highlightsList
      : [],
    helpful_hints: Array.isArray(listing.helpfulHints)
      ? listing.helpfulHints
      : [],
    sleeping_arrangements: Array.isArray(listing.sleepingArrangements)
      ? listing.sleepingArrangements
      : [],
    amenities_list: Array.isArray(listing.amenitiesList)
      ? listing.amenitiesList
      : [],
    seo_meta_title: listing.seoMetaTitle ?? null,
    seo_meta_description: listing.seoMetaDescription ?? null,
    seo_hidden_summary_plain: listing.seoHiddenSummaryPlain ?? null,
    status_code_string: listing.statusCodeString ?? null,
    upcoming_typical_pricing_months: Array.isArray(
      listing.upcomingTypicalPricingMonths,
    )
      ? listing.upcomingTypicalPricingMonths.slice(0, 6).map((entry) => ({
          monthLabel: entry.monthLabel,
          monthStartDate: entry.monthStartDate,
          typicalAllInNightly: Math.max(
            0,
            Math.round(entry.typicalAllInNightly),
          ),
        }))
      : [],
    typical_pricing_month: listing.typicalPricingMonth,
    typical_base_nightly: Math.max(0, listing.typicalBaseNightly),
    typical_all_in_nightly: Math.max(0, listing.typicalAllInNightly),
    ...availabilityFields,
  };
}

export function discoverSearchDocumentToListing(
  document: Partial<DiscoverSearchDocument>,
): DiscoverListing {
  const areaCode = asString(document.area_name);
  const beachCode = asString(document.beach_area_name);
  const communityCode = asString(document.community_name);

  const areaName = asString(document.area);
  const beachName = asString(document.beach);
  const communityName = asString(document.community);

  const resolvedArea = areaLabelFromCode(areaCode) ?? areaName;
  const resolvedBeach = beachAreaLabelFromCode(beachCode) ?? beachName;
  const resolvedCommunity =
    communityLabelFromCode(communityCode) ?? communityName;

  return {
    id: asString(document.id),
    name: asString(document.name),
    area: resolvedArea,
    beach: resolvedBeach,
    community: resolvedCommunity,
    lat: asNullableNumber(document.lat),
    lng: asNullableNumber(document.lng),
    bedrooms: Math.max(0, Math.round(asNumberOrZero(document.bedrooms))),
    bathrooms: Math.max(0, asNumberOrZero(document.bathrooms)),
    sleeps: Math.max(0, Math.round(asNumberOrZero(document.sleeps))),
    privatePool: asBoolean(document.private_pool),
    gulffront: asBoolean(document.gulf_front),
    golfCart: asBoolean(document.golf_cart),
    petFriendly: asBoolean(document.pet_friendly),
    accessible: asBoolean(document.accessible),
    elevator: asBoolean(document.elevator),
    previewImages: asStringArray(document.preview_images),
    images: asImageArray(document.images),
    imageGallery: asImageArray(document.images),
    imageCount: Math.max(0, Math.round(asNumberOrZero(document.image_count))),
    descriptionHeadline: asString(document.description_headline) || undefined,
    descriptionMarkdown: asString(document.description_markdown) || undefined,
    description: asString(document.description_plain) || undefined,
    highlightsList: asStringArray(document.highlights_list),
    helpfulHints: asStringArray(document.helpful_hints),
    sleepingArrangements: asStringArray(document.sleeping_arrangements),
    amenitiesList: asStringArray(document.amenities_list),
    seoMetaTitle: asString(document.seo_meta_title) || undefined,
    seoMetaDescription: asString(document.seo_meta_description) || undefined,
    seoHiddenSummaryPlain:
      asString(document.seo_hidden_summary_plain) || undefined,
    statusCodeString: asString(document.status_code_string) || undefined,
    upcomingTypicalPricingMonths: asUpcomingPricingMonths(
      document.upcoming_typical_pricing_months,
    ),
    typicalPricingMonth: asString(document.typical_pricing_month),
    typicalBaseNightly: Math.max(
      0,
      asNumberOrZero(document.typical_base_nightly),
    ),
    typicalAllInNightly: Math.max(
      0,
      asNumberOrZero(document.typical_all_in_nightly),
    ),
    sleepingSummary: {
      bed_counts: {
        king: asBedCount(document.king_bed_count),
        queen: asBedCount(document.queen_bed_count),
        bunk_beds: asBedCount(document.bunk_bed_count),
      },
    },
  };
}
