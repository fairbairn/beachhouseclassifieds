import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";

import { executeProminence30SingleQuote } from "@/lib/pricing/quote-runtime/adapters/prominence30a";
import { runRuntimeAdapterQuoteCli } from "@/lib/pricing/quotes/shared/runtime-adapter-quote-runner";
import { normalizeAdapterQuoteScopeArgs } from "../quote-scope";
import type { DetailRecordBase, ScrapedLink, ScraperAdapter } from "../types";

type LuxuryDayCode = "A" | "U" | "I" | "O" | "X";

type LuxuryDetailRecord = DetailRecordBase & {
  title: string;
  h1: string;
  canonical_url: string;
  meta_description: string;
  description_expanded: string;
  rooms_guidance: string[];
  amenities: {
    categories: Record<string, string[]>;
    all: string[];
  };
  location: {
    address: string;
    location_label: string;
    directions_url: string;
    directions_daddr: string;
    latitude: number | null;
    longitude: number | null;
  };
  media_gallery: {
    image_count: number;
    image_urls: string[];
  };
  property_profile: {
    unit_id: string;
    area: string;
    location: string;
    beds: number | null;
    baths: number | null;
    sleeps: number | null;
    city: string;
    state: string;
  };
  quote_context: {
    source: "description_expanded";
    item_eid: string;
    type_id: string;
    inventory_id: string;
    detail_url: string;
  };
  normalized_matching_profile: {
    source: "pm_prominence30a";
    external_listing_id: string;
    name: string;
    description: string;
    match_signals: {
      description_normalized: string;
      description_sha256: string;
      title_normalized: string;
      title_sha256: string;
      listing_composite_key: string;
    };
  };
  normalized_availability: {
    source: "pm_prominence30a";
    external_listing_id: string;
    captured_at: string;
    has_calendar_widget: boolean;
    booking_restrictions: string[];
    min_night_rules: Array<{
      start_date: string;
      end_date: string;
      min_nights: number;
      raw_rule: string;
    }>;
    window_start: string;
    window_end: string;
    code_legend: {
      A: "available";
      U: "unavailable";
      I: "checkin_only";
      O: "checkout_only";
      X: "other";
    };
    day_codes: string;
    days: Array<{
      date: string;
      status_code: LuxuryDayCode;
      is_available: boolean;
      is_available_for_checkin: boolean;
      is_available_for_checkout: boolean;
      booking_day_state: "bookable" | "blocked" | "unknown";
      min_nights_required: number | null;
    }>;
    counts: {
      available: number;
      unavailable: number;
      checkin_only: number;
      checkout_only: number;
      other: number;
      booking_available: number;
      booking_unavailable: number;
      booking_unknown: number;
    };
  };
  scrape_metrics: {
    total_ms: number;
    page_load_ms: number;
    extraction_ms: number;
    calendar_clicks: number;
    calendar_iterations: number;
  };
};

const DEFAULT_ANCHOR_URL =
  "https://www.prominenceon30a.com/30a-vacation-rentals#q=*%3A*";
const EXPECTED_LISTING_COUNT = 60;
const DETAIL_PATH_PREFIXES = ["/30a-vacation-rentals/", "/vacation-rentals/"];
const OUTPUT_ROOT = resolve(
  process.cwd(),
  "src",
  "lib",
  "data",
  "external-sources",
  "prominence30a",
);
const OUTPUT_DETAILS_HTML_DIR = resolve(OUTPUT_ROOT, "details", "html");

function normalizeLink(url: string): string {
  return url.split("#")[0]?.replace(/\/$/, "") ?? url;
}

function normalizeDetailUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`.replace(/\/$/, "");
  } catch {
    return normalizeLink(url);
  }
}

function isLikelyDetailPath(pathname: string): boolean {
  const normalizedPath = pathname.toLowerCase().replace(/\/+$/, "");
  const matchedPrefix = DETAIL_PATH_PREFIXES.find((prefix) =>
    normalizedPath.startsWith(prefix),
  );
  if (!matchedPrefix) {
    return false;
  }

  const slug = normalizedPath.split("/").filter(Boolean).at(-1) ?? "";
  const collectionSlug = matchedPrefix.split("/").filter(Boolean).at(-1) ?? "";
  if (
    !slug ||
    slug === collectionSlug ||
    slug === "search-results" ||
    slug === "results"
  ) {
    return false;
  }

  return /^[a-z0-9][a-z0-9-]*$/i.test(slug);
}

function normalizeForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/&amp;/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hashSha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stripHtml(value: string): string {
  return value
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function extractRcavIdentity(input: {
  listingId: string;
  descriptionExpanded: string;
  detailHtml: string;
}): {
  itemEid: string;
  typeId: string;
  inventoryId: string;
} {
  const source = `${input.detailHtml}\n${input.descriptionExpanded}`;
  const decodedSource = safeDecodeURIComponent(source);

  const rcavIdPattern = /rcav\[IDs\]\[(\d+)\]\[(?:0)?\]=(\d+)/i;
  const encodedRcavIdPattern = /rcav%5BIDs%5D%5B(\d+)\]%5B(?:0)?%5D=(\d+)/i;
  const rcavEidPattern = /rcav\[eid\]=(\d+)/i;
  const encodedRcavEidPattern = /rcav%5Beid%5D=(\d+)/i;

  const decodedIdMatch = decodedSource.match(rcavIdPattern);
  const encodedIdMatch = source.match(encodedRcavIdPattern);
  const typeId = decodedIdMatch?.[1] ?? encodedIdMatch?.[1] ?? null;
  const inventoryId = decodedIdMatch?.[2] ?? encodedIdMatch?.[2] ?? null;

  const decodedEidMatch = decodedSource.match(rcavEidPattern);
  const encodedEidMatch = source.match(encodedRcavEidPattern);
  const itemEid = decodedEidMatch?.[1] ?? encodedEidMatch?.[1] ?? null;

  if (itemEid && typeId && inventoryId) {
    return {
      itemEid,
      typeId,
      inventoryId,
    };
  }

  const exactEntityMatch = source.match(
    /'entity':\{'eid':'(\d+)'.*?'id':'(\d+)'.*?'type':'(\d+)'/s,
  );
  if (exactEntityMatch) {
    return {
      itemEid: exactEntityMatch[1],
      inventoryId: exactEntityMatch[2],
      typeId: exactEntityMatch[3],
    };
  }

  const fallbackMatch = source.match(
    /'eid':'(\d+)','engine_eid':'\d+','id':'(\d+)'.*?'type':'(\d+)'/s,
  );
  if (fallbackMatch) {
    return {
      itemEid: fallbackMatch[1],
      inventoryId: fallbackMatch[2],
      typeId: fallbackMatch[3],
    };
  }

  throw new Error(
    `Missing rcav identity fields for listing ${input.listingId}`,
  );
}

function normalizeListingName(value: string): string {
  const cleaned = stripHtml(value)
    .replace(/\b\d+(?:\.\d+)?\s*BR\b/gi, " ")
    .replace(/\b\d+(?:\.\d+)?\s*BA\b/gi, " ")
    .replace(/\b\d+\s*Guests?\b/gi, " ")
    .replace(/\bBeds?\b/gi, " ")
    .replace(/\bBaths?\b/gi, " ")
    .replace(/\s*[|-]\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned.slice(0, 240);
}

function stripProminenceBrandPrefix(value: string): string {
  return value.replace(/^\s*prominence\s+on\s+30a\b[\s:-]*/i, "").trim();
}

function dedupePreserveOrder(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function extractRoomDetailsGuidanceFromHtml(html: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const hasSleepSignal = (value: string): boolean =>
    /king|queen|full|double|twin|single|bunk|trundle|murphy|sofa\s*bed|sleeper|daybed|futon|sleeps?/i.test(
      value,
    );

  const sectionMatch = html.match(
    /<section[^>]*id=["']room-details["'][^>]*>([\s\S]*?)<\/section>/i,
  );
  const sectionHtml = sectionMatch?.[1] ?? html;

  const tables = Array.from(
    sectionHtml.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi),
  );
  for (const tableMatch of tables) {
    const tableHtml = tableMatch[1] ?? "";
    const headerText = stripHtml(tableHtml).toLowerCase();
    if (!headerText.includes("room") || !headerText.includes("beds")) {
      continue;
    }

    const rows = Array.from(tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi));
    for (const rowMatch of rows) {
      const rowHtml = rowMatch[1] ?? "";
      const cells = Array.from(rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi));
      if (cells.length < 2) {
        continue;
      }

      const room = stripHtml(cells[0]?.[1] ?? "")
        .replace(/\s+/g, " ")
        .trim();
      const beds = stripHtml(cells[1]?.[1] ?? "")
        .replace(/\s+/g, " ")
        .trim();
      const comments = stripHtml(cells[4]?.[1] ?? "")
        .replace(/\s+/g, " ")
        .trim();

      if (!room) {
        continue;
      }

      const signal = `${room} ${beds} ${comments}`;
      if (!hasSleepSignal(signal)) {
        continue;
      }

      const lineCore = beds ? `${room}: ${beds}` : room;
      const line = comments ? `${lineCore} - ${comments}` : lineCore;
      if (!line || seen.has(line)) {
        continue;
      }

      seen.add(line);
      out.push(line);
    }
  }

  return out.slice(0, 80);
}

function extractRoomDetailsGuidanceFromDescription(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const hasSleepSignal = (value: string): boolean =>
    /king|queen|full|double|twin|single|bunk|trundle|murphy|sofa\s*bed|sleeper|daybed|futon/i.test(
      value,
    );

  const hasLayoutSignal = (value: string): boolean =>
    /bedroom|guest\s*room|guestroom|master|bunk\s*room|bunk\s*area|loft|sleeper\s*sofa|additional\s*bedding|sleeping\s*arrangements/i.test(
      value,
    );

  const normalized = stripHtml(text).replace(/\s+/g, " ").trim();

  const pushIfValid = (value: string): void => {
    const chunk = value.replace(/\s+/g, " ").trim();
    if (chunk.length < 12 || chunk.length > 220) {
      return;
    }
    if (!hasSleepSignal(chunk) || !hasLayoutSignal(chunk)) {
      return;
    }
    if (seen.has(chunk)) {
      return;
    }

    seen.add(chunk);
    out.push(chunk);
  };

  // First pass: extract compact room-detail snippets from natural prose.
  const matches = Array.from(
    normalized.matchAll(
      /(?:\b(?:first|second|third|1st|2nd|3rd)\b\s*)?(?:\b(?:bedroom|guest\s*room|guestroom|master|bunk\s*room|bunk\s*area|loft|additional\s*bedding|sleeping\s*arrangements)\b)[^*\n\.]{0,220}/gi,
    ),
  ).map((match) => (match[0] ?? "").replace(/\s+/g, " ").trim());

  for (const chunk of matches) {
    pushIfValid(chunk);
  }

  // Second pass: capture bullet/feature lines like "Bedroom 1: King bed ...".
  const bulletCandidates = normalized
    .split(/\s*(?:\u2022|\|)\s*/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 12 && part.length <= 280);
  for (const candidate of bulletCandidates) {
    const trimmed = candidate.replace(/^[\-:;,\s]+/, "").trim();
    if (!trimmed) {
      continue;
    }

    // Keep only the leading room phrase to avoid pulling full marketing paragraphs.
    const roomPhrase = trimmed
      .split(
        /(?=\b(?:bedroom\s*\d+|bathroom\s*\d+|sleeps?\b|about\b|features\b))|(?=\s{2,})/i,
      )[0]
      ?.trim();
    if (!roomPhrase) {
      continue;
    }

    pushIfValid(roomPhrase);
  }

  // Third pass: handle inline bedroom sequences in one long sentence.
  const roomLabelPattern =
    /\b(?:\d+(?:st|nd|rd|th)\s+bedroom|bedroom\s*\d+|bedroom|guest\s*room|master\s*bedroom|bunk\s*room|sleeping\s*arrangements)\b/gi;
  const labelMatches = Array.from(normalized.matchAll(roomLabelPattern));
  for (let index = 0; index < labelMatches.length; index += 1) {
    const start = labelMatches[index]?.index;
    if (typeof start !== "number") {
      continue;
    }

    const nextStart = labelMatches[index + 1]?.index;
    const rawSlice = normalized.slice(start, nextStart ?? start + 220);
    const bounded = rawSlice
      .split(
        /\b(?:half\s+bathroom|bathroom\s*\d+|full-size\s+washer|complimentary|sleeps?\b|about\s+prominence|community|bonus\s+perks)\b/i,
      )[0]
      ?.trim();
    if (!bounded) {
      continue;
    }

    pushIfValid(bounded);
  }

  return out.slice(0, 80);
}

function parseFirstNumber(value: string): number | null {
  const match = value.match(/\d+(?:\.\d+)?/);
  if (!match) {
    return null;
  }
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseCityStateFromAddress(address: string): {
  city: string;
  state: string;
} {
  const compact = address.replace(/\s+/g, " ").trim();
  if (!compact) {
    return { city: "", state: "" };
  }

  const stateZipMatch = compact.match(/\b([A-Z]{2})\s+\d{5}(?:-\d{4})?\b/);
  const state = stateZipMatch?.[1] ?? "";
  const parts = compact
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  let city = "";
  if (parts.length >= 2) {
    const candidate = parts[parts.length - 2] ?? "";
    city = /\d/.test(candidate) ? "" : candidate;
  }

  return { city, state };
}

function normalizeGalleryUrl(rawUrl: string): string {
  const cleaned = rawUrl.trim();
  if (!cleaned) {
    return "";
  }

  try {
    const decoded = cleaned.replace(/&amp;/gi, "&");
    const parsed = new URL(decoded);

    // Rezfusion image endpoints encode the real image in `source`.
    const source = parsed.searchParams.get("source")?.trim();
    if (source) {
      try {
        const resolvedSource = new URL(
          decodeURIComponent(source),
          parsed.origin,
        );
        return `${resolvedSource.origin}${resolvedSource.pathname}${resolvedSource.search}`;
      } catch {
        // Fall through to normalized Rezfusion URL.
      }
    }

    return `${parsed.origin}${parsed.pathname}${parsed.search}`;
  } catch {
    return "";
  }
}

function extractCandidateImageWidth(url: URL): number {
  const searchWidth = Number(url.searchParams.get("width") ?? "");
  const searchW = Number(url.searchParams.get("w") ?? "");
  const pathWidthMatch = url.pathname.match(/\/width=(\d+)/i);
  const pathWidth = pathWidthMatch ? Number(pathWidthMatch[1]) : NaN;

  return Math.max(
    Number.isFinite(searchWidth) ? searchWidth : 0,
    Number.isFinite(searchW) ? searchW : 0,
    Number.isFinite(pathWidth) ? pathWidth : 0,
  );
}

function buildGalleryVariantKey(url: URL): string {
  const filtered = new URLSearchParams();
  const variantParams = new Set([
    "width",
    "w",
    "height",
    "h",
    "quality",
    "q",
    "dpr",
    "fit",
    "crop",
    "auto",
    "format",
    "fm",
  ]);

  for (const [key, value] of url.searchParams.entries()) {
    if (variantParams.has(key.toLowerCase())) {
      continue;
    }
    filtered.append(key, value);
  }

  const query = filtered.toString();
  return `${url.origin}${url.pathname}${query ? `?${query}` : ""}`;
}

function dedupePreferLargestGalleryVariants(values: string[]): string[] {
  const byKey = new Map<
    string,
    {
      key: string;
      url: string;
      width: number;
      firstSeen: number;
    }
  >();

  for (const [index, value] of values.entries()) {
    const normalized = value.trim();
    if (!normalized) {
      continue;
    }

    try {
      const parsed = new URL(normalized);
      const key = buildGalleryVariantKey(parsed);
      const width = extractCandidateImageWidth(parsed);
      const existing = byKey.get(key);

      if (!existing) {
        byKey.set(key, {
          key,
          url: normalized,
          width,
          firstSeen: index,
        });
        continue;
      }

      if (width > existing.width) {
        byKey.set(key, {
          ...existing,
          url: normalized,
          width,
        });
      }
    } catch {
      const existing = byKey.get(normalized);
      if (!existing) {
        byKey.set(normalized, {
          key: normalized,
          url: normalized,
          width: 0,
          firstSeen: index,
        });
      }
    }
  }

  return Array.from(byKey.values())
    .sort((left, right) => left.firstSeen - right.firstSeen)
    .map((entry) => entry.url);
}

function filterGallerySourceNoise(values: string[]): string[] {
  const hasRezfusion = values.some(
    (value) =>
      /images\.rezfusion\.com/i.test(value) || /\/vrm-img\//i.test(value),
  );
  if (!hasRezfusion) {
    return values;
  }

  return values.filter((value) => !/picturehandler\.ashx/i.test(value));
}

function extractGoogleMapsLlFromHtml(html: string): {
  latitude: number;
  longitude: number;
} | null {
  const hrefMatch = html.match(
    /href=["']https?:\/\/maps\.google\.com\/maps\?([^"']+)["']/i,
  );
  const querySource = hrefMatch?.[1] ?? "";
  if (!querySource) {
    return null;
  }

  const decodedQuery = querySource.replace(/&amp;/gi, "&");
  const llMatch = decodedQuery.match(
    /(?:^|[&?])ll=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/i,
  );
  if (!llMatch) {
    return null;
  }

  const latitude = Number(llMatch[1]);
  const longitude = Number(llMatch[2]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }

  return {
    latitude,
    longitude,
  };
}

function extractFieldLocationFromHtml(html: string): {
  street: string;
  latitude: number | null;
  longitude: number | null;
} {
  const widgetMatch = html.match(
    /<div[^>]+class=["'][^"']*be-property-widget[^"']*["'][^>]*>/i,
  );
  const widgetTag = widgetMatch?.[0] ?? "";

  const attrValue = (name: string): string => {
    const match = widgetTag.match(new RegExp(`${name}=["']([^"']*)["']`, "i"));
    return (match?.[1] ?? "").trim();
  };

  const numericAttrValue = (name: string): number => {
    const raw = attrValue(name);
    if (!raw) {
      return Number.NaN;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  };

  const streetFromWidget = attrValue("data-straddress1");
  const latitudeFromWidget = numericAttrValue("data-latitude");
  const longitudeFromWidget = numericAttrValue("data-longitude");

  const fieldLocationChunkMatch = html.match(
    /["']field_location["']\s*:\s*\{[\s\S]*?\}\s*,\s*["']field_teaser_image["']/i,
  );
  const fieldLocationChunk = fieldLocationChunkMatch
    ? fieldLocationChunkMatch[0]
    : html;

  const streetMatch = fieldLocationChunk.match(
    /["']?street["']?\s*:\s*["']([^"']*)["']/i,
  );
  const latitudeMatch = fieldLocationChunk.match(
    /["']?latitude["']?\s*:\s*["']?(-?\d+(?:\.\d+)?)["']?/i,
  );
  const longitudeMatch = fieldLocationChunk.match(
    /["']?longitude["']?\s*:\s*["']?(-?\d+(?:\.\d+)?)["']?/i,
  );

  const street = streetMatch?.[1]
    ? streetMatch[1]
        .replace(/\\\//g, "/")
        .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
          String.fromCharCode(Number.parseInt(hex, 16)),
        )
        .replace(/\\"/g, '"')
        .trim()
    : "";

  const latitude = latitudeMatch ? Number(latitudeMatch[1]) : NaN;
  const longitude = longitudeMatch ? Number(longitudeMatch[1]) : NaN;
  const latLngPairMatch = html.match(
    /["']latitude["']\s*:\s*(-?\d+(?:\.\d+)?)[\s\S]{0,120}?["']longitude["']\s*:\s*(-?\d+(?:\.\d+)?)/i,
  );
  const lngLatPairMatch = html.match(
    /["']longitude["']\s*:\s*(-?\d+(?:\.\d+)?)[\s\S]{0,120}?["']latitude["']\s*:\s*(-?\d+(?:\.\d+)?)/i,
  );
  const atCoordMatch = html.match(/@(-?\d+\.\d+),\s*(-?\d+\.\d+)/i);
  const maps3d4dMatch = html.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/i);
  const googleMapsLl = extractGoogleMapsLlFromHtml(html);
  const genericLlMatch = html.match(
    /[?&]ll=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/i,
  );

  const latitudeFallback = latLngPairMatch?.[1]
    ? Number(latLngPairMatch[1])
    : lngLatPairMatch?.[2]
      ? Number(lngLatPairMatch[2])
      : atCoordMatch?.[1]
        ? Number(atCoordMatch[1])
        : maps3d4dMatch?.[1]
          ? Number(maps3d4dMatch[1])
          : googleMapsLl?.latitude
            ? googleMapsLl.latitude
            : genericLlMatch?.[1]
              ? Number(genericLlMatch[1])
              : NaN;
  const longitudeFallback = latLngPairMatch?.[2]
    ? Number(latLngPairMatch[2])
    : lngLatPairMatch?.[1]
      ? Number(lngLatPairMatch[1])
      : atCoordMatch?.[2]
        ? Number(atCoordMatch[2])
        : maps3d4dMatch?.[2]
          ? Number(maps3d4dMatch[2])
          : googleMapsLl?.longitude
            ? googleMapsLl.longitude
            : genericLlMatch?.[2]
              ? Number(genericLlMatch[2])
              : NaN;

  const latitudeResolved = Number.isFinite(latitudeFromWidget)
    ? latitudeFromWidget
    : Number.isFinite(latitude)
      ? latitude
      : Number.isFinite(latitudeFallback)
        ? latitudeFallback
        : NaN;
  const longitudeResolved = Number.isFinite(longitudeFromWidget)
    ? longitudeFromWidget
    : Number.isFinite(longitude)
      ? longitude
      : Number.isFinite(longitudeFallback)
        ? longitudeFallback
        : NaN;

  const aboutAddressMatch = html.match(
    /listing-about[\s\S]*?<strong>[^<~]*~\s*([^<~]+?)\s*~\s*([^<]+?)<\/strong>/i,
  );
  const aboutAddress = aboutAddressMatch
    ? `${aboutAddressMatch[1]?.trim() ?? ""}, ${aboutAddressMatch[2]?.trim() ?? ""}`
    : "";

  return {
    street: streetFromWidget || street || aboutAddress,
    latitude: Number.isFinite(latitudeResolved) ? latitudeResolved : null,
    longitude: Number.isFinite(longitudeResolved) ? longitudeResolved : null,
  };
}

function extractListingAboutFromHtml(html: string): string {
  const aboutMatch = html.match(
    /<div[^>]+id=["']listing-about["'][^>]*>([\s\S]*?)(?:<div[^>]+class=["'][^"']*listing-about-read-more[^"']*["']|<div[^>]+id=["']listing-features["'])/i,
  );
  if (!aboutMatch?.[1]) {
    return "";
  }

  return stripHtml(aboutMatch[1]).slice(0, 30000);
}

function extractExternalListingId(detailUrl: string): string {
  try {
    const parsed = new URL(detailUrl);
    const parts = parsed.pathname.split("/").filter(Boolean);
    return parts[parts.length - 1] ?? parsed.pathname;
  } catch {
    return detailUrl;
  }
}

async function installEvaluateNameShim(page: Page): Promise<void> {
  const shim = "window.__name = window.__name || ((target) => target);";
  await page.addInitScript(shim);
  await page.evaluate(shim);
}

async function clickTab(page: Page, tabText: string): Promise<boolean> {
  const target = tabText.toLowerCase();
  const result = await page.evaluate((targetText) => {
    const nodes = Array.from(
      document.querySelectorAll("a, button, [role='tab'], [role='button']"),
    );

    for (const node of nodes) {
      const element = node as HTMLElement;
      if (element.offsetParent === null) {
        continue;
      }

      if (element.tagName.toLowerCase() === "a") {
        const href = (element.getAttribute("href") ?? "").trim().toLowerCase();
        if (href && !href.startsWith("#") && !href.startsWith("javascript:")) {
          continue;
        }
      }

      const label = [
        element.textContent ?? "",
        element.getAttribute("aria-label") ?? "",
        element.getAttribute("title") ?? "",
      ]
        .join(" ")
        .toLowerCase();

      if (!label.includes(targetText)) {
        continue;
      }

      element.click();
      return true;
    }

    return false;
  }, target);

  if (result) {
    await page.waitForTimeout(900);
  }
  return result;
}

async function clickVisibleControlsByLabel(
  page: Page,
  labels: string[],
): Promise<number> {
  const lowered = labels.map((label) => label.toLowerCase());
  const clicked = await page.evaluate((targets) => {
    let clicks = 0;
    const nodes = Array.from(
      document.querySelectorAll(
        "a, button, [role='button'], [role='tab'], [data-action], [aria-label], [title]",
      ),
    );

    for (const node of nodes) {
      const element = node as HTMLElement;
      if (element.offsetParent === null) {
        continue;
      }

      if (element.tagName.toLowerCase() === "a") {
        const href = (element.getAttribute("href") ?? "").trim().toLowerCase();
        if (href && !href.startsWith("#") && !href.startsWith("javascript:")) {
          continue;
        }
      }

      const label = [
        element.textContent ?? "",
        element.getAttribute("aria-label") ?? "",
        element.getAttribute("title") ?? "",
      ]
        .join(" ")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();

      if (!label) {
        continue;
      }

      if (!targets.some((target) => label.includes(target))) {
        continue;
      }

      element.click();
      clicks += 1;
    }

    return clicks;
  }, lowered);

  if (clicked > 0) {
    await page.waitForTimeout(700);
  }

  return clicked;
}

async function discoverListings(
  page: Page,
  anchorUrl: string,
  maxScrollSteps: number,
  scrollPauseMs: number,
  _networkIdleWaitMs: number,
  reportProgress: (message: string) => void,
): Promise<ScrapedLink[]> {
  await installEvaluateNameShim(page);

  await page.goto(anchorUrl, {
    waitUntil: "domcontentloaded",
    timeout: 120000,
  });
  await page.waitForTimeout(Math.max(1500, scrollPauseMs));

  // Panhandle often starts above a heavy hero/nav fold; force list context first.
  await clickTab(page, "list view").catch(() => false);
  await page.waitForTimeout(Math.max(700, scrollPauseMs));

  await page.evaluate(() => {
    const root = document.querySelector("riot-solr-result-list, .result-list");
    if (!root) {
      return;
    }

    const top = Math.max(
      0,
      window.scrollY + root.getBoundingClientRect().top - 120,
    );
    window.scrollTo(0, top);
  });
  await page.waitForTimeout(Math.max(500, scrollPauseMs));

  const readDiscoverySnapshot = async (): Promise<{
    rows: Array<{ href: string; text: string }>;
    expectedCount: number | null;
  }> =>
    page.evaluate(() => {
      const rows: Array<{ href: string; text: string }> = [];
      const seen = new Set<string>();

      const toNormalized = (hrefValue: string): string => {
        try {
          const absolute = new URL(hrefValue, window.location.origin);
          if (!absolute.hostname.endsWith("prominenceon30a.com")) {
            return "";
          }

          const normalizedPath = absolute.pathname
            .toLowerCase()
            .replace(/\/+$/, "");
          const matchesExpectedPrefix = [
            "/30a-vacation-rentals/",
            "/all-30a-vacation-rentals/",
            "/vacation-rentals/",
          ].some((prefix) => normalizedPath.startsWith(prefix));
          if (!matchesExpectedPrefix) {
            return "";
          }

          const slug = normalizedPath.split("/").filter(Boolean).at(-1) ?? "";
          if (
            !slug ||
            slug === "30a-vacation-rentals" ||
            slug === "all-30a-vacation-rentals" ||
            slug === "vacation-rentals" ||
            slug === "search-results" ||
            slug === "results" ||
            slug === "glossary"
          ) {
            return "";
          }

          if (!/^[a-z0-9][a-z0-9-]*$/i.test(slug)) {
            return "";
          }

          return `${absolute.origin}${absolute.pathname}`.replace(/\/$/, "");
        } catch {
          return "";
        }
      };

      const resultRoots = Array.from(
        document.querySelectorAll(
          "#properties, .props-container, .properties, .property-wrap, riot-solr-result-list, .result-list",
        ),
      );

      const resultAnchors =
        resultRoots.length > 0
          ? resultRoots.flatMap((root) =>
              Array.from(root.querySelectorAll("a[href]")),
            )
          : Array.from(document.querySelectorAll("a[href]"));

      for (const anchor of resultAnchors) {
        const hrefRaw =
          (anchor as HTMLAnchorElement).getAttribute("href") ?? "";
        if (!hrefRaw) {
          continue;
        }

        const normalized = toNormalized(hrefRaw);
        if (!normalized || seen.has(normalized)) {
          continue;
        }

        seen.add(normalized);
        rows.push({
          href: normalized,
          text: ((anchor as HTMLAnchorElement).textContent ?? "")
            .replace(/\s+/g, " ")
            .trim(),
        });
      }

      const resultNodesWithHref =
        resultRoots.length > 0
          ? resultRoots.flatMap((root) =>
              Array.from(
                root.querySelectorAll<HTMLElement>(
                  "[data-href], [data-url], [data-link]",
                ),
              ),
            )
          : [];

      for (const node of resultNodesWithHref) {
        const hrefRaw =
          node.getAttribute("data-href") ??
          node.getAttribute("data-url") ??
          node.getAttribute("data-link") ??
          "";

        if (!hrefRaw) {
          continue;
        }

        const normalized = toNormalized(hrefRaw);
        if (!normalized || seen.has(normalized)) {
          continue;
        }

        seen.add(normalized);
        rows.push({
          href: normalized,
          text: (node.textContent ?? "").replace(/\s+/g, " ").trim(),
        });
      }

      let expectedCount: number | null = null;
      const bodyText = document.body?.innerText ?? "";
      const match = bodyText.match(
        /\b(\d{1,4})\s+(?:results|rentals|properties)\b/i,
      );
      if (match) {
        const parsed = Number(match[1]);
        if (Number.isFinite(parsed) && parsed > 0) {
          expectedCount = Math.floor(parsed);
        }
      }

      return {
        rows,
        expectedCount,
      };
    });

  let discovery = await readDiscoverySnapshot();
  let previousCount = discovery.rows.length;
  let stagnantSteps = 0;
  // Panhandle relies on long-running incremental lazy load; allow deeper passes.
  const effectiveScrollSteps = Math.max(120, maxScrollSteps);
  const effectivePauseMs = Math.max(320, Math.min(scrollPauseMs, 1200));
  const wheelDelta = Math.max(
    560,
    Math.floor((page.viewportSize()?.height ?? 900) * 0.85),
  );

  if (discovery.expectedCount !== null) {
    reportProgress(
      `discovery expected count from page=${discovery.expectedCount}, initial captured=${discovery.rows.length}`,
    );
  } else {
    reportProgress(
      `discovery expected count (planner target)=${EXPECTED_LISTING_COUNT}, initial captured=${discovery.rows.length}`,
    );
  }

  for (let step = 0; step < effectiveScrollSteps; step += 1) {
    if (
      discovery.expectedCount !== null &&
      discovery.rows.length >= discovery.expectedCount
    ) {
      reportProgress(
        `discovery reached expected count after scroll step ${step}: ${discovery.rows.length}/${discovery.expectedCount}`,
      );
      break;
    }

    await page.mouse.wheel(0, wheelDelta);
    await page.evaluate(() => {
      window.scrollBy(0, Math.floor(window.innerHeight * 0.5));
    });
    await page.waitForTimeout(effectivePauseMs);

    discovery = await readDiscoverySnapshot();
    if (discovery.rows.length > previousCount) {
      reportProgress(
        `discovery grew to ${discovery.rows.length}${
          discovery.expectedCount ? `/${discovery.expectedCount}` : ""
        } at scroll step ${step + 1}`,
      );
      previousCount = discovery.rows.length;
      stagnantSteps = 0;
      continue;
    }

    stagnantSteps += 1;
    if (stagnantSteps >= 24 && step >= 100) {
      break;
    }
  }

  if (discovery.expectedCount !== null) {
    reportProgress(
      `discovery final captured=${discovery.rows.length}/${discovery.expectedCount}`,
    );
  } else {
    reportProgress(`discovery final captured=${discovery.rows.length}`);
  }

  return discovery.rows.map((row) => ({
    link: normalizeDetailUrl(row.href),
    source_url: anchorUrl,
    anchor_text: row.text,
  }));
}

async function extractAvailabilitySnapshot(page: Page): Promise<{
  hasCalendarWidget: boolean;
  months: string[];
  items: Array<{ date: string; code: LuxuryDayCode }>;
  bookingRestrictions: string[];
}> {
  return page.evaluate(() => {
    const items: Array<{ date: string; code: LuxuryDayCode }> = [];
    const monthHeaders = Array.from(
      document.querySelectorAll(
        ".pdp-availability-calendar-container .mb-2 strong, .pdp-availability-calendar-container .mb-2",
      ),
    )
      .map((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim())
      .filter(Boolean);

    for (const cell of Array.from(document.querySelectorAll("td[data-date]"))) {
      const rawDate = (cell.getAttribute("data-date") ?? "").trim();
      const match = rawDate.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (!match) {
        continue;
      }

      const month = Number(match[1]);
      const day = Number(match[2]);
      const year = Number(match[3]);
      if (
        !Number.isFinite(month) ||
        !Number.isFinite(day) ||
        !Number.isFinite(year)
      ) {
        continue;
      }

      const isoDate = new Date(Date.UTC(year, month - 1, day))
        .toISOString()
        .slice(0, 10);

      const classBlob = String(
        (cell as HTMLElement).className || "",
      ).toLowerCase();
      let code: LuxuryDayCode = "X";
      if (classBlob.includes("check-in")) {
        code = "I";
      } else if (classBlob.includes("check-out")) {
        code = "O";
      } else if (classBlob.includes("available")) {
        code = "A";
      } else if (
        classBlob.includes("booked") ||
        classBlob.includes("unavailable")
      ) {
        code = "U";
      }

      items.push({ date: isoDate, code });
    }

    // Legacy rcav calendar tables expose month/day in table captions and td classes.
    for (const table of Array.from(
      document.querySelectorAll(
        ".rcav-calendar .rc-calendar, table.rc-calendar",
      ),
    )) {
      const captionText =
        table
          .querySelector("caption")
          ?.textContent?.replace(/\s+/g, " ")
          .trim() ?? "";
      const monthMatch = captionText.match(/([A-Za-z]+)\s+(\d{4})/);
      if (!monthMatch) {
        continue;
      }

      const monthIndex = new Date(
        `${monthMatch[1]} 1, ${monthMatch[2]}`,
      ).getMonth();
      const year = Number(monthMatch[2]);
      if (!Number.isFinite(monthIndex) || !Number.isFinite(year)) {
        continue;
      }

      for (const dayCell of Array.from(
        table.querySelectorAll<HTMLElement>("td.day"),
      )) {
        const dayText =
          dayCell
            .querySelector(".mday")
            ?.textContent?.replace(/\s+/g, " ")
            .trim() ?? "";
        const day = Number(dayText);
        if (!Number.isFinite(day) || day < 1 || day > 31) {
          continue;
        }

        const isoDate = new Date(Date.UTC(year, monthIndex, day))
          .toISOString()
          .slice(0, 10);

        const classBlob = dayCell.className.toLowerCase();
        let code: LuxuryDayCode = "X";
        if (classBlob.includes("av-a") || classBlob.includes("av-o")) {
          code = "A";
        } else if (classBlob.includes("av-in")) {
          code = "I";
        } else if (classBlob.includes("av-out")) {
          code = "O";
        } else if (classBlob.includes("av-x") || classBlob.includes("av-u")) {
          code = "U";
        }

        items.push({ date: isoDate, code });
      }
    }

    const keyText = Array.from(
      document.querySelectorAll(
        ".be-calendar-legend-key-text, .rcav-key, .bre-ui-datepicker-extras, .label",
      ),
    )
      .map((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .filter((row) =>
        /night available|night unavailable|arrive only|depart only|check-in only|available|unavailable/i.test(
          row,
        ),
      );

    return {
      hasCalendarWidget: !!document.querySelector(
        ".pdp-availability-calendar, .pdp-availability-calendar-table, .ui-datepicker, .ui-datepicker-inline, .rcav-key, .rcav-calendar, table.rc-calendar",
      ),
      months: Array.from(new Set(monthHeaders)),
      items,
      bookingRestrictions: Array.from(new Set(keyText)).slice(0, 40),
    };
  });
}

async function extractDescriptionText(page: Page): Promise<string> {
  await clickTab(page, "Description");

  return page.evaluate(() => {
    const candidates: string[] = [];
    const selectors = [
      "#listing-about",
      "#listing-about p",
      ".listing-about-read-more",
      "#description",
      "[id*='description']",
      "[class*='description']",
      ".property-description",
      ".unit-description",
      ".tab-content",
      "[role='tabpanel']",
    ];

    for (const selector of selectors) {
      for (const node of Array.from(document.querySelectorAll(selector))) {
        const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
        if (text.length < 80) {
          continue;
        }

        candidates.push(text);
      }
    }

    candidates.sort((left, right) => right.length - left.length);
    return candidates[0] ?? "";
  });
}

async function extractRoomDetailsGuidanceFromDom(
  page: Page,
): Promise<string[]> {
  await clickTab(page, "Room Details");

  return page.evaluate(() => {
    const normalizeText = (value: string): string =>
      value.replace(/\s+/g, " ").trim();

    const hasSleepSignal = (value: string): boolean =>
      /king|queen|full|double|twin|single|bunk|trundle|murphy|sofa\s*bed|sleeper|daybed|futon|sleeps?/i.test(
        value,
      );

    const out: string[] = [];
    const seen = new Set<string>();

    const tables = Array.from(
      document.querySelectorAll(
        '#room-details table, .streamline-rooms-details table, table[ng-if*="room_details"], table.table-bordered',
      ),
    );

    for (const table of tables) {
      const headerTexts = Array.from(table.querySelectorAll("thead th"))
        .map((header) => normalizeText(header.textContent ?? "").toLowerCase())
        .filter(Boolean);

      if (
        !headerTexts.includes("room details") ||
        !headerTexts.includes("beds")
      ) {
        continue;
      }

      const rows = Array.from(table.querySelectorAll("tbody tr"));
      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll("td"));
        if (cells.length < 2) {
          continue;
        }

        const room = normalizeText(cells[0]?.textContent ?? "");
        const beds = normalizeText(cells[1]?.textContent ?? "");
        const comments = normalizeText(cells[4]?.textContent ?? "");
        if (!room) {
          continue;
        }

        const signal = `${room} ${beds} ${comments}`;
        if (!hasSleepSignal(signal)) {
          continue;
        }

        const lineCore = beds ? `${room}: ${beds}` : room;
        const line = comments ? `${lineCore} - ${comments}` : lineCore;
        if (!line || seen.has(line)) {
          continue;
        }

        seen.add(line);
        out.push(line);
      }
    }

    return out.slice(0, 80);
  });
}

async function fetchDetail(
  browser: Browser,
  detailUrl: string,
  availabilityHorizonDays: number,
  maxCalendarAdvanceMonths: number,
): Promise<LuxuryDetailRecord | null> {
  const startedAt = Date.now();
  const page = await browser.newPage();

  try {
    await installEvaluateNameShim(page);

    const beforeLoad = Date.now();
    await page.goto(detailUrl, {
      waitUntil: "domcontentloaded",
      timeout: 120000,
    });
    await page.waitForTimeout(1800);

    await clickVisibleControlsByLabel(page, [
      "read more",
      "show all amenities",
      "show all",
      "view all amenities",
      "all photos",
      "view photos",
      "gallery",
      "lightbox",
    ]);

    const pageLoadMs = Date.now() - beforeLoad;

    const extracted = await page.evaluate(() => {
      const getMeta = (name: string): string => {
        const direct = document.querySelector(`meta[name='${name}']`);
        if (direct) {
          return (direct.getAttribute("content") ?? "").trim();
        }

        const prop = document.querySelector(`meta[property='${name}']`);
        return (prop?.getAttribute("content") ?? "").trim();
      };

      return {
        title: document.title ?? "",
        h1: (() => {
          const heading = document.querySelector("h1");
          if (!heading) {
            return "";
          }

          const clone = heading.cloneNode(true) as HTMLElement;
          for (const nested of Array.from(
            clone.querySelectorAll(
              ".collapsible, .group-beds-baths-wrapper, .rc-lodging-detail",
            ),
          )) {
            nested.remove();
          }

          return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
        })(),
        canonical:
          document
            .querySelector("link[rel='canonical']")
            ?.getAttribute("href") ?? "",
        metaDescription: getMeta("description") || getMeta("og:description"),
        sleepsText: (() => {
          const labels = Array.from(
            document.querySelectorAll(".be-property-widget-info-label"),
          );
          for (const label of labels) {
            const text = (label.textContent ?? "").toLowerCase();
            if (!text.includes("guest")) {
              continue;
            }
            return (
              label.querySelector(".be-property-widget-info-label-count")
                ?.textContent ?? ""
            ).trim();
          }
          return (
            document.querySelector(".rc-lodging-occ")?.textContent ?? ""
          ).trim();
        })(),
        bedroomsText: (() => {
          const labels = Array.from(
            document.querySelectorAll(".be-property-widget-info-label"),
          );
          for (const label of labels) {
            const text = (label.textContent ?? "").toLowerCase();
            if (!text.includes("bed")) {
              continue;
            }
            return (
              label.querySelector(".be-property-widget-info-label-count")
                ?.textContent ?? ""
            ).trim();
          }
          return (
            document.querySelector(".rc-lodging-beds")?.textContent ?? ""
          ).trim();
        })(),
        bathroomsText: (() => {
          const labels = Array.from(
            document.querySelectorAll(".be-property-widget-info-label"),
          );
          for (const label of labels) {
            const text = (label.textContent ?? "").toLowerCase();
            if (!text.includes("bath")) {
              continue;
            }
            return (
              label.querySelector(".be-property-widget-info-label-count")
                ?.textContent ?? ""
            ).trim();
          }
          return (
            document.querySelector(".rc-lodging-baths")?.textContent ?? ""
          ).trim();
        })(),
        neighborhoodText:
          document
            .querySelector(
              ".pdp-property-info-list-item .pdp-property-info-list-item-text",
            )
            ?.textContent?.trim() ?? "",
        unitId:
          document
            .querySelector(
              '[name="entity_id"][content], [data-entity-id], .be-property-widget[data-id]',
            )
            ?.getAttribute("content")
            ?.trim() ??
          document
            .querySelector("[data-item-id], [data-id]")
            ?.getAttribute("data-item-id")
            ?.trim() ??
          document
            .querySelector(".be-property-widget[data-id]")
            ?.getAttribute("data-id")
            ?.trim() ??
          "",
        amenitiesCategories: (() => {
          const categories: Record<string, string[]> = {};
          const modernGroups = Array.from(
            document.querySelectorAll(".pdp-amenities-list-group"),
          );
          for (const group of modernGroups) {
            const heading =
              group.querySelector(".pdp-amenities-list-heading")?.textContent ??
              "";
            const category = heading.replace(/\s+/g, " ").trim();
            if (!category) {
              continue;
            }

            const items = Array.from(
              group.querySelectorAll(".pdp-amenities-item-text, li"),
            )
              .map((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim())
              .filter(Boolean);

            if (items.length > 0) {
              categories[category] = Array.from(new Set(items));
            }
          }

          if (Object.keys(categories).length > 0) {
            return categories;
          }

          const wrappers = Array.from(
            document.querySelectorAll(
              "#listing-features .amenity-item, #amenities .amenity-wrapper, section#amenities .amenity-wrapper, [id='amenities'] .amenity-wrapper",
            ),
          );
          for (const field of wrappers) {
            const heading =
              field.querySelector("h4")?.textContent ??
              field.querySelector("h3.label-above")?.textContent ??
              field.querySelector("h3")?.textContent ??
              field.querySelector("h2")?.textContent ??
              "";
            const category = heading
              .replace(/:\s*$/, "")
              .replace(/\s+/g, " ")
              .trim();
            if (!category) {
              continue;
            }

            const items = Array.from(field.querySelectorAll("li"))
              .map((li) => (li.textContent ?? "").replace(/\s+/g, " ").trim())
              .filter(Boolean);
            if (items.length > 0) {
              categories[category] = items;
            }
          }

          if (Object.keys(categories).length === 0) {
            const rcGroups = Array.from(
              document.querySelectorAll(
                "#amenities .rc-core-cat .item-list, section#amenities .rc-core-cat .item-list",
              ),
            );

            for (const group of rcGroups) {
              const heading =
                group.querySelector("h3")?.textContent ??
                group.querySelector("h2")?.textContent ??
                "";
              const category = heading
                .replace(/:\s*$/, "")
                .replace(/\s+/g, " ")
                .trim();
              if (!category) {
                continue;
              }

              const items = Array.from(group.querySelectorAll("ul li"))
                .map((li) => (li.textContent ?? "").replace(/\s+/g, " ").trim())
                .filter(Boolean);

              if (items.length > 0) {
                categories[category] = items;
              }
            }
          }

          return categories;
        })(),
        galleryUrls: (() => {
          const urls: string[] = [];
          const mediaRoots = Array.from(
            document.querySelectorAll(
              "#property-slick-slider-alt, .group-photos, #Media, #media, #pdpHiddenGallery, .pdp-property-widget-img-area, .slick-slider, .fancybox-container, .fancybox-stage, .modal .gallery, .gallery-modal, [class*='lightbox'], [class*='gallery']",
            ),
          );
          if (mediaRoots.length === 0) {
            return urls;
          }

          const attrValues = mediaRoots.flatMap((root) =>
            Array.from(
              root.querySelectorAll(
                "a[href], a[data-srcset], a[data-thumb], img[src], img[srcset], img[data-src], img[data-rstmb], [data-rsbigimg], [data-image]",
              ),
            ),
          );

          for (const node of attrValues) {
            const attrs: Array<{ value: string | null; splitSet: boolean }> = [
              { value: node.getAttribute("href"), splitSet: false },
              { value: node.getAttribute("src"), splitSet: false },
              { value: node.getAttribute("srcset"), splitSet: true },
              { value: node.getAttribute("data-src"), splitSet: false },
              { value: node.getAttribute("data-rstmb"), splitSet: false },
              { value: node.getAttribute("data-rsbigimg"), splitSet: false },
              { value: node.getAttribute("data-srcset"), splitSet: true },
              { value: node.getAttribute("data-thumb"), splitSet: false },
              { value: node.getAttribute("data-image"), splitSet: false },
              { value: node.getAttribute("data-lazy-src"), splitSet: false },
            ];
            for (const attr of attrs) {
              if (!attr.value) {
                continue;
              }
              try {
                const candidate = attr.splitSet
                  ? (attr.value.split(",")[0]?.trim().split(/\s+/)[0] ?? "")
                  : attr.value.trim();
                const absolute = new URL(
                  candidate,
                  window.location.origin,
                ).toString();
                if (
                  /logo_|gradient\.jpg|maps\.gstatic\.com|\/markers\/|transparent\.png/i.test(
                    absolute,
                  )
                ) {
                  continue;
                }
                if (
                  /\.(jpe?g|png|webp|gif)(\?|$)/i.test(absolute) ||
                  absolute.includes("picturehandler.ashx") ||
                  absolute.includes("/vrm-img/") ||
                  absolute.includes("images.rezfusion.com")
                ) {
                  urls.push(absolute);
                }
              } catch {
                // Skip invalid URL fragments.
              }
            }
          }
          return urls;
        })(),
      };
    });

    const descriptionText = (await extractDescriptionText(page)).slice(
      0,
      15000,
    );

    await clickTab(page, "Availability");

    const dayCodeByDate = new Map<string, LuxuryDayCode>();
    const codePriority: Record<LuxuryDayCode, number> = {
      X: 0,
      A: 1,
      U: 1,
      I: 2,
      O: 2,
    };

    const bookingRestrictions = new Set<string>();
    const seenMonthSignatures = new Set<string>();

    let calendarClicks = 0;
    let calendarIterations = 0;
    let stagnantIterations = 0;

    const now = new Date();
    const todayIso = now.toISOString().slice(0, 10);
    const horizon = new Date(now);
    horizon.setUTCDate(horizon.getUTCDate() + availabilityHorizonDays);
    const horizonIso = horizon.toISOString().slice(0, 10);

    for (
      let iteration = 0;
      iteration < Math.max(1, maxCalendarAdvanceMonths);
      iteration += 1
    ) {
      calendarIterations += 1;

      const snapshot = await extractAvailabilitySnapshot(page);
      const monthSignature = snapshot.months.join("|");
      if (monthSignature && seenMonthSignatures.has(monthSignature)) {
        stagnantIterations += 1;
      } else if (monthSignature) {
        seenMonthSignatures.add(monthSignature);
        stagnantIterations = 0;
      }

      for (const restriction of snapshot.bookingRestrictions) {
        bookingRestrictions.add(restriction);
      }

      for (const item of snapshot.items) {
        if (item.date < todayIso || item.date > horizonIso) {
          continue;
        }

        const previous = dayCodeByDate.get(item.date);
        if (!previous) {
          dayCodeByDate.set(item.date, item.code);
          continue;
        }

        if (codePriority[item.code] > codePriority[previous]) {
          dayCodeByDate.set(item.date, item.code);
        }
      }

      const latestDate = Array.from(dayCodeByDate.keys()).sort().at(-1) ?? "";
      if (latestDate && latestDate >= horizonIso) {
        break;
      }
      if (stagnantIterations >= 3) {
        break;
      }

      const clickedNext = await page.evaluate(() => {
        const nodes = Array.from(
          document.querySelectorAll(
            "a.ui-datepicker-next, button.next, a.next, .rc-calendar-next, [class*='calendar'] .next, [class*='datepicker'] [title*='Next' i], [class*='datepicker'] [aria-label*='Next' i], button[title*='Next' i], a[title*='Next' i], button[aria-label*='Next' i], a[aria-label*='Next' i]",
          ),
        );

        for (const node of nodes) {
          const element = node as HTMLElement;
          if (element.offsetParent === null) {
            continue;
          }
          if (
            element.getAttribute("aria-disabled") === "true" ||
            element.className.toLowerCase().includes("disabled")
          ) {
            continue;
          }
          element.click();
          return true;
        }

        return false;
      });

      if (!clickedNext) {
        break;
      }

      calendarClicks += 1;
      await page.waitForTimeout(750);
    }

    const normalizedDays = Array.from(dayCodeByDate.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([date, code]) => {
        const bookingDayState: "bookable" | "blocked" | "unknown" =
          code === "A" || code === "O"
            ? "bookable"
            : code === "U" || code === "I"
              ? "blocked"
              : "unknown";

        return {
          date,
          status_code: code,
          is_available: code === "A" || code === "O",
          is_available_for_checkin: code === "A" || code === "I",
          is_available_for_checkout: code === "A" || code === "O",
          booking_day_state: bookingDayState,
          min_nights_required: null,
        };
      });

    const normalizedDayByDate = new Map(
      normalizedDays.map((day) => [day.date, day]),
    );
    const completeWindowDays: typeof normalizedDays = [];
    const windowCursor = new Date(now);
    const fallbackEnd = new Date(now);
    fallbackEnd.setUTCDate(fallbackEnd.getUTCDate() + availabilityHorizonDays);
    const latestKnownDate =
      normalizedDays[normalizedDays.length - 1]?.date ?? "";
    const latestKnown = latestKnownDate
      ? new Date(`${latestKnownDate}T00:00:00Z`)
      : null;
    const targetEnd =
      latestKnown && latestKnown.getTime() > fallbackEnd.getTime()
        ? latestKnown
        : fallbackEnd;

    while (windowCursor.getTime() <= targetEnd.getTime()) {
      const isoDate = windowCursor.toISOString().slice(0, 10);
      const existing = normalizedDayByDate.get(isoDate);
      completeWindowDays.push(
        existing ?? {
          date: isoDate,
          status_code: "X",
          is_available: false,
          is_available_for_checkin: false,
          is_available_for_checkout: false,
          booking_day_state: "unknown",
          min_nights_required: null,
        },
      );
      windowCursor.setUTCDate(windowCursor.getUTCDate() + 1);
    }

    const externalListingId = extractExternalListingId(detailUrl);
    const htmlPath = resolve(
      OUTPUT_DETAILS_HTML_DIR,
      `${externalListingId}.html`,
    );
    const html = await page.content();
    await writeFile(htmlPath, html, "utf8");

    const descriptionExpanded = (
      stripHtml(descriptionText).slice(0, 30000) ||
      extractListingAboutFromHtml(html)
    ).slice(0, 30000);
    const domRoomDetailsGuidance =
      await extractRoomDetailsGuidanceFromDom(page);
    const rcavIdentity = extractRcavIdentity({
      listingId: externalListingId,
      descriptionExpanded,
      detailHtml: html,
    });
    const htmlRoomDetailsGuidance = extractRoomDetailsGuidanceFromHtml(html);
    const descriptionRoomDetailsGuidance =
      extractRoomDetailsGuidanceFromDescription(descriptionExpanded);
    const roomDetailsGuidance =
      domRoomDetailsGuidance.length > 0
        ? domRoomDetailsGuidance
        : htmlRoomDetailsGuidance.length > 0
          ? htmlRoomDetailsGuidance
          : descriptionRoomDetailsGuidance;

    const locationPayload = extractFieldLocationFromHtml(html);

    const beds = parseFirstNumber(extracted.bedroomsText);
    const baths = parseFirstNumber(extracted.bathroomsText);
    const sleeps = parseFirstNumber(extracted.sleepsText);
    const neighborhood = stripHtml(extracted.neighborhoodText).slice(0, 240);

    const propertyProfile: LuxuryDetailRecord["property_profile"] = {
      unit_id: stripHtml(extracted.unitId || externalListingId).slice(0, 140),
      area: neighborhood,
      location: neighborhood,
      beds,
      baths,
      sleeps,
      city: parseCityStateFromAddress(locationPayload.street).city,
      state: parseCityStateFromAddress(locationPayload.street).state,
    };

    const amenitiesCategories: Record<string, string[]> = {};
    for (const [category, items] of Object.entries(
      extracted.amenitiesCategories,
    )) {
      const cleanCategory = stripHtml(category).slice(0, 120);
      const cleanItems = dedupePreserveOrder(
        items.map((item) => stripHtml(item).slice(0, 200)),
      );
      if (!cleanCategory || cleanItems.length === 0) {
        continue;
      }
      amenitiesCategories[cleanCategory] = cleanItems;
    }

    const amenitiesAll = dedupePreserveOrder(
      Object.values(amenitiesCategories).flat(),
    );
    const amenities: LuxuryDetailRecord["amenities"] = {
      categories: amenitiesCategories,
      all: amenitiesAll,
    };

    const mediaUrls = dedupePreferLargestGalleryVariants(
      filterGallerySourceNoise(
        extracted.galleryUrls
          .map((url) => normalizeGalleryUrl(url))
          .filter(Boolean),
      ),
    );
    const mediaGallery: LuxuryDetailRecord["media_gallery"] = {
      image_count: mediaUrls.length,
      image_urls: mediaUrls,
    };

    const latitudeFallbackMatch = html.match(
      /latitude[^0-9-]*(-?\d+(?:\.\d+)?)/i,
    );
    const longitudeFallbackMatch = html.match(
      /longitude[^0-9-]*(-?\d+(?:\.\d+)?)/i,
    );
    const googleMapsLlFallback = extractGoogleMapsLlFromHtml(html);
    const genericLlFallbackMatch = html.match(
      /[?&]ll=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/i,
    );
    const aboutAddressFallbackMatch = descriptionExpanded.match(
      /~\s*([^~]+?)\s*~\s*([^~]+?\b[A-Z]{2}\s+\d{5}(?:-\d{4})?)/,
    );

    const latitudeRaw =
      locationPayload.latitude ??
      googleMapsLlFallback?.latitude ??
      (genericLlFallbackMatch ? Number(genericLlFallbackMatch[1]) : null) ??
      (latitudeFallbackMatch ? Number(latitudeFallbackMatch[1]) : null);
    const longitudeRaw =
      locationPayload.longitude ??
      googleMapsLlFallback?.longitude ??
      (genericLlFallbackMatch ? Number(genericLlFallbackMatch[2]) : null) ??
      (longitudeFallbackMatch ? Number(longitudeFallbackMatch[1]) : null);

    const latitude = latitudeRaw === 0 ? null : latitudeRaw;
    const longitude = longitudeRaw === 0 ? null : longitudeRaw;

    const streetAddress = stripHtml(
      locationPayload.street ||
        (aboutAddressFallbackMatch
          ? `${aboutAddressFallbackMatch[1]}, ${aboutAddressFallbackMatch[2]}`
          : ""),
    ).slice(0, 240);
    const locationLabel =
      neighborhood || amenitiesCategories["Location"]?.[0] || "";
    const resolvedAddress = streetAddress || locationLabel;

    const directionsQuery =
      resolvedAddress ||
      (latitude !== null && longitude !== null
        ? `${latitude},${longitude}`
        : "");

    const location: LuxuryDetailRecord["location"] = {
      address: resolvedAddress,
      location_label: locationLabel,
      directions_url: directionsQuery
        ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(directionsQuery)}`
        : "",
      directions_daddr: directionsQuery,
      latitude,
      longitude,
    };

    const listingName = normalizeListingName(
      stripProminenceBrandPrefix(
        extracted.h1 || extracted.title || externalListingId,
      ),
    );

    const normalizedMatchingProfile = {
      source: "pm_prominence30a" as const,
      external_listing_id: externalListingId,
      name: listingName,
      description: stripHtml(
        descriptionExpanded || descriptionText || extracted.metaDescription,
      ).slice(0, 15000),
      match_signals: {
        description_normalized: normalizeForMatch(
          stripHtml(
            descriptionExpanded || descriptionText || extracted.metaDescription,
          ).slice(0, 15000),
        ),
        description_sha256: hashSha256(
          normalizeForMatch(
            stripHtml(
              descriptionExpanded ||
                descriptionText ||
                extracted.metaDescription,
            ).slice(0, 15000),
          ),
        ),
        title_normalized: normalizeForMatch(listingName),
        title_sha256: hashSha256(normalizeForMatch(listingName)),
        listing_composite_key: hashSha256(
          `${externalListingId}|${normalizeForMatch(listingName)}`,
        ),
      },
    };

    const extractionMs = Date.now() - beforeLoad - pageLoadMs;
    const totalMs = Date.now() - startedAt;

    return {
      external_listing_id: externalListingId,
      detail_url: detailUrl,
      fetched_at: new Date().toISOString(),
      title: normalizeListingName(extracted.title || extracted.h1 || ""),
      h1: listingName,
      canonical_url: extracted.canonical || detailUrl,
      meta_description: stripHtml(extracted.metaDescription).slice(0, 2000),
      description_expanded: descriptionExpanded,
      rooms_guidance: roomDetailsGuidance,
      amenities,
      location,
      media_gallery: mediaGallery,
      property_profile: propertyProfile,
      quote_context: {
        source: "description_expanded",
        item_eid: rcavIdentity.itemEid,
        type_id: rcavIdentity.typeId,
        inventory_id: rcavIdentity.inventoryId,
        detail_url: detailUrl,
      },
      normalized_matching_profile: normalizedMatchingProfile,
      normalized_availability: {
        source: "pm_prominence30a",
        external_listing_id: externalListingId,
        captured_at: new Date().toISOString(),
        has_calendar_widget: normalizedDays.length > 0,
        booking_restrictions: Array.from(bookingRestrictions),
        min_night_rules: [],
        window_start: completeWindowDays[0]?.date ?? "",
        window_end:
          completeWindowDays[completeWindowDays.length - 1]?.date ?? "",
        code_legend: {
          A: "available",
          U: "unavailable",
          I: "checkin_only",
          O: "checkout_only",
          X: "other",
        },
        day_codes: completeWindowDays.map((day) => day.status_code).join(""),
        days: completeWindowDays,
        counts: {
          available: completeWindowDays.filter((day) => day.status_code === "A")
            .length,
          unavailable: completeWindowDays.filter(
            (day) => day.status_code === "U",
          ).length,
          checkin_only: completeWindowDays.filter(
            (day) => day.status_code === "I",
          ).length,
          checkout_only: completeWindowDays.filter(
            (day) => day.status_code === "O",
          ).length,
          other: completeWindowDays.filter((day) => day.status_code === "X")
            .length,
          booking_available: completeWindowDays.filter(
            (day) => day.booking_day_state === "bookable",
          ).length,
          booking_unavailable: completeWindowDays.filter(
            (day) => day.booking_day_state === "blocked",
          ).length,
          booking_unknown: completeWindowDays.filter(
            (day) => day.booking_day_state === "unknown",
          ).length,
        },
      },
      html_path: htmlPath,
      scrape_metrics: {
        total_ms: totalMs,
        page_load_ms: pageLoadMs,
        extraction_ms: extractionMs,
        calendar_clicks: calendarClicks,
        calendar_iterations: calendarIterations,
      },
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "unknown detail pull error";
    console.warn(
      `[prominence30a] detail pull failed for ${detailUrl}: ${message}`,
    );
    return null;
  } finally {
    await page.close();
  }
}

export function createProminence30Adapter(): ScraperAdapter<LuxuryDetailRecord> {
  return {
    managerKey: "prominence30a",
    scriptLabel: "prominence30a",
    defaultAnchorUrl: DEFAULT_ANCHOR_URL,
    detailFetchDelayMs: Math.max(
      0,
      Number(
        process.env.PROMINENCE30A_DETAIL_FETCH_DELAY_MS ??
          process.env.PROMINENCE30_DETAIL_FETCH_DELAY_MS ??
          "120",
      ) || 120,
    ),
    detailFetchConcurrency: Math.max(
      1,
      Number(
        process.env.PROMINENCE30A_DETAIL_FETCH_CONCURRENCY ??
          process.env.PROMINENCE30_DETAIL_FETCH_CONCURRENCY ??
          "4",
      ) || 4,
    ),
    availabilityHorizonDays: Math.max(
      1,
      Number(
        process.env.PROMINENCE30A_AVAILABILITY_HORIZON_DAYS ??
          process.env.PROMINENCE30_AVAILABILITY_HORIZON_DAYS ??
          "730",
      ) || 730,
    ),
    maxCalendarAdvanceMonths: Math.max(
      8,
      Number(
        process.env.PROMINENCE30A_CALENDAR_MAX_MONTHS ??
          process.env.PROMINENCE30_CALENDAR_MAX_MONTHS ??
          "26",
      ) || 26,
    ),
    isValidDetailUrl(value: string): string | null {
      try {
        const parsed = new URL(value.trim());
        if (
          !parsed.hostname.endsWith("prominenceon30a.com") ||
          !isLikelyDetailPath(parsed.pathname)
        ) {
          return null;
        }

        return normalizeDetailUrl(parsed.toString());
      } catch {
        return null;
      }
    },
    async discoverListings(context) {
      return discoverListings(
        context.page,
        context.anchorUrl,
        context.maxScrollSteps,
        context.scrollPauseMs,
        context.networkIdleWaitMs,
        context.reportProgress,
      );
    },
    async fetchDetail(context) {
      return fetchDetail(
        context.browser,
        context.detailUrl,
        context.availabilityHorizonDays,
        context.maxCalendarAdvanceMonths,
      );
    },
    async runQuoteCapture(argv, progress) {
      const normalizedArgs = await normalizeAdapterQuoteScopeArgs(
        "prominence30a",
        argv,
      );
      await runRuntimeAdapterQuoteCli(
        {
          adapterKey: "prominence30a",
          executeSingleQuote: executeProminence30SingleQuote,
          maxAttemptsEnvVar: "PROMINENCE30A_QUOTE_MAX_ATTEMPTS",
          defaultMaxListings: 10,
          defaultWeeks: 24,
          defaultNights: 7,
          defaultListingConcurrency: 1,
          defaultQuoteConcurrency: 2,
          defaultQuoteTimeoutMs: 20000,
          defaultQuoteMaxAttempts: 2,
          defaultEndpointPath: "/rescms/ajax/item/pricing/quote",
          defaultTaxPct: 0.12,
          defaultBaseNightly: 700,
        },
        normalizedArgs,
        progress,
      );
    },
    async runSingleQuoteObservation(input) {
      const result = await executeProminence30SingleQuote({
        listingId: input.listingId,
        checkInIso: input.checkInIso,
        checkOutIso: input.checkOutIso,
        adults: input.adults,
        children: input.children,
        quoteContext: input.quoteContext ?? {
          listing_id: input.listingId,
          detail_url: input.detailUrl,
        },
        options: {
          timeoutMs:
            Number(
              process.env.PROMINENCE30A_QUOTE_TIMEOUT_MS ??
                process.env.PROMINENCE30_QUOTE_TIMEOUT_MS ??
                process.env.QUOTE_CAPTURE_TIMEOUT_MS ??
                "20000",
            ) || 20000,
        },
      });

      if (result.success) {
        return {
          elapsedMs: result.elapsedMs,
          observation: {
            startDate: result.observation.startDate,
            endDate: result.observation.endDate,
            quoteAvailable: result.observation.quoteAvailable,
            currency: result.observation.currency,
            baseTotal: result.observation.baseTotal,
            taxesTotal: result.observation.taxesTotal,
            feesTotalExclTaxes: result.observation.feesTotalExclTaxes,
            grandTotal: result.observation.grandTotal,
            quotedTotal: result.observation.quotedTotal,
            handoffUrl: result.observation.handoffUrl,
            reason: null,
          },
        };
      }

      return {
        elapsedMs: result.elapsedMs,
        observation: {
          startDate: input.checkInIso,
          endDate: input.checkOutIso,
          quoteAvailable: false,
          currency: null,
          baseTotal: null,
          taxesTotal: null,
          feesTotalExclTaxes: null,
          grandTotal: null,
          quotedTotal: null,
          handoffUrl: input.handoffUrl ?? null,
          reason: result.error.message,
        },
      };
    },
  };
}
