import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { DiscoverListing } from "@/components/discover/discover-data";

const LISTINGS_DIR = path.resolve(process.cwd(), "db/listings");
const TARGET_LISTING_COUNT = 96;

type RawListing = {
  id?: unknown;
  name?: unknown;
  amenities?: {
    items?: unknown;
  };
  address?: {
    city?: unknown;
    display?: unknown;
  };
  location?: {
    description?: unknown;
    nearbyPOIs?: unknown;
    title?: unknown;
  };
  coordinate?: {
    latitude?: unknown;
    longitude?: unknown;
  };
  gallery?: unknown;
  faqs?: {
    general?: unknown;
  };
  highlights?: unknown;
  spaces?: unknown;
  policies?: {
    items?: unknown;
  };
  calendarRates?: unknown;
  description?: {
    about?: {
      items?: unknown;
    };
  };
};

let cachedListings: DiscoverListing[] | null = null;

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value.replace(/,/g, "").trim());
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function normalizeTextList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const output: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.trim()) {
      output.push(item.trim());
      continue;
    }

    if (item && typeof item === "object") {
      const nestedItems = Reflect.get(item, "items");
      if (Array.isArray(nestedItems)) {
        for (const nestedItem of nestedItems) {
          if (typeof nestedItem === "string" && nestedItem.trim()) {
            output.push(nestedItem.trim());
          }
          if (nestedItem && typeof nestedItem === "object") {
            const nestedNestedItems = Reflect.get(nestedItem, "items");
            if (Array.isArray(nestedNestedItems)) {
              for (const deepValue of nestedNestedItems) {
                if (typeof deepValue === "string" && deepValue.trim()) {
                  output.push(deepValue.trim());
                }
              }
            }
          }
        }
      }
    }
  }

  return output;
}

function sanitizeText(value: string): string {
  return value
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\u00a0/g, " ")
    .replace(/[\t\r]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function normalizeSanitizedTextList(value: unknown): string[] {
  return normalizeTextList(value)
    .map((item) => sanitizeText(item))
    .filter((item) => item.length > 0);
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];

  for (const value of values) {
    const normalized = value.toLowerCase();
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(value);
  }

  return output;
}

function parseFirstMatchNumber(text: string, pattern: RegExp): number | null {
  const matched = text.match(pattern);
  if (!matched?.[1]) {
    return null;
  }
  return toFiniteNumber(matched[1]);
}

function extractGalleryUrls(gallery: unknown): string[] {
  if (!Array.isArray(gallery)) {
    return [];
  }

  const urls = new Set<string>();
  for (const item of gallery) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const url = asString(Reflect.get(item, "url"));
    if (url) {
      urls.add(url);
    }
  }

  return Array.from(urls).slice(0, 4);
}

function extractGallery(
  gallery: unknown,
): Array<{ name: string; url: string }> {
  if (!Array.isArray(gallery)) {
    return [];
  }

  const output: Array<{ name: string; url: string }> = [];
  const seenUrls = new Set<string>();

  for (const item of gallery) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const url = asString(Reflect.get(item, "url"));
    if (!url || seenUrls.has(url)) {
      continue;
    }

    seenUrls.add(url);
    output.push({
      name: asString(Reflect.get(item, "name")) ?? "Property image",
      url,
    });
  }

  return output;
}

function inferBedsFromHighlights(lines: string[]): {
  bedrooms: number | null;
  bathrooms: number | null;
  sleeps: number | null;
  kingBeds: number;
  queenBeds: number;
} {
  const text = lines.join("\n");

  const bedrooms = parseFirstMatchNumber(text, /(\d+)\s*bedrooms?/i);
  const sleeps = parseFirstMatchNumber(text, /sleeps\s*(\d+)/i);

  let bathrooms = parseFirstMatchNumber(
    text,
    /(\d+(?:\.\d+)?)\+?\s*bathrooms?/i,
  );

  const spacesBathroomText = lines.find((line) => /bathrooms?/i.test(line));
  if (spacesBathroomText) {
    const fullBathrooms = parseFirstMatchNumber(
      spacesBathroomText,
      /(\d+(?:\.\d+)?)\s*bathrooms?/i,
    );
    const halfBathrooms = parseFirstMatchNumber(
      spacesBathroomText,
      /(\d+)\s*half\s*bathrooms?/i,
    );

    if (fullBathrooms !== null) {
      bathrooms = fullBathrooms + (halfBathrooms ?? 0) * 0.5;
    }
  }

  const kingBeds = Array.from(text.matchAll(/(\d+)\s*king\s*beds?/gi)).reduce(
    (sum, match) => sum + Number(match[1]),
    0,
  );
  const queenBeds = Array.from(text.matchAll(/(\d+)\s*queen\s*beds?/gi)).reduce(
    (sum, match) => sum + Number(match[1]),
    0,
  );

  return {
    bedrooms,
    bathrooms,
    sleeps,
    kingBeds,
    queenBeds,
  };
}

function extractPolicyText(items: unknown): string[] {
  if (!Array.isArray(items)) {
    return [];
  }

  const out: string[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const nestedItems = Reflect.get(item, "items");
    if (!Array.isArray(nestedItems)) {
      continue;
    }
    for (const policyText of nestedItems) {
      if (typeof policyText === "string" && policyText.trim()) {
        out.push(policyText.trim());
      }
    }
  }

  return out;
}

function extractAmenities(items: unknown): string[] {
  if (!Array.isArray(items)) {
    return [];
  }

  const values: string[] = [];

  for (const section of items) {
    if (!section || typeof section !== "object") {
      continue;
    }
    const sectionItems = Reflect.get(section, "items");
    if (!Array.isArray(sectionItems)) {
      continue;
    }
    for (const item of sectionItems) {
      if (typeof item === "string") {
        values.push(sanitizeText(item));
      }
    }
  }

  return uniqueStrings(values.filter((value) => value.length > 0));
}

function extractNearbyPoints(nearbyPOIs: unknown): string[] {
  if (!Array.isArray(nearbyPOIs)) {
    return [];
  }

  const values: string[] = [];
  for (const group of nearbyPOIs) {
    if (!group || typeof group !== "object") {
      continue;
    }
    const items = Reflect.get(group, "items");
    if (!Array.isArray(items)) {
      continue;
    }
    for (const item of items) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const text = asString(Reflect.get(item, "text"));
      const more = asString(Reflect.get(item, "more"));
      if (!text) {
        continue;
      }
      values.push(more ? `${text} (${more})` : text);
    }
  }

  return uniqueStrings(values);
}

function extractFaqHints(generalFaqs: unknown): string[] {
  if (!Array.isArray(generalFaqs)) {
    return [];
  }

  const values: string[] = [];
  for (const item of generalFaqs) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const answer = asString(Reflect.get(item, "answer"));
    if (answer) {
      values.push(sanitizeText(answer));
    }
  }

  return uniqueStrings(values);
}

function extractCheckTimes(policyItems: unknown): {
  checkInTime?: string;
  checkOutTime?: string;
} {
  const policyText = extractPolicyText(policyItems).map((text) =>
    sanitizeText(text),
  );

  let checkInTime: string | undefined;
  let checkOutTime: string | undefined;

  for (const line of policyText) {
    if (!checkInTime) {
      const matched = line.match(/check\s*in\s*(?:after)?\s*([\d:\sAPMapm]+)/i);
      if (matched?.[1]) {
        checkInTime = matched[1].trim();
      }
    }

    if (!checkOutTime) {
      const matched = line.match(
        /check\s*out\s*(?:before)?\s*([\d:\sAPMapm]+)/i,
      );
      if (matched?.[1]) {
        checkOutTime = matched[1].trim();
      }
    }
  }

  return {
    checkInTime,
    checkOutTime,
  };
}

function inferTypicalPriceLabel(raw: RawListing): string {
  const rates = raw.calendarRates;
  const values: number[] = [];

  if (rates && typeof rates === "object") {
    for (const value of Object.values(rates)) {
      if (typeof value !== "string") {
        continue;
      }
      const normalized = Number(value.replace(/[^\d.]/g, ""));
      if (Number.isFinite(normalized) && normalized > 0) {
        values.push(normalized);
      }
    }
  }

  if (values.length > 0) {
    const nightlyLow = Math.min(...values);
    const nightlyHigh = Math.max(...values);
    const weeklyLow = (nightlyLow * 7) / 1000;
    const weeklyHigh = (nightlyHigh * 7) / 1000;
    return `$${weeklyLow.toFixed(1)}k - $${weeklyHigh.toFixed(1)}k`;
  }

  return "$5.0k - $8.0k";
}

function extractAvailabilityCalendar(raw: RawListing): Record<string, number> {
  const rates = raw.calendarRates;
  if (!rates || typeof rates !== "object") {
    return {};
  }

  const out: Record<string, number> = {};
  for (const [dateIso, value] of Object.entries(rates)) {
    if (typeof value !== "string") {
      continue;
    }
    const parsed = Number(value.replace(/[^\d.]/g, ""));
    if (!Number.isFinite(parsed) || parsed <= 0) {
      continue;
    }
    out[dateIso] = Math.round(parsed);
  }

  return out;
}

function inferTypicalNightly(raw: RawListing): {
  typicalPricingMonth: string;
  typicalBaseNightly: number;
  typicalAllInNightly: number;
} {
  const rates = raw.calendarRates;
  const values: number[] = [];

  if (rates && typeof rates === "object") {
    for (const value of Object.values(rates)) {
      if (typeof value !== "string") {
        continue;
      }

      const normalized = Number(value.replace(/[^\d.]/g, ""));
      if (Number.isFinite(normalized) && normalized > 0) {
        values.push(normalized);
      }
    }
  }

  const month45 = new Date();
  month45.setDate(month45.getDate() + 45);
  const typicalPricingMonth = month45.toLocaleString("en-US", {
    month: "long",
  });

  if (values.length === 0) {
    return {
      typicalPricingMonth,
      typicalBaseNightly: 875,
      typicalAllInNightly: 1000,
    };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const medianNightly =
    sorted.length % 2 === 1
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2;
  const typicalAllInNightly = Math.ceil(medianNightly);

  return {
    typicalPricingMonth,
    typicalBaseNightly: Math.ceil(typicalAllInNightly * 0.88),
    typicalAllInNightly,
  };
}

function mapListing(raw: RawListing): DiscoverListing | null {
  const id = asString(raw.id) ?? null;
  const lat = toFiniteNumber(raw.coordinate?.latitude);
  const lng = toFiniteNumber(raw.coordinate?.longitude);

  if (!id || lat === null || lng === null) {
    return null;
  }

  const highlights = normalizeSanitizedTextList(raw.highlights);
  const spaces = normalizeSanitizedTextList(raw.spaces);
  const descriptionLines = normalizeSanitizedTextList(
    raw.description?.about?.items,
  );
  const allSignals = [...highlights, ...spaces, ...descriptionLines];

  const inferred = inferBedsFromHighlights(allSignals);
  const policyText = extractPolicyText(raw.policies?.items).join("\n");
  const allText = allSignals.join("\n");

  const bedrooms = Math.max(1, Math.round(inferred.bedrooms ?? 3));
  const bathroomsRaw = inferred.bathrooms ?? Math.max(1, bedrooms - 1);
  const bathrooms = Math.max(1, Math.round(bathroomsRaw * 2) / 2);
  const sleeps = Math.max(bedrooms * 2, inferred.sleeps ?? bedrooms * 2);

  const kingBeds =
    inferred.kingBeds > 0
      ? inferred.kingBeds
      : Math.max(1, Math.floor(bedrooms / 2));
  const queenBeds =
    inferred.queenBeds > 0
      ? inferred.queenBeds
      : Math.max(0, bedrooms - kingBeds);

  const area =
    asString(raw.address?.city) ??
    asString(raw.location?.title) ??
    asString(raw.address?.display) ??
    "30A";

  const gallery = extractGallery(raw.gallery);
  const imageUrls = extractGalleryUrls(raw.gallery);
  const amenities = extractAmenities(raw.amenities?.items);
  const nearbyPoints = extractNearbyPoints(raw.location?.nearbyPOIs);
  const faqHints = extractFaqHints(raw.faqs?.general);
  const checkTimes = extractCheckTimes(raw.policies?.items);

  const description =
    descriptionLines.find((line) => line.length > 60) ??
    descriptionLines[0] ??
    highlights.join(" • ");
  const trimmedDescription =
    description.length > 800
      ? `${description.slice(0, 797).trimEnd()}...`
      : description;

  const helpfulHints = uniqueStrings([
    ...extractPolicyText(raw.policies?.items).map((item) => sanitizeText(item)),
    ...faqHints,
  ]).slice(0, 8);

  const sleepingArrangements = uniqueStrings(
    spaces.filter((line) =>
      /bed|bedroom|bathroom|sleeps?|sofa|bunk|trundle/i.test(line),
    ),
  ).slice(0, 10);
  const hasPetsAllowed = /pets?\s+allowed|pet[-\s]?friendly/i.test(policyText);
  const hasNoPets = /no\s+pets?\s+allowed|pets?\s+not\s+allowed/i.test(
    policyText,
  );
  const nightlyPricing = inferTypicalNightly(raw);
  const availabilityCalendar = extractAvailabilityCalendar(raw);

  return {
    id,
    name: asString(raw.name) ?? `Listing ${id}`,
    area,
    community: area,
    bedrooms,
    bathrooms,
    sleeps,
    kingBeds,
    queenBeds,
    privatePool: /private\s+pool|\bpool\b/i.test(allText),
    beachfront:
      /beach\s?front|beachfront|oceanfront|waterfront|on\s+the\s+beach/i.test(
        allText,
      ),
    golfCart: /golf\s*cart|\blsv\b/i.test(allText),
    petsAllowed: hasNoPets ? false : hasPetsAllowed,
    accessible: /wheelchair|accessible|step[-\s]?free|mobility/i.test(allText),
    elevator: /\belevator\b|\blift\b/i.test(allText),
    previewImages: imageUrls,
    typicalPrice: inferTypicalPriceLabel(raw),
    typicalPricingMonth: nightlyPricing.typicalPricingMonth,
    typicalBaseNightly: nightlyPricing.typicalBaseNightly,
    typicalAllInNightly: nightlyPricing.typicalAllInNightly,
    description: trimmedDescription,
    highlightsList: uniqueStrings(highlights).slice(0, 10),
    helpfulHints,
    sleepingArrangements,
    amenitiesList: amenities.slice(0, 24),
    nearbyPoints: nearbyPoints.slice(0, 10),
    checkInTime: checkTimes.checkInTime,
    checkOutTime: checkTimes.checkOutTime,
    imageGallery: gallery.slice(0, 24),
    availabilityCalendar,
    lat,
    lng,
  };
}

export async function getDiscoverDemoListings(): Promise<DiscoverListing[]> {
  if (cachedListings) {
    return cachedListings;
  }

  const fileNames = (await readdir(LISTINGS_DIR))
    .filter((name) => name.endsWith(".json"))
    .sort(
      (a, b) =>
        Number(a.replace(/\.json$/, "")) - Number(b.replace(/\.json$/, "")),
    );

  const output: DiscoverListing[] = [];
  for (const fileName of fileNames) {
    if (output.length >= TARGET_LISTING_COUNT) {
      break;
    }

    const fullPath = path.join(LISTINGS_DIR, fileName);
    try {
      const rawText = await readFile(fullPath, "utf-8");
      const parsed = JSON.parse(rawText) as RawListing;
      const mapped = mapListing(parsed);
      if (!mapped) {
        continue;
      }
      output.push(mapped);
    } catch {
      // Skip malformed listing payloads and continue building the sample set.
    }
  }

  cachedListings = output;
  return output;
}
