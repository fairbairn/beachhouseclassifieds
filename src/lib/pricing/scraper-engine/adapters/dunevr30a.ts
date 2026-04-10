import { executeDunevr30aSingleQuote } from "@/lib/pricing/quote-runtime/adapters/dunevr30a";
import { runRuntimeAdapterQuoteCli } from "@/lib/pricing/quotes/shared/runtime-adapter-quote-runner";
import { canonicalizeExternalListingId } from "@/lib/pricing/shared/external-listing-id";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Page } from "playwright";

import { normalizeAdapterQuoteScopeArgs } from "../quote-scope";
import type { DetailRecordBase, ScrapedLink, ScraperAdapter } from "../types";

type DuneListingRow = {
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

type DuneDayCode = "Y" | "N" | "X";

type DuneDetailRecord = DetailRecordBase & {
  quote_context: {
    listing_id: string;
    detail_url: string;
  };
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
    source: "pm_dunevr30a";
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
    source: "pm_dunevr30a";
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
      status_code: DuneDayCode;
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
    source: "pm_dunevr30a";
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
  "https://dunevacationrentals.com/search-results/?beds=&sort_by=random";
const OUTPUT_ROOT = resolve(
  process.cwd(),
  "src",
  "lib",
  "data",
  "external-sources",
  "dunevr30a",
);
const OUTPUT_DETAILS_HTML_DIR = resolve(OUTPUT_ROOT, "details", "html");
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const listingCache = new Map<string, Promise<DuneListingRow[]>>();

function normalizeLink(url: string): string {
  return url.split("#")[0]?.replace(/\/$/, "") ?? url;
}

function toValidDetailUrl(value: string): string | null {
  try {
    const parsed = new URL(value.trim());
    if (!parsed.hostname.endsWith("dunevacationrentals.com")) {
      return null;
    }

    const normalizedPath = parsed.pathname.toLowerCase();
    if (
      !normalizedPath.startsWith("/rentals/") &&
      !normalizedPath.startsWith("/vacation-rental/") &&
      !normalizedPath.startsWith("/rental/")
    ) {
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
): Array<{ date: string; code: DuneDayCode }> {
  const beginDate = parseUsDateToUtc(beginDateRaw);
  if (!beginDate) {
    return [];
  }

  const days: Array<{ date: string; code: DuneDayCode }> = [];
  for (let index = 0; index < availabilityRaw.length; index += 1) {
    const current = new Date(beginDate);
    current.setUTCDate(beginDate.getUTCDate() + index);
    const rawCode = availabilityRaw[index] ?? "";
    const code: DuneDayCode =
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
  return canonicalizeExternalListingId(normalizeSeoPath(value));
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

function extractExternalListingSlug(value: string): string {
  return canonicalizeExternalListingId(value);
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

  const homeHighlightsAnchor = descriptionChunk.match(
    /Home\s*Highlights\s*:\s*([\s\S]*)/i,
  );
  const homeHighlightsChunk = homeHighlightsAnchor?.[1] ?? "";

  const homeHighlights = homeHighlightsChunk
    .split(/\n+/)
    .map((line) => line.replace(/^[-*•]\s*/, "").trim())
    .filter((line) => line.length > 0)
    .filter((line) => !/^reservation\/booking policy/i.test(line))
    .slice(0, 120);

  if (homeHighlights.length > 0) {
    categoryValues.HomeHighlights = dedupePreserveOrder(homeHighlights);
  }

  return categoryValues;
}

function extractImageUrlsFromListingRow(row: DuneListingRow | null): string[] {
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

function mapListingRow(raw: Record<string, unknown>): DuneListingRow | null {
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

async function loadListingRows(origin: string): Promise<DuneListingRow[]> {
  const cacheKey = origin.toLowerCase();
  let pending = listingCache.get(cacheKey);
  if (!pending) {
    pending = (async () => {
      const allRows: DuneListingRow[] = [];
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

function buildSeoMap(rows: DuneListingRow[]): Map<string, DuneListingRow> {
  const out = new Map<string, DuneListingRow>();
  for (const row of rows) {
    const key = normalizeSeoLookupKey(row.seoPageName);
    if (key && !out.has(key)) {
      out.set(key, row);
    }
  }
  return out;
}

async function discoverListings(
  anchorUrl: string,
  reportProgress: (message: string) => void,
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

  reportProgress(`discovered ${links.length} links from Streamline API`);
  return links;
}

async function scrollAndCollectListingLinks(
  page: Page,
  sourceUrl: string,
  maxScrollSteps: number,
  scrollPauseMs: number,
  networkIdleWaitMs: number,
  reportProgress: (message: string) => void,
): Promise<ScrapedLink[]> {
  let previousSignature = "";
  let stagnantSteps = 0;

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

    if ((step + 1) % 10 === 0) {
      reportProgress(`scroll steps completed: ${step + 1}`);
    }
  }

  await page.waitForTimeout(networkIdleWaitMs);

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

async function discoverListingsFromPage(
  page: Page,
  anchorUrl: string,
  maxScrollSteps: number,
  scrollPauseMs: number,
  networkIdleWaitMs: number,
  reportProgress: (message: string) => void,
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
    reportProgress,
  );

  if (fromAnchor.length > 0) {
    reportProgress(`discovered ${fromAnchor.length} links from page DOM`);
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
        reportProgress,
      );

      if (links.length > 0) {
        reportProgress(
          `discovered ${links.length} links from fallback page ${normalizeLink(candidateUrl)}`,
        );
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
  if (apiLinks.length > 0) {
    // Streamline API is the authoritative inventory when available.
    const authoritative: ScrapedLink[] = [];
    const seen = new Set<string>();
    for (const link of apiLinks) {
      const normalized = toValidDetailUrl(link.link);
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      authoritative.push({
        link: normalized,
        source_url: normalizeLink(link.source_url),
        anchor_text: link.anchor_text,
      });
    }

    return authoritative.sort((left, right) =>
      left.link.localeCompare(right.link),
    );
  }

  const merged: ScrapedLink[] = [];
  const seen = new Set<string>();

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
  availabilityByDate: Map<string, DuneDayCode>,
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
): Promise<DuneDetailRecord | null> {
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

    const latitudeFromHtml = parseNumberLike(
      html.match(/["']latitude["']\s*:\s*(-?\d+(?:\.\d+)?)/i)?.[1],
    );
    const longitudeFromHtml = parseNumberLike(
      html.match(/["']longitude["']\s*:\s*(-?\d+(?:\.\d+)?)/i)?.[1],
    );
    const latitude = listingRow?.latitude ?? latitudeFromHtml ?? null;
    const longitude = listingRow?.longitude ?? longitudeFromHtml ?? null;

    const firstAddressLine =
      descriptionExpanded
        .split("\n")
        .map((line) => line.trim())
        .find((line) => /\d/.test(line)) ?? "";
    const cityStateZipLine =
      descriptionExpanded
        .split("\n")
        .map((line) => line.trim())
        .find((line) => /,\s*[A-Z]{2}\s+\d{5}/.test(line)) ?? "";
    const fullAddress = [firstAddressLine, cityStateZipLine]
      .filter((value) => value.length > 0)
      .join(", ");
    const directionsDaddr = fullAddress;
    const directionsUrl = directionsDaddr
      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(directionsDaddr)}`
      : "";

    const externalListingId =
      extractExternalListingSlug(
        listingRow?.seoPageName ??
          extractSeoPathFromDetailUrl(resolvedDetailUrl),
      ) || rentalId;

    const normalizedDetailUrl = normalizeLink(resolvedDetailUrl);
    const htmlPath = resolve(
      OUTPUT_DETAILS_HTML_DIR,
      `${externalListingId}.html`,
    );
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

    const availabilityByDate = new Map<string, DuneDayCode>();
    for (const day of filteredDays) {
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

    const normalizedDays = filteredDays.map((day) => {
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
      external_listing_id: externalListingId,
      detail_url: normalizedDetailUrl,
      fetched_at: new Date().toISOString(),
      quote_context: {
        listing_id: rentalId,
        detail_url: normalizedDetailUrl,
      },
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
        location_label: [listingRow?.city ?? "", listingRow?.state ?? ""]
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
        beds: listingRow?.bedrooms ?? null,
        baths: listingRow?.bathrooms ?? null,
        sleeps: listingRow?.sleeps ?? null,
        city: listingRow?.city ?? "",
        state: listingRow?.state ?? "",
      },
      normalized_matching_profile: {
        source: "pm_dunevr30a",
        external_listing_id: externalListingId,
        name,
        description,
        match_signals: {
          description_normalized: descriptionNormalized,
          description_sha256: hashSha256(descriptionNormalized),
          title_normalized: titleNormalized,
          title_sha256: hashSha256(titleNormalized),
          listing_composite_key: [
            "pm_dunevr30a",
            externalListingId,
            hashSha256(descriptionNormalized),
            hashSha256(titleNormalized),
          ].join("::"),
        },
      },
      normalized_availability: {
        source: "pm_dunevr30a",
        external_listing_id: externalListingId,
        captured_at: new Date().toISOString(),
        window_start: filteredDays[0]?.date ?? "",
        window_end: filteredDays[filteredDays.length - 1]?.date ?? "",
        code_legend: {
          Y: "available",
          N: "not_available",
          X: "other",
        },
        day_codes: filteredDays.map((day) => day.code).join(""),
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
        source: "pm_dunevr30a",
        external_listing_id: externalListingId,
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

export function createDuneVR30AAdapter(): ScraperAdapter<DuneDetailRecord> {
  return {
    managerKey: "dunevr30a",
    scriptLabel: "dunevr30a",
    defaultAnchorUrl: DEFAULT_ANCHOR_URL,
    detailFetchDelayMs: Math.max(
      0,
      Number(process.env.DUNEVR30A_DETAIL_FETCH_DELAY_MS ?? "250") || 250,
    ),
    detailFetchConcurrency: Math.max(
      1,
      Number(process.env.DUNEVR30A_FETCH_CONCURRENCY ?? "6") || 6,
    ),
    availabilityHorizonDays: Math.max(
      1,
      Number(process.env.DUNEVR30A_AVAILABILITY_HORIZON_DAYS ?? "730") || 730,
    ),
    maxCalendarAdvanceMonths: 24,
    isValidDetailUrl(value: string): string | null {
      try {
        const parsed = new URL(value.trim());
        if (!parsed.hostname.endsWith("dunevacationrentals.com")) {
          return null;
        }

        const normalizedPath = parsed.pathname.toLowerCase();
        if (
          !normalizedPath.startsWith("/rentals/") &&
          !normalizedPath.startsWith("/vacation-rental/") &&
          !normalizedPath.startsWith("/rental/")
        ) {
          return null;
        }

        const normalized = `${parsed.origin}${parsed.pathname}`;
        return normalizeLink(normalized);
      } catch {
        return null;
      }
    },
    async discoverListings(context) {
      const pageLinks = await discoverListingsFromPage(
        context.page,
        context.anchorUrl,
        context.maxScrollSteps,
        context.scrollPauseMs,
        context.networkIdleWaitMs,
        context.reportProgress,
      );
      const apiLinks = await discoverListings(
        context.anchorUrl,
        context.reportProgress,
      );

      const merged = mergeScrapedLinks(pageLinks, apiLinks);
      context.reportProgress(
        `discovery summary: page=${pageLinks.length}, api=${apiLinks.length}, merged=${merged.length}`,
      );
      return merged;
    },
    async fetchDetail(context) {
      void context.browser;
      void context.maxCalendarAdvanceMonths;
      return fetchDetail(context.detailUrl, context.availabilityHorizonDays);
    },
    async runQuoteCapture(argv, progress) {
      const normalizedArgs = await normalizeAdapterQuoteScopeArgs(
        "dunevr30a",
        argv,
      );
      await runRuntimeAdapterQuoteCli(
        {
          adapterKey: "dunevr30a",
          executeSingleQuote: executeDunevr30aSingleQuote,
          defaultQuoteTimeoutMs: 20000,
          defaultQuoteMaxAttempts: 2,
          defaultEndpointPath: "/wp-admin/admin-ajax.php",
          defaultTaxPct: 0.12,
          defaultBaseNightly: 700,
        },
        normalizedArgs,
        progress,
      );
    },
    async runSingleQuoteObservation(input) {
      const result = await executeDunevr30aSingleQuote({
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
