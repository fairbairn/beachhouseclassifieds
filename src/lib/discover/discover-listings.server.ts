import {
  sampleListings,
  type DiscoverListing,
} from "@/components/discover/discover-data";
import { pgDb } from "@/core/server/db";
import {
  listing,
  listing_pricing_summary,
  listing_source_link,
  listing_source_pricing,
  site,
} from "@/lib/db/schema-postgres";
import { getDiscoverDemoListings } from "@/lib/discover/discover-demo-listings.server";
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
} from "drizzle-orm";

const TARGET_LISTING_COUNT = 96;
const DISCOVER_SITE_SLUG = "30acollections";
const DISCOVER_PRICING_SUMMARY_METHOD = "monthly_forward_avg_v1";

let cachedDiscoverSiteId: string | null | undefined;

async function resolveDiscoverSiteId(): Promise<string | null> {
  if (cachedDiscoverSiteId !== undefined) {
    return cachedDiscoverSiteId;
  }

  if (!pgDb) {
    cachedDiscoverSiteId = null;
    return cachedDiscoverSiteId;
  }

  const rows = await pgDb
    .select({ id: site.id })
    .from(site)
    .where(eq(site.slug, DISCOVER_SITE_SLUG))
    .limit(1);

  cachedDiscoverSiteId = rows[0]?.id ?? null;
  return cachedDiscoverSiteId;
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asNumber(value: unknown): number | null {
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

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(value);
  }
  return out;
}

function normalizeForPolicyCheck(value: string): {
  normalized: string;
  compact: string;
} {
  const normalized = value
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return {
    normalized,
    compact: normalized.replace(/\s+/g, ""),
  };
}

const DISALLOWED_AI_COPY_TOKENS = [
  "30a escapes",
  "30aescapes",
  "30a collections",
  "property management",
  "management company",
  "book direct",
  "book with",
  "contact us",
  "call us",
  "visit our",
];

function containsDisallowedAiCopyToken(value: string): boolean {
  const { normalized, compact } = normalizeForPolicyCheck(value);
  if (!normalized) {
    return false;
  }

  return DISALLOWED_AI_COPY_TOKENS.some((token) => {
    const { normalized: tokenNormalized, compact: tokenCompact } =
      normalizeForPolicyCheck(token);
    if (!tokenNormalized) {
      return false;
    }
    return (
      normalized.includes(tokenNormalized) ||
      (tokenCompact.length > 0 && compact.includes(tokenCompact))
    );
  });
}

function sanitizeAiCopyList(values: string[], maxItems: number): string[] {
  return unique(values.filter((entry) => !containsDisallowedAiCopyToken(entry)))
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, maxItems);
}

function ensureTerminalPeriod(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (/[.!?]$/.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed}.`;
}

function normalizeHintTone(value: string): string {
  return value
    .replace(/\bDO NOT\b/g, "do not")
    .replace(/\bNOT\b/g, "not")
    .replace(/\bMUST\b/g, "must")
    .replace(/\bREQUIRED\b/g, "required")
    .replace(/\bIS NOT\b/g, "is not")
    .replace(/\bARE NOT\b/g, "are not")
    .replace(/\bCAN NOT\b/g, "cannot")
    .replace(/\s+/g, " ")
    .trim();
}

function readTraitFlag(traitsRaw: unknown, traitKey: string): boolean {
  if (!Array.isArray(traitsRaw)) {
    return false;
  }

  for (const traitEntry of traitsRaw) {
    const trait = asObject(traitEntry);
    if (asString(trait.key) !== traitKey) {
      continue;
    }

    if (trait.value_type === "boolean" && trait.value_boolean === true) {
      return true;
    }
  }

  return false;
}

function buildSleepingArrangementLines(raw: {
  arrangements: unknown;
  summary: unknown;
}): string[] {
  const lines: string[] = [];

  if (Array.isArray(raw.arrangements)) {
    for (const roomEntry of raw.arrangements) {
      const room = asObject(roomEntry);
      const roomLabel = asString(room.room_label);
      const beds = Array.isArray(room.beds) ? room.beds : [];
      const bedParts: string[] = [];

      for (const bedEntry of beds) {
        const bed = asObject(bedEntry);
        const count = Math.max(0, Math.round(asNumber(bed.count) ?? 0));
        const bedType = asString(bed.bed_type).replace(/_/g, " ");
        if (count < 1 || !bedType) {
          continue;
        }
        bedParts.push(`${count} ${bedType}`);
      }

      if (bedParts.length > 0) {
        lines.push(`${roomLabel || "Sleeping Area"}: ${bedParts.join(", ")}`);
      }
    }
  }

  if (lines.length > 0) {
    return lines.slice(0, 10);
  }

  const summary = asObject(raw.summary);
  const bedCounts = asObject(summary.bed_counts);
  const fallbackLines = [
    asNumber(bedCounts.king)
      ? `${Math.round(asNumber(bedCounts.king) ?? 0)} king`
      : "",
    asNumber(bedCounts.queen)
      ? `${Math.round(asNumber(bedCounts.queen) ?? 0)} queen`
      : "",
    asNumber(bedCounts.full)
      ? `${Math.round(asNumber(bedCounts.full) ?? 0)} full`
      : "",
    asNumber(bedCounts.twin_standalone)
      ? `${Math.round(asNumber(bedCounts.twin_standalone) ?? 0)} twin`
      : "",
    asNumber(bedCounts.bunk_beds)
      ? `${Math.round(asNumber(bedCounts.bunk_beds) ?? 0)} bunk beds`
      : "",
  ]
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => entry[0].toUpperCase() + entry.slice(1));

  return fallbackLines.slice(0, 10);
}

function toIsoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function buildNextMonthStartDate(): Date {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const nextMonthStart = new Date(now);
  nextMonthStart.setDate(1);
  nextMonthStart.setMonth(nextMonthStart.getMonth() + 1);
  return nextMonthStart;
}

function buildMonthStartDateList(input: {
  startDate: Date;
  count: number;
}): Date[] {
  return Array.from({ length: input.count }, (_, index) => {
    const monthStart = new Date(input.startDate);
    monthStart.setMonth(monthStart.getMonth() + index);
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    return monthStart;
  });
}

type SourcePricingContext = {
  typicalPricingMonth: string;
  typicalBaseNightly: number;
  typicalAllInNightly: number;
  upcomingTypicalPricingMonths: Array<{
    monthLabel: string;
    monthStartDate: string;
    typicalAllInNightly: number;
  }>;
  availabilityCalendarStatus: Record<
    string,
    {
      dayType: "available" | "checkin_only" | "checkout_only" | "unavailable";
      isNightAvailable: boolean;
      isCheckInAllowed: boolean;
      isCheckOutAllowed: boolean;
      minNights: number | null;
      allInNightly: number | null;
      statusConfidence: "observed" | "derived";
    }
  >;
};

function dayTypeFromAvailabilityStatusCode(
  code: "A" | "U" | "I" | "O" | "X",
): "available" | "checkin_only" | "checkout_only" | "unavailable" {
  if (code === "A") {
    return "available";
  }
  if (code === "I") {
    return "checkin_only";
  }
  if (code === "O") {
    return "checkout_only";
  }
  return "unavailable";
}

function deriveCalendarDayType(input: {
  isNightAvailable: boolean;
  isCheckInAllowed: boolean;
  isCheckOutAllowed: boolean;
}): "available" | "checkin_only" | "checkout_only" | "unavailable" {
  if (!input.isNightAvailable && !input.isCheckOutAllowed) {
    return "unavailable";
  }
  if (!input.isNightAvailable && input.isCheckOutAllowed) {
    return "checkout_only";
  }
  if (input.isCheckInAllowed && input.isCheckOutAllowed) {
    return "available";
  }
  if (input.isCheckInAllowed) {
    return "checkin_only";
  }
  if (input.isCheckOutAllowed) {
    return "checkout_only";
  }
  return "unavailable";
}

async function loadPricingContextByListingSlug(input: {
  listingRows: Array<{
    slug: string;
    listing_id: string;
    listing_number: number;
  }>;
}): Promise<Map<string, SourcePricingContext>> {
  const out = new Map<string, SourcePricingContext>();

  if (!pgDb || input.listingRows.length === 0) {
    return out;
  }

  const listingIds = input.listingRows.map((row) => row.listing_id);
  const sourceLinkRows = await pgDb
    .select({
      id: listing_source_link.id,
      listing_id: listing_source_link.listing_id,
      is_primary_source: listing_source_link.is_primary_source,
    })
    .from(listing_source_link)
    .where(
      and(
        inArray(listing_source_link.listing_id, listingIds),
        eq(listing_source_link.source_status, "active"),
        isNull(listing_source_link.active_to),
      ),
    );

  const sourceLinkIdByListingId = new Map<string, string>();
  for (const row of sourceLinkRows) {
    if (!sourceLinkIdByListingId.has(row.listing_id) || row.is_primary_source) {
      sourceLinkIdByListingId.set(row.listing_id, row.id);
    }
  }

  const pickedSourceLinkIds = Array.from(
    new Set(sourceLinkIdByListingId.values()),
  );
  if (pickedSourceLinkIds.length === 0) {
    return out;
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const horizonEnd = new Date(today);
  horizonEnd.setDate(horizonEnd.getDate() + 330);
  const nextMonthStartDate = buildNextMonthStartDate();
  const monthStartDates = buildMonthStartDateList({
    startDate: nextMonthStartDate,
    count: 3,
  });
  const monthStartDateIsoList = monthStartDates.map((value) =>
    toIsoDate(value),
  );
  const targetMonthStartDateIso =
    monthStartDateIsoList[0] ?? toIsoDate(nextMonthStartDate);

  const summaryRows = await pgDb
    .select({
      listing_id: listing_pricing_summary.listing_id,
      month_start_date: listing_pricing_summary.month_start_date,
      recommended_all_in_nightly:
        listing_pricing_summary.recommended_all_in_nightly,
      computed_at: listing_pricing_summary.computed_at,
      anchor_date: listing_pricing_summary.anchor_date,
    })
    .from(listing_pricing_summary)
    .where(
      and(
        inArray(listing_pricing_summary.listing_id, listingIds),
        eq(listing_pricing_summary.nights, 7),
        eq(listing_pricing_summary.method, DISCOVER_PRICING_SUMMARY_METHOD),
        inArray(
          listing_pricing_summary.month_start_date,
          monthStartDateIsoList,
        ),
      ),
    )
    .orderBy(
      listing_pricing_summary.listing_id,
      listing_pricing_summary.month_start_date,
      desc(listing_pricing_summary.computed_at),
      desc(listing_pricing_summary.anchor_date),
    );

  const summaryNightlyByListingId = new Map<string, Map<string, number>>();
  for (const row of summaryRows) {
    const nightly = asNumber(row.recommended_all_in_nightly);
    if (nightly === null) {
      continue;
    }

    const listingSummary =
      summaryNightlyByListingId.get(row.listing_id) ??
      new Map<string, number>();
    if (!listingSummary.has(row.month_start_date)) {
      listingSummary.set(row.month_start_date, nightly);
    }
    summaryNightlyByListingId.set(row.listing_id, listingSummary);
  }

  const pricingRows = await pgDb
    .select({
      source_link_id: listing_source_pricing.source_link_id,
      stay_date: listing_source_pricing.stay_date,
      is_available: listing_source_pricing.is_available,
      availability_status_code: listing_source_pricing.availability_status_code,
      is_available_for_checkin: listing_source_pricing.is_available_for_checkin,
      is_available_for_checkout:
        listing_source_pricing.is_available_for_checkout,
      min_nights: listing_source_pricing.min_nights,
      base_nightly: listing_source_pricing.base_nightly,
      all_in_nightly: listing_source_pricing.all_in_nightly,
    })
    .from(listing_source_pricing)
    .where(
      and(
        inArray(listing_source_pricing.source_link_id, pickedSourceLinkIds),
        gte(listing_source_pricing.stay_date, toIsoDate(today)),
        lte(listing_source_pricing.stay_date, toIsoDate(horizonEnd)),
      ),
    );

  const pricingBySourceLinkId = new Map<
    string,
    Array<{
      stay_date: string;
      is_available: boolean;
      availability_status_code: string | null;
      is_available_for_checkin: boolean | null;
      is_available_for_checkout: boolean | null;
      min_nights: number | null;
      base_nightly: string | null;
      all_in_nightly: string;
    }>
  >();

  for (const row of pricingRows) {
    const entries = pricingBySourceLinkId.get(row.source_link_id) ?? [];
    entries.push({
      stay_date: row.stay_date,
      is_available: row.is_available,
      availability_status_code: row.availability_status_code,
      is_available_for_checkin: row.is_available_for_checkin,
      is_available_for_checkout: row.is_available_for_checkout,
      min_nights: row.min_nights,
      base_nightly: row.base_nightly,
      all_in_nightly: row.all_in_nightly,
    });
    pricingBySourceLinkId.set(row.source_link_id, entries);
  }

  for (const listingRow of input.listingRows) {
    const sourceLinkId = sourceLinkIdByListingId.get(listingRow.listing_id);
    if (!sourceLinkId) {
      continue;
    }

    const entries = (pricingBySourceLinkId.get(sourceLinkId) ?? []).sort(
      (a, b) => a.stay_date.localeCompare(b.stay_date),
    );
    if (entries.length === 0) {
      continue;
    }

    const availabilityCalendarStatus: Record<
      string,
      {
        dayType: "available" | "checkin_only" | "checkout_only" | "unavailable";
        isNightAvailable: boolean;
        isCheckInAllowed: boolean;
        isCheckOutAllowed: boolean;
        minNights: number | null;
        allInNightly: number | null;
        statusConfidence: "observed" | "derived";
      }
    > = {};
    for (const [index, entry] of entries.entries()) {
      const allIn = asNumber(entry.all_in_nightly);

      const availabilityStatusCode =
        entry.availability_status_code === "A" ||
        entry.availability_status_code === "U" ||
        entry.availability_status_code === "I" ||
        entry.availability_status_code === "O" ||
        entry.availability_status_code === "X"
          ? entry.availability_status_code
          : null;

      const hasObservedAvailabilitySignals =
        availabilityStatusCode !== null ||
        typeof entry.is_available_for_checkin === "boolean" ||
        typeof entry.is_available_for_checkout === "boolean";

      const minNights = Math.max(1, entry.min_nights ?? 1);
      let contiguousAvailableNights = 0;
      for (let cursor = index; cursor < entries.length; cursor += 1) {
        if (!entries[cursor]?.is_available) {
          break;
        }
        contiguousAvailableNights += 1;
      }

      const isNightAvailable = entry.is_available;
      const derivedIsCheckInAllowed =
        isNightAvailable && contiguousAvailableNights >= minNights;
      const derivedIsCheckOutAllowed =
        (entries[index - 1]?.is_available ?? false) === true;

      const isCheckInAllowed =
        entry.is_available_for_checkin ??
        (availabilityStatusCode === "A" || availabilityStatusCode === "I"
          ? true
          : availabilityStatusCode === "U" || availabilityStatusCode === "O"
            ? false
            : derivedIsCheckInAllowed);

      const isCheckOutAllowed =
        entry.is_available_for_checkout ??
        (availabilityStatusCode === "A" || availabilityStatusCode === "O"
          ? true
          : availabilityStatusCode === "U" || availabilityStatusCode === "I"
            ? false
            : derivedIsCheckOutAllowed);

      availabilityCalendarStatus[entry.stay_date] = {
        dayType:
          availabilityStatusCode !== null
            ? dayTypeFromAvailabilityStatusCode(availabilityStatusCode)
            : deriveCalendarDayType({
                isNightAvailable,
                isCheckInAllowed,
                isCheckOutAllowed,
              }),
        isNightAvailable,
        isCheckInAllowed,
        isCheckOutAllowed,
        minNights: entry.min_nights,
        allInNightly:
          isNightAvailable && allIn !== null
            ? Math.max(1, Math.round(allIn))
            : null,
        statusConfidence: hasObservedAvailabilitySignals
          ? "observed"
          : "derived",
      };
    }

    const summaryByMonth =
      summaryNightlyByListingId.get(listingRow.listing_id) ??
      new Map<string, number>();

    const monthFallbackAverages = new Map<string, number>();
    for (const monthStartIso of monthStartDateIsoList) {
      const values = entries
        .filter((entry) =>
          entry.stay_date.startsWith(monthStartIso.slice(0, 7)),
        )
        .map((entry) => asNumber(entry.all_in_nightly))
        .filter((value): value is number => value !== null);
      if (values.length === 0) {
        continue;
      }
      const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
      monthFallbackAverages.set(monthStartIso, avg);
    }

    const upcomingTypicalPricingMonths = monthStartDateIsoList
      .map((monthStartIso, index) => {
        const monthlyNightly =
          summaryByMonth.get(monthStartIso) ??
          monthFallbackAverages.get(monthStartIso);
        if (monthlyNightly === undefined) {
          return null;
        }

        const monthDate = monthStartDates[index] ?? nextMonthStartDate;
        return {
          monthLabel: monthDate.toLocaleString("en-US", { month: "long" }),
          monthStartDate: monthStartIso,
          typicalAllInNightly: Math.max(1, Math.round(monthlyNightly)),
        };
      })
      .filter(
        (
          value,
        ): value is {
          monthLabel: string;
          monthStartDate: string;
          typicalAllInNightly: number;
        } => value !== null,
      );

    const primaryMonthNightly =
      summaryByMonth.get(targetMonthStartDateIso) ??
      monthFallbackAverages.get(targetMonthStartDateIso);

    if (primaryMonthNightly !== undefined) {
      out.set(listingRow.slug, {
        typicalPricingMonth: nextMonthStartDate.toLocaleString("en-US", {
          month: "long",
        }),
        typicalBaseNightly: Math.max(1, Math.round(primaryMonthNightly * 0.88)),
        typicalAllInNightly: Math.max(1, Math.round(primaryMonthNightly)),
        upcomingTypicalPricingMonths,
        availabilityCalendarStatus,
      });
      continue;
    }

    const allInValues = entries
      .filter((entry) =>
        entry.stay_date.startsWith(targetMonthStartDateIso.slice(0, 7)),
      )
      .map((entry) => asNumber(entry.all_in_nightly))
      .filter((value): value is number => value !== null);
    const baseValues = entries
      .filter((entry) =>
        entry.stay_date.startsWith(targetMonthStartDateIso.slice(0, 7)),
      )
      .map((entry) => asNumber(entry.base_nightly))
      .filter((value): value is number => value !== null);

    const typicalAllIn =
      allInValues.length > 0
        ? allInValues.reduce((sum, value) => sum + value, 0) /
          allInValues.length
        : null;
    if (typicalAllIn === null) {
      continue;
    }

    const typicalBase =
      baseValues.length > 0
        ? baseValues.reduce((sum, value) => sum + value, 0) / baseValues.length
        : Math.ceil(typicalAllIn * 0.88);

    out.set(listingRow.slug, {
      typicalPricingMonth: nextMonthStartDate.toLocaleString("en-US", {
        month: "long",
      }),
      typicalBaseNightly: Math.max(1, Math.round(typicalBase)),
      typicalAllInNightly: Math.max(1, Math.round(typicalAllIn)),
      upcomingTypicalPricingMonths,
      availabilityCalendarStatus,
    });
  }

  return out;
}

function extractImageGalleryFromListingImages(
  imagesRaw: unknown,
): Array<{ name: string; url: string }> {
  if (!Array.isArray(imagesRaw)) {
    return [];
  }

  const bySortOrder = [...imagesRaw]
    .map((entry) => {
      const image = asObject(entry);
      const src = asString(image.src);
      const sortOrder = asNumber(image.sort_order);
      const caption = asString(image.caption);
      const name = asString(image.name);
      return {
        src,
        sortOrder: sortOrder ?? Number.MAX_SAFE_INTEGER,
        label: caption || name,
      };
    })
    .filter((entry) => entry.src.length > 0)
    .sort((a, b) => a.sortOrder - b.sortOrder);

  const gallery: Array<{ name: string; url: string }> = [];
  const seen = new Set<string>();

  for (const image of bySortOrder) {
    const key = image.src.trim().toLowerCase();
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    gallery.push({
      name: image.label || `Photo ${gallery.length + 1}`,
      url: image.src,
    });
  }

  return gallery;
}

async function loadFromListingTable(input?: {
  includeSlug?: string;
  onlySlug?: boolean;
}): Promise<DiscoverListing[]> {
  if (!pgDb) {
    return [];
  }

  const discoverSiteId = await resolveDiscoverSiteId();
  if (!discoverSiteId) {
    return [];
  }

  const selectFields = {
    id: listing.id,
    slug: listing.slug,
    canonical_name: listing.canonical_name,
    listing_number: listing.listing_number,
    bedrooms: listing.bedrooms,
    bathrooms: listing.bathrooms,
    sleeps: listing.sleeps,
    lat: listing.lat,
    lng: listing.lng,
    city: listing.city,
    area: listing.area,
    area_name: listing.area_name,
    beach_area_name: listing.beach_area_name,
    community_name: listing.community_name,
    is_gulf_front: listing.is_gulf_front,
    description_headline_plain: listing.description_headline_plain,
    description_short_plain: listing.description_short_plain,
    description_markdown: listing.description_markdown,
    highlights: listing.highlights,
    helpful_hints: listing.helpful_hints,
    sleeping_arrangements: listing.sleeping_arrangements,
    sleeping_summary: listing.sleeping_summary,
    amenities_normalized: listing.amenities_normalized,
    traits: listing.traits,
    images: listing.images,
  } as const;

  const includeSlug = input?.includeSlug?.trim();
  const onlySlug = Boolean(input?.onlySlug && includeSlug);

  const rows = onlySlug
    ? await pgDb
        .select({
          ...selectFields,
        })
        .from(listing)
        .where(
          and(
            eq(listing.site_id, discoverSiteId),
            eq(listing.status, "active"),
            or(eq(listing.state, "FL"), isNull(listing.state)),
            isNotNull(listing.area_name),
            eq(listing.slug, includeSlug as string),
          ),
        )
        .limit(1)
    : await pgDb
        .select({
          ...selectFields,
        })
        .from(listing)
        .where(
          and(
            eq(listing.site_id, discoverSiteId),
            eq(listing.status, "active"),
            or(eq(listing.state, "FL"), isNull(listing.state)),
            isNotNull(listing.area_name),
          ),
        )
        .limit(TARGET_LISTING_COUNT);

  const hasIncluded = Boolean(
    includeSlug && rows.some((row) => row.slug === includeSlug),
  );

  if (!onlySlug && includeSlug && !hasIncluded) {
    const includeRows = await pgDb
      .select({
        ...selectFields,
      })
      .from(listing)
      .where(
        and(
          eq(listing.site_id, discoverSiteId),
          eq(listing.status, "active"),
          or(eq(listing.state, "FL"), isNull(listing.state)),
          isNotNull(listing.area_name),
          eq(listing.slug, includeSlug),
        ),
      )
      .limit(1);

    if (includeRows.length > 0) {
      rows.push(includeRows[0]);
    }
  }

  const previewSeeds = sampleListings.length > 0 ? sampleListings : [];

  const pricingContextBySlug = await loadPricingContextByListingSlug({
    listingRows: rows.map((row) => ({
      slug: row.slug,
      listing_id: row.id,
      listing_number: row.listing_number ?? 0,
    })),
  });

  const mappedRows = rows.map((row, index) => {
    const amenities = asStringArray(row.amenities_normalized);
    const traits = row.traits;
    const sleeps = Math.max(1, Math.round(row.sleeps ?? 0) || 6);
    const bedrooms = Math.max(1, Math.round(row.bedrooms ?? 0) || 3);
    const bathroomNumber = asNumber(row.bathrooms);
    const bathrooms =
      bathroomNumber !== null
        ? Math.max(1, Math.round(bathroomNumber * 2) / 2)
        : Math.max(1, bedrooms - 0.5);

    const summary = asObject(row.sleeping_summary);
    const bedCounts = asObject(summary.bed_counts);
    const kingBeds = Math.max(0, Math.round(asNumber(bedCounts.king) ?? 0));
    const queenBeds = Math.max(0, Math.round(asNumber(bedCounts.queen) ?? 0));

    const area =
      asString(row.beach_area_name) ||
      asString(row.area_name) ||
      asString(row.city) ||
      asString(row.area) ||
      "30A";
    const community = asString(row.community_name) || area;

    const imageGalleryFromListing = extractImageGalleryFromListingImages(
      row.images,
    );
    const imageUrlsFromListing = imageGalleryFromListing.map(
      (image) => image.url,
    );
    const previewFromListing = imageUrlsFromListing.slice(0, 5);
    const imageCountFromListing = imageUrlsFromListing.length;
    const preview =
      previewFromListing.length > 0
        ? previewFromListing
        : previewSeeds.length > 0
          ? (previewSeeds[index % previewSeeds.length]?.previewImages ?? [])
          : [];

    const description = asString(row.description_markdown);
    const descriptionHeadline =
      asString(row.description_headline_plain) ||
      asString(row.description_short_plain);
    const highlightsList = sanitizeAiCopyList(asStringArray(row.highlights), 10)
      .map((entry) => ensureTerminalPeriod(entry))
      .filter(Boolean);
    const helpfulHints = sanitizeAiCopyList(asStringArray(row.helpful_hints), 8)
      .map((entry) => normalizeHintTone(entry))
      .map((entry) => ensureTerminalPeriod(entry))
      .filter(Boolean);
    const sourcePricing = pricingContextBySlug.get(row.slug);
    if (
      !sourcePricing ||
      Object.keys(sourcePricing.availabilityCalendarStatus).length === 0
    ) {
      return null;
    }

    return {
      id: row.slug,
      name: row.canonical_name,
      demoOrder: row.listing_number ?? index + 1,
      area,
      community,
      lat: row.lat ?? undefined,
      lng: row.lng ?? undefined,
      bedrooms,
      bathrooms,
      sleeps,
      kingBeds,
      queenBeds,
      privatePool:
        amenities.includes("private_pool") ||
        readTraitFlag(traits, "feature.private_pool"),
      beachfront:
        Boolean(row.is_gulf_front) ||
        amenities.includes("gulf_front") ||
        amenities.includes("beachfront"),
      gulfView:
        amenities.includes("gulf_front") ||
        amenities.includes("beachfront") ||
        amenities.includes("water_view"),
      golfCart:
        amenities.includes("golf_cart") ||
        readTraitFlag(traits, "feature.golf_cart"),
      petsAllowed:
        amenities.includes("pet_friendly") ||
        readTraitFlag(traits, "feature.pets_allowed"),
      accessible:
        readTraitFlag(traits, "feature.accessible") ||
        amenities.includes("accessible"),
      elevator:
        amenities.includes("elevator") ||
        readTraitFlag(traits, "feature.elevator"),
      previewImages: preview,
      imageCount:
        imageCountFromListing > 0 ? imageCountFromListing : preview.length,
      imageGallery:
        imageGalleryFromListing.length > 0
          ? imageGalleryFromListing
          : preview.map((url, imageIndex) => ({
              name: `Photo ${imageIndex + 1}`,
              url,
            })),
      typicalPricingMonth: sourcePricing.typicalPricingMonth,
      typicalBaseNightly: sourcePricing.typicalBaseNightly,
      typicalAllInNightly: sourcePricing.typicalAllInNightly,
      upcomingTypicalPricingMonths: sourcePricing.upcomingTypicalPricingMonths,
      descriptionHeadline: descriptionHeadline || undefined,
      descriptionMarkdown: description || undefined,
      description: description || undefined,
      highlightsList,
      helpfulHints,
      sleepingArrangements: buildSleepingArrangementLines({
        arrangements: row.sleeping_arrangements,
        summary: row.sleeping_summary,
      }),
      amenitiesList: amenities,
      availabilityCalendarStatus: sourcePricing.availabilityCalendarStatus,
      sleepingSummary: summary,
    };
  });

  return mappedRows.filter((row): row is DiscoverListing => row !== null);
}

export async function getDiscoverListings(input?: {
  includeSlug?: string;
  onlySlug?: boolean;
  disableFallback?: boolean;
}): Promise<DiscoverListing[]> {
  const fromListingTable = await loadFromListingTable(input).catch(() => []);
  if (fromListingTable.length > 0) {
    return fromListingTable;
  }

  if (input?.disableFallback) {
    return [];
  }

  const fromDemo = await getDiscoverDemoListings().catch(() => []);
  if (fromDemo.length > 0) {
    return fromDemo;
  }

  return sampleListings;
}
