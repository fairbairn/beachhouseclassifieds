import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Browser } from "playwright";

import { executeScenicstays30aSingleQuote } from "@/lib/pricing/quote-runtime/adapters/scenicstays30a";
import { runRuntimeAdapterQuoteCli } from "@/lib/pricing/quotes/shared/runtime-adapter-quote-runner";
import { normalizeAdapterQuoteScopeArgs } from "../quote-scope";
import type { DetailRecordBase, ScrapedLink, ScraperAdapter } from "../types";

type ScenicStaysDetailRecord = DetailRecordBase & {
  quote_context: {
    listing_id: string;
    unit_id: string;
    detail_url: string;
    quote_endpoint: string;
    property_name: string;
    room_type_id: string;
    hash: string;
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
  pricing_api_hints: {
    provider: "streamlinecore-api-request";
    endpoint_path: "/wp-admin/admin-ajax.php";
    method_names: {
      availability: "GetPropertyAvailabilityRawData";
      room_details: "GetPropertyRoomDetails";
      rates: "GetPropertyRates";
    };
    notes: string;
  };
};

const DEFAULT_ANCHOR_URL =
  "https://myscenicstays.com/rentals?type=2&mapsearch=1";
const OUTPUT_ROOT = resolve(
  process.cwd(),
  "src",
  "lib",
  "data",
  "external-sources",
  "scenicstays30a",
);
const OUTPUT_DETAILS_HTML_DIR = resolve(OUTPUT_ROOT, "details", "html");

const MAX_CLICK_CYCLES = 80;
const CLICK_WAIT_MS = 1200;
const GROWTH_POLL_ROUNDS = 10;
const MAX_NO_GROWTH_CYCLES = 5;

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

function parsePositiveNumberLike(
  value: string | number | null | undefined,
): number | null {
  const parsed = parseNumberLike(value);
  if (parsed === null || parsed <= 0) {
    return null;
  }
  return parsed;
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

function sanitizeSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
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

function extractWidgetInfoLabelCount(
  html: string,
  labelPattern: RegExp,
): string {
  const blocks = html.matchAll(
    /<div[^>]*class=["'][^"']*be-property-widget-info-label[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi,
  );

  for (const block of blocks) {
    const blockHtml = block[1] ?? "";
    const labelText = stripHtml(blockHtml).replace(/\s+/g, " ").trim();
    if (!labelPattern.test(labelText)) {
      continue;
    }

    const count = extractFirst(
      /be-property-widget-info-label-count[^>]*>\s*(\d+(?:\.\d+)?)\s*</i,
      blockHtml,
    );
    if (count) {
      return count;
    }
  }

  return "";
}

function extractWidgetCountByLabelText(
  html: string,
  labelPattern: RegExp,
): string {
  const matches = html.matchAll(
    /be-property-widget-info-label-count[^>]*>\s*(\d+(?:\.\d+)?)\s*<\/span>[\s\S]*?be-property-widget-info-label-text[^>]*>\s*([^<]+)\s*<\/span>/gi,
  );

  for (const match of matches) {
    const count = (match[1] ?? "").trim();
    const label = (match[2] ?? "").trim();
    if (count && labelPattern.test(label)) {
      return count;
    }
  }

  return "";
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

    const rateMatch = body.match(
      /class=["'][^"']*property-rate[^"']*["'][^>]*>([\s\S]*?)<\/span>/i,
    );
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

type StreamlineRoomDetailsPayload = {
  data?: {
    room_details?: Array<{
      name?: unknown;
      group?: Array<{
        name?: unknown;
        amenity?: Array<{
          name?: unknown;
        }>;
      }>;
    }>;
  };
};

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

function extractRoomDetailsGuidanceFromApi(
  payload: StreamlineRoomDetailsPayload | null,
): string[] {
  const hasSleepSignal = (value: string): boolean =>
    /king|queen|full|double|twin|single|bunk|trundle|murphy|sofa\s*bed|daybed|futon|sleeps?/i.test(
      value,
    );

  const out: string[] = [];
  const seen = new Set<string>();
  const rooms = Array.isArray(payload?.data?.room_details)
    ? payload.data.room_details
    : [];

  for (const room of rooms) {
    const roomName = String(room?.name ?? "")
      .replace(/\s+/g, " ")
      .trim();
    if (!roomName) {
      continue;
    }

    const amenities: string[] = [];
    const groups = Array.isArray(room?.group) ? room.group : [];
    for (const group of groups) {
      const entries = Array.isArray(group?.amenity) ? group.amenity : [];
      for (const entry of entries) {
        const value = String(entry?.name ?? "")
          .replace(/\s+/g, " ")
          .trim();
        if (value) {
          amenities.push(value);
        }
      }
    }

    const beds = dedupePreserveOrder(amenities).join(" + ");
    const line = beds ? `${roomName}: ${beds}` : roomName;
    const signal = `${roomName} ${beds}`.toLowerCase();
    if (!hasSleepSignal(signal) || seen.has(line)) {
      continue;
    }

    seen.add(line);
    out.push(line);
  }

  return out.slice(0, 80);
}

function extractRoomDetailsGuidanceFromDescription(
  description: string,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const prepared = description
    .replace(/\s+/g, " ")
    .replace(/\b(Bed\s*\d+\s*:)/gi, "\n$1")
    .replace(/\b((?:Primary|Master|Guest)\s*Bedroom\s*:)/gi, "\n$1")
    .replace(/\b(Bunk\s*Room\s*:)/gi, "\n$1");

  const lines = prepared
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const candidates: string[] = [];
  for (const line of lines) {
    if (line.length <= 280) {
      candidates.push(line);
      continue;
    }

    const segments = line
      .split(/(?<=[.!?])\s+|\s+-\s+|\s\|\s+/)
      .map((segment) => segment.replace(/\s+/g, " ").trim())
      .filter(Boolean);

    if (segments.length > 0) {
      candidates.push(...segments);
    }
  }

  for (const line of candidates) {
    if (line.length < 10 || line.length > 320) {
      continue;
    }

    const normalized = line.toLowerCase();
    const hasRoomLabel =
      normalized.includes("bedroom") ||
      /^bed\s*\d+\s*:/i.test(normalized) ||
      normalized.includes("bunk room");
    if (!hasRoomLabel) {
      continue;
    }
    if (
      !/king|queen|full|double|twin|single|bunk|trundle|murphy|sofa\s*bed|daybed|futon|sleeps?/i.test(
        normalized,
      )
    ) {
      continue;
    }

    const cleaned = line
      .replace(/^[-*]\s*/, "")
      .replace(/\s*:\s*/g, ": ")
      .trim();
    if (seen.has(cleaned)) {
      continue;
    }

    seen.add(cleaned);
    out.push(cleaned);
  }

  return out.slice(0, 80);
}

function extractRoomDetailsGuidanceFromGalleryCaptions(html: string): string[] {
  const matches = Array.from(
    html.matchAll(/data-caption=["']([^"']+)["']/gi),
  ).map((match) =>
    stripHtml(match[1] ?? "")
      .replace(/\s+/g, " ")
      .trim(),
  );

  const out: string[] = [];
  const seen = new Set<string>();

  for (const caption of matches) {
    if (!caption || caption.length > 220) {
      continue;
    }

    const normalized = caption.toLowerCase();
    const hasRoomSignal =
      normalized.includes("bedroom") ||
      normalized.includes("bunk") ||
      normalized.includes("trundle") ||
      normalized.includes("king") ||
      normalized.includes("queen") ||
      normalized.includes("twin");
    if (!hasRoomSignal) {
      continue;
    }

    const cleaned = caption
      .replace(/^[-*]\s*/, "")
      .replace(/\s*:\s*/g, ": ")
      .trim();
    if (seen.has(cleaned)) {
      continue;
    }

    seen.add(cleaned);
    out.push(cleaned);
  }

  return out.slice(0, 80);
}

function extractLowConfidenceRoomGuidance(
  description: string,
  beds: number | null,
  sleeps: number | null,
): string[] {
  const sentence = description
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .find((part) => /bedroom|bunk|trundle|king|queen|twin|sleeps?/i.test(part));

  if (sentence) {
    return [sentence.slice(0, 280)];
  }

  const summaryParts: string[] = [];
  if (beds !== null && Number.isFinite(beds)) {
    summaryParts.push(`${beds} bedrooms`);
  }
  if (sleeps !== null && Number.isFinite(sleeps)) {
    summaryParts.push(`sleeps ${sleeps}`);
  }

  if (summaryParts.length > 0) {
    return [
      `Listing summary (low confidence): ${summaryParts.join(", ")} from Scenic property widget and description cues.`,
    ];
  }

  return [];
}

function extractStoredDatesAvailability(
  html: string,
): Array<{ date: string; code: string }> {
  const tagMatch = html.match(/<div[^>]+id=["']pdpStoredDates["'][^>]*>/i);
  if (!tagMatch?.[0]) {
    return [];
  }

  const tag = tagMatch[0];
  const readAttr = (name: string): string => {
    const regex = new RegExp(`${name}=["']([\\s\\S]*?)["']`, "i");
    return (tag.match(regex)?.[1] ?? "").trim();
  };

  const parseDateList = (value: string): string[] => {
    return value
      .split(",")
      .map((entry) => normalizeDateLikeToIso(entry))
      .filter(Boolean);
  };

  const unavailableDates = parseDateList(readAttr("data-unavailable-dates"));
  const checkinDates = parseDateList(readAttr("data-checkin-dates"));
  const checkoutDates = parseDateList(readAttr("data-checkout-dates"));

  const rows: Array<{ date: string; code: string }> = [];
  for (const date of unavailableDates) {
    rows.push({ date, code: "N" });
  }
  for (const date of checkinDates) {
    rows.push({ date, code: "Y" });
  }
  for (const date of checkoutDates) {
    rows.push({ date, code: "Y" });
  }

  return rows;
}

function mergeAvailabilityDays(
  ...groups: Array<Array<{ date: string; code: string }>>
): Array<{ date: string; code: string }> {
  const merged = new Map<string, string>();

  for (const group of groups) {
    for (const day of group) {
      if (!day?.date) {
        continue;
      }

      const normalizedCode =
        day.code === "Y" ? "Y" : day.code === "N" ? "N" : "";
      if (!normalizedCode) {
        continue;
      }

      const existing = merged.get(day.date);
      if (!existing || normalizedCode === "Y") {
        merged.set(day.date, normalizedCode);
      }
    }
  }

  return Array.from(merged.entries())
    .map(([date, code]) => ({ date, code }))
    .sort((left, right) => left.date.localeCompare(right.date));
}

function mergeRateDays(
  ...groups: Array<
    Array<{
      date: string;
      nightly_rate: number | null;
      min_nights: number | null;
      is_booked: boolean | null;
      changeover_code: string;
      season_name: string;
    }>
  >
): Array<{
  date: string;
  nightly_rate: number | null;
  min_nights: number | null;
  is_booked: boolean | null;
  changeover_code: string;
  season_name: string;
}> {
  const merged = new Map<
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

  for (const group of groups) {
    for (const day of group) {
      if (!day?.date) {
        continue;
      }

      const existing = merged.get(day.date);
      if (!existing) {
        merged.set(day.date, day);
        continue;
      }

      const existingHasRate = typeof existing.nightly_rate === "number";
      const nextHasRate = typeof day.nightly_rate === "number";
      if (!existingHasRate && nextHasRate) {
        merged.set(day.date, day);
      }
    }
  }

  return Array.from(merged.values()).sort((left, right) =>
    left.date.localeCompare(right.date),
  );
}

function extractDescriptionExpanded(html: string): string {
  const fromModernSection = extractFirst(
    /<div[^>]+class=["'][^"']*pdp-section\s+pdp-description[^"']*["'][^>]*>[\s\S]*?<div[^>]+class=["'][^"']*be-read-more-wrap[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    html,
  );
  if (fromModernSection) {
    return fromModernSection.slice(0, 20000);
  }

  const fromLegacySection = extractSectionBetween(
    html,
    'class="property_description"',
    "</section><!--End description-->",
  );
  const legacy = stripHtml(fromLegacySection).replace(/^description\s+/i, "");
  if (legacy) {
    return legacy.slice(0, 20000);
  }

  return "";
}

async function collectInteractiveDetailSnapshot(
  browser: Browser,
  detailUrl: string,
  maxCalendarAdvanceMonths: number,
): Promise<{
  html: string;
  availabilityDays: Array<{ date: string; code: string }>;
  rateDays: Array<{
    date: string;
    nightly_rate: number | null;
    min_nights: number | null;
    is_booked: boolean | null;
    changeover_code: string;
    season_name: string;
  }>;
}> {
  const page = await browser.newPage();

  try {
    await page.goto(detailUrl, {
      waitUntil: "domcontentloaded",
      timeout: 120000,
    });
    await page.waitForTimeout(1200);

    const clickByText = async (needle: string): Promise<void> => {
      await page.evaluate((targetText) => {
        const target = targetText.toLowerCase();
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
          const dataMore = (element.getAttribute("data-text-more") ?? "")
            .toLowerCase()
            .trim();
          const combined = `${text} ${aria} ${value} ${dataMore}`;
          if (combined.includes(target)) {
            element.click();
            return;
          }
        }
      }, needle);

      await page.waitForTimeout(180);
    };

    await clickByText("read more");
    await clickByText("show more rates");
    await clickByText("show all amenities");

    const availabilityMap = new Map<string, string>();
    const rateMap = new Map<
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

    const captureVisibleCalendars = async (): Promise<void> => {
      const snapshot = await page.evaluate(() => {
        const availability: Array<{ date: string; code: string }> = [];
        const cells = document.querySelectorAll(
          ".pdp-availability-calendar td[data-date], .choose-your-dates td[data-date], .booking-calendar td[data-date]",
        );
        for (const cell of Array.from(cells)) {
          const element = cell as HTMLElement;
          const rawDate = element.getAttribute("data-date") ?? "";
          if (!rawDate) {
            continue;
          }

          const classes = (element.className ?? "").toLowerCase();
          let code = "";
          if (
            classes.includes("available") ||
            classes.includes("check-in") ||
            classes.includes("check-out")
          ) {
            code = "Y";
          } else if (
            classes.includes("booked") ||
            classes.includes("unavailable")
          ) {
            code = "N";
          }

          if (code) {
            availability.push({ date: rawDate, code });
          }
        }

        const rates: Array<{ date: string; nightlyRateRaw: string }> = [];
        const rows = document.querySelectorAll(".pdp-rates-table tbody tr");
        for (const row of Array.from(rows)) {
          const cells = row.querySelectorAll("td");
          if (cells.length < 3) {
            continue;
          }

          const dateText = (cells[0]?.textContent ?? "").trim();
          const rateText = (cells[2]?.textContent ?? "").trim();
          if (!dateText || !rateText) {
            continue;
          }
          rates.push({ date: dateText, nightlyRateRaw: rateText });
        }

        return { availability, rates };
      });

      for (const day of snapshot.availability) {
        const date = normalizeDateLikeToIso(day.date);
        const code = day.code === "Y" ? "Y" : day.code === "N" ? "N" : "";
        if (!date || !code) {
          continue;
        }

        const existing = availabilityMap.get(date);
        if (!existing || code === "Y") {
          availabilityMap.set(date, code);
        }
      }

      for (const row of snapshot.rates) {
        const date = normalizeDateLikeToIso(row.date);
        if (!date) {
          continue;
        }

        const rate = parseCurrencyLike(row.nightlyRateRaw);
        const existing = rateMap.get(date);
        if (!existing || (existing.nightly_rate === null && rate !== null)) {
          rateMap.set(date, {
            date,
            nightly_rate: rate,
            min_nights: null,
            is_booked: null,
            changeover_code: "",
            season_name: "",
          });
        }
      }
    };

    await captureVisibleCalendars();

    const maxAdvances = Math.max(0, maxCalendarAdvanceMonths);
    for (let month = 0; month < maxAdvances; month += 1) {
      const advanced = await page.evaluate(() => {
        const candidates = Array.from(
          document.querySelectorAll(
            ".pdp-availability-calendar .swiper-button-next-btn, .choose-your-dates .swiper-button-next-btn, .swiper-button-next-btn[aria-label*='Calendar'], .swiper-button-next-btn",
          ),
        );

        for (const node of candidates) {
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

          element.click();
          return true;
        }

        return false;
      });

      if (!advanced) {
        break;
      }

      await page.waitForTimeout(140);
      await captureVisibleCalendars();
    }

    return {
      html: await page.content(),
      availabilityDays: Array.from(availabilityMap.entries())
        .map(([date, code]) => ({ date, code }))
        .sort((left, right) => left.date.localeCompare(right.date)),
      rateDays: Array.from(rateMap.values()).sort((left, right) =>
        left.date.localeCompare(right.date),
      ),
    };
  } finally {
    await page.close().catch(() => undefined);
  }
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
  let noGrowthCycles = 0;

  for (let cycle = 0; cycle < maxCycles; cycle += 1) {
    const beforeIdCount = idSet.size;
    const beforeDetailCount = detailUrlSet.size;
    const beforeScrollHeight = await page.evaluate(
      () => document.body.scrollHeight,
    );

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

    if (loadMoreVisible) {
      await page.evaluate(() => {
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
            return;
          }
        }
      });
    }

    await page.evaluate(() => {
      window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" });
    });

    await page.waitForTimeout(CLICK_WAIT_MS);
    await page.evaluate(() => {
      window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" });
    });

    await page.waitForTimeout(Math.max(700, scrollPauseMs));
    await collectDetailUrls();

    let observedGrowth =
      idSet.size > beforeIdCount || detailUrlSet.size > beforeDetailCount;

    for (let poll = 0; poll < GROWTH_POLL_ROUNDS; poll += 1) {
      const grew =
        idSet.size > beforeIdCount || detailUrlSet.size > beforeDetailCount;
      if (grew) {
        observedGrowth = true;
        break;
      }
      await page.waitForTimeout(350);
      await collectDetailUrls();
    }

    const afterScrollHeight = await page.evaluate(
      () => document.body.scrollHeight,
    );
    if (afterScrollHeight > beforeScrollHeight) {
      observedGrowth = true;
    }

    if (observedGrowth) {
      noGrowthCycles = 0;
    } else {
      noGrowthCycles += 1;
    }

    if (noGrowthCycles >= MAX_NO_GROWTH_CYCLES) {
      break;
    }

    if ((cycle + 1) % 3 === 0) {
      reportProgress(
        `discovery cycle ${cycle + 1}/${maxCycles}; ids=${idSet.size}; links=${detailUrlSet.size}; no-growth=${noGrowthCycles}`,
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
  browser: Browser,
  detailUrl: string,
  availabilityHorizonDays: number,
  maxCalendarAdvanceMonths: number,
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
    const detailOrigin = new URL(detailUrl).origin;
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

    const interactiveSnapshot = await collectInteractiveDetailSnapshot(
      browser,
      detailUrl,
      maxCalendarAdvanceMonths,
    ).catch(() => ({
      html: "",
      availabilityDays: [] as Array<{ date: string; code: string }>,
      rateDays: [] as Array<{
        date: string;
        nightly_rate: number | null;
        min_nights: number | null;
        is_booked: boolean | null;
        changeover_code: string;
        season_name: string;
      }>,
    }));

    const parsingHtml = interactiveSnapshot.html || html;

    const title = extractFirst(
      /<title[^>]*>([\s\S]*?)<\/title>/i,
      parsingHtml,
    ).slice(0, 240);
    const h1 = extractFirst(/<h1[^>]*>([\s\S]*?)<\/h1>/i, parsingHtml).slice(
      0,
      240,
    );
    const canonicalUrl =
      extractFirst(
        /<link[^>]+rel=["']canonical["'][^>]+href=["']([\s\S]*?)["'][^>]*>/i,
        parsingHtml,
      ) || detailUrl;

    const metaDescription =
      extractFirst(
        /<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["'][^>]*>/i,
        parsingHtml,
      ).slice(0, 2000) ||
      extractFirst(
        /<meta[^>]+content=["']([\s\S]*?)["'][^>]+name=["']description["'][^>]*>/i,
        parsingHtml,
      ).slice(0, 2000);

    const jsonLdObjects = extractJsonLdObjects(parsingHtml);
    const lodgingJsonLd =
      jsonLdObjects.find((item) => {
        const itemType = String(item["@type"] ?? "").toLowerCase();
        return (
          itemType.includes("lodging") || itemType.includes("accommodation")
        );
      }) ??
      jsonLdObjects[0] ??
      null;

    const descriptionExpanded =
      extractDescriptionExpanded(parsingHtml) ||
      stripHtml(
        typeof lodgingJsonLd?.description === "string"
          ? lodgingJsonLd.description
          : metaDescription,
      ).slice(0, 20000);

    const amenitiesSection = extractSectionBetween(
      parsingHtml,
      'id="property-amenities"',
      "</section>",
    );

    const modernAmenities = Array.from(
      parsingHtml.matchAll(
        /<span[^>]+class=["'][^"']*pdp-amenities-item-text[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi,
      ),
      (match) => stripHtml(match[1] ?? "").trim(),
    ).filter(Boolean);

    const categoryMap: Record<string, string[]> = {};
    if (modernAmenities.length > 0) {
      categoryMap.General = Array.from(new Set(modernAmenities));
    }

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

    const amenitiesAll = Object.values(categoryMap).flat().filter(Boolean);

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
      longitude: parseNumberLike(
        jsonLdGeo?.longitude as string | number | null,
      ),
    };

    const widgetStreet = extractWidgetDataAttr(parsingHtml, "data-straddress1");
    const widgetCity = extractWidgetDataAttr(parsingHtml, "data-strlocation");
    const widgetLatitude = parseNumberLike(
      extractWidgetDataAttr(parsingHtml, "data-latitude"),
    );
    const widgetLongitude = parseNumberLike(
      extractWidgetDataAttr(parsingHtml, "data-longitude"),
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

    const beds = parsePositiveNumberLike(
      (lodgingJsonLd?.numberOfBedrooms as string | number | null) ?? null,
    );
    const baths = parsePositiveNumberLike(
      (lodgingJsonLd?.numberOfBathroomsTotal as string | number | null) ??
        (lodgingJsonLd?.numberOfBathrooms as string | number | null) ??
        null,
    );
    const sleeps = parsePositiveNumberLike(
      (lodgingJsonLd?.maximumAttendeeCapacity as string | number | null) ??
        ((lodgingJsonLd?.occupancy as Record<string, unknown> | null)
          ?.maxValue as string | number | null) ??
        null,
    );

    const bedsFromWidgetLabels = parsePositiveNumberLike(
      extractWidgetCountByLabelText(parsingHtml, /\bbedrooms?\b/i) ||
        extractWidgetInfoLabelCount(parsingHtml, /\bbedrooms?\b/i),
    );
    const bathsFromWidgetLabels = parsePositiveNumberLike(
      extractWidgetCountByLabelText(parsingHtml, /\bbaths?|bathrooms?\b/i) ||
        extractWidgetInfoLabelCount(parsingHtml, /\bbaths?|bathrooms?\b/i),
    );
    const sleepsFromWidgetLabels = parsePositiveNumberLike(
      extractWidgetCountByLabelText(parsingHtml, /\bguests?|sleeps?\b/i) ||
        extractWidgetInfoLabelCount(parsingHtml, /\bguests?|sleeps?\b/i),
    );

    const bedsResolved =
      beds ??
      parsePositiveNumberLike(extractWidgetDataAttr(html, "data-dblbeds")) ??
      bedsFromWidgetLabels;
    const bathsResolved = baths ?? bathsFromWidgetLabels;
    const sleepsResolved =
      sleeps ??
      parsePositiveNumberLike(
        extractWidgetDataAttr(parsingHtml, "data-intoccu"),
      ) ??
      sleepsFromWidgetLabels;

    const mediaUrls = collectMediaUrls(parsingHtml, detailUrl, jsonLdObjects);

    const widgetUnitId = extractWidgetUnitId(parsingHtml);
    const numericUnitIdRaw =
      (widgetUnitId && /^\d+$/.test(widgetUnitId) ? widgetUnitId : "") ||
      (rentalIdFromUrl && /^\d+$/.test(rentalIdFromUrl) ? rentalIdFromUrl : "");
    const normalizedSlug = sanitizeSlug(rentalSlugFromUrl);
    const fallbackSlug = sanitizeSlug(
      normalizeLink(detailUrl).split("/").filter(Boolean).at(-1) || "",
    );
    const externalListingId =
      normalizedSlug || fallbackSlug || numericUnitIdRaw || "unknown-listing";

    const numericUnitId =
      numericUnitIdRaw && /^\d+$/.test(numericUnitIdRaw)
        ? Number(numericUnitIdRaw)
        : null;

    let roomDetailsApiPayload: StreamlineRoomDetailsPayload | null = null;
    if (numericUnitId !== null) {
      const roomDetailsApiUrl = `${detailOrigin}/wp-admin/admin-ajax.php?${new URLSearchParams(
        {
          action: "streamlinecore-api-request",
          params: JSON.stringify({
            methodName: "GetPropertyRoomDetails",
            params: {
              unit_id: numericUnitId,
              use_room_type_logic: "no",
              standard_pricing: 1,
            },
          }),
        },
      ).toString()}`;

      const roomDetailsResponse = await fetch(roomDetailsApiUrl, {
        method: "GET",
        headers,
      });

      if (roomDetailsResponse.status === 200) {
        const raw = await roomDetailsResponse.text();
        try {
          roomDetailsApiPayload = JSON.parse(
            raw,
          ) as StreamlineRoomDetailsPayload;
        } catch {
          // Ignore malformed room-details payload.
        }
      }
    }

    const htmlPath = resolve(
      OUTPUT_DETAILS_HTML_DIR,
      `${externalListingId}.html`,
    );
    await writeFile(htmlPath, `${parsingHtml}\n`, "utf8");

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
    const allAvailabilityDaysFromStored = mergeAvailabilityDays(
      extractStoredDatesAvailability(html),
      extractStoredDatesAvailability(parsingHtml),
    );
    const allAvailabilityDaysFromHtml = mergeAvailabilityDays(
      parseAvailabilityDaysFromCalendarHtml(html),
      parseAvailabilityDaysFromCalendarHtml(parsingHtml),
    );
    const allAvailabilityDays = mergeAvailabilityDays(
      allAvailabilityDaysFromApi,
      allAvailabilityDaysFromStored,
      allAvailabilityDaysFromHtml,
      interactiveSnapshot.availabilityDays,
    );

    const now = new Date();
    const today = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const horizonDate = new Date(today);
    horizonDate.setUTCDate(horizonDate.getUTCDate() + availabilityHorizonDays);

    const knownCodesByDate = new Map<string, string>();
    for (const day of allAvailabilityDays) {
      const dayDate = new Date(`${day.date}T00:00:00.000Z`);
      if (dayDate < today || dayDate > horizonDate) {
        continue;
      }
      const code = day.code === "Y" ? "Y" : day.code === "N" ? "N" : "";
      if (!code) {
        continue;
      }

      const existing = knownCodesByDate.get(day.date);
      if (!existing || code === "Y") {
        knownCodesByDate.set(day.date, code);
      }
    }

    const completeWindowDays: Array<{ date: string; code: string }> = [];
    for (
      let cursor = new Date(today);
      cursor <= horizonDate;
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    ) {
      const date = formatDateIso(cursor);
      completeWindowDays.push({
        date,
        code: knownCodesByDate.get(date) ?? "U",
      });
    }

    const ratesStartIso = completeWindowDays[0]?.date ?? formatDateIso(today);
    const ratesEndIso =
      completeWindowDays[completeWindowDays.length - 1]?.date ??
      formatDateIso(horizonDate);
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
      normalizedRateDays = mergeRateDays(
        parseRateDaysFromCalendarHtml(html),
        parseRateDaysFromCalendarHtml(parsingHtml),
      );
    }

    normalizedRateDays = mergeRateDays(
      normalizedRateDays,
      interactiveSnapshot.rateDays,
    );

    const nightlyRates = normalizedRateDays
      .map((day) => day.nightly_rate)
      .filter((value): value is number => typeof value === "number");

    const changeoverByDate = new Map<string, "I" | "O" | "C">();
    for (const day of normalizedRateDays) {
      const normalizedCode = day.changeover_code.trim().toUpperCase();
      if (
        (normalizedCode === "I" ||
          normalizedCode === "O" ||
          normalizedCode === "C") &&
        !changeoverByDate.has(day.date)
      ) {
        changeoverByDate.set(day.date, normalizedCode);
      }
    }

    const daysWithRate = nightlyRates.length;
    const sumRates = nightlyRates.reduce((sum, value) => sum + value, 0);
    const minNightlyRate = daysWithRate > 0 ? Math.min(...nightlyRates) : null;
    const maxNightlyRate = daysWithRate > 0 ? Math.max(...nightlyRates) : null;
    const avgNightlyRate =
      daysWithRate > 0 ? Number((sumRates / daysWithRate).toFixed(2)) : null;

    const normalizedDays = completeWindowDays.map((day, index) => {
      const previousDay = index > 0 ? completeWindowDays[index - 1] : undefined;
      const bookingDayState: "bookable" | "blocked" | "unknown" =
        day.code === "Y"
          ? "bookable"
          : day.code === "N"
            ? "blocked"
            : "unknown";

      const changeoverHint = changeoverByDate.get(day.date) ?? null;
      const isCheckInAllowed =
        changeoverHint === "I" ||
        changeoverHint === "C" ||
        (changeoverHint === null && day.code === "Y");
      const isCheckOutAllowed =
        changeoverHint === "O" ||
        changeoverHint === "C" ||
        (changeoverHint === null &&
          (day.code === "Y" ||
            (day.code === "N" && previousDay?.code === "Y")));

      const statusCode: "A" | "U" | "I" | "O" | "X" =
        day.code !== "Y" && day.code !== "N"
          ? "X"
          : isCheckInAllowed && isCheckOutAllowed
            ? "A"
            : isCheckInAllowed
              ? "I"
              : isCheckOutAllowed
                ? "O"
                : "U";

      return {
        date: day.date,
        is_available: day.code === "Y",
        is_available_for_checkin: isCheckInAllowed,
        is_available_for_checkout: isCheckOutAllowed,
        status_code: statusCode,
        booking_day_state: bookingDayState,
      };
    });

    const available = completeWindowDays.filter(
      (day) => day.code === "Y",
    ).length;
    const notAvailable = completeWindowDays.filter(
      (day) => day.code === "N",
    ).length;
    const other = normalizedDays.length - available - notAvailable;

    const description =
      descriptionExpanded || stripHtml(metaDescription).slice(0, 20000);
    const roomDetailsGuidanceFromApi = extractRoomDetailsGuidanceFromApi(
      roomDetailsApiPayload,
    );
    const roomDetailsGuidanceFromGallery =
      extractRoomDetailsGuidanceFromGalleryCaptions(parsingHtml);
    const roomDetailsGuidanceFromDescription =
      extractRoomDetailsGuidanceFromDescription(description);
    const roomDetailsGuidanceLowConfidence = extractLowConfidenceRoomGuidance(
      description,
      bedsResolved,
      sleepsResolved,
    );
    const roomDetailsGuidance =
      roomDetailsGuidanceFromApi.length > 0
        ? roomDetailsGuidanceFromApi
        : roomDetailsGuidanceFromGallery.length > 0
          ? roomDetailsGuidanceFromGallery
          : roomDetailsGuidanceFromDescription.length > 0
            ? roomDetailsGuidanceFromDescription
            : roomDetailsGuidanceLowConfidence;
    const name = stripHtml(h1 || title).slice(0, 240);
    const descriptionNormalized = normalizeForMatch(description);
    const titleNormalized = normalizeForMatch(name);

    return {
      external_listing_id: externalListingId,
      detail_url: detailUrl,
      fetched_at: new Date().toISOString(),
      quote_context: {
        listing_id: numericUnitIdRaw || externalListingId,
        unit_id: numericUnitIdRaw || externalListingId,
        detail_url: detailUrl,
        quote_endpoint: `${new URL(detailUrl).origin}/ajax/quote`,
        property_name: h1 || title || externalListingId,
        room_type_id: "",
        hash: "",
      },
      title,
      h1,
      canonical_url: canonicalUrl,
      meta_description: metaDescription,
      description_expanded: descriptionExpanded,
      rooms_guidance: roomDetailsGuidance,
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
        unit_id: numericUnitIdRaw || externalListingId,
        property_code: numericUnitIdRaw || externalListingId,
        beds: bedsResolved,
        baths: bathsResolved,
        sleeps: sleepsResolved,
        city: location.city,
        state: location.state,
        zip: location.postal_code,
      },
      normalized_matching_profile: {
        source: "pm_scenicstays30a",
        external_listing_id: externalListingId,
        name,
        description,
        match_signals: {
          description_normalized: descriptionNormalized,
          description_sha256: hashSha256(descriptionNormalized),
          title_normalized: titleNormalized,
          title_sha256: hashSha256(titleNormalized),
          listing_composite_key: [
            "pm_scenicstays30a",
            externalListingId,
            hashSha256(descriptionNormalized),
            hashSha256(titleNormalized),
          ].join("::"),
        },
      },
      normalized_availability: {
        source: "pm_scenicstays30a",
        external_listing_id: externalListingId,
        captured_at: new Date().toISOString(),
        window_start: completeWindowDays[0]?.date ?? "",
        window_end:
          completeWindowDays[completeWindowDays.length - 1]?.date ?? "",
        code_legend: {
          Y: "available",
          N: "not_available",
        },
        day_codes: completeWindowDays.map((day) => day.code).join(""),
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
        external_listing_id: externalListingId,
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
      pricing_api_hints: {
        provider: "streamlinecore-api-request",
        endpoint_path: "/wp-admin/admin-ajax.php",
        method_names: {
          availability: "GetPropertyAvailabilityRawData",
          room_details: "GetPropertyRoomDetails",
          rates: "GetPropertyRates",
        },
        notes:
          "GetPropertyRoomDetails is used as the primary rooms guidance source; description parsing remains as fallback when room details are empty.",
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
      Number(process.env.SCENICSTAYS30A_DETAIL_FETCH_DELAY_MS ?? "250") || 250,
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
        const hasRentalSlug = !!extractRentalSlugFromDetailUrl(
          parsed.toString(),
        );
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
      return fetchDetail(
        context.browser,
        context.detailUrl,
        context.availabilityHorizonDays,
        context.maxCalendarAdvanceMonths,
      );
    },
    async runQuoteCapture(argv, progress) {
      const normalizedArgs = await normalizeAdapterQuoteScopeArgs(
        "scenicstays30a",
        argv,
      );
      await runRuntimeAdapterQuoteCli(
        {
          adapterKey: "scenicstays30a",
          executeSingleQuote: executeScenicstays30aSingleQuote,
          defaultListingConcurrency: 1,
          defaultQuoteConcurrency: 1,
          defaultQuoteTimeoutMs: 12000,
          defaultQuoteMaxAttempts: 4,
          defaultEndpointPath: "/api/nrbe/reservation-quotes.json",
          defaultTaxPct: 0.12,
          defaultBaseNightly: 450,
        },
        normalizedArgs,
        progress,
      );
    },
    async runSingleQuoteObservation(input) {
      const result = await executeScenicstays30aSingleQuote({
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
          reason: result.error.message,
        },
      };
    },
  };
}
