import { executeCoastproperties30aSingleQuote } from "@/lib/pricing/quote-runtime/adapters/coastproperties30a";
import { runRuntimeAdapterQuoteCli } from "@/lib/pricing/quotes/shared/runtime-adapter-quote-runner";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { normalizeAdapterQuoteScopeArgs } from "../quote-scope";
import {
  navigateDetailWithChallenge,
  postStreamlineApiRequestWithPage,
} from "../shared/streamline-browser-session";
import type {
  DetailRecordBase,
  DiscoverContext,
  ScrapedLink,
  ScraperAdapter,
} from "../types";

type CoastDetailRecord = DetailRecordBase & {
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
    source: "detail_url_path";
    unit_id: string;
    detail_url: string;
  };
  normalized_matching_profile: {
    source: "pm_coastproperties30a";
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
    source: "pm_coastproperties30a";
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
      day_code: "Y" | "N";
      changeover_code: "C" | "I" | "O" | "X";
      is_available: boolean;
      status_code: "A" | "U" | "I" | "O" | "X";
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
    changeover_codes: string;
  };
  normalized_rates: {
    source: "pm_coastproperties30a";
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
  "https://www.coast-properties.com/search-results/?sort_by=price";
const OUTPUT_ROOT = resolve(
  process.cwd(),
  "src",
  "lib",
  "data",
  "external-sources",
  "coastproperties30a",
);
const OUTPUT_DETAILS_HTML_DIR = resolve(OUTPUT_ROOT, "details", "html");

const MAX_CLICK_CYCLES = 28;
const CLICK_WAIT_MS = 1200;
const GROWTH_POLL_ROUNDS = 10;

function normalizeLink(url: string): string {
  return url.split("#")[0]?.replace(/\/$/, "") ?? url;
}

function toCanonicalGalleryImageUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.hostname.toLowerCase() !== "gallery.streamlinevrs.com") {
    return null;
  }

  const normalizedPath = parsed.pathname.replace(/\/+/g, "/");
  if (!normalizedPath.includes("/units-gallery/")) {
    return null;
  }

  const fileName = normalizedPath.split("/").filter(Boolean).pop() ?? "";
  if (!/^image_[^/]+\.(?:jpe?g|png|webp|gif)$/i.test(fileName)) {
    return null;
  }

  return `https://gallery.streamlinevrs.com${normalizedPath}`;
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

function slugifyExternalListingId(input: {
  name: string;
  rentalId: string;
}): string {
  const base = input.name
    .toLowerCase()
    .replace(/&amp;/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const normalized = base || "listing";
  return `${normalized}-${input.rentalId}`;
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

function canonicalUrlFromId(id: string): string {
  return `https://www.coast-properties.com/${id}/`;
}

function extractRentalIdFromDetailUrl(detailUrl: string): string | null {
  try {
    const parsed = new URL(detailUrl);
    if (!parsed.hostname.endsWith("coast-properties.com")) {
      return null;
    }

    const parts = parsed.pathname.split("/").filter(Boolean);
    return parts[0]?.match(/^\d+$/)?.[0] ?? null;
  } catch {
    return null;
  }
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

function decodeAvailabilityDays(
  beginDateRaw: string,
  availabilityRaw: string,
  changeOverRaw: string,
): Array<{
  date: string;
  code: "Y" | "N" | "X";
  changeOverCode: "C" | "I" | "O" | "X";
}> {
  const beginDate = parseUsDateToUtc(beginDateRaw);
  if (!beginDate) {
    return [];
  }

  const days: Array<{
    date: string;
    code: "Y" | "N" | "X";
    changeOverCode: "C" | "I" | "O" | "X";
  }> = [];
  for (let index = 0; index < availabilityRaw.length; index += 1) {
    const current = new Date(beginDate);
    current.setUTCDate(beginDate.getUTCDate() + index);
    const rawCode = availabilityRaw[index] ?? "";
    const rawChangeOverCode = changeOverRaw[index] ?? "";
    const code: "Y" | "N" | "X" =
      rawCode === "Y" ? "Y" : rawCode === "N" ? "N" : "X";
    const changeOverCode: "C" | "I" | "O" | "X" =
      rawChangeOverCode === "C"
        ? "C"
        : rawChangeOverCode === "I"
          ? "I"
          : rawChangeOverCode === "O"
            ? "O"
            : "X";
    days.push({
      date: formatDateIso(current),
      code,
      changeOverCode,
    });
  }

  return days;
}

function addUtcDaysFromIso(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  date.setUTCDate(date.getUTCDate() + days);
  return formatDateIso(date);
}

function toDayCodeFromStatus(
  statusCode: "A" | "U" | "I" | "O" | "X",
): "Y" | "N" {
  return statusCode === "A" || statusCode === "O" ? "Y" : "N";
}

function toChangeoverCodeFromStatus(
  statusCode: "A" | "U" | "I" | "O" | "X",
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

function ensureMinimumAvailabilityDays(
  days: CoastDetailRecord["normalized_availability"]["days"],
  minimumDays: number,
): CoastDetailRecord["normalized_availability"]["days"] {
  if (days.length === 0 || minimumDays <= 1) {
    return days;
  }

  const firstDate = days[0]?.date ?? "";
  if (!firstDate) {
    return days;
  }

  const targetEnd = addUtcDaysFromIso(firstDate, minimumDays - 1);
  if (!targetEnd) {
    return days;
  }

  const byDate = new Map(days.map((day) => [day.date, day]));
  let cursor = firstDate;
  while (cursor && cursor <= targetEnd) {
    if (!byDate.has(cursor)) {
      byDate.set(cursor, {
        date: cursor,
        day_code: "N",
        changeover_code: "X",
        is_available: false,
        status_code: "X",
        is_available_for_checkin: false,
        is_available_for_checkout: false,
        booking_day_state: "unknown",
      });
    }
    cursor = addUtcDaysFromIso(cursor, 1);
  }

  return Array.from(byDate.values()).sort((left, right) =>
    left.date.localeCompare(right.date),
  );
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

async function discoverListings(
  page: Parameters<
    ScraperAdapter<CoastDetailRecord>["discoverListings"]
  >[0]["page"],
  anchorUrl: string,
  maxScrollSteps: number,
  scrollPauseMs: number,
  _networkIdleWaitMs: number,
  reportProgress: (message: string) => void,
): Promise<ScrapedLink[]> {
  const idSet = new Set<string>();

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

    for (let poll = 0; poll < GROWTH_POLL_ROUNDS; poll += 1) {
      if (idSet.size > beforeCount) {
        break;
      }
      await page.waitForTimeout(350);
    }

    if ((cycle + 1) % 3 === 0) {
      reportProgress(
        `load-more cycle ${cycle + 1}/${maxCycles}; ids=${idSet.size}`,
      );
    }
  }

  const sortedIds = Array.from(idSet).sort(
    (left, right) => Number(left) - Number(right),
  );

  return sortedIds.map((id) => ({
    link: normalizeLink(canonicalUrlFromId(id)),
    source_url: anchorUrl,
    anchor_text: "api-load-more",
  }));
}

async function fetchDetail(
  browser: { newPage: () => Promise<DiscoverContext["page"]> },
  detailUrl: string,
  availabilityHorizonDays: number,
  reportDetailProgress?: (message: string) => void,
): Promise<CoastDetailRecord | null> {
  const rentalId = extractRentalIdFromDetailUrl(detailUrl);
  if (!rentalId) {
    return null;
  }

  const parsedDetailUrl = new URL(detailUrl);
  const origin = parsedDetailUrl.origin;
  const page = await browser.newPage();

  try {
    try {
      const detailResponse = await navigateDetailWithChallenge({
        page,
        detailUrl,
        origin,
        timeoutMs: 120000,
      });
      const detailStatus = detailResponse.status;

      if (detailStatus !== 200) {
        if (detailStatus === 403) {
          reportDetailProgress?.(
            `http_status=403 detail_url=${detailUrl} provider=coastproperties30a`,
          );
        } else {
          reportDetailProgress?.(
            `detail_request_non_200 status=${detailStatus} detail_url=${detailUrl} provider=coastproperties30a`,
          );
        }
        return null;
      }

      const html = detailResponse.html;

      const title = extractFirst(
        /<title[^>]*>([\s\S]*?)<\/title>/i,
        html,
      ).slice(0, 240);
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

      const descriptionExpanded =
        extractFirst(
          /<div class="description block clearfix">[\s\S]*?<article>([\s\S]*?)<\/article>/i,
          html,
        ).slice(0, 20000) || stripHtml(metaDescription).slice(0, 20000);

      const amenitiesCategories: Record<string, string[]> = {};
      const amenitiesAll: string[] = [];
      const seenAmenities = new Set<string>();
      const amenitiesMatch = html.match(
        /<div class="amenities block clearfix">([\s\S]*?)<\/div><!-- end block -->/i,
      );
      if (amenitiesMatch?.[1]) {
        let currentCategory = "General";
        for (const itemMatch of amenitiesMatch[1].matchAll(
          /<li class="amenity_item"([^>]*)>([\s\S]*?)<\/li>/gi,
        )) {
          const attrs = (itemMatch[1] ?? "").toLowerCase();
          const value = stripHtml(itemMatch[2] ?? "").trim();
          if (!value) {
            continue;
          }

          const isCategory = attrs.includes("font-weight:700");
          if (isCategory) {
            currentCategory = value;
            if (!amenitiesCategories[currentCategory]) {
              amenitiesCategories[currentCategory] = [];
            }
            continue;
          }

          if (!amenitiesCategories[currentCategory]) {
            amenitiesCategories[currentCategory] = [];
          }
          amenitiesCategories[currentCategory].push(value);

          const key = value.toLowerCase();
          if (seenAmenities.has(key)) {
            continue;
          }
          seenAmenities.add(key);
          amenitiesAll.push(value);
        }
      }

      const imageUrls = new Set<string>();
      const galleryBlock = html.match(
        /<div class="galleryGo">([\s\S]*?)<\/div>\s*<\/div><!--End gallerySlick-->/i,
      )?.[1];
      const gallerySource = galleryBlock || html;
      for (const imgMatch of gallerySource.matchAll(
        /<img[^>]+src=["']([^"']+)["'][^>]*>/gi,
      )) {
        const src = (imgMatch[1] ?? "").trim();
        if (!src || src.startsWith("data:")) {
          continue;
        }
        try {
          const absolute = new URL(src, detailUrl).toString();
          const canonical = toCanonicalGalleryImageUrl(absolute);
          if (canonical) {
            imageUrls.add(canonical);
          }
        } catch {
          // Ignore malformed image URLs.
        }
      }
      const ogImage = extractFirst(
        /<meta[^>]+property=["']og:image["'][^>]+content=["']([\s\S]*?)["'][^>]*>/i,
        html,
      );
      if (ogImage) {
        try {
          const absolute = new URL(ogImage, detailUrl).toString();
          const canonical = toCanonicalGalleryImageUrl(absolute);
          if (canonical) {
            imageUrls.add(canonical);
          }
        } catch {
          // Ignore malformed og:image URL.
        }
      }

      let schemaAddress: Record<string, unknown> = {};
      let schemaLatitude: number | null = null;
      let schemaLongitude: number | null = null;
      let schemaBedrooms: number | null = null;
      let schemaBathrooms: number | null = null;
      let schemaSleeps: number | null = null;
      for (const schemaMatch of html.matchAll(
        /<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi,
      )) {
        const raw = (schemaMatch[1] ?? "").trim();
        if (!raw) {
          continue;
        }
        try {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          const schemaType = String(parsed["@type"] ?? "").toLowerCase();
          if (!schemaType.includes("vacationrental")) {
            continue;
          }

          const address = parsed.address;
          if (address && typeof address === "object") {
            schemaAddress = address as Record<string, unknown>;
          }

          const containsPlace =
            parsed.containsPlace && typeof parsed.containsPlace === "object"
              ? (parsed.containsPlace as Record<string, unknown>)
              : null;

          schemaLatitude = parseNumberLike(parsed.latitude);
          schemaLongitude = parseNumberLike(parsed.longitude);
          schemaBedrooms = containsPlace
            ? parseNumberLike(containsPlace.numberOfBedrooms)
            : null;
          schemaBathrooms = containsPlace
            ? parseNumberLike(containsPlace.numberOfBathroomsTotal)
            : null;
          const occupancy =
            containsPlace?.occupancy &&
            typeof containsPlace.occupancy === "object"
              ? (containsPlace.occupancy as Record<string, unknown>)
              : null;
          schemaSleeps = occupancy ? parseNumberLike(occupancy.value) : null;
          break;
        } catch {
          // Ignore invalid JSON-LD script blocks.
        }
      }

      const mapCenterMatch = html.match(
        /<map[^>]+center="\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*"/i,
      );
      const markerMatch = html.match(
        /<marker[^>]+position="\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*"/i,
      );
      const latitude =
        schemaLatitude ??
        (mapCenterMatch ? Number(mapCenterMatch[1]) : null) ??
        (markerMatch ? Number(markerMatch[1]) : null);
      const longitude =
        schemaLongitude ??
        (mapCenterMatch ? Number(mapCenterMatch[2]) : null) ??
        (markerMatch ? Number(markerMatch[2]) : null);

      const streetAddress = String(schemaAddress.streetAddress ?? "").trim();
      const city = String(schemaAddress.addressLocality ?? "").trim();
      const region = String(schemaAddress.addressRegion ?? "").trim();
      const postal = String(schemaAddress.postalCode ?? "").trim();
      const fullAddress = [streetAddress, city, region, postal]
        .filter((part) => part.length > 0)
        .join(", ");
      const directionsDaddr = fullAddress;
      const directionsUrl = directionsDaddr
        ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
            directionsDaddr,
          )}`
        : "";

      const externalListingId = slugifyExternalListingId({
        name: h1 || title || rentalId,
        rentalId,
      });

      const roomDetailsApiPayload =
        await postStreamlineApiRequestWithPage<StreamlineRoomDetailsPayload>({
          page,
          origin,
          methodName: "GetPropertyRoomDetails",
          params: {
            unit_id: Number(rentalId),
            use_room_type_logic: "no",
            standard_pricing: 1,
          },
        });

      const htmlPath = resolve(
        OUTPUT_DETAILS_HTML_DIR,
        `${externalListingId}.html`,
      );
      await writeFile(htmlPath, `${html}\n`, "utf8");

      const availabilityPayload = await postStreamlineApiRequestWithPage<{
        data?: {
          range?: { beginDate?: string; endDate?: string };
          availability?: string;
          changeOver?: string;
        };
      }>({
        page,
        origin,
        methodName: "GetPropertyAvailabilityRawData",
        params: {
          unit_id: Number(rentalId),
          use_room_type_logic: "no",
          standard_pricing: 1,
        },
      });

      const rawBeginDate = availabilityPayload?.data?.range?.beginDate ?? "";
      const rawEndDate = availabilityPayload?.data?.range?.endDate ?? "";
      const rawAvailabilityCodes =
        availabilityPayload?.data?.availability ?? "";
      const rawChangeoverCodes = availabilityPayload?.data?.changeOver ?? "";

      const allAvailabilityDays = decodeAvailabilityDays(
        rawBeginDate,
        rawAvailabilityCodes,
        rawChangeoverCodes,
      );

      const now = new Date();
      const today = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
      );
      const horizonDate = new Date(today);
      horizonDate.setUTCDate(
        horizonDate.getUTCDate() + availabilityHorizonDays,
      );

      const filteredDays = allAvailabilityDays.filter((day) => {
        const dayDate = new Date(`${day.date}T00:00:00.000Z`);
        return dayDate >= today && dayDate <= horizonDate;
      });

      const ratesStartIso = filteredDays[0]?.date ?? formatDateIso(today);
      const ratesEndIso =
        filteredDays[filteredDays.length - 1]?.date ??
        formatDateIso(horizonDate);
      const ratesStartDateUs = formatDateUsFromIso(ratesStartIso);
      const ratesEndDateUs = formatDateUsFromIso(ratesEndIso);

      let ratesRowsRaw: Array<Record<string, unknown>> = [];
      if (ratesStartDateUs && ratesEndDateUs) {
        const ratesPayload = await postStreamlineApiRequestWithPage<{
          data?: unknown;
        }>({
          page,
          origin,
          methodName: "GetPropertyRates",
          params: {
            unit_id: Number(rentalId),
            startdate: ratesStartDateUs,
            enddate: ratesEndDateUs,
          },
        });

        const data = ratesPayload?.data;
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
      }

      const normalizedRateDays = ratesRowsRaw
        .map((row) => {
          const date = normalizeDateLikeToIso(row.date);
          if (!date) {
            return null;
          }

          const nightlyRate = parseCurrencyLike(row.rate);
          const minNights = parseNumberLike(row.minStay);
          const bookedRaw = row.booked;
          const isBooked =
            typeof bookedRaw === "number"
              ? bookedRaw === 1
              : typeof bookedRaw === "string"
                ? bookedRaw.trim() === "1"
                : null;
          const changeoverCode = String(row.changeOver ?? "").trim();
          const seasonName = String(row.season ?? "")
            .trim()
            .slice(0, 160);

          return {
            date,
            nightly_rate: nightlyRate,
            min_nights: minNights,
            is_booked: isBooked,
            changeover_code: changeoverCode,
            season_name: seasonName,
          };
        })
        .filter((row): row is NonNullable<typeof row> => row !== null)
        .sort((left, right) => left.date.localeCompare(right.date));

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

      const normalizedDays = filteredDays.map((day, index) => {
        const previousDay = index > 0 ? filteredDays[index - 1] : undefined;
        const bookingDayState: "bookable" | "blocked" | "unknown" =
          day.code === "Y"
            ? "bookable"
            : day.code === "N"
              ? "blocked"
              : "unknown";

        const isAvailable = day.code === "Y";
        const isCheckInAllowed =
          day.code === "Y" &&
          day.changeOverCode !== "X" &&
          day.changeOverCode !== "O";
        const isCheckOutAllowed =
          (day.code === "Y" &&
            day.changeOverCode !== "X" &&
            day.changeOverCode !== "I") ||
          (day.code === "N" && previousDay?.code === "Y");

        const statusCode: "A" | "U" | "I" | "O" | "X" =
          day.code === "X"
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
          day_code: toDayCodeFromStatus(statusCode),
          changeover_code: toChangeoverCodeFromStatus(statusCode),
          is_available: isAvailable,
          is_available_for_checkin: isCheckInAllowed,
          is_available_for_checkout: isCheckOutAllowed,
          status_code: statusCode,
          booking_day_state: bookingDayState,
        };
      });

      const conformanceDays = ensureMinimumAvailabilityDays(
        normalizedDays,
        365,
      );

      const available = conformanceDays.filter(
        (day) => day.day_code === "Y",
      ).length;
      const notAvailable = conformanceDays.filter(
        (day) => day.day_code === "N",
      ).length;
      const other = conformanceDays.length - available - notAvailable;

      const description = descriptionExpanded || stripHtml(metaDescription);
      const roomDetailsGuidanceFromApi = extractRoomDetailsGuidanceFromApi(
        roomDetailsApiPayload,
      );
      const roomDetailsGuidance =
        roomDetailsGuidanceFromApi.length > 0
          ? roomDetailsGuidanceFromApi
          : extractRoomDetailsGuidanceFromDescription(description);
      const name = stripHtml(h1 || title).slice(0, 240);
      const descriptionNormalized = normalizeForMatch(description);
      const titleNormalized = normalizeForMatch(name);

      const mediaImageUrls = Array.from(imageUrls);

      return {
        external_listing_id: externalListingId,
        detail_url: detailUrl,
        fetched_at: new Date().toISOString(),
        title,
        h1,
        canonical_url: canonicalUrl,
        meta_description: metaDescription,
        description_expanded: descriptionExpanded,
        rooms_guidance: roomDetailsGuidance,
        amenities: {
          categories: amenitiesCategories,
          all: amenitiesAll,
        },
        location: {
          address: fullAddress,
          location_label: city || region,
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
          area: region,
          location: city || region,
          beds: schemaBedrooms,
          baths: schemaBathrooms,
          sleeps: schemaSleeps,
          city,
          state: "",
        },
        quote_context: {
          source: "detail_url_path",
          unit_id: rentalId,
          detail_url: detailUrl,
        },
        normalized_matching_profile: {
          source: "pm_coastproperties30a",
          external_listing_id: externalListingId,
          name,
          description,
          match_signals: {
            description_normalized: descriptionNormalized,
            description_sha256: hashSha256(descriptionNormalized),
            title_normalized: titleNormalized,
            title_sha256: hashSha256(titleNormalized),
            listing_composite_key: [
              "pm_coastproperties30a",
              externalListingId,
              hashSha256(descriptionNormalized),
              hashSha256(titleNormalized),
            ].join("::"),
          },
        },
        normalized_availability: {
          source: "pm_coastproperties30a",
          external_listing_id: externalListingId,
          captured_at: new Date().toISOString(),
          window_start: conformanceDays[0]?.date ?? "",
          window_end: conformanceDays[conformanceDays.length - 1]?.date ?? "",
          code_legend: {
            Y: "available",
            N: "not_available",
            X: "other",
          },
          day_codes: conformanceDays.map((day) => day.status_code).join(""),
          days: conformanceDays,
          counts: {
            available,
            not_available: notAvailable,
            other,
            booking_available: conformanceDays.filter(
              (day) => day.booking_day_state === "bookable",
            ).length,
            booking_unavailable: conformanceDays.filter(
              (day) => day.booking_day_state === "blocked",
            ).length,
            booking_unknown: conformanceDays.filter(
              (day) => day.booking_day_state === "unknown",
            ).length,
          },
        },
        availability_raw: {
          begin_date: rawBeginDate,
          end_date: rawEndDate,
          day_codes: rawAvailabilityCodes,
          changeover_codes: rawChangeoverCodes,
        },
        normalized_rates: {
          source: "pm_coastproperties30a",
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
            room_details: "GetPropertyRoomDetails",
            rates: "GetPropertyRates",
          },
          notes:
            "GetPropertyRoomDetails is used as the primary rooms guidance source; description parsing remains as fallback when room details are empty.",
        },
        html_path: htmlPath,
      };
    } finally {
      await page.close();
    }
  } catch {
    return null;
  }
}

export function createCoastProperties30AAdapter(): ScraperAdapter<CoastDetailRecord> {
  return {
    managerKey: "coastproperties30a",
    scriptLabel: "coastproperties30a",
    defaultAnchorUrl: DEFAULT_ANCHOR_URL,
    detailFetchDelayMs: Math.max(
      0,
      Number(process.env.COASTPROPERTIES30A_DETAIL_FETCH_DELAY_MS ?? "250") ||
        250,
    ),
    detailFetchConcurrency: Math.max(
      1,
      Number(process.env.COASTPROPERTIES30A_FETCH_CONCURRENCY ?? "6") || 6,
    ),
    availabilityHorizonDays: Math.max(
      1,
      Number(
        process.env.COASTPROPERTIES30A_AVAILABILITY_HORIZON_DAYS ?? "730",
      ) || 730,
    ),
    maxCalendarAdvanceMonths: 24,
    isValidDetailUrl(value: string): string | null {
      try {
        const parsed = new URL(value.trim());
        if (!parsed.hostname.endsWith("coast-properties.com")) {
          return null;
        }

        const rentalId = extractRentalIdFromDetailUrl(parsed.toString());
        if (!rentalId) {
          return null;
        }

        return normalizeLink(canonicalUrlFromId(rentalId));
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
        context.browser as unknown as {
          newPage: () => Promise<DiscoverContext["page"]>;
        },
        context.detailUrl,
        context.availabilityHorizonDays,
        context.reportDetailProgress,
      );
    },
    async runQuoteCapture(argv, progress) {
      const normalizedArgs = await normalizeAdapterQuoteScopeArgs(
        "coastproperties30a",
        argv,
      );
      await runRuntimeAdapterQuoteCli(
        {
          adapterKey: "coastproperties30a",
          executeSingleQuote: executeCoastproperties30aSingleQuote,
          maxAttemptsEnvVar: "COASTPROPERTIES30A_QUOTE_MAX_ATTEMPTS",
          defaultMaxListings: 30,
          defaultWeeks: 24,
          defaultNights: 7,
          defaultListingConcurrency: 2,
          defaultQuoteConcurrency: 3,
          defaultQuoteTimeoutMs: 20000,
          defaultQuoteMaxAttempts: 2,
        },
        normalizedArgs,
        progress,
      );
    },
    async runSingleQuoteObservation(input) {
      return executeCoastproperties30aSingleQuote(input);
    },
  };
}
