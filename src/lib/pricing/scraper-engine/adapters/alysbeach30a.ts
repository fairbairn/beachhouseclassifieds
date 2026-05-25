import { executeAlysBeach30ASingleQuote } from "@/lib/pricing/quote-runtime/adapters/alysbeach30a";
import { runRuntimeAdapterQuoteCli } from "@/lib/pricing/quotes/shared/runtime-adapter-quote-runner";
import { canonicalizeExternalListingId } from "@/lib/pricing/shared/external-listing-id";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { normalizeAdapterQuoteScopeArgs } from "../quote-scope";
import type { DetailRecordBase, ScrapedLink, ScraperAdapter } from "../types";

type OverseeDayCode = "A" | "U" | "I" | "O" | "X";
type CanonicalDayCode = "Y" | "N";
type CanonicalChangeoverCode = "C" | "I" | "O" | "X";

type MinNightRule = {
  start: string;
  end: string;
  minLOS: number;
};

type ParsedMinNightRule = {
  start_date: string;
  end_date: string;
  min_nights: number;
};

type BookingWindowDay = {
  allow?: {
    arrival?: boolean;
    departure?: boolean;
  };
  stay?: {
    min?: number;
  };
};

type OverseeBookedDatesResponse = {
  bookedDates?: unknown;
  noCheckin?: unknown;
  minLOS?: unknown;
  minNights?: unknown;
  bookingWindow?: {
    RR?: Record<string, BookingWindowDay>;
  };
};

type OverseeDetailRecord = DetailRecordBase & {
  quote_context: {
    listing_id: string;
    detail_url: string;
    infants: number;
    pets: number;
  };
  title: string;
  h1: string;
  canonical_url: string;
  meta_description: string;
  description_expanded: string;
  rooms_guidance: false;
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
  normalized_matching_profile: {
    source: "pm_alysbeach30a";
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
    source: "pm_alysbeach30a";
    external_listing_id: string;
    captured_at: string;
    has_calendar_widget: boolean;
    min_night_rules: ParsedMinNightRule[];
    window_start: string;
    window_end: string;
    code_legend: {
      A: "available";
      U: "unavailable";
      I: "checkout_only";
      O: "checkin_only";
      X: "other";
    };
    day_codes: string;
    days: Array<{
      date: string;
      day_code: CanonicalDayCode;
      status_code: OverseeDayCode;
      changeover_code: CanonicalChangeoverCode;
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
  availability_raw: {
    booked_dates: string[];
    no_checkin_dates: string[];
    min_los: number | null;
    min_night_rules: ParsedMinNightRule[];
    booking_window_days: number;
  };
  property_profile: {
    unit_id: string;
    property_code: string;
    unit_slug: string;
    unit_type: string;
    city: string;
    state: string;
    zip: string;
    beds: number | null;
    baths: number | null;
    sleeps: number | null;
  };
};

const DEFAULT_ANCHOR_URL =
  "https://vacation.alysbeach.com/vacation-properties/?search%5Bsort%5D=random&search%5Border%5D=19&search%5Bshowall%5D=1&show=200";
const OUTPUT_ROOT = resolve(
  process.cwd(),
  "src",
  "lib",
  "data",
  "external-sources",
  "alysbeach30a",
);
const OUTPUT_DETAILS_HTML_DIR = resolve(OUTPUT_ROOT, "details", "html");

function normalizeLink(url: string): string {
  return url.split("#")[0]?.replace(/\/+$/, "") ?? url;
}

function stripHtml(value: string): string {
  return value
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractFirst(regex: RegExp, value: string): string {
  const match = value.match(regex);
  if (!match?.[1]) {
    return "";
  }
  return stripHtml(match[1]);
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

function normalizeDetailUrl(value: string): string | null {
  try {
    const parsed = new URL(value.trim());
    if (!parsed.hostname.endsWith("vacation.alysbeach.com")) {
      return null;
    }

    const path = parsed.pathname.replace(/\/+$/, "");
    const parts = path.split("/").filter(Boolean);
    if (
      parts.length < 3 ||
      parts[0] !== "vrp" ||
      parts[1] !== "unit" ||
      !parts[2]
    ) {
      return null;
    }

    return normalizeLink(`${parsed.origin}/vrp/unit/${parts[2]}`);
  } catch {
    return null;
  }
}

function decodeHtmlAttributeValue(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function extractUnitDataAttributes(html: string): Record<string, string> {
  const containerMatch = html.match(/<[^>]+id=["']unit-data["'][^>]*>/i);
  if (!containerMatch) {
    return {};
  }

  const attrs: Record<string, string> = {};
  const attrRegex = /data-([a-z0-9-]+)=["']([\s\S]*?)["']/gi;
  let match: RegExpExecArray | null = attrRegex.exec(containerMatch[0]);
  while (match) {
    const key = match[1]?.toLowerCase() ?? "";
    const value = decodeHtmlAttributeValue(match[2] ?? "");
    if (key) {
      attrs[key] = value;
    }
    match = attrRegex.exec(containerMatch[0]);
  }

  return attrs;
}

function parseNumberLike(value: string | undefined): number | null {
  const numeric = Number(String(value ?? "").trim());
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return numeric;
}

function parseCoordinateLike(
  value: string | undefined,
  axis: "lat" | "lng",
): number | null {
  const parsed = parseNumberLike(value);
  if (parsed === null) {
    return null;
  }

  if (Math.abs(parsed) < 1e-9) {
    return null;
  }

  if (axis === "lat") {
    return parsed >= -90 && parsed <= 90 ? parsed : null;
  }

  return parsed >= -180 && parsed <= 180 ? parsed : null;
}

function extractGoogleMapsLlCoordinates(
  html: string,
): { latitude: number; longitude: number } | null {
  const match = html.match(
    /https?:\/\/maps\.google\.com\/maps\?[^"'\s>]*\bll=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/i,
  );
  if (!match) {
    return null;
  }

  const latitude = parseCoordinateLike(match[1], "lat");
  const longitude = parseCoordinateLike(match[2], "lng");
  if (latitude === null || longitude === null) {
    return null;
  }

  return { latitude, longitude };
}

function extractCoordinatesFromMapValue(
  value: string,
): { latitude: number; longitude: number } | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const llMatch = trimmed.match(
    /(?:[?&]|\b)ll=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/i,
  );
  if (llMatch) {
    const latitude = parseCoordinateLike(llMatch[1], "lat");
    const longitude = parseCoordinateLike(llMatch[2], "lng");
    if (latitude !== null && longitude !== null) {
      return { latitude, longitude };
    }
  }

  const qMatch = trimmed.match(
    /(?:[?&]|\b)q=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/i,
  );
  if (qMatch) {
    const latitude = parseCoordinateLike(qMatch[1], "lat");
    const longitude = parseCoordinateLike(qMatch[2], "lng");
    if (latitude !== null && longitude !== null) {
      return { latitude, longitude };
    }
  }

  const atMatch = trimmed.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/i);
  if (atMatch) {
    const latitude = parseCoordinateLike(atMatch[1], "lat");
    const longitude = parseCoordinateLike(atMatch[2], "lng");
    if (latitude !== null && longitude !== null) {
      return { latitude, longitude };
    }
  }

  return null;
}

async function extractLocationTabCoordinates(
  browser: Parameters<
    ScraperAdapter<OverseeDetailRecord>["fetchDetail"]
  >[0]["browser"],
  detailUrl: string,
): Promise<{ latitude: number; longitude: number } | null> {
  const page = await browser.newPage();

  try {
    await page.goto(detailUrl, {
      waitUntil: "domcontentloaded",
      timeout: 120000,
    });

    await page.waitForTimeout(1200);

    await page.evaluate(() => {
      const target =
        (document.querySelector("#gmaplink") as HTMLElement | null) ??
        (document.querySelector(
          'li[aria-controls="location"], [role="tab"][aria-controls="location"]',
        ) as HTMLElement | null);

      if (!target) {
        return;
      }

      target.click();
      target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await page.waitForTimeout(1800);

    const htmlAfterClick = await page.content();
    const htmlCoords = extractGoogleMapsLlCoordinates(htmlAfterClick);
    if (htmlCoords) {
      return htmlCoords;
    }

    const extracted = await page.evaluate(() => {
      const unitData = document.querySelector("#unit-data");
      const unitLat = unitData?.getAttribute("data-unit-latitude") ?? "";
      const unitLng = unitData?.getAttribute("data-unit-longitude") ?? "";

      const mapValues = new Set<string>();
      const mapNodes = Array.from(
        document.querySelectorAll("a[href], iframe[src]"),
      );
      for (const node of mapNodes) {
        const href =
          (node as HTMLAnchorElement).getAttribute("href") ||
          (node as HTMLIFrameElement).getAttribute("src") ||
          "";
        if (!href) {
          continue;
        }
        if (
          href.includes("google.com/maps") ||
          href.includes("maps.google.com")
        ) {
          mapValues.add(href);
        }
      }

      const locationRoot = document.querySelector("#location");
      if (locationRoot) {
        const text = locationRoot.textContent || "";
        if (text) {
          mapValues.add(text);
        }
        const locationHtml = locationRoot.outerHTML || "";
        if (locationHtml) {
          mapValues.add(locationHtml);
        }
      }

      return {
        unitLat,
        unitLng,
        mapValues: Array.from(mapValues),
      };
    });

    const latFromUnit = parseCoordinateLike(extracted.unitLat, "lat");
    const lngFromUnit = parseCoordinateLike(extracted.unitLng, "lng");
    if (latFromUnit !== null && lngFromUnit !== null) {
      return { latitude: latFromUnit, longitude: lngFromUnit };
    }

    for (const value of extracted.mapValues) {
      const coords = extractCoordinatesFromMapValue(value);
      if (coords) {
        return coords;
      }
    }

    return null;
  } catch {
    return null;
  } finally {
    await page.close();
  }
}

function absoluteHttpUrl(value: string, baseUrl: string): string | null {
  const raw = value.trim();
  if (!raw) {
    return null;
  }

  if (/^https?:\/\//i.test(raw)) {
    return raw;
  }

  if (raw.startsWith("//")) {
    return `https:${raw}`;
  }

  try {
    return new URL(raw, baseUrl).toString();
  } catch {
    return null;
  }
}

function extractSectionBetween(
  html: string,
  startId: string,
  nextIds: string[],
): string {
  const startRegex = new RegExp(`<div\\s+id=["']${startId}["'][^>]*>`, "i");
  const startMatch = html.match(startRegex);
  if (!startMatch || typeof startMatch.index !== "number") {
    return "";
  }

  const sectionStart = startMatch.index + startMatch[0].length;
  let sectionEnd = html.length;
  const afterStart = html.slice(sectionStart);

  for (const nextId of nextIds) {
    const nextRegex = new RegExp(`<div\\s+id=["']${nextId}["'][^>]*>`, "i");
    const nextMatch = afterStart.match(nextRegex);
    if (nextMatch && typeof nextMatch.index === "number") {
      sectionEnd = Math.min(sectionEnd, sectionStart + nextMatch.index);
    }
  }

  return html.slice(sectionStart, sectionEnd);
}

function extractDescriptionExpanded(html: string, fallback: string): string {
  const descriptionSection = extractSectionBetween(html, "description", [
    "unit-info",
    "houserules",
    "amenities",
  ]);

  if (!descriptionSection) {
    return fallback;
  }

  const chunks: string[] = [];

  const iconRegex =
    /<div[^>]+class=["'][^"']*icon_info[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi;
  let iconMatch: RegExpExecArray | null = iconRegex.exec(descriptionSection);
  while (iconMatch) {
    const text = stripHtml(iconMatch[1] ?? "");
    if (text) {
      chunks.push(text);
    }
    iconMatch = iconRegex.exec(descriptionSection);
  }

  const paragraphRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let paragraphMatch: RegExpExecArray | null =
    paragraphRegex.exec(descriptionSection);
  while (paragraphMatch) {
    const text = stripHtml(paragraphMatch[1] ?? "");
    if (text) {
      chunks.push(text);
    }
    paragraphMatch = paragraphRegex.exec(descriptionSection);
  }

  if (chunks.length === 0) {
    return fallback;
  }

  return chunks.join("\n\n").slice(0, 20000);
}

function extractAmenities(html: string): {
  categories: Record<string, string[]>;
  all: string[];
} {
  const amenitiesSection = extractSectionBetween(html, "amenities", [
    "bedandbaths",
    "location",
    "community",
  ]);

  if (!amenitiesSection) {
    return { categories: {}, all: [] };
  }

  const categories: Record<string, string[]> = {};
  const all = new Set<string>();

  const groupRegex =
    /<div[^>]+class=["'][^"']*vrp-amen-group[^"']*["'][^>]*>[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>[\s\S]*?<ul[^>]*>([\s\S]*?)<\/ul>/gi;
  let groupMatch: RegExpExecArray | null = groupRegex.exec(amenitiesSection);
  while (groupMatch) {
    const categoryName = stripHtml(groupMatch[1] ?? "") || "General";
    const listHtml = groupMatch[2] ?? "";

    const items: string[] = [];
    const itemRegex =
      /<li[^>]*class=["'][^"']*vrp-amen-name[^"']*["'][^>]*>[\s\S]*?<span[^>]*>([^<]+)/gi;
    let itemMatch: RegExpExecArray | null = itemRegex.exec(listHtml);
    while (itemMatch) {
      const item = stripHtml(itemMatch[1] ?? "");
      if (item) {
        items.push(item);
        all.add(item);
      }
      itemMatch = itemRegex.exec(listHtml);
    }

    if (items.length > 0) {
      categories[categoryName] = Array.from(new Set(items));
    }

    groupMatch = groupRegex.exec(amenitiesSection);
  }

  if (Object.keys(categories).length === 0) {
    const categoryRegex =
      /<div[^>]+class=["'][^"']*amenities-category[^"']*["'][^>]*>[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>[\s\S]*?<ul[^>]*>([\s\S]*?)<\/ul>/gi;
    let categoryMatch: RegExpExecArray | null =
      categoryRegex.exec(amenitiesSection);
    while (categoryMatch) {
      const categoryName = stripHtml(categoryMatch[1] ?? "") || "General";
      const listHtml = categoryMatch[2] ?? "";

      const items = Array.from(listHtml.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi))
        .map((entry) => stripHtml(entry[1] ?? ""))
        .map((entry) => entry.replace(/\s+/g, " ").trim())
        .filter(Boolean);

      if (items.length > 0) {
        const uniqueItems = Array.from(new Set(items));
        categories[categoryName] = uniqueItems;
        for (const item of uniqueItems) {
          all.add(item);
        }
      }

      categoryMatch = categoryRegex.exec(amenitiesSection);
    }
  }

  return {
    categories,
    all: Array.from(all),
  };
}

function extractAmenityHintsFromDescription(description: string): string[] {
  const text = description.replace(/\s+/g, " ").trim();
  if (!text) {
    return [];
  }

  const hintKeywords = [
    "pool",
    "beach",
    "wifi",
    "cable",
    "kitchen",
    "grill",
    "security",
    "concierge",
    "wellness",
    "racquet",
  ];

  const segments = text
    .split(/[.;]|\u2022|\n/)
    .map((value) => value.replace(/\s+/g, " ").trim())
    .filter((value) => value.length >= 6 && value.length <= 120);

  const hints = new Set<string>();
  for (const segment of segments) {
    const lowered = segment.toLowerCase();
    if (!hintKeywords.some((keyword) => lowered.includes(keyword))) {
      continue;
    }
    hints.add(segment.slice(0, 120));
    if (hints.size >= 24) {
      break;
    }
  }

  return Array.from(hints);
}

function collectMediaUrls(html: string, baseUrl: string): string[] {
  const urls = new Set<string>();

  const unwrapOverseeImageUrl = (url: string): string | null => {
    try {
      const parsed = new URL(url);
      if (parsed.hostname === "img.trackhs.com") {
        const wrappedPath = decodeURIComponent(
          parsed.pathname.replace(/^\/x\d+\//i, ""),
        ).trim();
        if (/^https?:\/\//i.test(wrappedPath)) {
          return wrappedPath;
        }
      }

      return parsed.toString();
    } catch {
      return null;
    }
  };

  const addUrl = (value: string | null | undefined) => {
    if (!value) {
      return;
    }

    const normalized = absoluteHttpUrl(value, baseUrl);
    if (!normalized) {
      return;
    }

    const canonicalImageUrl = unwrapOverseeImageUrl(normalized);
    if (!canonicalImageUrl) {
      return;
    }

    if (
      canonicalImageUrl.includes("track-pm.s3.amazonaws.com/alysbeach/image")
    ) {
      urls.add(canonicalImageUrl);
    }
  };

  const ogImage = html.match(
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>/i,
  );
  addUrl(ogImage?.[1] ?? "");

  const srcRegex = /(?:data-src|src)=["']([^"']+)["']/gi;
  let srcMatch: RegExpExecArray | null = srcRegex.exec(html);
  while (srcMatch) {
    addUrl(srcMatch[1] ?? "");
    srcMatch = srcRegex.exec(html);
  }

  return Array.from(urls);
}

function parseMdyyyyToIso(value: string): string | null {
  const cleaned = value.trim();
  const match = cleaned.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (!match) {
    return null;
  }

  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (!month || !day || !year) {
    return null;
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString().slice(0, 10);
}

function formatIsoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function formatMdyyyyFromIso(isoDate: string): string {
  const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return "";
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!year || !month || !day) {
    return "";
  }
  return `${month}-${day}-${year}`;
}

function parseIsoDate(value: string): Date | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!year || !month || !day) {
    return null;
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseMinNightRules(value: unknown): ParsedMinNightRule[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const parsed: ParsedMinNightRule[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const start = String((item as MinNightRule).start ?? "").trim();
    const end = String((item as MinNightRule).end ?? "").trim();
    const minLOS = Number((item as MinNightRule).minLOS ?? 0);

    const startDate = parseIsoDate(start);
    const endDate = parseIsoDate(end);
    if (!startDate || !endDate || minLOS <= 0 || !Number.isFinite(minLOS)) {
      continue;
    }

    parsed.push({
      start_date: formatIsoDate(startDate),
      end_date: formatIsoDate(endDate),
      min_nights: Math.floor(minLOS),
    });
  }

  return parsed.sort((left, right) =>
    left.start_date.localeCompare(right.start_date),
  );
}

function resolveMinNightsForDate(
  isoDate: string,
  rules: ParsedMinNightRule[],
  bookingWindowDay: BookingWindowDay | null,
): number | null {
  const windowMin = Number(bookingWindowDay?.stay?.min ?? 0);
  if (Number.isFinite(windowMin) && windowMin > 0) {
    return Math.floor(windowMin);
  }

  let result: number | null = null;
  for (const rule of rules) {
    if (isoDate < rule.start_date || isoDate > rule.end_date) {
      continue;
    }
    result =
      result === null ? rule.min_nights : Math.max(result, rule.min_nights);
  }

  return result;
}

function applyStatusCode(
  day: OverseeDetailRecord["normalized_availability"]["days"][number],
  statusCode: OverseeDayCode,
): void {
  day.status_code = statusCode;
  day.day_code = statusCode === "A" || statusCode === "O" ? "Y" : "N";
  day.changeover_code =
    statusCode === "I"
      ? "I"
      : statusCode === "O"
        ? "O"
        : statusCode === "A"
          ? "C"
          : "X";
  day.is_available = statusCode === "A";
  day.is_available_for_checkin = statusCode === "A" || statusCode === "O";
  day.is_available_for_checkout = statusCode === "A" || statusCode === "I";
  day.booking_day_state =
    statusCode === "A"
      ? "bookable"
      : statusCode === "U"
        ? "blocked"
        : "unknown";
}

function inferMaxPageFromHtml(html: string): number {
  let maxPage = 1;

  const pageHrefRegex = /[?&]page=(\d+)/gi;
  let pageMatch: RegExpExecArray | null = pageHrefRegex.exec(html);
  while (pageMatch) {
    const pageNumber = Number(pageMatch[1]);
    if (Number.isInteger(pageNumber) && pageNumber > maxPage) {
      maxPage = pageNumber;
    }
    pageMatch = pageHrefRegex.exec(html);
  }

  const totalPageVar = html.match(/totalPages\s*=\s*(\d+)/i);
  const totalFromVar = Number(totalPageVar?.[1] ?? "");
  if (Number.isInteger(totalFromVar) && totalFromVar > maxPage) {
    maxPage = totalFromVar;
  }

  return maxPage;
}

function extractUnitLinksFromHtml(html: string): string[] {
  const links = new Set<string>();
  const regex =
    /(?:https?:\/\/vacation\.alysbeach\.com)?\/vrp\/unit\/[^"'\s<]+/gi;

  let match: RegExpExecArray | null = regex.exec(html);
  while (match) {
    const raw = match[0] ?? "";
    const candidate = raw.startsWith("/")
      ? `https://vacation.alysbeach.com${raw}`
      : raw;
    const normalized = normalizeDetailUrl(candidate);
    if (normalized) {
      links.add(normalized);
    }
    match = regex.exec(html);
  }

  return Array.from(links);
}

function extractSlugFromDetailUrl(detailUrl: string): string {
  try {
    const parsed = new URL(detailUrl);
    const parts = parsed.pathname.split("/").filter(Boolean);
    return parts[2] ?? "";
  } catch {
    return "";
  }
}

function toSearchAjaxUrl(anchorUrl: string, pageNumber: number): string {
  const source = new URL(anchorUrl);
  const endpoint = new URL("https://vacation.alysbeach.com/");
  endpoint.searchParams.set("vrpjax", "1");
  endpoint.searchParams.set("act", "search");

  for (const [key, value] of source.searchParams.entries()) {
    endpoint.searchParams.append(key, value);
  }

  endpoint.searchParams.set("page", String(pageNumber));
  return endpoint.toString();
}

async function discoverListings(
  page: Parameters<
    ScraperAdapter<OverseeDetailRecord>["discoverListings"]
  >[0]["page"],
  anchorUrl: string,
  maxScrollSteps: number,
  scrollPauseMs: number,
  reportProgress: (message: string) => void,
): Promise<ScrapedLink[]> {
  const sourceUrl = anchorUrl.includes("vacation.alysbeach.com")
    ? anchorUrl
    : DEFAULT_ANCHOR_URL;

  await page.goto(sourceUrl, {
    waitUntil: "domcontentloaded",
    timeout: 120000,
  });
  await page.waitForTimeout(Math.max(900, scrollPauseMs));

  const discovered = new Set<string>();
  const sourceByLink = new Map<string, string>();

  const firstHtml = await page.content();
  for (const link of extractUnitLinksFromHtml(firstHtml)) {
    discovered.add(link);
    sourceByLink.set(link, sourceUrl);
  }

  const inferredMaxPage = inferMaxPageFromHtml(firstHtml);
  const configuredMaxPagesRaw = Number(
    process.env.ALYSBEACH30A_MAX_SEARCH_PAGES ?? "",
  );
  const configuredMaxPages =
    Number.isFinite(configuredMaxPagesRaw) && configuredMaxPagesRaw > 0
      ? Math.floor(configuredMaxPagesRaw)
      : Math.max(120, Math.max(1, maxScrollSteps) * 20);
  const hardCeiling = Math.min(500, configuredMaxPages);
  const finalPage =
    inferredMaxPage > 1
      ? Math.min(Math.max(1, inferredMaxPage), hardCeiling)
      : hardCeiling;

  if (inferredMaxPage > 1) {
    reportProgress(`pagination detected; inferred pages=${inferredMaxPage}`);
  }
  if (finalPage === hardCeiling && inferredMaxPage > hardCeiling) {
    reportProgress(
      `pagination capped at ${hardCeiling}; set ALYSBEACH30A_MAX_SEARCH_PAGES to raise`,
    );
  }

  let stalePages = 0;

  for (let pageNumber = 2; pageNumber <= finalPage; pageNumber += 1) {
    const endpoint = toSearchAjaxUrl(sourceUrl, pageNumber);

    let html = "";
    try {
      const response = await fetch(endpoint, {
        method: "GET",
        headers: {
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          referer: sourceUrl,
        },
      });

      if (!response.ok) {
        break;
      }

      html = await response.text();
    } catch {
      break;
    }

    const beforeSize = discovered.size;
    const links = extractUnitLinksFromHtml(html);
    for (const link of links) {
      discovered.add(link);
      sourceByLink.set(link, endpoint);
    }

    if (links.length === 0 || discovered.size === beforeSize) {
      stalePages += 1;
    } else {
      stalePages = 0;
    }

    if (pageNumber % 5 === 0 || pageNumber === finalPage) {
      reportProgress(
        `search page ${pageNumber}/${finalPage}; links=${discovered.size}`,
      );
    }

    if (stalePages >= 2) {
      break;
    }
  }

  return Array.from(discovered)
    .sort((left, right) => left.localeCompare(right))
    .map((link) => ({
      link,
      source_url: sourceByLink.get(link) ?? sourceUrl,
      anchor_text: "view-unit",
    }));
}

async function fetchDetail(
  browser: Parameters<
    ScraperAdapter<OverseeDetailRecord>["fetchDetail"]
  >[0]["browser"],
  detailUrl: string,
  availabilityHorizonDays: number,
): Promise<OverseeDetailRecord | null> {
  const normalizedDetailUrl = normalizeDetailUrl(detailUrl);
  if (!normalizedDetailUrl) {
    return null;
  }

  try {
    const response = await fetch(normalizedDetailUrl, {
      method: "GET",
      redirect: "follow",
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        referer: DEFAULT_ANCHOR_URL,
      },
    });

    const contentType = (
      response.headers.get("content-type") ?? ""
    ).toLowerCase();
    if (response.status !== 200 || !contentType.includes("text/html")) {
      return null;
    }

    const html = await response.text();
    const unitData = extractUnitDataAttributes(html);

    const unitSlug =
      unitData["unit-slug"] || extractSlugFromDetailUrl(normalizedDetailUrl);
    const externalListingId =
      unitSlug ||
      unitData["unit-id"] ||
      unitData["unit-property-code"] ||
      normalizedDetailUrl;
    const quoteListingId =
      unitData["unit-id"] ||
      unitData["unit-property-code"] ||
      externalListingId;

    const title = extractFirst(/<title[^>]*>([\s\S]*?)<\/title>/i, html).slice(
      0,
      240,
    );
    const h1 = extractFirst(/<h1[^>]*>([\s\S]*?)<\/h1>/i, html).slice(0, 240);
    const canonicalUrl =
      extractFirst(
        /<link[^>]+rel=["']canonical["'][^>]+href=["']([\s\S]*?)["'][^>]*>/i,
        html,
      ) || normalizedDetailUrl;
    const metaDescription =
      extractFirst(
        /<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["'][^>]*>/i,
        html,
      ).slice(0, 2000) ||
      extractFirst(
        /<meta[^>]+content=["']([\s\S]*?)["'][^>]+name=["']description["'][^>]*>/i,
        html,
      ).slice(0, 2000);

    const descriptionSource =
      extractFirst(
        /<div[^>]+class=["'][^"']*second-part-desc[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
        html,
      ) || metaDescription;
    const descriptionExpanded = extractDescriptionExpanded(
      html,
      descriptionSource,
    );
    const amenities = extractAmenities(html);
    if (amenities.all.length === 0) {
      const amenityHints =
        extractAmenityHintsFromDescription(descriptionExpanded);
      if (amenityHints.length > 0) {
        amenities.categories = { General: amenityHints };
        amenities.all = amenityHints;
      }
    }
    const imageUrls = collectMediaUrls(html, normalizedDetailUrl);
    const mapsHrefCoordinates = extractGoogleMapsLlCoordinates(html);

    const addressParts = [
      unitData["unit-address1"],
      unitData["unit-address2"],
      unitData["unit-city"],
      unitData["unit-state"],
      unitData["unit-zip"],
    ]
      .map((part) => String(part ?? "").trim())
      .filter(Boolean);
    const fullAddress = addressParts.join(", ");
    const locationLabel = [unitData["unit-city"], unitData["unit-state"]]
      .map((part) => String(part ?? "").trim())
      .filter(Boolean)
      .join(", ");

    const detailFileBase =
      canonicalizeExternalListingId(externalListingId) || externalListingId;
    const htmlPath = resolve(OUTPUT_DETAILS_HTML_DIR, `${detailFileBase}.html`);
    await writeFile(htmlPath, `${html}\n`, "utf8");

    let bookedDates: string[] = [];
    let noCheckinDates: string[] = [];
    let minLOS: number | null = null;
    let minNightRules: ParsedMinNightRule[] = [];
    let bookingWindowByDate: Record<string, BookingWindowDay> = {};

    if (unitSlug) {
      const availabilityUrl = `https://vacation.alysbeach.com/?vrpjax=1&act=getUnitBookedDates&par=${encodeURIComponent(unitSlug)}`;
      try {
        const availabilityResponse = await fetch(availabilityUrl, {
          method: "GET",
          headers: {
            "user-agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
            accept: "application/json,text/plain,*/*",
            referer: normalizedDetailUrl,
          },
        });

        if (availabilityResponse.ok) {
          const availabilityJson =
            (await availabilityResponse.json()) as OverseeBookedDatesResponse;

          const rawBooked = Array.isArray(availabilityJson.bookedDates)
            ? availabilityJson.bookedDates
            : [];
          bookedDates = rawBooked
            .map((value) => String(value ?? "").trim())
            .filter(Boolean)
            .map((value) => parseMdyyyyToIso(value))
            .filter((value): value is string => Boolean(value));

          const rawNoCheckin = Array.isArray(availabilityJson.noCheckin)
            ? availabilityJson.noCheckin
            : [];
          noCheckinDates = rawNoCheckin
            .map((value) => String(value ?? "").trim())
            .filter(Boolean)
            .map((value) => parseMdyyyyToIso(value))
            .filter((value): value is string => Boolean(value));

          const los = Number(availabilityJson.minLOS ?? 0);
          if (Number.isFinite(los) && los > 0) {
            minLOS = Math.floor(los);
          }

          minNightRules = parseMinNightRules(availabilityJson.minNights);

          const rawWindow = availabilityJson.bookingWindow?.RR;
          if (rawWindow && typeof rawWindow === "object") {
            bookingWindowByDate = rawWindow;
          }
        }
      } catch {
        // Keep detail record with empty availability when endpoint parsing fails.
      }
    }

    const bookedSet = new Set(bookedDates);
    const noCheckinSet = new Set(noCheckinDates);

    const now = new Date();
    const startDate = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    startDate.setUTCDate(startDate.getUTCDate() + 1);

    const endDate = new Date(startDate);
    endDate.setUTCDate(
      endDate.getUTCDate() + Math.max(1, availabilityHorizonDays),
    );

    const normalizedDays: OverseeDetailRecord["normalized_availability"]["days"] =
      [];
    const cursor = new Date(startDate);
    while (cursor <= endDate) {
      const isoDate = formatIsoDate(cursor);
      const mdyyyy = formatMdyyyyFromIso(isoDate);
      const bookingWindowDay = bookingWindowByDate[mdyyyy] ?? null;

      const isBooked = bookedSet.has(isoDate);
      const allowArrival = bookingWindowDay?.allow?.arrival;
      const allowDeparture = bookingWindowDay?.allow?.departure;

      let statusCode: OverseeDayCode = "A";
      if (isBooked) {
        statusCode = "U";
      } else if (allowArrival === false && allowDeparture === false) {
        statusCode = "U";
      } else if (allowArrival === false && allowDeparture !== false) {
        statusCode = "I";
      } else if (allowArrival !== false && allowDeparture === false) {
        statusCode = "O";
      } else if (noCheckinSet.has(isoDate)) {
        statusCode = "I";
      }

      const minNightsRequired =
        resolveMinNightsForDate(isoDate, minNightRules, bookingWindowDay) ??
        minLOS;

      const dayRecord: OverseeDetailRecord["normalized_availability"]["days"][number] =
        {
          date: isoDate,
          day_code: statusCode === "A" || statusCode === "O" ? "Y" : "N",
          status_code: statusCode,
          changeover_code:
            statusCode === "I"
              ? "I"
              : statusCode === "O"
                ? "O"
                : statusCode === "A"
                  ? "C"
                  : "X",
          is_available: statusCode === "A",
          is_available_for_checkin: statusCode === "A" || statusCode === "O",
          is_available_for_checkout: statusCode === "A" || statusCode === "I",
          booking_day_state:
            statusCode === "A"
              ? "bookable"
              : statusCode === "U"
                ? "blocked"
                : "unknown",
          min_nights_required: minNightsRequired,
        };

      normalizedDays.push(dayRecord);

      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    // Fallback when upstream payload omits explicit turn-day markers.
    for (let i = 0; i < normalizedDays.length; i += 1) {
      const current = normalizedDays[i];
      if (!current || current.status_code !== "A") {
        continue;
      }

      const prev = i > 0 ? normalizedDays[i - 1] : null;
      const next = i + 1 < normalizedDays.length ? normalizedDays[i + 1] : null;
      const prevUnavailable = prev?.status_code === "U";
      const nextUnavailable = next?.status_code === "U";

      if (prevUnavailable && !nextUnavailable) {
        applyStatusCode(current, "I");
      } else if (!prevUnavailable && nextUnavailable) {
        applyStatusCode(current, "O");
      }
    }

    const counts = {
      available: normalizedDays.filter((day) => day.status_code === "A").length,
      unavailable: normalizedDays.filter((day) => day.status_code === "U")
        .length,
      checkin_only: normalizedDays.filter((day) => day.status_code === "I")
        .length,
      checkout_only: normalizedDays.filter((day) => day.status_code === "O")
        .length,
      other: normalizedDays.filter((day) => day.status_code === "X").length,
      booking_available: normalizedDays.filter(
        (day) => day.booking_day_state === "bookable",
      ).length,
      booking_unavailable: normalizedDays.filter(
        (day) => day.booking_day_state === "blocked",
      ).length,
      booking_unknown: normalizedDays.filter(
        (day) => day.booking_day_state === "unknown",
      ).length,
    };

    const name = stripHtml(unitData["unit-name"] || h1 || title).slice(0, 240);
    const description = stripHtml(
      descriptionExpanded || descriptionSource,
    ).slice(0, 20000);
    const descriptionNormalized = normalizeForMatch(description);
    const titleNormalized = normalizeForMatch(name);

    const unitLatitude = parseCoordinateLike(unitData["unit-latitude"], "lat");
    const unitLongitude = parseCoordinateLike(
      unitData["unit-longitude"],
      "lng",
    );
    const lazyLoadedCoordinates =
      unitLatitude === null || unitLongitude === null
        ? await extractLocationTabCoordinates(browser, normalizedDetailUrl)
        : null;

    return {
      external_listing_id: externalListingId,
      detail_url: normalizedDetailUrl,
      quote_context: {
        listing_id: quoteListingId,
        detail_url: normalizedDetailUrl,
        infants: 0,
        pets: 0,
      },
      fetched_at: new Date().toISOString(),
      html_path: htmlPath,
      title,
      h1,
      canonical_url: canonicalUrl,
      meta_description: metaDescription,
      description_expanded: descriptionExpanded,
      rooms_guidance: false,
      amenities,
      location: {
        address: fullAddress,
        location_label: locationLabel,
        directions_url: fullAddress
          ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(fullAddress)}`
          : "",
        directions_daddr: fullAddress,
        latitude:
          unitLatitude ??
          mapsHrefCoordinates?.latitude ??
          lazyLoadedCoordinates?.latitude ??
          null,
        longitude:
          unitLongitude ??
          mapsHrefCoordinates?.longitude ??
          lazyLoadedCoordinates?.longitude ??
          null,
      },
      media_gallery: {
        image_count: imageUrls.length,
        image_urls: imageUrls,
      },
      normalized_matching_profile: {
        source: "pm_alysbeach30a",
        external_listing_id: externalListingId,
        name,
        description,
        match_signals: {
          description_normalized: descriptionNormalized,
          description_sha256: hashSha256(descriptionNormalized),
          title_normalized: titleNormalized,
          title_sha256: hashSha256(titleNormalized),
          listing_composite_key: [
            "pm_alysbeach30a",
            externalListingId,
            hashSha256(descriptionNormalized),
            hashSha256(titleNormalized),
          ].join("::"),
        },
      },
      normalized_availability: {
        source: "pm_alysbeach30a",
        external_listing_id: externalListingId,
        captured_at: new Date().toISOString(),
        has_calendar_widget:
          html.includes("Add dates for Prices") ||
          html.includes("check-availability-arrival-date") ||
          Object.keys(bookingWindowByDate).length > 0,
        min_night_rules: minNightRules,
        window_start: normalizedDays[0]?.date ?? "",
        window_end: normalizedDays[normalizedDays.length - 1]?.date ?? "",
        code_legend: {
          A: "available",
          U: "unavailable",
          I: "checkout_only",
          O: "checkin_only",
          X: "other",
        },
        day_codes: normalizedDays.map((day) => day.status_code).join(""),
        days: normalizedDays,
        counts,
      },
      availability_raw: {
        booked_dates: bookedDates,
        no_checkin_dates: noCheckinDates,
        min_los: minLOS,
        min_night_rules: minNightRules,
        booking_window_days: Object.keys(bookingWindowByDate).length,
      },
      property_profile: {
        unit_id: unitData["unit-id"] || externalListingId,
        property_code: unitData["unit-property-code"] || "",
        unit_slug: unitSlug,
        unit_type: unitData["unit-type"] || "",
        city: unitData["unit-city"] || "",
        state: unitData["unit-state"] || "",
        zip: unitData["unit-zip"] || "",
        beds: Number.isFinite(Number(unitData["unit-beds"]))
          ? Number(unitData["unit-beds"])
          : null,
        baths: Number.isFinite(Number(unitData["unit-baths"]))
          ? Number(unitData["unit-baths"])
          : null,
        sleeps: Number.isFinite(Number(unitData["unit-sleeps"]))
          ? Number(unitData["unit-sleeps"])
          : null,
      },
    };
  } catch {
    return null;
  }
}

export function createAlysBeach30AAdapter(): ScraperAdapter<OverseeDetailRecord> {
  return {
    managerKey: "alysbeach30a",
    scriptLabel: "alysbeach30a",
    defaultAnchorUrl: DEFAULT_ANCHOR_URL,
    detailFetchDelayMs: Math.max(
      0,
      Number(process.env.ALYSBEACH30A_DETAIL_FETCH_DELAY_MS ?? "300") || 300,
    ),
    detailFetchConcurrency: Math.max(
      1,
      Number(process.env.ALYSBEACH30A_FETCH_CONCURRENCY ?? "5") || 5,
    ),
    availabilityHorizonDays: Math.max(
      1,
      Number(process.env.ALYSBEACH30A_AVAILABILITY_HORIZON_DAYS ?? "486") ||
        486,
    ),
    maxCalendarAdvanceMonths: 18,
    isValidDetailUrl(value: string): string | null {
      return normalizeDetailUrl(value);
    },
    async discoverListings(context) {
      return discoverListings(
        context.page,
        context.anchorUrl,
        context.maxScrollSteps,
        context.scrollPauseMs,
        context.reportProgress,
      );
    },
    async fetchDetail(context) {
      return fetchDetail(
        context.browser,
        context.detailUrl,
        context.availabilityHorizonDays,
      );
    },
    async runQuoteCapture(argv, progress) {
      const normalizedArgs = await normalizeAdapterQuoteScopeArgs(
        "alysbeach30a",
        argv,
      );
      await runRuntimeAdapterQuoteCli(
        {
          adapterKey: "alysbeach30a",
          executeSingleQuote: executeAlysBeach30ASingleQuote,
          defaultQuoteTimeoutMs: 20000,
          defaultQuoteMaxAttempts: 2,
          defaultEndpointPath: "/?vrpjax=1&act=checkavailability&par=1",
          defaultTaxPct: 0.12,
          defaultBaseNightly: 650,
        },
        normalizedArgs,
        progress,
      );
    },
    async runSingleQuoteObservation(input) {
      const result = await executeAlysBeach30ASingleQuote({
        listingId: input.listingId,
        checkInIso: input.checkInIso,
        checkOutIso: input.checkOutIso,
        adults: input.adults,
        children: input.children,
        quoteContext: input.quoteContext ?? null,
        options: {
          timeoutMs: Number(process.env.QUOTE_CAPTURE_TIMEOUT_MS ?? "20000"),
        },
      });

      if (result.success) {
        return {
          elapsedMs: result.elapsedMs,
          observation: {
            ...result.observation,
            reason: result.observation.quoteAvailable
              ? null
              : "quote_unavailable",
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
          reason: result.error?.message ?? "quote_failed",
        },
      };
    },
  };
}
