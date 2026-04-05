import { executeRoyaldestinationsSingleQuote } from "@/lib/pricing/quote-runtime/adapters/royaldestinations";
import { runRuntimeAdapterQuoteCli } from "@/lib/pricing/quotes/shared/runtime-adapter-quote-runner";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { normalizeAdapterQuoteScopeArgs } from "../quote-scope";
import type { DetailRecordBase, ScrapedLink, ScraperAdapter } from "../types";

type RoyalDestinationsDayCode = "A" | "U" | "I" | "O" | "X";

type BookingRange = {
  start: string;
  end: string;
};

type MinDayRule = {
  startDate: string;
  endDate: string;
  minimum: number;
};

type ParsedRule = {
  start_date: string;
  end_date: string;
  min_nights: number;
  raw_rule: string;
};

type AmenityGroups = Record<string, string[]>;

type RoyalDestinationsDetailRecord = DetailRecordBase & {
  title: string;
  h1: string;
  canonical_url: string;
  meta_description: string;
  description_expanded: string;
  amenities: {
    categories: AmenityGroups;
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
  quote_context: {
    source: "detail_html";
    entity_id: number | null;
    ids_tuple: string | null;
    detail_url: string;
  };
  normalized_matching_profile: {
    source: "pm_royaldestinations";
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
    source: "pm_royaldestinations";
    external_listing_id: string;
    captured_at: string;
    has_calendar_widget: boolean;
    booking_restrictions: string[];
    min_night_rules: ParsedRule[];
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
      status_code: RoyalDestinationsDayCode;
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
    booking_ranges: BookingRange[];
    min_day_rules: MinDayRule[];
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
};

const DEFAULT_ANCHOR_URL = "https://www.royaldestinations.com/vacation-rentals";
const EXPECTED_LISTING_COUNT = 143;
const NON_LISTING_SLUGS = new Set([
  "elevator",
  "event-friendly",
  "featured-properties",
  "flexible-length-stay",
  "golf-cart",
  "miramar-beach",
  "new-to-our-program",
  "pet-friendly",
  "private-pool",
  "south-30a",
]);
const OUTPUT_ROOT = resolve(
  process.cwd(),
  "src",
  "lib",
  "data",
  "external-sources",
  "royaldestinations",
);
const OUTPUT_DETAILS_HTML_DIR = resolve(OUTPUT_ROOT, "details", "html");
const ROYALDESTINATIONS_RCAPI_PATH = "/rcapi/item/avail/search";

function normalizeLink(url: string): string {
  return url.split("#")[0]?.replace(/\/$/, "") ?? url;
}

function stripHtml(value: string): string {
  return value
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

function extractFirst(regex: RegExp, value: string): string {
  const match = value.match(regex);
  if (!match?.[1]) {
    return "";
  }
  return stripHtml(match[1]);
}

function extractFirstNumber(regex: RegExp, value: string): number | null {
  const raw = extractFirst(regex, value);
  if (!raw.trim()) {
    return null;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeEmptyString(value: string): string {
  return value.trim();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#x2019;/gi, "'")
    .replace(/&#x2013;/gi, "-")
    .replace(/&#x2014;/gi, "-")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function extractSectionById(html: string, sectionId: string): string {
  const startToken = `<section id="${sectionId}"`;
  const start = html.indexOf(startToken);
  if (start < 0) {
    return "";
  }

  const end = html.indexOf("</section>", start);
  if (end < 0) {
    return html.slice(start);
  }

  return html.slice(start, end + "</section>".length);
}

function parseAmenitiesFromHtml(html: string): {
  categories: AmenityGroups;
  all: string[];
} {
  const section = extractSectionById(html, "amenities");
  if (!section) {
    return { categories: {}, all: [] };
  }

  const categoryRegex =
    /<div class="label-above">\s*([^:<]+):\s*&nbsp;\s*<\/div>\s*<ul>([\s\S]*?)<\/ul>/gi;
  const categories: AmenityGroups = {};

  let categoryMatch: RegExpExecArray | null;
  while ((categoryMatch = categoryRegex.exec(section)) !== null) {
    const categoryName = stripHtml(decodeHtmlEntities(categoryMatch[1] ?? ""));
    const listHtml = categoryMatch[2] ?? "";
    const items = Array.from(listHtml.matchAll(/<li>([\s\S]*?)<\/li>/gi))
      .map((item) => stripHtml(decodeHtmlEntities(item[1] ?? "")))
      .filter(Boolean);

    if (categoryName && items.length > 0) {
      categories[categoryName] = items;
    }
  }

  const all = Array.from(
    new Set(
      Object.values(categories)
        .flat()
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );

  return { categories, all };
}

function parseExpandedDescription(html: string): string {
  const bodyBlock = extractFirst(
    /<div class="field field-name-body">([\s\S]*?)<\/div>\s*<div id="node-vr-listing-full-group-tabs-wrapper"/i,
    html,
  );

  return stripHtml(decodeHtmlEntities(bodyBlock)).slice(0, 40000);
}

function monthNameToNumber(label: string): number | null {
  const monthMap: Record<string, number> = {
    january: 1,
    february: 2,
    march: 3,
    april: 4,
    may: 5,
    june: 6,
    july: 7,
    august: 8,
    september: 9,
    october: 10,
    november: 11,
    december: 12,
  };

  return monthMap[label.toLowerCase()] ?? null;
}

function mapCalendarClassToCode(classValue: string): RoyalDestinationsDayCode {
  if (classValue.includes("av-O") && classValue.includes("av-IN")) {
    return "I";
  }
  if (classValue.includes("av-X") && classValue.includes("av-OUT")) {
    return "O";
  }
  if (/\bav-O\b/.test(classValue)) {
    return "A";
  }
  if (/\bav-X\b/.test(classValue)) {
    return "U";
  }
  return "X";
}

function parseAvailabilityDaysFromHtml(html: string): Array<{
  date: string;
  status_code: RoyalDestinationsDayCode;
}> {
  const section = extractSectionById(html, "availability");
  if (!section) {
    return [];
  }

  const days = new Map<string, RoyalDestinationsDayCode>();
  const monthBlocks = Array.from(
    section.matchAll(
      /<div class="[^"]*\brc-calendar\b[^"]*\brcav-month\b[^"]*">([\s\S]*?)<\/div>/gi,
    ),
  );

  for (const monthBlock of monthBlocks) {
    const block = monthBlock[1] ?? "";
    const captionRaw = extractFirst(
      /rcjs-page-caption">([^<]+)<\/caption>/i,
      block,
    );
    const caption = stripHtml(decodeHtmlEntities(captionRaw));
    const captionMatch = caption.match(/^([A-Za-z]+)\s+(\d{4})$/);
    if (!captionMatch?.[1] || !captionMatch[2]) {
      continue;
    }

    const month = monthNameToNumber(captionMatch[1]);
    const year = Number(captionMatch[2]);
    if (!month || !Number.isFinite(year)) {
      continue;
    }

    const dayCells = Array.from(
      block.matchAll(
        /<td class="day\s+([^"]+)">\s*<span class="mday">(\d+)<\/span>/gi,
      ),
    );

    for (const dayCell of dayCells) {
      const classValue = dayCell[1] ?? "";
      const day = Number(dayCell[2]);
      if (!Number.isInteger(day) || day < 1 || day > 31) {
        continue;
      }

      const date = new Date(Date.UTC(year, month - 1, day));
      if (
        Number.isNaN(date.getTime()) ||
        date.getUTCFullYear() !== year ||
        date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day
      ) {
        continue;
      }

      days.set(formatIsoDate(date), mapCalendarClassToCode(classValue));
    }
  }

  return Array.from(days.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, status_code]) => ({ date, status_code }));
}

function parseLocationMetadataFromHtml(html: string): {
  address: string;
  location_label: string;
  directions_url: string;
  directions_daddr: string;
  latitude: number | null;
  longitude: number | null;
} {
  const section = extractSectionById(html, "location");
  const directionsUrlRaw =
    extractFirst(/href="([^"]+)"[^>]*vrweb-driving-directions/i, section) ||
    extractFirst(/vrweb-driving-directions"[^>]*href="([^"]+)"/i, section);
  const directionsUrl = decodeHtmlEntities(directionsUrlRaw);

  const daddrRaw = directionsUrl
    ? extractFirst(/[?&]daddr=([^&]+)/i, directionsUrl)
    : "";
  const directionsDaddr = decodeHtmlEntities(daddrRaw)
    .replace(/\+/g, " ")
    .replace(/%2C/gi, ",")
    .replace(/%20/gi, " ")
    .trim();

  const latLngPatterns = [
    /(?:lat|latitude)\s*[:=]\s*(-?\d+\.\d+)\s*[,;\s]+(?:lng|lon|longitude)\s*[:=]\s*(-?\d+\.\d+)/gi,
    /@(-?\d+\.\d+),\s*(-?\d+\.\d+)/gi,
  ];

  let latitude: number | null = null;
  let longitude: number | null = null;

  const locationSource = section || html;
  for (const pattern of latLngPatterns) {
    const match = pattern.exec(locationSource);
    if (!match?.[1] || !match[2]) {
      continue;
    }

    const lat = Number(match[1]);
    const lng = Number(match[2]);
    if (
      Number.isFinite(lat) &&
      Number.isFinite(lng) &&
      Math.abs(lat) <= 90 &&
      Math.abs(lng) <= 180
    ) {
      latitude = lat;
      longitude = lng;
      break;
    }
  }

  return {
    address: directionsDaddr,
    location_label: "",
    directions_url: directionsUrl,
    directions_daddr: directionsDaddr,
    latitude,
    longitude,
  };
}

function parseGalleryImageUrlsFromHtml(html: string): string[] {
  const candidates = new Set<string>();

  const addCandidate = (rawValue: string): void => {
    if (!rawValue) {
      return;
    }

    const decoded = decodeHtmlEntities(rawValue).trim();
    if (!decoded) {
      return;
    }

    const normalized = decoded.replace(/\s+/g, "");
    if (!/^https?:\/\//i.test(normalized)) {
      return;
    }

    try {
      const parsed = new URL(normalized);
      // Collapse width variants so one asset counts once.
      parsed.searchParams.delete("width");
      candidates.add(parsed.toString());
    } catch {
      candidates.add(normalized);
    }
  };

  for (const match of html.matchAll(/data-rsbigimg="([^"]+)"/gi)) {
    addCandidate(match[1] ?? "");
  }

  for (const match of html.matchAll(
    /<a[^>]+class="[^"]*\brsImg\b[^"]*"[^>]+href="([^"]+)"/gi,
  )) {
    addCandidate(match[1] ?? "");
  }

  return Array.from(candidates).sort((a, b) => a.localeCompare(b));
}

function parseCityStateFromDirections(html: string): {
  city: string;
  state: string;
} {
  const locationMetadata = parseLocationMetadataFromHtml(html);
  const fallbackSource = locationMetadata.directions_daddr;

  if (!fallbackSource) {
    return { city: "", state: "" };
  }

  const decoded = fallbackSource
    .replace(/\+/g, " ")
    .replace(/%2C/gi, ",")
    .replace(/%20/gi, " ")
    .replace(/&amp;/gi, " ")
    .trim();

  const stateMatch = decoded.match(/\b([A-Z]{2})\b\s*$/);
  const state = stateMatch?.[1] ?? "";

  const cityMatch = decoded.match(
    /\b([A-Za-z][A-Za-z\s.'-]+)\s+[A-Z]{2}\b\s*$/,
  );
  const city = cityMatch?.[1]?.trim() ?? "";

  return { city, state };
}

function parseSlashDate(value: string): Date | null {
  const match = value.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
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

function formatIsoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function parsePageNumber(raw: string): number | null {
  const numberValue = Number(raw);
  if (!Number.isInteger(numberValue) || numberValue < 1) {
    return null;
  }
  return numberValue;
}

function normalizeDetailUrl(value: string): string | null {
  try {
    const parsed = new URL(value.trim());
    if (!parsed.hostname.endsWith("royaldestinations.com")) {
      return null;
    }

    const path = parsed.pathname.replace(/\/+$/, "");
    const parts = path.split("/").filter(Boolean);
    if (parts.length < 2 || parts[0] !== "30a-vacation-rentals" || !parts[1]) {
      return null;
    }

    const slug = parts[1].toLowerCase();
    if (NON_LISTING_SLUGS.has(slug)) {
      return null;
    }

    const normalized = new URL(
      `${parsed.origin}/30a-vacation-rentals/${parts[1]}`,
    );

    // Preserve booking context params that often unlock embedded availability data.
    const allowedParams = [
      "rcav[begin]",
      "rcav[end]",
      "rcav[adult]",
      "rcav[child]",
      "rcav[eid]",
      "rcav[IDs][8][0]",
      "eid",
    ];

    for (const key of allowedParams) {
      const valueForKey = parsed.searchParams.get(key);
      if (valueForKey) {
        normalized.searchParams.set(key, valueForKey);
      }
    }

    return normalizeLink(normalized.toString());
  } catch {
    return null;
  }
}

function canonicalDetailKey(value: string): string | null {
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

function scoreDetailUrl(value: string): number {
  try {
    const parsed = new URL(value);
    let score = 0;
    if (parsed.searchParams.get("rcav[IDs][8][0]")) {
      score += 4;
    }
    if (
      parsed.searchParams.get("rcav[eid]") ||
      parsed.searchParams.get("eid")
    ) {
      score += 2;
    }
    if (
      parsed.searchParams.get("rcav[begin]") &&
      parsed.searchParams.get("rcav[end]")
    ) {
      score += 1;
    }
    return score;
  } catch {
    return 0;
  }
}

function extractExternalListingId(detailUrl: string): string {
  try {
    const parsed = new URL(detailUrl);
    const parts = parsed.pathname
      .replace(/\/+$/, "")
      .split("/")
      .filter(Boolean);
    return parts[parts.length - 1] || detailUrl;
  } catch {
    return detailUrl;
  }
}

function parseEntityIdFromHtml(html: string): number | null {
  const patterns = [
    /rcItemAvailForm[\s\S]*?"eid":"(\d+)"/i,
    /rc-eid-(\d+)/i,
    /"eid":"(\d+)"/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (!match?.[1]) {
      continue;
    }

    const parsed = Number(match[1]);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return null;
}

function parseIdsTuple(detailUrl: string, html: string): string | null {
  try {
    const parsed = new URL(detailUrl);
    const tuple =
      parsed.searchParams.get("rcav[IDs][8][0]") ??
      parsed.searchParams.get("rcav%5BIDs%5D%5B8%5D%5B0%5D");
    if (tuple && tuple.trim()) {
      return tuple.trim();
    }
  } catch {
    // Ignore parse failures and fall back to html extraction.
  }

  const htmlMatch = html.match(/"id":"(\d+-\d+)"/i);
  return htmlMatch?.[1]?.trim() ?? null;
}

function readJsonObjectAfterKey<T extends object>(
  html: string,
  key: string,
): T | null {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const keyMatch = new RegExp(`${escapedKey}\\s*:\\s*\\{`, "m").exec(html);
  if (!keyMatch?.index && keyMatch?.index !== 0) {
    return null;
  }

  const start = (keyMatch.index ?? 0) + keyMatch[0].lastIndexOf("{");
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < html.length; i += 1) {
    const ch = html[i] as string;

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (ch === "{") {
      depth += 1;
      continue;
    }

    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const raw = html.slice(start, i + 1);
        try {
          return JSON.parse(raw) as T;
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

function readJsonArrayAfterKey<T>(html: string, key: string): T[] {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const keyMatch = new RegExp(`${escapedKey}\\s*:\\s*\\[`, "m").exec(html);
  if (!keyMatch?.index && keyMatch?.index !== 0) {
    return [];
  }

  const start = (keyMatch.index ?? 0) + keyMatch[0].lastIndexOf("[");
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < html.length; i += 1) {
    const ch = html[i] as string;

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (ch === "[") {
      depth += 1;
      continue;
    }

    if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        const raw = html.slice(start, i + 1);
        try {
          const parsed = JSON.parse(raw) as unknown;
          return Array.isArray(parsed) ? (parsed as T[]) : [];
        } catch {
          return [];
        }
      }
    }
  }

  return [];
}

function resolveMinNightsForDate(
  date: string,
  rules: ParsedRule[],
): number | null {
  let result: number | null = null;
  for (const rule of rules) {
    if (date < rule.start_date || date > rule.end_date) {
      continue;
    }

    result =
      result === null ? rule.min_nights : Math.max(result, rule.min_nights);
  }

  return result;
}

function toParsedRules(rules: MinDayRule[]): ParsedRule[] {
  const parsed: ParsedRule[] = [];

  for (const rule of rules) {
    const start = parseSlashDate(rule.startDate);
    const end = parseSlashDate(rule.endDate);
    if (!start || !end || !Number.isFinite(rule.minimum) || rule.minimum <= 0) {
      continue;
    }

    parsed.push({
      start_date: formatIsoDate(start),
      end_date: formatIsoDate(end),
      min_nights: Math.floor(rule.minimum),
      raw_rule: `${rule.startDate}..${rule.endDate}:${rule.minimum}`,
    });
  }

  return parsed.sort((left, right) =>
    left.start_date.localeCompare(right.start_date),
  );
}

async function collectLinksOnCurrentPage(
  page: Parameters<
    ScraperAdapter<RoyalDestinationsDetailRecord>["discoverListings"]
  >[0]["page"],
): Promise<{
  detailLinks: string[];
  pageNumbers: number[];
  resultsCount: number | null;
}> {
  return page.evaluate(() => {
    const detailLinks = new Set<string>();
    const pageNumbers = new Set<number>();

    const bodyText = document.body.textContent || "";
    const countMatch = bodyText.match(/(\d+)\s+Results/i);
    const resultsCount = countMatch?.[1] ? Number(countMatch[1]) : null;

    const resultRoots = Array.from(
      document.querySelectorAll("riot-solr-result-list, .result-list"),
    );

    const resultAnchors =
      resultRoots.length > 0
        ? resultRoots.flatMap((root) =>
            Array.from(root.querySelectorAll("a[href]")),
          )
        : Array.from(document.querySelectorAll("a[href]"));

    for (const anchor of resultAnchors) {
      if ((anchor as HTMLElement).offsetParent === null) {
        continue;
      }

      const href = anchor.getAttribute("href") || "";
      if (!href.trim()) {
        continue;
      }

      try {
        const url = new URL(href, window.location.origin);
        const path = url.pathname.replace(/\/$/, "");
        const parts = path.split("/").filter(Boolean);

        if (
          url.hostname.endsWith("royaldestinations.com") &&
          parts[0] === "30a-vacation-rentals" &&
          parts[1]
        ) {
          detailLinks.add(url.toString());
        }
      } catch {
        // Ignore malformed URLs.
      }
    }

    const anchors = Array.from(document.querySelectorAll("a[href]"));
    for (const anchor of anchors) {
      const href = anchor.getAttribute("href") || "";
      if (!href.trim()) {
        continue;
      }

      try {
        const url = new URL(href, window.location.origin);
        const pageParam = url.searchParams.get("page");
        if (pageParam) {
          const pageNumber = Number(pageParam);
          if (Number.isInteger(pageNumber) && pageNumber > 0) {
            pageNumbers.add(pageNumber);
          }
        }
      } catch {
        // Ignore malformed URLs.
      }

      const dataPage = anchor.getAttribute("data-page") || "";
      const dataPageNumber = Number(dataPage);
      if (Number.isInteger(dataPageNumber) && dataPageNumber > 0) {
        pageNumbers.add(dataPageNumber);
      }
    }

    return {
      detailLinks: Array.from(detailLinks),
      pageNumbers: Array.from(pageNumbers),
      resultsCount: Number.isInteger(resultsCount) ? resultsCount : null,
    };
  });
}

function toSourceUrls(anchorUrl: string): string[] {
  const source = new URL(anchorUrl);
  const showAll = new URL(anchorUrl);
  showAll.searchParams.set("show", "all");

  return Array.from(new Set([source.toString(), showAll.toString()]));
}

async function gatherPageLinksWithScroll(
  page: Parameters<
    ScraperAdapter<RoyalDestinationsDetailRecord>["discoverListings"]
  >[0]["page"],
  maxScrollSteps: number,
  scrollPauseMs: number,
): Promise<{
  detailLinks: string[];
  pageNumbers: number[];
  resultsCount: number | null;
}> {
  const links = new Set<string>();
  const pageNumbers = new Set<number>();
  let resultsCount: number | null = null;
  let staleRounds = 0;

  const steps = Math.max(1, maxScrollSteps);
  for (let step = 0; step < steps; step += 1) {
    const snapshot = await collectLinksOnCurrentPage(page);
    const beforeSize = links.size;

    for (const link of snapshot.detailLinks) {
      links.add(link);
    }
    for (const pageNumber of snapshot.pageNumbers) {
      pageNumbers.add(pageNumber);
    }
    if (resultsCount === null && snapshot.resultsCount !== null) {
      resultsCount = snapshot.resultsCount;
    }

    if (links.size === beforeSize) {
      staleRounds += 1;
    } else {
      staleRounds = 0;
    }

    if (staleRounds >= 3) {
      break;
    }

    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });
    await page.waitForTimeout(Math.max(650, scrollPauseMs));
  }

  return {
    detailLinks: Array.from(links),
    pageNumbers: Array.from(pageNumbers),
    resultsCount,
  };
}

async function discoverListings(
  page: Parameters<
    ScraperAdapter<RoyalDestinationsDetailRecord>["discoverListings"]
  >[0]["page"],
  anchorUrl: string,
  maxScrollSteps: number,
  scrollPauseMs: number,
  reportProgress: (message: string) => void,
): Promise<ScrapedLink[]> {
  const discoveredByCanonical = new Map<string, string>();
  const sourceByCanonical = new Map<string, string>();

  const addCandidate = (candidate: string, sourceUrl: string): void => {
    const normalized = normalizeDetailUrl(candidate);
    if (!normalized) {
      return;
    }

    const canonical = canonicalDetailKey(normalized);
    if (!canonical) {
      return;
    }

    const existing = discoveredByCanonical.get(canonical);
    if (!existing) {
      discoveredByCanonical.set(canonical, normalized);
      sourceByCanonical.set(canonical, sourceUrl);
      return;
    }

    if (scoreDetailUrl(normalized) > scoreDetailUrl(existing)) {
      discoveredByCanonical.set(canonical, normalized);
      sourceByCanonical.set(canonical, sourceUrl);
    }
  };

  const sourceUrls = toSourceUrls(anchorUrl);
  let expectedResultsCount: number | null = null;
  for (const sourceUrl of sourceUrls) {
    await page.goto(sourceUrl, {
      waitUntil: "domcontentloaded",
      timeout: 120000,
    });

    await page.waitForTimeout(Math.max(900, scrollPauseMs));

    const firstPass = await gatherPageLinksWithScroll(
      page,
      maxScrollSteps,
      scrollPauseMs,
    );
    for (const link of firstPass.detailLinks) {
      addCandidate(link, sourceUrl);
    }

    if (firstPass.resultsCount !== null) {
      if (expectedResultsCount === null) {
        expectedResultsCount = firstPass.resultsCount;
      }
      reportProgress(
        `source ${sourceUrl} reports ${firstPass.resultsCount} results; discovered canonical links=${discoveredByCanonical.size}`,
      );
    }

    let maxPage = 1;
    for (const rawPageNumber of firstPass.pageNumbers) {
      const pageNumber = parsePageNumber(String(rawPageNumber));
      if (pageNumber && pageNumber > maxPage) {
        maxPage = pageNumber;
      }
    }

    if (
      maxPage === 1 &&
      firstPass.resultsCount &&
      firstPass.detailLinks.length > 0
    ) {
      const inferredPages = Math.ceil(
        firstPass.resultsCount / Math.max(1, firstPass.detailLinks.length),
      );
      if (inferredPages > maxPage) {
        maxPage = inferredPages;
      }
    }

    const pageTraversalLimit = Math.max(1, Math.min(maxPage, maxScrollSteps));
    if (pageTraversalLimit > 1) {
      reportProgress(
        `source ${sourceUrl} pagination; traversing ${pageTraversalLimit} pages`,
      );
    }

    let stalePages = 0;
    for (
      let pageNumber = 2;
      pageNumber <= pageTraversalLimit;
      pageNumber += 1
    ) {
      const beforeSize = discoveredByCanonical.size;
      const pageUrl = new URL(sourceUrl);
      pageUrl.searchParams.set("page", String(pageNumber));

      await page.goto(pageUrl.toString(), {
        waitUntil: "domcontentloaded",
        timeout: 120000,
      });
      await page.waitForTimeout(Math.max(700, scrollPauseMs));

      const pass = await gatherPageLinksWithScroll(
        page,
        maxScrollSteps,
        scrollPauseMs,
      );
      for (const link of pass.detailLinks) {
        addCandidate(link, pageUrl.toString());
      }

      if (discoveredByCanonical.size === beforeSize) {
        stalePages += 1;
      } else {
        stalePages = 0;
      }

      if (pageNumber % 2 === 0 || pageNumber === pageTraversalLimit) {
        reportProgress(
          `source page ${pageNumber}/${pageTraversalLimit}; canonical links=${discoveredByCanonical.size}`,
        );
      }

      if (stalePages >= 2) {
        break;
      }
    }
  }

  const discoveredCount = discoveredByCanonical.size;
  if (
    expectedResultsCount !== null &&
    discoveredCount !== expectedResultsCount
  ) {
    reportProgress(
      `canonical links discovered=${discoveredCount} vs on-page results=${expectedResultsCount}`,
    );
  } else if (discoveredCount < EXPECTED_LISTING_COUNT) {
    reportProgress(
      `discovered ${discoveredCount} links vs expected ${EXPECTED_LISTING_COUNT}; consider tuning max scroll/pagination`,
    );
  }

  return Array.from(discoveredByCanonical.values())
    .sort((a, b) => a.localeCompare(b))
    .map((link) => ({
      link,
      source_url:
        sourceByCanonical.get(canonicalDetailKey(link) ?? "") ?? anchorUrl,
      anchor_text: "view-rental",
    }));
}

async function fetchDetail(
  detailUrl: string,
  availabilityHorizonDays: number,
): Promise<RoyalDestinationsDetailRecord | null> {
  const normalizedDetailUrl = normalizeDetailUrl(detailUrl);
  if (!normalizedDetailUrl) {
    return null;
  }

  const headers = {
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    referer: DEFAULT_ANCHOR_URL,
  };

  try {
    const response = await fetch(normalizedDetailUrl, {
      method: "GET",
      redirect: "follow",
      headers,
    });

    const contentType = (
      response.headers.get("content-type") || ""
    ).toLowerCase();
    if (response.status !== 200 || !contentType.includes("text/html")) {
      return null;
    }

    const html = await response.text();
    const externalListingId = extractExternalListingId(normalizedDetailUrl);

    const title = extractFirst(/<title[^>]*>([\s\S]*?)<\/title>/i, html).slice(
      0,
      240,
    );
    const listingH1 = extractFirst(
      /field-name-title[^>]*>\s*<h1[^>]*>([\s\S]*?)<\/h1>/i,
      html,
    ).slice(0, 240);
    const genericH1 = extractFirst(/<h1[^>]*>([\s\S]*?)<\/h1>/i, html).slice(
      0,
      240,
    );
    const h1 = listingH1 || genericH1;
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

    const htmlPath = resolve(
      OUTPUT_DETAILS_HTML_DIR,
      `${externalListingId}.html`,
    );
    await writeFile(htmlPath, `${html}\n`, "utf8");

    const propDetails =
      readJsonObjectAfterKey<Record<string, unknown>>(html, "propDetails") ??
      {};
    const expandedDescription = parseExpandedDescription(html);
    const amenities = parseAmenitiesFromHtml(html);
    const locationMetadata = parseLocationMetadataFromHtml(html);
    const galleryImageUrls = parseGalleryImageUrlsFromHtml(html);
    const parsedCalendarDays = parseAvailabilityDaysFromHtml(html);
    const quoteEntityId = parseEntityIdFromHtml(html);
    const quoteIdsTuple = parseIdsTuple(normalizedDetailUrl, html);

    const bedsFromHtml = extractFirstNumber(
      /rc-lodging-beds[^>]*>\s*(\d+)\s*Bedrooms/i,
      html,
    );
    const bathsFromHtml = extractFirstNumber(
      /rc-lodging-baths[^>]*>\s*(\d+(?:\.\d+)?)\s*Baths?/i,
      html,
    );
    const bathsFromBody = extractFirstNumber(
      /(\d+(?:\.\d+)?)\s+Full\s+Baths?/i,
      html,
    );
    const sleepsFromHtml = extractFirstNumber(
      /rc-lodging-occ[^>]*>\s*Sleeps\s*(\d+)/i,
      html,
    );
    const areaFromHtml = extractFirst(
      /field-name-rc-core-term-view[^>]*>\s*(?:<div[^>]*>[\s\S]*?<\/div>)?\s*([^<]+)/i,
      html,
    );
    const locationFromHtml = extractFirst(
      /field-name-rc-core-term-beach-community[^>]*>\s*(?:<div[^>]*>[\s\S]*?<\/div>)?\s*([^<]+)/i,
      html,
    );
    const { city: cityFromDirections, state: stateFromDirections } =
      parseCityStateFromDirections(html);
    const locationLabel = [cityFromDirections, stateFromDirections]
      .filter(Boolean)
      .join(", ");
    const bookings = readJsonArrayAfterKey<BookingRange>(
      html,
      "bookings",
    ).filter(
      (row) => typeof row?.start === "string" && typeof row?.end === "string",
    );
    const minDayRules = readJsonArrayAfterKey<MinDayRule>(
      html,
      "minDays",
    ).filter(
      (row) =>
        typeof row?.startDate === "string" &&
        typeof row?.endDate === "string" &&
        typeof row?.minimum === "number",
    );

    const parsedRules = toParsedRules(minDayRules);

    const now = new Date();
    const startDate = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    startDate.setUTCDate(startDate.getUTCDate() + 1);
    const startDateIso = formatIsoDate(startDate);

    const twoYearHorizonDate = new Date(startDate);
    twoYearHorizonDate.setUTCDate(twoYearHorizonDate.getUTCDate() + 730);
    const twoYearHorizonIso = formatIsoDate(twoYearHorizonDate);

    const requestedHorizonDate = new Date(startDate);
    requestedHorizonDate.setUTCDate(
      requestedHorizonDate.getUTCDate() + Math.max(1, availabilityHorizonDays),
    );
    const bookingStart = new Set<string>();
    const bookingEnd = new Set<string>();
    const bookedOnly = new Set<string>();

    for (const booking of bookings) {
      const start = parseSlashDate(booking.start);
      const end = parseSlashDate(booking.end);
      if (!start || !end || end < start) {
        continue;
      }

      const startIso = formatIsoDate(start);
      const endIso = formatIsoDate(end);
      bookingStart.add(startIso);
      bookingEnd.add(endIso);

      const cursor = new Date(start);
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      while (cursor < end) {
        bookedOnly.add(formatIsoDate(cursor));
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
    }

    const normalizedDays: RoyalDestinationsDetailRecord["normalized_availability"]["days"] =
      [];
    const calendarDays = parsedCalendarDays
      .filter(
        (day) => day.date >= startDateIso && day.date <= twoYearHorizonIso,
      )
      .sort((a, b) => a.date.localeCompare(b.date));

    if (calendarDays.length > 0) {
      for (const calendarDay of calendarDays) {
        const statusCode = calendarDay.status_code;
        const minNights = resolveMinNightsForDate(
          calendarDay.date,
          parsedRules,
        );
        const bookingDayState: "bookable" | "blocked" | "unknown" =
          statusCode === "A"
            ? "bookable"
            : statusCode === "U"
              ? "blocked"
              : "unknown";

        normalizedDays.push({
          date: calendarDay.date,
          status_code: statusCode,
          is_available: statusCode === "A",
          is_available_for_checkin: statusCode === "A" || statusCode === "I",
          is_available_for_checkout: statusCode === "A" || statusCode === "O",
          booking_day_state: bookingDayState,
          min_nights_required: minNights,
        });
      }
    } else {
      const cursor = new Date(startDate);
      while (cursor <= requestedHorizonDate) {
        const isoDate = formatIsoDate(cursor);
        const isStart = bookingStart.has(isoDate);
        const isEnd = bookingEnd.has(isoDate);
        const isBooked = bookedOnly.has(isoDate);

        let statusCode: RoyalDestinationsDayCode = "A";
        if (isBooked) {
          statusCode = "U";
        } else if (isStart) {
          statusCode = "I";
        } else if (isEnd) {
          statusCode = "O";
        }

        const minNights = resolveMinNightsForDate(isoDate, parsedRules);
        const bookingDayState: "bookable" | "blocked" | "unknown" =
          statusCode === "A"
            ? "bookable"
            : statusCode === "U"
              ? "blocked"
              : "unknown";

        normalizedDays.push({
          date: isoDate,
          status_code: statusCode,
          is_available: statusCode === "A",
          is_available_for_checkin: statusCode === "A" || statusCode === "I",
          is_available_for_checkout: statusCode === "A" || statusCode === "O",
          booking_day_state: bookingDayState,
          min_nights_required: minNights,
        });

        cursor.setUTCDate(cursor.getUTCDate() + 1);
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

    const description = stripHtml(
      String(
        expandedDescription || propDetails.description || metaDescription || "",
      ),
    ).slice(0, 40000);
    const name = stripHtml(
      String(propDetails.prop_name ?? listingH1 ?? h1 ?? title ?? ""),
    ).slice(0, 240);
    const descriptionNormalized = normalizeForMatch(description);
    const titleNormalized = normalizeForMatch(name);

    return {
      external_listing_id: externalListingId,
      detail_url: normalizedDetailUrl,
      fetched_at: new Date().toISOString(),
      html_path: htmlPath,
      title,
      h1,
      canonical_url: canonicalUrl,
      meta_description: metaDescription,
      description_expanded: expandedDescription,
      amenities,
      location: {
        address: locationMetadata.address,
        location_label: locationLabel,
        directions_url: locationMetadata.directions_url,
        directions_daddr: locationMetadata.directions_daddr,
        latitude: locationMetadata.latitude,
        longitude: locationMetadata.longitude,
      },
      media_gallery: {
        image_count: galleryImageUrls.length,
        image_urls: galleryImageUrls,
      },
      quote_context: {
        source: "detail_html",
        entity_id: quoteEntityId,
        ids_tuple: quoteIdsTuple,
        detail_url: normalizedDetailUrl,
      },
      normalized_matching_profile: {
        source: "pm_royaldestinations",
        external_listing_id: externalListingId,
        name,
        description,
        match_signals: {
          description_normalized: descriptionNormalized,
          description_sha256: hashSha256(descriptionNormalized),
          title_normalized: titleNormalized,
          title_sha256: hashSha256(titleNormalized),
          listing_composite_key: [
            "pm_royaldestinations",
            externalListingId,
            hashSha256(descriptionNormalized),
            hashSha256(titleNormalized),
          ].join("::"),
        },
      },
      normalized_availability: {
        source: "pm_royaldestinations",
        external_listing_id: externalListingId,
        captured_at: new Date().toISOString(),
        has_calendar_widget:
          html.includes("Night Available") ||
          html.includes("calendar-wrap") ||
          html.includes("AVAILABILITY") ||
          parsedCalendarDays.length > 0 ||
          bookings.length > 0,
        booking_restrictions: parsedRules
          .filter((rule) => rule.min_nights >= 999)
          .map((rule) => `${rule.start_date}..${rule.end_date}: closed`),
        min_night_rules: parsedRules,
        window_start: normalizedDays[0]?.date ?? "",
        window_end: normalizedDays[normalizedDays.length - 1]?.date ?? "",
        code_legend: {
          A: "available",
          U: "unavailable",
          I: "checkin_only",
          O: "checkout_only",
          X: "other",
        },
        day_codes: normalizedDays.map((day) => day.status_code).join(""),
        days: normalizedDays,
        counts,
      },
      availability_raw: {
        booking_ranges: bookings,
        min_day_rules: minDayRules,
      },
      property_profile: {
        unit_id: String(propDetails.unit_id ?? externalListingId),
        area: normalizeEmptyString(
          String(propDetails.area ?? areaFromHtml ?? ""),
        ),
        location: normalizeEmptyString(
          String(propDetails.location ?? locationFromHtml ?? ""),
        ),
        beds:
          Number.isFinite(Number(propDetails.bed)) &&
          Number(propDetails.bed) > 0
            ? Number(propDetails.bed)
            : bedsFromHtml,
        baths:
          Number.isFinite(Number(propDetails.bath)) &&
          Number(propDetails.bath) > 0
            ? Number(propDetails.bath)
            : (bathsFromHtml ?? bathsFromBody),
        sleeps:
          Number.isFinite(Number(propDetails.sleeps)) &&
          Number(propDetails.sleeps) > 0
            ? Number(propDetails.sleeps)
            : sleepsFromHtml,
        city: normalizeEmptyString(
          String(propDetails.city ?? cityFromDirections ?? ""),
        ),
        state: normalizeEmptyString(
          String(propDetails.state ?? stateFromDirections ?? ""),
        ),
      },
    };
  } catch {
    return null;
  }
}

export function createRoyalDestinationsAdapter(): ScraperAdapter<RoyalDestinationsDetailRecord> {
  return {
    managerKey: "royaldestinations",
    scriptLabel: "royaldestinations",
    defaultAnchorUrl: DEFAULT_ANCHOR_URL,
    detailFetchDelayMs: Math.max(
      0,
      Number(process.env.ROYALDESTINATIONS_DETAIL_FETCH_DELAY_MS ?? "250") ||
        250,
    ),
    detailFetchConcurrency: Math.max(
      1,
      Number(process.env.ROYALDESTINATIONS_FETCH_CONCURRENCY ?? "6") || 6,
    ),
    availabilityHorizonDays: Math.max(
      1,
      Number(
        process.env.ROYALDESTINATIONS_AVAILABILITY_HORIZON_DAYS ?? "486",
      ) || 486,
    ),
    maxCalendarAdvanceMonths: Math.max(
      1,
      Number(process.env.ROYALDESTINATIONS_CALENDAR_MAX_MONTHS ?? "18") || 18,
    ),
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
      return fetchDetail(context.detailUrl, context.availabilityHorizonDays);
    },
    async runQuoteCapture(argv, progress) {
      const normalizedArgs = await normalizeAdapterQuoteScopeArgs(
        "royaldestinations",
        argv,
      );
      await runRuntimeAdapterQuoteCli(
        {
          adapterKey: "royaldestinations",
          executeSingleQuote: executeRoyaldestinationsSingleQuote,
          defaultQuoteTimeoutMs: 20000,
          defaultQuoteMaxAttempts: 2,
          defaultEndpointPath: ROYALDESTINATIONS_RCAPI_PATH,
          defaultTaxPct: 0.12,
          defaultBaseNightly: 650,
        },
        normalizedArgs,
        progress,
      );
    },
  };
}
