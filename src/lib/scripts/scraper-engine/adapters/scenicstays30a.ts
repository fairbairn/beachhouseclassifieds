import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { DetailRecordBase, ScrapedLink, ScraperAdapter } from "../types";

type ScenicStaysDetailRecord = DetailRecordBase & {
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
    city: string;
    state: string;
    postal_code: string;
    country: string;
    latitude: number | null;
    longitude: number | null;
  };
  media_gallery: {
    image_count: number;
    image_urls: string[];
  };
  property_profile: {
    unit_id: string;
    property_code: string;
    beds: number | null;
    baths: number | null;
    sleeps: number | null;
    city: string;
    state: string;
    zip: string;
  };
  normalized_matching_profile: {
    source: "pm_scenicstays30a";
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
    source: "pm_scenicstays30a";
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
      is_available: boolean;
      status_code: string;
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
    begin_date: string;
    end_date: string;
    day_codes: string;
  };
  normalized_rates: {
    source: "pm_scenicstays30a";
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
};

const DEFAULT_ANCHOR_URL =
  "https://myscenicstays.com/30a-vacation-rentals";
const OUTPUT_ROOT = resolve(
  process.cwd(),
  "src",
  "lib",
  "data",
  "external-sources",
  "scenicstays30a",
);
const OUTPUT_DETAILS_HTML_DIR = resolve(OUTPUT_ROOT, "details", "html");

const MAX_CLICK_CYCLES = 24;
const CLICK_WAIT_MS = 1200;
const GROWTH_POLL_ROUNDS = 10;

function normalizeLink(url: string): string {
  return url.split("#")[0]?.replace(/\/$/, "") ?? url;
}

function extractFirst(regex: RegExp, value: string): string {
  const match = value.match(regex);
  if (!match?.[1]) {
    return "";
  }
  return stripHtml(match[1]).trim();
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

function parseNumberLike(
  value: string | number | null | undefined,
): number | null {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return null;
  }
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return numeric;
}

function toAbsoluteHttpUrl(value: string, baseUrl: string): string | null {
  const raw = value.trim();
  if (!raw) {
    return null;
  }
  try {
    return new URL(raw, baseUrl).toString();
  } catch {
    return null;
  }
}

function extractSectionBetween(
  html: string,
  startMarker: string,
  endMarker: string,
): string {
  const start = html.indexOf(startMarker);
  if (start < 0) {
    return "";
  }
  const end = html.indexOf(endMarker, start + startMarker.length);
  if (end < 0) {
    return "";
  }
  return html.slice(start, end);
}

function extractJsonLdObjects(html: string): Array<Record<string, unknown>> {
  const scripts = html.match(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi,
  );
  if (!scripts?.length) {
    return [];
  }

  const objects: Array<Record<string, unknown>> = [];
  for (const script of scripts) {
    const jsonText = script
      .replace(/<script[^>]*>/i, "")
      .replace(/<\/script>\s*$/i, "")
      .trim();

    if (!jsonText) {
      continue;
    }

    try {
      const parsed = JSON.parse(jsonText) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item === "object") {
            objects.push(item as Record<string, unknown>);
          }
        }
      } else if (parsed && typeof parsed === "object") {
        objects.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Ignore malformed JSON-LD blocks.
    }
  }

  return objects;
}

function collectMediaUrls(
  html: string,
  baseUrl: string,
  jsonLdObjects: Array<Record<string, unknown>>,
): string[] {
  const urls = new Set<string>();

  for (const object of jsonLdObjects) {
    const image = object.image;
    if (typeof image === "string") {
      const absolute = toAbsoluteHttpUrl(image, baseUrl);
      if (absolute) {
        urls.add(absolute);
      }
    }
    if (Array.isArray(image)) {
      for (const entry of image) {
        if (typeof entry !== "string") {
          continue;
        }
        const absolute = toAbsoluteHttpUrl(entry, baseUrl);
        if (absolute) {
          urls.add(absolute);
        }
      }
    }
  }

  const attrMatches = html.matchAll(
    /(?:data-lazy|data-src|src|content)=["']([^"']+)["']/gi,
  );
  for (const match of attrMatches) {
    const raw = (match[1] ?? "").trim();
    if (!raw) {
      continue;
    }
    const absolute = toAbsoluteHttpUrl(raw, baseUrl);
    if (!absolute) {
      continue;
    }
    if (
      absolute.includes("gallery.streamlinevrs.com") ||
      absolute.includes("streamlinevrs.com") ||
      absolute.includes("myscenicstays.com/wp-content") ||
      absolute.includes("myscenicstays.icnd-cdn.com") ||
      absolute.includes("assets.guesty.com")
    ) {
      urls.add(absolute);
    }
  }

  return Array.from(urls);
}

function extractIdsFromPropertyListPayload(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const data = (parsed as { data?: unknown })?.data;
  if (!data || typeof data !== "object") {
    return [];
  }

  const properties = (data as { property?: unknown })?.property;
  if (!Array.isArray(properties)) {
    return [];
  }

  const ids: string[] = [];
  for (const property of properties) {
    if (!property || typeof property !== "object") {
      continue;
    }

    const idValue = (property as { id?: unknown }).id;
    if (typeof idValue === "number" || typeof idValue === "string") {
      const id = String(idValue).match(/\d+/)?.[0];
      if (id) {
        ids.push(id);
      }
    }
  }

  return ids;
}

function canonicalStayUrlFromId(id: string): string {
  return `https://myscenicstays.com/${id}/`;
}

function extractRentalIdFromDetailUrl(detailUrl: string): string | null {
  try {
    const parsed = new URL(detailUrl);
    if (!parsed.hostname.endsWith("myscenicstays.com")) {
      return null;
    }

    const parts = parsed.pathname.split("/").filter(Boolean);
    const fromPath = parts[0]?.match(/\d+/)?.[0] ?? null;
    return fromPath;
  } catch {
    return null;
  }
}

function extractRentalSlugFromDetailUrl(detailUrl: string): string {
  try {
    const parsed = new URL(detailUrl);
    if (!parsed.hostname.endsWith("myscenicstays.com")) {
      return "";
    }

    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length >= 2 && parts[0] === "rentals") {
      return parts[1] ?? "";
    }

    return "";
  } catch {
    return "";
  }
}

function extractWidgetUnitId(html: string): string {
  const unitCodeMatch = html.match(
    /class=["'][^"']*be-property-widget[^"']*["'][^>]*\sdata-unitcode=["']([^"']+)["']/i,
  );
  const unitCode = (unitCodeMatch?.[1] ?? "").trim();
  if (/^\d+$/.test(unitCode)) {
    return unitCode;
  }

  const mapMarkerMatch = html.match(
    /class=["'][^"']*be-property-widget[^"']*["'][^>]*\sdata-mapmarkerid=["']([^"']+)["']/i,
  );
  const mapMarkerId = (mapMarkerMatch?.[1] ?? "").trim();
  if (/^\d+$/.test(mapMarkerId)) {
    return mapMarkerId;
  }

  return "";
}

function extractWidgetDataAttr(html: string, attrName: string): string {
  const match = html.match(
    new RegExp(
      `class=["'][^"']*be-property-widget[^"']*["'][^>]*\\s${attrName}=["']([^"']+)["']`,
      "i",
    ),
  );
  return (match?.[1] ?? "").trim();
}

function parseAvailabilityDaysFromCalendarHtml(
  html: string,
): Array<{ date: string; code: string }> {
  const days: Array<{ date: string; code: string }> = [];

  const cellMatches = html.matchAll(
    /<td[^>]*class=["']([^"']*)["'][^>]*data-date=["']([^"']+)["'][^>]*>/gi,
  );

  for (const match of cellMatches) {
    const classes = (match[1] ?? "").toLowerCase();
    const isoDate = normalizeDateLikeToIso(match[2]);
    if (!isoDate) {
      continue;
    }

    let code = "";
    if (classes.includes("booked")) {
      code = "N";
    } else if (
      classes.includes("available") ||
      classes.includes("check-in") ||
      classes.includes("check-out")
    ) {
      code = "Y";
    }

    if (!code) {
      continue;
    }

    days.push({ date: isoDate, code });
  }

  return days;
}

function parseRateDaysFromCalendarHtml(html: string): Array<{
  date: string;
  nightly_rate: number | null;
  min_nights: number | null;
  is_booked: boolean | null;
  changeover_code: string;
  season_name: string;
}> {
  const rateDays: Array<{
    date: string;
    nightly_rate: number | null;
    min_nights: number | null;
    is_booked: boolean | null;
    changeover_code: string;
    season_name: string;
  }> = [];

  const cellBlocks = html.matchAll(
    /<td[^>]*class=["']([^"']*)["'][^>]*data-date=["']([^"']+)["'][^>]*>([\s\S]*?)<\/td>/gi,
  );

  for (const block of cellBlocks) {
    const classes = (block[1] ?? "").toLowerCase();
    const isoDate = normalizeDateLikeToIso(block[2]);
    const body = block[3] ?? "";
    if (!isoDate) {
      continue;
    }

    const rateMatch = body.match(/class=["'][^"']*property-rate[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
    const nightlyRate = parseCurrencyLike(stripHtml(rateMatch?.[1] ?? ""));
    if (nightlyRate === null) {
      continue;
    }

    const isBooked = classes.includes("booked")
      ? true
      : classes.includes("available")
        ? false
        : null;

    rateDays.push({
      date: isoDate,
      nightly_rate: nightlyRate,
      min_nights: null,
      is_booked: isBooked,
      changeover_code: classes.includes("check-in")
        ? "I"
        : classes.includes("check-out")
          ? "O"
          : "",
      season_name: "",
    });
  }

  return rateDays;
}

function formatDateIso(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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

function formatDateUsFromIso(value: string): string {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
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

  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    return trimmed;
  }

  const usMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (usMatch) {
    const month = usMatch[1]!.padStart(2, "0");
    const day = usMatch[2]!.padStart(2, "0");
    const year = usMatch[3]!;
    return `${year}-${month}-${day}`;
  }

  return "";
}

function parseCurrencyLike(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.replace(/[^0-9.-]/g, "").trim();
  if (!normalized) {
    return null;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function decodeAvailabilityDays(
  beginDateRaw: string,
  availabilityRaw: string,
): Array<{ date: string; code: string }> {
  const beginDate = parseUsDateToUtc(beginDateRaw);
  if (!beginDate) {
    return [];
  }

  const days: Array<{ date: string; code: string }> = [];
  for (let index = 0; index < availabilityRaw.length; index += 1) {
    const current = new Date(beginDate);
    current.setUTCDate(beginDate.getUTCDate() + index);
    days.push({
      date: formatDateIso(current),
      code: availabilityRaw[index] ?? "",
    });
  }

  return days;
}

async function discoverListings(
  page: Parameters<
    ScraperAdapter<ScenicStaysDetailRecord>["discoverListings"]
  >[0]["page"],
  anchorUrl: string,
  maxScrollSteps: number,
  scrollPauseMs: number,
  _networkIdleWaitMs: number,
  reportProgress: (message: string) => void,
): Promise<ScrapedLink[]> {
  const idSet = new Set<string>();
  const detailUrlSet = new Set<string>();

  const collectDetailUrls = async (): Promise<void> => {
    const links = await page.evaluate(() => {
      const urls = new Set<string>();
      for (const node of Array.from(document.querySelectorAll("a[href]"))) {
        const href = (node as HTMLAnchorElement).href;
        if (!href) {
          continue;
        }
        try {
          const parsed = new URL(href, window.location.origin);
          if (!parsed.hostname.endsWith("myscenicstays.com")) {
            continue;
          }
          if (!parsed.pathname.startsWith("/rentals/")) {
            continue;
          }
          urls.add(parsed.toString());
        } catch {
          // Ignore malformed links.
        }
      }
      return Array.from(urls);
    });

    for (const link of links) {
      detailUrlSet.add(normalizeLink(link));
    }
  };

  page.on("response", (response) => {
    void (async () => {
      try {
        const url = response.url();
        if (!url.includes("/wp-admin/admin-ajax.php")) {
          return;
        }
        if (!url.includes("GetPropertyListWordPress")) {
          return;
        }

        const body = await response.text();
        const ids = extractIdsFromPropertyListPayload(body);
        for (const id of ids) {
          idSet.add(id);
        }
      } catch {
        // Ignore per-response parsing failures.
      }
    })();
  });

  await page.goto(anchorUrl, {
    waitUntil: "domcontentloaded",
    timeout: 120000,
  });

  await page.waitForTimeout(Math.max(1800, scrollPauseMs * 2));
  await collectDetailUrls();

  const maxCycles = Math.min(maxScrollSteps, MAX_CLICK_CYCLES);
  for (let cycle = 0; cycle < maxCycles; cycle += 1) {
    const loadMoreVisible = await page.evaluate(() => {
      const nodes = Array.from(
        document.querySelectorAll(
          "button, a, [role='button'], input[type='button'], input[type='submit']",
        ),
      );

      for (const node of nodes) {
        const element = node as HTMLElement;
        if (element.offsetParent === null) {
          continue;
        }

        if (
          element.getAttribute("disabled") !== null ||
          element.getAttribute("aria-disabled") === "true"
        ) {
          continue;
        }

        const text = (element.textContent ?? "").toLowerCase().trim();
        const aria = (element.getAttribute("aria-label") ?? "")
          .toLowerCase()
          .trim();
        const value = (element.getAttribute("value") ?? "")
          .toLowerCase()
          .trim();
        const combined = `${text} ${aria} ${value}`;
        if (combined.includes("load more")) {
          return true;
        }
      }

      return false;
    });

    if (!loadMoreVisible) {
      break;
    }

    const beforeCount = idSet.size;

    const clicked = await page.evaluate(() => {
      const nodes = Array.from(
        document.querySelectorAll(
          "button, a, [role='button'], input[type='button'], input[type='submit']",
        ),
      );

      for (const node of nodes) {
        const element = node as HTMLElement;
        if (element.offsetParent === null) {
          continue;
        }

        if (
          element.getAttribute("disabled") !== null ||
          element.getAttribute("aria-disabled") === "true"
        ) {
          continue;
        }

        const text = (element.textContent ?? "").toLowerCase().trim();
        const aria = (element.getAttribute("aria-label") ?? "")
          .toLowerCase()
          .trim();
        const value = (element.getAttribute("value") ?? "")
          .toLowerCase()
          .trim();
        const combined = `${text} ${aria} ${value}`;

        if (combined.includes("load more")) {
          element.click();
          return true;
        }
      }

      return false;
    });

    if (!clicked) {
      break;
    }

    await page.waitForTimeout(CLICK_WAIT_MS);
    await collectDetailUrls();

    for (let poll = 0; poll < GROWTH_POLL_ROUNDS; poll += 1) {
      if (idSet.size > beforeCount) {
        break;
      }
      await page.waitForTimeout(350);
    }

    if ((cycle + 1) % 3 === 0) {
      reportProgress(
        `load-more cycle ${cycle + 1}/${maxCycles}; ids=${idSet.size}; links=${detailUrlSet.size}`,
      );
    }
  }

  if (detailUrlSet.size > 0) {
    return Array.from(detailUrlSet)
      .sort((left, right) => left.localeCompare(right))
      .map((link) => ({
        link,
        source_url: anchorUrl,
        anchor_text: "dom-rental-link",
      }));
  }

  const sortedIds = Array.from(idSet).sort(
    (left, right) => Number(left) - Number(right),
  );

  return sortedIds.map((id) => ({
    link: normalizeLink(canonicalStayUrlFromId(id)),
    source_url: anchorUrl,
    anchor_text: "api-load-more",
  }));
}

async function fetchDetail(
  detailUrl: string,
  availabilityHorizonDays: number,
): Promise<ScenicStaysDetailRecord | null> {
  const rentalIdFromUrl = extractRentalIdFromDetailUrl(detailUrl);
  const rentalSlugFromUrl = extractRentalSlugFromDetailUrl(detailUrl);

  const headers = {
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    accept: "text/html,application/json,text/plain,*/*",
    referer: detailUrl,
  };

  try {
    const detailResponse = await fetch(detailUrl, {
      method: "GET",
      redirect: "follow",
      headers,
    });

    const contentType = (
      detailResponse.headers.get("content-type") ?? ""
    ).toLowerCase();
    if (detailResponse.status !== 200 || !contentType.includes("text/html")) {
      return null;
    }

    const html = await detailResponse.text();

    const title = extractFirst(/<title[^>]*>([\s\S]*?)<\/title>/i, html).slice(
      0,
      240,
    );
    const h1 = extractFirst(/<h1[^>]*>([\s\S]*?)<\/h1>/i, html).slice(0, 240);
    const canonicalUrl =
      extractFirst(
        /<link[^>]+rel=["']canonical["'][^>]+href=["']([\s\S]*?)["'][^>]*>/i,
        html,
      ) || detailUrl;

    const metaDescription =
      extractFirst(
        /<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["'][^>]*>/i,
        html,
      ).slice(0, 2000) ||
      extractFirst(
        /<meta[^>]+content=["']([\s\S]*?)["'][^>]+name=["']description["'][^>]*>/i,
        html,
      ).slice(0, 2000);

    const jsonLdObjects = extractJsonLdObjects(html);
    const lodgingJsonLd =
      jsonLdObjects.find((item) => {
        const itemType = String(item["@type"] ?? "").toLowerCase();
        return itemType.includes("lodging") || itemType.includes("accommodation");
      }) ?? jsonLdObjects[0] ?? null;

    const descriptionSection = extractSectionBetween(
      html,
      'class="property_description"',
      '</section><!--End description-->',
    );
    const descriptionExpanded =
      stripHtml(descriptionSection).replace(/^description\s+/i, "").slice(0, 20000) ||
      stripHtml(
        typeof lodgingJsonLd?.description === "string"
          ? lodgingJsonLd.description
          : metaDescription,
      ).slice(0, 20000);

    const amenitiesSection = extractSectionBetween(
      html,
      'id="property-amenities"',
      "</section>",
    );
    const categoryMap: Record<string, string[]> = {};
    let activeCategory = "General";
    const amenityBlocks = amenitiesSection.matchAll(
      /<div[^>]+class=["'][^"']*(amenity_group|amenity_item)[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi,
    );
    for (const block of amenityBlocks) {
      const kind = (block[1] ?? "").trim();
      const rawText = stripHtml(block[2] ?? "").trim();
      if (!rawText) {
        continue;
      }
      if (kind === "amenity_group") {
        activeCategory = rawText;
        if (!categoryMap[activeCategory]) {
          categoryMap[activeCategory] = [];
        }
        continue;
      }
      if (!categoryMap[activeCategory]) {
        categoryMap[activeCategory] = [];
      }
      if (!categoryMap[activeCategory].includes(rawText)) {
        categoryMap[activeCategory].push(rawText);
      }
    }

    const amenitiesAll = Object.values(categoryMap)
      .flat()
      .filter(Boolean);

    const jsonLdAddress =
      lodgingJsonLd && typeof lodgingJsonLd.address === "object"
        ? (lodgingJsonLd.address as Record<string, unknown>)
        : null;
    const jsonLdGeo =
      lodgingJsonLd && typeof lodgingJsonLd.geo === "object"
        ? (lodgingJsonLd.geo as Record<string, unknown>)
        : null;

    const location = {
      address: stripHtml(
        [
          jsonLdAddress?.streetAddress,
          jsonLdAddress?.addressLocality,
          jsonLdAddress?.addressRegion,
          jsonLdAddress?.postalCode,
        ]
          .map((part) => String(part ?? "").trim())
          .filter(Boolean)
          .join(", "),
      ).slice(0, 500),
      city: String(jsonLdAddress?.addressLocality ?? "").trim(),
      state: String(jsonLdAddress?.addressRegion ?? "").trim(),
      postal_code: String(jsonLdAddress?.postalCode ?? "").trim(),
      country: String(jsonLdAddress?.addressCountry ?? "").trim(),
      latitude: parseNumberLike(jsonLdGeo?.latitude as string | number | null),
      longitude: parseNumberLike(jsonLdGeo?.longitude as string | number | null),
    };

    const widgetStreet = extractWidgetDataAttr(html, "data-straddress1");
    const widgetCity = extractWidgetDataAttr(html, "data-strlocation");
    const widgetLatitude = parseNumberLike(
      extractWidgetDataAttr(html, "data-latitude"),
    );
    const widgetLongitude = parseNumberLike(
      extractWidgetDataAttr(html, "data-longitude"),
    );

    if (!location.address && widgetStreet) {
      location.address = widgetStreet;
    }
    if (!location.city && widgetCity) {
      location.city = widgetCity;
    }
    if (location.latitude === null && widgetLatitude !== null) {
      location.latitude = widgetLatitude;
    }
    if (location.longitude === null && widgetLongitude !== null) {
      location.longitude = widgetLongitude;
    }

    const beds = parseNumberLike(
      (lodgingJsonLd?.numberOfBedrooms as string | number | null) ?? null,
    );
    const baths = parseNumberLike(
      (lodgingJsonLd?.numberOfBathroomsTotal as string | number | null) ??
        (lodgingJsonLd?.numberOfBathrooms as string | number | null) ??
        null,
    );
    const sleeps = parseNumberLike(
      (lodgingJsonLd?.maximumAttendeeCapacity as string | number | null) ??
        ((lodgingJsonLd?.occupancy as Record<string, unknown> | null)?.
          maxValue as string | number | null) ??
        null,
    );

    const bedsResolved =
      beds ?? parseNumberLike(extractWidgetDataAttr(html, "data-dblbeds"));
    const sleepsResolved =
      sleeps ?? parseNumberLike(extractWidgetDataAttr(html, "data-intoccu"));

    const mediaUrls = collectMediaUrls(html, detailUrl, jsonLdObjects);

    const widgetUnitId = extractWidgetUnitId(html);
    const rentalId =
      widgetUnitId ||
      rentalIdFromUrl ||
      rentalSlugFromUrl ||
      normalizeLink(detailUrl).split("/").filter(Boolean).at(-1) ||
      "unknown";
    const numericUnitId = /^\d+$/.test(rentalId) ? Number(rentalId) : null;

    const htmlPath = resolve(OUTPUT_DETAILS_HTML_DIR, `${rentalId}.html`);
    await writeFile(htmlPath, `${html}\n`, "utf8");

    let rawBeginDate = "";
    let rawEndDate = "";
    let rawAvailabilityCodes = "";

    if (numericUnitId !== null) {
      const availabilityApiUrl = `https://myscenicstays.com/wp-admin/admin-ajax.php?${new URLSearchParams(
        {
          action: "streamlinecore-api-request",
          params: JSON.stringify({
            methodName: "GetPropertyAvailabilityRawData",
            params: {
              unit_id: numericUnitId,
              use_room_type_logic: "no",
              standard_pricing: 1,
            },
          }),
        },
      ).toString()}`;

      const availabilityResponse = await fetch(availabilityApiUrl, {
        method: "GET",
        headers,
      });

      if (availabilityResponse.status === 200) {
        const raw = await availabilityResponse.text();
        try {
          const parsed = JSON.parse(raw) as {
            data?: {
              range?: { beginDate?: string; endDate?: string };
              availability?: string;
            };
          };
          rawBeginDate = parsed.data?.range?.beginDate ?? "";
          rawEndDate = parsed.data?.range?.endDate ?? "";
          rawAvailabilityCodes = parsed.data?.availability ?? "";
        } catch {
          // Ignore malformed availability payload.
        }
      }
    }

    const allAvailabilityDaysFromApi = decodeAvailabilityDays(
      rawBeginDate,
      rawAvailabilityCodes,
    );
    const allAvailabilityDays =
      allAvailabilityDaysFromApi.length > 0
        ? allAvailabilityDaysFromApi
        : parseAvailabilityDaysFromCalendarHtml(html);

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

    const ratesStartIso = filteredDays[0]?.date ?? formatDateIso(today);
    const ratesEndIso =
      filteredDays[filteredDays.length - 1]?.date ?? formatDateIso(horizonDate);
    const ratesStartDateUs = formatDateUsFromIso(ratesStartIso);
    const ratesEndDateUs = formatDateUsFromIso(ratesEndIso);

    let ratesRowsRaw: Array<Record<string, unknown>> = [];
    if (numericUnitId !== null && ratesStartDateUs && ratesEndDateUs) {
      const ratesApiUrl = `https://myscenicstays.com/wp-admin/admin-ajax.php?${new URLSearchParams(
        {
          action: "streamlinecore-api-request",
          params: JSON.stringify({
            methodName: "GetPropertyRates",
            params: {
              unit_id: numericUnitId,
              startdate: ratesStartDateUs,
              enddate: ratesEndDateUs,
            },
          }),
        },
      ).toString()}`;

      const ratesResponse = await fetch(ratesApiUrl, {
        method: "GET",
        headers,
      });

      if (ratesResponse.status === 200) {
        const rawRates = await ratesResponse.text();
        try {
          const parsed = JSON.parse(rawRates) as {
            data?: unknown;
          };

          const data = parsed.data;
          if (Array.isArray(data)) {
            ratesRowsRaw = data.filter(
              (row): row is Record<string, unknown> =>
                row !== null && typeof row === "object",
            );
          } else if (data && typeof data === "object") {
            ratesRowsRaw = Object.values(data).filter(
              (row): row is Record<string, unknown> =>
                row !== null && typeof row === "object",
            );
          }
        } catch {
          // Ignore malformed rates payload.
        }
      }
    }

    let normalizedRateDays = ratesRowsRaw
      .map((row) => {
        const date = normalizeDateLikeToIso(row.date);
        if (!date) {
          return null;
        }

        const nightlyRate = parseCurrencyLike(row.rate);
        const minNights = parseNumberLike(
          row.minStay as string | number | null | undefined,
        );
        const bookedRaw = row.booked;

        let isBooked: boolean | null = null;
        if (typeof bookedRaw === "number") {
          isBooked = bookedRaw > 0;
        } else if (typeof bookedRaw === "string") {
          const lower = bookedRaw.trim().toLowerCase();
          if (["1", "true", "y", "yes", "booked"].includes(lower)) {
            isBooked = true;
          } else if (["0", "false", "n", "no", "open"].includes(lower)) {
            isBooked = false;
          }
        }

        return {
          date,
          nightly_rate: nightlyRate,
          min_nights: minNights,
          is_booked: isBooked,
          changeover_code: String(row.changeOver ?? "").trim(),
          season_name: String(row.season ?? "").trim(),
        };
      })
      .filter((day): day is NonNullable<typeof day> => day !== null)
      .sort((left, right) => left.date.localeCompare(right.date));

    if (normalizedRateDays.length === 0) {
      normalizedRateDays = parseRateDaysFromCalendarHtml(html);
    }

    const nightlyRates = normalizedRateDays
      .map((day) => day.nightly_rate)
      .filter((value): value is number => typeof value === "number");

    const daysWithRate = nightlyRates.length;
    const sumRates = nightlyRates.reduce((sum, value) => sum + value, 0);
    const minNightlyRate = daysWithRate > 0 ? Math.min(...nightlyRates) : null;
    const maxNightlyRate = daysWithRate > 0 ? Math.max(...nightlyRates) : null;
    const avgNightlyRate =
      daysWithRate > 0 ? Number((sumRates / daysWithRate).toFixed(2)) : null;

    const normalizedDays = filteredDays.map((day) => {
      const bookingDayState: "bookable" | "blocked" | "unknown" =
        day.code === "Y"
          ? "bookable"
          : day.code === "N"
            ? "blocked"
            : "unknown";

      return {
        date: day.date,
        is_available: day.code === "Y",
        is_available_for_checkin: day.code === "Y",
        is_available_for_checkout: day.code === "Y",
        status_code: day.code,
        booking_day_state: bookingDayState,
      };
    });

    const available = normalizedDays.filter(
      (day) => day.status_code === "Y",
    ).length;
    const notAvailable = normalizedDays.filter(
      (day) => day.status_code === "N",
    ).length;
    const other = normalizedDays.length - available - notAvailable;

    const description = descriptionExpanded || stripHtml(metaDescription).slice(0, 20000);
    const name = stripHtml(h1 || title).slice(0, 240);
    const descriptionNormalized = normalizeForMatch(description);
    const titleNormalized = normalizeForMatch(name);

    return {
      external_listing_id: rentalId,
      detail_url: detailUrl,
      fetched_at: new Date().toISOString(),
      title,
      h1,
      canonical_url: canonicalUrl,
      meta_description: metaDescription,
      description_expanded: descriptionExpanded,
      amenities: {
        categories: categoryMap,
        all: amenitiesAll,
      },
      location,
      media_gallery: {
        image_count: mediaUrls.length,
        image_urls: mediaUrls,
      },
      property_profile: {
        unit_id: rentalId,
        property_code: rentalId,
        beds: bedsResolved,
        baths,
        sleeps: sleepsResolved,
        city: location.city,
        state: location.state,
        zip: location.postal_code,
      },
      normalized_matching_profile: {
        source: "pm_scenicstays30a",
        external_listing_id: rentalId,
        name,
        description,
        match_signals: {
          description_normalized: descriptionNormalized,
          description_sha256: hashSha256(descriptionNormalized),
          title_normalized: titleNormalized,
          title_sha256: hashSha256(titleNormalized),
          listing_composite_key: [
            "pm_scenicstays30a",
            rentalId,
            hashSha256(descriptionNormalized),
            hashSha256(titleNormalized),
          ].join("::"),
        },
      },
      normalized_availability: {
        source: "pm_scenicstays30a",
        external_listing_id: rentalId,
        captured_at: new Date().toISOString(),
        window_start: filteredDays[0]?.date ?? "",
        window_end: filteredDays[filteredDays.length - 1]?.date ?? "",
        code_legend: {
          Y: "available",
          N: "not_available",
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
        source: "pm_scenicstays30a",
        external_listing_id: rentalId,
        captured_at: new Date().toISOString(),
        currency: "USD",
        window_start: ratesStartIso,
        window_end: ratesEndIso,
        days: normalizedRateDays,
        stats: {
          days_with_rate: daysWithRate,
          min_nightly_rate: minNightlyRate,
          max_nightly_rate: maxNightlyRate,
          avg_nightly_rate: avgNightlyRate,
        },
      },
      rates_raw: {
        request_start_date: ratesStartDateUs,
        request_end_date: ratesEndDateUs,
        rows: ratesRowsRaw,
      },
      html_path: htmlPath,
    };
  } catch {
    return null;
  }
}

export function createScenicStays30AAdapter(): ScraperAdapter<ScenicStaysDetailRecord> {
  return {
    managerKey: "scenicstays30a",
    scriptLabel: "scenicstays30a",
    defaultAnchorUrl: DEFAULT_ANCHOR_URL,
    detailFetchDelayMs: Math.max(
      0,
      Number(process.env.SCENICSTAYS30A_DETAIL_FETCH_DELAY_MS ?? "250") ||
        250,
    ),
    detailFetchConcurrency: Math.max(
      1,
      Number(process.env.SCENICSTAYS30A_FETCH_CONCURRENCY ?? "6") || 6,
    ),
    availabilityHorizonDays: Math.max(
      1,
      Number(process.env.SCENICSTAYS30A_AVAILABILITY_HORIZON_DAYS ?? "730") ||
        730,
    ),
    maxCalendarAdvanceMonths: 24,
    isValidDetailUrl(value: string): string | null {
      try {
        const parsed = new URL(value.trim());
        if (!parsed.hostname.endsWith("myscenicstays.com")) {
          return null;
        }

        const hasNumericId = !!extractRentalIdFromDetailUrl(parsed.toString());
        const hasRentalSlug = !!extractRentalSlugFromDetailUrl(parsed.toString());
        if (!hasNumericId && !hasRentalSlug) {
          return null;
        }

        return normalizeLink(parsed.toString());
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
      return fetchDetail(context.detailUrl, context.availabilityHorizonDays);
    },
  };
}
