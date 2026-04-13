import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createScrapeProgress } from "../tooling/terminal/scrape-progress";

type ScrapedLink = {
  link: string;
  source_url: string;
  anchor_text: string;
};

type StayDetailData = {
  rental_id: string;
  detail_url: string;
  fetched_at: string;
  title: string;
  h1: string;
  canonical_url: string;
  meta_description: string;
  json_ld_name: string;
  json_ld_description: string;
  json_ld_blocks: Array<{
    index: number;
    raw_json: string;
    parsed: unknown | null;
    parse_error: string | null;
  }>;
  inline_api_method_hints: Array<{
    method_name: string;
    unit_id: string | null;
    sample: string;
  }>;
  normalized_matching_profile: {
    source: "pm_stayon30a";
    external_listing_id: string;
    name: string;
    description: string;
    address: {
      street: string;
      locality: string;
      region: string;
      postal_code: string;
      country: string;
    };
    geo: {
      latitude: number | null;
      longitude: number | null;
    };
    attributes: {
      bedrooms: number | null;
      bathrooms_total: number | null;
      occupancy: number | null;
      rating_value: number | null;
      review_count: number | null;
      image_url: string;
    };
    match_signals: {
      description_normalized: string;
      description_sha256: string;
      title_normalized: string;
      title_sha256: string;
      address_normalized: string;
      address_sha256: string;
      listing_composite_key: string;
    };
  };
  description_section_excerpt: string;
  why_we_love_it_excerpt: string;
  body_text_excerpt: string;
  html_path: string;
};

type AvailabilityDay = {
  date: string;
  code: string;
};

type StayAvailabilityData = {
  rental_id: string;
  fetched_at: string;
  raw_begin_date: string;
  raw_end_date: string;
  raw_availability: string;
  availability_days: AvailabilityDay[];
  availability_codes_summary: Record<string, number>;
  normalized_availability: {
    source: "pm_stayon30a";
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
};

type PlaywrightBrowserModule = {
  chromium: {
    launch(options?: Record<string, unknown>): Promise<{
      newPage(): Promise<{
        on(
          event: "response",
          listener: (response: {
            url(): string;
            text(): Promise<string>;
            headers(): Record<string, string>;
          }) => void,
        ): void;
        goto(url: string, options?: Record<string, unknown>): Promise<unknown>;
        waitForTimeout(ms: number): Promise<void>;
        evaluate<TReturn>(fn: () => TReturn): Promise<TReturn>;
      }>;
      close(): Promise<void>;
    }>;
  };
};

const DEFAULT_ANCHOR_URL =
  "https://stayon30a.com/search-results/?min_beds=3&sort_by=rotation&plus_oc=1";
const MAX_CLICK_CYCLES = 24;
const CLICK_WAIT_MS = 1200;
const GROWTH_POLL_ROUNDS = 10;
const DETAIL_FETCH_DELAY_MS = Number(
  process.env.STAYON30A_DETAIL_FETCH_DELAY_MS ?? "250",
);
const LISTING_FETCH_CONCURRENCY = Math.max(
  1,
  Number(process.env.STAYON30A_FETCH_CONCURRENCY ?? "6") || 6,
);
const AVAILABILITY_HORIZON_DAYS = Math.max(
  1,
  Number(process.env.STAYON30A_AVAILABILITY_HORIZON_DAYS ?? "730") || 730,
);
const OUTPUT_ROOT = resolve(
  process.cwd(),
  "src",
  "lib",
  "data",
  "external-sources",
  "stayon30a",
);
const OUTPUT_DETAILS_HTML_DIR = resolve(OUTPUT_ROOT, "details", "html");
const OUTPUT_DETAILS_JSON_DIR = resolve(OUTPUT_ROOT, "details", "json");
const OUTPUT_AVAILABILITY_JSON_DIR = resolve(
  OUTPUT_ROOT,
  "availability",
  "json",
);
const OUTPUT_STATE_DIR = resolve(OUTPUT_ROOT, "state");
const OUTPUT_STATE_HISTORY_DIR = resolve(OUTPUT_STATE_DIR, "history");
const OUTPUT_STATE_LATEST_PATH = resolve(
  OUTPUT_STATE_DIR,
  "latest-observed-ids.json",
);

type RunOptions = {
  anchorUrl: string;
  rentalId: string | null;
};

type StayObservedState = {
  manager_key: "stayon30a";
  generated_at: string;
  source_url: string;
  is_full_census: boolean;
  observed_ids: string[];
  observed_count: number;
  newly_seen_ids: string[];
  disappeared_ids: string[];
};

type ListingFetchResult = {
  rentalId: string;
  detail: StayDetailData | null;
  availability: StayAvailabilityData | null;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function toElapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function parseRunOptions(argv: string[]): RunOptions {
  let anchorUrl = DEFAULT_ANCHOR_URL;
  let rentalId: string | null = null;

  let index = 2;
  if (argv[index] && !argv[index]?.startsWith("--")) {
    anchorUrl = argv[index] as string;
    index += 1;
  }

  for (; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    if (arg === "--rental-id" && value) {
      const parsedId = value.match(/\d+/)?.[0] ?? null;
      rentalId = parsedId;
      index += 1;
    }
  }

  return { anchorUrl, rentalId };
}

async function loadPlaywright(): Promise<PlaywrightBrowserModule> {
  try {
    return (await import("playwright")) as PlaywrightBrowserModule;
  } catch {
    throw new Error(
      "Playwright is not installed. Run: npm install -D playwright && npx playwright install chromium",
    );
  }
}

function canonicalStayUrlFromId(id: string): string {
  return `https://www.stayon30a.com/${id}/`;
}

function extractIdsFromPropertyListPayload(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  if (!parsed || typeof parsed !== "object") {
    return [];
  }

  const data = (parsed as { data?: unknown }).data;
  if (!data || typeof data !== "object") {
    return [];
  }

  const properties = (data as { property?: unknown }).property;
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

function extractPagination(raw: string): {
  totalUnits: number | null;
  totalPages: number | null;
} {
  try {
    const parsed = JSON.parse(raw) as {
      data?: {
        available_properties?: {
          pagination?: {
            total_units?: unknown;
            total_pages?: unknown;
          };
        };
      };
    };

    const pagination = parsed.data?.available_properties?.pagination;
    if (!pagination) {
      return { totalUnits: null, totalPages: null };
    }

    const totalUnits =
      typeof pagination.total_units === "number"
        ? pagination.total_units
        : null;
    const totalPages =
      typeof pagination.total_pages === "number"
        ? pagination.total_pages
        : null;

    return { totalUnits, totalPages };
  } catch {
    return { totalUnits: null, totalPages: null };
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
  return stripHtml(match[1]).trim();
}

function parseJsonLd(html: string): { name: string; description: string } {
  const blocks = extractJsonLdBlocks(html);
  for (const block of blocks) {
    if (!block.parsed || typeof block.parsed !== "object") {
      continue;
    }

    const parsed = block.parsed as Record<string, unknown>;
    const name =
      typeof parsed.name === "string"
        ? parsed.name
        : typeof parsed.headline === "string"
          ? parsed.headline
          : "";
    const description =
      typeof parsed.description === "string" ? parsed.description : "";

    if (name || description) {
      return {
        name: stripHtml(name).slice(0, 240),
        description: stripHtml(description).slice(0, 15000),
      };
    }
  }

  return { name: "", description: "" };
}

function extractJsonLdBlocks(html: string): Array<{
  index: number;
  raw_json: string;
  parsed: unknown | null;
  parse_error: string | null;
}> {
  const matches = Array.from(
    html.matchAll(
      /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
    ),
  );

  const blocks: Array<{
    index: number;
    raw_json: string;
    parsed: unknown | null;
    parse_error: string | null;
  }> = [];

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const raw = (match?.[1] ?? "").trim();
    if (!raw) {
      continue;
    }

    try {
      blocks.push({
        index,
        raw_json: raw,
        parsed: JSON.parse(raw),
        parse_error: null,
      });
    } catch {
      blocks.push({
        index,
        raw_json: raw,
        parsed: null,
        parse_error: "JSON parse failed",
      });
    }
  }

  return blocks;
}

function extractInlineApiMethodHints(html: string): Array<{
  method_name: string;
  unit_id: string | null;
  sample: string;
}> {
  const hints: Array<{
    method_name: string;
    unit_id: string | null;
    sample: string;
  }> = [];

  const regex =
    /methodName"?\s*:\s*"([A-Za-z0-9_]+)"[\s\S]{0,220}?unit_id"?\s*:\s*"?(\d+)?"?/gi;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(html)) !== null) {
    const methodName = match[1] ?? "";
    if (!methodName) {
      continue;
    }

    const sample = (match[0] ?? "").replace(/\s+/g, " ").slice(0, 220);
    hints.push({
      method_name: methodName,
      unit_id: match[2] ?? null,
      sample,
    });
  }

  const deduped = new Map<
    string,
    { method_name: string; unit_id: string | null; sample: string }
  >();
  for (const hint of hints) {
    const key = `${hint.method_name}::${hint.unit_id ?? ""}`;
    if (!deduped.has(key)) {
      deduped.set(key, hint);
    }
  }

  return Array.from(deduped.values());
}

function extractSectionExcerpt(
  strippedText: string,
  startToken: string,
  endToken: string,
  maxLength: number,
): string {
  const lower = strippedText.toLowerCase();
  const startIndex = lower.indexOf(startToken.toLowerCase());
  if (startIndex < 0) {
    return "";
  }

  const afterStart = startIndex + startToken.length;
  const endIndex = lower.indexOf(endToken.toLowerCase(), afterStart);
  const raw =
    endIndex > afterStart
      ? strippedText.slice(afterStart, endIndex)
      : strippedText.slice(afterStart, afterStart + maxLength);

  return raw.trim().slice(0, maxLength);
}

function toNumberOrNull(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
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

function toDailyStateFileName(timestampIso: string): string {
  return timestampIso.replace(/[:.]/g, "-");
}

async function readLatestObservedIds(): Promise<string[]> {
  try {
    const raw = await readFile(OUTPUT_STATE_LATEST_PATH, "utf8");
    const parsed = JSON.parse(raw) as { observed_ids?: unknown };
    if (!Array.isArray(parsed.observed_ids)) {
      return [];
    }

    return parsed.observed_ids.filter(
      (value): value is string => typeof value === "string",
    );
  } catch {
    return [];
  }
}

function extractNormalizedMatchingProfile(
  rentalId: string,
  title: string,
  h1: string,
  metaDescription: string,
  jsonLdName: string,
  jsonLdDescription: string,
  jsonLdBlocks: Array<{
    index: number;
    raw_json: string;
    parsed: unknown | null;
    parse_error: string | null;
  }>,
): StayDetailData["normalized_matching_profile"] {
  const base: StayDetailData["normalized_matching_profile"] = {
    source: "pm_stayon30a",
    external_listing_id: rentalId,
    name: h1 || jsonLdName || title,
    description: jsonLdDescription || metaDescription,
    address: {
      street: "",
      locality: "",
      region: "",
      postal_code: "",
      country: "",
    },
    geo: {
      latitude: null,
      longitude: null,
    },
    attributes: {
      bedrooms: null,
      bathrooms_total: null,
      occupancy: null,
      rating_value: null,
      review_count: null,
      image_url: "",
    },
    match_signals: {
      description_normalized: "",
      description_sha256: "",
      title_normalized: "",
      title_sha256: "",
      address_normalized: "",
      address_sha256: "",
      listing_composite_key: "",
    },
  };

  const vacationRentalBlock = jsonLdBlocks.find((block) => {
    if (!block.parsed || typeof block.parsed !== "object") {
      return false;
    }

    const type = (block.parsed as Record<string, unknown>)["@type"];
    return typeof type === "string" && type.toLowerCase() === "vacationrental";
  });

  if (
    !vacationRentalBlock?.parsed ||
    typeof vacationRentalBlock.parsed !== "object"
  ) {
    return base;
  }

  const parsed = vacationRentalBlock.parsed as Record<string, unknown>;

  if (typeof parsed.name === "string" && parsed.name.trim()) {
    base.name = parsed.name.trim();
  }
  if (typeof parsed.description === "string" && parsed.description.trim()) {
    base.description = parsed.description.trim();
  }

  const address = parsed.address;
  if (address && typeof address === "object") {
    const addressObj = address as Record<string, unknown>;
    base.address.street =
      typeof addressObj.streetAddress === "string"
        ? addressObj.streetAddress
        : "";
    base.address.locality =
      typeof addressObj.addressLocality === "string"
        ? addressObj.addressLocality
        : "";
    base.address.region =
      typeof addressObj.addressRegion === "string"
        ? addressObj.addressRegion
        : "";
    base.address.postal_code =
      typeof addressObj.postalCode === "string" ? addressObj.postalCode : "";
    base.address.country =
      typeof addressObj.addressCountry === "string"
        ? addressObj.addressCountry
        : "";
  }

  base.geo.latitude = toNumberOrNull(parsed.latitude);
  base.geo.longitude = toNumberOrNull(parsed.longitude);
  base.attributes.image_url =
    typeof parsed.image === "string" ? parsed.image : "";

  const containsPlace = parsed.containsPlace;
  if (containsPlace && typeof containsPlace === "object") {
    const containsPlaceObj = containsPlace as Record<string, unknown>;
    base.attributes.bedrooms = toNumberOrNull(
      containsPlaceObj.numberOfBedrooms,
    );
    base.attributes.bathrooms_total = toNumberOrNull(
      containsPlaceObj.numberOfBathroomsTotal,
    );

    const occupancy = containsPlaceObj.occupancy;
    if (occupancy && typeof occupancy === "object") {
      base.attributes.occupancy = toNumberOrNull(
        (occupancy as Record<string, unknown>).value,
      );
    }
  }

  const aggregateRating = parsed.aggregateRating;
  if (aggregateRating && typeof aggregateRating === "object") {
    const aggregateRatingObj = aggregateRating as Record<string, unknown>;
    base.attributes.rating_value = toNumberOrNull(
      aggregateRatingObj.ratingValue,
    );
    base.attributes.review_count = toNumberOrNull(
      aggregateRatingObj.reviewCount,
    );
  }

  const normalizedDescription = normalizeForMatch(base.description);
  const normalizedTitle = normalizeForMatch(base.name);
  const normalizedAddress = normalizeForMatch(
    [
      base.address.street,
      base.address.locality,
      base.address.region,
      base.address.postal_code,
      base.address.country,
    ]
      .filter(Boolean)
      .join(" "),
  );

  base.match_signals.description_normalized = normalizedDescription;
  base.match_signals.description_sha256 = hashSha256(normalizedDescription);
  base.match_signals.title_normalized = normalizedTitle;
  base.match_signals.title_sha256 = hashSha256(normalizedTitle);
  base.match_signals.address_normalized = normalizedAddress;
  base.match_signals.address_sha256 = hashSha256(normalizedAddress);
  base.match_signals.listing_composite_key = [
    base.source,
    rentalId,
    base.match_signals.description_sha256,
    base.match_signals.title_sha256,
    base.match_signals.address_sha256,
  ].join("::");

  return base;
}

async function fetchDetailPage(
  rentalId: string,
): Promise<StayDetailData | null> {
  const detailUrl = canonicalStayUrlFromId(rentalId);

  try {
    const response = await fetch(detailUrl, {
      method: "GET",
      redirect: "follow",
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      },
    });

    const contentType = (
      response.headers.get("content-type") ?? ""
    ).toLowerCase();
    if (response.status !== 200 || !contentType.includes("text/html")) {
      return null;
    }

    const html = await response.text();

    const title = extractFirst(/<title[^>]*>([\s\S]*?)<\/title>/i, html).slice(
      0,
      240,
    );
    const h1 = extractFirst(/<h1[^>]*>([\s\S]*?)<\/h1>/i, html).slice(0, 240);
    const canonicalUrl =
      extractFirst(
        /<link[^>]+rel=["']canonical["'][^>]+href=["']([\s\S]*?)["'][^>]*>/i,
        html,
      ) ||
      extractFirst(
        /<link[^>]+href=["']([\s\S]*?)["'][^>]+rel=["']canonical["'][^>]*>/i,
        html,
      );

    const metaDescription =
      extractFirst(
        /<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["'][^>]*>/i,
        html,
      ).slice(0, 1000) ||
      extractFirst(
        /<meta[^>]+content=["']([\s\S]*?)["'][^>]+name=["']description["'][^>]*>/i,
        html,
      ).slice(0, 1000);

    const jsonLd = parseJsonLd(html);
    const jsonLdBlocks = extractJsonLdBlocks(html);
    const inlineApiMethodHints = extractInlineApiMethodHints(html);
    const strippedText = stripHtml(html);
    const descriptionSectionExcerpt = extractSectionExcerpt(
      strippedText,
      "Description",
      "Amenities",
      12000,
    );
    const whyWeLoveItExcerpt = extractSectionExcerpt(
      strippedText,
      "Why We Love It",
      "Description",
      6000,
    );
    const bodyTextExcerpt = strippedText.slice(0, 25000);
    const htmlPath = resolve(OUTPUT_DETAILS_HTML_DIR, `${rentalId}.html`);

    await writeFile(htmlPath, html, "utf8");

    const normalizedMatchingProfile = extractNormalizedMatchingProfile(
      rentalId,
      title,
      h1,
      metaDescription,
      jsonLd.name,
      jsonLd.description,
      jsonLdBlocks,
    );

    return {
      rental_id: rentalId,
      detail_url: detailUrl,
      fetched_at: new Date().toISOString(),
      title,
      h1,
      canonical_url: canonicalUrl,
      meta_description: metaDescription,
      json_ld_name: jsonLd.name,
      json_ld_description: jsonLd.description,
      json_ld_blocks: jsonLdBlocks,
      inline_api_method_hints: inlineApiMethodHints,
      normalized_matching_profile: normalizedMatchingProfile,
      description_section_excerpt: descriptionSectionExcerpt,
      why_we_love_it_excerpt: whyWeLoveItExcerpt,
      body_text_excerpt: bodyTextExcerpt,
      html_path: htmlPath,
    };
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
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date;
}

function buildAvailabilityApiUrl(rentalId: string): string {
  const paramsPayload = JSON.stringify({
    methodName: "GetPropertyAvailabilityRawData",
    params: {
      unit_id: Number(rentalId),
      use_room_type_logic: "no",
      standard_pricing: 1,
    },
  });

  const query = new URLSearchParams({
    action: "streamlinecore-api-request",
    params: paramsPayload,
  });

  return `https://stayon30a.com/wp-admin/admin-ajax.php?${query.toString()}`;
}

function decodeAvailabilityDays(
  beginDateRaw: string,
  availabilityRaw: string,
): AvailabilityDay[] {
  const beginDate = parseUsDateToUtc(beginDateRaw);
  if (!beginDate) {
    return [];
  }

  const days: AvailabilityDay[] = [];
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

async function fetchAvailability(
  rentalId: string,
): Promise<StayAvailabilityData | null> {
  const url = buildAvailabilityApiUrl(rentalId);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        accept: "application/json, text/plain, */*",
        referer: canonicalStayUrlFromId(rentalId),
      },
    });

    const raw = await response.text();
    if (response.status !== 200) {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }

    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const data = (parsed as { data?: unknown }).data;
    if (!data || typeof data !== "object") {
      return null;
    }

    const range = (data as { range?: unknown }).range;
    const availability = (data as { availability?: unknown }).availability;

    if (
      !range ||
      typeof range !== "object" ||
      typeof availability !== "string"
    ) {
      return null;
    }

    const beginDateRaw =
      typeof (range as { beginDate?: unknown }).beginDate === "string"
        ? (range as { beginDate: string }).beginDate
        : "";

    const endDateRaw =
      typeof (range as { endDate?: unknown }).endDate === "string"
        ? (range as { endDate: string }).endDate
        : "";

    const allDays = decodeAvailabilityDays(beginDateRaw, availability);

    const now = new Date();
    const today = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const horizonDate = new Date(today);
    horizonDate.setUTCDate(
      horizonDate.getUTCDate() + AVAILABILITY_HORIZON_DAYS,
    );

    const filteredDays = allDays.filter((day) => {
      const dayDate = new Date(`${day.date}T00:00:00.000Z`);
      return dayDate >= today && dayDate <= horizonDate;
    });

    const summary: Record<string, number> = {};
    for (const day of filteredDays) {
      summary[day.code] = (summary[day.code] ?? 0) + 1;
    }

    const normalizedDays = filteredDays.map((day) => ({
      date: day.date,
      is_available: day.code === "Y",
      is_available_for_checkin: day.code === "Y",
      is_available_for_checkout: day.code === "Y",
      status_code: day.code,
      booking_day_state:
        day.code === "Y"
          ? "bookable"
          : day.code === "N"
            ? "blocked"
            : "unknown",
    }));

    const available = normalizedDays.filter(
      (day) => day.status_code === "Y",
    ).length;
    const notAvailable = normalizedDays.filter(
      (day) => day.status_code === "N",
    ).length;
    const other = normalizedDays.length - available - notAvailable;

    const normalizedAvailability: StayAvailabilityData["normalized_availability"] =
      {
        source: "pm_stayon30a",
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
      };

    return {
      rental_id: rentalId,
      fetched_at: new Date().toISOString(),
      raw_begin_date: beginDateRaw,
      raw_end_date: endDateRaw,
      raw_availability: availability,
      availability_days: filteredDays,
      availability_codes_summary: summary,
      normalized_availability: normalizedAvailability,
    };
  } catch {
    return null;
  }
}

async function run(): Promise<void> {
  const startedAt = Date.now();
  const progress = createScrapeProgress({ script: "stayon30a" });

  const options = parseRunOptions(process.argv);
  const anchorUrl = options.anchorUrl;
  progress.phase(
    `booting scraper (concurrency=${LISTING_FETCH_CONCURRENCY}, per-worker-delay=${DETAIL_FETCH_DELAY_MS}ms)`,
  );

  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ headless: true });

  try {
    const idSet = new Set<string>();
    let totalUnits: number | null = null;
    let totalPages: number | null = null;
    let clicksPerformed = 0;
    let sortedIds: string[] = [];

    if (options.rentalId) {
      progress.phase(`single listing mode for rental_id=${options.rentalId}`);
      sortedIds = [options.rentalId];
      totalUnits = 1;
      totalPages = 1;
    } else {
      progress.phase("discovering rental IDs from load-more pages");
      const page = await browser.newPage();

      page.on("response", (response) => {
        void (async () => {
          try {
            const url = response.url();
            if (!url.includes("stayon30a.com/wp-admin/admin-ajax.php")) {
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

            const pagination = extractPagination(body);
            if (pagination.totalUnits !== null) {
              totalUnits = pagination.totalUnits;
            }
            if (pagination.totalPages !== null) {
              totalPages = pagination.totalPages;
            }
          } catch {
            // Ignore individual response handling errors.
          }
        })();
      });

      await page.goto(anchorUrl, {
        waitUntil: "domcontentloaded",
        timeout: 120000,
      });

      await page.waitForTimeout(2200);

      for (let cycle = 0; cycle < MAX_CLICK_CYCLES; cycle += 1) {
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

        clicksPerformed += 1;
        await page.waitForTimeout(CLICK_WAIT_MS);

        for (let poll = 0; poll < GROWTH_POLL_ROUNDS; poll += 1) {
          if (idSet.size > beforeCount) {
            break;
          }
          await page.waitForTimeout(350);
        }
      }

      sortedIds = Array.from(idSet).sort(
        (left, right) => Number(left) - Number(right),
      );
      progress.success(
        `discovered ${sortedIds.length} listing IDs (clicks=${clicksPerformed}, api_total_units=${totalUnits ?? "unknown"})`,
      );
    }

    await mkdir(OUTPUT_DETAILS_HTML_DIR, { recursive: true });
    await mkdir(OUTPUT_DETAILS_JSON_DIR, { recursive: true });
    await mkdir(OUTPUT_AVAILABILITY_JSON_DIR, { recursive: true });
    await mkdir(OUTPUT_STATE_DIR, { recursive: true });
    await mkdir(OUTPUT_STATE_HISTORY_DIR, { recursive: true });

    const detailRecords: StayDetailData[] = [];
    const availabilityRecords: StayAvailabilityData[] = [];
    const failedDetailIds: string[] = [];
    const failedAvailabilityIds: string[] = [];

    progress.phase(
      `fetching ${sortedIds.length} detail + availability payloads with bounded concurrency`,
    );

    const listingResults: ListingFetchResult[] = new Array(sortedIds.length);
    let nextIndex = 0;
    let processedCount = 0;

    const workerCount = Math.min(LISTING_FETCH_CONCURRENCY, sortedIds.length);
    const workers: Array<Promise<void>> = [];

    const worker = async (): Promise<void> => {
      while (true) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        if (currentIndex >= sortedIds.length) {
          return;
        }

        const rentalId = sortedIds[currentIndex] as string;
        const [detail, availability] = await Promise.all([
          fetchDetailPage(rentalId),
          fetchAvailability(rentalId),
        ]);

        listingResults[currentIndex] = {
          rentalId,
          detail,
          availability,
        };

        processedCount += 1;
        if (processedCount % 10 === 0 || processedCount === sortedIds.length) {
          progress.tick(
            `processed ${processedCount}/${sortedIds.length} (${formatElapsed(toElapsedMs(startedAt))})`,
          );
        }

        if (DETAIL_FETCH_DELAY_MS > 0) {
          await sleep(DETAIL_FETCH_DELAY_MS);
        }
      }
    };

    for (let index = 0; index < workerCount; index += 1) {
      workers.push(worker());
    }
    await Promise.all(workers);

    for (const result of listingResults) {
      const { rentalId, detail, availability } = result;

      if (detail) {
        detailRecords.push(detail);
      } else {
        failedDetailIds.push(rentalId);
      }

      if (availability) {
        availabilityRecords.push(availability);
        const availabilityPath = resolve(
          OUTPUT_AVAILABILITY_JSON_DIR,
          `${rentalId}.json`,
        );
        await writeFile(
          availabilityPath,
          `${JSON.stringify(availability, null, 2)}\n`,
          "utf8",
        );
      } else {
        failedAvailabilityIds.push(rentalId);
      }

      if (detail) {
        const detailPath = resolve(OUTPUT_DETAILS_JSON_DIR, `${rentalId}.json`);
        const merged = {
          ...detail,
          availability_snapshot: availability,
        };
        await writeFile(
          detailPath,
          `${JSON.stringify(merged, null, 2)}\n`,
          "utf8",
        );
      }
    }

    const links: ScrapedLink[] = sortedIds.map((id) => ({
      link: canonicalStayUrlFromId(id),
      source_url: anchorUrl,
      anchor_text: "api-load-more",
    }));

    const generatedAt = new Date().toISOString();
    const isFullCensus = options.rentalId === null;

    const previousObservedIds = isFullCensus
      ? await readLatestObservedIds()
      : [];
    const previousSet = new Set(previousObservedIds);
    const currentSet = new Set(sortedIds);

    const newlySeenIds = isFullCensus
      ? sortedIds.filter((id) => !previousSet.has(id))
      : [];
    const disappearedIds = isFullCensus
      ? previousObservedIds.filter((id) => !currentSet.has(id))
      : [];

    const observedState: StayObservedState = {
      manager_key: "stayon30a",
      generated_at: generatedAt,
      source_url: anchorUrl,
      is_full_census: isFullCensus,
      observed_ids: sortedIds,
      observed_count: sortedIds.length,
      newly_seen_ids: newlySeenIds,
      disappeared_ids: disappearedIds,
    };

    const payload = {
      generated_at: generatedAt,
      manager_key: "stayon30a",
      source_url: anchorUrl,
      click_loop_mode: "load-more-until-missing",
      is_full_census: isFullCensus,
      clicks_performed: clicksPerformed,
      api_total_units: totalUnits,
      api_total_pages: totalPages,
      link_count: links.length,
      newly_seen_count: newlySeenIds.length,
      disappeared_count: disappearedIds.length,
      newly_seen_ids: newlySeenIds,
      disappeared_ids: disappearedIds,
      links,
      detail_pages_pulled: detailRecords.length,
      detail_pages_failed: failedDetailIds.length,
      availability_pulled: availabilityRecords.length,
      availability_failed: failedAvailabilityIds.length,
      failed_detail_ids: failedDetailIds,
      failed_availability_ids: failedAvailabilityIds,
      output_root: OUTPUT_ROOT,
    };

    const root = process.cwd();
    const reportsDir = resolve(root, ".tmp", "reports");
    const externalSourceDir = resolve(
      root,
      "src",
      "lib",
      "data",
      "external-sources",
    );
    const adapterOutputDir = resolve(externalSourceDir, "stayon30a");

    await mkdir(reportsDir, { recursive: true });
    await mkdir(adapterOutputDir, { recursive: true });

    const reportPath = resolve(reportsDir, "stayon30a-playwright-links.json");
    const sourcePath = resolve(adapterOutputDir, "listings.json");
    const detailsManifestPath = resolve(OUTPUT_ROOT, "details", "index.json");
    const availabilityManifestPath = resolve(
      OUTPUT_ROOT,
      "availability",
      "index.json",
    );
    const stateHistoryPath = resolve(
      OUTPUT_STATE_HISTORY_DIR,
      `${toDailyStateFileName(generatedAt)}.json`,
    );

    await writeFile(
      reportPath,
      `${JSON.stringify(payload, null, 2)}\n`,
      "utf8",
    );
    await writeFile(sourcePath, `${JSON.stringify(links, null, 2)}\n`, "utf8");
    await writeFile(
      detailsManifestPath,
      `${JSON.stringify(detailRecords, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      availabilityManifestPath,
      `${JSON.stringify(availabilityRecords, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      stateHistoryPath,
      `${JSON.stringify(observedState, null, 2)}\n`,
      "utf8",
    );
    if (isFullCensus) {
      await writeFile(
        OUTPUT_STATE_LATEST_PATH,
        `${JSON.stringify(observedState, null, 2)}\n`,
        "utf8",
      );
    }

    const elapsed = formatElapsed(toElapsedMs(startedAt));
    progress.success(
      `scrape complete in ${elapsed} (${detailRecords.length} details, ${availabilityRecords.length} availability)`,
    );

    console.log("Stay on 30A full scrape complete.");
    console.log(`- source_url: ${anchorUrl}`);
    console.log(`- clicks_performed: ${clicksPerformed}`);
    console.log(`- api_total_units: ${totalUnits ?? "unknown"}`);
    console.log(`- links_found: ${links.length}`);
    console.log(`- newly_seen_ids: ${newlySeenIds.length}`);
    console.log(`- disappeared_ids: ${disappearedIds.length}`);
    console.log(`- detail_pages_pulled: ${detailRecords.length}`);
    console.log(`- availability_pulled: ${availabilityRecords.length}`);
    console.log(`- report_json: ${reportPath}`);
    console.log(`- external_source_json: ${sourcePath}`);
    console.log(`- details_manifest_json: ${detailsManifestPath}`);
    console.log(`- availability_manifest_json: ${availabilityManifestPath}`);
    console.log(`- observed_state_json: ${stateHistoryPath}`);
  } finally {
    await browser.close();
  }
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Stay on 30A full scrape failed: ${message}`);
  process.exit(1);
});
