import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Page } from "playwright";

import {
  createDiscoveryLogger,
  resolveAdapterRuntime,
} from "../adapter-foundation";
import { normalizeAdapterQuoteScopeArgs } from "../quote-scope";
import type { DetailRecordBase, ScrapedLink, ScraperAdapter } from "../types";
import { runThirtyABeachQuoteCli } from "./quotes/30abeach";

type ThirtyABeachListingRow = {
  id: string;
  seoPageName: string;
  name: string;
  description: string;
  city: string;
  state: string;
  latitude: number | null;
  longitude: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  sleeps: number | null;
  imageUrls: string[];
};

type ThirtyABeachDayCode = "Y" | "N" | "X";

type ThirtyABeachDetailRecord = DetailRecordBase & {
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
    area: string;
    location: string;
    beds: number | null;
    baths: number | null;
    sleeps: number | null;
    city: string;
    state: string;
  };
  normalized_matching_profile: {
    source: "pm_30abeach";
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
    source: "pm_30abeach";
    external_listing_id: string;
    captured_at: string;
    window_start: string;
    window_end: string;
    code_legend: {
      Y: "available";
      N: "not_available";
      X: "other";
    };
    day_codes: string;
    days: Array<{
      date: string;
      is_available: boolean;
      status_code: ThirtyABeachDayCode;
      is_available_for_checkin: boolean;
      is_available_for_checkout: boolean;
      booking_day_state: "bookable" | "blocked" | "unknown";
      min_nights_required: number | null;
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
    begin_date: string;
    end_date: string;
    day_codes: string;
  };
  normalized_rates: {
    source: "pm_30abeach";
    external_listing_id: string;
    captured_at: string;
    currency: string;
    window_start: string;
    window_end: string;
    days: Array<{
      date: string;
      nightly_rate: number | null;
      min_nights: number | null;
      is_booked: boolean | null;
      changeover_code: string;
      season_name: string;
    }>;
    stats: {
      days_with_rate: number;
      min_nightly_rate: number | null;
      max_nightly_rate: number | null;
      avg_nightly_rate: number | null;
    };
  };
  rates_raw: {
    request_start_date: string;
    request_end_date: string;
    rows: Array<Record<string, unknown>>;
  };
  pricing_api_hints: {
    provider: "streamlinecore-api-request";
    endpoint_path: "/wp-admin/admin-ajax.php";
    method_names: {
      availability: "GetPropertyAvailabilityRawData";
      rates: "GetPropertyRatesRawData";
      pre_reservation_price: "GetPreReservationPrice";
    };
    notes: string;
  };
};

const DEFAULT_ANCHOR_URL =
  "https://30abeachproperties.com/search-results/?beds=&sort_by=random";
const OUTPUT_ROOT = resolve(
  process.cwd(),
  "src",
  "lib",
  "data",
  "external-sources",
  "30abeach",
);
const OUTPUT_DETAILS_HTML_DIR = resolve(OUTPUT_ROOT, "details", "html");
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const listingCache = new Map<string, Promise<ThirtyABeachListingRow[]>>();

function normalizeLink(url: string): string {
  return url.split("#")[0]?.replace(/\/$/, "") ?? url;
}

function isDetailPath(pathname: string): boolean {
  const normalizedPath = pathname.toLowerCase();
  if (
    normalizedPath.startsWith("/rentals/") ||
    normalizedPath.startsWith("/vacation-rental/") ||
    normalizedPath.startsWith("/rental/")
  ) {
    return true;
  }

  return /^\/\d+\/?$/.test(pathname);
}

function toValidDetailUrl(value: string): string | null {
  try {
    const parsed = new URL(value.trim());
    if (!parsed.hostname.endsWith("30abeachproperties.com")) {
      return null;
    }

    if (!isDetailPath(parsed.pathname)) {
      return null;
    }

    return normalizeLink(`${parsed.origin}${parsed.pathname}`);
  } catch {
    return null;
  }
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
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#039;/gi, "'")
    .replace(/&rsquo;/gi, "'")
    .replace(/&ldquo;|&rdquo;/gi, '"')
    .replace(/&ndash;|&mdash;/gi, "-")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
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

function parseCurrencyLike(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[^0-9.-]/g, "").trim());
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function parseUsDateToUtc(value: string): Date | null {
  const match = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
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
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDateIso(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDateUsFromIso(isoDate: string): string {
  const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return "";
  }
  return `${match[2]}/${match[3]}/${match[1]}`;
}

function normalizeDateLikeToIso(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }

  const parsedUs = parseUsDateToUtc(trimmed);
  if (parsedUs) {
    return formatDateIso(parsedUs);
  }

  return "";
}

function decodeAvailabilityDays(
  beginDateRaw: string,
  availabilityRaw: string,
): Array<{ date: string; code: ThirtyABeachDayCode }> {
  const beginDate = parseUsDateToUtc(beginDateRaw);
  if (!beginDate) {
    return [];
  }

  const days: Array<{ date: string; code: ThirtyABeachDayCode }> = [];
  for (let index = 0; index < availabilityRaw.length; index += 1) {
    const current = new Date(beginDate);
    current.setUTCDate(beginDate.getUTCDate() + index);
    const rawCode = availabilityRaw[index] ?? "";
    const code: ThirtyABeachDayCode =
      rawCode === "Y" ? "Y" : rawCode === "N" ? "N" : "X";
    days.push({
      date: formatDateIso(current),
      code,
    });
  }

  return days;
}

function extractFirst(regex: RegExp, value: string): string {
  const match = value.match(regex);
  if (!match?.[1]) {
    return "";
  }
  return stripHtml(match[1]).trim();
}

function normalizeSeoPath(value: string): string {
  return value.trim().replace(/^\/+/, "").replace(/\/+$/, "").toLowerCase();
}

function normalizeSeoLookupKey(value: string): string {
  return normalizeSeoPath(value).replace(/'/g, "");
}

function detailUrlFromSeoPath(origin: string, seoPath: string): string {
  const normalized = normalizeSeoPath(seoPath);
  if (!normalized) {
    return origin;
  }
  return `${origin}/${normalized}/`;
}

function extractSeoPathFromDetailUrl(detailUrl: string): string {
  try {
    const parsed = new URL(detailUrl);
    return normalizeSeoPath(parsed.pathname);
  } catch {
    return "";
  }
}

function extractUnitIdFromHtml(html: string): string | null {
  const patterns = [
    /id=["']unit_id["'][^>]*value=["'](\d+)["']/i,
    /book\.unit_id\s*=\s*(\d+)/i,
    /["']unit_id["']\s*:\s*(\d+)/i,
    /unit_id%22\s*:\s*(\d+)/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
}

function extractAmenityCategoriesFromHtml(
  html: string,
): Record<string, string[]> {
  const categoryValues: Record<string, string[]> = {};

  const amenityItems = Array.from(
    html.matchAll(
      /class=["'][^"']*amenity_item[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi,
    ),
  )
    .map((match) => stripHtml(match[1] ?? ""))
    .map((value) => value.replace(/^[-*•]\s*/, "").trim())
    .filter((value) => value.length > 0);

  const groupItems = Array.from(
    html.matchAll(
      /class=["'][^"']*amenity_group[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi,
    ),
  )
    .map((match) => stripHtml(match[1] ?? ""))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (amenityItems.length > 0) {
    categoryValues.Amenities = dedupePreserveOrder(amenityItems);
  }

  if (groupItems.length > 0) {
    categoryValues.AmenityGroups = dedupePreserveOrder(groupItems);
  }

  const descriptionChunk = extractFirst(
    /<div[^>]+class=["'][^"']*property_description[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    html,
  );

  const highlightsAnchor = descriptionChunk.match(
    /(Home|Property)\s*Highlights\s*:\s*([\s\S]*)/i,
  );
  const highlightsChunk = highlightsAnchor?.[2] ?? highlightsAnchor?.[1] ?? "";

  const highlightedAmenities = highlightsChunk
    .split(/\n+/)
    .map((line) => line.replace(/^[-*•]\s*/, "").trim())
    .filter((line) => line.length > 0)
    .filter((line) => !/^reservation\/booking policy/i.test(line))
    .filter((line) => !/^(home|property)\s*highlights\s*:?$/i.test(line))
    .slice(0, 120);

  if (highlightedAmenities.length > 0) {
    categoryValues.PropertyHighlights =
      dedupePreserveOrder(highlightedAmenities);
  }

  if (Object.values(categoryValues).flat().length < 8) {
    const descriptionLines = descriptionChunk
      .split(/\n+/)
      .map((line) => line.replace(/^[-*•]\s*/, "").trim())
      .filter((line) => line.length > 0)
      .filter((line) => line.length <= 140)
      .filter((line) => !/^\d+\s+[A-Za-z]/.test(line))
      .filter((line) => !/^\d+\s*$/.test(line))
      .filter((line) => !/^first floor:?$/i.test(line))
      .filter((line) => !/^second floor:?$/i.test(line))
      .filter((line) => !/^third floor:?$/i.test(line))
      .filter((line) => !/^sleeps\s+\d+/i.test(line))
      .filter((line) => !/^no\s+smoking$/i.test(line))
      .filter((line) => !/^no\s+pets$/i.test(line))
      .slice(0, 80);

    if (descriptionLines.length > 0) {
      categoryValues.DescriptionHighlights =
        dedupePreserveOrder(descriptionLines);
    }
  }

  return categoryValues;
}

function extractJsonLdAddress(html: string): {
  address: string;
  city: string;
  state: string;
} {
  const scripts = Array.from(
    html.matchAll(
      /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
    ),
  )
    .map((match) => match[1] ?? "")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  for (const rawScript of scripts) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawScript);
    } catch {
      continue;
    }

    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of items) {
      if (!item || typeof item !== "object") {
        continue;
      }

      const addressObj = (item as { address?: unknown }).address;
      if (!addressObj || typeof addressObj !== "object") {
        continue;
      }

      const streetAddress = stripHtml(
        String((addressObj as { streetAddress?: unknown }).streetAddress ?? ""),
      ).trim();
      const city = stripHtml(
        String(
          (addressObj as { addressLocality?: unknown }).addressLocality ?? "",
        ),
      ).trim();
      const state = stripHtml(
        String((addressObj as { addressRegion?: unknown }).addressRegion ?? ""),
      ).trim();
      const postalCode = stripHtml(
        String((addressObj as { postalCode?: unknown }).postalCode ?? ""),
      ).trim();

      const fullAddress = [
        streetAddress,
        [city, state].filter((part) => part.length > 0).join(", "),
        postalCode,
      ]
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
        .join(" ");

      if (fullAddress || city || state) {
        return {
          address: fullAddress,
          city,
          state,
        };
      }
    }
  }

  return {
    address: "",
    city: "",
    state: "",
  };
}

function extractRoomDetailsStats(html: string): {
  beds: number | null;
  baths: number | null;
  sleeps: number | null;
} {
  const parseFirstInt = (value: string): number | null => {
    const match = value.match(/(\d+)/);
    if (!match?.[1]) {
      return null;
    }
    const parsed = Number(match[1]);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const fromDetailsList = (
    label: "Sleeps" | "Bedrooms" | "Bathrooms",
  ): number | null => {
    const regex = new RegExp(
      `${label}:\\s*<span[^>]*>\\s*<strong>([\\s\\S]*?)<\\/strong>`,
      "i",
    );
    const match = html.match(regex);
    if (!match?.[1]) {
      return null;
    }
    return parseFirstInt(stripHtml(match[1]));
  };

  const fromGuestsBadge = (): number | null => {
    const match = html.match(/<li>\s*(\d+)\s*Guests\s*<\/li>/i);
    if (!match?.[1]) {
      return null;
    }
    const parsed = Number(match[1]);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const fromDescriptionPattern = (pattern: RegExp): number | null => {
    const descriptionBlock = extractFirst(
      /<div[^>]+class=["'][^"']*property_description[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
      html,
    );
    const match = descriptionBlock.match(pattern);
    if (!match?.[1]) {
      return null;
    }
    const parsed = Number(match[1]);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const sleeps =
    fromDetailsList("Sleeps") ??
    fromGuestsBadge() ??
    fromDescriptionPattern(/sleeps\s*(\d+)/i);
  const beds =
    fromDetailsList("Bedrooms") ?? fromDescriptionPattern(/(\d+)\s*bedroom/i);
  const baths =
    fromDetailsList("Bathrooms") ??
    fromDescriptionPattern(/(\d+(?:\.\d+)?)\s*bath/i);

  return {
    beds,
    baths,
    sleeps,
  };
}

function extractImageUrlsFromListingRow(
  row: ThirtyABeachListingRow | null,
): string[] {
  if (!row) {
    return [];
  }
  return dedupePreserveOrder(row.imageUrls);
}

async function callStreamlineApi<T = unknown>(
  origin: string,
  methodName: string,
  params: Record<string, unknown>,
): Promise<T | null> {
  const url = `${origin}/wp-admin/admin-ajax.php?${new URLSearchParams({
    action: "streamlinecore-api-request",
    params: JSON.stringify({ methodName, params }),
  }).toString()}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "user-agent": USER_AGENT,
      accept: "application/json,text/plain,*/*",
    },
  });

  if (response.status !== 200) {
    return null;
  }

  const raw = await response.text();
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function mapListingRow(
  raw: Record<string, unknown>,
): ThirtyABeachListingRow | null {
  const idValue = raw.id;
  const idText =
    typeof idValue === "number" || typeof idValue === "string"
      ? (String(idValue).match(/\d+/)?.[0] ?? "")
      : "";
  if (!idText) {
    return null;
  }

  const seoFromPayload = String(raw.seo_page_name ?? "").trim();
  let seoPageName = seoFromPayload;

  if (!seoPageName) {
    const flyerUrl = String(raw.flyer_url ?? "").trim();
    if (flyerUrl) {
      try {
        const parsedFlyer = new URL(flyerUrl);
        seoPageName = normalizeSeoPath(parsedFlyer.pathname);
      } catch {
        // Ignore malformed flyer_url fallback values.
      }
    }
  }

  if (!seoPageName) {
    return null;
  }

  const gallery = raw.gallery;
  const imageUrls: string[] = [];

  if (gallery && typeof gallery === "object") {
    const galleryImage = (gallery as { image?: unknown }).image;
    if (Array.isArray(galleryImage)) {
      for (const item of galleryImage) {
        if (typeof item === "string" && item.trim()) {
          imageUrls.push(item.trim());
        } else if (item && typeof item === "object") {
          const maybeUrl = (item as { url?: unknown; image?: unknown }).url;
          if (typeof maybeUrl === "string" && maybeUrl.trim()) {
            imageUrls.push(maybeUrl.trim());
          }
          const maybeImage = (item as { image?: unknown }).image;
          if (typeof maybeImage === "string" && maybeImage.trim()) {
            imageUrls.push(maybeImage.trim());
          }
        }
      }
    } else if (typeof galleryImage === "string" && galleryImage.trim()) {
      imageUrls.push(galleryImage.trim());
    }
  }

  const latitude = parseNumberLike(raw.latitude);
  const longitude = parseNumberLike(raw.longitude);

  return {
    id: idText,
    seoPageName,
    name: stripHtml(String(raw.name ?? "")).slice(0, 240),
    description: stripHtml(
      String(raw.description ?? raw.short_description ?? ""),
    ),
    city: stripHtml(String(raw.city ?? "")).slice(0, 120),
    state: stripHtml(String(raw.state_name ?? "")).slice(0, 20),
    latitude,
    longitude,
    bedrooms: parseNumberLike(raw.bedrooms_number),
    bathrooms: parseNumberLike(raw.bathrooms_number),
    sleeps: parseNumberLike(raw.max_occupants),
    imageUrls: dedupePreserveOrder(imageUrls),
  };
}

async function loadListingRows(
  origin: string,
): Promise<ThirtyABeachListingRow[]> {
  const cacheKey = origin.toLowerCase();
  let pending = listingCache.get(cacheKey);
  if (!pending) {
    pending = (async () => {
      const allRows: ThirtyABeachListingRow[] = [];
      const seenIds = new Set<string>();

      for (let pageNumber = 1; pageNumber <= 8; pageNumber += 1) {
        const payload = await callStreamlineApi<{
          data?: { property?: unknown };
        }>(origin, "GetPropertyListWordPress", {
          sort_by: "random",
          return_gallery: 1,
          max_images_number: "5",
          use_room_type_logic: 0,
          get_prices_starting_from: 0,
          longterm_enabled: "0",
          additional_variables: 1,
          extra_charges: 1,
          use_amenities: "no",
          use_description: true,
          use_streamshare: 0,
          page_number: pageNumber,
          page_results_number: 200,
          skip_units: "",
        });

        const properties = payload?.data?.property;
        if (!Array.isArray(properties) || properties.length === 0) {
          break;
        }

        let addedThisPage = 0;
        for (const item of properties) {
          if (!item || typeof item !== "object") {
            continue;
          }

          const row = mapListingRow(item as Record<string, unknown>);
          if (!row || seenIds.has(row.id)) {
            continue;
          }

          seenIds.add(row.id);
          allRows.push(row);
          addedThisPage += 1;
        }

        if (addedThisPage === 0) {
          break;
        }
      }

      return allRows;
    })();
    listingCache.set(cacheKey, pending);
  }

  return pending;
}

function buildSeoMap(
  rows: ThirtyABeachListingRow[],
): Map<string, ThirtyABeachListingRow> {
  const out = new Map<string, ThirtyABeachListingRow>();
  for (const row of rows) {
    const key = normalizeSeoLookupKey(row.seoPageName);
    if (key && !out.has(key)) {
      out.set(key, row);
    }
  }
  return out;
}

async function discoverListingsFromApi(
  anchorUrl: string,
): Promise<ScrapedLink[]> {
  const parsed = new URL(anchorUrl);
  const origin = parsed.origin;
  const rows = await loadListingRows(origin);
  const links = rows
    .map((row): ScrapedLink | null => {
      const detailUrl = detailUrlFromSeoPath(origin, row.seoPageName);
      let pathname = "";
      try {
        pathname = new URL(detailUrl).pathname.toLowerCase();
      } catch {
        return null;
      }

      if (
        !pathname.startsWith("/rentals/") &&
        !pathname.startsWith("/vacation-rental/") &&
        !pathname.startsWith("/rental/")
      ) {
        return null;
      }
      return {
        link: normalizeLink(detailUrl),
        source_url: normalizeLink(anchorUrl),
        anchor_text: row.name,
      };
    })
    .filter((item): item is ScrapedLink => item !== null);

  return links;
}

async function collectCurrentUnitListLinks(
  page: Page,
  sourceUrl: string,
): Promise<ScrapedLink[]> {
  const rawRows = await page.evaluate(() => {
    const unitListRoot =
      document.querySelector(".unitList.listings_wrapper_box.row") ??
      document.querySelector(".unit-list.listings_wrapper_box.row") ??
      document.querySelector(".unit-list") ??
      document.querySelector('[class*="unit-list"]') ??
      document.querySelector(
        '[class*="unitList"][class*="listings_wrapper_box"][class*="row"]',
      ) ??
      document.querySelector('[id*="unit-list"]') ??
      document.body;

    const anchors = Array.from(unitListRoot.querySelectorAll("a[href]"));
    return anchors.map((anchor) => ({
      href: (anchor as HTMLAnchorElement).href,
      text: (anchor.textContent ?? "").trim(),
    }));
  });

  const links: ScrapedLink[] = [];
  const seen = new Set<string>();

  for (const row of rawRows) {
    const href = typeof row.href === "string" ? row.href : "";
    if (!href) {
      continue;
    }

    const valid = toValidDetailUrl(href);
    if (!valid || seen.has(valid)) {
      continue;
    }

    seen.add(valid);
    links.push({
      link: valid,
      source_url: normalizeLink(sourceUrl),
      anchor_text: typeof row.text === "string" ? row.text : "",
    });
  }

  return links;
}

async function scrollAndCollectListingLinks(
  page: Page,
  sourceUrl: string,
  maxScrollSteps: number,
  scrollPauseMs: number,
  networkIdleWaitMs: number,
  logger: ReturnType<typeof createDiscoveryLogger>,
): Promise<ScrapedLink[]> {
  let previousSignature = "";
  let stagnantSteps = 0;
  const collected = new Map<string, ScrapedLink>();

  const collectStepLinks = async (): Promise<void> => {
    const links = await collectCurrentUnitListLinks(page, sourceUrl);
    for (const link of links) {
      if (!collected.has(link.link)) {
        collected.set(link.link, link);
      }
    }
  };

  await collectStepLinks();

  for (let step = 0; step < maxScrollSteps; step += 1) {
    const loadMoreClicked = await page.evaluate(() => {
      const candidates = Array.from(
        document.querySelectorAll<HTMLButtonElement | HTMLAnchorElement>(
          "button, a",
        ),
      );

      for (const candidate of candidates) {
        const text = (candidate.textContent ?? "").trim().toLowerCase();
        if (!text.includes("load more")) {
          continue;
        }

        if (
          candidate instanceof HTMLButtonElement &&
          (candidate.disabled ||
            candidate.getAttribute("aria-disabled") === "true")
        ) {
          continue;
        }

        candidate.click();
        return true;
      }

      return false;
    });

    if (loadMoreClicked) {
      await page.waitForTimeout(Math.max(500, scrollPauseMs));
    }

    const signature = await page.evaluate(() => {
      const unitListRoot =
        document.querySelector(".unitList.listings_wrapper_box.row") ??
        document.querySelector(".unit-list.listings_wrapper_box.row") ??
        document.querySelector(".unit-list") ??
        document.querySelector('[class*="unit-list"]') ??
        document.querySelector(
          '[class*="unitList"][class*="listings_wrapper_box"][class*="row"]',
        ) ??
        document.querySelector('[id*="unit-list"]') ??
        document.body;

      const anchors = Array.from(unitListRoot.querySelectorAll("a[href]"));
      const listingCount = anchors.filter((anchor) => {
        const href =
          (anchor as HTMLAnchorElement).getAttribute("href")?.toLowerCase() ??
          "";
        return (
          href.includes("/rentals/") ||
          href.includes("/vacation-rental/") ||
          href.includes("/rental/")
        );
      }).length;

      return `${document.body.scrollHeight}:${listingCount}`;
    });

    if (signature === previousSignature && !loadMoreClicked) {
      stagnantSteps += 1;
      if (stagnantSteps >= 3) {
        const discovered = Number(signature.split(":")[1] ?? 0) || 0;
        logger.earlyStop({
          reason: "stagnant-signature",
          discovered,
          step: step + 1,
          maxSteps: maxScrollSteps,
          extras: {
            source: "dom",
          },
        });
        break;
      }
    } else {
      stagnantSteps = 0;
      previousSignature = signature;
    }

    await page.evaluate(() => {
      window.scrollBy(0, window.innerHeight * 1.4);
    });
    await page.waitForTimeout(scrollPauseMs);

    await collectStepLinks();

    const discovered = Number(signature.split(":")[1] ?? 0) || 0;
    logger.progress({
      stage: "scroll",
      discovered: Math.max(discovered, collected.size),
      step: step + 1,
      maxSteps: maxScrollSteps,
      noGrowthRounds: stagnantSteps,
      extras: {
        source: "dom",
        load_more_clicked: loadMoreClicked,
      },
    });
  }

  await page.waitForTimeout(networkIdleWaitMs);
  await collectStepLinks();
  return Array.from(collected.values());
}

async function discoverListingsFromPage(
  page: Page,
  anchorUrl: string,
  maxScrollSteps: number,
  scrollPauseMs: number,
  networkIdleWaitMs: number,
  logger: ReturnType<typeof createDiscoveryLogger>,
): Promise<ScrapedLink[]> {
  await page.goto(anchorUrl, {
    waitUntil: "domcontentloaded",
    timeout: 120000,
  });

  const fromAnchor = await scrollAndCollectListingLinks(
    page,
    anchorUrl,
    maxScrollSteps,
    scrollPauseMs,
    networkIdleWaitMs,
    logger,
  );

  if (fromAnchor.length > 0) {
    logger.progress({
      stage: "dom-anchor",
      discovered: fromAnchor.length,
      extras: {
        source: "dom",
        anchor_url: normalizeLink(anchorUrl),
      },
    });
    return fromAnchor;
  }

  const candidateSearchUrls = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll("a[href]"));
    const candidates: string[] = [];
    for (const anchor of anchors) {
      const href = (anchor as HTMLAnchorElement).href;
      if (!href) {
        continue;
      }

      const lower = href.toLowerCase();
      if (
        lower.includes("/search-results") ||
        lower.includes("vacation-rentals")
      ) {
        candidates.push(href);
      }
    }

    return Array.from(new Set(candidates));
  });

  for (const candidateUrl of candidateSearchUrls.slice(0, 3)) {
    try {
      await page.goto(candidateUrl, {
        waitUntil: "domcontentloaded",
        timeout: 120000,
      });

      const links = await scrollAndCollectListingLinks(
        page,
        candidateUrl,
        maxScrollSteps,
        scrollPauseMs,
        networkIdleWaitMs,
        logger,
      );

      if (links.length > 0) {
        logger.progress({
          stage: "dom-fallback",
          discovered: links.length,
          extras: {
            source: "dom",
            fallback_url: normalizeLink(candidateUrl),
          },
        });
        return links;
      }
    } catch {
      // Ignore candidate page navigation failures and continue.
    }
  }

  return [];
}

function mergeScrapedLinks(
  pageLinks: ScrapedLink[],
  apiLinks: ScrapedLink[],
): ScrapedLink[] {
  const merged: ScrapedLink[] = [];
  const seen = new Set<string>();

  // Keep Playwright-discovered unit-list links first, then add API-only extras.
  for (const link of [...pageLinks, ...apiLinks]) {
    const normalized = toValidDetailUrl(link.link);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    merged.push({
      link: normalized,
      source_url: normalizeLink(link.source_url),
      anchor_text: link.anchor_text,
    });
  }

  return merged.sort((left, right) => left.link.localeCompare(right.link));
}

function parseRateRows(payload: unknown): Array<Record<string, unknown>> {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const data = (payload as { data?: unknown }).data;
  if (!data || typeof data !== "object") {
    return [];
  }

  const rates = (data as { rates?: unknown }).rates;
  if (Array.isArray(rates)) {
    return rates.filter(
      (row): row is Record<string, unknown> =>
        row !== null && typeof row === "object",
    );
  }

  if (rates && typeof rates === "object") {
    return Object.values(rates).filter(
      (row): row is Record<string, unknown> =>
        row !== null && typeof row === "object",
    );
  }

  return [];
}

function expandRateDays(
  rateRows: Array<Record<string, unknown>>,
  availabilityByDate: Map<string, ThirtyABeachDayCode>,
): Array<{
  date: string;
  nightly_rate: number | null;
  min_nights: number | null;
  is_booked: boolean | null;
  changeover_code: string;
  season_name: string;
}> {
  const out: Array<{
    date: string;
    nightly_rate: number | null;
    min_nights: number | null;
    is_booked: boolean | null;
    changeover_code: string;
    season_name: string;
  }> = [];

  for (const row of rateRows) {
    const startIso = normalizeDateLikeToIso(row.period_begin);
    const endIso = normalizeDateLikeToIso(row.period_end);
    if (!startIso || !endIso) {
      continue;
    }

    const start = new Date(`${startIso}T00:00:00.000Z`);
    const end = new Date(`${endIso}T00:00:00.000Z`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      continue;
    }

    const nightlyRate = parseCurrencyLike(row.daily_first_interval_price);
    const minNights = parseNumberLike(row.narrow_defined_days);
    const seasonName = stripHtml(
      String(row.season_name ?? row.period_name ?? ""),
    ).slice(0, 160);

    for (
      let cursor = new Date(start);
      cursor.getTime() <= end.getTime();
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    ) {
      const date = formatDateIso(cursor);
      const availabilityCode = availabilityByDate.get(date);

      out.push({
        date,
        nightly_rate: nightlyRate,
        min_nights: minNights,
        is_booked:
          availabilityCode === "Y"
            ? false
            : availabilityCode === "N"
              ? true
              : null,
        changeover_code: availabilityCode ?? "",
        season_name: seasonName,
      });
    }
  }

  const dedupedByDate = new Map<
    string,
    {
      date: string;
      nightly_rate: number | null;
      min_nights: number | null;
      is_booked: boolean | null;
      changeover_code: string;
      season_name: string;
    }
  >();

  for (const row of out) {
    dedupedByDate.set(row.date, row);
  }

  return Array.from(dedupedByDate.values()).sort((left, right) =>
    left.date.localeCompare(right.date),
  );
}

async function fetchDetail(
  detailUrl: string,
  availabilityHorizonDays: number,
): Promise<ThirtyABeachDetailRecord | null> {
  try {
    const parsedDetail = new URL(detailUrl);
    const origin = parsedDetail.origin;
    const seoPath = normalizeSeoLookupKey(
      extractSeoPathFromDetailUrl(detailUrl),
    );

    const listingRows = await loadListingRows(origin);
    const seoMap = buildSeoMap(listingRows);
    let listingRow = seoMap.get(seoPath) ?? null;

    const resolvedDetailUrl = listingRow
      ? detailUrlFromSeoPath(origin, listingRow.seoPageName)
      : detailUrl;

    let detailResponse = await fetch(resolvedDetailUrl, {
      method: "GET",
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml",
      },
    });

    if (detailResponse.status === 404 && !listingRow) {
      const sanitizedPath = parsedDetail.pathname.replace(/'/g, "");
      const fallbackUrl = `${origin}${sanitizedPath}`;
      detailResponse = await fetch(fallbackUrl, {
        method: "GET",
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml",
        },
      });

      if (detailResponse.status === 200) {
        const fallbackSeoPath = normalizeSeoLookupKey(
          extractSeoPathFromDetailUrl(fallbackUrl),
        );
        listingRow = seoMap.get(fallbackSeoPath) ?? listingRow;
      }
    }

    if (detailResponse.status !== 200) {
      return null;
    }

    const html = await detailResponse.text();

    const extractedUnitId = extractUnitIdFromHtml(html);
    if (!listingRow && extractedUnitId) {
      listingRow =
        listingRows.find((row) => row.id === extractedUnitId) ?? null;
    }

    const rentalId = listingRow?.id ?? extractedUnitId ?? "";
    if (!rentalId) {
      return null;
    }

    const canonicalUrl =
      extractFirst(
        /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i,
        html,
      ) || normalizeLink(detailUrl);
    const title = extractFirst(/<title[^>]*>([\s\S]*?)<\/title>/i, html);
    const h1 = extractFirst(/<h1[^>]*>([\s\S]*?)<\/h1>/i, html);
    const metaDescription = extractFirst(
      /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i,
      html,
    );

    const descriptionExpanded = extractFirst(
      /<div[^>]+class=["'][^"']*property_description[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
      html,
    );

    const amenitiesCategories = extractAmenityCategoriesFromHtml(html);
    const amenitiesAll = dedupePreserveOrder(
      Object.values(amenitiesCategories).flat(),
    );
    const roomDetailsStats = extractRoomDetailsStats(html);

    const latitudeFromHtml = parseNumberLike(
      html.match(/["']latitude["']\s*:\s*(-?\d+(?:\.\d+)?)/i)?.[1],
    );
    const longitudeFromHtml = parseNumberLike(
      html.match(/["']longitude["']\s*:\s*(-?\d+(?:\.\d+)?)/i)?.[1],
    );
    const latitude = listingRow?.latitude ?? latitudeFromHtml ?? null;
    const longitude = listingRow?.longitude ?? longitudeFromHtml ?? null;

    const jsonLdAddress = extractJsonLdAddress(html);
    const fullAddress = jsonLdAddress.address;
    const directionsDaddr = fullAddress;
    const directionsUrl = directionsDaddr
      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(directionsDaddr)}`
      : "";

    const htmlPath = resolve(OUTPUT_DETAILS_HTML_DIR, `${rentalId}.html`);
    await writeFile(htmlPath, `${html}\n`, "utf8");

    const availabilityPayload = await callStreamlineApi<{
      data?: {
        range?: { beginDate?: string; endDate?: string };
        availability?: string;
      };
    }>(origin, "GetPropertyAvailabilityRawData", {
      unit_id: Number(rentalId),
      use_room_type_logic: "no",
      standard_pricing: 1,
    });

    const rawBeginDate = availabilityPayload?.data?.range?.beginDate ?? "";
    const rawEndDate = availabilityPayload?.data?.range?.endDate ?? "";
    const rawAvailabilityCodes = availabilityPayload?.data?.availability ?? "";

    const allAvailabilityDays = decodeAvailabilityDays(
      rawBeginDate,
      rawAvailabilityCodes,
    );

    const now = new Date();
    const today = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const horizonDate = new Date(today);
    horizonDate.setUTCDate(horizonDate.getUTCDate() + availabilityHorizonDays);

    const filteredDays = allAvailabilityDays.filter((day) => {
      const dayDate = new Date(`${day.date}T00:00:00.000Z`);
      return dayDate >= today && dayDate <= horizonDate;
    });

    const availabilityDays = [...filteredDays];
    if (availabilityDays.length > 0) {
      const lastKnown = new Date(
        `${availabilityDays[availabilityDays.length - 1]?.date}T00:00:00.000Z`,
      );
      const cursor = new Date(lastKnown);
      cursor.setUTCDate(cursor.getUTCDate() + 1);

      while (cursor <= horizonDate) {
        availabilityDays.push({
          date: formatDateIso(cursor),
          code: "X",
        });
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
    } else {
      const cursor = new Date(today);
      while (cursor <= horizonDate) {
        availabilityDays.push({
          date: formatDateIso(cursor),
          code: "X",
        });
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
    }

    const availabilityByDate = new Map<string, ThirtyABeachDayCode>();
    for (const day of availabilityDays) {
      availabilityByDate.set(day.date, day.code);
    }

    const ratesStartIso = filteredDays[0]?.date ?? formatDateIso(today);
    const ratesEndIso =
      filteredDays[filteredDays.length - 1]?.date ?? formatDateIso(horizonDate);
    const ratesStartDateUs = formatDateUsFromIso(ratesStartIso);
    const ratesEndDateUs = formatDateUsFromIso(ratesEndIso);

    const ratesPayload =
      ratesStartDateUs && ratesEndDateUs
        ? await callStreamlineApi(origin, "GetPropertyRatesRawData", {
            unit_id: Number(rentalId),
            use_yielding_with_dates: "yes",
            startdate: ratesStartDateUs,
            enddate: ratesEndDateUs,
          })
        : null;

    const ratesRowsRaw = parseRateRows(ratesPayload);
    const normalizedRateDays = expandRateDays(ratesRowsRaw, availabilityByDate);

    const rateValues = normalizedRateDays
      .map((row) => row.nightly_rate)
      .filter((value): value is number => Number.isFinite(value));
    const minRate = rateValues.length > 0 ? Math.min(...rateValues) : null;
    const maxRate = rateValues.length > 0 ? Math.max(...rateValues) : null;
    const avgRate =
      rateValues.length > 0
        ? Number(
            (
              rateValues.reduce((sum, value) => sum + value, 0) /
              rateValues.length
            ).toFixed(2),
          )
        : null;

    const normalizedDays = availabilityDays.map((day) => {
      const bookingDayState: "bookable" | "blocked" | "unknown" =
        day.code === "Y"
          ? "bookable"
          : day.code === "N"
            ? "blocked"
            : "unknown";

      const rateForDay = normalizedRateDays.find(
        (rate) => rate.date === day.date,
      );

      return {
        date: day.date,
        is_available: day.code === "Y",
        status_code: day.code,
        is_available_for_checkin: day.code === "Y",
        is_available_for_checkout: day.code === "Y",
        booking_day_state: bookingDayState,
        min_nights_required: rateForDay?.min_nights ?? null,
      };
    });

    const available = normalizedDays.filter(
      (day) => day.status_code === "Y",
    ).length;
    const notAvailable = normalizedDays.filter(
      (day) => day.status_code === "N",
    ).length;
    const other = normalizedDays.length - available - notAvailable;

    const description =
      descriptionExpanded || listingRow?.description || metaDescription;
    const name = stripHtml(h1 || title || listingRow?.name || "").slice(0, 240);
    const descriptionNormalized = normalizeForMatch(description);
    const titleNormalized = normalizeForMatch(name);

    const mediaImageUrls = dedupePreserveOrder([
      ...extractImageUrlsFromListingRow(listingRow),
      ...Array.from(
        html.matchAll(
          /https?:\/\/[^"'\s>]+(?:gallery\.streamlinevrs\.com|streamlinevrs\.com)[^"'\s>]*/gi,
        ),
      ).map((match) => match[0] ?? ""),
    ]);

    return {
      external_listing_id: rentalId,
      detail_url: normalizeLink(detailUrl),
      fetched_at: new Date().toISOString(),
      title,
      h1,
      canonical_url: canonicalUrl,
      meta_description: metaDescription,
      description_expanded: description,
      amenities: {
        categories: amenitiesCategories,
        all: amenitiesAll,
      },
      location: {
        address: fullAddress,
        location_label: [
          listingRow?.city ?? jsonLdAddress.city,
          listingRow?.state ?? jsonLdAddress.state,
        ]
          .filter((part) => part.length > 0)
          .join(", "),
        directions_url: directionsUrl,
        directions_daddr: directionsDaddr,
        latitude:
          latitude !== null && Number.isFinite(latitude) ? latitude : null,
        longitude:
          longitude !== null && Number.isFinite(longitude) ? longitude : null,
      },
      media_gallery: {
        image_count: mediaImageUrls.length,
        image_urls: mediaImageUrls,
      },
      property_profile: {
        unit_id: rentalId,
        area: listingRow?.city ?? "",
        location: [listingRow?.city ?? "", listingRow?.state ?? ""]
          .filter((part) => part.length > 0)
          .join(", "),
        beds: listingRow?.bedrooms ?? roomDetailsStats.beds ?? null,
        baths: listingRow?.bathrooms ?? roomDetailsStats.baths ?? null,
        sleeps: listingRow?.sleeps ?? roomDetailsStats.sleeps ?? null,
        city: listingRow?.city ?? "",
        state: listingRow?.state ?? "",
      },
      normalized_matching_profile: {
        source: "pm_30abeach",
        external_listing_id: rentalId,
        name,
        description,
        match_signals: {
          description_normalized: descriptionNormalized,
          description_sha256: hashSha256(descriptionNormalized),
          title_normalized: titleNormalized,
          title_sha256: hashSha256(titleNormalized),
          listing_composite_key: [
            "pm_30abeach",
            rentalId,
            hashSha256(descriptionNormalized),
            hashSha256(titleNormalized),
          ].join("::"),
        },
      },
      normalized_availability: {
        source: "pm_30abeach",
        external_listing_id: rentalId,
        captured_at: new Date().toISOString(),
        window_start: availabilityDays[0]?.date ?? "",
        window_end: availabilityDays[availabilityDays.length - 1]?.date ?? "",
        code_legend: {
          Y: "available",
          N: "not_available",
          X: "other",
        },
        day_codes: availabilityDays.map((day) => day.code).join(""),
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
        begin_date: rawBeginDate,
        end_date: rawEndDate,
        day_codes: rawAvailabilityCodes,
      },
      normalized_rates: {
        source: "pm_30abeach",
        external_listing_id: rentalId,
        captured_at: new Date().toISOString(),
        currency: "USD",
        window_start: normalizedRateDays[0]?.date ?? "",
        window_end:
          normalizedRateDays[normalizedRateDays.length - 1]?.date ?? "",
        days: normalizedRateDays,
        stats: {
          days_with_rate: rateValues.length,
          min_nightly_rate: minRate,
          max_nightly_rate: maxRate,
          avg_nightly_rate: avgRate,
        },
      },
      rates_raw: {
        request_start_date: ratesStartDateUs,
        request_end_date: ratesEndDateUs,
        rows: ratesRowsRaw,
      },
      pricing_api_hints: {
        provider: "streamlinecore-api-request",
        endpoint_path: "/wp-admin/admin-ajax.php",
        method_names: {
          availability: "GetPropertyAvailabilityRawData",
          rates: "GetPropertyRatesRawData",
          pre_reservation_price: "GetPreReservationPrice",
        },
        notes:
          "GetPreReservationPrice appears available on this Streamline-backed adapter for ad-hoc full quote requests (date/guest/stay inputs); schema and required params vary by manager and should be probed separately.",
      },
      html_path: htmlPath,
    };
  } catch {
    return null;
  }
}

export function create30ABeachAdapter(): ScraperAdapter<ThirtyABeachDetailRecord> {
  const runtime = resolveAdapterRuntime({
    managerKey: "30abeach",
    defaults: {
      detailFetchDelayMs: 250,
      detailFetchConcurrency: 6,
      availabilityHorizonDays: 730,
      maxCalendarAdvanceMonths: 24,
    },
    aliases: {
      DETAIL_FETCH_DELAY_MS: ["THIRTYABEACH_DETAIL_FETCH_DELAY_MS"],
      DETAIL_FETCH_CONCURRENCY: ["THIRTYABEACH_FETCH_CONCURRENCY"],
      AVAILABILITY_HORIZON_DAYS: ["THIRTYABEACH_AVAILABILITY_HORIZON_DAYS"],
      MAX_CALENDAR_ADVANCE_MONTHS: ["THIRTYABEACH_CALENDAR_MAX_MONTHS"],
    },
  });

  return {
    managerKey: "30abeach",
    scriptLabel: "30abeach",
    defaultAnchorUrl: DEFAULT_ANCHOR_URL,
    detailFetchDelayMs: runtime.detailFetchDelayMs,
    detailFetchConcurrency: runtime.detailFetchConcurrency,
    availabilityHorizonDays: runtime.availabilityHorizonDays,
    maxCalendarAdvanceMonths: runtime.maxCalendarAdvanceMonths,
    isValidDetailUrl(value: string): string | null {
      try {
        const parsed = new URL(value.trim());
        if (!parsed.hostname.endsWith("30abeachproperties.com")) {
          return null;
        }

        if (!isDetailPath(parsed.pathname)) {
          return null;
        }

        const normalized = `${parsed.origin}${parsed.pathname}`;
        return normalizeLink(normalized);
      } catch {
        return null;
      }
    },
    async discoverListings(context) {
      const logger = createDiscoveryLogger(context.reportProgress);
      const pageLinks = await discoverListingsFromPage(
        context.page,
        context.anchorUrl,
        context.maxScrollSteps,
        context.scrollPauseMs,
        context.networkIdleWaitMs,
        logger,
      );
      const apiLinks = await discoverListingsFromApi(context.anchorUrl);

      logger.expected({
        source: "api",
        expected: apiLinks.length,
        initialDiscovered: pageLinks.length,
      });

      const merged = mergeScrapedLinks(pageLinks, apiLinks);
      logger.summary({
        selected: merged.length,
        expected: apiLinks.length > 0 ? apiLinks.length : null,
        bySource: {
          dom: pageLinks.length,
          api: apiLinks.length,
        },
      });
      return merged;
    },
    async fetchDetail(context) {
      void context.browser;
      void context.maxCalendarAdvanceMonths;
      return fetchDetail(context.detailUrl, context.availabilityHorizonDays);
    },
    async runQuoteCapture(argv, progress) {
      const normalizedArgs = await normalizeAdapterQuoteScopeArgs(
        "30abeach",
        argv,
      );
      await runThirtyABeachQuoteCli(normalizedArgs, progress);
    },
  };
}
