import {
  sampleListings,
  type DiscoverListing,
} from "@/components/discover/discover-data";
import { pgDb } from "@/core/server/db";
import { listing, site } from "@/lib/db/schema-postgres";
import { getDiscoverDemoListings } from "@/lib/discover/discover-demo-listings.server";
import { and, eq, isNotNull } from "drizzle-orm";

const TARGET_LISTING_COUNT = 96;
const DISCOVER_SITE_SLUG = "30acollections";

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

function derivePricing(
  listingNumber: number,
  sleeps: number,
): {
  typicalBaseNightly: number;
  typicalAllInNightly: number;
  typicalPrice: string;
  typicalPricingMonth: string;
} {
  const seed = Math.abs(listingNumber) % 500;
  const allInNightly = Math.max(325, 350 + seed + sleeps * 22);
  const baseNightly = Math.ceil(allInNightly * 0.88);
  const lowWeekly = (allInNightly * 7) / 1000;
  const highWeekly = (allInNightly * 7 * 1.2) / 1000;
  const month45 = new Date();
  month45.setDate(month45.getDate() + 45);

  return {
    typicalBaseNightly: baseNightly,
    typicalAllInNightly: allInNightly,
    typicalPrice: `$${lowWeekly.toFixed(1)}k - $${highWeekly.toFixed(1)}k`,
    typicalPricingMonth: month45.toLocaleString("en-US", {
      month: "long",
    }),
  };
}

function buildAvailabilityCalendar(input: {
  nightlyBase: number;
  listingSeed: number;
}): Record<string, number> {
  const out: Record<string, number> = {};
  const seed = Math.abs(input.listingSeed % 17);
  const start = new Date();
  start.setHours(0, 0, 0, 0);

  for (let offset = 0; offset < 330; offset += 1) {
    const day = new Date(start);
    day.setDate(start.getDate() + offset);
    const iso = day.toISOString().slice(0, 10);

    // Keep occasional gaps to mimic unavailable nights.
    if ((offset + seed) % 19 === 0) {
      continue;
    }

    const dayOfWeek = day.getDay();
    const weekendMultiplier = dayOfWeek === 5 || dayOfWeek === 6 ? 1.18 : 1;
    const seasonalMultiplier = 1 + ((offset % 29) - 14) * 0.004;
    const computed = Math.round(
      input.nightlyBase * weekendMultiplier * seasonalMultiplier,
    );

    out[iso] = Math.max(175, computed);
  }

  return out;
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
            eq(listing.state, "FL"),
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
            eq(listing.state, "FL"),
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
          eq(listing.state, "FL"),
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

  return rows.map((row, index) => {
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

    const pricing = derivePricing(row.listing_number ?? index + 1, sleeps);

    const area =
      asString(row.beach_area_name) ||
      asString(row.area_name) ||
      asString(row.city) ||
      asString(row.area) ||
      "30A";
    const community = asString(row.community_name) || area;

    const preview =
      previewSeeds.length > 0
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
    const availabilityCalendar = buildAvailabilityCalendar({
      nightlyBase: pricing.typicalAllInNightly,
      listingSeed: row.listing_number ?? index + 1,
    });

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
      typicalPrice: pricing.typicalPrice,
      typicalPricingMonth: pricing.typicalPricingMonth,
      typicalBaseNightly: pricing.typicalBaseNightly,
      typicalAllInNightly: pricing.typicalAllInNightly,
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
      availabilityCalendar,
      sleepingSummary: summary,
    };
  });
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
