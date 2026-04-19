import { executeElp30aSingleQuote } from "@/lib/pricing/quote-runtime/adapters/elp30a";
import { runRuntimeAdapterQuoteCli } from "@/lib/pricing/quotes/shared/runtime-adapter-quote-runner";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { normalizeAdapterQuoteScopeArgs } from "../quote-scope";
import type { DetailRecordBase, ScrapedLink, ScraperAdapter } from "../types";

type ElpDayCode = "A" | "U" | "I" | "O" | "X";
type CanonicalDayCode = "Y" | "N";
type CanonicalChangeoverCode = "C" | "I" | "O" | "X";

type ElpRateEntry = {
  start_date?: unknown;
  end_date?: unknown;
  amount?: unknown;
};

type ElpAvailEntry = {
  start_date?: unknown;
  end_date?: unknown;
};

type ElpMinNightsEntry = {
  start_date?: unknown;
  end_date?: unknown;
  nights?: unknown;
};

type ElpUnitPayload = {
  id?: unknown;
  Name?: unknown;
  City?: unknown;
  State?: unknown;
  Bedrooms?: unknown;
  Bathrooms?: unknown;
  Sleeps?: unknown;
  Type?: unknown;
  Area?: unknown;
  Location?: unknown;
  Address1?: unknown;
  Address2?: unknown;
  PostalCode?: unknown;
  lat?: unknown;
  long?: unknown;
  page_slug?: unknown;
  Description?: unknown;
  photos?: unknown;
  rates?: unknown;
  avail?: unknown;
  minnights?: unknown;
  attributes?: unknown;
};

type ElpAttributeEntry = {
  name?: unknown;
  group?: unknown;
};

type ElpCheckAvailabilityResponse = {
  ID?: unknown;
  Name?: unknown;
  TotalCost?: unknown;
  TotalTax?: unknown;
  TheRentalRate?: unknown;
  unit?: unknown;
};

type ElpDetailRecord = DetailRecordBase & {
  quote_context: {
    listing_id: string;
    detail_url: string;
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
    source: "pm_elp30a";
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
    source: "pm_elp30a";
    external_listing_id: string;
    captured_at: string;
    has_calendar_widget: boolean;
    min_night_rules: Array<{
      start_date: string;
      end_date: string;
      min_nights: number;
    }>;
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
      status_code: ElpDayCode;
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
  normalized_rates: {
    source: "pm_elp30a";
    external_listing_id: string;
    captured_at: string;
    currency: "USD";
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
  availability_raw: {
    available_ranges: Array<{ start_date: string; end_date: string }>;
    min_night_rules: Array<{
      start_date: string;
      end_date: string;
      min_nights: number;
    }>;
  };
  rates_raw: {
    rows: Array<{ start_date: string; end_date: string; amount: number }>;
  };
  property_profile: {
    unit_id: string;
    property_code: string;
    unit_slug: string;
    unit_type: string;
    area: string;
    location: string;
    beds: number | null;
    baths: number | null;
    sleeps: number | null;
    city: string;
    state: string;
    zip: string;
  };
};

type HtmlUnitData = {
  unitId: string;
  slug: string;
  propertyCode: string;
  name: string;
  address1: string;
  address2: string;
  city: string;
  state: string;
  zip: string;
  latitude: number | null;
  longitude: number | null;
  beds: number | null;
  baths: number | null;
  sleeps: number | null;
  unitType: string;
};

type HtmlCalendarDay = {
  date: string;
  status_code: ElpDayCode;
  is_available: boolean;
  is_available_for_checkin: boolean;
  is_available_for_checkout: boolean;
  booking_day_state: "bookable" | "blocked" | "unknown";
};

const BASE_HOST = "https://eluxuryproperties.com";
const DEFAULT_ANCHOR_URL = `${BASE_HOST}/vrp/search/results/?show=200`;
const OUTPUT_ROOT = resolve(
  process.cwd(),
  "src",
  "lib",
  "data",
  "external-sources",
  "elp30a",
);
const OUTPUT_DETAILS_HTML_DIR = resolve(OUTPUT_ROOT, "details", "html");
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function normalizeLink(url: string): string {
  return url.split("#")[0]?.replace(/\/+$/, "") ?? url;
}

function normalizeDetailUrl(value: string): string | null {
  try {
    const parsed = new URL(value.trim(), BASE_HOST);
    if (!parsed.hostname.endsWith("eluxuryproperties.com")) {
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

function toDayCodeFromStatus(status: ElpDayCode): CanonicalDayCode {
  return status === "A" || status === "O" ? "Y" : "N";
}

function toChangeoverCodeFromStatus(
  status: ElpDayCode,
): CanonicalChangeoverCode {
  if (status === "I") {
    return "I";
  }
  if (status === "O") {
    return "O";
  }
  if (status === "U" || status === "X") {
    return "X";
  }
  return "C";
}

function decodeBasicHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function parseMoney(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value * 100) / 100;
  }

  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.replace(/[^0-9.-]/g, "").trim();
  if (!normalized) {
    return null;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : null;
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

function parseIsoDate(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return null;
  }
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function formatUsDate(isoDate: string): string {
  const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return isoDate;
  }
  return `${match[2]}/${match[3]}/${match[1]}`;
}

function inferMaxPageFromHtml(html: string): number {
  let maxPage = 1;
  const pageRegex = /[?&]page=(\d+)/gi;
  let match: RegExpExecArray | null = pageRegex.exec(html);
  while (match) {
    const pageNumber = Number(match[1]);
    if (Number.isInteger(pageNumber) && pageNumber > maxPage) {
      maxPage = pageNumber;
    }
    match = pageRegex.exec(html);
  }
  return maxPage;
}

function extractUnitLinksFromHtml(html: string): string[] {
  const links = new Set<string>();
  const absoluteRegex =
    /https:\/\/eluxuryproperties\.com\/vrp\/unit\/[^"'\s<]+/gi;
  const relativeRegex = /href=["'](\/vrp\/unit\/[^"'#\s<]+)(?:[^"']*)["']/gi;

  let absoluteMatch: RegExpExecArray | null = absoluteRegex.exec(html);
  while (absoluteMatch) {
    const normalized = normalizeDetailUrl(absoluteMatch[0] ?? "");
    if (normalized) {
      links.add(normalized);
    }
    absoluteMatch = absoluteRegex.exec(html);
  }

  let relativeMatch: RegExpExecArray | null = relativeRegex.exec(html);
  while (relativeMatch) {
    const normalized = normalizeDetailUrl(
      `${BASE_HOST}${relativeMatch[1] ?? ""}`,
    );
    if (normalized) {
      links.add(normalized);
    }
    relativeMatch = relativeRegex.exec(html);
  }

  return Array.from(links);
}

function buildSearchPageUrl(anchorUrl: string, pageNumber: number): string {
  const source = new URL(anchorUrl);
  source.searchParams.set("show", process.env.ELP30A_SHOW ?? "200");
  source.searchParams.set("page", String(pageNumber));
  return source.toString();
}

function parsePropIdFromHtml(html: string, unitSlug: string): string | null {
  const escapedSlug = unitSlug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    /name=["']obj\[PropID\]["'][^>]*value=["'](\d+)["']/i,
    /name=["']obj\[unit_id\]["'][^>]*value=["'](\d+)["']/i,
    new RegExp(
      `"id"\\s*:\\s*"?(\\d+)"?[^\\n]{0,600}"page_slug"\\s*:\\s*"${escapedSlug}"`,
      "i",
    ),
    /obj%5BPropID%5D=(\d+)/i,
    /obj\[PropID\]=("|')?(\d+)(?:\1)?/i,
    /"PropID"\s*:\s*"?(\d+)"?/i,
    /"ID"\s*:\s*"?(\d+)"?[,}]/i,
    /data-propid=("|')?(\d+)(?:\1)?/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    const candidate = match?.[2] ?? match?.[1] ?? null;
    if (candidate && /^\d+$/.test(candidate)) {
      return candidate;
    }
  }

  return null;
}

function isInvalidUnitPage(params: {
  title: string;
  h1: string;
  html: string;
}): boolean {
  const title = params.title.toLowerCase();
  const h1 = params.h1.toLowerCase();
  const html = params.html.toLowerCase();

  return (
    title.includes("page not found") ||
    h1.includes("no results found") ||
    html.includes("this property is no longer available") ||
    html.includes("this property is no longer in our inventory")
  );
}

function collectMediaUrls(html: string, baseUrl: string): string[] {
  const urls = new Set<string>();
  const regex = /(?:src|data-src|data-image|content)=["']([^"']+)["']/gi;

  let match: RegExpExecArray | null = regex.exec(html);
  while (match) {
    const raw = (match[1] ?? "").trim();
    if (!raw) {
      match = regex.exec(html);
      continue;
    }

    try {
      const absolute = new URL(raw, baseUrl).toString();
      const normalizedAbsolute = normalizeImageUrl(absolute);
      const parsed = new URL(normalizedAbsolute);
      const isImagePath = /\.(jpe?g|png|webp|gif)(\?|$)/i.test(parsed.pathname);
      const isTrackWrapped =
        parsed.hostname.includes("img.trackhs.com") &&
        parsed.pathname.includes("/https://track-pm.s3.amazonaws.com/");
      const isTrackAsset =
        parsed.hostname.includes("track-pm.s3.amazonaws.com") ||
        parsed.hostname.includes("img.trackhs.com");

      if (isImagePath || isTrackWrapped || isTrackAsset) {
        urls.add(normalizedAbsolute);
      }
    } catch {
      // Ignore malformed URLs.
    }

    match = regex.exec(html);
  }

  return Array.from(urls);
}

function normalizeImageUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }

  const nestedIndex = trimmed.indexOf("/https://");
  if (nestedIndex >= 0) {
    return trimmed.slice(nestedIndex + 1);
  }

  const nestedHttpIndex = trimmed.indexOf("/http://");
  if (nestedHttpIndex >= 0) {
    return trimmed.slice(nestedHttpIndex + 1);
  }

  return trimmed;
}

function parseHtmlUnitData(html: string): HtmlUnitData | null {
  const tagMatch = html.match(/<div[^>]+id=["']unit-data["'][^>]*>/i);
  if (!tagMatch?.[0]) {
    return null;
  }

  const tag = tagMatch[0];
  const attrs: Record<string, string> = {};
  const attrRegex = /data-([a-z0-9-]+)=["']([^"']*)["']/gi;
  let attrMatch: RegExpExecArray | null = attrRegex.exec(tag);
  while (attrMatch) {
    const key = attrMatch[1] ?? "";
    const value = decodeBasicHtmlEntities(attrMatch[2] ?? "").trim();
    if (key) {
      attrs[key] = value;
    }
    attrMatch = attrRegex.exec(tag);
  }

  return {
    unitId: attrs["unit-id"] ?? "",
    slug: attrs["unit-slug"] ?? "",
    propertyCode: attrs["unit-property-code"] ?? "",
    name: attrs["unit-name"] ?? "",
    address1: attrs["unit-address1"] ?? "",
    address2: attrs["unit-address2"] ?? "",
    city: attrs["unit-city"] ?? "",
    state: attrs["unit-state"] ?? "",
    zip: attrs["unit-zip"] ?? "",
    latitude: parseNumberLike(attrs["unit-latitude"]),
    longitude: parseNumberLike(attrs["unit-longitude"]),
    beds: parseNumberLike(attrs["unit-beds"]),
    baths: parseNumberLike(attrs["unit-baths"]),
    sleeps: parseNumberLike(attrs["unit-sleeps"]),
    unitType: attrs["unit-type"] ?? "",
  };
}

function parseSchemaNumber(html: string, field: string): number | null {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(
    new RegExp(`"${escaped}"\\s*:\\s*"?(-?\\d+(?:\\.\\d+)?)"?`, "i"),
  );
  return parseNumberLike(match?.[1] ?? null);
}

function toIsoDateFromTitle(value: string): string | null {
  const normalized = value.replace(/\s+/g, " ").trim();
  const match = normalized.match(/,\s*([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
  if (!match) {
    return null;
  }

  const monthMap: Record<string, string> = {
    january: "01",
    february: "02",
    march: "03",
    april: "04",
    may: "05",
    june: "06",
    july: "07",
    august: "08",
    september: "09",
    october: "10",
    november: "11",
    december: "12",
  };
  const month = monthMap[(match[1] ?? "").toLowerCase()];
  if (!month) {
    return null;
  }
  const day = String(Number(match[2] ?? "")).padStart(2, "0");
  const year = match[3] ?? "";
  return `${year}-${month}-${day}`;
}

function parseCalendarDaysFromHtml(html: string): HtmlCalendarDay[] {
  const calendarSection = html.match(
    /<div[^>]+id=["']calendar["'][^>]*>([\s\S]*?)<div class="calkey"/i,
  );
  const scope = calendarSection?.[1] ?? "";
  if (!scope) {
    return [];
  }

  const results: HtmlCalendarDay[] = [];
  const seen = new Set<string>();
  const cellRegex = /<td([^>]*)title=["']([^"']+)["'][^>]*>([\s\S]*?)<\/td>/gi;
  let cellMatch: RegExpExecArray | null = cellRegex.exec(scope);
  while (cellMatch) {
    const attrs = cellMatch[1] ?? "";
    const title = cellMatch[2] ?? "";
    const isoDate = toIsoDateFromTitle(title);
    if (!isoDate || seen.has(isoDate)) {
      cellMatch = cellRegex.exec(scope);
      continue;
    }

    const classMatch = attrs.match(/class=["']([^"']+)["']/i);
    const classTokens = (classMatch?.[1] ?? "")
      .split(/\s+/)
      .map((token) => token.trim())
      .filter(Boolean);

    if (classTokens.includes("pad") || classTokens.includes("passed")) {
      cellMatch = cellRegex.exec(scope);
      continue;
    }

    let status: ElpDayCode = "A";
    let checkIn = false;
    let checkOut = false;

    if (classTokens.includes("dDate")) {
      status = "I";
      checkIn = true;
    } else if (classTokens.includes("aDate")) {
      status = "O";
      checkOut = true;
    } else if (classTokens.includes("highlighted")) {
      status = "U";
    }

    const isAvailable = status === "A";
    results.push({
      date: isoDate,
      status_code: status,
      is_available: isAvailable,
      is_available_for_checkin: isAvailable || checkIn,
      is_available_for_checkout: isAvailable || checkOut,
      booking_day_state: status === "U" ? "blocked" : "bookable",
    });
    seen.add(isoDate);
    cellMatch = cellRegex.exec(scope);
  }

  return results.sort((a, b) => a.date.localeCompare(b.date));
}

function buildAvailableRangesFromDays(
  days: Array<{ date: string; status_code: ElpDayCode }>,
): Array<{ start_date: string; end_date: string }> {
  const availableDays = days
    .filter((day) => day.status_code === "A")
    .map((day) => day.date)
    .sort((a, b) => a.localeCompare(b));

  if (availableDays.length === 0) {
    return [];
  }

  const ranges: Array<{ start_date: string; end_date: string }> = [];
  let start = availableDays[0] ?? "";
  let prev = start;

  for (let index = 1; index < availableDays.length; index += 1) {
    const current = availableDays[index] ?? "";
    const nextDay = new Date(`${prev}T00:00:00.000Z`);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    const nextIso = `${nextDay.getUTCFullYear()}-${String(nextDay.getUTCMonth() + 1).padStart(2, "0")}-${String(nextDay.getUTCDate()).padStart(2, "0")}`;

    if (current !== nextIso) {
      ranges.push({ start_date: start, end_date: prev });
      start = current;
    }
    prev = current;
  }

  ranges.push({ start_date: start, end_date: prev });
  return ranges;
}

function collectGalleryMediaUrls(html: string, baseUrl: string): string[] {
  const urls = new Set<string>();

  const pushRegex = /photos\.push\(`([^`]+)`\)/gi;
  let pushMatch: RegExpExecArray | null = pushRegex.exec(html);
  while (pushMatch) {
    const raw = (pushMatch[1] ?? "").trim();
    if (raw) {
      try {
        urls.add(normalizeImageUrl(new URL(raw, baseUrl).toString()));
      } catch {
        // Ignore malformed URLs.
      }
    }
    pushMatch = pushRegex.exec(html);
  }

  const thumbRegex = /data-thumb=["']([^"']+)["']/gi;
  let thumbMatch: RegExpExecArray | null = thumbRegex.exec(html);
  while (thumbMatch) {
    const raw = (thumbMatch[1] ?? "").trim();
    if (raw) {
      try {
        urls.add(normalizeImageUrl(new URL(raw, baseUrl).toString()));
      } catch {
        // Ignore malformed URLs.
      }
    }
    thumbMatch = thumbRegex.exec(html);
  }

  const largeImgRegex =
    /class=["'][^"']*large-img[^"']*["'][^>]*data-src=["']([^"']+)["']/gi;
  let largeImgMatch: RegExpExecArray | null = largeImgRegex.exec(html);
  while (largeImgMatch) {
    const raw = (largeImgMatch[1] ?? "").trim();
    if (raw) {
      try {
        urls.add(normalizeImageUrl(new URL(raw, baseUrl).toString()));
      } catch {
        // Ignore malformed URLs.
      }
    }
    largeImgMatch = largeImgRegex.exec(html);
  }

  const filtered = Array.from(urls).filter((value) => {
    try {
      const parsed = new URL(value);
      const isImagePath = /\/(?:[^/]+)\.(?:jpe?g|png|webp|gif)(\?|$)/i.test(
        parsed.pathname,
      );
      const isTrackAsset =
        parsed.hostname.includes("track-pm.s3.amazonaws.com") ||
        parsed.hostname.includes("img.trackhs.com");
      return isImagePath || isTrackAsset;
    } catch {
      return false;
    }
  });

  return filtered;
}

function parseAmenities(
  html: string,
  unit: ElpUnitPayload | null,
): { categories: Record<string, string[]>; all: string[] } {
  const categories: Record<string, string[]> = {};
  const allSet = new Set<string>();

  const rawAttributes = Array.isArray(unit?.attributes)
    ? (unit?.attributes as ElpAttributeEntry[])
    : [];
  for (const entry of rawAttributes) {
    const name = stripHtml(String(entry.name ?? "")).trim();
    if (!name || name.length > 120) {
      continue;
    }
    const categoryRaw = stripHtml(String(entry.group ?? "")).trim();
    const categoryKey =
      categoryRaw.length > 0
        ? categoryRaw.toLowerCase().replace(/[^a-z0-9]+/g, "_")
        : "general";

    if (!categories[categoryKey]) {
      categories[categoryKey] = [];
    }
    if (!categories[categoryKey].includes(name)) {
      categories[categoryKey].push(name);
    }
    allSet.add(name);
  }

  if (allSet.size > 0) {
    return {
      categories,
      all: Array.from(allSet).slice(0, 300),
    };
  }

  const amenitiesSectionMatch = html.match(
    /<div[^>]+id=["']amenities["'][^>]*>([\s\S]*?)<\/div>/i,
  );
  const amenityScope = amenitiesSectionMatch?.[1] ?? "";
  const listItemRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let itemMatch: RegExpExecArray | null = listItemRegex.exec(amenityScope);
  while (itemMatch) {
    const value = decodeBasicHtmlEntities(stripHtml(itemMatch[1] ?? "")).trim();
    if (!value || value.length < 2 || value.length > 120) {
      itemMatch = listItemRegex.exec(amenityScope);
      continue;
    }

    const lowered = value.toLowerCase();
    if (
      lowered.includes("view details") ||
      lowered.includes("book now") ||
      lowered.includes("calendar") ||
      lowered.includes("reviews") ||
      lowered.includes("description") ||
      lowered.includes("location")
    ) {
      itemMatch = listItemRegex.exec(amenityScope);
      continue;
    }

    allSet.add(value);
    itemMatch = listItemRegex.exec(amenityScope);
  }

  categories.general = Array.from(allSet).slice(0, 200);
  return {
    categories,
    all: Array.from(allSet).slice(0, 200),
  };
}

function extractDescriptionExpanded(html: string): string {
  const sectionRegexes = [
    /<section[^>]*id=["'][^"']*description[^"']*["'][^>]*>([\s\S]*?)<\/section>/i,
    /<div[^>]*id=["'][^"']*description[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    /"Description"\s*:\s*"([\s\S]*?)"[,}]/i,
  ];

  for (const regex of sectionRegexes) {
    const match = html.match(regex);
    if (!match?.[1]) {
      continue;
    }

    const raw = match[1];
    if (regex.source.includes('\\"Description\\"')) {
      try {
        const decoded = JSON.parse(`"${raw.replace(/"/g, '\\"')}"`);
        const clean = stripHtml(String(decoded ?? ""));
        if (clean.length > 30) {
          return clean;
        }
      } catch {
        const clean = stripHtml(raw);
        if (clean.length > 30) {
          return clean;
        }
      }
    } else {
      const clean = stripHtml(raw);
      if (clean.length > 30) {
        return clean;
      }
    }
  }

  return extractFirst(
    /<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["'][^>]*>/i,
    html,
  );
}

function buildIsoDateRange(startIso: string, endIso: string): string[] {
  const dates: string[] = [];
  const start = new Date(`${startIso}T00:00:00.000Z`);
  const end = new Date(`${endIso}T00:00:00.000Z`);
  if (
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime()) ||
    end < start
  ) {
    return dates;
  }
  const cursor = new Date(start);
  while (cursor <= end) {
    const year = cursor.getUTCFullYear();
    const month = String(cursor.getUTCMonth() + 1).padStart(2, "0");
    const day = String(cursor.getUTCDate()).padStart(2, "0");
    dates.push(`${year}-${month}-${day}`);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function parseCheckAvailabilityPayload(payload: ElpCheckAvailabilityResponse): {
  unit: ElpUnitPayload | null;
  availableRanges: Array<{ start_date: string; end_date: string }>;
  rateRows: Array<{ start_date: string; end_date: string; amount: number }>;
  minNightRules: Array<{
    start_date: string;
    end_date: string;
    min_nights: number;
  }>;
} {
  const unit =
    payload.unit && typeof payload.unit === "object"
      ? (payload.unit as ElpUnitPayload)
      : null;

  const availableRanges: Array<{ start_date: string; end_date: string }> = [];
  const rawAvail = Array.isArray(unit?.avail)
    ? (unit?.avail as ElpAvailEntry[])
    : [];
  for (const entry of rawAvail) {
    const start = parseIsoDate(entry.start_date);
    const end = parseIsoDate(entry.end_date);
    if (!start || !end) {
      continue;
    }
    availableRanges.push({ start_date: start, end_date: end });
  }

  const rateRows: Array<{
    start_date: string;
    end_date: string;
    amount: number;
  }> = [];
  const rawRates = Array.isArray(unit?.rates)
    ? (unit?.rates as ElpRateEntry[])
    : [];
  for (const entry of rawRates) {
    const start = parseIsoDate(entry.start_date);
    const end = parseIsoDate(entry.end_date);
    const amount = parseMoney(entry.amount);
    if (!start || !end || amount === null) {
      continue;
    }
    rateRows.push({ start_date: start, end_date: end, amount });
  }

  const minNightRules: Array<{
    start_date: string;
    end_date: string;
    min_nights: number;
  }> = [];
  const rawMinNights = Array.isArray(unit?.minnights)
    ? (unit?.minnights as ElpMinNightsEntry[])
    : [];
  for (const entry of rawMinNights) {
    const start = parseIsoDate(entry.start_date);
    const end = parseIsoDate(entry.end_date);
    const nights = parseNumberLike(entry.nights);
    if (!start || !end || nights === null || nights <= 0) {
      continue;
    }
    minNightRules.push({
      start_date: start,
      end_date: end,
      min_nights: Math.floor(nights),
    });
  }

  return { unit, availableRanges, rateRows, minNightRules };
}

function resolveMinNightsForDate(
  isoDate: string,
  rules: Array<{ start_date: string; end_date: string; min_nights: number }>,
): number | null {
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

async function fetchCheckAvailabilityPayload(input: {
  propId: string;
  detailUrl: string;
}): Promise<ElpCheckAvailabilityResponse | null> {
  const now = new Date();
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  );
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 7);

  const startIso = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}-${String(start.getUTCDate()).padStart(2, "0")}`;
  const endIso = `${end.getUTCFullYear()}-${String(end.getUTCMonth() + 1).padStart(2, "0")}-${String(end.getUTCDate()).padStart(2, "0")}`;

  const endpoint = new URL(`${BASE_HOST}/`);
  endpoint.searchParams.set("vrpjax", "1");
  endpoint.searchParams.set("act", "checkavailability");
  endpoint.searchParams.set("par", "1");
  endpoint.searchParams.set("obj[Arrival]", formatUsDate(startIso));
  endpoint.searchParams.set("obj[Departure]", formatUsDate(endIso));
  endpoint.searchParams.set("obj[Adults]", "");
  endpoint.searchParams.set("obj[Children]", "");
  endpoint.searchParams.set("obj[PropID]", input.propId);
  endpoint.searchParams.set("obj[v2]", "1");

  try {
    const response = await fetch(endpoint.toString(), {
      method: "GET",
      headers: {
        accept: "application/json,text/plain,*/*",
        "user-agent": USER_AGENT,
        referer: input.detailUrl,
        origin: BASE_HOST,
      },
    });

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as ElpCheckAvailabilityResponse;
    return payload;
  } catch {
    return null;
  }
}

async function discoverListings(
  page: Parameters<
    ScraperAdapter<ElpDetailRecord>["discoverListings"]
  >[0]["page"],
  anchorUrl: string,
  maxScrollSteps: number,
  reportProgress: (message: string) => void,
): Promise<ScrapedLink[]> {
  const sourceUrl = anchorUrl.includes("eluxuryproperties.com")
    ? anchorUrl
    : DEFAULT_ANCHOR_URL;

  const initialUrl = new URL(sourceUrl);
  initialUrl.searchParams.set("show", process.env.ELP30A_SHOW ?? "200");

  await page.goto(initialUrl.toString(), {
    waitUntil: "domcontentloaded",
    timeout: 120000,
  });
  await page.waitForTimeout(1200);

  const discovered = new Set<string>();
  const sourceByLink = new Map<string, string>();

  const firstHtml = await page.content();
  for (const link of extractUnitLinksFromHtml(firstHtml)) {
    discovered.add(link);
    sourceByLink.set(link, initialUrl.toString());
  }

  const inferredMaxPage = inferMaxPageFromHtml(firstHtml);
  const configuredMaxPagesRaw = Number(process.env.ELP30A_MAX_PAGES ?? "");
  const configuredMaxPages =
    Number.isFinite(configuredMaxPagesRaw) && configuredMaxPagesRaw > 0
      ? Math.floor(configuredMaxPagesRaw)
      : Math.max(30, Math.max(1, maxScrollSteps) * 5);
  const finalPage = Math.min(Math.max(inferredMaxPage, 1), configuredMaxPages);

  if (inferredMaxPage > 1) {
    reportProgress(`pagination detected; inferred pages=${inferredMaxPage}`);
  }

  let stalePages = 0;
  for (let pageNumber = 2; pageNumber <= finalPage; pageNumber += 1) {
    const pageUrl = buildSearchPageUrl(initialUrl.toString(), pageNumber);
    try {
      const response = await fetch(pageUrl, {
        method: "GET",
        headers: {
          "user-agent": USER_AGENT,
          accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          referer: initialUrl.toString(),
        },
      });

      if (!response.ok) {
        break;
      }

      const html = await response.text();
      const before = discovered.size;
      const links = extractUnitLinksFromHtml(html);
      for (const link of links) {
        discovered.add(link);
        sourceByLink.set(link, pageUrl);
      }

      if (links.length === 0 || discovered.size === before) {
        stalePages += 1;
      } else {
        stalePages = 0;
      }

      if (pageNumber % 3 === 0 || pageNumber === finalPage) {
        reportProgress(
          `search page ${pageNumber}/${finalPage}; links=${discovered.size}`,
        );
      }

      if (stalePages >= 2) {
        break;
      }
    } catch {
      break;
    }
  }

  return Array.from(discovered)
    .sort((left, right) => left.localeCompare(right))
    .map((link) => ({
      link,
      source_url: sourceByLink.get(link) ?? initialUrl.toString(),
      anchor_text: "view-unit",
    }));
}

async function fetchDetail(
  detailUrl: string,
  availabilityHorizonDays: number,
): Promise<ElpDetailRecord | null> {
  const normalizedDetailUrl = normalizeDetailUrl(detailUrl);
  if (!normalizedDetailUrl) {
    return null;
  }

  const slug = normalizedDetailUrl.split("/").filter(Boolean).at(-1) ?? "";

  try {
    const response = await fetch(normalizedDetailUrl, {
      method: "GET",
      redirect: "follow",
      headers: {
        "user-agent": USER_AGENT,
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
    const parsedTitle = extractFirst(
      /<title[^>]*>([\s\S]*?)<\/title>/i,
      html,
    ).slice(0, 240);
    const parsedH1 = extractFirst(/<h1[^>]*>([\s\S]*?)<\/h1>/i, html).slice(
      0,
      240,
    );

    if (isInvalidUnitPage({ title: parsedTitle, h1: parsedH1, html })) {
      return null;
    }

    const propId = parsePropIdFromHtml(html, slug);
    if (!propId) {
      return null;
    }

    const checkPayload = await fetchCheckAvailabilityPayload({
      propId,
      detailUrl: normalizedDetailUrl,
    });
    const htmlUnitData = parseHtmlUnitData(html);
    const calendarDays = parseCalendarDaysFromHtml(html);
    const parsedAvailabilityRaw = checkPayload
      ? parseCheckAvailabilityPayload(checkPayload)
      : {
          unit: null,
          availableRanges: [] as Array<{
            start_date: string;
            end_date: string;
          }>,
          rateRows: [] as Array<{
            start_date: string;
            end_date: string;
            amount: number;
          }>,
          minNightRules: [] as Array<{
            start_date: string;
            end_date: string;
            min_nights: number;
          }>,
        };

    const payloadSlug = String(parsedAvailabilityRaw.unit?.page_slug ?? "")
      .trim()
      .toLowerCase();
    const expectedSlug = slug.trim().toLowerCase();
    const payloadMatchesSlug =
      !payloadSlug || !expectedSlug || payloadSlug === expectedSlug;

    const parsedAvailability = payloadMatchesSlug
      ? parsedAvailabilityRaw
      : {
          unit: null,
          availableRanges: [] as Array<{
            start_date: string;
            end_date: string;
          }>,
          rateRows: [] as Array<{
            start_date: string;
            end_date: string;
            amount: number;
          }>,
          minNightRules: [] as Array<{
            start_date: string;
            end_date: string;
            min_nights: number;
          }>,
        };

    const unit = parsedAvailability.unit;
    const title = parsedTitle;
    const h1 = parsedH1;
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

    const descriptionExpanded = extractDescriptionExpanded(html);
    const amenities = parseAmenities(html, unit);
    const imageUrls = (() => {
      const galleryUrls = collectGalleryMediaUrls(html, normalizedDetailUrl);
      if (galleryUrls.length > 0) {
        return galleryUrls;
      }
      return collectMediaUrls(html, normalizedDetailUrl);
    })();

    const externalListingId = slug;
    const quoteListingId = propId;

    const city = String(unit?.City ?? htmlUnitData?.city ?? "").trim();
    const state = String(unit?.State ?? htmlUnitData?.state ?? "").trim();
    const addressParts = [
      String(unit?.Address1 ?? htmlUnitData?.address1 ?? "").trim(),
      String(unit?.Address2 ?? htmlUnitData?.address2 ?? "").trim(),
      city,
      state,
      String(unit?.PostalCode ?? htmlUnitData?.zip ?? "").trim(),
    ].filter(Boolean);
    const address = addressParts.join(", ");
    const locationLabel = [city, state].filter(Boolean).join(", ");
    const latitude =
      parseNumberLike(unit?.lat) ??
      htmlUnitData?.latitude ??
      parseSchemaNumber(html, "latitude");
    const longitude =
      parseNumberLike(unit?.long) ??
      htmlUnitData?.longitude ??
      parseSchemaNumber(html, "longitude");

    const htmlPath = resolve(
      OUTPUT_DETAILS_HTML_DIR,
      `${externalListingId}.html`,
    );
    await writeFile(htmlPath, `${html}\n`, "utf8");

    const availableSet = new Set<string>();
    for (const range of parsedAvailability.availableRanges) {
      for (const date of buildIsoDateRange(range.start_date, range.end_date)) {
        availableSet.add(date);
      }
    }

    const ratesByDate = new Map<string, number>();
    for (const row of parsedAvailability.rateRows) {
      for (const date of buildIsoDateRange(row.start_date, row.end_date)) {
        ratesByDate.set(date, row.amount);
      }
    }

    const now = new Date();
    const startDate = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
    );
    const endDate = new Date(startDate);
    endDate.setUTCDate(
      endDate.getUTCDate() + Math.max(1, availabilityHorizonDays),
    );

    const days: ElpDetailRecord["normalized_availability"]["days"] = [];
    const rateDays: ElpDetailRecord["normalized_rates"]["days"] = [];

    if (calendarDays.length > 0) {
      for (const day of calendarDays) {
        if (
          day.date <
          `${startDate.getUTCFullYear()}-${String(startDate.getUTCMonth() + 1).padStart(2, "0")}-${String(startDate.getUTCDate()).padStart(2, "0")}`
        ) {
          continue;
        }
        if (
          day.date >
          `${endDate.getUTCFullYear()}-${String(endDate.getUTCMonth() + 1).padStart(2, "0")}-${String(endDate.getUTCDate()).padStart(2, "0")}`
        ) {
          continue;
        }

        const minNights = resolveMinNightsForDate(
          day.date,
          parsedAvailability.minNightRules,
        );
        days.push({
          date: day.date,
          day_code: toDayCodeFromStatus(day.status_code),
          status_code: day.status_code,
          changeover_code: toChangeoverCodeFromStatus(day.status_code),
          is_available: day.is_available,
          is_available_for_checkin: day.is_available_for_checkin,
          is_available_for_checkout: day.is_available_for_checkout,
          booking_day_state: day.booking_day_state,
          min_nights_required: minNights,
        });
        rateDays.push({
          date: day.date,
          nightly_rate: ratesByDate.get(day.date) ?? null,
          min_nights: minNights,
          is_booked: day.booking_day_state === "blocked",
          changeover_code: toChangeoverCodeFromStatus(day.status_code),
          season_name: "",
        });
      }
    }

    if (days.length === 0) {
      const cursor = new Date(startDate);
      while (cursor <= endDate) {
        const isoDate = `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}-${String(cursor.getUTCDate()).padStart(2, "0")}`;
        const hasRate = ratesByDate.has(isoDate);
        const available =
          availableSet.size > 0 ? availableSet.has(isoDate) : hasRate;
        const minNights = resolveMinNightsForDate(
          isoDate,
          parsedAvailability.minNightRules,
        );

        days.push({
          date: isoDate,
          day_code: available ? "Y" : "N",
          status_code: available ? "A" : "U",
          changeover_code: available ? "C" : "X",
          is_available: available,
          is_available_for_checkin: available,
          is_available_for_checkout: available,
          booking_day_state: available ? "bookable" : "blocked",
          min_nights_required: minNights,
        });

        rateDays.push({
          date: isoDate,
          nightly_rate: ratesByDate.get(isoDate) ?? null,
          min_nights: minNights,
          is_booked: available ? false : true,
          changeover_code: available ? "C" : "X",
          season_name: "",
        });

        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
    }

    const daysWithRate = rateDays.filter((day) => day.nightly_rate !== null);
    const nightlyValues = daysWithRate
      .map((day) => day.nightly_rate)
      .filter((value): value is number => typeof value === "number");
    const minNightlyRate =
      nightlyValues.length > 0 ? Math.min(...nightlyValues) : null;
    const maxNightlyRate =
      nightlyValues.length > 0 ? Math.max(...nightlyValues) : null;
    const avgNightlyRate =
      nightlyValues.length > 0
        ? Math.round(
            (nightlyValues.reduce((sum, value) => sum + value, 0) /
              nightlyValues.length) *
              100,
          ) / 100
        : null;

    const counts = {
      available: days.filter((day) => day.status_code === "A").length,
      unavailable: days.filter((day) => day.status_code === "U").length,
      checkin_only: days.filter((day) => day.status_code === "I").length,
      checkout_only: days.filter((day) => day.status_code === "O").length,
      other: 0,
      booking_available: days.filter(
        (day) => day.booking_day_state === "bookable",
      ).length,
      booking_unavailable: days.filter(
        (day) => day.booking_day_state === "blocked",
      ).length,
      booking_unknown: 0,
    };

    const nameSource =
      String(unit?.Name ?? htmlUnitData?.name ?? "").trim() ||
      String(checkPayload?.Name ?? "").trim() ||
      h1 ||
      title ||
      slug;
    const name = stripHtml(nameSource).slice(0, 240);

    const descriptionSource =
      String(unit?.Description ?? "").trim() ||
      descriptionExpanded ||
      metaDescription;
    const description = stripHtml(
      decodeBasicHtmlEntities(descriptionSource),
    ).slice(0, 20000);
    const descriptionNormalized = normalizeForMatch(description);
    const titleNormalized = normalizeForMatch(name);

    return {
      external_listing_id: externalListingId,
      detail_url: normalizedDetailUrl,
      quote_context: {
        listing_id: quoteListingId,
        detail_url: normalizedDetailUrl,
      },
      fetched_at: new Date().toISOString(),
      html_path: htmlPath,
      title,
      h1,
      canonical_url: canonicalUrl,
      meta_description: metaDescription,
      description_expanded: description,
      rooms_guidance: false,
      amenities,
      location: {
        address,
        location_label: locationLabel,
        directions_url: address
          ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`
          : "",
        directions_daddr: address,
        latitude,
        longitude,
      },
      media_gallery: {
        image_count: imageUrls.length,
        image_urls: imageUrls,
      },
      normalized_matching_profile: {
        source: "pm_elp30a",
        external_listing_id: externalListingId,
        name,
        description,
        match_signals: {
          description_normalized: descriptionNormalized,
          description_sha256: hashSha256(descriptionNormalized),
          title_normalized: titleNormalized,
          title_sha256: hashSha256(titleNormalized),
          listing_composite_key: [
            "pm_elp30a",
            externalListingId,
            hashSha256(descriptionNormalized),
            hashSha256(titleNormalized),
          ].join("::"),
        },
      },
      normalized_availability: {
        source: "pm_elp30a",
        external_listing_id: externalListingId,
        captured_at: new Date().toISOString(),
        has_calendar_widget:
          html.includes("Calendar") ||
          calendarDays.length > 0 ||
          parsedAvailability.availableRanges.length > 0 ||
          parsedAvailability.rateRows.length > 0,
        min_night_rules: parsedAvailability.minNightRules,
        window_start: days[0]?.date ?? "",
        window_end: days[days.length - 1]?.date ?? "",
        code_legend: {
          A: "available",
          U: "unavailable",
          I: "checkin_only",
          O: "checkout_only",
          X: "other",
        },
        day_codes: days.map((day) => day.status_code).join(""),
        days,
        counts,
      },
      normalized_rates: {
        source: "pm_elp30a",
        external_listing_id: externalListingId,
        captured_at: new Date().toISOString(),
        currency: "USD",
        window_start: rateDays[0]?.date ?? "",
        window_end: rateDays[rateDays.length - 1]?.date ?? "",
        days: rateDays,
        stats: {
          days_with_rate: daysWithRate.length,
          min_nightly_rate: minNightlyRate,
          max_nightly_rate: maxNightlyRate,
          avg_nightly_rate: avgNightlyRate,
        },
      },
      availability_raw: {
        available_ranges:
          parsedAvailability.availableRanges.length > 0
            ? parsedAvailability.availableRanges
            : buildAvailableRangesFromDays(days),
        min_night_rules: parsedAvailability.minNightRules,
      },
      rates_raw: {
        rows: parsedAvailability.rateRows,
      },
      property_profile: {
        unit_id: String(htmlUnitData?.unitId ?? quoteListingId),
        property_code: String(htmlUnitData?.propertyCode ?? quoteListingId),
        unit_slug: String(unit?.page_slug ?? htmlUnitData?.slug ?? slug),
        unit_type: String(unit?.Type ?? htmlUnitData?.unitType ?? "").trim(),
        area: String(unit?.Area ?? "").trim(),
        location: String(unit?.Location ?? locationLabel).trim(),
        beds:
          parseNumberLike(unit?.Bedrooms) ??
          htmlUnitData?.beds ??
          parseSchemaNumber(html, "numberOfBedrooms"),
        baths:
          parseNumberLike(unit?.Bathrooms) ??
          htmlUnitData?.baths ??
          parseSchemaNumber(html, "numberOfBathroomsTotal"),
        sleeps: parseNumberLike(unit?.Sleeps) ?? htmlUnitData?.sleeps,
        city,
        state,
        zip: String(unit?.PostalCode ?? htmlUnitData?.zip ?? "").trim(),
      },
    };
  } catch {
    return null;
  }
}

export function createElp30AAdapter(): ScraperAdapter<ElpDetailRecord> {
  return {
    managerKey: "elp30a",
    scriptLabel: "elp30a",
    defaultAnchorUrl: DEFAULT_ANCHOR_URL,
    detailFetchDelayMs: Math.max(
      0,
      Number(process.env.ELP30A_DETAIL_FETCH_DELAY_MS ?? "300") || 300,
    ),
    detailFetchConcurrency: Math.max(
      1,
      Number(process.env.ELP30A_FETCH_CONCURRENCY ?? "4") || 4,
    ),
    availabilityHorizonDays: Math.max(
      1,
      Number(process.env.ELP30A_AVAILABILITY_HORIZON_DAYS ?? "486") || 486,
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
        context.reportProgress,
      );
    },
    async fetchDetail(context) {
      return fetchDetail(context.detailUrl, context.availabilityHorizonDays);
    },
    async runQuoteCapture(argv, progress) {
      const normalizedArgs = await normalizeAdapterQuoteScopeArgs(
        "elp30a",
        argv,
      );
      await runRuntimeAdapterQuoteCli(
        {
          adapterKey: "elp30a",
          executeSingleQuote: executeElp30aSingleQuote,
          defaultQuoteTimeoutMs: 20000,
          defaultQuoteMaxAttempts: 2,
          defaultEndpointPath: "/?vrpjax=1&act=checkavailability&par=1",
          defaultTaxPct: 0.12,
          defaultBaseNightly: 700,
        },
        normalizedArgs,
        progress,
      );
    },
    async runSingleQuoteObservation(input) {
      const result = await executeElp30aSingleQuote({
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
