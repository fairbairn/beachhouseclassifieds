import { executeSandpiper30aSingleQuote } from "@/lib/pricing/quote-runtime/adapters/sandpiper30a";
import { runRuntimeAdapterQuoteCli } from "@/lib/pricing/quotes/shared/runtime-adapter-quote-runner";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { normalizeAdapterQuoteScopeArgs } from "../quote-scope";
import type {
  ScraperBrowserLike,
  ScraperBrowserPageLike,
} from "../shared/browser-engine";
import type { DetailRecordBase, ScrapedLink, ScraperAdapter } from "../types";

type Page = ScraperBrowserPageLike & {
  addInitScript(script: string | (() => unknown)): Promise<void>;
  waitForTimeout(milliseconds: number): Promise<void>;
  waitForSelector(
    selector: string,
    options?: {
      state?: "attached" | "detached" | "hidden" | "visible";
      timeout?: number;
    },
  ): Promise<unknown>;
  evaluate<TArg, TResult>(
    pageFunction: (arg: TArg) => TResult | Promise<TResult>,
    arg: TArg,
  ): Promise<TResult>;
  evaluate<TResult>(
    pageFunction: () => TResult | Promise<TResult>,
  ): Promise<TResult>;
  viewportSize(): { width: number; height: number } | null;
  mouse: {
    wheel(deltaX: number, deltaY: number): Promise<void>;
  };
  request: {
    get(
      url: string,
      options?: { headers?: Record<string, string>; timeout?: number },
    ): Promise<{
      ok(): boolean;
      status(): number;
      text(): Promise<string>;
      json(): Promise<unknown>;
    }>;
  };
  context(): {
    cookies(urls?: string | string[]): Promise<Array<{ name: string }>>;
  };
};

type Browser = ScraperBrowserLike & {
  newPage(): Promise<Page>;
};

type LuxuryDayCode = "A" | "U" | "I" | "O" | "X";
type CanonicalDayCode = "Y" | "N";
type CanonicalChangeoverCode = "C" | "I" | "O" | "X";
type DetailProgressReporter = (message: string) => void;

function toDayCodeFromStatus(status: LuxuryDayCode): CanonicalDayCode {
  return status === "A" || status === "O" ? "Y" : "N";
}

function toChangeoverCodeFromStatus(
  status: LuxuryDayCode,
): CanonicalChangeoverCode {
  if (status === "I") {
    return "I";
  }
  if (status === "O") {
    return "O";
  }
  return status === "A" ? "C" : "X";
}

function applyDerivedStatus(
  day: LuxuryDetailRecord["normalized_availability"]["days"][number],
  statusCode: LuxuryDayCode,
): void {
  day.status_code = statusCode;
  day.day_code = toDayCodeFromStatus(statusCode);
  day.changeover_code = toChangeoverCodeFromStatus(statusCode);
  day.is_available = statusCode === "A" || statusCode === "O";
  day.is_available_for_checkin = statusCode === "A" || statusCode === "I";
  day.is_available_for_checkout = statusCode === "A" || statusCode === "O";
  day.booking_day_state =
    statusCode === "A" || statusCode === "O"
      ? "bookable"
      : statusCode === "U" || statusCode === "I"
        ? "blocked"
        : "unknown";
}

function deriveTurnDayStatuses(
  days: LuxuryDetailRecord["normalized_availability"]["days"],
): void {
  for (let index = 0; index < days.length; index += 1) {
    const day = days[index];
    if (!day || day.status_code !== "A") {
      continue;
    }

    const previousDay = index > 0 ? days[index - 1] : null;
    const nextDay = index + 1 < days.length ? days[index + 1] : null;
    const previousUnavailable =
      previousDay !== null &&
      (previousDay.status_code === "U" || previousDay.status_code === "X");
    const nextUnavailable =
      nextDay !== null &&
      (nextDay.status_code === "U" || nextDay.status_code === "X");

    if (!previousUnavailable && !nextUnavailable) {
      continue;
    }

    if (previousUnavailable && !nextUnavailable) {
      applyDerivedStatus(day, "I");
      continue;
    }

    if (!previousUnavailable && nextUnavailable) {
      applyDerivedStatus(day, "O");
      continue;
    }

    applyDerivedStatus(day, "I");
  }
}

type LuxuryDetailRecord = DetailRecordBase & {
  quote_context: {
    unit_code: string;
    detail_url: string;
    hub_property_id?: string;
    pms_id?: string;
    item_code?: string;
    item_id?: string;
    property_id?: string;
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
    source: "pm_sandpiper30a";
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
    source: "pm_sandpiper30a";
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
      day_code: CanonicalDayCode;
      status_code: LuxuryDayCode;
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
  scrape_metrics: {
    total_ms: number;
    page_load_ms: number;
    extraction_ms: number;
    calendar_clicks: number;
    calendar_iterations: number;
  };
};

const DEFAULT_ANCHOR_URL =
  "https://sandpipervacationrentals.com/all-properties/";
const EXPECTED_LISTING_COUNT = 104;
const DETAIL_PATH_PREFIXES = [
  "/vacation_rentals/",
  "/vacation-rentals/",
  "/all-properties/",
];
const OUTPUT_ROOT = resolve(
  process.cwd(),
  "src",
  "lib",
  "data",
  "external-sources",
  "sandpiper30a",
);
const OUTPUT_DETAILS_HTML_DIR = resolve(OUTPUT_ROOT, "details", "html");
const SANDPIPER_RESULTS_SCROLL_GRID_SELECTOR =
  "#lmpm-property-search-list-scroll > div.lmpm-search-grid";
const SANDPIPER_RESULTS_FALLBACK_SELECTORS =
  "#lmpm-property-search-list-scroll > div, #lmpm-property-search-list-scroll, riot-solr-result-list, .result-list, #post-6 > section";

function normalizeLink(url: string): string {
  return url.split("#")[0]?.replace(/\/$/, "") ?? url;
}

function normalizeDetailUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const pathOnly = `${parsed.origin}${parsed.pathname}`.replace(/\/$/, "");
    const query = parsed.searchParams.toString();
    return query ? `${pathOnly}?${query}` : pathOnly;
  } catch {
    return normalizeLink(url);
  }
}

function toCanonicalDetailNavigationUrl(detailUrl: string): string {
  try {
    const parsed = new URL(detailUrl);
    const base = `${parsed.origin}${parsed.pathname}`;
    return base.endsWith("/") ? base : `${base}/`;
  } catch {
    return detailUrl;
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function safePageUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    return "unknown";
  }
}

async function evaluateWithDiagnostics<TResult>(
  page: Page,
  stage: string,
  reportProgress: ((message: string) => void) | undefined,
  pageFunction: () => TResult | Promise<TResult>,
): Promise<TResult>;
async function evaluateWithDiagnostics<TArg, TResult>(
  page: Page,
  stage: string,
  reportProgress: ((message: string) => void) | undefined,
  pageFunction: (arg: TArg) => TResult | Promise<TResult>,
  arg: TArg,
): Promise<TResult>;
async function evaluateWithDiagnostics<TArg, TResult>(
  page: Page,
  stage: string,
  reportProgress: ((message: string) => void) | undefined,
  pageFunction:
    | ((arg: TArg) => TResult | Promise<TResult>)
    | (() => TResult | Promise<TResult>),
  arg?: TArg,
): Promise<TResult> {
  try {
    if (arguments.length >= 5) {
      return await page.evaluate(
        pageFunction as (arg: TArg) => TResult | Promise<TResult>,
        arg as TArg,
      );
    }

    return await page.evaluate(
      pageFunction as () => TResult | Promise<TResult>,
    );
  } catch (error) {
    const message = `page.evaluate failed stage=${stage} url=${safePageUrl(page)} error=${toErrorMessage(error)}`;
    reportProgress?.(message);
    throw new Error(message);
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

function isLikelyDetailUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return isLikelyDetailPath(parsed.pathname);
  } catch {
    return false;
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

function extractRequiredUnitCodeFromHtml(html: string): string | null {
  const match = html.match(
    /<input[^>]*id=["']unitCode["'][^>]*value=["']([^"']+)["'][^>]*>/i,
  );
  const unitCode = match?.[1]?.trim() ?? "";
  return unitCode || null;
}

function extractHubPropertyIdFromUrl(detailUrl: string): string | null {
  try {
    const parsed = new URL(detailUrl);
    const value = parsed.searchParams.get("hub_property_id")?.trim() ?? "";
    return value || null;
  } catch {
    return null;
  }
}

function decodeHubPropertyId(value: string): {
  itemCode: string | null;
  propertyId: string | null;
} {
  try {
    const decoded = Buffer.from(value, "base64").toString("utf8").trim();
    if (!decoded) {
      return { itemCode: null, propertyId: null };
    }

    const itemMatch = decoded.match(/^item\s*:\s*(\d+)$/i);
    return {
      itemCode: decoded,
      propertyId: itemMatch?.[1] ?? null,
    };
  } catch {
    return { itemCode: null, propertyId: null };
  }
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

    // Rezfusion wrappers often look like
    // https://images.rezfusion.com/.../https://pictures.escapia.com/...jpg
    // where the second https URL is the canonical asset.
    const firstHttpsIndex = decoded.indexOf("https://");
    const secondHttpsIndex =
      firstHttpsIndex >= 0
        ? decoded.indexOf("https://", firstHttpsIndex + "https://".length)
        : -1;
    if (secondHttpsIndex > firstHttpsIndex) {
      const embeddedCandidate = decoded.slice(secondHttpsIndex).trim();
      try {
        const embedded = new URL(embeddedCandidate);
        return `${embedded.origin}${embedded.pathname}`;
      } catch {
        // Fall through to other parsing paths.
      }
    }

    // Some Rezfusion URLs embed the canonical image URL directly in the path.
    const embeddedUrlMatch = decoded.match(
      /(https?:\/\/[^\s"']+\.(?:jpe?g|png|webp|gif))/i,
    );
    if (embeddedUrlMatch?.[1]) {
      try {
        const embedded = new URL(embeddedUrlMatch[1]);
        return `${embedded.origin}${embedded.pathname}`;
      } catch {
        // Fall through to standard URL normalization.
      }
    }

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

    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "";
  }
}

function buildGalleryImageSignature(url: string): string {
  try {
    const parsed = new URL(url);
    const decodedPath = decodeURIComponent(parsed.pathname);

    const directEscapiaMatch = decodedPath.match(
      /\/(\d+)\.(?:jpe?g|png|webp|gif)$/i,
    );
    if (directEscapiaMatch?.[1]) {
      const numericId = directEscapiaMatch[1];
      return `escapia:${numericId.slice(-4)}`;
    }

    const embeddedEscapiaMatch = decodedPath.match(
      /https?:\/\/pictures\.escapia\.com\/[^?#]+\/(\d+)\.(?:jpe?g|png|webp|gif)$/i,
    );
    if (embeddedEscapiaMatch?.[1]) {
      const numericId = embeddedEscapiaMatch[1];
      return `escapia:${numericId.slice(-4)}`;
    }

    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function dedupeGalleryUrls(urls: string[]): string[] {
  const bySignature = new Map<string, string>();

  for (const url of urls) {
    const signature = buildGalleryImageSignature(url);
    if (!bySignature.has(signature)) {
      bySignature.set(signature, url);
    }
  }

  return Array.from(bySignature.values());
}

function isLikelyPropertyGalleryImageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();

    if (host.includes("pictures.escapia.com")) {
      return /\/(?:[0-9]{3,}|[^/]+)\.(?:jpe?g|png|webp|gif)$/.test(path);
    }

    if (host.includes("images.rezfusion.com")) {
      return (
        path.includes("pictures.escapia.com") || /\/cdn-cgi\/image\//.test(path)
      );
    }

    return false;
  } catch {
    return false;
  }
}

function extractGalleryUrlsFromHtmlMarkup(
  html: string,
  detailUrl: string,
): string[] {
  const urls: string[] = [];

  const collectRaw = (raw: string): void => {
    const cleaned = raw.trim().replace(/&amp;/gi, "&");
    if (!cleaned) {
      return;
    }

    const srcsetParts = cleaned
      .split(",")
      .map((part) => part.trim().split(/\s+/)[0] ?? "")
      .filter(Boolean);
    const candidates = srcsetParts.length > 0 ? srcsetParts : [cleaned];

    for (const candidate of candidates) {
      try {
        const absolute = new URL(candidate, detailUrl).toString();
        if (/(?:jpe?g|png|webp|gif)(?:\?|$)/i.test(absolute)) {
          urls.push(absolute);
        }
      } catch {
        // Ignore malformed URL candidates in markup.
      }
    }
  };

  const attrPattern = /(src|data-src|srcset)=["']([^"']+)["']/gi;
  for (const match of html.matchAll(attrPattern)) {
    const raw = match[2]?.trim() ?? "";
    if (raw) {
      collectRaw(raw);
    }
  }

  const directUrlPattern =
    /https?:\/\/[^\s"'<>]+\.(?:jpe?g|png|webp|gif)(?:\?[^\s"'<>]*)?/gi;
  for (const match of html.matchAll(directUrlPattern)) {
    const raw = match[0]?.trim() ?? "";
    if (raw) {
      collectRaw(raw);
    }
  }

  return dedupePreserveOrder(urls);
}

async function extractLightboxGalleryUrls(
  page: Page,
  reportProgress?: DetailProgressReporter,
): Promise<string[]> {
  await clickVisibleControlsByLabel(
    page,
    ["photos", "all photos", "view photos", "gallery", "lightbox"],
    reportProgress,
  );

  await page.waitForTimeout(900);

  return evaluateWithDiagnostics(
    page,
    "detail.extractLightboxGalleryUrls",
    reportProgress,
    () => {
      const urls: string[] = [];
      const nodes = Array.from(
        document.querySelectorAll(
          ".image-gallery-slide img[src], .image-gallery-slide img[data-src], img.image-gallery-image, .image-gallery-thumbnail img[src], .image-gallery-thumbnail img[data-src], .image-gallery img[src], .image-gallery-content img[src]",
        ),
      );

      for (const node of nodes) {
        const attrs = [node.getAttribute("src"), node.getAttribute("data-src")];

        for (const raw of attrs) {
          if (!raw) {
            continue;
          }

          try {
            const absolute = new URL(raw, window.location.origin).toString();
            if (/\.(jpe?g|png|webp|gif)(\?|$)/i.test(absolute)) {
              urls.push(absolute);
            }
          } catch {
            // Skip invalid URL fragments.
          }
        }
      }

      return Array.from(new Set(urls));
    },
  );
}

function extractEscapiaSuffix(url: string): string | null {
  try {
    const parsed = new URL(url);
    const decodedPath = decodeURIComponent(parsed.pathname);
    const directEscapiaMatch = decodedPath.match(
      /\/(\d+)\.(?:jpe?g|png|webp|gif)$/i,
    );
    if (directEscapiaMatch?.[1]) {
      return directEscapiaMatch[1].slice(-4);
    }

    const embeddedEscapiaMatch = decodedPath.match(
      /https?:\/\/pictures\.escapia\.com\/[^?#]+\/(\d+)\.(?:jpe?g|png|webp|gif)$/i,
    );
    if (embeddedEscapiaMatch?.[1]) {
      return embeddedEscapiaMatch[1].slice(-4);
    }

    return null;
  } catch {
    return null;
  }
}

function dedupeResolvedGalleryUrls(urls: string[]): string[] {
  const byKey = new Map<string, string>();

  for (const rawUrl of urls) {
    const normalized = normalizeGalleryUrl(rawUrl);
    if (!normalized || !isLikelyPropertyGalleryImageUrl(normalized)) {
      continue;
    }

    const escapiaSuffix = extractEscapiaSuffix(normalized);
    const key = escapiaSuffix ? `escapia:${escapiaSuffix}` : normalized;

    if (!byKey.has(key)) {
      byKey.set(key, normalized);
    }
  }

  return dedupeGalleryUrls(Array.from(byKey.values()));
}

function extractFieldLocationFromHtml(html: string): {
  street: string;
  latitude: number | null;
  longitude: number | null;
} {
  const extractCoordinatePairFallback = (): {
    latitude: number | null;
    longitude: number | null;
  } => {
    const pairPattern = /(-?\d{1,2}\.\d{4,})\s*,\s*(-?\d{1,3}\.\d{4,})/g;

    for (const match of html.matchAll(pairPattern)) {
      const latitude = Number(match[1]);
      const longitude = Number(match[2]);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        continue;
      }

      if (
        latitude < -90 ||
        latitude > 90 ||
        longitude < -180 ||
        longitude > 180
      ) {
        continue;
      }

      // Guard against common non-geo numeric pairs like image dimensions.
      if (Math.abs(latitude) < 0.01 || Math.abs(longitude) < 0.01) {
        continue;
      }

      return { latitude, longitude };
    }

    return { latitude: null, longitude: null };
  };

  const widgetMatch = html.match(
    /<div[^>]+class=["'][^"']*be-property-widget[^"']*["'][^>]*>/i,
  );
  const widgetTag = widgetMatch?.[0] ?? "";

  const attrValue = (name: string): string => {
    const match = widgetTag.match(new RegExp(`${name}=["']([^"']*)["']`, "i"));
    return (match?.[1] ?? "").trim();
  };

  const geoMetaMatch = html.match(
    /<meta[^>]+name=["']geo\.position["'][^>]+content=["']\s*(-?\d{1,2}\.\d{4,})\s*,\s*(-?\d{1,3}\.\d{4,})\s*["'][^>]*>/i,
  );
  if (geoMetaMatch?.[1] && geoMetaMatch?.[2]) {
    const latitude = Number(geoMetaMatch[1]);
    const longitude = Number(geoMetaMatch[2]);
    if (
      Number.isFinite(latitude) &&
      Number.isFinite(longitude) &&
      latitude >= -90 &&
      latitude <= 90 &&
      longitude >= -180 &&
      longitude <= 180
    ) {
      return {
        street: "",
        latitude,
        longitude,
      };
    }
  }

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
    : "";

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

  const hasMeaningfulCoords =
    (Number.isFinite(latitudeResolved) &&
      Math.abs(latitudeResolved) > 0.000001) ||
    (Number.isFinite(longitudeResolved) &&
      Math.abs(longitudeResolved) > 0.000001);

  if (hasMeaningfulCoords) {
    return {
      street,
      latitude: Number.isFinite(latitudeResolved) ? latitudeResolved : null,
      longitude: Number.isFinite(longitudeResolved) ? longitudeResolved : null,
    };
  }

  const mapsLinkMatch = html.match(
    /<a[^>]+href=["']([^"']*google\.com\/maps[^"']*)["'][^>]*>/i,
  );
  const mapsHrefRaw = mapsLinkMatch?.[1]?.replace(/&amp;/gi, "&") ?? "";

  if (mapsHrefRaw) {
    try {
      const mapsUrl = new URL(mapsHrefRaw);
      const placeMatch = mapsUrl.pathname.match(
        /\/maps\/place\/\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/i,
      );
      const latFromPlace = placeMatch ? Number(placeMatch[1]) : NaN;
      const lngFromPlace = placeMatch ? Number(placeMatch[2]) : NaN;

      const daddrRaw = mapsUrl.searchParams.get("daddr")?.trim() ?? "";
      const daddr = daddrRaw.replace(/\+/g, " ");
      const daddrCoordMatch = daddr.match(
        /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/,
      );

      const latFromDaddr = daddrCoordMatch ? Number(daddrCoordMatch[1]) : NaN;
      const lngFromDaddr = daddrCoordMatch ? Number(daddrCoordMatch[2]) : NaN;

      const resolvedLatitude = Number.isFinite(latFromPlace)
        ? latFromPlace
        : Number.isFinite(latFromDaddr)
          ? latFromDaddr
          : null;
      const resolvedLongitude = Number.isFinite(lngFromPlace)
        ? lngFromPlace
        : Number.isFinite(lngFromDaddr)
          ? lngFromDaddr
          : null;

      if (resolvedLatitude === null && resolvedLongitude === null) {
        const coordinatePairFallback = extractCoordinatePairFallback();
        return {
          street: daddrCoordMatch ? "" : daddr,
          latitude: coordinatePairFallback.latitude,
          longitude: coordinatePairFallback.longitude,
        };
      }

      return {
        street: daddrCoordMatch ? "" : daddr,
        latitude: resolvedLatitude,
        longitude: resolvedLongitude,
      };
    } catch {
      // Fall through to empty location payload.
    }
  }

  const inlineCoordsMatch = html.match(
    /google\.com\/maps\/place\/\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/i,
  );
  if (inlineCoordsMatch) {
    const latitudeInline = Number(inlineCoordsMatch[1]);
    const longitudeInline = Number(inlineCoordsMatch[2]);
    return {
      street: "",
      latitude: Number.isFinite(latitudeInline) ? latitudeInline : null,
      longitude: Number.isFinite(longitudeInline) ? longitudeInline : null,
    };
  }

  if (Number.isFinite(latitudeResolved) || Number.isFinite(longitudeResolved)) {
    return {
      street,
      latitude: Number.isFinite(latitudeResolved) ? latitudeResolved : null,
      longitude: Number.isFinite(longitudeResolved) ? longitudeResolved : null,
    };
  }

  const coordinatePairFallback = extractCoordinatePairFallback();
  if (
    Number.isFinite(coordinatePairFallback.latitude) ||
    Number.isFinite(coordinatePairFallback.longitude)
  ) {
    return {
      street,
      latitude: coordinatePairFallback.latitude,
      longitude: coordinatePairFallback.longitude,
    };
  }

  return {
    street,
    latitude: Number.isFinite(latitude) ? latitude : null,
    longitude: Number.isFinite(longitude) ? longitude : null,
  };
}

function extractAmenitiesCategoriesFromHtml(
  html: string,
): Record<string, string[]> {
  const categories: Record<string, string[]> = {};

  const findArrayAfterKey = (source: string, key: string): string | null => {
    const keyMatch = new RegExp(`"${key}"\\s*:`, "i").exec(source);
    if (!keyMatch || typeof keyMatch.index !== "number") {
      return null;
    }

    const startIndex = source.indexOf("[", keyMatch.index);
    if (startIndex < 0) {
      return null;
    }

    let depth = 0;
    let inString = false;
    let escaping = false;
    for (let index = startIndex; index < source.length; index += 1) {
      const char = source[index];
      if (!char) {
        continue;
      }

      if (escaping) {
        escaping = false;
        continue;
      }

      if (char === "\\") {
        escaping = true;
        continue;
      }

      if (char === '"') {
        inString = !inString;
        continue;
      }

      if (inString) {
        continue;
      }

      if (char === "[") {
        depth += 1;
        continue;
      }

      if (char === "]") {
        depth -= 1;
        if (depth === 0) {
          return source.slice(startIndex, index + 1);
        }
      }
    }

    return null;
  };

  const amenityCategoriesPayload =
    findArrayAfterKey(html, "amenity_categories") ??
    html.match(/"amenity_categories"\s*:\s*(\[[\s\S]*?\])\s*[},]/i)?.[1] ??
    null;

  if (!amenityCategoriesPayload) {
    return categories;
  }

  try {
    const parsed = JSON.parse(amenityCategoriesPayload) as Array<{
      name?: unknown;
      amenities?: Array<{ name?: unknown }>;
    }>;

    for (const entry of parsed) {
      const rawCategory = typeof entry?.name === "string" ? entry.name : "";
      const cleanCategory = stripHtml(rawCategory).replace(/:\s*$/, "").trim();
      if (!cleanCategory) {
        continue;
      }

      const rawAmenities = Array.isArray(entry?.amenities)
        ? entry.amenities
        : [];
      const cleanAmenities = dedupePreserveOrder(
        rawAmenities
          .map((amenity) =>
            typeof amenity?.name === "string" ? stripHtml(amenity.name) : "",
          )
          .map((name) => name.trim())
          .filter(Boolean),
      );

      if (cleanAmenities.length === 0) {
        continue;
      }

      categories[cleanCategory] = cleanAmenities;
    }
  } catch {
    return {};
  }

  return categories;
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

async function installEvaluateNameShim(page: Page): Promise<void> {
  const shim = "window.__name = window.__name || ((target) => target);";
  await page.addInitScript(shim);
  await page.evaluate(shim);
}

async function clickTab(
  page: Page,
  tabText: string,
  reportProgress?: (message: string) => void,
): Promise<boolean> {
  const target = tabText.toLowerCase();
  const result = await evaluateWithDiagnostics(
    page,
    `ui.clickTab:${tabText}`,
    reportProgress,
    (targetText: string) => {
      const nodes = Array.from(
        document.querySelectorAll("a, button, [role='tab'], [role='button']"),
      );

      for (const node of nodes) {
        const element = node as HTMLElement;
        if (element.offsetParent === null) {
          continue;
        }

        if (element.tagName.toLowerCase() === "a") {
          const href = (element as HTMLAnchorElement)
            .getAttribute("href")
            ?.trim();
          if (!href) {
            continue;
          }

          const lowerHref = href.toLowerCase();
          const isInPageAnchor =
            lowerHref.startsWith("#") || lowerHref.startsWith("javascript:");
          if (!isInPageAnchor) {
            try {
              const absolute = new URL(href, window.location.href);
              const isSameDocument =
                absolute.origin === window.location.origin &&
                absolute.pathname === window.location.pathname &&
                absolute.search === window.location.search;
              if (!isSameDocument) {
                continue;
              }
            } catch {
              continue;
            }
          }
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
    },
    target,
  );

  if (result) {
    await page.waitForTimeout(900);
  }
  return result;
}

async function clickVisibleControlsByLabel(
  page: Page,
  labels: string[],
  reportProgress?: (message: string) => void,
): Promise<number> {
  const lowered = labels.map((label) => label.toLowerCase());
  const clicked = await evaluateWithDiagnostics(
    page,
    `ui.clickVisibleControlsByLabel:${labels.join("|")}`,
    reportProgress,
    (targets: string[]) => {
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

        if (element.tagName.toLowerCase() === "a") {
          const href = (element as HTMLAnchorElement)
            .getAttribute("href")
            ?.trim();
          if (!href) {
            continue;
          }

          const lowerHref = href.toLowerCase();
          const isInPageAnchor =
            lowerHref.startsWith("#") || lowerHref.startsWith("javascript:");
          if (!isInPageAnchor) {
            try {
              const absolute = new URL(href, window.location.href);
              const isSameDocument =
                absolute.origin === window.location.origin &&
                absolute.pathname === window.location.pathname &&
                absolute.search === window.location.search;
              if (!isSameDocument) {
                continue;
              }
            } catch {
              continue;
            }
          }
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
    },
    lowered,
  );

  if (clicked > 0) {
    await page.waitForTimeout(700);
  }

  return clicked;
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

  // Panhandle often starts above a heavy hero/nav fold; force list context first.
  await clickTab(page, "list view", reportProgress).catch(() => false);
  await page.waitForTimeout(Math.max(700, scrollPauseMs));

  await page
    .waitForSelector(
      `${SANDPIPER_RESULTS_SCROLL_GRID_SELECTOR}, ${SANDPIPER_RESULTS_FALLBACK_SELECTORS}`,
      {
        state: "attached",
        timeout: 9000,
      },
    )
    .catch(() => undefined);

  await evaluateWithDiagnostics(
    page,
    "discovery.scrollIntoResultsRoot",
    reportProgress,
    () => {
      const root =
        document.querySelector(
          "#lmpm-property-search-list-scroll > div.lmpm-search-grid",
        ) ??
        document.querySelector(
          "#lmpm-property-search-list-scroll > div, riot-solr-result-list, .result-list",
        );
      if (!root) {
        return;
      }

      const top = Math.max(
        0,
        window.scrollY + root.getBoundingClientRect().top - 120,
      );
      window.scrollTo(0, top);
    },
  );
  await page.waitForTimeout(Math.max(500, scrollPauseMs));

  const readDiscoverySnapshot = async (): Promise<{
    rows: Array<{ href: string; text: string }>;
    expectedCount: number | null;
  }> =>
    evaluateWithDiagnostics(
      page,
      "discovery.readSnapshot",
      reportProgress,
      () => {
        const rows: Array<{ href: string; text: string }> = [];
        const seen = new Set<string>();

        const detailPrefixPattern =
          /\/(?:vacation_rentals|vacation-rentals|all-properties)\//i;

        const toNormalized = (
          hrefValue: string,
          options?: {
            requireAllPropertiesHubId?: boolean;
            requireHubPropertyId?: boolean;
          },
        ): string => {
          try {
            const absolute = new URL(hrefValue, window.location.origin);
            const host = absolute.hostname.toLowerCase();
            const isAllowedHost =
              host.endsWith("sandpipervacationrentals.com") ||
              host.endsWith("sandpipervacationrentals.rezfusion.com");
            if (!isAllowedHost) {
              return "";
            }

            const normalizedPath = absolute.pathname
              .toLowerCase()
              .replace(/\/+$/, "");
            const matchesExpectedPrefix = [
              "/vacation_rentals/",
              "/vacation-rentals/",
              "/all-properties/",
            ].some((prefix) => normalizedPath.startsWith(prefix));
            if (!matchesExpectedPrefix) {
              return "";
            }

            const slug = normalizedPath.split("/").filter(Boolean).at(-1) ?? "";
            if (
              !slug ||
              slug === "vacation_rentals" ||
              slug === "vacation-rentals" ||
              slug === "all-properties" ||
              slug === "search-results" ||
              slug === "results"
            ) {
              return "";
            }

            if (!/^[a-z0-9][a-z0-9-]*$/i.test(slug)) {
              return "";
            }

            if (
              options?.requireAllPropertiesHubId &&
              normalizedPath.startsWith("/all-properties/") &&
              !absolute.searchParams.has("hub_property_id")
            ) {
              return "";
            }

            if (
              options?.requireHubPropertyId &&
              !absolute.searchParams.has("hub_property_id")
            ) {
              return "";
            }

            const pathOnly = `${absolute.origin}${absolute.pathname}`.replace(
              /\/$/,
              "",
            );
            const query = absolute.searchParams.toString();
            return query ? `${pathOnly}?${query}` : pathOnly;
          } catch {
            return "";
          }
        };

        const rootCandidates = Array.from(
          document.querySelectorAll(
            "#lmpm-property-search-list-scroll > div.lmpm-search-grid, #lmpm-property-search-list-scroll > div, #lmpm-property-search-list-scroll, riot-solr-result-list, .result-list, #post-6 > section",
          ),
        );

        const resultRoots = rootCandidates.filter((root) => {
          const links = Array.from(root.querySelectorAll("a[href]"));
          const detailLikeCount = links.filter((anchor) => {
            const href =
              (anchor as HTMLAnchorElement).getAttribute("href") ?? "";
            return detailPrefixPattern.test(href);
          }).length;
          return detailLikeCount >= 5;
        });
        const activeRoots = resultRoots;

        const listingContainers =
          activeRoots.length > 0
            ? activeRoots.flatMap((root) =>
                Array.from(
                  root.querySelectorAll(
                    "[data-item-id], [data-id], article, li, .lmpm-property-search-list-item, [class*='property'][class*='listing'], [class*='result'][class*='item'], [class*='property-card'], [class*='listing-card']",
                  ),
                ),
              )
            : [];

        const resultAnchors =
          listingContainers.length > 0
            ? listingContainers.flatMap((container) =>
                Array.from(
                  container.querySelectorAll(
                    "a[href*='/all-properties/'][href*='hub_property_id='], a[href*='/vacation_rentals/'][href*='hub_property_id='], a[href*='/vacation-rentals/'][href*='hub_property_id=']",
                  ),
                ),
              )
            : activeRoots.flatMap((root) =>
                Array.from(
                  root.querySelectorAll(
                    "a[href*='/all-properties/'][href*='hub_property_id='], a[href*='/vacation_rentals/'][href*='hub_property_id='], a[href*='/vacation-rentals/'][href*='hub_property_id=']",
                  ),
                ),
              );

        for (const anchor of resultAnchors) {
          const hrefRaw =
            (anchor as HTMLAnchorElement).getAttribute("href") ?? "";
          if (!hrefRaw) {
            continue;
          }

          const normalized = toNormalized(hrefRaw, {
            requireHubPropertyId: true,
          });
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

        let expectedCount: number | null = null;
        const bodyText = document.body?.innerText ?? "";
        const match = bodyText.match(
          /\b(\d{1,4})\s+(?:results|rentals|properties)\b/i,
        );
        if (match) {
          const parsed = Number(match[1]);
          if (Number.isFinite(parsed) && parsed > 0) {
            expectedCount = Math.floor(parsed);
          }
        }

        return {
          rows,
          expectedCount,
        };
      },
    );

  let discovery = await readDiscoverySnapshot();
  const discoveredByHref = new Map<string, string>();
  for (const row of discovery.rows) {
    const href = normalizeDetailUrl(row.href);
    if (!href || discoveredByHref.has(href)) {
      continue;
    }
    discoveredByHref.set(href, row.text);
  }
  let previousCount = discovery.rows.length;
  let stagnantSteps = 0;
  // Panhandle relies on long-running incremental lazy load; allow deeper passes.
  const effectiveScrollSteps = Math.max(40, maxScrollSteps);
  const effectivePauseMs = Math.max(300, Math.min(scrollPauseMs, 1000));
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
      discoveredByHref.size >= discovery.expectedCount
    ) {
      reportProgress(
        `discovery reached expected count after scroll step ${step}: ${discoveredByHref.size}/${discovery.expectedCount}`,
      );
      break;
    }

    await page.mouse.wheel(0, wheelDelta);
    await evaluateWithDiagnostics(
      page,
      "discovery.scrollByHalfViewport",
      reportProgress,
      () => {
        window.scrollBy(0, Math.floor(window.innerHeight * 0.5));
      },
    );
    await page.waitForTimeout(effectivePauseMs);

    const snapshot = await readDiscoverySnapshot();
    discovery = snapshot;
    for (const row of snapshot.rows) {
      const href = normalizeDetailUrl(row.href);
      if (!href || discoveredByHref.has(href)) {
        continue;
      }
      discoveredByHref.set(href, row.text);
    }
    if (discoveredByHref.size > previousCount) {
      reportProgress(
        `discovery grew to ${discoveredByHref.size}${
          discovery.expectedCount ? `/${discovery.expectedCount}` : ""
        } at scroll step ${step + 1}`,
      );
      previousCount = discoveredByHref.size;
      stagnantSteps = 0;
      continue;
    }

    stagnantSteps += 1;
    if (stagnantSteps >= 10 && step >= 20) {
      break;
    }
  }

  if (discovery.expectedCount !== null) {
    reportProgress(
      `discovery final captured=${discoveredByHref.size}/${discovery.expectedCount}`,
    );
  } else {
    reportProgress(`discovery final captured=${discoveredByHref.size}`);
  }

  return Array.from(discoveredByHref.entries()).map(([href, text]) => ({
    link: href,
    source_url: anchorUrl,
    anchor_text: text,
  }));
}

async function extractAvailabilitySnapshot(
  page: Page,
  reportProgress?: DetailProgressReporter,
): Promise<{
  hasCalendarWidget: boolean;
  months: string[];
  items: Array<{ date: string; code: LuxuryDayCode }>;
  bookingRestrictions: string[];
}> {
  return evaluateWithDiagnostics(
    page,
    "detail.extractAvailabilitySnapshot",
    reportProgress,
    () => {
      const items: Array<{ date: string; code: LuxuryDayCode }> = [];
      const monthHeaders = Array.from(
        document.querySelectorAll(
          ".pdp-availability-calendar-container .mb-2 strong, .pdp-availability-calendar-container .mb-2, .CalendarMonth_caption, .DayPicker-Caption, [class*='CalendarMonth'] [class*='caption'], [class*='month'] [class*='caption']",
        ),
      )
        .map((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim())
        .filter(Boolean);

      for (const cell of Array.from(
        document.querySelectorAll("td[data-date]"),
      )) {
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

      const parseIsoDateFromLabel = (label: string): string | null => {
        const cleaned = label.replace(/\s+/g, " ").trim();
        if (!cleaned) {
          return null;
        }

        const monthDateMatch = cleaned.match(
          /(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}/i,
        );
        if (!monthDateMatch?.[0]) {
          return null;
        }

        const parsed = new Date(monthDateMatch[0]);
        if (!Number.isFinite(parsed.getTime())) {
          return null;
        }

        return new Date(
          Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate()),
        )
          .toISOString()
          .slice(0, 10);
      };

      const modernDayNodes = Array.from(
        document.querySelectorAll(
          ".CalendarDay, [class*='CalendarDay'], .DayPicker-Day, [role='gridcell'][aria-label], [aria-label*='available' i], [aria-label*='unavailable' i], [aria-label*='booked' i], [aria-label*='check-in' i], [aria-label*='check-out' i]",
        ),
      );

      for (const node of modernDayNodes) {
        const el = node as HTMLElement;
        const classBlob = String(el.className || "").toLowerCase();
        const ariaLabel = (el.getAttribute("aria-label") ?? "").trim();
        const textBlob = `${ariaLabel} ${classBlob}`.toLowerCase();

        const dateFromAria = parseIsoDateFromLabel(ariaLabel);
        if (!dateFromAria) {
          continue;
        }

        let code: LuxuryDayCode = "X";
        if (
          /not available|unavailable|blocked|booked|disabled/.test(textBlob)
        ) {
          code = "U";
        } else if (/check[- ]?in|arrive/.test(textBlob)) {
          code = "I";
        } else if (/check[- ]?out|depart/.test(textBlob)) {
          code = "O";
        } else if (/available/.test(textBlob)) {
          code = "A";
        }

        items.push({ date: dateFromAria, code });
      }

      const keyText = Array.from(
        document.querySelectorAll(
          ".be-calendar-legend-key-text, .rcav-key, .bre-ui-datepicker-extras, .label",
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
          ".pdp-availability-calendar, .pdp-availability-calendar-table, .ui-datepicker, .ui-datepicker-inline, .rcav-key, #startDate, #endDate, .DateRangePicker, [class*='CalendarDay'], .DayPicker",
        ),
        months: Array.from(new Set(monthHeaders)),
        items,
        bookingRestrictions: Array.from(new Set(keyText)).slice(0, 40),
      };
    },
  );
}

async function extractAvailabilityFromLmpmApi(
  page: Page,
  propertyId: string,
  todayIso: string,
  horizonIso: string,
): Promise<
  Array<{ date: string; code: LuxuryDayCode; minNights: number | null }>
> {
  const rows: Array<{
    date: string;
    code: LuxuryDayCode;
    minNights: number | null;
  }> = [];

  const cursor = new Date(`${todayIso}T00:00:00Z`);
  const horizon = new Date(`${horizonIso}T00:00:00Z`);

  while (cursor.getTime() <= horizon.getTime()) {
    const startIso = cursor.toISOString().slice(0, 10);
    const end = new Date(cursor);
    end.setUTCDate(end.getUTCDate() + 30);
    if (end.getTime() > horizon.getTime()) {
      end.setTime(horizon.getTime());
    }
    const endIso = end.toISOString().slice(0, 10);

    const endpoint =
      `https://sandpipervacationrentals.com/wp-json/lmpm/v1/properties/${encodeURIComponent(propertyId)}/dates` +
      `?start=${startIso}&end=${endIso}&pms_id=${encodeURIComponent(propertyId)}&_locale=user`;

    const response = await page.request.get(endpoint, {
      timeout: 30000,
      failOnStatusCode: false,
    });

    if (!response.ok()) {
      break;
    }

    const payload = (await response.json()) as Array<{
      date?: unknown;
      status?: unknown;
      check_in?: unknown;
      check_out?: unknown;
      disable_check_in?: unknown;
      disable_check_out?: unknown;
      mlos?: unknown;
    }>;

    if (!Array.isArray(payload) || payload.length === 0) {
      break;
    }

    for (const day of payload) {
      const date = typeof day.date === "string" ? day.date.slice(0, 10) : "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        continue;
      }

      const status =
        typeof day.status === "string" ? day.status.toLowerCase() : "";
      const checkIn = day.check_in === true;
      const checkOut = day.check_out === true;
      const disableCheckIn = day.disable_check_in === true;
      const disableCheckOut = day.disable_check_out === true;

      let code: LuxuryDayCode = "X";
      if (/booked|unavailable|blocked|closed/.test(status)) {
        code = "U";
      } else if (checkIn && !checkOut) {
        code = "I";
      } else if (checkOut && !checkIn) {
        code = "O";
      } else if (
        /available|open/.test(status) ||
        (!disableCheckIn && !disableCheckOut)
      ) {
        code = "A";
      }

      const mlosRaw =
        typeof day.mlos === "number"
          ? day.mlos
          : typeof day.mlos === "string"
            ? Number(day.mlos)
            : NaN;
      const minNights =
        Number.isFinite(mlosRaw) && mlosRaw > 0 ? Math.floor(mlosRaw) : null;

      rows.push({ date, code, minNights });
    }

    cursor.setUTCDate(cursor.getUTCDate() + 31);
  }

  return rows;
}

async function extractDescriptionText(
  page: Page,
  reportProgress?: DetailProgressReporter,
): Promise<string> {
  await clickTab(page, "Description", reportProgress);

  return evaluateWithDiagnostics(
    page,
    "detail.extractDescriptionText",
    reportProgress,
    () => {
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
    },
  );
}

async function waitForCookie(input: {
  page: Page;
  origin: string;
  cookieName: string;
  timeoutMs: number;
}): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < input.timeoutMs) {
    const cookies = await input.page.context().cookies(input.origin);
    if (cookies.some((cookie) => cookie.name === input.cookieName)) {
      return true;
    }
    await input.page.waitForTimeout(350);
  }
  return false;
}

async function detectChallengeSignal(
  page: Page,
  reportProgress?: DetailProgressReporter,
): Promise<string | null> {
  const signal = await evaluateWithDiagnostics(
    page,
    "detail.detectChallengeSignal",
    reportProgress,
    () => {
      const text = `${document.title || ""} ${document.body?.innerText ?? ""}`
        .toLowerCase()
        .replace(/\s+/g, " ");

      if (
        text.includes("just a moment") ||
        text.includes("attention required") ||
        text.includes("verify you are human") ||
        text.includes("checking your browser") ||
        text.includes("cf-challenge") ||
        text.includes("cloudflare") ||
        text.includes("captcha")
      ) {
        return "challenge_detected";
      }

      return null;
    },
  );

  return typeof signal === "string" ? signal : null;
}

async function waitForDetailHydration(
  page: Page,
  reportProgress?: DetailProgressReporter,
): Promise<void> {
  await page
    .waitForSelector(
      "h1, .lmpm-property-stats, .pdp-property-info-list-item, [class*='property-listing-title']",
      { state: "attached", timeout: 15000 },
    )
    .catch(() => undefined);

  for (let step = 0; step < 4; step += 1) {
    await evaluateWithDiagnostics(
      page,
      "detail.hydration.scrollNudge",
      reportProgress,
      () => {
        window.scrollBy(0, Math.floor(window.innerHeight * 0.35));
      },
    );
    await page.waitForTimeout(450);
  }

  await evaluateWithDiagnostics(
    page,
    "detail.hydration.scrollReset",
    reportProgress,
    () => {
      window.scrollTo(0, 0);
    },
  );

  await page.waitForTimeout(900);
}

async function fetchDetail(
  browser: Browser,
  detailUrl: string,
  availabilityHorizonDays: number,
  maxCalendarAdvanceMonths: number,
  reportDetailProgress?: DetailProgressReporter,
): Promise<LuxuryDetailRecord | null> {
  const startedAt = Date.now();
  const page = await browser.newPage();

  try {
    await installEvaluateNameShim(page);

    const hubPropertyId = extractHubPropertyIdFromUrl(detailUrl);
    const canonicalDetailUrl = toCanonicalDetailNavigationUrl(detailUrl);

    const beforeLoad = Date.now();
    let response = await page.goto(canonicalDetailUrl, {
      waitUntil: "domcontentloaded",
      timeout: 120000,
    });

    if ((response?.status() ?? 0) >= 400 && canonicalDetailUrl !== detailUrl) {
      response = await page.goto(detailUrl, {
        waitUntil: "domcontentloaded",
        timeout: 120000,
      });
    }

    let responseStatus = response?.status() ?? null;
    const responseHeaders = response?.headers() ?? {};
    const cfMitigated = responseHeaders["cf-mitigated"]?.trim().toLowerCase();

    if (responseStatus === 403 && cfMitigated === "challenge") {
      const origin = (() => {
        try {
          return new URL(canonicalDetailUrl).origin;
        } catch {
          return "https://sandpipervacationrentals.com";
        }
      })();

      const gotClearance = await waitForCookie({
        page,
        origin,
        cookieName: "cf_clearance",
        timeoutMs: 8000,
      });

      if (gotClearance) {
        response = await page.goto(canonicalDetailUrl, {
          waitUntil: "domcontentloaded",
          timeout: 120000,
        });
        responseStatus = response?.status() ?? responseStatus;
      }
    }

    if (responseStatus === 403 || responseStatus === 429) {
      const reason =
        responseStatus === 403
          ? "status=403 challenge_or_forbidden"
          : "status=429 rate_limited";
      reportDetailProgress?.(
        `detail failed listing=${detailUrl} reason=${reason}`,
      );
      throw new Error(reason);
    }

    await waitForDetailHydration(page, reportDetailProgress);

    const challengeSignal = await detectChallengeSignal(
      page,
      reportDetailProgress,
    );
    if (challengeSignal) {
      const reason = `status=403 ${challengeSignal}`;
      reportDetailProgress?.(
        `detail failed listing=${detailUrl} reason=${reason}`,
      );
      throw new Error(reason);
    }

    await clickVisibleControlsByLabel(
      page,
      [
        "photos",
        "read more",
        "show all amenities",
        "show all",
        "view all amenities",
        "all photos",
        "view photos",
        "gallery",
        "lightbox",
      ],
      reportDetailProgress,
    );

    // Some listing templates lazy-mount amenities content behind a tab.
    await clickVisibleControlsByLabel(
      page,
      ["amenities", "amenity", "amenitieis"],
      reportDetailProgress,
    );
    await clickTab(page, "Amenities", reportDetailProgress);
    await page
      .waitForSelector(
        "#lmpm-property-listing-all-amenities, [data-component='lmpm-property-listing-all-amenities'], #amenities",
        {
          state: "attached",
          timeout: 2500,
        },
      )
      .catch(() => undefined);

    const pageLoadMs = Date.now() - beforeLoad;

    const extracted = await evaluateWithDiagnostics(
      page,
      "detail.extractPrimaryPayload",
      reportDetailProgress,
      () => {
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
            const propertyHeading = document.querySelector(
              "h1[class*='property-listing-title']",
            );
            const propertyText = (propertyHeading?.textContent ?? "")
              .replace(/\s+/g, " ")
              .trim();
            if (propertyText) {
              return propertyText;
            }

            const fallbackHeadings = Array.from(
              document.querySelectorAll("h1"),
            );
            for (const heading of fallbackHeadings) {
              const text = (heading.textContent ?? "")
                .replace(/\s+/g, " ")
                .trim();
              if (text) {
                return text;
              }
            }

            return "";
          })(),
          canonical:
            document
              .querySelector("link[rel='canonical']")
              ?.getAttribute("href") ?? "",
          mapLatitude: (() => {
            const byWindow = (window as Record<string, unknown>)[
              "_lmpmHubSearchApiMapCenterLat"
            ];
            if (typeof byWindow === "number" && Number.isFinite(byWindow)) {
              return byWindow;
            }
            if (typeof byWindow === "string") {
              const parsed = Number(byWindow);
              if (Number.isFinite(parsed)) {
                return parsed;
              }
            }

            const html = document.documentElement.outerHTML;
            const pairMatch = html.match(
              /(-?\d{1,2}\.\d{4,})\s*,\s*(-?\d{1,3}\.\d{4,})/,
            );
            if (!pairMatch?.[1]) {
              return null;
            }

            const latitude = Number(pairMatch[1]);
            return Number.isFinite(latitude) ? latitude : null;
          })(),
          mapLongitude: (() => {
            const byWindow = (window as Record<string, unknown>)[
              "_lmpmHubSearchApiMapCenterLong"
            ];
            if (typeof byWindow === "number" && Number.isFinite(byWindow)) {
              return byWindow;
            }
            if (typeof byWindow === "string") {
              const parsed = Number(byWindow);
              if (Number.isFinite(parsed)) {
                return parsed;
              }
            }

            const html = document.documentElement.outerHTML;
            const pairMatch = html.match(
              /(-?\d{1,2}\.\d{4,})\s*,\s*(-?\d{1,3}\.\d{4,})/,
            );
            if (!pairMatch?.[2]) {
              return null;
            }

            const longitude = Number(pairMatch[2]);
            return Number.isFinite(longitude) ? longitude : null;
          })(),
          metaDescription: getMeta("description") || getMeta("og:description"),
          sleepsText: (() => {
            const propertyStats = document.querySelector(
              ".lmpm-ps-occupancy, .lmpm-property-stats .lmpm-ps-occupancy",
            );
            const propertyStatsText = (propertyStats?.textContent ?? "")
              .replace(/\s+/g, " ")
              .trim();
            if (propertyStatsText) {
              return propertyStatsText;
            }

            const summaryCards = Array.from(
              document.querySelectorAll(".size-summary [class*='summary']"),
            );
            for (const card of summaryCards) {
              const label =
                card.querySelector("small")?.textContent?.toLowerCase() ?? "";
              if (!label.includes("sleep")) {
                continue;
              }

              const text = (card.textContent ?? "").replace(/\s+/g, " ").trim();
              const valueMatch = text.match(/\d+(?:\.\d+)?/);
              if (valueMatch?.[0]) {
                return valueMatch[0];
              }
            }

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
            const propertyStats = document.querySelector(
              ".lmpm-ps-bedrooms, .lmpm-property-stats .lmpm-ps-bedrooms",
            );
            const propertyStatsText = (propertyStats?.textContent ?? "")
              .replace(/\s+/g, " ")
              .trim();
            if (propertyStatsText) {
              return propertyStatsText;
            }

            const summaryCards = Array.from(
              document.querySelectorAll(".size-summary [class*='summary']"),
            );
            for (const card of summaryCards) {
              const label =
                card.querySelector("small")?.textContent?.toLowerCase() ?? "";
              if (!label.includes("bed")) {
                continue;
              }

              const text = (card.textContent ?? "").replace(/\s+/g, " ").trim();
              const valueMatch = text.match(/\d+(?:\.\d+)?/);
              if (valueMatch?.[0]) {
                return valueMatch[0];
              }
            }

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
            const propertyStats = document.querySelector(
              ".lmpm-ps-bathrooms, .lmpm-property-stats .lmpm-ps-bathrooms",
            );
            const propertyStatsText = (propertyStats?.textContent ?? "")
              .replace(/\s+/g, " ")
              .trim();
            if (propertyStatsText) {
              return propertyStatsText;
            }

            const summaryCards = Array.from(
              document.querySelectorAll(".size-summary [class*='summary']"),
            );
            for (const card of summaryCards) {
              const label =
                card.querySelector("small")?.textContent?.toLowerCase() ?? "";
              if (!label.includes("bath")) {
                continue;
              }

              const text = (card.textContent ?? "").replace(/\s+/g, " ").trim();
              const valueMatch = text.match(/\d+(?:\.\d+)?/);
              if (valueMatch?.[0]) {
                return valueMatch[0];
              }
            }

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
              ?.textContent?.trim() ??
            document
              .querySelector(
                ".entry-title small, .unit-header .entry-title small",
              )
              ?.textContent?.trim() ??
            "",
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
            "",
          amenitiesCategories: (() => {
            const categories: Record<string, string[]> = {};
            const lmpmRoots = Array.from(
              document.querySelectorAll(
                "#lmpm-property-listing-all-amenities, [data-component='lmpm-property-listing-all-amenities']",
              ),
            );

            for (const root of lmpmRoots) {
              const headingNodes = Array.from(
                root.querySelectorAll("h5, h4, h3"),
              );
              for (const headingNode of headingNodes) {
                const category = (headingNode.textContent ?? "")
                  .replace(/:\s*$/, "")
                  .replace(/\s+/g, " ")
                  .trim();
                if (!category || category.toLowerCase() === "amenities") {
                  continue;
                }

                const row =
                  headingNode.closest(".wp-block-columns") ??
                  headingNode.parentElement;
                const items: string[] = [];

                let cursor = row?.nextElementSibling ?? null;
                while (cursor) {
                  const hasNextHeading = !!cursor.querySelector("h5, h4, h3");
                  if (hasNextHeading) {
                    break;
                  }

                  const cursorItems = Array.from(
                    cursor.querySelectorAll(
                      "small, li, .pdp-amenities-item-text, .lmpm-amenity-label",
                    ),
                  )
                    .map((el) =>
                      (el.textContent ?? "").replace(/\s+/g, " ").trim(),
                    )
                    .filter(Boolean)
                    .map((item) => item.replace(/^[-•]+\s*/, ""));
                  items.push(...cursorItems);
                  cursor = cursor.nextElementSibling;
                }

                const deduped = Array.from(new Set(items.filter(Boolean)));
                if (deduped.length > 0) {
                  categories[category] = deduped;
                }
              }
            }

            if (Object.keys(categories).length > 0) {
              return categories;
            }

            const modernGroups = Array.from(
              document.querySelectorAll(".pdp-amenities-list-group"),
            );
            for (const group of modernGroups) {
              const heading =
                group.querySelector(".pdp-amenities-list-heading")
                  ?.textContent ?? "";
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
                  .map((li) =>
                    (li.textContent ?? "").replace(/\s+/g, " ").trim(),
                  )
                  .filter(Boolean);

                if (items.length > 0) {
                  categories[category] = items;
                }
              }
            }

            if (Object.keys(categories).length === 0) {
              const legacyGroups = Array.from(
                document.querySelectorAll(
                  "#collapseAmenities strong, #amenities strong, .panel-body strong",
                ),
              );

              for (const headingNode of legacyGroups) {
                const headingText = (headingNode.textContent ?? "")
                  .replace(/:\s*$/, "")
                  .replace(/\s+/g, " ")
                  .trim();
                if (!headingText) {
                  continue;
                }

                let nearbyList: Element | null = null;
                let cursor = headingNode.nextElementSibling;
                while (cursor) {
                  if (cursor.matches("strong")) {
                    break;
                  }
                  if (cursor.matches("ul.amenities-list, ul")) {
                    nearbyList = cursor;
                    break;
                  }
                  cursor = cursor.nextElementSibling;
                }

                if (!nearbyList) {
                  continue;
                }

                const items = Array.from(nearbyList.querySelectorAll("li"))
                  .map((li) =>
                    (li.textContent ?? "").replace(/\s+/g, " ").trim(),
                  )
                  .filter(Boolean)
                  .map((item) => item.replace(/^[-•]+\s*/, ""))
                  .filter(Boolean);

                if (items.length > 0) {
                  categories[headingText] = Array.from(new Set(items));
                }
              }
            }

            if (Object.keys(categories).length === 0) {
              const listItems = Array.from(
                document.querySelectorAll(
                  "#collapseAmenities li, #amenities li",
                ),
              )
                .map((li) => (li.textContent ?? "").replace(/\s+/g, " ").trim())
                .filter(Boolean)
                .map((item) => item.replace(/^[-•]+\s*/, ""))
                .filter(Boolean);

              if (listItems.length > 0) {
                categories["Amenities"] = Array.from(new Set(listItems));
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
              document.querySelector(".image-gallery") ??
              document.querySelector(".image-gallery-slides");
            if (!mediaRoot) {
              return urls;
            }

            const attrValues = Array.from(
              mediaRoot.querySelectorAll(
                "a[href], img[src], img[data-src], img[data-rstmb], [data-rsbigimg], [data-image]",
              ),
            );

            for (const node of attrValues) {
              const attrs = [
                node.getAttribute("href"),
                node.getAttribute("src"),
                node.getAttribute("data-src"),
                node.getAttribute("data-rstmb"),
                node.getAttribute("data-rsbigimg"),
                node.getAttribute("data-image"),
              ];
              for (const raw of attrs) {
                if (!raw) {
                  continue;
                }
                try {
                  const candidate = raw.trim().split(/\s+/)[0] ?? "";
                  const absolute = new URL(
                    candidate,
                    window.location.origin,
                  ).toString();
                  if (
                    /\.(jpe?g|png|webp|gif)(\?|$)/i.test(absolute) ||
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
      },
    );

    const currentPageUrl = page.url();
    const canonicalCandidate = extracted.canonical.trim();
    const resolvedCanonical = canonicalCandidate || currentPageUrl;
    const pageIdentity = `${extracted.title} ${extracted.h1}`
      .toLowerCase()
      .replace(/\s+/g, " ");

    if (!isLikelyDetailUrl(resolvedCanonical)) {
      const reason = `status=404 non_detail_landing final_url=${currentPageUrl} canonical=${canonicalCandidate || "n/a"}`;
      reportDetailProgress?.(
        `detail failed listing=${detailUrl} reason=${reason}`,
      );
      throw new Error(reason);
    }

    if (
      pageIdentity.includes("wordpress ") &&
      pageIdentity.includes(" error")
    ) {
      const reason = `status=500 cms_error_page final_url=${currentPageUrl}`;
      reportDetailProgress?.(
        `detail failed listing=${detailUrl} reason=${reason}`,
      );
      throw new Error(reason);
    }

    const descriptionText = (
      await extractDescriptionText(page, reportDetailProgress)
    ).slice(0, 15000);
    const descriptionExpanded = stripHtml(descriptionText).slice(0, 30000);
    const lightboxGalleryUrls = await extractLightboxGalleryUrls(
      page,
      reportDetailProgress,
    );

    await clickTab(page, "Availability", reportDetailProgress);
    await evaluateWithDiagnostics(
      page,
      "detail.openAvailabilityCalendar",
      reportDetailProgress,
      () => {
        const openers = Array.from(
          document.querySelectorAll<HTMLElement>(
            "#startDate, input[name='startDate'], input[name='checkInDate'], .DateRangePickerInput input, [aria-label*='check in' i], [placeholder*='start date' i], [placeholder*='check in' i]",
          ),
        );

        for (const opener of openers) {
          if (opener.offsetParent === null) {
            continue;
          }
          opener.click();
          break;
        }
      },
    );
    await page.waitForTimeout(700);

    const dayCodeByDate = new Map<string, LuxuryDayCode>();
    const codePriority: Record<LuxuryDayCode, number> = {
      X: 0,
      A: 1,
      U: 1,
      I: 2,
      O: 2,
    };

    const bookingRestrictions = new Set<string>();
    const seenMonthSignatures = new Set<string>();
    const minNightsByDate = new Map<string, number>();

    let calendarClicks = 0;
    let calendarIterations = 0;
    let stagnantIterations = 0;

    const now = new Date();
    const todayIso = now.toISOString().slice(0, 10);
    const horizon = new Date(now);
    horizon.setUTCDate(horizon.getUTCDate() + availabilityHorizonDays);
    const horizonIso = horizon.toISOString().slice(0, 10);

    if (hubPropertyId) {
      const apiRows = await extractAvailabilityFromLmpmApi(
        page,
        hubPropertyId,
        todayIso,
        horizonIso,
      );

      for (const row of apiRows) {
        const previous = dayCodeByDate.get(row.date);
        if (!previous || codePriority[row.code] > codePriority[previous]) {
          dayCodeByDate.set(row.date, row.code);
        }
        if (row.minNights !== null) {
          minNightsByDate.set(row.date, row.minNights);
        }
      }
    }

    if (dayCodeByDate.size === 0) {
      for (
        let iteration = 0;
        iteration < Math.max(1, maxCalendarAdvanceMonths);
        iteration += 1
      ) {
        calendarIterations += 1;

        const snapshot = await extractAvailabilitySnapshot(
          page,
          reportDetailProgress,
        );
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
        if (stagnantIterations >= 3) {
          break;
        }

        const clickedNext = await evaluateWithDiagnostics(
          page,
          "detail.calendar.clickNext",
          reportDetailProgress,
          () => {
            const nodes = Array.from(
              document.querySelectorAll(
                "a.ui-datepicker-next, button.next, a.next, .rc-calendar-next, [class*='calendar'] .next, [class*='datepicker'] [title*='Next' i], [class*='datepicker'] [aria-label*='Next' i], button[title*='Next' i], a[title*='Next' i], button[aria-label*='Next' i], a[aria-label*='Next' i], button[aria-label*='Move forward' i], button[aria-label*='next month' i], .DayPickerNavigation_button__horizontalDefault",
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
          },
        );

        if (!clickedNext) {
          break;
        }

        calendarClicks += 1;
        await page.waitForTimeout(750);
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
          day_code: toDayCodeFromStatus(code),
          status_code: code,
          changeover_code: toChangeoverCodeFromStatus(code),
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
          day_code: "N",
          status_code: "X",
          changeover_code: "X",
          is_available: false,
          is_available_for_checkin: false,
          is_available_for_checkout: false,
          booking_day_state: "unknown",
          min_nights_required: null,
        },
      );
      windowCursor.setUTCDate(windowCursor.getUTCDate() + 1);
    }

    deriveTurnDayStatuses(completeWindowDays);

    const liveMapCoords = await evaluateWithDiagnostics(
      page,
      "detail.extractLiveMapCoords",
      reportDetailProgress,
      () => {
        const parseCandidate = (value: unknown): number | null => {
          if (typeof value === "number" && Number.isFinite(value)) {
            return value;
          }
          if (typeof value === "string") {
            const parsed = Number(value);
            if (Number.isFinite(parsed)) {
              return parsed;
            }
          }
          return null;
        };

        const latFromWindow = parseCandidate(
          (window as Record<string, unknown>)._lmpmHubSearchApiMapCenterLat,
        );
        const lngFromWindow = parseCandidate(
          (window as Record<string, unknown>)._lmpmHubSearchApiMapCenterLong,
        );
        if (latFromWindow !== null && lngFromWindow !== null) {
          return { latitude: latFromWindow, longitude: lngFromWindow };
        }

        const html = document.documentElement.outerHTML;
        const pairMatch = html.match(
          /(-?\d{1,2}\.\d{4,})\s*,\s*(-?\d{1,3}\.\d{4,})/,
        );
        if (pairMatch?.[1] && pairMatch?.[2]) {
          const latitude = Number(pairMatch[1]);
          const longitude = Number(pairMatch[2]);
          if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
            return { latitude, longitude };
          }
        }

        return { latitude: null, longitude: null };
      },
    );

    const externalListingId = extractExternalListingId(detailUrl);
    const htmlPath = resolve(
      OUTPUT_DETAILS_HTML_DIR,
      `${externalListingId}.html`,
    );
    const html = await page.content();
    const unitCodeFromHtml = extractRequiredUnitCodeFromHtml(html);
    const hubPropertyDecoded = hubPropertyId
      ? decodeHubPropertyId(hubPropertyId)
      : { itemCode: null, propertyId: null };
    const unitCode = unitCodeFromHtml ?? hubPropertyId;
    if (!unitCode) {
      throw new Error(
        "Missing required unit code and hub_property_id in detail context",
      );
    }
    await writeFile(htmlPath, html, "utf8");

    const locationPayload = extractFieldLocationFromHtml(html);

    const beds = parseFirstNumber(extracted.bedroomsText);
    const baths = parseFirstNumber(extracted.bathroomsText);
    const sleeps = parseFirstNumber(extracted.sleepsText);
    const neighborhood = stripHtml(extracted.neighborhoodText).slice(0, 240);

    const propertyProfile: LuxuryDetailRecord["property_profile"] = {
      unit_id: stripHtml(extracted.unitId || externalListingId).slice(0, 140),
      area: neighborhood,
      location: neighborhood,
      beds,
      baths,
      sleeps,
      city: parseCityStateFromAddress(locationPayload.street).city,
      state: parseCityStateFromAddress(locationPayload.street).state,
    };

    const amenitiesCategories: Record<string, string[]> = {};
    for (const [category, items] of Object.entries(
      extracted.amenitiesCategories,
    )) {
      const cleanCategory = stripHtml(category).slice(0, 120);
      const cleanItems = dedupePreserveOrder(
        items.map((item) => {
          const cleaned = stripHtml(item).slice(0, 200);
          if (!cleanCategory) {
            return cleaned;
          }

          const prefix = `${cleanCategory} - `;
          if (cleaned.toLowerCase().startsWith(prefix.toLowerCase())) {
            return cleaned.slice(prefix.length).trim();
          }

          return cleaned;
        }),
      );
      if (!cleanCategory || cleanItems.length === 0) {
        continue;
      }
      amenitiesCategories[cleanCategory] = cleanItems;
    }

    if (Object.keys(amenitiesCategories).length === 0) {
      const fallbackCategories = extractAmenitiesCategoriesFromHtml(html);
      for (const [category, items] of Object.entries(fallbackCategories)) {
        if (items.length === 0) {
          continue;
        }
        amenitiesCategories[category] = dedupePreserveOrder(items);
      }
    }

    const amenitiesAll = dedupePreserveOrder(
      Object.values(amenitiesCategories).flat(),
    );
    const amenities: LuxuryDetailRecord["amenities"] = {
      categories: amenitiesCategories,
      all: amenitiesAll,
    };

    const htmlGalleryUrls = extractGalleryUrlsFromHtmlMarkup(html, detailUrl);
    const mediaUrls = dedupeResolvedGalleryUrls(
      dedupePreserveOrder([
        ...lightboxGalleryUrls,
        ...extracted.galleryUrls,
        ...htmlGalleryUrls,
      ]),
    );
    const mediaGallery: LuxuryDetailRecord["media_gallery"] = {
      image_count: mediaUrls.length,
      image_urls: mediaUrls,
    };

    const latitudeRaw =
      locationPayload.latitude ??
      liveMapCoords.latitude ??
      (typeof extracted.mapLatitude === "number"
        ? extracted.mapLatitude
        : null);
    const longitudeRaw =
      locationPayload.longitude ??
      liveMapCoords.longitude ??
      (typeof extracted.mapLongitude === "number"
        ? extracted.mapLongitude
        : null);
    const latitude = latitudeRaw === 0 ? null : latitudeRaw;
    const longitude = longitudeRaw === 0 ? null : longitudeRaw;
    const streetAddress = stripHtml(locationPayload.street).slice(0, 240);
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
      source: "pm_sandpiper30a" as const,
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

    return {
      external_listing_id: externalListingId,
      detail_url: detailUrl,
      quote_context: {
        unit_code: unitCode,
        detail_url: detailUrl,
        ...(hubPropertyId
          ? {
              hub_property_id: hubPropertyId,
              pms_id: hubPropertyId,
              property_id: hubPropertyId,
            }
          : {}),
        ...(hubPropertyDecoded.itemCode
          ? { item_code: hubPropertyDecoded.itemCode }
          : {}),
        ...(hubPropertyDecoded.propertyId
          ? { item_id: hubPropertyDecoded.propertyId }
          : {}),
      },
      fetched_at: new Date().toISOString(),
      title: normalizeListingName(extracted.title || extracted.h1 || ""),
      h1: listingName,
      canonical_url: extracted.canonical || detailUrl,
      meta_description: stripHtml(extracted.metaDescription).slice(0, 2000),
      description_expanded: descriptionExpanded,
      rooms_guidance: false,
      amenities,
      location,
      media_gallery: mediaGallery,
      property_profile: propertyProfile,
      normalized_matching_profile: normalizedMatchingProfile,
      normalized_availability: {
        source: "pm_sandpiper30a",
        external_listing_id: externalListingId,
        captured_at: new Date().toISOString(),
        has_calendar_widget: normalizedDays.length > 0,
        booking_restrictions: Array.from(bookingRestrictions),
        min_night_rules: [],
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
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "unknown detail pull error";
    reportDetailProgress?.(
      `detail failed listing=${detailUrl} reason=${message} final_url=${safePageUrl(page)}`,
    );
    console.warn(
      `[sandpiper30a] detail pull failed for ${detailUrl}: ${message}`,
    );
    return null;
  } finally {
    await page.close();
  }
}

export function createSandpiper30AAdapter(): ScraperAdapter<LuxuryDetailRecord> {
  return {
    managerKey: "sandpiper30a",
    scriptLabel: "sandpiper30a",
    defaultAnchorUrl: DEFAULT_ANCHOR_URL,
    detailFetchDelayMs: Math.max(
      0,
      Number(process.env.SANDPIPER30A_DETAIL_FETCH_DELAY_MS ?? "120") || 120,
    ),
    detailFetchConcurrency: Math.max(
      1,
      Number(process.env.SANDPIPER30A_DETAIL_FETCH_CONCURRENCY ?? "4") || 4,
    ),
    availabilityHorizonDays: Math.max(
      1,
      Number(process.env.SANDPIPER30A_AVAILABILITY_HORIZON_DAYS ?? "730") ||
        730,
    ),
    maxCalendarAdvanceMonths: Math.max(
      8,
      Number(process.env.SANDPIPER30A_CALENDAR_MAX_MONTHS ?? "26") || 26,
    ),
    isValidDetailUrl(value: string): string | null {
      try {
        const parsed = new URL(value.trim());
        if (
          !parsed.hostname.endsWith("sandpipervacationrentals.com") ||
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
        context.reportDetailProgress,
      );
    },
    async runQuoteCapture(argv, progress) {
      const normalizedArgs = await normalizeAdapterQuoteScopeArgs(
        "sandpiper30a",
        argv,
      );
      await runRuntimeAdapterQuoteCli(
        {
          adapterKey: "sandpiper30a",
          executeSingleQuote: executeSandpiper30aSingleQuote,
          defaultQuoteTimeoutMs: 20000,
          defaultQuoteMaxAttempts: 2,
          defaultEndpointPath: "/wp-admin/admin-ajax.php?action=q4vr_stay",
          defaultTaxPct: 0.12,
          defaultBaseNightly: 700,
        },
        normalizedArgs,
        progress,
      );
    },
    async runSingleQuoteObservation(input) {
      const result = await executeSandpiper30aSingleQuote({
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
