import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { sql } from "drizzle-orm";

import { databaseProvider, pgDb } from "@/core/server/db";
import { buildListingSlug } from "@/core/shared/listing-identity";
import { listings, sources } from "@/lib/db/schema-postgres";

type ParsedArgs = {
  listingsRoot: string;
  limit: number | null;
  dryRun: boolean;
  geoProvider: "none" | "osm";
};

type ListingRecord = {
  id?: unknown;
  name?: unknown;
  address?: {
    city?: unknown;
    province?: unknown;
    country?: unknown;
    display?: unknown;
  };
  coordinate?: {
    latitude?: unknown;
    longitude?: unknown;
  };
  highlights?: unknown;
  gallery?: unknown;
  location?: {
    description?: unknown;
  };
  offers?: unknown;
  [key: string]: unknown;
};

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    listingsRoot: resolve(process.cwd(), "db", "listings"),
    limit: null,
    dryRun: false,
    geoProvider: "osm",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--listings-root") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("Missing value for --listings-root");
      }
      args.listingsRoot = resolve(process.cwd(), value);
      i += 1;
      continue;
    }

    if (arg === "--limit") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("Missing value for --limit");
      }
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("--limit must be a positive integer");
      }
      args.limit = parsed;
      i += 1;
      continue;
    }

    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }

    if (arg === "--geo-provider") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("Missing value for --geo-provider");
      }

      if (value !== "none" && value !== "osm") {
        throw new Error("--geo-provider must be one of: none, osm");
      }

      args.geoProvider = value;
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

async function collectJsonFiles(rootDir: string): Promise<string[]> {
  const out: string[] = [];

  async function walk(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const path = resolve(dir, entry.name);

      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }

      if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) {
        out.push(path);
      }
    }
  }

  await walk(rootDir);
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.replace(/[$,]/g, "").trim();
    if (normalized.length === 0) {
      return null;
    }

    const parsed = Number.parseFloat(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function resolveCountryCode(value: unknown): string | null {
  const text = asString(value);
  if (!text) {
    return null;
  }

  const upper = text.toUpperCase();
  if (upper === "USA" || upper === "UNITED STATES") {
    return "US";
  }

  return upper.length <= 3 ? upper : upper.slice(0, 3);
}

function normalizePropertyType(value: string): string {
  const text = value.trim().toLowerCase();

  if (text.includes("townhome") || text.includes("townhome")) {
    return "townhouse";
  }

  if (text.includes("vacation home") || text.includes("home")) {
    return "house";
  }

  return text;
}

function inferPropertyType(payload: ListingRecord): string | null {
  const texts: string[] = [];

  const pushText = (value: unknown) => {
    const text = asString(value);
    if (text) {
      texts.push(text.toLowerCase());
    }
  };

  pushText(payload.name);
  pushText(payload.location?.description);

  const aboutItems = (payload as { description?: unknown }).description;
  if (aboutItems && typeof aboutItems === "object") {
    const about = (aboutItems as { about?: unknown }).about;
    if (about && typeof about === "object") {
      const aboutArray = (about as { items?: unknown }).items;
      if (Array.isArray(aboutArray)) {
        for (const section of aboutArray) {
          if (!section || typeof section !== "object") {
            continue;
          }

          const title = (section as { title?: unknown }).title;
          pushText(title);

          const sectionItems = (section as { items?: unknown }).items;
          if (Array.isArray(sectionItems)) {
            for (const item of sectionItems) {
              pushText(item);
            }
          }
        }
      }
    }
  }

  const joined = texts.join(" \n");
  if (!joined) {
    return null;
  }

  const patterns: Array<{ type: string; test: RegExp }> = [
    { type: "cottage", test: /\bcottage\b/i },
    { type: "villa", test: /\bvilla\b/i },
    { type: "condo", test: /\bcondo(minium)?\b/i },
    { type: "cabin", test: /\bcabin\b/i },
    { type: "townhouse", test: /\btown\s?house\b|\btownhome\b/i },
    { type: "apartment", test: /\bapartment\b|\bflat\b/i },
    { type: "bungalow", test: /\bbungalow\b/i },
    { type: "house", test: /\bhouse\b|\bhome\b|\bvacation home\b/i },
  ];

  for (const pattern of patterns) {
    if (pattern.test.test(joined)) {
      return normalizePropertyType(pattern.type);
    }
  }

  return null;
}

function isLikelyStreetAddress(value: string | null): boolean {
  if (!value) {
    return false;
  }

  if (/\d/.test(value)) {
    return true;
  }

  return /\b(st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|ct|court)\b/i.test(
    value,
  );
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

function inferPostalCode(payload: ListingRecord): string | null {
  const visited = new Set<unknown>();
  const candidates: string[] = [];

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

      if (typeof nested === "string") {
        const maybe = normalizePostalCode(nested);
        if (maybe && /\d{5}/.test(maybe)) {
          candidates.push(maybe);
        }
      }

      walk(nested);
    }
  };

  walk(payload);

  for (const candidate of candidates) {
    const normalized = normalizePostalCode(candidate);
    if (normalized) {
      return normalized;
    }
  }

  const addressDisplay = asString(payload.address?.display);
  if (addressDisplay) {
    return normalizePostalCode(addressDisplay);
  }

  return null;
}

type OsmReverseResult = {
  postcode: string | null;
  city: string | null;
  state: string | null;
  countryCode: string | null;
  displayName: string | null;
  placeId: string | null;
};

const osmReverseCache = new Map<string, OsmReverseResult>();

async function reverseGeocodeWithOsm(
  lat: number,
  lng: number,
): Promise<OsmReverseResult | null> {
  const cacheKey = `${lat.toFixed(6)},${lng.toFixed(6)}`;
  const cached = osmReverseCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const url = new URL("https://nominatim.openstreetmap.org/reverse");
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lng));
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("zoom", "18");

  const response = await fetch(url, {
    headers: {
      "user-agent": "BeachHouseClassifieds/1.0 (local-import)",
    },
    signal: AbortSignal.timeout(8000),
  });

  if (!response.ok) {
    throw new Error(
      `OSM reverse geocode failed: HTTP ${String(response.status)}`,
    );
  }

  const json = (await response.json()) as {
    place_id?: unknown;
    display_name?: unknown;
    address?: {
      postcode?: unknown;
      city?: unknown;
      town?: unknown;
      village?: unknown;
      hamlet?: unknown;
      state?: unknown;
      state_code?: unknown;
      country_code?: unknown;
    };
  };

  const result: OsmReverseResult = {
    postcode: normalizePostalCode(asString(json.address?.postcode) ?? ""),
    city:
      asString(json.address?.city) ??
      asString(json.address?.town) ??
      asString(json.address?.village) ??
      asString(json.address?.hamlet),
    state: asString(json.address?.state_code) ?? asString(json.address?.state),
    countryCode: asString(json.address?.country_code)?.toUpperCase() ?? null,
    displayName: asString(json.display_name),
    placeId:
      typeof json.place_id === "number" || typeof json.place_id === "string"
        ? String(json.place_id)
        : null,
  };

  osmReverseCache.set(cacheKey, result);
  return result;
}

function parseHighlights(highlights: unknown) {
  const result: {
    bedrooms: number | null;
    bathrooms: number | null;
    maxGuests: number | null;
  } = {
    bedrooms: null,
    bathrooms: null,
    maxGuests: null,
  };

  if (!Array.isArray(highlights)) {
    return result;
  }

  for (const item of highlights) {
    const text = asString(item)?.toLowerCase();

    if (!text) {
      continue;
    }

    if (result.bedrooms === null && text.includes("bedroom")) {
      const match = text.match(/(\d+)/);
      if (match) {
        result.bedrooms = Number.parseInt(match[1], 10);
      }
    }

    if (result.bathrooms === null && text.includes("bath")) {
      const match = text.match(/(\d+(?:\.\d+)?)/);
      if (match) {
        result.bathrooms = Number.parseFloat(match[1]);
      }
    }

    if (result.maxGuests === null && text.includes("sleep")) {
      const match = text.match(/(\d+)/);
      if (match) {
        result.maxGuests = Number.parseInt(match[1], 10);
      }
    }
  }

  return result;
}

function stripHtml(value: string): string {
  return value
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function inferSourceDescription(payload: ListingRecord): string | null {
  const sections = (payload as { description?: unknown }).description;
  if (!sections || typeof sections !== "object") {
    return null;
  }

  const about = (sections as { about?: unknown }).about;
  if (!about || typeof about !== "object") {
    return null;
  }

  const items = (about as { items?: unknown }).items;
  if (!Array.isArray(items)) {
    return null;
  }

  for (const section of items) {
    if (!section || typeof section !== "object") {
      continue;
    }

    const paragraphItems = (section as { items?: unknown }).items;
    if (!Array.isArray(paragraphItems)) {
      continue;
    }

    for (const paragraph of paragraphItems) {
      const text = asString(paragraph);
      if (!text) {
        continue;
      }

      const normalized = stripHtml(text);
      if (normalized.length > 0) {
        return normalized;
      }
    }
  }

  return null;
}

function pushTrait(output: Set<string>, value: unknown) {
  const text = asString(value);
  if (!text) {
    return;
  }

  const normalized = stripHtml(text).toLowerCase();
  if (normalized.length === 0 || normalized.length > 80) {
    return;
  }

  output.add(normalized);
}

function inferTraits(payload: ListingRecord): string[] {
  const traitSet = new Set<string>();

  if (Array.isArray(payload.highlights)) {
    for (const highlight of payload.highlights) {
      pushTrait(traitSet, highlight);
    }
  }

  const amenities = (payload as { amenities?: unknown }).amenities;
  if (amenities && typeof amenities === "object") {
    const groups = (amenities as { items?: unknown }).items;
    if (Array.isArray(groups)) {
      for (const group of groups) {
        if (!group || typeof group !== "object") {
          continue;
        }

        pushTrait(traitSet, (group as { title?: unknown }).title);

        const items = (group as { items?: unknown }).items;
        if (!Array.isArray(items)) {
          continue;
        }

        for (const item of items) {
          pushTrait(traitSet, item);
        }
      }
    }
  }

  const spaces = (payload as { spaces?: unknown }).spaces;
  if (Array.isArray(spaces)) {
    for (const block of spaces) {
      if (!block || typeof block !== "object") {
        continue;
      }

      pushTrait(traitSet, (block as { title?: unknown }).title);

      const groups = (block as { items?: unknown }).items;
      if (!Array.isArray(groups)) {
        continue;
      }

      for (const group of groups) {
        if (!group || typeof group !== "object") {
          continue;
        }

        pushTrait(traitSet, (group as { title?: unknown }).title);

        const items = (group as { items?: unknown }).items;
        if (!Array.isArray(items)) {
          continue;
        }

        for (const item of items) {
          pushTrait(traitSet, item);
        }
      }
    }
  }

  return Array.from(traitSet)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 200);
}

function summarizeDescription(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= 220) {
    return compact;
  }

  return `${compact.slice(0, 217).trimEnd()}...`;
}

function stripMarkdown(value: string): string {
  return value
    .replace(/[#*_`>-]/g, " ")
    .replace(/\[[^\]]+\]\([^)]+\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildCanonicalDescriptionMarkdown(input: {
  title: string;
  city: string | null;
  state: string | null;
  propertyType: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  maxGuests: number | null;
  featureFlags: {
    isOceanfront: boolean;
    isBeachfront: boolean;
    isWaterfront: boolean;
    hasPool: boolean;
    allowsPets: boolean;
    hasNeighborhoodAmenities: boolean;
  };
  traits: string[];
  sourceDescription: string | null;
}): string {
  const headlineParts = [input.city, input.state].filter(Boolean).join(", ");
  const typeLabel = input.propertyType ?? "vacation rental";
  const introLocation = headlineParts ? ` in ${headlineParts}` : "";

  const capacityParts: string[] = [];
  if (input.bedrooms !== null)
    capacityParts.push(`${String(input.bedrooms)} bedrooms`);
  if (input.bathrooms !== null)
    capacityParts.push(`${String(input.bathrooms)} bathrooms`);
  if (input.maxGuests !== null)
    capacityParts.push(`sleeps up to ${String(input.maxGuests)}`);

  const highlights: string[] = [];
  if (input.featureFlags.isOceanfront) highlights.push("Oceanfront setting");
  if (input.featureFlags.isBeachfront)
    highlights.push("Direct beachfront access");
  if (input.featureFlags.isWaterfront) highlights.push("Waterfront location");
  if (input.featureFlags.hasPool) highlights.push("Pool access");
  if (input.featureFlags.allowsPets) highlights.push("Pet-friendly stay");
  if (input.featureFlags.hasNeighborhoodAmenities)
    highlights.push("Close to neighborhood amenities and attractions");

  const topTraits = input.traits
    .filter((trait) => !/(bedrooms?|bathrooms?|sleeps?)/i.test(trait))
    .slice(0, 8)
    .map((trait) => `- ${trait}`);

  const sourceContext = input.sourceDescription
    ? stripHtml(input.sourceDescription).slice(0, 280)
    : null;

  const lines: string[] = [];
  lines.push(`## Overview`);
  lines.push(
    `${input.title} is a ${typeLabel}${introLocation} designed for coastal vacation stays.`,
  );

  if (capacityParts.length > 0) {
    lines.push(`It offers ${capacityParts.join(", ")}.`);
  }

  if (highlights.length > 0) {
    lines.push("");
    lines.push("## Property Highlights");
    for (const item of highlights) {
      lines.push(`- ${item}`);
    }
  }

  if (topTraits.length > 0) {
    lines.push("");
    lines.push("## Amenities and Features");
    lines.push(...topTraits);
  }

  if (sourceContext) {
    lines.push("");
    lines.push("## Stay Snapshot");
    lines.push(
      `This listing is based on currently available source details and has been normalized for BeachHouseClassifieds.`,
    );
  }

  return lines.join("\n").trim();
}

function collectSearchCorpus(payload: ListingRecord, traits: string[]): string {
  const lines: string[] = [];

  const add = (value: unknown) => {
    const text = asString(value);
    if (text) {
      lines.push(stripHtml(text).toLowerCase());
    }
  };

  add(payload.name);
  add(payload.address?.display);

  if (Array.isArray(payload.highlights)) {
    for (const value of payload.highlights) {
      add(value);
    }
  }

  const description = (payload as { description?: unknown }).description;
  if (description && typeof description === "object") {
    const about = (description as { about?: unknown }).about;
    if (about && typeof about === "object") {
      const items = (about as { items?: unknown }).items;
      if (Array.isArray(items)) {
        for (const section of items) {
          if (!section || typeof section !== "object") {
            continue;
          }

          add((section as { title?: unknown }).title);
          const sectionItems = (section as { items?: unknown }).items;
          if (Array.isArray(sectionItems)) {
            for (const item of sectionItems) {
              add(item);
            }
          }
        }
      }
    }
  }

  const amenities = (payload as { amenities?: unknown }).amenities;
  if (amenities && typeof amenities === "object") {
    const groups = (amenities as { items?: unknown }).items;
    if (Array.isArray(groups)) {
      for (const group of groups) {
        if (!group || typeof group !== "object") {
          continue;
        }

        add((group as { title?: unknown }).title);
        const items = (group as { items?: unknown }).items;
        if (Array.isArray(items)) {
          for (const item of items) {
            add(item);
          }
        }
      }
    }
  }

  const faqs = (payload as { faqs?: unknown }).faqs;
  if (faqs && typeof faqs === "object") {
    const general = (faqs as { general?: unknown }).general;
    if (Array.isArray(general)) {
      for (const item of general) {
        if (!item || typeof item !== "object") {
          continue;
        }

        add((item as { question?: unknown }).question);
        add((item as { answer?: unknown }).answer);
      }
    }
  }

  const location = payload.location;
  if (location && typeof location === "object") {
    const descriptions = location.description;
    if (Array.isArray(descriptions)) {
      for (const item of descriptions) {
        add(item);
      }
    }
  }

  for (const trait of traits) {
    lines.push(trait);
  }

  return lines.join("\n");
}

function inferFeatureFlags(payload: ListingRecord, traits: string[]) {
  const corpus = collectSearchCorpus(payload, traits);
  const has = (pattern: RegExp) => pattern.test(corpus);

  const amenityTexts: string[] = [];
  const amenities = (payload as { amenities?: unknown }).amenities;
  if (amenities && typeof amenities === "object") {
    const groups = (amenities as { items?: unknown }).items;
    if (Array.isArray(groups)) {
      for (const group of groups) {
        if (!group || typeof group !== "object") {
          continue;
        }

        const title = asString((group as { title?: unknown }).title);
        if (title) {
          amenityTexts.push(stripHtml(title).toLowerCase());
        }

        const items = (group as { items?: unknown }).items;
        if (Array.isArray(items)) {
          for (const item of items) {
            const text = asString(item);
            if (text) {
              amenityTexts.push(stripHtml(text).toLowerCase());
            }
          }
        }
      }
    }
  }

  const amenityCorpus = amenityTexts.join("\n");

  const hasPrivatePool =
    /\b(private pool|own pool|plunge pool|heated private pool|exclusive pool)\b/i.test(
      corpus,
    ) || /\bprivate pool\b/i.test(amenityCorpus);

  const hasNeighborhoodPool =
    /\b(communal pool|community pool|shared pool|resort pool|neighborhood pool|pool pass|beach club pool|club pool)\b/i.test(
      corpus,
    ) ||
    /\b(communal pool|community pool|shared pool|pool & spa)\b/i.test(
      amenityCorpus,
    );

  const allowsPets = has(
    /\b(pet friendly|pets allowed|dogs allowed|cats allowed)\b/i,
  )
    ? true
    : has(/\b(no pets|pets (are )?not allowed|only service animals?)\b/i)
      ? false
      : false;

  const nearbyPois = (payload.location as { nearbyPOIs?: unknown } | undefined)
    ?.nearbyPOIs;
  const hasNearbyPois = Array.isArray(nearbyPois) && nearbyPois.length > 0;

  return {
    isOceanfront: has(
      /\b(oceanfront|gulf front|gulffront|on the ocean|ocean side)\b/i,
    ),
    isBeachfront: has(/\b(beachfront|on the beach|beach front)\b/i),
    isWaterfront: has(
      /\b(waterfront|lakefront|riverfront|bayfront|canal front|intracoastal)\b/i,
    ),
    hasPrivatePool,
    hasNeighborhoodPool,
    hasPool: hasPrivatePool,
    allowsPets,
    hasNeighborhoodAmenities:
      hasNearbyPois ||
      has(
        /\b(nearby activities|shopping|restaurants|walk to|what's nearby)\b/i,
      ),
  };
}

function canonicalSlug(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_{2,}/g, "_");
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(
    new Set(values.map((value) => value.trim()).filter(Boolean)),
  );
}

function buildAmenitiesSection(payload: ListingRecord) {
  const groups: Array<{ key: string; label: string; items: string[] }> = [];
  const amenities = (payload as { amenities?: unknown }).amenities;

  if (amenities && typeof amenities === "object") {
    const items = (amenities as { items?: unknown }).items;
    if (Array.isArray(items)) {
      for (const group of items) {
        if (!group || typeof group !== "object") {
          continue;
        }

        const label =
          asString((group as { title?: unknown }).title) ?? "General";
        const rawItems = (group as { items?: unknown }).items;
        const normalizedItems = Array.isArray(rawItems)
          ? uniqueStrings(
              rawItems
                .map((item) => asString(item))
                .filter((item): item is string => Boolean(item)),
            )
          : [];

        groups.push({
          key: canonicalSlug(label),
          label,
          items: normalizedItems,
        });
      }
    }
  }

  return {
    schema_version: 1,
    groups,
  };
}

function buildSpacesSection(payload: ListingRecord) {
  const spaces: Array<{ key: string; label: string; items: string[] }> = [];
  const blocks = (payload as { spaces?: unknown }).spaces;

  if (Array.isArray(blocks)) {
    for (const block of blocks) {
      if (!block || typeof block !== "object") {
        continue;
      }

      const blockTitle =
        asString((block as { title?: unknown }).title) ?? "space";
      const groups = (block as { items?: unknown }).items;

      if (!Array.isArray(groups)) {
        continue;
      }

      for (const group of groups) {
        if (!group || typeof group !== "object") {
          continue;
        }

        const label =
          asString((group as { title?: unknown }).title) ?? blockTitle;
        const items = (group as { items?: unknown }).items;
        const normalizedItems = Array.isArray(items)
          ? uniqueStrings(
              items
                .map((item) => asString(item))
                .filter((item): item is string => Boolean(item)),
            )
          : [];

        spaces.push({
          key: canonicalSlug(label),
          label,
          items: normalizedItems,
        });
      }
    }
  }

  return {
    schema_version: 1,
    groups: spaces,
  };
}

function buildPoliciesSection(payload: ListingRecord) {
  const groups: Array<{ key: string; label: string; items: string[] }> = [];
  const policies = (payload as { policies?: unknown }).policies;

  if (policies && typeof policies === "object") {
    const title =
      asString((policies as { title?: unknown }).title) ?? "Policies";
    const blocks = (policies as { items?: unknown }).items;
    if (Array.isArray(blocks)) {
      for (const block of blocks) {
        if (!block || typeof block !== "object") {
          continue;
        }

        const label = asString((block as { title?: unknown }).title) ?? title;
        const items = (block as { items?: unknown }).items;
        const normalizedItems = Array.isArray(items)
          ? uniqueStrings(
              items
                .map((item) => asString(item))
                .filter((item): item is string => Boolean(item)),
            )
          : [];

        groups.push({
          key: canonicalSlug(label),
          label,
          items: normalizedItems,
        });
      }
    }
  }

  return {
    schema_version: 1,
    groups,
  };
}

function buildFaqsSection(payload: ListingRecord) {
  const items: Array<{ question: string; answer: string }> = [];
  const faqs = (payload as { faqs?: unknown }).faqs;
  if (faqs && typeof faqs === "object") {
    const general = (faqs as { general?: unknown }).general;
    if (Array.isArray(general)) {
      for (const entry of general) {
        if (!entry || typeof entry !== "object") {
          continue;
        }

        const question = asString((entry as { question?: unknown }).question);
        const answer = asString((entry as { answer?: unknown }).answer);
        if (question && answer) {
          items.push({
            question: stripHtml(question),
            answer: stripHtml(answer),
          });
        }
      }
    }
  }

  return {
    schema_version: 1,
    items,
  };
}

function buildReviewsSection(payload: ListingRecord) {
  const reviews = (payload as { reviews?: unknown }).reviews;
  const recent: Array<{
    title: string | null;
    message: string | null;
    rating: number | null;
    date: string | null;
  }> = [];

  let total: number | null = null;
  let score: number | null = null;

  if (reviews && typeof reviews === "object") {
    const reviewTotal = (reviews as { total?: unknown }).total;
    if (typeof reviewTotal === "number" && Number.isFinite(reviewTotal)) {
      total = reviewTotal;
    }

    const reviewScore = (reviews as { score?: unknown }).score;
    if (typeof reviewScore === "number" && Number.isFinite(reviewScore)) {
      score = reviewScore;
    }

    const items = (reviews as { items?: unknown }).items;
    if (Array.isArray(items)) {
      for (const item of items.slice(0, 5)) {
        if (!item || typeof item !== "object") {
          continue;
        }

        const message = asString((item as { message?: unknown }).message);
        const title = asString((item as { title?: unknown }).title);
        const date = asString((item as { createdDate?: unknown }).createdDate);
        const ratingRaw = (item as { rating?: unknown }).rating;
        const rating =
          typeof ratingRaw === "number" && Number.isFinite(ratingRaw)
            ? ratingRaw
            : null;

        recent.push({
          title,
          message: message ? stripHtml(message) : null,
          rating,
          date,
        });
      }
    }
  }

  return {
    schema_version: 1,
    total,
    score,
    recent,
  };
}

function buildLocationSection(payload: ListingRecord) {
  const nearby: Array<{
    category: string;
    name: string;
    detail: string | null;
  }> = [];
  const location = payload.location;

  if (location && typeof location === "object") {
    const nearbyPOIs = (location as { nearbyPOIs?: unknown }).nearbyPOIs;
    if (Array.isArray(nearbyPOIs)) {
      for (const group of nearbyPOIs) {
        if (!group || typeof group !== "object") {
          continue;
        }

        const category =
          asString((group as { title?: unknown }).title) ?? "nearby";
        const items = (group as { items?: unknown }).items;

        if (!Array.isArray(items)) {
          continue;
        }

        for (const item of items) {
          if (!item || typeof item !== "object") {
            continue;
          }

          const name = asString((item as { text?: unknown }).text);
          if (!name) {
            continue;
          }

          const detail = asString((item as { more?: unknown }).more);
          nearby.push({ category, name, detail });
        }
      }
    }
  }

  return {
    schema_version: 1,
    nearby,
  };
}

function buildFieldLineage(sourceRecordId: string) {
  const fromSource = {
    source_record_id: sourceRecordId,
    strategy: "canonical_from_source_v1",
  };

  return {
    title: fromSource,
    city: fromSource,
    state: fromSource,
    country_code: fromSource,
    property_type: fromSource,
    description: fromSource,
    description_summary: fromSource,
    description_marketing_md: fromSource,
    traits: fromSource,
    amenities_section: fromSource,
    spaces_section: fromSource,
    policies_section: fromSource,
    faqs_section: fromSource,
    reviews_section: fromSource,
    location_section: fromSource,
    is_oceanfront: fromSource,
    is_beachfront: fromSource,
    is_waterfront: fromSource,
    has_private_pool: fromSource,
    has_neighborhood_pool: fromSource,
    has_pool: fromSource,
    allows_pets: fromSource,
    has_neighborhood_amenities: fromSource,
    bedrooms: fromSource,
    bathrooms: fromSource,
    max_guests: fromSource,
    nightly_rate: fromSource,
    street_address: fromSource,
    zip_code: fromSource,
    lat: fromSource,
    lng: fromSource,
    geo: fromSource,
    images: fromSource,
    primary_image_id: fromSource,
  };
}

function findNightlyRate(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string") {
    const maybe = asNumber(value);
    return maybe;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNightlyRate(item);
      if (found !== null) {
        return found;
      }
    }
    return null;
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;

    const priorityKeys = [
      "amount",
      "value",
      "total",
      "display",
      "formatted",
      "nightly",
      "nightlyRate",
      "price",
      "lead",
      "payments",
      "rates",
      "categories",
    ];

    for (const key of priorityKeys) {
      if (key in record) {
        const found = findNightlyRate(record[key]);
        if (found !== null) {
          return found;
        }
      }
    }

    for (const nested of Object.values(record)) {
      const found = findNightlyRate(nested);
      if (found !== null) {
        return found;
      }
    }
  }

  return null;
}

function deriveListingId(sourceType: string, sourceId: string): string {
  const digest = createHash("sha1")
    .update(`${sourceType}:${sourceId}`)
    .digest("hex")
    .slice(0, 20);

  return digest;
}

function deriveSourceRecordId(
  listingRowId: string,
  sourceType: string,
  sourceId: string,
  payloadHash: string,
): string {
  const digest = createHash("sha1")
    .update(`src:${listingRowId}:${sourceType}:${sourceId}:${payloadHash}`)
    .digest("hex")
    .slice(0, 20);

  return `src_${digest}`;
}

function extractSourceListingIdFromUrl(rawUrl: unknown): string | null {
  const sourceUrl = asString(rawUrl);
  if (!sourceUrl) {
    return null;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(sourceUrl);
  } catch {
    return null;
  }

  const hostname = parsedUrl.hostname.toLowerCase();
  if (!hostname.endsWith("vrbo.com")) {
    return null;
  }

  const pathSegments = parsedUrl.pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  if (pathSegments.length === 0) {
    return null;
  }

  const candidate = pathSegments[0];
  return /^\d+$/.test(candidate) ? candidate : null;
}

async function run() {
  const options = parseArgs(process.argv.slice(2));

  if (databaseProvider !== "postgres" || !pgDb) {
    throw new Error(
      "Postgres provider is required. Run using --target postgres:local (or another Postgres target).",
    );
  }

  const files = await collectJsonFiles(options.listingsRoot);
  const selected =
    options.limit !== null ? files.slice(0, options.limit) : files;

  if (selected.length === 0) {
    console.log("No listing JSON files found.");
    return;
  }

  const sourceType = "vrbo" as const;
  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  let skippedNonUs = 0;

  for (const filePath of selected) {
    processed += 1;

    try {
      const raw = await readFile(filePath, "utf8");
      const payload = JSON.parse(raw) as ListingRecord;
      const sourceId = asString(payload.id);

      if (!sourceId) {
        failed += 1;
        continue;
      }

      const title = asString(payload.name) ?? `VRBO ${sourceId}`;
      const city = asString(payload.address?.city);
      const state = asString(payload.address?.province);
      const countryCode = resolveCountryCode(payload.address?.country);
      if (countryCode !== null && countryCode !== "US") {
        skippedNonUs += 1;
        continue;
      }
      const sourceLat = asNumber(payload.coordinate?.latitude);
      const sourceLng = asNumber(payload.coordinate?.longitude);
      const highlights = parseHighlights(payload.highlights);
      const nightlyRate = findNightlyRate(payload.offers);
      const propertyType = inferPropertyType(payload);
      const inferredPostalCode = inferPostalCode(payload);
      const sourceDescription = inferSourceDescription(payload);
      const descriptionMarketingMd = null;
      const traits = inferTraits(payload);
      const featureFlags = inferFeatureFlags(payload, traits);
      const canonicalDescription = buildCanonicalDescriptionMarkdown({
        title,
        city,
        state,
        propertyType,
        bedrooms: highlights.bedrooms,
        bathrooms: highlights.bathrooms,
        maxGuests: highlights.maxGuests,
        featureFlags,
        traits,
        sourceDescription,
      });
      const descriptionSummary = summarizeDescription(
        stripMarkdown(canonicalDescription),
      );
      const amenitiesSection = buildAmenitiesSection(payload);
      const spacesSection = buildSpacesSection(payload);
      const policiesSection = buildPoliciesSection(payload);
      const faqsSection = buildFaqsSection(payload);
      const reviewsSection = buildReviewsSection(payload);
      const locationSection = buildLocationSection(payload);
      const sourceDisplayAddress = asString(payload.address?.display);
      const sourceStreetAddress = isLikelyStreetAddress(sourceDisplayAddress)
        ? sourceDisplayAddress
        : null;
      const bathroomsValue =
        highlights.bathrooms !== null ? String(highlights.bathrooms) : null;
      const nightlyRateValue =
        nightlyRate !== null ? String(nightlyRate.toFixed(2)) : null;

      const listingId = deriveListingId(sourceType, sourceId);
      const payloadHash = createHash("sha256").update(raw).digest("hex");
      const sourceRecordId = deriveSourceRecordId(
        listingId,
        sourceType,
        sourceId,
        payloadHash,
      );
      const sourceListingId = extractSourceListingIdFromUrl(
        (payload as { url?: unknown }).url,
      );
      const slug = buildListingSlug({
        title,
        city,
        state,
        listingId,
      });
      const nowIso = new Date().toISOString();

      let geocoded: OsmReverseResult | null = null;
      if (
        options.geoProvider === "osm" &&
        sourceLat !== null &&
        sourceLng !== null
      ) {
        try {
          geocoded = await reverseGeocodeWithOsm(sourceLat, sourceLng);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          console.warn(`OSM geocode failed for ${sourceId}: ${message}`);
        }
      }

      if (geocoded?.countryCode && geocoded.countryCode !== "US") {
        skippedNonUs += 1;
        continue;
      }

      const resolvedCity = geocoded?.city ?? city;
      const resolvedState = geocoded?.state ?? state;
      const resolvedCountryCode = "US";
      const resolvedZipCode = geocoded?.postcode ?? inferredPostalCode;

      const geo = {
        lat: sourceLat,
        lng: sourceLng,
        city: resolvedCity,
        state: resolvedState,
        country_code: resolvedCountryCode,
        zip_code: resolvedZipCode,
        source_provider: "vrbo",
        source_display: sourceDisplayAddress,
        geocode_provider: geocoded ? "osm" : null,
        geocode_place_id: geocoded?.placeId ?? null,
        geocode_display_name: geocoded?.displayName ?? null,
      };

      const sourceRefs = [
        {
          source_record_id: sourceRecordId,
          source_type: sourceType,
          source_id: sourceId,
          payload_hash: payloadHash,
          captured_at: nowIso,
          priority: 1,
          selected_fields: [
            "title",
            "city",
            "state",
            "country_code",
            "property_type",
            "description",
            "description_summary",
            "description_marketing_md",
            "traits",
            "is_oceanfront",
            "is_beachfront",
            "is_waterfront",
            "has_private_pool",
            "has_neighborhood_pool",
            "has_pool",
            "allows_pets",
            "has_neighborhood_amenities",
            "bedrooms",
            "bathrooms",
            "max_guests",
            "nightly_rate",
            "street_address",
            "zip_code",
            "lat",
            "lng",
            "geo",
            "images",
            "primary_image_id",
          ],
          merge_strategy: "single_source_latest_payload",
        },
      ];
      const mergeStrategyVersion = "v1";
      const fieldLineage = buildFieldLineage(sourceRecordId);

      if (!options.dryRun) {
        await pgDb
          .insert(listings)
          .values({
            id: listingId,
            slug,
            title,
            city: resolvedCity,
            state: resolvedState,
            countryCode: resolvedCountryCode,
            propertyType,
            description: canonicalDescription,
            descriptionSummary,
            descriptionMarketingMd,
            traits,
            amenitiesSection,
            spacesSection,
            policiesSection,
            faqsSection,
            reviewsSection,
            locationSection,
            isOceanfront: featureFlags.isOceanfront,
            isBeachfront: featureFlags.isBeachfront,
            isWaterfront: featureFlags.isWaterfront,
            hasPrivatePool: featureFlags.hasPrivatePool,
            hasNeighborhoodPool: featureFlags.hasNeighborhoodPool,
            hasPool: featureFlags.hasPool,
            allowsPets: featureFlags.allowsPets,
            hasNeighborhoodAmenities: featureFlags.hasNeighborhoodAmenities,
            bedrooms: highlights.bedrooms,
            bathrooms: bathroomsValue,
            maxGuests: highlights.maxGuests,
            currencyCode: "USD",
            nightlyRate: nightlyRateValue,
            streetAddress: sourceStreetAddress,
            zipCode: resolvedZipCode,
            lat: sourceLat,
            lng: sourceLng,
            geo,
            mergeStrategyVersion,
            fieldLineage,
            sourceRefs,
            images: [],
            primaryImageId: null,
            createdAt: nowIso,
            updatedAt: nowIso,
          })
          .onConflictDoUpdate({
            target: [listings.id],
            set: {
              slug: sql`excluded.slug`,
              title: sql`excluded.title`,
              city: sql`excluded.city`,
              state: sql`excluded.state`,
              countryCode: sql`excluded.country_code`,
              propertyType: sql`excluded.property_type`,
              description: sql`excluded.description`,
              descriptionSummary: sql`excluded.description_summary`,
              descriptionMarketingMd: sql`excluded.description_marketing_md`,
              traits: sql`excluded.traits`,
              amenitiesSection: sql`excluded.amenities_section`,
              spacesSection: sql`excluded.spaces_section`,
              policiesSection: sql`excluded.policies_section`,
              faqsSection: sql`excluded.faqs_section`,
              reviewsSection: sql`excluded.reviews_section`,
              locationSection: sql`excluded.location_section`,
              isOceanfront: sql`excluded.is_oceanfront`,
              isBeachfront: sql`excluded.is_beachfront`,
              isWaterfront: sql`excluded.is_waterfront`,
              hasPrivatePool: sql`excluded.has_private_pool`,
              hasNeighborhoodPool: sql`excluded.has_neighborhood_pool`,
              hasPool: sql`excluded.has_pool`,
              allowsPets: sql`excluded.allows_pets`,
              hasNeighborhoodAmenities: sql`excluded.has_neighborhood_amenities`,
              bedrooms: sql`excluded.bedrooms`,
              bathrooms: sql`excluded.bathrooms`,
              maxGuests: sql`excluded.max_guests`,
              currencyCode: sql`excluded.currency_code`,
              nightlyRate: sql`excluded.nightly_rate`,
              streetAddress: sql`excluded.street_address`,
              zipCode: sql`excluded.zip_code`,
              lat: sql`excluded.lat`,
              lng: sql`excluded.lng`,
              geo: sql`excluded.geo`,
              mergeStrategyVersion: sql`excluded.merge_strategy_version`,
              fieldLineage: sql`excluded.field_lineage`,
              sourceRefs: sql`excluded.source_refs`,
              images: sql`excluded.images`,
              primaryImageId: sql`excluded.primary_image_id`,
              updatedAt: sql`excluded.updated_at`,
            },
          });

        await pgDb
          .insert(sources)
          .values({
            id: sourceRecordId,
            listingId,
            sourceType,
            sourceId,
            source_listing_id: sourceListingId,
            sourceUrl: null,
            payloadHash,
            payload,
            capturedAt: nowIso,
            createdAt: nowIso,
            updatedAt: nowIso,
          })
          .onConflictDoNothing({
            target: [sources.listingId, sources.payloadHash],
          });
      }

      succeeded += 1;

      if (processed % 100 === 0) {
        console.log(
          `[progress] processed=${String(processed)} succeeded=${String(succeeded)} failed=${String(failed)}`,
        );
      }
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Import failed for ${filePath}: ${message}`);
    }
  }

  console.log("\nImport summary");
  console.log(`- listingsRoot: ${options.listingsRoot}`);
  console.log(`- dryRun: ${String(options.dryRun)}`);
  console.log(`- processed: ${String(processed)}`);
  console.log(`- succeeded: ${String(succeeded)}`);
  console.log(`- failed: ${String(failed)}`);
  console.log(`- skipped_non_us: ${String(skippedNonUs)}`);
}

let interrupted = false;

process.on("SIGINT", () => {
  interrupted = true;
  console.error("Import cancelled by user.");
  process.exit(130);
});

run().catch((error: unknown) => {
  if (interrupted) {
    process.exit(130);
  }

  const message = error instanceof Error ? error.message : String(error);
  console.error(`Import failed: ${message}`);
  process.exit(1);
});
