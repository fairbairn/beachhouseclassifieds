import { executeFivestar30aSingleQuote } from "@/lib/pricing/quote-runtime/adapters/fivestar30a";
import { runRuntimeAdapterQuoteCli } from "@/lib/pricing/quotes/shared/runtime-adapter-quote-runner";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { runWithConcurrency } from "@/lib/pricing/quotes/shared/run-with-concurrency";
import { normalizeAdapterQuoteScopeArgs } from "../quote-scope";
import type { DetailRecordBase, ScrapedLink, ScraperAdapter } from "../types";

type FiveStarDayCode = "A" | "U" | "I" | "O" | "X";

type BookingRange = {
  start: string;
  end: string;
};

type MinDayRule = {
  startDate: string;
  endDate: string;
  minimum: number;
};

type RateRule = {
  startDate: string;
  endDate: string;
  dailyRate: number;
  weeklyRate: number;
  monthlyRate: number;
};

type BatchPricingEntry = {
  unitId?: unknown;
  isAvailable?: unknown;
  rent?: unknown;
  total?: unknown;
};

type ParsedRule = {
  start_date: string;
  end_date: string;
  min_nights: number;
  raw_rule: string;
};

type FiveStarDetailRecord = DetailRecordBase & {
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
  normalized_matching_profile: {
    source: "pm_fivestar30a";
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
    source: "pm_fivestar30a";
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
      I: "checkout_only";
      O: "checkin_only";
      X: "other";
    };
    day_codes: string;
    days: Array<{
      date: string;
      status_code: FiveStarDayCode;
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
  normalized_rates: {
    source: "pm_fivestar30a";
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
    rows: RateRule[];
  };
  property_profile: {
    unit_id: string;
    location_id: string;
    area: string;
    location: string;
    beds: number | null;
    baths: number | null;
    sleeps: number | null;
    city: string;
    state: string;
  };
  quote_context: {
    source: "detail_prop_payload";
    unit_id: string;
    location_id: string;
    detail_url: string;
  };
};

const DEFAULT_ANCHOR_URL =
  "https://www.fivestargulfrentals.com/vacation-rentals/results/?searchform=1&cwrsearch=1&Location=30A%20West";
const EAST_ANCHOR_URL =
  "https://www.fivestargulfrentals.com/vacation-rentals/results/?searchform=1&cwrsearch=1&Location=30A%20East";
const OUTPUT_ROOT = resolve(
  process.cwd(),
  "src",
  "lib",
  "data",
  "external-sources",
  "fivestar30a",
);
const OUTPUT_DETAILS_HTML_DIR = resolve(OUTPUT_ROOT, "details", "html");
const ROUTER_ENDPOINT =
  "https://www.fivestargulfrentals.com/vacation-rentals/router/";
const DEFAULT_DETERMINISTIC_RATE_QUERY_DAYS = 120;
const DEFAULT_DETERMINISTIC_RATE_CONCURRENCY = 3;

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

function absoluteHttpUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const normalized = new URL(trimmed, "https://www.fivestargulfrentals.com")
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

function parseLatLng(value: string): {
  latitude: number | null;
  longitude: number | null;
} {
  const parts = value.split(",").map((part) => part.trim());
  if (parts.length < 2) {
    return { latitude: null, longitude: null };
  }

  return {
    latitude: parseNumberLike(parts[0]),
    longitude: parseNumberLike(parts[1]),
  };
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

function pickVacationRentalSchema(
  schemaObjects: Record<string, unknown>[],
): Record<string, unknown> | null {
  for (const item of schemaObjects) {
    const type = item["@type"];
    if (typeof type === "string" && type.toLowerCase() === "vacationrental") {
      return item;
    }
    if (
      Array.isArray(type) &&
      type.some(
        (entry) =>
          typeof entry === "string" && entry.toLowerCase() === "vacationrental",
      )
    ) {
      return item;
    }
  }

  return null;
}

function normalizeDetailUrl(value: string): string | null {
  try {
    const parsed = new URL(value.trim());
    if (!parsed.hostname.endsWith("fivestargulfrentals.com")) {
      return null;
    }

    const path = parsed.pathname.replace(/\/+$/, "");
    const parts = path.split("/").filter(Boolean);
    if (
      parts.length < 3 ||
      parts[0] !== "vacation-rentals" ||
      parts[1] !== "rental" ||
      !parts[2]
    ) {
      return null;
    }

    return normalizeLink(
      `${parsed.origin}/vacation-rentals/rental/${parts[2]}`,
    );
  } catch {
    return null;
  }
}

function extractExternalListingId(detailUrl: string, html: string): string {
  const normalized = normalizeDetailUrl(detailUrl);
  if (normalized) {
    try {
      const parsed = new URL(normalized);
      const parts = parsed.pathname.split("/").filter(Boolean);
      const slug = parts[2] ?? "";
      if (slug) {
        return slug;
      }
    } catch {
      return detailUrl;
    }
  }

  const propUnitId = html.match(/['"]unit_id['"]\s*:\s*['"]?(\d+)['"]?/i)?.[1];
  if (propUnitId) {
    return propUnitId;
  }

  return detailUrl;
}

function dedupePreserveOrder(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) {
      continue;
    }
    const key = normalizeForMatch(normalized);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(normalized);
  }

  return out;
}

function extractRoomsGuidanceFromHtmlRoomCards(html: string): string[] {
  const sectionMatch = html.match(
    /<section[^>]+id=["']roomcards["'][^>]*>([\s\S]*?)<\/section>/i,
  );
  if (!sectionMatch?.[1]) {
    return [];
  }

  const roomCards = Array.from(
    sectionMatch[1].matchAll(
      /<div[^>]*class=["'][^"']*roomcard[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi,
    ),
  );
  const guidance: string[] = [];

  for (const roomCard of roomCards) {
    const cardHtml = roomCard[1] ?? "";
    const roomName = extractFirst(/<h3[^>]*>([\s\S]*?)<\/h3>/i, cardHtml);
    const afterHeading = cardHtml.split(/<h3[^>]*>[\s\S]*?<\/h3>/i)[1] ?? "";
    const features = Array.from(
      afterHeading.matchAll(/<div[^>]*>([\s\S]*?)<\/div>/gi),
    )
      .map((match) => stripHtml(match[1] ?? ""))
      .filter(Boolean);

    if (!roomName && features.length === 0) {
      continue;
    }

    guidance.push(
      features.length > 0 ? `${roomName} | ${features.join(", ")}` : roomName,
    );
  }

  return dedupePreserveOrder(guidance);
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

function formatRouterDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-");
  if (!year || !month || !day) {
    return isoDate;
  }
  return `${year}-${Number(month)}-${Number(day)}`;
}

function addIsoDays(isoDate: string, delta: number): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return formatIsoDate(date);
}

function normalizePositiveMoney(value: unknown): number | null {
  const parsed = toFiniteNumber(value);
  if (parsed === null || parsed <= 0) {
    return null;
  }

  return Math.round(parsed * 100) / 100;
}

function readBatchPricingEntry(
  payload: unknown,
  unitId: string,
): BatchPricingEntry | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const keyed = payload as Record<string, unknown>;
  const fromKey = keyed[unitId];
  if (fromKey && typeof fromKey === "object") {
    return fromKey as BatchPricingEntry;
  }

  for (const value of Object.values(keyed)) {
    if (!value || typeof value !== "object") {
      continue;
    }

    const candidate = value as BatchPricingEntry;
    const candidateUnitId = String(candidate.unitId ?? "").trim();
    if (candidateUnitId === unitId) {
      return candidate;
    }
  }

  return null;
}

async function fetchDeterministicDailyRate(input: {
  unitId: string;
  detailUrl: string;
  startDateIso: string;
}): Promise<number | null> {
  const endDateIso = addIsoDays(input.startDateIso, 1);

  const response = await fetch(ROUTER_ENDPOINT, {
    method: "POST",
    headers: {
      accept: "application/json, text/plain, */*",
      "content-type": "application/json;charset=UTF-8",
      origin: "https://www.fivestargulfrentals.com",
      referer: input.detailUrl,
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    },
    body: JSON.stringify({
      call: "getBatchPricing",
      arrive_date: formatRouterDate(input.startDateIso),
      depart_date: formatRouterDate(endDateIso),
      unitIdsArray: [input.unitId],
    }),
  });

  if (!response.ok) {
    return null;
  }

  let payload: unknown;
  try {
    payload = (await response.json()) as unknown;
  } catch {
    return null;
  }

  const entry = readBatchPricingEntry(payload, input.unitId);
  if (!entry) {
    return null;
  }

  const availability = String(entry.isAvailable ?? "").toLowerCase();
  if (availability === "false" || availability === "0") {
    return null;
  }

  return normalizePositiveMoney(entry.rent);
}

function readJsonObjectAfterKey<T extends object>(
  html: string,
  key: string,
  fromIndex = 0,
): T | null {
  const source = fromIndex > 0 ? html.slice(fromIndex) : html;
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const keyMatch = new RegExp(`${escapedKey}\\s*:\\s*\\{`, "m").exec(source);
  if (!keyMatch?.index && keyMatch?.index !== 0) {
    return null;
  }

  const start = (keyMatch.index ?? 0) + keyMatch[0].lastIndexOf("{");
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < source.length; i += 1) {
    const ch = source[i] as string;

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
        const raw = source.slice(start, i + 1);
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

function readJsonArrayAfterKey<T>(
  html: string,
  key: string,
  fromIndex = 0,
): T[] {
  const source = fromIndex > 0 ? html.slice(fromIndex) : html;
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const keyMatch = new RegExp(`${escapedKey}\\s*:\\s*\\[`, "m").exec(source);
  if (!keyMatch?.index && keyMatch?.index !== 0) {
    return [];
  }

  const start = (keyMatch.index ?? 0) + keyMatch[0].lastIndexOf("[");
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < source.length; i += 1) {
    const ch = source[i] as string;

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
        const raw = source.slice(start, i + 1);
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

function findVueDataReturnIndex(html: string): number {
  const scriptAnchor = html.indexOf("const propDetailsApp = Vue.createApp");
  if (scriptAnchor < 0) {
    return 0;
  }

  const dataAnchor = html.indexOf("return {", scriptAnchor);
  if (dataAnchor < 0) {
    return scriptAnchor;
  }

  return dataAnchor;
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

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parsePageNumber(raw: string): number | null {
  const numberValue = Number(raw);
  if (!Number.isInteger(numberValue) || numberValue < 1) {
    return null;
  }
  return numberValue;
}

async function collectLinksOnCurrentPage(
  page: Parameters<
    ScraperAdapter<FiveStarDetailRecord>["discoverListings"]
  >[0]["page"],
): Promise<{ detailLinks: string[]; pageNumbers: number[] }> {
  return page.evaluate(() => {
    const detailLinks = new Set<string>();
    const pageNumbers = new Set<number>();

    const anchors = Array.from(document.querySelectorAll("a[href]"));
    for (const anchor of anchors) {
      const href = anchor.getAttribute("href") || "";
      if (!href.trim()) {
        continue;
      }

      try {
        const url = new URL(href, window.location.origin);
        const path = url.pathname.replace(/\/$/, "");
        const parts = path.split("/").filter(Boolean);

        if (
          url.hostname.endsWith("fivestargulfrentals.com") &&
          parts[0] === "vacation-rentals" &&
          parts[1] === "rental" &&
          parts[2]
        ) {
          detailLinks.add(`${url.origin}/vacation-rentals/rental/${parts[2]}`);
        }

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
    };
  });
}

function toAnchorSet(anchorUrl: string): string[] {
  const seeds = [DEFAULT_ANCHOR_URL, EAST_ANCHOR_URL];

  if (anchorUrl.includes("fivestargulfrentals.com")) {
    seeds.unshift(anchorUrl);
  }

  return Array.from(
    new Set(seeds.map((value) => value.trim()).filter(Boolean)),
  );
}

async function discoverListings(
  page: Parameters<
    ScraperAdapter<FiveStarDetailRecord>["discoverListings"]
  >[0]["page"],
  anchorUrl: string,
  maxScrollSteps: number,
  scrollPauseMs: number,
  reportProgress: (message: string) => void,
): Promise<ScrapedLink[]> {
  const discovered = new Set<string>();
  const sourceByLink = new Map<string, string>();
  const sources = toAnchorSet(anchorUrl);

  for (const sourceUrl of sources) {
    await page.goto(sourceUrl, {
      waitUntil: "domcontentloaded",
      timeout: 120000,
    });

    await page.waitForTimeout(Math.max(900, scrollPauseMs));

    const firstPass = await collectLinksOnCurrentPage(page);
    for (const link of firstPass.detailLinks) {
      const normalized = normalizeDetailUrl(link);
      if (!normalized) {
        continue;
      }
      discovered.add(normalized);
      sourceByLink.set(normalized, sourceUrl);
    }

    let maxPage = 1;
    for (const rawPageNumber of firstPass.pageNumbers) {
      const pageNumber = parsePageNumber(String(rawPageNumber));
      if (pageNumber && pageNumber > maxPage) {
        maxPage = pageNumber;
      }
    }

    const pageTraversalLimit = Math.max(1, Math.min(maxPage, maxScrollSteps));
    if (pageTraversalLimit > 1) {
      reportProgress(
        `source pagination detected; traversing ${pageTraversalLimit} pages for ${sourceUrl}`,
      );
    }

    for (
      let pageNumber = 2;
      pageNumber <= pageTraversalLimit;
      pageNumber += 1
    ) {
      const pageUrl = new URL(sourceUrl);
      pageUrl.searchParams.set("page", String(pageNumber));

      await page.goto(pageUrl.toString(), {
        waitUntil: "domcontentloaded",
        timeout: 120000,
      });
      await page.waitForTimeout(Math.max(700, scrollPauseMs));

      const pass = await collectLinksOnCurrentPage(page);
      for (const link of pass.detailLinks) {
        const normalized = normalizeDetailUrl(link);
        if (!normalized) {
          continue;
        }
        discovered.add(normalized);
        sourceByLink.set(normalized, pageUrl.toString());
      }

      if (pageNumber % 2 === 0 || pageNumber === pageTraversalLimit) {
        reportProgress(
          `source page ${pageNumber}/${pageTraversalLimit}; links=${discovered.size}`,
        );
      }
    }
  }

  return Array.from(discovered)
    .sort((a, b) => a.localeCompare(b))
    .map((link) => ({
      link,
      source_url: sourceByLink.get(link) ?? DEFAULT_ANCHOR_URL,
      anchor_text: "view-rental",
    }));
}

async function fetchDetail(
  detailUrl: string,
  availabilityHorizonDays: number,
): Promise<FiveStarDetailRecord | null> {
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
    const externalListingId = extractExternalListingId(
      normalizedDetailUrl,
      html,
    );
    const parsedUnitId =
      html.match(/['"]unit_id['"]\s*:\s*['"]?(\d+)['"]?/i)?.[1] ?? "";

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

    const htmlPath = resolve(
      OUTPUT_DETAILS_HTML_DIR,
      `${externalListingId}.html`,
    );
    await writeFile(htmlPath, `${html}\n`, "utf8");

    const vueDataStart = findVueDataReturnIndex(html);
    const propDetails =
      readJsonObjectAfterKey<Record<string, unknown>>(
        html,
        "propDetails",
        vueDataStart,
      ) ?? {};
    const propImages = readJsonArrayAfterKey<Record<string, unknown>>(
      html,
      "propImages",
      vueDataStart,
    );
    const amenityGroups = readJsonArrayAfterKey<Record<string, unknown>>(
      html,
      "amenities",
      vueDataStart,
    );
    const roomCards = readJsonArrayAfterKey<Record<string, unknown>>(
      html,
      "roomCards",
      vueDataStart,
    );
    const schemaObjects = parseJsonLdObjects(html);
    const vacationRentalSchema = pickVacationRentalSchema(schemaObjects);

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
    const rateRules = readJsonArrayAfterKey<RateRule>(html, "rates").filter(
      (row) =>
        typeof row?.startDate === "string" &&
        typeof row?.endDate === "string" &&
        toFiniteNumber(row?.dailyRate) !== null,
    );

    const parsedRules = toParsedRules(minDayRules);

    const now = new Date();
    const startDate = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    startDate.setUTCDate(startDate.getUTCDate() + 1);

    const endDate = new Date(startDate);
    endDate.setUTCDate(
      endDate.getUTCDate() + Math.max(1, availabilityHorizonDays),
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

    const normalizedDays: FiveStarDetailRecord["normalized_availability"]["days"] =
      [];
    const cursor = new Date(startDate);
    while (cursor <= endDate) {
      const isoDate = formatIsoDate(cursor);
      const isStart = bookingStart.has(isoDate);
      const isEnd = bookingEnd.has(isoDate);
      const isBooked = bookedOnly.has(isoDate);

      let statusCode: FiveStarDayCode = "A";
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
        is_available_for_checkin: statusCode === "A" || statusCode === "O",
        is_available_for_checkout: statusCode === "A" || statusCode === "I",
        booking_day_state: bookingDayState,
        min_nights_required: minNights,
      });

      cursor.setUTCDate(cursor.getUTCDate() + 1);
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

    const rateMap = new Map<
      string,
      {
        nightly_rate: number | null;
        min_nights: number | null;
        season_name: string;
      }
    >();

    for (const rateRule of rateRules) {
      const start = parseSlashDate(rateRule.startDate);
      const end = parseSlashDate(rateRule.endDate);
      if (!start || !end || end < start) {
        continue;
      }

      const dailyRate = toFiniteNumber(rateRule.dailyRate);
      const minNights =
        toFiniteNumber(rateRule.weeklyRate) && Number(rateRule.weeklyRate) > 0
          ? 7
          : toFiniteNumber(rateRule.monthlyRate) &&
              Number(rateRule.monthlyRate) > 0
            ? 28
            : null;

      const cursorRate = new Date(start);
      while (cursorRate <= end) {
        const isoDate = formatIsoDate(cursorRate);
        rateMap.set(isoDate, {
          nightly_rate: dailyRate,
          min_nights: minNights,
          season_name: "embedded_rates",
        });
        cursorRate.setUTCDate(cursorRate.getUTCDate() + 1);
      }
    }

    const deterministicRateWindowDays = Math.max(
      0,
      Number(
        process.env.FIVESTAR30A_DETERMINISTIC_RATE_QUERY_DAYS ??
          String(DEFAULT_DETERMINISTIC_RATE_QUERY_DAYS),
      ) || DEFAULT_DETERMINISTIC_RATE_QUERY_DAYS,
    );
    const deterministicRateConcurrency = Math.max(
      1,
      Number(
        process.env.FIVESTAR30A_DETERMINISTIC_RATE_CONCURRENCY ??
          String(DEFAULT_DETERMINISTIC_RATE_CONCURRENCY),
      ) || DEFAULT_DETERMINISTIC_RATE_CONCURRENCY,
    );

    const embeddedCoverageFloor = Math.min(
      normalizedDays.length,
      deterministicRateWindowDays,
      60,
    );
    const shouldUseDeterministicFallback =
      deterministicRateWindowDays > 0 &&
      (rateMap.size === 0 || rateMap.size < embeddedCoverageFloor);

    if (shouldUseDeterministicFallback) {
      const queryDays = normalizedDays
        .slice(0, deterministicRateWindowDays)
        .filter((day) => day.status_code !== "U")
        .map((day) => day.date);

      const deterministicResults = await runWithConcurrency(
        queryDays,
        deterministicRateConcurrency,
        async (dateIso) => {
          const nightlyRate = await fetchDeterministicDailyRate({
            unitId: String(propDetails.unit_id ?? externalListingId),
            detailUrl: normalizedDetailUrl,
            startDateIso: dateIso,
          });

          return {
            dateIso,
            nightlyRate,
          };
        },
      );

      for (const result of deterministicResults) {
        if (result.nightlyRate === null) {
          continue;
        }

        const existing = rateMap.get(result.dateIso);
        rateMap.set(result.dateIso, {
          nightly_rate: result.nightlyRate,
          min_nights:
            existing?.min_nights ??
            resolveMinNightsForDate(result.dateIso, parsedRules),
          season_name: "router_batch_pricing",
        });
      }
    }

    const normalizedRateDays: FiveStarDetailRecord["normalized_rates"]["days"] =
      normalizedDays.map((day) => {
        const derived = rateMap.get(day.date);
        return {
          date: day.date,
          nightly_rate: derived?.nightly_rate ?? null,
          min_nights: derived?.min_nights ?? day.min_nights_required,
          is_booked: day.status_code === "U",
          changeover_code: day.status_code,
          season_name: derived?.season_name ?? "default",
        };
      });

    normalizedRateDays.sort((left, right) =>
      left.date.localeCompare(right.date),
    );

    const rateValues = normalizedRateDays
      .map((day) => day.nightly_rate)
      .filter(
        (value): value is number =>
          typeof value === "number" && Number.isFinite(value),
      );
    const minRate = rateValues.length > 0 ? Math.min(...rateValues) : null;
    const maxRate = rateValues.length > 0 ? Math.max(...rateValues) : null;
    const avgRate =
      rateValues.length > 0
        ? Math.round(
            (rateValues.reduce((sum, value) => sum + value, 0) /
              rateValues.length) *
              100,
          ) / 100
        : null;

    const description = stripHtml(
      String(propDetails.description ?? metaDescription ?? ""),
    ).slice(0, 20000);
    const name = stripHtml(
      String(propDetails.prop_name ?? h1 ?? title ?? ""),
    ).slice(0, 240);
    const descriptionNormalized = normalizeForMatch(description);
    const titleNormalized = normalizeForMatch(name);

    const descriptionExpanded = description;
    const roomsGuidance = extractRoomsGuidanceFromHtmlRoomCards(html);

    const amenitiesCategories: Record<string, string[]> = {};
    const amenitiesAll: string[] = [];
    const seenAmenity = new Set<string>();
    const pushAmenity = (category: string, value: string) => {
      const normalizedCategory = category.trim() || "General";
      const normalizedValue = stripHtml(value).trim();
      if (!normalizedValue) {
        return;
      }

      if (!amenitiesCategories[normalizedCategory]) {
        amenitiesCategories[normalizedCategory] = [];
      }
      amenitiesCategories[normalizedCategory].push(normalizedValue);

      const dedupeKey = normalizeForMatch(normalizedValue);
      if (!dedupeKey || seenAmenity.has(dedupeKey)) {
        return;
      }
      seenAmenity.add(dedupeKey);
      amenitiesAll.push(normalizedValue);
    };

    for (const group of amenityGroups) {
      const category =
        typeof group.groupName === "string" ? group.groupName : "General";
      const values = Array.isArray(group.amenities)
        ? (group.amenities as unknown[])
        : [];

      for (const value of values) {
        if (!value || typeof value !== "object") {
          continue;
        }
        const label = (value as { name?: unknown }).name;
        if (typeof label === "string") {
          pushAmenity(category, label);
        }
      }
    }

    const schemaAmenities = Array.isArray(vacationRentalSchema?.amenityFeature)
      ? (vacationRentalSchema?.amenityFeature as unknown[])
      : [];
    for (const feature of schemaAmenities) {
      if (!feature || typeof feature !== "object") {
        continue;
      }
      const label = (feature as { name?: unknown }).name;
      if (typeof label === "string") {
        pushAmenity("Schema Amenities", label);
      }
    }

    for (const room of roomCards) {
      if (!room || typeof room !== "object") {
        continue;
      }

      const roomName = (room as { room_name?: unknown }).room_name;
      if (typeof roomName === "string" && roomName.trim()) {
        pushAmenity("Room Features", roomName);
      }

      const roomAmenitiesRaw = (room as { room_group_amens?: unknown })
        .room_group_amens;
      if (typeof roomAmenitiesRaw !== "string" || !roomAmenitiesRaw.trim()) {
        continue;
      }

      try {
        const parsedRoomAmenities = JSON.parse(roomAmenitiesRaw) as unknown;
        if (!Array.isArray(parsedRoomAmenities)) {
          continue;
        }

        for (const entry of parsedRoomAmenities) {
          if (typeof entry === "string") {
            pushAmenity("Room Features", entry);
          }
        }
      } catch {
        // Ignore malformed room amenity payloads.
      }
    }

    const imageUrls: string[] = [];
    const seenImage = new Set<string>();
    const pushImage = (urlValue: string) => {
      const normalized = absoluteHttpUrl(urlValue);
      if (!normalized) {
        return;
      }
      const canonical = toCanonicalGalleryImageUrl(normalized);
      if (!canonical) {
        return;
      }
      const key = canonical.toLowerCase();
      if (seenImage.has(key)) {
        return;
      }
      seenImage.add(key);
      imageUrls.push(canonical);
    };

    for (const image of propImages) {
      if (!image || typeof image !== "object") {
        continue;
      }

      const imageSource = (image as { image_source?: unknown }).image_source;
      if (typeof imageSource === "string") {
        pushImage(imageSource.replace(/\\\//g, "/"));
      }
    }

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

    const schemaAddress =
      vacationRentalSchema?.address &&
      typeof vacationRentalSchema.address === "object"
        ? (vacationRentalSchema.address as Record<string, unknown>)
        : null;
    const schemaGeo =
      vacationRentalSchema?.geo && typeof vacationRentalSchema.geo === "object"
        ? (vacationRentalSchema.geo as Record<string, unknown>)
        : null;

    const address =
      [
        String(propDetails.address ?? "").trim(),
        String(propDetails.address2 ?? "").trim(),
      ]
        .filter(Boolean)
        .join(" ") || String(schemaAddress?.streetAddress ?? "").trim();
    const city =
      String(propDetails.city ?? "").trim() ||
      String(schemaAddress?.addressLocality ?? "").trim();
    const state =
      String(propDetails.state ?? "").trim() ||
      String(schemaAddress?.addressRegion ?? "").trim();

    const geocodeRaw = String(propDetails.geocode ?? "").trim();
    const parsedGeocode = parseLatLng(geocodeRaw);
    const latitude =
      parsedGeocode.latitude ?? parseNumberLike(schemaGeo?.latitude ?? null);
    const longitude =
      parsedGeocode.longitude ?? parseNumberLike(schemaGeo?.longitude ?? null);

    const locationLabel =
      String(propDetails.location ?? "").trim() ||
      [city, state].filter(Boolean).join(", ");
    const directionsDaddr = [address, city, state].filter(Boolean).join(", ");
    const directionsUrl = directionsDaddr
      ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(
          directionsDaddr,
        )}`
      : "";

    return {
      external_listing_id: externalListingId,
      detail_url: normalizedDetailUrl,
      fetched_at: new Date().toISOString(),
      html_path: htmlPath,
      title,
      h1,
      canonical_url: canonicalUrl,
      meta_description: metaDescription,
      description_expanded: descriptionExpanded,
      rooms_guidance: roomsGuidance,
      amenities: {
        categories: amenitiesCategories,
        all: amenitiesAll,
      },
      location: {
        address,
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
      normalized_matching_profile: {
        source: "pm_fivestar30a",
        external_listing_id: externalListingId,
        name,
        description,
        match_signals: {
          description_normalized: descriptionNormalized,
          description_sha256: hashSha256(descriptionNormalized),
          title_normalized: titleNormalized,
          title_sha256: hashSha256(titleNormalized),
          listing_composite_key: [
            "pm_fivestar30a",
            externalListingId,
            hashSha256(descriptionNormalized),
            hashSha256(titleNormalized),
          ].join("::"),
        },
      },
      normalized_availability: {
        source: "pm_fivestar30a",
        external_listing_id: externalListingId,
        captured_at: new Date().toISOString(),
        has_calendar_widget:
          html.includes("Select your arrival date") ||
          html.includes("calendar-wrap") ||
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
          I: "checkout_only",
          O: "checkin_only",
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
      normalized_rates: {
        source: "pm_fivestar30a",
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
        rows: rateRules,
      },
      property_profile: {
        unit_id: String(propDetails.unit_id ?? parsedUnitId ?? ""),
        location_id: String(propDetails.location_id ?? ""),
        area: String(propDetails.area ?? ""),
        location: String(propDetails.location ?? ""),
        beds: Number.isFinite(Number(propDetails.bed))
          ? Number(propDetails.bed)
          : null,
        baths: Number.isFinite(Number(propDetails.bath))
          ? Number(propDetails.bath)
          : null,
        sleeps: Number.isFinite(Number(propDetails.sleeps))
          ? Number(propDetails.sleeps)
          : null,
        city: String(propDetails.city ?? ""),
        state: String(propDetails.state ?? ""),
      },
      quote_context: {
        source: "detail_prop_payload",
        unit_id: String(propDetails.unit_id ?? parsedUnitId ?? ""),
        location_id: String(propDetails.location_id ?? ""),
        detail_url: normalizedDetailUrl,
      },
    };
  } catch {
    return null;
  }
}

export function createFiveStar30AAdapter(): ScraperAdapter<FiveStarDetailRecord> {
  return {
    managerKey: "fivestar30a",
    scriptLabel: "fivestar30a",
    defaultAnchorUrl: DEFAULT_ANCHOR_URL,
    detailFetchDelayMs: Math.max(
      0,
      Number(process.env.FIVESTAR30A_DETAIL_FETCH_DELAY_MS ?? "250") || 250,
    ),
    detailFetchConcurrency: Math.max(
      1,
      Number(process.env.FIVESTAR30A_FETCH_CONCURRENCY ?? "6") || 6,
    ),
    availabilityHorizonDays: Math.max(
      1,
      Number(process.env.FIVESTAR30A_AVAILABILITY_HORIZON_DAYS ?? "486") || 486,
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
        context.scrollPauseMs,
        context.reportProgress,
      );
    },
    async fetchDetail(context) {
      return fetchDetail(context.detailUrl, context.availabilityHorizonDays);
    },
    async runQuoteCapture(argv, progress) {
      const normalizedArgs = await normalizeAdapterQuoteScopeArgs(
        "fivestar30a",
        argv,
      );
      await runRuntimeAdapterQuoteCli(
        {
          adapterKey: "fivestar30a",
          executeSingleQuote: executeFivestar30aSingleQuote,
          defaultQuoteTimeoutMs: 20000,
          defaultQuoteMaxAttempts: 2,
          defaultEndpointPath: "/vacation-rentals/router/",
          defaultTaxPct: 0.12,
          defaultBaseNightly: 700,
        },
        normalizedArgs,
        progress,
      );
    },
    async runSingleQuoteObservation(input) {
      const result = await executeFivestar30aSingleQuote({
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
