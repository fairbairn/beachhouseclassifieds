import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { executeExclusive30aSingleQuote } from "@/lib/pricing/quote-runtime/adapters/exclusive30a";
import { runRuntimeAdapterQuoteCli } from "@/lib/pricing/quotes/shared/runtime-adapter-quote-runner";
import { normalizeAdapterQuoteScopeArgs } from "../quote-scope";
import type { DetailRecordBase, ScrapedLink, ScraperAdapter } from "../types";

type ExclusiveBookedDay = {
  d?: string;
  departure_okay?: number;
};

type ExclusiveStatusCode = "A" | "U" | "I" | "O" | "X";

type ExclusiveDetailRecord = DetailRecordBase & {
  quote_context: {
    property_id: string;
    detail_url: string;
  };
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
  normalized_matching_profile: {
    source: "pm_exclusive30a";
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
    source: "pm_exclusive30a";
    external_listing_id: string;
    captured_at: string;
    window_start: string;
    window_end: string;
    code_legend: {
      Y: "available";
      N: "not_available";
    };
    day_codes: string;
    days: Array<{
      date: string;
      day_code: "Y" | "N";
      changeover_code: "C" | "I" | "O" | "X";
      is_available: boolean;
      status_code: ExclusiveStatusCode;
      is_available_for_checkin: boolean;
      is_available_for_checkout: boolean;
      booking_day_state: "bookable" | "blocked" | "unknown";
    }>;
    counts: {
      available: number;
      not_available: number;
      other: number;
      booking_available: number;
      booking_unavailable: number;
      booking_unknown: number;
    };
  };
  availability_raw: {
    booked_days: ExclusiveBookedDay[];
  };
};

const DEFAULT_ANCHOR_URL = "https://www.exclusive30a.com/vacation-rentals";
const OUTPUT_ROOT = resolve(
  process.cwd(),
  "src",
  "lib",
  "data",
  "external-sources",
  "exclusive30a",
);
const OUTPUT_DETAILS_HTML_DIR = resolve(OUTPUT_ROOT, "details", "html");

function stripHtml(value: string): string {
  return value
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&mdash;/gi, "-")
    .replace(/&ndash;/gi, "-")
    .replace(/&rsquo;/gi, "'")
    .replace(/&lsquo;/gi, "'")
    .replace(/&ldquo;/gi, '"')
    .replace(/&rdquo;/gi, '"')
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, digits: string) => {
      const code = Number(digits);
      if (!Number.isFinite(code) || code <= 0) {
        return "";
      }
      return String.fromCodePoint(code);
    })
    .replace(/&#x([a-fA-F0-9]+);/g, (_, hex: string) => {
      const code = Number.parseInt(hex, 16);
      if (!Number.isFinite(code) || code <= 0) {
        return "";
      }
      return String.fromCodePoint(code);
    });
}

function extractFirst(regex: RegExp, value: string): string {
  const match = value.match(regex);
  if (!match?.[1]) {
    return "";
  }
  return decodeHtmlEntities(stripHtml(match[1])).trim();
}

function stripHtmlFragment(value: string): string {
  return decodeHtmlEntities(stripHtml(value));
}

function extractDescriptionFromPanel(html: string): string {
  const panelMatch = html.match(
    /<div[^>]+id=["']panel-description["'][^>]*>[\s\S]*?<div[^>]+class=["'][^"']*accordion-body[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*<!--\s*end accordion-body\s*-->/i,
  );
  if (!panelMatch?.[1]) {
    return "";
  }

  return stripHtmlFragment(panelMatch[1]).slice(0, 20000);
}

function extractRoomsGuidanceFromPanel(html: string): string[] {
  const panelMatch = html.match(
    /<div[^>]+id=["']panel-bedrooms["'][^>]*>([\s\S]*?)<\/div>\s*<!--\s*end accordion-body\s*-->/i,
  );
  if (!panelMatch?.[1]) {
    return [];
  }

  const body = panelMatch[1];
  const rows: string[] = [];

  const rowRegex =
    /<div[^>]*class=["'][^"']*\brow\b[^"']*["'][^>]*>[\s\S]*?<div[^>]*class=["'][^"']*col-4[^"']*["'][^>]*>[\s\S]*?<div[^>]*class=["'][^"']*mb-3[^"']*["'][^>]*>([\s\S]*?)<\/div>[\s\S]*?<\/div>[\s\S]*?<div[^>]*class=["'][^"']*col-8[^"']*["'][^>]*>[\s\S]*?<div[^>]*class=["'][^"']*mb-3[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi;

  for (const rowMatch of body.matchAll(rowRegex)) {
    const room = stripHtmlFragment(rowMatch[1] ?? "").trim();
    const features = stripHtmlFragment(rowMatch[2] ?? "").trim();

    if (!room) {
      continue;
    }

    const roomKey = normalizeForMatch(room);
    const featureKey = normalizeForMatch(features);
    if (roomKey === "room" && (featureKey === "features" || !featureKey)) {
      continue;
    }

    rows.push(features ? `${room} | ${features}` : room);
  }

  return Array.from(new Set(rows));
}

function addAmenityValue(
  categories: Record<string, string[]>,
  all: string[],
  seen: Set<string>,
  category: string,
  value: string,
): void {
  const cleanedCategory =
    stripHtmlFragment(category).trim() || "Property Amenities";
  const cleanedValue = stripHtmlFragment(value).trim();
  if (!cleanedValue) {
    return;
  }

  if (!categories[cleanedCategory]) {
    categories[cleanedCategory] = [];
  }
  categories[cleanedCategory].push(cleanedValue);

  const dedupeKey = normalizeForMatch(cleanedValue);
  if (!dedupeKey || seen.has(dedupeKey)) {
    return;
  }
  seen.add(dedupeKey);
  all.push(cleanedValue);
}

function extractAmenitiesFromHtml(html: string): {
  categories: Record<string, string[]>;
  all: string[];
} {
  const categories: Record<string, string[]> = {};
  const all: string[] = [];
  const seen = new Set<string>();

  const modalBody = html.match(
    /<div[^>]+id=["']prop-amenities-modal["'][\s\S]*?<div[^>]+class=["'][^"']*modal-body[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/i,
  )?.[1];

  if (modalBody) {
    const categoryRegex =
      /<h5[^>]*class=["'][^"']*fw-bold[^"']*["'][^>]*>([\s\S]*?)<\/h5>\s*<ul[^>]*class=["'][^"']*bcs-amenities-list[^"']*["'][^>]*>([\s\S]*?)<\/ul>/gi;

    for (const match of modalBody.matchAll(categoryRegex)) {
      const category = match[1] ?? "Property Amenities";
      const listHtml = match[2] ?? "";
      for (const li of listHtml.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)) {
        if (li[1]) {
          addAmenityValue(categories, all, seen, category, li[1]);
        }
      }
    }
  }

  const highlightsList = html.match(
    /<div[^>]*class=["'][^"']*property-amenities-wrap[^"']*["'][\s\S]*?<ul[^>]*class=["'][^"']*bcs-amenities-list[^"']*["'][^>]*>([\s\S]*?)<\/ul>/i,
  )?.[1];
  if (highlightsList) {
    for (const li of highlightsList.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)) {
      if (li[1]) {
        addAmenityValue(categories, all, seen, "Highlights", li[1]);
      }
    }
  }

  return { categories, all };
}

function normalizeForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/&amp;/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toDayCodeFromStatus(statusCode: ExclusiveStatusCode): "Y" | "N" {
  return statusCode === "A" || statusCode === "O" ? "Y" : "N";
}

function toChangeoverCodeFromStatus(
  statusCode: ExclusiveStatusCode,
): "C" | "I" | "O" | "X" {
  if (statusCode === "I") {
    return "I";
  }
  if (statusCode === "O") {
    return "O";
  }
  if (statusCode === "U" || statusCode === "X") {
    return "X";
  }
  return "C";
}

function hashSha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseNumberLike(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function parseCoordinateVariable(html: string): {
  latitude: number | null;
  longitude: number | null;
} {
  const match = html.match(
    /var\s+coordinate\s*=\s*\{[\s\S]*?['"]lat['"]\s*:\s*(-?\d+(?:\.\d+)?)[\s\S]*?['"](?:lng|lon|lan|longitude)['"]\s*:\s*(-?\d+(?:\.\d+)?)[\s\S]*?\}/i,
  );
  if (!match?.[1] || !match[2]) {
    return { latitude: null, longitude: null };
  }

  return {
    latitude: parseNumberLike(match[1]),
    longitude: parseNumberLike(match[2]),
  };
}

function absoluteHttpUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const normalized = new URL(trimmed, "https://www.exclusive30a.com")
      .toString()
      .trim();
    if (!/^https?:\/\//i.test(normalized)) {
      return null;
    }
    return normalized;
  } catch {
    return null;
  }
}

function parseJsonLdObjects(html: string): Record<string, unknown>[] {
  const objects: Record<string, unknown>[] = [];
  const scriptRegex =
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

  for (const match of html.matchAll(scriptRegex)) {
    const raw = match[1]?.trim();
    if (!raw) {
      continue;
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item === "object") {
            objects.push(item as Record<string, unknown>);
          }
        }
        continue;
      }

      if (parsed && typeof parsed === "object") {
        objects.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Ignore malformed json-ld blobs.
    }
  }

  return objects;
}

function parseSchemaTypes(value: unknown): string[] {
  if (typeof value === "string") {
    return [value.toLowerCase()];
  }
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.toLowerCase());
}

function pickVacationRentalSchema(
  schemaObjects: Record<string, unknown>[],
): Record<string, unknown> | null {
  const preferredTypes = new Set([
    "vacationrental",
    "accommodation",
    "house",
    "product",
    "lodgingbusiness",
  ]);

  let best: { item: Record<string, unknown>; score: number } | null = null;

  for (const item of schemaObjects) {
    const types = parseSchemaTypes(item["@type"]);
    const hasPreferredType = types.some((entry) => preferredTypes.has(entry));
    if (!hasPreferredType) {
      continue;
    }

    let score = 1;
    if (item.numberOfBedrooms != null) {
      score += 3;
    }
    if (item.numberOfBathroomsTotal != null) {
      score += 3;
    }
    if (item.occupancy != null) {
      score += 2;
    }
    if (item.containsPlace != null) {
      score += 2;
    }
    if (item.address != null) {
      score += 1;
    }
    if (item.geo != null) {
      score += 1;
    }

    if (!best || score > best.score) {
      best = { item, score };
    }
  }

  if (best) {
    return best.item;
  }

  return schemaObjects[0] ?? null;
}

function extractFirstNumber(regex: RegExp, value: string): number | null {
  const match = value.match(regex);
  if (!match?.[1]) {
    return null;
  }

  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractCapacityStatFromHtml(
  html: string,
  label: "Bedrooms" | "Baths" | "Sleeps",
): number | null {
  const classPattern = "prop-stat-label\\s+property-title-custom-color[^\"']*";

  const beforeLabel = new RegExp(
    `<span[^>]*class=["'][^"']*${classPattern}["'][^>]*>\\s*(\\d+(?:\\.\\d+)?)\\s*<\\/span>\\s*<span[^>]*class=["'][^"']*${classPattern}["'][^>]*>\\s*${label}\\b`,
    "i",
  );
  const beforeValue = extractFirstNumber(beforeLabel, html);
  if (beforeValue != null) {
    return beforeValue;
  }

  const afterLabel = new RegExp(
    `<span[^>]*class=["'][^"']*${classPattern}["'][^>]*>\\s*${label}\\b\\s*<\\/span>\\s*<span[^>]*class=["'][^"']*${classPattern}["'][^>]*>\\s*(\\d+(?:\\.\\d+)?)\\s*<\\/span>`,
    "i",
  );
  return extractFirstNumber(afterLabel, html);
}

function normalizeDetailUrl(value: string): string | null {
  try {
    const parsed = new URL(value.trim());
    if (!parsed.hostname.endsWith("exclusive30a.com")) {
      return null;
    }

    const cleanPath = parsed.pathname.replace(/\/$/, "");
    const parts = cleanPath.split("/").filter(Boolean);
    if (parts.length < 2 || parts[0] !== "vacation-rentals") {
      return null;
    }

    const slug = parts[1];
    if (!slug) {
      return null;
    }

    return `${parsed.origin}/vacation-rentals/${slug}`;
  } catch {
    return null;
  }
}

function parsePageNumber(raw: string): number | null {
  const numberValue = Number(raw);
  if (!Number.isInteger(numberValue) || numberValue < 1) {
    return null;
  }
  return numberValue;
}

function parseBookedDaysFromHtml(html: string): ExclusiveBookedDay[] {
  const match = html.match(/var\s+booked_days\s*=\s*(\[[\s\S]*?\]);/i);
  if (!match?.[1]) {
    return [];
  }

  try {
    const parsed = JSON.parse(match[1]) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((entry) => entry && typeof entry === "object") as
      | ExclusiveBookedDay[]
      | [];
  } catch {
    return [];
  }
}

function extractPropertyIdFromHtml(html: string): string {
  const unitDataId = html.match(
    /var\s+unitData\s*=\s*\{[\s\S]*?unitID['"]?\s*:\s*(\d+)/i,
  )?.[1];
  if (unitDataId) {
    return unitDataId;
  }

  const dataFavId = html.match(/data-favid=["'](\d+)["']/i)?.[1];
  if (dataFavId) {
    return dataFavId;
  }

  const ecommerceItemId = html.match(
    /['"]item_id['"]\s*:\s*['"]?(\d+)['"]?/i,
  )?.[1];
  if (ecommerceItemId) {
    return ecommerceItemId;
  }

  return "";
}

function extractListingSlugFromDetailUrl(detailUrl: string): string {
  const normalized = normalizeDetailUrl(detailUrl);
  if (!normalized) {
    return "unknown";
  }

  const parts = new URL(normalized).pathname.split("/").filter(Boolean);
  return parts[1] || "unknown";
}

function yyyymmddToIso(value: string): string | null {
  const normalized = value.trim();
  if (!/^\d{8}$/.test(normalized)) {
    return null;
  }

  const year = Number(normalized.slice(0, 4));
  const month = Number(normalized.slice(4, 6));
  const day = Number(normalized.slice(6, 8));

  if (year < 1900 || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return formatDateIso(date);
}

function formatDateIso(value: Date): string {
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  const day = String(value.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function decodeTrackingCandidates(value: string): string[] {
  const normalized = value.replace(/&amp;/gi, "&").trim();
  if (!normalized) {
    return [];
  }

  const candidates = new Set<string>([normalized]);
  let current = normalized;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const decoded = decodeURIComponent(current);
      if (!decoded || decoded === current) {
        break;
      }
      candidates.add(decoded);
      current = decoded;
    } catch {
      break;
    }
  }

  return Array.from(candidates);
}

async function collectLinksOnCurrentPage(
  page: Parameters<
    ScraperAdapter<ExclusiveDetailRecord>["discoverListings"]
  >[0]["page"],
): Promise<{ detailLinks: string[]; pageNumbers: number[] }> {
  const detailLinks = new Set<string>();
  const pageNumbers = new Set<number>();

  const panelSelector =
    "#prop-search-results > div.col.mb-5.gmarker.tile-item > div.card.property-tile.h-100.p-3";

  const toListingUrl = (candidate: string): string | null => {
    try {
      const parsed = new URL(candidate, DEFAULT_ANCHOR_URL);
      if (!parsed.hostname.endsWith("exclusive30a.com")) {
        return null;
      }

      const cleanPath = parsed.pathname.replace(/\/$/, "");
      const parts = cleanPath.split("/").filter(Boolean);
      if (parts.length < 2 || parts[0] !== "vacation-rentals") {
        return null;
      }

      return `${parsed.origin}/vacation-rentals/${parts.slice(1).join("/")}`;
    } catch {
      return null;
    }
  };

  const panels = page.locator(panelSelector);
  const panelCount = await panels.count();
  for (let index = 0; index < panelCount; index += 1) {
    const panel = panels.nth(index);
    if (!(await panel.isVisible())) {
      continue;
    }

    const href = await panel.evaluate((element) => {
      const selectors = [
        "a.tiles-view-home-btn[target][href]",
        "a.tiles-view-home-btn[href]",
        "a[href*='destination_url=']",
      ];

      for (const selector of selectors) {
        const anchor = element.querySelector(selector);
        const value = anchor?.getAttribute("href") || "";
        if (value.trim()) {
          return value;
        }
      }

      return "";
    });

    if (!href?.trim()) {
      continue;
    }

    const normalizedHref = href.replace(/&amp;/gi, "&");

    const directListing = toListingUrl(normalizedHref);
    if (directListing) {
      detailLinks.add(directListing);
      continue;
    }

    let destination = "";
    try {
      const clickUrl = new URL(normalizedHref, DEFAULT_ANCHOR_URL);
      destination =
        clickUrl.searchParams.get("destination_url") ||
        clickUrl.searchParams.get("amp;destination_url") ||
        "";
    } catch {
      destination = "";
    }

    if (!destination.trim()) {
      const fallbackMatch = normalizedHref.match(
        /(?:\?|&|&amp;)destination_url=([^&#]+)/i,
      );
      destination = fallbackMatch?.[1] ? fallbackMatch[1] : "";
    }

    if (!destination.trim()) {
      continue;
    }

    for (const candidate of decodeTrackingCandidates(destination)) {
      const listingUrl = toListingUrl(candidate);
      if (listingUrl) {
        detailLinks.add(listingUrl);
      }
    }
  }

  const paginationAnchors = page.locator("a[href*='page='], a[data-page]");
  const paginationCount = await paginationAnchors.count();
  for (let index = 0; index < paginationCount; index += 1) {
    const anchor = paginationAnchors.nth(index);
    const href = (await anchor.getAttribute("href")) || "";
    const dataPage = (await anchor.getAttribute("data-page")) || "";

    if (href.trim()) {
      try {
        const url = new URL(href, DEFAULT_ANCHOR_URL);
        const pageParam = url.searchParams.get("page");
        if (pageParam) {
          const pageNumber = Number(pageParam);
          if (Number.isInteger(pageNumber) && pageNumber > 0) {
            pageNumbers.add(pageNumber);
          }
        }
      } catch {
        // Ignore invalid URLs.
      }
    }

    const dataPageNumber = Number(dataPage);
    if (Number.isInteger(dataPageNumber) && dataPageNumber > 0) {
      pageNumbers.add(dataPageNumber);
    }
  }

  return {
    detailLinks: Array.from(detailLinks),
    pageNumbers: Array.from(pageNumbers),
  };
}

async function collectStableLinksOnCurrentPage(
  page: Parameters<
    ScraperAdapter<ExclusiveDetailRecord>["discoverListings"]
  >[0]["page"],
  settleMs: number,
): Promise<{ detailLinks: string[]; pageNumbers: number[] }> {
  let previousFingerprint = "";
  let latest: { detailLinks: string[]; pageNumbers: number[] } = {
    detailLinks: [],
    pageNumbers: [],
  };

  for (let attempt = 0; attempt < 8; attempt += 1) {
    await page.waitForTimeout(settleMs);
    latest = await collectLinksOnCurrentPage(page);

    const fingerprint = latest.detailLinks
      .slice()
      .sort((a, b) => a.localeCompare(b))
      .join("|");

    if (fingerprint && fingerprint === previousFingerprint) {
      return latest;
    }

    previousFingerprint = fingerprint;
  }

  return latest;
}

async function discoverListings(
  page: Parameters<
    ScraperAdapter<ExclusiveDetailRecord>["discoverListings"]
  >[0]["page"],
  anchorUrl: string,
  maxScrollSteps: number,
  scrollPauseMs: number,
  reportProgress: (message: string) => void,
): Promise<ScrapedLink[]> {
  const collectedLinks: string[] = [];
  const sourceByLink = new Map<string, string>();
  const seenLinks = new Set<string>();

  const collectPage = async (
    sourcePageUrl: string,
  ): Promise<{
    extracted: number;
    newUnique: number;
    pageNumbers: number[];
  }> => {
    const pass = await collectStableLinksOnCurrentPage(
      page,
      Math.max(700, scrollPauseMs),
    );

    let extracted = 0;
    let newUnique = 0;
    for (const link of pass.detailLinks) {
      const normalized = normalizeDetailUrl(link);
      if (!normalized) {
        continue;
      }

      extracted += 1;
      collectedLinks.push(normalized);
      if (!sourceByLink.has(normalized)) {
        sourceByLink.set(normalized, sourcePageUrl);
      }

      if (!seenLinks.has(normalized)) {
        seenLinks.add(normalized);
        newUnique += 1;
      }
    }

    return {
      extracted,
      newUnique,
      pageNumbers: pass.pageNumbers,
    };
  };

  const navigateToPage = async (pageNumber: number): Promise<string> => {
    const pageUrl = new URL(anchorUrl);
    if (pageNumber > 1) {
      pageUrl.searchParams.set("page", String(pageNumber));
    } else {
      pageUrl.searchParams.delete("page");
    }

    if (pageNumber === 1) {
      await page.goto(pageUrl.toString(), {
        waitUntil: "domcontentloaded",
        timeout: 120000,
      });
      return page.url();
    }

    const paginationLink = page
      .locator(`a[data-page='${pageNumber}'], a[href*='page=${pageNumber}']`)
      .first();
    const linkExists = (await paginationLink.count()) > 0;

    if (!linkExists) {
      await page.goto(pageUrl.toString(), {
        waitUntil: "domcontentloaded",
        timeout: 120000,
      });
      return page.url();
    }

    try {
      await Promise.all([
        page
          .waitForNavigation({
            waitUntil: "domcontentloaded",
            timeout: 120000,
          })
          .catch(() => null),
        paginationLink.click({ timeout: 10000 }),
      ]);
    } catch {
      await page.goto(pageUrl.toString(), {
        waitUntil: "domcontentloaded",
        timeout: 120000,
      });
    }

    return page.url();
  };

  reportProgress("session_mode=single-context ordered-pagination=true");

  const firstPageUrl = await navigateToPage(1);
  const firstPass = await collectPage(firstPageUrl);
  reportProgress(
    `pagination page 1/?; extracted_links=${firstPass.extracted}; unique_added=${firstPass.newUnique}; cumulative_unique=${seenLinks.size}`,
  );

  let maxPage = 1;
  for (const rawPageNumber of firstPass.pageNumbers) {
    const parsedPage = parsePageNumber(String(rawPageNumber));
    if (parsedPage && parsedPage > maxPage) {
      maxPage = parsedPage;
    }
  }

  const configuredPageCount = Number(
    process.env.EXCLUSIVE30A_PAGE_COUNT ?? "7",
  );
  const defaultPageCount =
    Number.isInteger(configuredPageCount) && configuredPageCount > 0
      ? configuredPageCount
      : 7;
  const discoveredPageCount = Math.max(maxPage, defaultPageCount);
  const pageTraversalLimit = Math.max(
    1,
    Math.min(discoveredPageCount, maxScrollSteps),
  );

  if (pageTraversalLimit > 1) {
    reportProgress(
      `pagination detected; traversing ${pageTraversalLimit} pages (reported max=${maxPage})`,
    );
  }

  for (let pageNumber = 2; pageNumber <= pageTraversalLimit; pageNumber += 1) {
    const currentPageUrl = await navigateToPage(pageNumber);
    const pagePass = await collectPage(currentPageUrl);

    reportProgress(
      `pagination page ${pageNumber}/${pageTraversalLimit}; extracted_links=${pagePass.extracted}; unique_added=${pagePass.newUnique}; cumulative_unique=${seenLinks.size}`,
    );
  }

  return collectedLinks.map((link) => ({
    link,
    source_url: sourceByLink.get(link) ?? anchorUrl,
    anchor_text: "view-home",
  }));
}

async function fetchDetail(
  context: Parameters<ScraperAdapter<ExclusiveDetailRecord>["fetchDetail"]>[0],
): Promise<ExclusiveDetailRecord | null> {
  const { detailUrl, availabilityHorizonDays, browser, reportDetailProgress } =
    context;
  const normalizedDetailUrl = normalizeDetailUrl(detailUrl);
  if (!normalizedDetailUrl) {
    reportDetailProgress?.(`detail_invalid_url listing=${detailUrl}`);
    return null;
  }

  reportDetailProgress?.(
    `detail_transport=cloakbrowser listing=${normalizedDetailUrl}`,
  );

  try {
    const detailPage = await browser.newPage();
    let html = "";
    try {
      const response = await detailPage.goto(normalizedDetailUrl, {
        waitUntil: "domcontentloaded",
        timeout: 120000,
      });

      const status = response?.status() ?? null;
      const finalUrl = detailPage.url();
      if (status !== 200) {
        reportDetailProgress?.(
          `detail_http_status status=${status ?? "unknown"} listing=${normalizedDetailUrl} final_url=${finalUrl}`,
        );
        return null;
      }

      html = await detailPage.content();
      const lowerHtml = html.toLowerCase();
      if (
        lowerHtml.includes("error 1015") ||
        lowerHtml.includes("attention required") ||
        lowerHtml.includes("cf-browser-verification") ||
        lowerHtml.includes("cloudflare")
      ) {
        reportDetailProgress?.(
          `detail_challenge_detected status=200 listing=${normalizedDetailUrl} final_url=${finalUrl}`,
        );
        return null;
      }
    } finally {
      await detailPage.close().catch(() => undefined);
    }

    if (!html.trim()) {
      reportDetailProgress?.(
        `detail_empty_html listing=${normalizedDetailUrl}`,
      );
      return null;
    }

    const listingSlug = extractListingSlugFromDetailUrl(normalizedDetailUrl);
    const propertyId = extractPropertyIdFromHtml(html);

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

    const htmlPath = resolve(OUTPUT_DETAILS_HTML_DIR, `${listingSlug}.html`);
    await writeFile(htmlPath, `${html}\n`, "utf8");

    const schemaObjects = parseJsonLdObjects(html);
    const vacationRentalSchema = pickVacationRentalSchema(schemaObjects);

    const bookedDays = parseBookedDaysFromHtml(html);
    const bookedByDate = new Map<string, ExclusiveBookedDay>();
    for (const entry of bookedDays) {
      const raw = typeof entry.d === "string" ? entry.d : "";
      const iso = yyyymmddToIso(raw);
      if (!iso) {
        continue;
      }
      bookedByDate.set(iso, entry);
    }

    const now = new Date();
    const today = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );

    const normalizedDays: ExclusiveDetailRecord["normalized_availability"]["days"] =
      [];
    for (let offset = 0; offset <= availabilityHorizonDays; offset += 1) {
      const current = new Date(today);
      current.setUTCDate(today.getUTCDate() + offset);
      const date = formatDateIso(current);

      const booked = bookedByDate.get(date);
      if (booked) {
        const checkoutOk = Number(booked.departure_okay) === 1;
        normalizedDays.push({
          date,
          day_code: checkoutOk ? "Y" : "N",
          changeover_code: checkoutOk ? "O" : "X",
          is_available: false,
          is_available_for_checkin: false,
          is_available_for_checkout: checkoutOk,
          status_code: checkoutOk ? "O" : "U",
          booking_day_state: "blocked",
        });
      } else {
        normalizedDays.push({
          date,
          day_code: "Y",
          changeover_code: "C",
          is_available: true,
          is_available_for_checkin: true,
          is_available_for_checkout: true,
          status_code: "A",
          booking_day_state: "bookable",
        });
      }
    }

    const applyDerivedStatus = (
      day: (typeof normalizedDays)[number],
      statusCode: ExclusiveStatusCode,
    ): void => {
      day.status_code = statusCode;
      day.day_code = toDayCodeFromStatus(statusCode);
      day.changeover_code = toChangeoverCodeFromStatus(statusCode);
      day.is_available =
        statusCode === "A" || statusCode === "I" || statusCode === "O";
      day.is_available_for_checkin = statusCode === "A" || statusCode === "I";
      day.is_available_for_checkout = statusCode === "A" || statusCode === "O";
    };

    for (let index = 0; index < normalizedDays.length; index += 1) {
      const day = normalizedDays[index];
      if (!day || day.status_code !== "A") {
        continue;
      }

      const previousDay = index > 0 ? normalizedDays[index - 1] : null;
      const nextDay =
        index + 1 < normalizedDays.length ? normalizedDays[index + 1] : null;
      const previousUnavailable =
        previousDay !== null &&
        (previousDay.status_code === "U" || previousDay.status_code === "X");
      const nextUnavailable =
        nextDay !== null &&
        (nextDay.status_code === "U" || nextDay.status_code === "X");

      if (index === 0 && nextUnavailable) {
        applyDerivedStatus(day, "O");
        continue;
      }

      if (previousUnavailable) {
        applyDerivedStatus(day, "I");
      }
    }

    const available = normalizedDays.filter((day) => day.is_available).length;
    const notAvailable = normalizedDays.length - available;
    const other = normalizedDays.length - available - notAvailable;

    const name = stripHtmlFragment(h1 || title).slice(0, 240);
    const schemaDescription =
      typeof vacationRentalSchema?.description === "string"
        ? stripHtmlFragment(vacationRentalSchema.description)
        : "";
    const panelDescription = extractDescriptionFromPanel(html);
    const roomsGuidance = extractRoomsGuidanceFromPanel(html);
    const description =
      [panelDescription, schemaDescription, metaDescription]
        .map((value) => stripHtmlFragment(value))
        .sort((a, b) => b.length - a.length)[0]
        ?.slice(0, 20000) ?? "";
    const titleNormalized = normalizeForMatch(name);
    const descriptionNormalized = normalizeForMatch(description);
    const descriptionHash = hashSha256(descriptionNormalized);
    const titleHash = hashSha256(titleNormalized);

    const amenitiesFromHtml = extractAmenitiesFromHtml(html);
    const amenitiesCategories: Record<string, string[]> = {
      ...amenitiesFromHtml.categories,
    };
    const amenitiesAll: string[] = [...amenitiesFromHtml.all];
    const seenAmenity = new Set<string>(
      amenitiesAll.map((value) => normalizeForMatch(value)).filter(Boolean),
    );
    const schemaAmenities = Array.isArray(vacationRentalSchema?.amenityFeature)
      ? (vacationRentalSchema?.amenityFeature as unknown[])
      : [];
    for (const feature of schemaAmenities) {
      if (!feature || typeof feature !== "object") {
        continue;
      }

      const label = (feature as { name?: unknown }).name;
      if (typeof label !== "string") {
        continue;
      }

      const value = stripHtmlFragment(label).trim();
      if (!value) {
        continue;
      }

      addAmenityValue(
        amenitiesCategories,
        amenitiesAll,
        seenAmenity,
        "Property Amenities",
        value,
      );
    }

    const imageUrls: string[] = [];
    const seenImage = new Set<string>();
    const pushImage = (value: string) => {
      const normalized = absoluteHttpUrl(value);
      if (!normalized) {
        return;
      }

      const key = normalized.toLowerCase();
      if (seenImage.has(key)) {
        return;
      }
      seenImage.add(key);
      imageUrls.push(normalized);
    };

    const galleryHrefRegex =
      /data-fancybox=["']property-gallery["'][^>]+href=["']([^"']+)["']/gi;
    for (const match of html.matchAll(galleryHrefRegex)) {
      if (match[1]) {
        pushImage(match[1]);
      }
    }

    if (imageUrls.length === 0) {
      const schemaImages = vacationRentalSchema?.image;
      if (Array.isArray(schemaImages)) {
        for (const entry of schemaImages) {
          if (typeof entry === "string") {
            pushImage(entry);
          }
        }
      } else if (typeof schemaImages === "string") {
        pushImage(schemaImages);
      }

      const ogImage = extractFirst(
        /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
        html,
      );
      if (ogImage) {
        pushImage(ogImage);
      }
    }

    const schemaAddress =
      vacationRentalSchema?.address &&
      typeof vacationRentalSchema.address === "object"
        ? (vacationRentalSchema.address as Record<string, unknown>)
        : null;
    const schemaGeo =
      vacationRentalSchema?.geo && typeof vacationRentalSchema.geo === "object"
        ? (vacationRentalSchema.geo as Record<string, unknown>)
        : null;

    const address = String(schemaAddress?.streetAddress ?? "").trim();
    let city = String(schemaAddress?.addressLocality ?? "").trim();
    const state = String(schemaAddress?.addressRegion ?? "").trim();
    const locationExcerpt = extractFirst(
      /<p[^>]*class=["'][^"']*property-excerpt[^"']*["'][^>]*>([\s\S]*?)<\/p>/i,
      html,
    );
    if (!city && locationExcerpt) {
      city = locationExcerpt.split("-")[0]?.trim().slice(0, 120);
    }
    const fallbackAddress = address || locationExcerpt;
    const locationLabel =
      [city, state].filter(Boolean).join(", ") || locationExcerpt;
    const directionsDaddr = [fallbackAddress, city, state]
      .filter(Boolean)
      .join(", ");
    const directionsUrl = directionsDaddr
      ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(
          directionsDaddr,
        )}`
      : "";
    const coordVar = parseCoordinateVariable(html);
    const latitude =
      parseNumberLike(schemaGeo?.latitude ?? null) ?? coordVar.latitude;
    const longitude =
      parseNumberLike(schemaGeo?.longitude ?? null) ?? coordVar.longitude;

    const bedsFromSchema = parseNumberLike(
      vacationRentalSchema?.numberOfBedrooms ??
        (
          vacationRentalSchema?.containsPlace as
            | { numberOfBedrooms?: unknown }
            | undefined
        )?.numberOfBedrooms ??
        null,
    );
    const bathsFromSchema = parseNumberLike(
      vacationRentalSchema?.numberOfBathroomsTotal ??
        (
          vacationRentalSchema?.containsPlace as
            | { numberOfBathroomsTotal?: unknown }
            | undefined
        )?.numberOfBathroomsTotal ??
        null,
    );
    const sleepsFromSchema = parseNumberLike(
      (
        vacationRentalSchema?.occupancy as
          | {
              value?: unknown;
            }
          | undefined
      )?.value ??
        (
          vacationRentalSchema?.containsPlace as
            | {
                occupancy?: {
                  value?: unknown;
                };
              }
            | undefined
        )?.occupancy?.value ??
        null,
    );

    const bedsFromHtml = extractCapacityStatFromHtml(html, "Bedrooms");
    const bathsFromHtml = extractCapacityStatFromHtml(html, "Baths");
    const sleepsFromHtml = extractCapacityStatFromHtml(html, "Sleeps");

    return {
      external_listing_id: listingSlug,
      detail_url: normalizedDetailUrl,
      quote_context: {
        property_id: propertyId,
        detail_url: normalizedDetailUrl,
      },
      fetched_at: new Date().toISOString(),
      title,
      h1,
      canonical_url: canonicalUrl,
      meta_description: metaDescription,
      description_expanded: description,
      rooms_guidance: roomsGuidance,
      amenities: {
        categories: amenitiesCategories,
        all: amenitiesAll,
      },
      location: {
        address: fallbackAddress,
        location_label: locationLabel,
        directions_url: directionsUrl,
        directions_daddr: directionsDaddr,
        latitude,
        longitude,
      },
      media_gallery: {
        image_count: imageUrls.length,
        image_urls: imageUrls,
      },
      property_profile: {
        unit_id: propertyId || listingSlug,
        area: "30A",
        location: locationLabel,
        beds: bedsFromSchema ?? bedsFromHtml,
        baths: bathsFromSchema ?? bathsFromHtml,
        sleeps: sleepsFromSchema ?? sleepsFromHtml,
        city,
        state,
      },
      normalized_matching_profile: {
        source: "pm_exclusive30a",
        external_listing_id: listingSlug,
        name,
        description,
        match_signals: {
          description_normalized: descriptionNormalized,
          description_sha256: descriptionHash,
          title_normalized: titleNormalized,
          title_sha256: titleHash,
          listing_composite_key: [
            "pm_exclusive30a",
            listingSlug,
            descriptionHash,
            titleHash,
          ].join("::"),
        },
      },
      normalized_availability: {
        source: "pm_exclusive30a",
        external_listing_id: listingSlug,
        captured_at: new Date().toISOString(),
        window_start: normalizedDays[0]?.date ?? "",
        window_end: normalizedDays[normalizedDays.length - 1]?.date ?? "",
        code_legend: {
          Y: "available",
          N: "not_available",
        },
        day_codes: normalizedDays
          .map((day) => (day.is_available ? "Y" : "N"))
          .join(""),
        days: normalizedDays,
        counts: {
          available,
          not_available: notAvailable,
          other,
          booking_available: normalizedDays.filter(
            (day) => day.booking_day_state === "bookable",
          ).length,
          booking_unavailable: normalizedDays.filter(
            (day) => day.booking_day_state === "blocked",
          ).length,
          booking_unknown: normalizedDays.filter(
            (day) => day.booking_day_state === "unknown",
          ).length,
        },
      },
      availability_raw: {
        booked_days: bookedDays,
      },
      html_path: htmlPath,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "unknown_detail_request_error";
    reportDetailProgress?.(
      `detail_request_error listing=${normalizedDetailUrl} reason=${message}`,
    );
    return null;
  }
}

export function createExclusive30AAdapter(): ScraperAdapter<ExclusiveDetailRecord> {
  return {
    managerKey: "exclusive30a",
    scriptLabel: "exclusive30a",
    defaultAnchorUrl: DEFAULT_ANCHOR_URL,
    detailFetchDelayMs: Math.max(
      0,
      Number(process.env.EXCLUSIVE30A_DETAIL_FETCH_DELAY_MS ?? "250") || 250,
    ),
    detailFetchConcurrency: Math.max(
      1,
      Number(process.env.EXCLUSIVE30A_FETCH_CONCURRENCY ?? "6") || 6,
    ),
    availabilityHorizonDays: Math.max(
      1,
      Number(process.env.EXCLUSIVE30A_AVAILABILITY_HORIZON_DAYS ?? "730") ||
        730,
    ),
    maxCalendarAdvanceMonths: 24,
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
      return fetchDetail(context);
    },
    async runQuoteCapture(argv, progress) {
      const normalizedArgs = await normalizeAdapterQuoteScopeArgs(
        "exclusive30a",
        argv,
      );
      await runRuntimeAdapterQuoteCli(
        {
          adapterKey: "exclusive30a",
          executeSingleQuote: executeExclusive30aSingleQuote,
          defaultQuoteTimeoutMs: 20000,
          defaultQuoteMaxAttempts: 2,
          defaultEndpointPath: "/quote",
          defaultTaxPct: 0.12,
          defaultBaseNightly: 700,
        },
        normalizedArgs,
        progress,
      );
    },
    async runSingleQuoteObservation(input) {
      const result = await executeExclusive30aSingleQuote({
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
          handoffUrl: input.handoffUrl ?? null,
          reason: result.error.code,
        },
      };
    },
  };
}
