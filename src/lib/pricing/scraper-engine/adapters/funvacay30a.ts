import { executeFunvacay30aSingleQuote } from "@/lib/pricing/quote-runtime/adapters/funvacay30a";
import { runRuntimeAdapterQuoteCli } from "@/lib/pricing/quotes/shared/runtime-adapter-quote-runner";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";

import { normalizeAdapterQuoteScopeArgs } from "../quote-scope";
import type { DetailRecordBase, ScrapedLink, ScraperAdapter } from "../types";

type LuxuryDayCode = "A" | "U" | "I" | "O" | "X";

type LuxuryDetailRecord = DetailRecordBase & {
  title: string;
  h1: string;
  canonical_url: string;
  meta_description: string;
  description_expanded: string;
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
    unit_type: string;
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
    endpoint_path: "/rescms/ajax/item/pricing/quote";
  };
  normalized_matching_profile: {
    source: "pm_funvacay30a";
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
    source: "pm_funvacay30a";
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
  pricing_api_hints: {
    provider: "cwr-router";
    endpoint_path: "/vacation-rentals/router/";
    method_names: {
      pre_reservation_price: "getPrice";
    };
    required_payload_fields: string[];
    notes: string;
  };
};

const DEFAULT_ANCHOR_URL =
  "https://www.funvacay.com/emerald-coast-vacation-rentals#fq=%7B!tag%3DRiotSolrWidget%2CRiotSolrFacetList-sm_nid%24rc_core_term_location%24name%7Dsm_nid%24rc_core_term_location%24name%3A%2230A%22";
const EXPECTED_LISTING_COUNT = 45;
const DETAIL_PATH_PREFIXES = ["/emerald-coast-vacation-rentals/"];
const OUTPUT_ROOT = resolve(
  process.cwd(),
  "src",
  "lib",
  "data",
  "external-sources",
  "funvacay30a",
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
        return `${resolvedSource.origin}${resolvedSource.pathname}`;
      } catch {
        // Fall through to normalized Rezfusion URL.
      }
    }

    return `${parsed.origin}${parsed.pathname}${parsed.search}`;
  } catch {
    return "";
  }
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

  const streetFromWidget = attrValue("data-straddress1");
  const latitudeFromWidget = Number(attrValue("data-latitude"));
  const longitudeFromWidget = Number(attrValue("data-longitude"));

  if (
    streetFromWidget ||
    Number.isFinite(latitudeFromWidget) ||
    Number.isFinite(longitudeFromWidget)
  ) {
    return {
      street: streetFromWidget,
      latitude: Number.isFinite(latitudeFromWidget) ? latitudeFromWidget : null,
      longitude: Number.isFinite(longitudeFromWidget)
        ? longitudeFromWidget
        : null,
    };
  }

  const fieldLocationChunkMatch = html.match(
    /["']field_location["']\s*:\s*\{[\s\S]*?\}\s*,\s*["']field_teaser_image["']/i,
  );
  const fieldLocationChunk = fieldLocationChunkMatch
    ? fieldLocationChunkMatch[0]
    : html;

  const streetMatch = fieldLocationChunk.match(
    /["']street["']\s*:\s*["']([^"']*)["']/i,
  );
  const latitudeMatch = fieldLocationChunk.match(
    /["']latitude["']\s*:\s*["']?(-?\d+(?:\.\d+)?)["']?/i,
  );
  const longitudeMatch = fieldLocationChunk.match(
    /["']longitude["']\s*:\s*["']?(-?\d+(?:\.\d+)?)["']?/i,
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

  const latitudeFallback = latLngPairMatch?.[1]
    ? Number(latLngPairMatch[1])
    : lngLatPairMatch?.[2]
      ? Number(lngLatPairMatch[2])
      : atCoordMatch?.[1]
        ? Number(atCoordMatch[1])
        : maps3d4dMatch?.[1]
          ? Number(maps3d4dMatch[1])
          : NaN;
  const longitudeFallback = latLngPairMatch?.[2]
    ? Number(latLngPairMatch[2])
    : lngLatPairMatch?.[1]
      ? Number(lngLatPairMatch[1])
      : atCoordMatch?.[2]
        ? Number(atCoordMatch[2])
        : maps3d4dMatch?.[2]
          ? Number(maps3d4dMatch[2])
          : NaN;

  const latitudeResolved = Number.isFinite(latitude)
    ? latitude
    : Number.isFinite(latitudeFallback)
      ? latitudeFallback
      : NaN;
  const longitudeResolved = Number.isFinite(longitude)
    ? longitude
    : Number.isFinite(longitudeFallback)
      ? longitudeFallback
      : NaN;

  return {
    street,
    latitude: Number.isFinite(latitudeResolved) ? latitudeResolved : null,
    longitude: Number.isFinite(longitudeResolved) ? longitudeResolved : null,
  };
}

function extractUnitIdFromHtml(html: string): string {
  const patterns = [
    /\bunitId\s*:\s*['"]([^'"]+)['"]/i,
    /"unitId"\s*:\s*"([^"]+)"/i,
    /"unit_id"\s*:\s*"([^"]+)"/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    const value = (match?.[1] ?? "").trim();
    if (value) {
      return value;
    }
  }

  return "";
}

function parseJsonLdSignals(html: string): {
  amenities: string[];
  imageUrls: string[];
  street: string;
  city: string;
  state: string;
  latitude: number | null;
  longitude: number | null;
  beds: number | null;
  baths: number | null;
  sleeps: number | null;
} {
  const amenities = new Set<string>();
  const imageUrls = new Set<string>();

  let street = "";
  let city = "";
  let state = "";
  let latitude: number | null = null;
  let longitude: number | null = null;
  let beds: number | null = null;
  let baths: number | null = null;
  let sleeps: number | null = null;

  const trySetNumber = (raw: unknown): number | null => {
    if (typeof raw === "number" && Number.isFinite(raw)) {
      return raw;
    }
    if (typeof raw === "string") {
      const parsed = Number(raw.trim());
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  };

  const scripts: string[] = [];
  const scriptPattern =
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(scriptPattern)) {
    const body = (match[1] ?? "").trim();
    if (body) {
      scripts.push(body);
    }
  }

  const walkObject = (value: unknown): void => {
    if (!value || typeof value !== "object") {
      return;
    }

    if (Array.isArray(value)) {
      for (const entry of value) {
        walkObject(entry);
      }
      return;
    }

    const record = value as Record<string, unknown>;

    const imageValue = record.image;
    if (typeof imageValue === "string") {
      imageUrls.add(imageValue);
    } else if (Array.isArray(imageValue)) {
      for (const imageEntry of imageValue) {
        if (typeof imageEntry === "string") {
          imageUrls.add(imageEntry);
        }
      }
    }

    const amenityFeature = record.amenityFeature;
    if (Array.isArray(amenityFeature)) {
      for (const feature of amenityFeature) {
        if (!feature || typeof feature !== "object") {
          continue;
        }
        const name = String((feature as Record<string, unknown>).name ?? "")
          .replace(/\s+/g, " ")
          .trim();
        if (name) {
          amenities.add(name);
        }
      }
    }

    const address = record.address;
    if (address && typeof address === "object") {
      const addressRecord = address as Record<string, unknown>;
      if (!street) {
        street = String(addressRecord.streetAddress ?? "").trim();
      }
      if (!city) {
        city = String(addressRecord.addressLocality ?? "").trim();
      }
      if (!state) {
        state = String(addressRecord.addressRegion ?? "").trim();
      }
    }

    const geo = record.geo;
    if (geo && typeof geo === "object") {
      const geoRecord = geo as Record<string, unknown>;
      if (latitude === null) {
        latitude = trySetNumber(geoRecord.latitude);
      }
      if (longitude === null) {
        longitude = trySetNumber(geoRecord.longitude);
      }
    }

    const containsPlace = record.containsPlace;
    if (containsPlace && typeof containsPlace === "object") {
      const placeRecord = containsPlace as Record<string, unknown>;
      if (beds === null) {
        beds = trySetNumber(placeRecord.numberOfBedrooms);
      }
      if (baths === null) {
        baths = trySetNumber(placeRecord.numberOfBathroomsTotal);
      }

      const occupancy = placeRecord.occupancy;
      if (occupancy && typeof occupancy === "object" && sleeps === null) {
        sleeps = trySetNumber((occupancy as Record<string, unknown>).value);
      }
    }

    if (beds === null) {
      beds = trySetNumber(record.numberOfBedrooms);
    }
    if (baths === null) {
      baths = trySetNumber(record.numberOfBathroomsTotal);
    }

    for (const nested of Object.values(record)) {
      if (nested && typeof nested === "object") {
        walkObject(nested);
      }
    }
  };

  for (const script of scripts) {
    try {
      const parsed = JSON.parse(script) as unknown;
      walkObject(parsed);
    } catch {
      // Ignore malformed JSON-LD blocks.
    }
  }

  return {
    amenities: Array.from(amenities),
    imageUrls: Array.from(imageUrls),
    street,
    city,
    state,
    latitude,
    longitude,
    beds,
    baths,
    sleeps,
  };
}

function extractUnitCardSignals(
  html: string,
  unitId: string,
): {
  street: string;
  city: string;
  latitude: number | null;
  longitude: number | null;
  unitType: string;
} {
  const parseFromChunk = (chunk: string) => {
    const street = (chunk.match(/"address":"([^"]*)"/i)?.[1] ?? "")
      .replace(/\\\//g, "/")
      .trim();
    const city = (chunk.match(/"city":"([^"]*)"/i)?.[1] ?? "")
      .replace(/\\\//g, "/")
      .trim();
    const geocode = chunk.match(
      /"geocode":"\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*"/i,
    );
    const latitude = geocode ? Number(geocode[1]) : NaN;
    const longitude = geocode ? Number(geocode[2]) : NaN;
    const unitType = (chunk.match(/"unit_type":"([^"]*)"/i)?.[1] ?? "")
      .replace(/\\\//g, "/")
      .trim();

    return {
      street,
      city,
      latitude: Number.isFinite(latitude) ? latitude : null,
      longitude: Number.isFinite(longitude) ? longitude : null,
      unitType,
    };
  };

  if (!unitId) {
    const fallback = parseFromChunk(html.slice(0, 22000));
    return {
      street: fallback.street,
      city: fallback.city,
      latitude: fallback.latitude,
      longitude: fallback.longitude,
      unitType: fallback.unitType,
    };
  }

  const marker = `"unit_id":"${unitId}"`;
  const idx = html.indexOf(marker);
  if (idx < 0) {
    const fallback = parseFromChunk(html.slice(0, 22000));
    return {
      street: fallback.street,
      city: fallback.city,
      latitude: fallback.latitude,
      longitude: fallback.longitude,
      unitType: fallback.unitType,
    };
  }

  const chunk = html.slice(Math.max(0, idx - 240), idx + 1800);
  const parsed = parseFromChunk(chunk);

  return {
    street: parsed.street,
    city: parsed.city,
    latitude: parsed.latitude,
    longitude: parsed.longitude,
    unitType: parsed.unitType,
  };
}

function extractPrimaryUnitTypeFromHtml(html: string): string {
  const fromPrimaryPropDetails = html.match(
    /propDetails\s*:\s*\{[\s\S]{0,14000}?"unit_type"\s*:\s*"([^"]*)"/i,
  );
  const fromGeneric = html.match(/"unit_type"\s*:\s*"([^"]*)"/i);

  const raw =
    (fromPrimaryPropDetails?.[1] ?? fromGeneric?.[1] ?? "")
      .replace(/\\\//g, "/")
      .trim() || "";

  return raw;
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

function extractRcavIdentityFromSource(source: string): {
  itemEid: string;
  typeId: string;
  inventoryId: string;
} | null {
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

  return null;
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

function extractJsArrayLiteralByKey(html: string, key: string): string | null {
  const keyIndex = html.indexOf(`${key}:`);
  if (keyIndex < 0) {
    return null;
  }

  const start = html.indexOf("[", keyIndex);
  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let quote = "";
  let escapeNext = false;

  for (let index = start; index < html.length; index += 1) {
    const ch = html[index] ?? "";

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (inString) {
      if (ch === "\\") {
        escapeNext = true;
        continue;
      }
      if (ch === quote) {
        inString = false;
        quote = "";
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }

    if (ch === "[") {
      depth += 1;
      continue;
    }

    if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        return html.slice(start, index + 1);
      }
    }
  }

  return null;
}

function parseSlashDateToIso(value: string): string {
  const raw = value.trim();
  const match = raw.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (!match) {
    return "";
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return "";
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) {
    return "";
  }

  return date.toISOString().slice(0, 10);
}

function addUtcDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    return isoDate;
  }
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function extractCalendarOffsetDays(
  html: string,
  key: string,
  fallback: number,
): number {
  const pattern = new RegExp(
    `${key}\\s*:\\s*new Date\\([\\s\\S]{0,140}?getDate\\(\\)\\s*\\+\\s*(\\d+)`,
    "i",
  );
  const match = html.match(pattern);
  const parsed = match?.[1] ? Number(match[1]) : NaN;
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function extractAvailabilityFromRightWidgetHtml(
  html: string,
  todayIso: string,
  horizonIso: string,
): {
  hasCalendarWidget: boolean;
  bookingRestrictions: string[];
  items: Array<{ date: string; code: LuxuryDayCode; minNights: number | null }>;
  minNightRules: Array<{
    start_date: string;
    end_date: string;
    min_nights: number;
    raw_rule: string;
  }>;
} {
  const hasCalendarWidget =
    html.includes('id="rt-datepick-app"') || html.includes("bookings:");
  if (!hasCalendarWidget) {
    return {
      hasCalendarWidget: false,
      bookingRestrictions: [],
      items: [],
      minNightRules: [],
    };
  }

  type BookingRange = { start: string; end: string };
  type MinDayRule = { startDate: string; endDate: string; minimum: number };

  const parseArray = <T>(key: string): T[] => {
    const literal = extractJsArrayLiteralByKey(html, key);
    if (!literal) {
      return [];
    }

    try {
      return JSON.parse(literal.replace(/\\\//g, "/")) as T[];
    } catch {
      return [];
    }
  };

  const bookings = parseArray<BookingRange>("bookings");
  const minDays = parseArray<MinDayRule>("minDays");

  const startOffsetDays = extractCalendarOffsetDays(html, "calStartDate", 1);
  const endOffsetDays = extractCalendarOffsetDays(html, "calEndDate", 365);
  const preloadStartIso = addUtcDays(todayIso, startOffsetDays);
  const preloadEndIso = addUtcDays(todayIso, endOffsetDays);

  const statusByDate = new Map<string, LuxuryDayCode>();
  const minNightsByDate = new Map<string, number>();
  const codePriority: Record<LuxuryDayCode, number> = {
    X: 0,
    A: 1,
    U: 1,
    I: 2,
    O: 2,
  };

  const minNightRules = minDays
    .map((rule) => {
      const start = parseSlashDateToIso(String(rule.startDate ?? ""));
      const end = parseSlashDateToIso(String(rule.endDate ?? ""));
      const minNights = Number(rule.minimum);
      if (!start || !end || !Number.isFinite(minNights) || minNights < 1) {
        return null;
      }

      let cursor = start;
      while (cursor <= end && cursor <= horizonIso) {
        if (cursor >= todayIso) {
          minNightsByDate.set(cursor, Math.floor(minNights));
        }
        cursor = addUtcDays(cursor, 1);
      }

      return {
        start_date: start,
        end_date: end,
        min_nights: Math.floor(minNights),
        raw_rule: `minDays:${start}->${end}=${Math.floor(minNights)}`,
      };
    })
    .filter((rule): rule is NonNullable<typeof rule> => !!rule);

  for (const booking of bookings) {
    const start = parseSlashDateToIso(String(booking.start ?? ""));
    const end = parseSlashDateToIso(String(booking.end ?? ""));
    if (!start || !end || end < start) {
      continue;
    }

    let cursor = start;
    while (cursor <= end) {
      if (cursor >= todayIso && cursor <= horizonIso) {
        const code: LuxuryDayCode =
          cursor === start ? "I" : cursor === end ? "O" : "U";
        const previous = statusByDate.get(cursor);
        if (!previous || codePriority[code] > codePriority[previous]) {
          statusByDate.set(cursor, code);
        }
      }

      cursor = addUtcDays(cursor, 1);
    }
  }

  const items: Array<{
    date: string;
    code: LuxuryDayCode;
    minNights: number | null;
  }> = [];

  let cursor = todayIso;
  while (cursor <= horizonIso) {
    const inPreloadedWindow =
      cursor >= preloadStartIso && cursor <= preloadEndIso;
    const code = inPreloadedWindow ? (statusByDate.get(cursor) ?? "A") : "X";
    items.push({
      date: cursor,
      code,
      minNights: minNightsByDate.get(cursor) ?? null,
    });
    cursor = addUtcDays(cursor, 1);
  }

  return {
    hasCalendarWidget,
    bookingRestrictions: [
      "Unavailable",
      "Check-in only",
      "Check-out only",
      "Selected",
    ],
    items,
    minNightRules,
  };
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

  // CWR-style pages can start above a heavy hero/nav fold; force list context first.
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

  // This site applies filters client-side after initial render; wait for the
  // visible card count to settle before extracting links.
  let stabilizedVisibleCards = 0;
  let stablePasses = 0;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const visibleCards = await page.evaluate(() => {
      const cardAnchors = Array.from(
        document.querySelectorAll(
          ".property a.prop-box-anchor[href], .property a[href*='/emerald-coast-vacation-rentals/'], #properties .property a[href], .props-container .property a[href], a[href*='/emerald-coast-vacation-rentals/']",
        ),
      );

      return cardAnchors.filter((anchor) => {
        const element = anchor as HTMLElement;
        if (element.offsetParent === null) {
          return false;
        }
        const href = (
          (anchor as HTMLAnchorElement).getAttribute("href") ?? ""
        ).toLowerCase();
        return href.includes("/emerald-coast-vacation-rentals/");
      }).length;
    });

    if (visibleCards === stabilizedVisibleCards) {
      stablePasses += 1;
    } else {
      stabilizedVisibleCards = visibleCards;
      stablePasses = 0;
    }

    if (stablePasses >= 2 && stabilizedVisibleCards > 0) {
      break;
    }

    await page.waitForTimeout(Math.max(450, scrollPauseMs));
  }

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
          if (!absolute.hostname.endsWith("funvacay.com")) {
            return "";
          }

          const normalizedPath = absolute.pathname
            .toLowerCase()
            .replace(/\/+$/, "");
          const matchesExpectedPrefix = [
            "/emerald-coast-vacation-rentals/",
          ].some((prefix) => normalizedPath.startsWith(prefix));
          if (!matchesExpectedPrefix) {
            return "";
          }

          const slug = normalizedPath.split("/").filter(Boolean).at(-1) ?? "";
          if (
            !slug ||
            slug === "vacation-rentals" ||
            slug === "search-results" ||
            slug === "results"
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

      const cardAnchors =
        resultRoots.length > 0
          ? resultRoots.flatMap((root) =>
              Array.from(
                root.querySelectorAll(
                  ".property a.prop-box-anchor[href], .property a[href*='/emerald-coast-vacation-rentals/'], a.prop-box-anchor[href], a[href*='/emerald-coast-vacation-rentals/']",
                ),
              ),
            )
          : Array.from(
              document.querySelectorAll(
                ".property a.prop-box-anchor[href], .property a[href*='/emerald-coast-vacation-rentals/'], a[href*='/emerald-coast-vacation-rentals/']",
              ),
            );

      for (const anchor of cardAnchors) {
        const element = anchor as HTMLElement;
        if (element.offsetParent === null) {
          continue;
        }

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

      const explicitCountNodes = Array.from(
        document.querySelectorAll(
          ".results-count, .result-count, .count, [class*='result'][class*='count'], [class*='property'][class*='count']",
        ),
      )
        .map((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim())
        .filter(Boolean);

      for (const text of explicitCountNodes) {
        const countMatch = text.match(/\b(\d{1,4})\b/);
        const parsed = countMatch ? Number(countMatch[1]) : NaN;
        if (Number.isFinite(parsed) && parsed > 0) {
          expectedCount = Math.floor(parsed);
          break;
        }
      }

      const bodyText = document.body?.innerText ?? "";
      if (expectedCount === null) {
        const match = bodyText.match(
          /\b(\d{1,4})\s+(?:results|rentals|properties)\b/i,
        );
        if (match) {
          const parsed = Number(match[1]);
          if (Number.isFinite(parsed) && parsed > 0) {
            expectedCount = Math.floor(parsed);
          }
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
  // Keep infinite-scroll responsive; do not force deep crawl loops.
  const effectiveScrollSteps = Math.max(12, maxScrollSteps);
  const effectivePauseMs = Math.max(220, Math.min(scrollPauseMs, 900));
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

    if (
      discovery.expectedCount === null &&
      discovery.rows.length >= EXPECTED_LISTING_COUNT
    ) {
      reportProgress(
        `discovery reached planner target after scroll step ${step}: ${discovery.rows.length}/${EXPECTED_LISTING_COUNT}`,
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
    if (stagnantSteps >= 8) {
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
    const toIso = (year: number, monthIndex: number, day: number): string => {
      const date = new Date(Date.UTC(year, monthIndex, day));
      if (
        date.getUTCFullYear() !== year ||
        date.getUTCMonth() !== monthIndex ||
        date.getUTCDate() !== day
      ) {
        return "";
      }
      return date.toISOString().slice(0, 10);
    };

    const parseMonthHeader = (
      value: string,
    ): { year: number; monthIndex: number } | null => {
      const cleaned = value.replace(/\s+/g, " ").trim();
      const match = cleaned.match(/^([A-Za-z]+)\s+(\d{4})$/);
      if (!match) {
        return null;
      }

      const monthName = (match[1] ?? "").toLowerCase();
      const year = Number(match[2]);
      const monthLookup: Record<string, number> = {
        jan: 0,
        january: 0,
        feb: 1,
        february: 1,
        mar: 2,
        march: 2,
        apr: 3,
        april: 3,
        may: 4,
        jun: 5,
        june: 5,
        jul: 6,
        july: 6,
        aug: 7,
        august: 7,
        sep: 8,
        sept: 8,
        september: 8,
        oct: 9,
        october: 9,
        nov: 10,
        november: 10,
        dec: 11,
        december: 11,
      };

      const monthIndex = monthLookup[monthName];
      if (!Number.isFinite(monthIndex) || !Number.isFinite(year)) {
        return null;
      }

      return { year, monthIndex };
    };

    const items: Array<{ date: string; code: LuxuryDayCode }> = [];
    const monthHeaders = Array.from(
      document.querySelectorAll(
        ".pdp-availability-calendar-container .mb-2 strong, .pdp-availability-calendar-container .mb-2, #availability .month h3, .bookcalendar .month h3",
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

    if (items.length === 0) {
      const monthNodes = Array.from(
        document.querySelectorAll("#availability .month, .bookcalendar .month"),
      );

      for (const monthNode of monthNodes) {
        const monthLabel = (monthNode.querySelector("h3")?.textContent ?? "")
          .replace(/\s+/g, " ")
          .trim();
        const parsedMonth = parseMonthHeader(monthLabel);
        if (!parsedMonth) {
          continue;
        }

        for (const dayNode of Array.from(
          monthNode.querySelectorAll(".week .day"),
        )) {
          const dayText = (dayNode.textContent ?? "").replace(/\D+/g, "");
          const day = Number(dayText);
          if (!Number.isFinite(day) || day < 1 || day > 31) {
            continue;
          }

          const isoDate = toIso(parsedMonth.year, parsedMonth.monthIndex, day);
          if (!isoDate) {
            continue;
          }

          const classBlob = String(
            (dayNode as HTMLElement).className || "",
          ).toLowerCase();
          let code: LuxuryDayCode = "A";
          if (
            classBlob.includes("booked") ||
            classBlob.includes("unavailable")
          ) {
            code = "U";
          } else if (
            classBlob.includes("start") ||
            classBlob.includes("check-in")
          ) {
            code = "I";
          } else if (
            classBlob.includes("bookend") ||
            classBlob.includes("check-out")
          ) {
            code = "O";
          }

          items.push({ date: isoDate, code });
        }
      }
    }

    const keyText = Array.from(
      document.querySelectorAll(
        ".be-calendar-legend-key-text, .rcav-key, .bre-ui-datepicker-extras, .label, #availability .legend-booked, #availability .legend-open",
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
        ".pdp-availability-calendar, .pdp-availability-calendar-table, .ui-datepicker, .ui-datepicker-inline, .rcav-key, #availability .bookcalendar, #availability .month",
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

        const lowered = text.toLowerCase();
        if (
          lowered.includes("amenities") &&
          lowered.includes("availability") &&
          lowered.includes("reviews")
        ) {
          continue;
        }

        candidates.push(text);
      }
    }

    candidates.sort((left, right) => right.length - left.length);
    return candidates[0] ?? "";
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
    await page
      .waitForSelector(
        "h1, .be-property-widget, #availability, .pdp-availability-calendar, .pdp-property-widget-info-list",
        { timeout: 1200 },
      )
      .catch(() => undefined);
    await page.waitForTimeout(450);

    await clickVisibleControlsByLabel(page, [
      "read more",
      "show more",
      "show more amenities",
      "show more months",
      "show all amenities",
      "show all",
      "view all amenities",
      "all photos",
      "view photos",
      "view gallery",
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
          return "";
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
          return "";
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
          return "";
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
          Array.from(document.querySelectorAll("script"))
            .map((script) => script.textContent ?? "")
            .join("\n")
            .match(/\bunitId\s*:\s*['"]([^'"]+)['"]/i)?.[1]
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
              "#amenities .amenity-wrapper, section#amenities .amenity-wrapper, [id='amenities'] .amenity-wrapper",
            ),
          );
          for (const field of wrappers) {
            const heading =
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
            const rtAmenityGroups = Array.from(
              document.querySelectorAll(
                "#amenities .amen-group-wrap, section#amenities .amen-group-wrap",
              ),
            );

            for (const group of rtAmenityGroups) {
              const category =
                (group.querySelector(".amencat")?.textContent ?? "")
                  .replace(/\s+/g, " ")
                  .trim() || "General";

              const items = Array.from(
                group.querySelectorAll(".pdamenity, .amenity .pdamenity"),
              )
                .map((node) =>
                  (node.textContent ?? "").replace(/\s+/g, " ").trim(),
                )
                .filter(Boolean);

              if (items.length > 0) {
                categories[category] = Array.from(new Set(items));
              }
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
          const mediaRoot =
            document.querySelector("#Media") ??
            document.querySelector('[id="media"]') ??
            document.querySelector("#pdpHiddenGallery") ??
            document.querySelector(".pdp-property-widget-img-area") ??
            document;
          if (!mediaRoot) {
            return urls;
          }

          const attrValues = Array.from(
            mediaRoot.querySelectorAll(
              "a[href], a[data-srcset], a[data-thumb], a.fancygallery[href], img[src], img[srcset], img[data-src], img[data-lazy-src], img[data-rstmb], [data-rsbigimg], [data-image], .image-canvas[style*='background-image']",
            ),
          );

          for (const node of attrValues) {
            const attrs = [
              node.getAttribute("href"),
              node.getAttribute("src"),
              node.getAttribute("srcset"),
              node.getAttribute("data-src"),
              node.getAttribute("data-lazy-src"),
              node.getAttribute("data-rstmb"),
              node.getAttribute("data-rsbigimg"),
              node.getAttribute("data-srcset"),
              node.getAttribute("data-thumb"),
              node.getAttribute("data-image"),
              node.getAttribute("style"),
            ];
            for (const raw of attrs) {
              if (!raw) {
                continue;
              }
              try {
                const backgroundMatch = raw.match(
                  /background-image:\s*url\((['"]?)([^)'"]+)\1\)/i,
                );
                const candidate =
                  backgroundMatch?.[2] ??
                  raw.split(",")[0]?.trim().split(/\s+/)[0] ??
                  "";
                const absolute = new URL(
                  candidate,
                  window.location.origin,
                ).toString();
                if (
                  /\.(jpe?g|png|webp|gif)(\?|$)/i.test(absolute) ||
                  absolute.includes("/unitimages/") ||
                  absolute.includes("picturehandler.ashx") ||
                  absolute.includes("/evrn/") ||
                  absolute.includes("/images.")
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
    const descriptionExpanded = stripHtml(descriptionText).slice(0, 30000);

    const dayCodeByDate = new Map<string, LuxuryDayCode>();
    const minNightsByDate = new Map<string, number>();
    const codePriority: Record<LuxuryDayCode, number> = {
      X: 0,
      A: 1,
      U: 1,
      I: 2,
      O: 2,
    };

    const bookingRestrictions = new Set<string>();
    let minNightRules: Array<{
      start_date: string;
      end_date: string;
      min_nights: number;
      raw_rule: string;
    }> = [];
    const seenMonthSignatures = new Set<string>();

    let calendarClicks = 0;
    let calendarIterations = 0;
    let stagnantIterations = 0;

    const now = new Date();
    const todayIso = now.toISOString().slice(0, 10);
    const horizon = new Date(now);
    horizon.setUTCDate(horizon.getUTCDate() + availabilityHorizonDays);
    const horizonIso = horizon.toISOString().slice(0, 10);

    const externalListingId = extractExternalListingId(detailUrl);

    const htmlPath = resolve(
      OUTPUT_DETAILS_HTML_DIR,
      `${externalListingId}.html`,
    );
    const html = await page.content();
    await writeFile(htmlPath, html, "utf8");

    const rightWidgetAvailability = extractAvailabilityFromRightWidgetHtml(
      html,
      todayIso,
      horizonIso,
    );

    if (rightWidgetAvailability.items.length > 0) {
      for (const restriction of rightWidgetAvailability.bookingRestrictions) {
        bookingRestrictions.add(restriction);
      }

      minNightRules = rightWidgetAvailability.minNightRules;

      for (const item of rightWidgetAvailability.items) {
        const previous = dayCodeByDate.get(item.date);
        if (!previous || codePriority[item.code] > codePriority[previous]) {
          dayCodeByDate.set(item.date, item.code);
        }

        if (item.minNights !== null && item.minNights > 0) {
          minNightsByDate.set(item.date, item.minNights);
        }
      }
    } else {
      await clickTab(page, "Availability");

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
        if (stagnantIterations >= 2) {
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
        await page.waitForTimeout(450);
      }
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
          min_nights_required: minNightsByDate.get(date) ?? null,
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

    const jsonLdSignals = parseJsonLdSignals(html);
    const locationPayload = extractFieldLocationFromHtml(html);
    const extractedUnitId =
      stripHtml(extracted.unitId).trim() || extractUnitIdFromHtml(html);
    const unitCardSignals = extractUnitCardSignals(html, extractedUnitId);
    const primaryUnitType = extractPrimaryUnitTypeFromHtml(html);

    const beds =
      parseFirstNumber(extracted.bedroomsText) ?? jsonLdSignals.beds ?? null;
    const baths =
      parseFirstNumber(extracted.bathroomsText) ?? jsonLdSignals.baths ?? null;
    const sleeps =
      parseFirstNumber(extracted.sleepsText) ?? jsonLdSignals.sleeps ?? null;
    const neighborhood = stripHtml(
      extracted.neighborhoodText || jsonLdSignals.city,
    ).slice(0, 240);

    const latitudeRaw =
      locationPayload.latitude ??
      unitCardSignals.latitude ??
      jsonLdSignals.latitude ??
      null;
    const longitudeRaw =
      locationPayload.longitude ??
      unitCardSignals.longitude ??
      jsonLdSignals.longitude ??
      null;
    const latitude = latitudeRaw === 0 ? null : latitudeRaw;
    const longitude = longitudeRaw === 0 ? null : longitudeRaw;

    const streetAddress = stripHtml(
      locationPayload.street ||
        unitCardSignals.street ||
        jsonLdSignals.street ||
        [unitCardSignals.city, jsonLdSignals.city, jsonLdSignals.state]
          .filter(Boolean)
          .join(", "),
    ).slice(0, 240);

    const cityStateFromAddress = parseCityStateFromAddress(streetAddress);
    const profileCity =
      cityStateFromAddress.city || stripHtml(jsonLdSignals.city).slice(0, 80);
    const profileState =
      cityStateFromAddress.state || stripHtml(jsonLdSignals.state).slice(0, 20);

    const propertyProfile: LuxuryDetailRecord["property_profile"] = {
      unit_id: stripHtml(extractedUnitId || externalListingId).slice(0, 140),
      unit_type: stripHtml(primaryUnitType || unitCardSignals.unitType).slice(
        0,
        80,
      ),
      area: neighborhood,
      location: neighborhood,
      beds,
      baths,
      sleeps,
      city: profileCity,
      state: profileState,
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

    if (Object.keys(amenitiesCategories).length === 0) {
      const jsonLdAmenities = dedupePreserveOrder(
        jsonLdSignals.amenities
          .map((item) => stripHtml(item).slice(0, 200))
          .filter(Boolean),
      );
      if (jsonLdAmenities.length > 0) {
        amenitiesCategories.General = jsonLdAmenities;
      }
    }

    const amenitiesAll = dedupePreserveOrder(
      Object.values(amenitiesCategories).flat(),
    );
    const amenities: LuxuryDetailRecord["amenities"] = {
      categories: amenitiesCategories,
      all: amenitiesAll,
    };

    const mediaUrls = dedupePreserveOrder(
      [...extracted.galleryUrls, ...jsonLdSignals.imageUrls]
        .map((url) => normalizeGalleryUrl(url))
        .filter((url) => {
          if (!url.includes("/unitimages/")) {
            return true;
          }
          if (!extractedUnitId) {
            return true;
          }
          return url.includes(`/${extractedUnitId}/`);
        })
        .filter(
          (url) =>
            !/30a-vacay-logo|\/themes\/rtapi\/images\/lightning\.png/i.test(
              url,
            ),
        )
        .filter(Boolean),
    );
    const mediaGallery: LuxuryDetailRecord["media_gallery"] = {
      image_count: mediaUrls.length,
      image_urls: mediaUrls,
    };

    const directionsQuery =
      streetAddress ||
      (latitude !== null && longitude !== null
        ? `${latitude},${longitude}`
        : "");

    const location: LuxuryDetailRecord["location"] = {
      address: streetAddress,
      location_label: neighborhood,
      directions_url: directionsQuery
        ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(directionsQuery)}`
        : "",
      directions_daddr: directionsQuery,
      latitude,
      longitude,
    };

    const listingName = normalizeListingName(
      extracted.h1 || extracted.title || externalListingId,
    );

    const normalizedMatchingProfile = {
      source: "pm_funvacay30a" as const,
      external_listing_id: externalListingId,
      name: listingName,
      description: stripHtml(
        descriptionText || extracted.metaDescription,
      ).slice(0, 15000),
      match_signals: {
        description_normalized: normalizeForMatch(
          stripHtml(descriptionText || extracted.metaDescription).slice(
            0,
            15000,
          ),
        ),
        description_sha256: hashSha256(
          normalizeForMatch(
            stripHtml(descriptionText || extracted.metaDescription).slice(
              0,
              15000,
            ),
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
    const rcavIdentity = extractRcavIdentityFromSource(
      `${descriptionExpanded}\n${html}`,
    );
    if (!rcavIdentity) {
      throw new Error(
        `Missing required quote context identity tuple (eid/type/id) for ${externalListingId}`,
      );
    }

    return {
      external_listing_id: externalListingId,
      detail_url: detailUrl,
      fetched_at: new Date().toISOString(),
      title: normalizeListingName(extracted.title || extracted.h1 || ""),
      h1: listingName,
      canonical_url: extracted.canonical || detailUrl,
      meta_description: stripHtml(extracted.metaDescription).slice(0, 2000),
      description_expanded: descriptionExpanded,
      amenities,
      location,
      media_gallery: mediaGallery,
      property_profile: propertyProfile,
      quote_context: {
        source: "description_expanded" as const,
        item_eid: rcavIdentity.itemEid,
        type_id: rcavIdentity.typeId,
        inventory_id: rcavIdentity.inventoryId,
        detail_url: detailUrl,
        endpoint_path: "/rescms/ajax/item/pricing/quote" as const,
      },
      normalized_matching_profile: normalizedMatchingProfile,
      normalized_availability: {
        source: "pm_funvacay30a",
        external_listing_id: externalListingId,
        captured_at: new Date().toISOString(),
        has_calendar_widget: normalizedDays.length > 0,
        booking_restrictions: Array.from(bookingRestrictions),
        min_night_rules: minNightRules,
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
      pricing_api_hints: {
        provider: "cwr-router",
        endpoint_path: "/vacation-rentals/router/",
        method_names: {
          pre_reservation_price: "getPrice",
        },
        required_payload_fields: [
          "call",
          "unitId",
          "arrive",
          "depart",
          "adult",
          "child",
        ],
        notes:
          "FunVacay exposes pre-reservation quote responses via /vacation-rentals/router/ with call=getPrice. Use unitId plus arrive/depart for stay pricing; response typically includes availability and booking totals.",
      },
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "unknown detail pull error";
    console.warn(
      `[funvacay30a] detail pull failed for ${detailUrl}: ${message}`,
    );
    return null;
  } finally {
    await page.close();
  }
}

export function createFunVacay30AAdapter(): ScraperAdapter<LuxuryDetailRecord> {
  return {
    managerKey: "funvacay30a",
    scriptLabel: "funvacay30a",
    defaultAnchorUrl: DEFAULT_ANCHOR_URL,
    detailFetchDelayMs: Math.max(
      0,
      Number(process.env.FUNVACAY30A_DETAIL_FETCH_DELAY_MS ?? "40") || 40,
    ),
    detailFetchConcurrency: Math.max(
      1,
      Number(process.env.FUNVACAY30A_DETAIL_FETCH_CONCURRENCY ?? "6") || 6,
    ),
    availabilityHorizonDays: Math.max(
      1,
      Number(process.env.FUNVACAY30A_AVAILABILITY_HORIZON_DAYS ?? "730") || 730,
    ),
    maxCalendarAdvanceMonths: Math.max(
      8,
      Number(process.env.FUNVACAY30A_CALENDAR_MAX_MONTHS ?? "26") || 26,
    ),
    isValidDetailUrl(value: string): string | null {
      try {
        const parsed = new URL(value.trim());
        if (
          !parsed.hostname.endsWith("funvacay.com") ||
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
        "funvacay30a",
        argv,
      );
      await runRuntimeAdapterQuoteCli(
        {
          adapterKey: "funvacay30a",
          executeSingleQuote: executeFunvacay30aSingleQuote,
          maxAttemptsEnvVar: "FUNVACAY30A_QUOTE_MAX_ATTEMPTS",
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
      const result = await executeFunvacay30aSingleQuote({
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
              process.env.FUNVACAY30A_QUOTE_TIMEOUT_MS ??
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
            reason: result.observation.quoteAvailable
              ? null
              : "Quote unavailable",
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
          handoffUrl: null,
          reason: result.error.message,
        },
      };
    },
  };
}
