import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";

import {
  assertCanonicalQuotesSidecarRecord,
  type CanonicalQuoteObservation,
  type CanonicalQuotesSidecarRecord,
} from "@/lib/pricing/contracts/quote-observations-contract";
import { execute360BlueSingleQuote } from "@/lib/pricing/quote-runtime/adapters/360blue";
import { runRuntimeAdapterQuoteCli } from "@/lib/pricing/quotes/shared/runtime-adapter-quote-runner";
import { normalizeAdapterQuoteScopeArgs } from "../quote-scope";
import type { DetailRecordBase, ScrapedLink, ScraperAdapter } from "../types";

type BookingDayState = "bookable" | "blocked" | "unknown";
type CanonicalDayCode = "Y" | "N";
type CanonicalChangeoverCode = "C" | "I" | "O" | "X";

type MinNightRule = {
  start_date: string;
  end_date: string;
  min_nights: number;
  raw_rule: string;
};

type BookingAvailabilityApiRow = {
  date: string;
  available: boolean;
  dateAllowsCheckIn: boolean;
  dateAllowsCheckOut: boolean;
  minLOSForCheckIn: number;
  maxLOSForCheckIn: number;
  availableCheckOutDays: string[];
};

type ReservationQuoteApiResponse = {
  unitId: string;
  arrivalDate: string;
  departureDate: string;
  adults: number;
  children: number;
  subTotal: number;
  averageNightlyRate: number;
  total: number;
  taxes: number;
};

type EstimatedQuotePricing = {
  baseNightly: number;
  allInNightly: number;
  baseTotal: number;
  taxesTotal: number;
  feesTotalExclTaxes: number;
  grandTotal: number;
  quotedTotal: number;
  feePctOfBase: number;
  taxPctOfBase: number;
  nonBasePctOfTotal: number;
  allInMultiplier: number;
};

type RateQuoteObservation = CanonicalQuoteObservation;

type DetailRecord360Blue = DetailRecordBase & {
  title: string;
  h1: string;
  canonical_url: string;
  meta_description: string;
  json_ld_name: string;
  json_ld_description: string;
  description_expanded: string;
  rooms_guidance: false | string[];
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
    unit_id: string;
    cart_create_endpoint: string;
  };
  normalized_availability: {
    source: "pm_360blue";
    external_listing_id: string;
    captured_at: string;
    has_calendar_widget: boolean;
    check_in_time: string;
    check_out_time: string;
    booking_restrictions: string[];
    min_night_rules: MinNightRule[];
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
      status_code: "A" | "U" | "I" | "O" | "X";
      changeover_code: CanonicalChangeoverCode;
      is_available: boolean;
      is_available_for_checkin: boolean;
      is_available_for_checkout: boolean;
      booking_day_state: BookingDayState;
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
    source: "pm_360blue";
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
    advertised_rate_texts: string[];
    matched_nightly_snippets: string[];
    observations_count: number;
    observations_path: string | null;
    observations: RateQuoteObservation[];
    quote_windows_count: number;
    quote_windows_path: string | null;
    quote_windows: Array<{
      arrival_date: string;
      departure_date: string;
      nights: number;
      subtotal: number;
      total: number;
    }>;
  };
  normalized_matching_profile: {
    source: "pm_360blue";
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
  body_text_excerpt: string;
  scrape_metrics: {
    total_ms: number;
    page_load_and_expand_ms: number;
    extraction_ms: number;
    calendar_pagination_clicks: number;
    calendar_iterations: number;
  };
};

const DEFAULT_ANCHOR_URL = "https://www.360blue.com/travel-collections/30A";
const OUTPUT_ROOT = resolve(
  process.cwd(),
  "src",
  "lib",
  "data",
  "external-sources",
  "360blue",
);
const OUTPUT_DETAILS_HTML_DIR = resolve(OUTPUT_ROOT, "details", "html");
const OUTPUT_DETAILS_QUOTES_DIR = resolve(OUTPUT_ROOT, "details", "quotes");
const BLUE360_CART_CREATE_ENDPOINT =
  "https://www.360blue.com/api/nrbe/carts/create.json";

type BlueQuoteSidecar = CanonicalQuotesSidecarRecord;

function build360BlueHandoffUrl(input: {
  unitId: string;
  arrivalDate: string;
  departureDate: string;
  adults: number;
  children: number;
}): string | null {
  const normalizedUnitId = Number(input.unitId);
  if (!Number.isFinite(normalizedUnitId) || normalizedUnitId <= 0) {
    return null;
  }

  const payload = {
    unitId: Math.floor(normalizedUnitId),
    arrivalDate: input.arrivalDate,
    departureDate: input.departureDate,
    adults: Math.max(1, Math.floor(input.adults)),
    children: Math.max(0, Math.floor(input.children)),
  };

  const params = new URLSearchParams();
  params.set("method", "POST");
  params.set("contentType", "application/json");
  params.set("payload", JSON.stringify(payload));
  return `${BLUE360_CART_CREATE_ENDPOINT}#${params.toString()}`;
}

function normalizeLink(url: string): string {
  return url.split("#")[0]?.replace(/\/$/, "") ?? url;
}

function toValidDetailUrl(value: string): string | null {
  try {
    const parsed = new URL(value.trim());
    const isPropertyPath = parsed.pathname.includes("/properties/");
    const isSupportedHost =
      parsed.hostname.endsWith("360blue.com") ||
      parsed.hostname.endsWith("callistavacations.com");
    if (!isPropertyPath || !isSupportedHost) {
      return null;
    }

    // Canonicalize all accepted 360blue detail URLs onto the public 360blue host.
    parsed.hostname = "www.360blue.com";
    parsed.protocol = "https:";
    return normalizeLink(parsed.toString());
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

function toTurnDayChangeoverCode(statusCode: string): string {
  const code = statusCode.trim().toUpperCase();
  if (code === "I") {
    return "I";
  }
  if (code === "O") {
    return "O";
  }
  if (code === "A") {
    return "C";
  }
  if (code === "U" || code === "X") {
    return "X";
  }
  return "";
}

function toDayCodeFromStatus(statusCode: string): CanonicalDayCode {
  const code = statusCode.trim().toUpperCase();
  return code === "A" || code === "O" ? "Y" : "N";
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

function parseFirstNightlyRate(texts: string[]): number | null {
  for (const text of texts) {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (!normalized) {
      continue;
    }

    // Prioritize values clearly tied to nightly pricing copy.
    if (!/(night|\/\s*nt|per\s*night)/i.test(normalized)) {
      continue;
    }

    const match = normalized.match(/\$\s*([\d,]+(?:\.\d{2})?)/);
    if (!match?.[1]) {
      continue;
    }

    const parsed = Number(match[1].replace(/,/g, ""));
    if (!Number.isFinite(parsed) || parsed <= 0) {
      continue;
    }

    return Math.round(parsed * 100) / 100;
  }

  return null;
}

function extractLatLngFromHtml(html: string): {
  latitude: number | null;
  longitude: number | null;
} {
  const mapNodeMatch = html.match(
    /<div[^>]+class="[^"]*cmp-pdp-map[^"]*"[^>]*>/i,
  );
  if (!mapNodeMatch?.[0]) {
    return { latitude: null, longitude: null };
  }

  const mapNode = mapNodeMatch[0];
  const latRaw = mapNode.match(/\sdata-lat="([^"]+)"/i)?.[1]?.trim() ?? "";
  const longRaw = mapNode.match(/\sdata-long="([^"]+)"/i)?.[1]?.trim() ?? "";
  const latitude = Number(latRaw);
  const longitude = Number(longRaw);

  return {
    latitude: Number.isFinite(latitude) ? latitude : null,
    longitude: Number.isFinite(longitude) ? longitude : null,
  };
}

function normalizeGalleryUrl(rawUrl: string): string {
  const cleaned = rawUrl.trim();
  if (!cleaned) {
    return "";
  }

  const embeddedHttpIndex = cleaned.indexOf("https://", "https://".length);
  if (embeddedHttpIndex > 0) {
    const embedded = cleaned.slice(embeddedHttpIndex);
    try {
      const embeddedParsed = new URL(embedded);
      return `${embeddedParsed.origin}${embeddedParsed.pathname}`;
    } catch {
      // Fall through to regular parsing.
    }
  }

  try {
    const parsed = new URL(cleaned);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "";
  }
}

function parseAddressFromTitle(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }

  const hyphenIndex = text.lastIndexOf(" - ");
  if (hyphenIndex > -1) {
    const afterDash = text.slice(hyphenIndex + 3).trim();
    if (afterDash) {
      return afterDash;
    }
  }

  const deQuoted = text
    .replace(/"[^"]*"/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const streetMatch = Array.from(
    deQuoted.matchAll(
      /\b\d{1,6}\s+[A-Za-z0-9.'#&/-]+(?:\s+[A-Za-z0-9.'#&/-]+){0,10}\s(?:Street|St|Road|Rd|Avenue|Ave|Boulevard|Blvd|Highway|Hwy|Drive|Dr|Lane|Ln|Court|Ct|Way|Place|Pl|Circle|Cir|Trail|Trl|Loop|Parkway|Pkwy)\b(?:\s+[A-Za-z0-9.'#&/-]+){0,8}/gi,
    ),
  )
    .map((match) => (match[0] ?? "").trim())
    .filter(Boolean)
    .at(-1);
  if (streetMatch) {
    return streetMatch;
  }

  const trailingAddressMatch = text.match(/(\d+\s+[A-Za-z0-9 .'-]+)$/);
  if (trailingAddressMatch?.[1]) {
    return trailingAddressMatch[1].trim();
  }

  return "";
}

function parseCityState(label: string): { city: string; state: string } {
  const compact = label.replace(/\s+/g, " ").trim();
  if (!compact) {
    return { city: "", state: "" };
  }

  const parts = compact
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  const city = parts[0] ?? "";
  const state = (parts[1] ?? "").split(/\s+/)[0] ?? "";
  return { city, state };
}

function extractJsonLdBlocks(html: string): Array<{ parsed: unknown | null }> {
  const matches = Array.from(
    html.matchAll(
      /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
    ),
  );

  const blocks: Array<{ parsed: unknown | null }> = [];
  for (const match of matches) {
    const raw = (match?.[1] ?? "").trim();
    if (!raw) {
      continue;
    }

    try {
      blocks.push({ parsed: JSON.parse(raw) });
    } catch {
      blocks.push({ parsed: null });
    }
  }

  return blocks;
}

function parseJsonLd(blocks: Array<{ parsed: unknown | null }>): {
  name: string;
  description: string;
} {
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

function extractExternalListingId(detailUrl: string): string {
  try {
    const parsed = new URL(detailUrl);
    const parts = parsed.pathname.split("/").filter(Boolean);
    return parts[parts.length - 1] ?? parsed.pathname;
  } catch {
    return detailUrl;
  }
}

function parseRuleDateLabel(value: string): string {
  const cleaned = value.replace(/\s+/g, " ").trim();
  const match = cleaned.match(/^([A-Za-z]+)\.\s+(\d{1,2}),\s+(\d{4})$/);
  if (!match) {
    return "";
  }

  const monthRaw = match[1]?.toLowerCase() ?? "";
  const day = Number(match[2]);
  const year = Number(match[3]);
  const monthByName: Record<string, number> = {
    jan: 0,
    january: 0,
    feb: 1,
    february: 1,
    mar: 2,
    march: 2,
    apr: 3,
    april: 3,
    may: 4,
    jun: 5,
    june: 5,
    jul: 6,
    july: 6,
    aug: 7,
    august: 7,
    sep: 8,
    sept: 8,
    september: 8,
    oct: 9,
    october: 9,
    nov: 10,
    november: 10,
    dec: 11,
    december: 11,
  };

  const monthIndex = monthByName[monthRaw];
  if (
    !Number.isFinite(monthIndex) ||
    !Number.isFinite(day) ||
    !Number.isFinite(year) ||
    day <= 0 ||
    day > 31
  ) {
    return "";
  }

  return new Date(Date.UTC(year, monthIndex, day)).toISOString().slice(0, 10);
}

function parseMinNightRules(rawRules: string[]): MinNightRule[] {
  const parsedRules: MinNightRule[] = [];

  for (const rawRule of rawRules) {
    const match = rawRule.match(
      /^([A-Za-z]{3}\.\s+\d{1,2},\s+\d{4})\s+—\s+([A-Za-z]{3}\.\s+\d{1,2},\s+\d{4})\s+(\d+)\s+Night\s+Minimum$/i,
    );
    if (!match) {
      continue;
    }

    const startDate = parseRuleDateLabel(match[1] ?? "");
    const endDate = parseRuleDateLabel(match[2] ?? "");
    const minNights = Number(match[3]);
    if (
      !startDate ||
      !endDate ||
      !Number.isFinite(minNights) ||
      minNights <= 0
    ) {
      continue;
    }

    parsedRules.push({
      start_date: startDate,
      end_date: endDate,
      min_nights: Math.floor(minNights),
      raw_rule: rawRule,
    });
  }

  return parsedRules.sort((left, right) =>
    left.start_date.localeCompare(right.start_date),
  );
}

function resolveMinNightsForDate(
  date: string,
  rules: MinNightRule[],
): number | null {
  let matchedMinNights: number | null = null;
  for (const rule of rules) {
    if (date < rule.start_date || date > rule.end_date) {
      continue;
    }

    matchedMinNights =
      matchedMinNights === null
        ? rule.min_nights
        : Math.max(matchedMinNights, rule.min_nights);
  }
  return matchedMinNights;
}

function addDaysToIsoDate(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function nightsBetweenIsoDates(startDate: string, endDate: string): number {
  const start = new Date(`${startDate}T00:00:00Z`).getTime();
  const end = new Date(`${endDate}T00:00:00Z`).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return 0;
  }

  return Math.round((end - start) / 86400000);
}

function firstSaturdayOnOrAfter(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  const day = date.getUTCDay();
  const daysUntilSaturday = (6 - day + 7) % 7;
  date.setUTCDate(date.getUTCDate() + daysUntilSaturday);
  return date.toISOString().slice(0, 10);
}

function buildWeeklyQuoteWindowStarts(input: {
  fromDateIso: string;
  toDateIso: string;
  maxQueries: number;
}): string[] {
  const starts: string[] = [];
  let cursor = firstSaturdayOnOrAfter(input.fromDateIso);

  while (
    starts.length < Math.max(1, input.maxQueries) &&
    cursor <= input.toDateIso
  ) {
    starts.push(cursor);
    cursor = addDaysToIsoDate(cursor, 7);
  }

  return starts;
}

function toUtcMidnightMs(isoDate: string): number {
  return Date.parse(`${isoDate}T00:00:00Z`);
}

function minIsoDate(left: string, right: string): string {
  return left <= right ? left : right;
}

async function fetchNrbeJson<T>(
  page: Page,
  endpointPath: string,
  params: Record<string, string>,
  timeoutMs = 12000,
): Promise<T | null> {
  const queryEntries = Object.entries(params).filter(([, value]) =>
    Boolean(value?.trim()),
  );

  const result = await page.evaluate(
    async ({
      endpointPath: path,
      queryEntries: entries,
      timeoutMs: timeout,
    }) => {
      const searchParams = new URLSearchParams();
      for (const [key, value] of entries) {
        searchParams.set(key, value);
      }

      const url = `${path}?${searchParams.toString()}`;
      const controller = new AbortController();
      const timeoutHandle = window.setTimeout(
        () => controller.abort(),
        timeout,
      );

      try {
        const response = await fetch(url, {
          method: "GET",
          credentials: "include",
          headers: {
            accept: "application/json, text/plain, */*",
          },
          signal: controller.signal,
        });
        const bodyText = await response.text();

        return {
          ok: response.ok,
          status: response.status,
          bodyText,
        };
      } catch {
        return {
          ok: false,
          status: 0,
          bodyText: "",
        };
      } finally {
        window.clearTimeout(timeoutHandle);
      }
    },
    {
      endpointPath,
      queryEntries,
      timeoutMs,
    },
  );

  if (!result.ok || !result.bodyText) {
    return null;
  }

  try {
    return JSON.parse(result.bodyText) as T;
  } catch {
    return null;
  }
}

async function fetchBookingAvailabilitySeries(
  page: Page,
  unitId: string,
  startDate: string,
  endDate: string,
): Promise<BookingAvailabilityApiRow[]> {
  const rowsByDate = new Map<string, BookingAvailabilityApiRow>();
  let cursor = startDate;

  while (cursor <= endDate) {
    const chunkEnd = minIsoDate(addDaysToIsoDate(cursor, 55), endDate);
    const chunk = await fetchNrbeJson<BookingAvailabilityApiRow[]>(
      page,
      "/api/nrbe/booking-availability.json",
      {
        unitId,
        startDate: cursor,
        endDate: chunkEnd,
      },
    );

    if (Array.isArray(chunk)) {
      for (const row of chunk) {
        if (!row?.date) {
          continue;
        }

        rowsByDate.set(row.date, {
          date: row.date,
          available: Boolean(row.available),
          dateAllowsCheckIn: Boolean(row.dateAllowsCheckIn),
          dateAllowsCheckOut: Boolean(row.dateAllowsCheckOut),
          minLOSForCheckIn: Number.isFinite(row.minLOSForCheckIn)
            ? Math.max(1, Math.floor(row.minLOSForCheckIn))
            : 1,
          maxLOSForCheckIn: Number.isFinite(row.maxLOSForCheckIn)
            ? Math.max(1, Math.floor(row.maxLOSForCheckIn))
            : 28,
          availableCheckOutDays: Array.isArray(row.availableCheckOutDays)
            ? row.availableCheckOutDays.filter((value) =>
                /^\d{4}-\d{2}-\d{2}$/.test(value),
              )
            : [],
        });
      }
    }

    cursor = addDaysToIsoDate(chunkEnd, 1);
  }

  return Array.from(rowsByDate.values()).sort((left, right) =>
    left.date.localeCompare(right.date),
  );
}

async function fetchReservationQuote(
  page: Page,
  unitId: string,
  arrivalDate: string,
  departureDate: string,
  adults: number,
  children: number,
  timeoutMs: number,
): Promise<ReservationQuoteApiResponse | null> {
  const quote = await fetchNrbeJson<ReservationQuoteApiResponse>(
    page,
    "/api/nrbe/reservation-quotes.json",
    {
      unitId,
      arrivalDate,
      departureDate,
      adults: String(Math.max(1, Math.floor(adults))),
      children: String(Math.max(0, Math.floor(children))),
    },
    timeoutMs,
  );

  if (!quote) {
    return null;
  }

  if (
    !Number.isFinite(quote.averageNightlyRate) ||
    !Number.isFinite(quote.subTotal) ||
    !Number.isFinite(quote.total) ||
    !Number.isFinite(quote.taxes)
  ) {
    return null;
  }

  return quote;
}

function createUnavailableObservation(input: {
  listingId: string;
  unitId: string;
  arrivalDate: string;
  departureDate: string;
  nights: number;
  reason: string;
  sampledAt: string;
  pricing: EstimatedQuotePricing;
}): RateQuoteObservation {
  return {
    sampled_at: input.sampledAt,
    captured_at: new Date().toISOString(),
    source_listing_id: input.listingId,
    currency: "USD",
    start_date: input.arrivalDate,
    end_date: input.departureDate,
    check_in_date: input.arrivalDate,
    check_out_date: input.departureDate,
    nights: input.nights,
    base_nightly: input.pricing.baseNightly,
    all_in_nightly: input.pricing.allInNightly,
    quote_available: false,
    quote_unavailable_reason: input.reason,
    base_total: input.pricing.baseTotal,
    taxes_total: input.pricing.taxesTotal,
    fees_total_excl_taxes: input.pricing.feesTotalExclTaxes,
    fee_lines: [],
    grand_total: input.pricing.grandTotal,
    quoted_total: input.pricing.quotedTotal,
    fee_pct_of_base: input.pricing.feePctOfBase,
    tax_pct_of_base: input.pricing.taxPctOfBase,
    non_base_pct_of_total: input.pricing.nonBasePctOfTotal,
    all_in_multiplier: input.pricing.allInMultiplier,
    handoff_url: build360BlueHandoffUrl({
      unitId: input.unitId,
      arrivalDate: input.arrivalDate,
      departureDate: input.departureDate,
      adults: 1,
      children: 0,
    }),
    source: "quote_api",
  };
}

function createAvailableObservation(input: {
  listingId: string;
  unitId: string;
  arrivalDate: string;
  departureDate: string;
  nights: number;
  quote: ReservationQuoteApiResponse;
  sampledAt: string;
}): RateQuoteObservation {
  const baseTotal = Number(input.quote.subTotal);
  const taxesTotal = Number(input.quote.taxes);
  const grandTotal = Number(input.quote.total);
  const feesTotalExclTaxes = Math.max(
    0,
    Math.round((grandTotal - baseTotal - taxesTotal) * 100) / 100,
  );
  const baseNightly =
    Number.isFinite(baseTotal) && input.nights > 0
      ? Math.round((baseTotal / input.nights) * 100) / 100
      : null;
  const allInNightly =
    Number.isFinite(grandTotal) && input.nights > 0
      ? Math.round((grandTotal / input.nights) * 100) / 100
      : null;

  return {
    sampled_at: input.sampledAt,
    captured_at: new Date().toISOString(),
    source_listing_id: input.listingId,
    currency: "USD",
    start_date: input.arrivalDate,
    end_date: input.departureDate,
    check_in_date: input.arrivalDate,
    check_out_date: input.departureDate,
    nights: input.nights,
    base_nightly: baseNightly,
    all_in_nightly: allInNightly,
    quote_available: true,
    quote_unavailable_reason: null,
    base_total: baseTotal,
    taxes_total: taxesTotal,
    fees_total_excl_taxes: feesTotalExclTaxes,
    fee_lines: [],
    grand_total: grandTotal,
    quoted_total: grandTotal,
    fee_pct_of_base:
      Number.isFinite(baseTotal) && baseTotal > 0
        ? Math.round((feesTotalExclTaxes / baseTotal) * 1_000_000) / 1_000_000
        : 0,
    tax_pct_of_base:
      Number.isFinite(baseTotal) && baseTotal > 0
        ? Math.round((taxesTotal / baseTotal) * 1_000_000) / 1_000_000
        : 0,
    non_base_pct_of_total:
      Number.isFinite(grandTotal) && grandTotal > 0
        ? Math.round(((grandTotal - baseTotal) / grandTotal) * 1_000_000) /
          1_000_000
        : 0,
    all_in_multiplier:
      Number.isFinite(baseTotal) && baseTotal > 0 && Number.isFinite(grandTotal)
        ? Math.round((grandTotal / baseTotal) * 1_000_000) / 1_000_000
        : null,
    handoff_url: build360BlueHandoffUrl({
      unitId: input.unitId,
      arrivalDate: input.arrivalDate,
      departureDate: input.departureDate,
      adults: 1,
      children: 0,
    }),
    source: "quote_api",
  };
}

function createEstimatedPricing(input: {
  baseNightly: number;
  nights: number;
  taxPctOfBase: number;
}): EstimatedQuotePricing {
  const baseTotal = Math.round(input.baseNightly * input.nights * 100) / 100;
  const taxesTotal =
    Math.round(baseTotal * Math.max(0, input.taxPctOfBase) * 100) / 100;
  const feesTotalExclTaxes = 0;
  const grandTotal =
    Math.round((baseTotal + taxesTotal + feesTotalExclTaxes) * 100) / 100;
  const allInNightly =
    input.nights > 0 ? Math.round((grandTotal / input.nights) * 100) / 100 : 0;
  const allInMultiplier =
    baseTotal > 0
      ? Math.round((grandTotal / baseTotal) * 1_000_000) / 1_000_000
      : 1;
  const nonBasePctOfTotal =
    grandTotal > 0
      ? Math.round(((grandTotal - baseTotal) / grandTotal) * 1_000_000) /
        1_000_000
      : 0;

  return {
    baseNightly: Math.round(input.baseNightly * 100) / 100,
    allInNightly,
    baseTotal,
    taxesTotal,
    feesTotalExclTaxes,
    grandTotal,
    quotedTotal: grandTotal,
    feePctOfBase: 0,
    taxPctOfBase:
      baseTotal > 0
        ? Math.round((taxesTotal / baseTotal) * 1_000_000) / 1_000_000
        : 0,
    nonBasePctOfTotal,
    allInMultiplier,
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? null;
  }

  const left = sorted[middle - 1];
  const right = sorted[middle];
  if (left === undefined || right === undefined) {
    return null;
  }

  return Math.round(((left + right) / 2) * 100) / 100;
}

function interpolateValue(
  values: Array<number | null>,
  index: number,
): number | null {
  const direct = values[index];
  if (direct !== null && direct !== undefined) {
    return direct;
  }

  let previous: { value: number; index: number } | null = null;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const value = values[cursor];
    if (value !== null && value !== undefined) {
      previous = { value, index: cursor };
      break;
    }
  }

  let next: { value: number; index: number } | null = null;
  for (let cursor = index + 1; cursor < values.length; cursor += 1) {
    const value = values[cursor];
    if (value !== null && value !== undefined) {
      next = { value, index: cursor };
      break;
    }
  }

  if (previous && next && previous.index !== next.index) {
    const span = next.index - previous.index;
    const position = index - previous.index;
    const ratio = position / span;
    return (
      Math.round(
        (previous.value + (next.value - previous.value) * ratio) * 100,
      ) / 100
    );
  }

  if (previous) {
    return previous.value;
  }

  if (next) {
    return next.value;
  }

  return null;
}

async function discoverListings(
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

  let previousHeight = 0;
  for (let step = 0; step < maxScrollSteps; step += 1) {
    await page.evaluate(() => {
      window.scrollBy(0, window.innerHeight * 1.5);
    });

    await page.waitForTimeout(scrollPauseMs);

    const currentHeight = await page.evaluate(() => document.body.scrollHeight);
    if (currentHeight === previousHeight) {
      await page.waitForTimeout(networkIdleWaitMs);
      const recheckHeight = await page.evaluate(
        () => document.body.scrollHeight,
      );
      if (recheckHeight === currentHeight) {
        break;
      }
    }

    previousHeight = currentHeight;

    if ((step + 1) % 10 === 0) {
      reportProgress(`scroll steps completed: ${step + 1}`);
    }
  }

  const linkRows = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll("a[href]"));
    return anchors.map((anchor) => ({
      href: (anchor as HTMLAnchorElement).href,
      text: (anchor.textContent ?? "").trim(),
    }));
  });

  const rows: ScrapedLink[] = [];
  const seen = new Set<string>();

  for (const row of linkRows) {
    const href = typeof row.href === "string" ? row.href : "";
    if (!href) {
      continue;
    }

    const valid = toValidDetailUrl(href);
    if (!valid || seen.has(valid)) {
      continue;
    }

    seen.add(valid);
    rows.push({
      link: valid,
      source_url: anchorUrl,
      anchor_text: typeof row.text === "string" ? row.text : "",
    });
  }

  return rows.sort((left, right) => left.link.localeCompare(right.link));
}

async function fetchDetail(
  browser: Browser,
  detailUrl: string,
  availabilityHorizonDays: number,
  maxCalendarAdvanceMonths: number,
  mode:
    | "detail"
    | "avail"
    | "quote"
    | "detail,avail"
    | "detail,quote"
    | "avail,quote"
    | "detail,avail,quote",
  existingDetailJsonPath?: string | null,
  reportDetailProgress?: (message: string) => void,
): Promise<DetailRecord360Blue | null> {
  const externalListingId = extractExternalListingId(detailUrl);

  const page = await browser.newPage();
  const fetchStartedAt = Date.now();

  try {
    const pageLoadStartedAt = Date.now();
    await page.goto(detailUrl, {
      waitUntil: "domcontentloaded",
      timeout: 120000,
    });
    await page.waitForTimeout(1200);

    await page.evaluate(() => {
      const button = document.querySelector(
        ".cmp-property-description__read-more-less",
      );
      if (button instanceof HTMLButtonElement) {
        button.click();
      }
    });
    await page.waitForTimeout(250);
    const pageLoadAndExpandMs = Date.now() - pageLoadStartedAt;

    const extractionStartedAt = Date.now();
    const extracted = await page.evaluate(() => {
      const propertyName =
        document
          .querySelector(".cmp-property-description__title")
          ?.textContent?.trim() ?? "";
      const propertyDescription =
        document
          .querySelector(".cmp-property-description__description")
          ?.textContent?.trim() ?? "";
      const h1 = document.querySelector("h1")?.textContent?.trim() ?? "";
      const canonical =
        document
          .querySelector('link[rel="canonical"]')
          ?.getAttribute("href")
          ?.trim() ?? "";
      const metaDescription =
        document
          .querySelector('meta[name="description"]')
          ?.getAttribute("content")
          ?.trim() ?? "";
      const shortAddress =
        document
          .querySelector(".cmp-property-description__short-address")
          ?.textContent?.trim() ?? "";
      const bedroomsText =
        document
          .querySelector(".cmp-property-description__bedrooms")
          ?.textContent?.trim() ?? "";
      const bedsText =
        document
          .querySelector(".cmp-property-description__beds")
          ?.textContent?.trim() ?? "";
      const sleepsText =
        document
          .querySelector(".cmp-property-description__sleeps")
          ?.textContent?.trim() ??
        document
          .querySelector(".nr-booking-widget-root")
          ?.getAttribute("data-sleeps")
          ?.trim() ??
        "";
      const fullBathsText =
        document
          .querySelector(".cmp-property-description__bathrooms-number")
          ?.textContent?.trim() ?? "";
      const halfBathsText =
        document
          .querySelector(".cmp-property-description__halfbathrooms-number")
          ?.textContent?.trim() ?? "";
      const amenitiesItems = Array.from(
        document.querySelectorAll(".cmp-features-amenities__item"),
      )
        .map((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim())
        .filter(Boolean);
      const galleryUrls = Array.from(
        document.querySelectorAll(
          "#hero-gallery img[src], .cmp-property-hero-gallery img[src], .cmp-property-hero img[src]",
        ),
      )
        .map((img) => (img as HTMLImageElement).getAttribute("src") ?? "")
        .map((src) => src.trim())
        .filter(Boolean)
        .map((src) => {
          try {
            return new URL(src, window.location.origin).toString();
          } catch {
            return "";
          }
        })
        .filter(Boolean);
      const bodyText = document.body?.innerText ?? "";
      const unitId = document.body?.dataset?.propertyId?.trim() ?? "";
      const advertisedRateTexts = [
        ".box-Indifrom",
        ".nightRate",
        ".night-rate",
        ".nr-booking-widget-root [class*='nightRate']",
        ".nr-booking-widget-root [class*='night-rate']",
      ]
        .flatMap((selector) =>
          Array.from(document.querySelectorAll(selector)).map(
            (node) => node.textContent ?? "",
          ),
        )
        .map((value) => value.replace(/\s+/g, " ").trim())
        .filter(Boolean);
      const matchedNightlySnippets = Array.from(
        new Set(
          Array.from(
            bodyText.matchAll(
              /\$\s?[\d,]+(?:\.\d{2})?\s*(?:\/\s*night|per\s*night|nightly|night)/gi,
            ),
          )
            .map((match) => match[0]?.trim() ?? "")
            .filter(Boolean),
        ),
      ).slice(0, 20);
      const html = document.documentElement.outerHTML;
      return {
        title: document.title ?? "",
        propertyName,
        propertyDescription,
        h1,
        canonical,
        metaDescription,
        shortAddress,
        bedroomsText,
        bedsText,
        sleepsText,
        fullBathsText,
        halfBathsText,
        amenitiesItems,
        galleryUrls,
        bodyText,
        unitId,
        advertisedRateTexts,
        matchedNightlySnippets,
        html,
      };
    });

    const html = extracted.html;
    const externalListingId = extractExternalListingId(detailUrl);

    const title = stripHtml(extracted.title).slice(0, 240);
    const propertyName = stripHtml(extracted.propertyName).slice(0, 240);
    const h1 = stripHtml(extracted.h1 || propertyName).slice(0, 240);
    const propertyDescription = stripHtml(extracted.propertyDescription).slice(
      0,
      20000,
    );
    const shortAddress = stripHtml(extracted.shortAddress).slice(0, 240);
    const canonicalUrl = extracted.canonical || detailUrl;
    const metaDescription = stripHtml(extracted.metaDescription).slice(0, 1200);
    const bodyText = extracted.bodyText.replace(/\s+/g, " ").trim();

    const jsonLdBlocks = extractJsonLdBlocks(html);
    const jsonLd = parseJsonLd(jsonLdBlocks);

    const horizonDate = new Date();
    horizonDate.setUTCDate(horizonDate.getUTCDate() + availabilityHorizonDays);
    const todayIso = new Date().toISOString().slice(0, 10);
    const horizonIso = horizonDate.toISOString().slice(0, 10);

    const unitId = extracted.unitId?.trim() ?? "";
    // Prefer provider booking-availability API whenever unit id is available.
    // This avoids brittle UI-calendar pagination ceilings during avail-only refreshes.
    const shouldUseBookingAvailabilityApi = true;
    const bookingAvailabilityRows =
      shouldUseBookingAvailabilityApi && /^\d+$/.test(unitId)
        ? await fetchBookingAvailabilitySeries(
            page,
            unitId,
            todayIso,
            horizonIso,
          )
        : [];
    const bookingAvailabilityByDate = new Map(
      bookingAvailabilityRows.map((row) => [row.date, row]),
    );

    let calendarPageClicks = 0;
    let calendarIterationsUsed = bookingAvailabilityRows.length > 0 ? 1 : 0;

    const fallbackDayCodeByDate = new Map<
      string,
      "A" | "U" | "I" | "O" | "X"
    >();
    if (bookingAvailabilityRows.length === 0) {
      let lastSignature = "";

      for (
        let iteration = 0;
        iteration < maxCalendarAdvanceMonths;
        iteration += 1
      ) {
        calendarIterationsUsed = iteration + 1;
        const pageSlice = await page.evaluate(() => {
          const monthNameToIndex: Record<string, number> = {
            january: 0,
            february: 1,
            march: 2,
            april: 3,
            may: 4,
            june: 5,
            july: 6,
            august: 7,
            september: 8,
            october: 9,
            november: 10,
            december: 11,
          };

          const months = Array.from(
            document.querySelectorAll(".cmp-availability-calendar__month"),
          );

          const items: Array<{
            date: string;
            code: "A" | "U" | "I" | "O" | "X";
          }> = [];
          const signatures: string[] = [];

          for (const month of months) {
            const label =
              month
                .querySelector(".current-date")
                ?.textContent?.trim()
                .replace(/\s+/g, " ") ?? "";
            if (!label) {
              continue;
            }
            signatures.push(label);

            const match = label.match(/^([A-Za-z]+)\s+(\d{4})$/);
            if (!match) {
              continue;
            }

            const monthIndex = monthNameToIndex[match[1]!.toLowerCase()];
            const year = Number(match[2]);
            if (!Number.isFinite(monthIndex) || !Number.isFinite(year)) {
              continue;
            }

            const dayNodes = Array.from(month.querySelectorAll("ul.days > li"));
            for (const dayNode of dayNodes) {
              const classes = Array.from(dayNode.classList);
              if (classes.includes("inactive")) {
                continue;
              }

              const dayNum = Number((dayNode.textContent ?? "").trim());
              if (!Number.isFinite(dayNum) || dayNum <= 0 || dayNum > 31) {
                continue;
              }

              let code: "A" | "U" | "I" | "O" | "X" = "X";
              if (classes.includes("check-available")) {
                code = "A";
              } else if (classes.includes("check-unavailable")) {
                code = "U";
              } else if (classes.includes("checkin-only")) {
                code = "I";
              } else if (classes.includes("checkout-only")) {
                code = "O";
              }

              const isoDate = new Date(Date.UTC(year, monthIndex, dayNum))
                .toISOString()
                .slice(0, 10);

              items.push({
                date: isoDate,
                code,
              });
            }
          }

          return {
            hasCalendarWidget:
              document.querySelector(".cmp-availability-calendar") !== null,
            signature: signatures.join("|"),
            items,
          };
        });

        for (const item of pageSlice.items) {
          if (!fallbackDayCodeByDate.has(item.date)) {
            fallbackDayCodeByDate.set(item.date, item.code);
          }
        }

        const newestDate =
          Array.from(fallbackDayCodeByDate.keys()).sort().at(-1) ?? "";
        if (newestDate && newestDate >= horizonIso) {
          break;
        }

        if (
          !pageSlice.hasCalendarWidget ||
          pageSlice.signature === lastSignature
        ) {
          break;
        }
        lastSignature = pageSlice.signature;

        const clicked = await page.evaluate(() => {
          const nextButton = document.querySelector("#next");
          if (nextButton instanceof HTMLButtonElement) {
            nextButton.click();
            return true;
          }
          return false;
        });
        if (!clicked) {
          break;
        }

        calendarPageClicks += 1;
        await page.waitForTimeout(700);
      }
    }

    const hasCalendarWidget = /availability\s+calendar/i.test(bodyText);
    const checkInTimeMatch = bodyText.match(/Check-in:\s*([^\s]+\s*[AP]M)/i);
    const checkOutTimeMatch = bodyText.match(/Check-out:\s*([^\s]+\s*[AP]M)/i);
    const bookingRestrictionMatches = Array.from(
      bodyText.matchAll(
        /([A-Za-z]{3}\.\s+\d{1,2},\s+\d{4}\s+—\s+[A-Za-z]{3}\.\s+\d{1,2},\s+\d{4}\s+\d+\s+Night\s+Minimum)/g,
      ),
    )
      .map((match) => match[1] ?? "")
      .filter(Boolean);
    const minNightRules = parseMinNightRules(
      Array.from(new Set(bookingRestrictionMatches)).slice(0, 60),
    );

    const normalizedDays =
      bookingAvailabilityRows.length > 0
        ? bookingAvailabilityRows
            .filter((row) => row.date >= todayIso && row.date <= horizonIso)
            .map((row) => {
              let statusCode: "A" | "U" | "I" | "O" | "X" = "X";
              if (
                row.available &&
                row.dateAllowsCheckIn &&
                row.dateAllowsCheckOut
              ) {
                statusCode = "A";
              } else if (row.dateAllowsCheckIn && !row.dateAllowsCheckOut) {
                statusCode = "I";
              } else if (!row.dateAllowsCheckIn && row.dateAllowsCheckOut) {
                statusCode = "O";
              } else if (!row.available) {
                statusCode = "U";
              }

              const bookingDayState: BookingDayState = row.available
                ? "bookable"
                : "blocked";

              return {
                date: row.date,
                day_code: toDayCodeFromStatus(statusCode),
                status_code: statusCode,
                changeover_code: toTurnDayChangeoverCode(
                  statusCode,
                ) as CanonicalChangeoverCode,
                is_available: row.available,
                is_available_for_checkin:
                  row.available && row.dateAllowsCheckIn,
                is_available_for_checkout:
                  row.available && row.dateAllowsCheckOut,
                booking_day_state: bookingDayState,
                min_nights_required:
                  resolveMinNightsForDate(row.date, minNightRules) ??
                  row.minLOSForCheckIn,
              };
            })
        : Array.from(fallbackDayCodeByDate.entries())
            .filter(([date]) => date >= todayIso && date <= horizonIso)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([date, code]) => {
              const bookingDayState: BookingDayState =
                code === "A" || code === "O"
                  ? "bookable"
                  : code === "U" || code === "I"
                    ? "blocked"
                    : "unknown";

              return {
                date,
                day_code: toDayCodeFromStatus(code),
                status_code: code,
                changeover_code: toTurnDayChangeoverCode(
                  code,
                ) as CanonicalChangeoverCode,
                is_available: code === "A" || code === "O",
                is_available_for_checkin: code === "A" || code === "O",
                is_available_for_checkout: code === "A" || code === "O",
                booking_day_state: bookingDayState,
                min_nights_required: resolveMinNightsForDate(
                  date,
                  minNightRules,
                ),
              };
            });

    // Fallback: when provider rows omit turn-day markers, infer I/O from nearest
    // non-X neighbors so validator boundaries remain explicit.
    for (let i = 0; i < normalizedDays.length; i += 1) {
      const current = normalizedDays[i];
      if (!current || current.status_code !== "A") {
        continue;
      }

      let prevNonXStatus: "A" | "U" | "I" | "O" | null = null;
      for (let j = i - 1; j >= 0; j -= 1) {
        const status = normalizedDays[j]?.status_code;
        if (!status || status === "X") {
          continue;
        }
        prevNonXStatus = status;
        break;
      }

      let nextNonXStatus: "A" | "U" | "I" | "O" | null = null;
      for (let j = i + 1; j < normalizedDays.length; j += 1) {
        const status = normalizedDays[j]?.status_code;
        if (!status || status === "X") {
          continue;
        }
        nextNonXStatus = status;
        break;
      }

      const needsCheckinBoundary = prevNonXStatus === "U";
      const needsCheckoutBoundary = nextNonXStatus === "U";

      if (needsCheckinBoundary) {
        current.status_code = "I";
        current.day_code = toDayCodeFromStatus("I");
        current.changeover_code = "I";
        current.is_available = true;
        current.is_available_for_checkin = true;
        current.is_available_for_checkout = false;
        current.booking_day_state = "bookable";
        continue;
      }

      if (needsCheckoutBoundary) {
        current.status_code = "O";
        current.day_code = toDayCodeFromStatus("O");
        current.changeover_code = "O";
        current.is_available = true;
        current.is_available_for_checkin = false;
        current.is_available_for_checkout = true;
        current.booking_day_state = "bookable";
      }
    }

    if (normalizedDays.length === 0) {
      const cursor = new Date(`${todayIso}T00:00:00.000Z`);
      while (cursor.toISOString().slice(0, 10) <= horizonIso) {
        const date = cursor.toISOString().slice(0, 10);
        normalizedDays.push({
          date,
          day_code: "N",
          status_code: "X",
          changeover_code: "X",
          is_available: false,
          is_available_for_checkin: false,
          is_available_for_checkout: false,
          booking_day_state: "unknown",
          min_nights_required: null,
        });
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
    }

    const normalizedAvailability: DetailRecord360Blue["normalized_availability"] =
      {
        source: "pm_360blue",
        external_listing_id: externalListingId,
        captured_at: new Date().toISOString(),
        has_calendar_widget: hasCalendarWidget,
        check_in_time: checkInTimeMatch?.[1] ?? "",
        check_out_time: checkOutTimeMatch?.[1] ?? "",
        booking_restrictions: Array.from(
          new Set(bookingRestrictionMatches),
        ).slice(0, 60),
        min_night_rules: minNightRules,
        window_start: normalizedDays[0]?.date ?? "",
        window_end: normalizedDays[normalizedDays.length - 1]?.date ?? "",
        code_legend: {
          A: "available",
          U: "unavailable",
          I: "checkin_only",
          O: "checkout_only",
          X: "other",
        },
        day_codes: normalizedDays.map((day) => day.status_code).join(""),
        days: normalizedDays,
        counts: {
          available: normalizedDays.filter((day) => day.status_code === "A")
            .length,
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
        },
      };

    if (mode === "avail") {
      if (!existingDetailJsonPath) {
        throw new Error(
          `mode=avail requires existing detail artifact for ${externalListingId}`,
        );
      }

      const existingRaw = await readFile(existingDetailJsonPath, "utf8");
      const existingDetail = JSON.parse(existingRaw) as DetailRecord360Blue;
      const nowIso = new Date().toISOString();
      const extractionMs = Date.now() - extractionStartedAt;
      const totalMs = Date.now() - fetchStartedAt;

      return {
        ...existingDetail,
        external_listing_id: externalListingId,
        detail_url: detailUrl,
        fetched_at: nowIso,
        normalized_availability: normalizedAvailability,
        scrape_metrics: {
          ...(existingDetail.scrape_metrics ?? {
            total_ms: 0,
            page_load_and_expand_ms: 0,
            extraction_ms: 0,
            calendar_pagination_clicks: 0,
            calendar_iterations: 0,
          }),
          total_ms: totalMs,
          page_load_and_expand_ms: pageLoadAndExpandMs,
          extraction_ms: extractionMs,
          calendar_pagination_clicks: calendarPageClicks,
          calendar_iterations: calendarIterationsUsed,
        },
      };
    }

    const ratesWindowDays = Math.max(
      168,
      Number(process.env.BLUE360_RATES_WINDOW_DAYS ?? "182") || 182,
    );
    const ratesSampleStepDays = Math.max(
      7,
      Number(process.env.BLUE360_RATES_SAMPLE_STEP_DAYS ?? "7") || 7,
    );
    const targetQuoteNights = Math.max(
      1,
      Number(process.env.BLUE360_RATES_QUOTE_NIGHTS ?? "7") || 7,
    );
    const ratesMaxQueries = Math.max(
      1,
      Number(
        process.env.BLUE360_RATES_MAX_QUERIES ??
          process.env.BLUE360_RATE_QUOTE_MAX_DAYS ??
          "24",
      ) || 24,
    );
    const ratesTargetQueries = Math.max(
      1,
      Math.ceil(ratesWindowDays / ratesSampleStepDays),
    );
    const effectiveRatesMaxQueries = Math.min(
      ratesMaxQueries,
      ratesTargetQueries,
    );
    const ratesWindowEndIso = addDaysToIsoDate(
      normalizedDays[0]?.date ?? todayIso,
      ratesWindowDays - 1,
    );

    const availabilityByDate = new Map(
      normalizedDays.map((day) => [day.date, day] as const),
    );

    const normalizedRateDays: DetailRecord360Blue["normalized_rates"]["days"] =
      normalizedDays
        .filter((day) => day.date <= ratesWindowEndIso)
        .map((day) => ({
          date: day.date,
          nightly_rate: null,
          min_nights: day.min_nights_required,
          is_booked: day.is_available ? false : true,
          changeover_code: toTurnDayChangeoverCode(day.status_code),
          season_name: day.is_available ? "quote_pending" : "not_available",
        }));

    const quoteOutcomes = new Map<
      string,
      {
        sampledAt: string;
        arrivalDate: string;
        departureDate: string;
        nights: number;
        reason: string | null;
        quote: ReservationQuoteApiResponse | null;
      }
    >();
    const unitIdIsNumeric = /^\d+$/.test(unitId);
    const quoteTimeoutMs = Math.max(
      2000,
      Number(process.env.BLUE360_RATE_QUOTE_TIMEOUT_MS ?? "12000") || 12000,
    );
    const quoteMaxAttempts = Math.max(
      1,
      Number(process.env.BLUE360_RATE_QUOTE_MAX_ATTEMPTS ?? "2") || 2,
    );
    const quoteCallBudget = Math.max(
      1,
      Number(
        process.env.BLUE360_RATE_CALLS_BUDGET ??
          String(effectiveRatesMaxQueries * quoteMaxAttempts),
      ) || effectiveRatesMaxQueries * quoteMaxAttempts,
    );
    const maxConsecutiveQuoteFailures = Math.max(
      1,
      Number(process.env.BLUE360_RATE_CALLS_MAX_CONSECUTIVE_FAILURES ?? "3") ||
        3,
    );

    const weeklyQuoteStarts = buildWeeklyQuoteWindowStarts({
      fromDateIso: todayIso,
      toDateIso: ratesWindowEndIso,
      maxQueries: effectiveRatesMaxQueries,
    });

    const sampledRatesByDate = new Map<string, number>();
    let quoteCallsUsed = 0;
    let consecutiveQuoteFailures = 0;
    for (const startDate of weeklyQuoteStarts) {
      const sampleDay = normalizedRateDays.find(
        (day) => day.date === startDate,
      );
      const day = availabilityByDate.get(startDate);
      if (
        !sampleDay ||
        !day ||
        !day.is_available_for_checkin ||
        !unitIdIsNumeric
      ) {
        quoteOutcomes.set(startDate, {
          sampledAt: new Date().toISOString(),
          arrivalDate: startDate,
          departureDate: addDaysToIsoDate(startDate, targetQuoteNights),
          nights: targetQuoteNights,
          reason: "weekly cadence start unavailable for check-in",
          quote: null,
        });
        continue;
      }

      const nights = targetQuoteNights;
      const checkoutDate = addDaysToIsoDate(startDate, nights);
      const canCheckout =
        bookingAvailabilityByDate
          .get(startDate)
          ?.availableCheckOutDays.includes(checkoutDate) ?? false;
      if (!canCheckout) {
        sampleDay.season_name = "quote_unavailable";
        quoteOutcomes.set(startDate, {
          sampledAt: new Date().toISOString(),
          arrivalDate: startDate,
          departureDate: checkoutDate,
          nights,
          reason: "checkout day unavailable for sampled window",
          quote: null,
        });
        continue;
      }

      if (quoteCallsUsed >= quoteCallBudget) {
        sampleDay.season_name = "quote_unavailable";
        quoteOutcomes.set(startDate, {
          sampledAt: new Date().toISOString(),
          arrivalDate: startDate,
          departureDate: checkoutDate,
          nights,
          reason: "reservation-quotes call budget exceeded",
          quote: null,
        });
        continue;
      }

      if (consecutiveQuoteFailures >= maxConsecutiveQuoteFailures) {
        sampleDay.season_name = "quote_unavailable";
        quoteOutcomes.set(startDate, {
          sampledAt: new Date().toISOString(),
          arrivalDate: startDate,
          departureDate: checkoutDate,
          nights,
          reason: "reservation-quotes consecutive failures threshold exceeded",
          quote: null,
        });
        continue;
      }

      let quote: ReservationQuoteApiResponse | null = null;
      for (let attempt = 0; attempt < quoteMaxAttempts; attempt += 1) {
        quoteCallsUsed += 1;
        quote = await fetchReservationQuote(
          page,
          unitId,
          startDate,
          checkoutDate,
          1,
          0,
          quoteTimeoutMs,
        );
        if (quote) {
          break;
        }
        if (quoteCallsUsed >= quoteCallBudget) {
          break;
        }
      }

      if (!quote || nightsBetweenIsoDates(startDate, checkoutDate) <= 0) {
        sampleDay.season_name = "quote_unavailable";
        consecutiveQuoteFailures += 1;
        quoteOutcomes.set(startDate, {
          sampledAt: new Date().toISOString(),
          arrivalDate: startDate,
          departureDate: checkoutDate,
          nights,
          reason: "reservation-quotes request failed",
          quote: null,
        });
        continue;
      }

      consecutiveQuoteFailures = 0;

      const nightlyRate = Math.round((quote.subTotal / nights) * 100) / 100;
      if (Number.isFinite(nightlyRate) && nightlyRate > 0) {
        sampledRatesByDate.set(startDate, nightlyRate);
        sampleDay.nightly_rate = nightlyRate;
        sampleDay.season_name = "quote_weekly_sample";
      } else {
        sampleDay.season_name = "quote_unavailable";
      }

      quoteOutcomes.set(startDate, {
        sampledAt: new Date().toISOString(),
        arrivalDate: startDate,
        departureDate: checkoutDate,
        nights,
        reason: null,
        quote,
      });
    }

    const sampledPoints = Array.from(sampledRatesByDate.entries())
      .map(([date, nightlyRate]) => ({
        date,
        nightlyRate,
        ts: toUtcMidnightMs(date),
      }))
      .sort((left, right) => left.ts - right.ts);

    for (const rateDay of normalizedRateDays) {
      const day = availabilityByDate.get(rateDay.date);
      if (!day || !day.is_available || rateDay.nightly_rate !== null) {
        continue;
      }

      if (sampledPoints.length === 0) {
        rateDay.season_name = "quote_unavailable";
        continue;
      }

      const ts = toUtcMidnightMs(rateDay.date);
      let prevPoint: (typeof sampledPoints)[number] | null = null;
      let nextPoint: (typeof sampledPoints)[number] | null = null;

      for (const point of sampledPoints) {
        if (point.ts <= ts) {
          prevPoint = point;
        }
        if (point.ts >= ts) {
          nextPoint = point;
          break;
        }
      }

      if (prevPoint && nextPoint && prevPoint.ts !== nextPoint.ts) {
        const ratio = (ts - prevPoint.ts) / (nextPoint.ts - prevPoint.ts);
        rateDay.nightly_rate =
          Math.round(
            (prevPoint.nightlyRate +
              (nextPoint.nightlyRate - prevPoint.nightlyRate) * ratio) *
              100,
          ) / 100;
        rateDay.season_name = "quote_weekly_interpolated";
        continue;
      }

      if (prevPoint) {
        rateDay.nightly_rate = prevPoint.nightlyRate;
        rateDay.season_name = "quote_weekly_carry_forward";
        continue;
      }

      if (nextPoint) {
        rateDay.nightly_rate = nextPoint.nightlyRate;
        rateDay.season_name = "quote_weekly_backfill";
      }
    }

    const weeklyBaseSeeds = weeklyQuoteStarts.map(
      (startDate) => sampledRatesByDate.get(startDate) ?? null,
    );
    const availableTaxPcts = Array.from(quoteOutcomes.values())
      .map((outcome) => {
        if (!outcome.quote || outcome.nights <= 0) {
          return null;
        }
        const baseTotal = Number(outcome.quote.subTotal);
        const taxesTotal = Number(outcome.quote.taxes);
        if (
          !Number.isFinite(baseTotal) ||
          baseTotal <= 0 ||
          !Number.isFinite(taxesTotal)
        ) {
          return null;
        }
        return taxesTotal / baseTotal;
      })
      .filter((value): value is number => value !== null && value >= 0);
    const defaultTaxPct = median(availableTaxPcts) ?? 0.12;

    const quoteObservations: RateQuoteObservation[] = weeklyQuoteStarts.map(
      (startDate, index) => {
        const outcome = quoteOutcomes.get(startDate) ?? {
          sampledAt: new Date().toISOString(),
          arrivalDate: startDate,
          departureDate: addDaysToIsoDate(startDate, targetQuoteNights),
          nights: targetQuoteNights,
          reason: "weekly cadence start unavailable for check-in",
          quote: null,
        };

        if (outcome.quote) {
          return createAvailableObservation({
            listingId: externalListingId,
            unitId,
            arrivalDate: outcome.arrivalDate,
            departureDate: outcome.departureDate,
            nights: outcome.nights,
            quote: outcome.quote,
            sampledAt: outcome.sampledAt,
          });
        }

        const interpolatedBaseNightly =
          interpolateValue(weeklyBaseSeeds, index) ??
          median(
            sampledRatesByDate.size > 0
              ? Array.from(sampledRatesByDate.values())
              : [],
          ) ??
          500;
        const pricing = createEstimatedPricing({
          baseNightly: interpolatedBaseNightly,
          nights: Math.max(1, outcome.nights),
          taxPctOfBase: defaultTaxPct,
        });

        return createUnavailableObservation({
          listingId: externalListingId,
          unitId,
          arrivalDate: outcome.arrivalDate,
          departureDate: outcome.departureDate,
          nights: outcome.nights,
          reason:
            outcome.reason ?? "weekly cadence start unavailable for check-in",
          sampledAt: outcome.sampledAt,
          pricing,
        });
      },
    );

    const advertisedNightlyRate = parseFirstNightlyRate([
      ...extracted.advertisedRateTexts,
      ...extracted.matchedNightlySnippets,
    ]);
    if (
      normalizedRateDays.every((day) => day.nightly_rate === null) &&
      advertisedNightlyRate !== null &&
      normalizedDays.length > 0
    ) {
      normalizedRateDays[0] = {
        date: normalizedDays[0]!.date,
        nightly_rate: advertisedNightlyRate,
        min_nights: normalizedDays[0]!.min_nights_required,
        is_booked: false,
        changeover_code: toTurnDayChangeoverCode(
          normalizedDays[0]!.status_code,
        ),
        season_name: "displayed_from_rate_fallback",
      };
    }
    const rateValues = normalizedRateDays
      .map((day) => day.nightly_rate)
      .filter((value): value is number => Number.isFinite(value));
    const minRate = rateValues.length ? Math.min(...rateValues) : null;
    const maxRate = rateValues.length ? Math.max(...rateValues) : null;
    const avgRate = rateValues.length
      ? Math.round(
          (rateValues.reduce((sum, value) => sum + value, 0) /
            rateValues.length) *
            100,
        ) / 100
      : null;

    const descriptionExpanded =
      propertyDescription || jsonLd.description || metaDescription || "";

    const bedrooms = parseFirstNumber(extracted.bedroomsText);
    const bedsFallback = parseFirstNumber(extracted.bedsText);
    const fullBaths = parseFirstNumber(extracted.fullBathsText) ?? 0;
    const halfBaths = parseFirstNumber(extracted.halfBathsText) ?? 0;
    const totalBaths =
      fullBaths > 0 || halfBaths > 0 ? fullBaths + halfBaths * 0.5 : null;
    const sleeps = parseFirstNumber(extracted.sleepsText);
    const parsedAddress = parseAddressFromTitle(h1 || propertyName || title);

    const profileCityState = parseCityState(shortAddress);
    const propertyProfile: DetailRecord360Blue["property_profile"] = {
      unit_id: extracted.unitId?.trim() || externalListingId,
      area: shortAddress,
      location: shortAddress,
      beds: bedrooms ?? bedsFallback,
      baths: totalBaths,
      sleeps,
      city: profileCityState.city,
      state: profileCityState.state,
    };

    const amenityList = dedupePreserveOrder(
      extracted.amenitiesItems.map((item) => stripHtml(item).slice(0, 200)),
    );
    const amenities: DetailRecord360Blue["amenities"] = {
      categories: {
        General: amenityList,
      },
      all: amenityList,
    };

    const htmlGalleryUrls = Array.from(
      html.matchAll(/<img[^>]+src="([^"]+)"[^>]*>/gi),
    )
      .map((match) => match[1] ?? "")
      .filter((value) =>
        /img\.trackhs\.com|track-pm\.s3\.amazonaws\.com/i.test(value),
      );
    const mediaUrls = dedupePreserveOrder(
      [...extracted.galleryUrls, ...htmlGalleryUrls]
        .map((url) => normalizeGalleryUrl(url))
        .filter(Boolean),
    );
    const mediaGallery: DetailRecord360Blue["media_gallery"] = {
      image_count: mediaUrls.length,
      image_urls: mediaUrls,
    };

    const directionsQuery = [parsedAddress, shortAddress]
      .filter(Boolean)
      .join(", ");
    const coordinates = extractLatLngFromHtml(html);
    const location: DetailRecord360Blue["location"] = {
      address: parsedAddress,
      location_label: shortAddress,
      directions_url: directionsQuery
        ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(directionsQuery)}`
        : "",
      directions_daddr: directionsQuery,
      latitude: coordinates.latitude,
      longitude: coordinates.longitude,
    };

    const description = descriptionExpanded;
    const descriptionNormalized = normalizeForMatch(description);
    const name = h1 || jsonLd.name || title;
    const titleNormalized = normalizeForMatch(name);

    const htmlPath = resolve(
      OUTPUT_DETAILS_HTML_DIR,
      `${externalListingId}.html`,
    );
    await writeFile(htmlPath, `${html}\n`, "utf8");

    await mkdir(OUTPUT_DETAILS_QUOTES_DIR, { recursive: true });
    const quoteObservationsPath = resolve(
      OUTPUT_DETAILS_QUOTES_DIR,
      `${externalListingId}.json`,
    );
    const quoteSidecar: BlueQuoteSidecar = {
      adapter_key: "360blue",
      external_listing_id: externalListingId,
      detail_url: detailUrl,
      captured_at: new Date().toISOString(),
      currency: "USD",
      quote_window_cadence: "weekly_sat_to_sat",
      quote_window_gap_policy: "record_unavailable_without_date_shift",
      quote_window_anchor_date: firstSaturdayOnOrAfter(todayIso),
      quote_window_days: ratesWindowDays,
      quote_sample_step_days: ratesSampleStepDays,
      quote_nights: targetQuoteNights,
      quote_max_queries: effectiveRatesMaxQueries,
      endpoint_path: "/api/nrbe/reservation-quotes.json",
      observations: quoteObservations,
    };
    assertCanonicalQuotesSidecarRecord(quoteSidecar);
    await writeFile(
      quoteObservationsPath,
      `${JSON.stringify(quoteSidecar, null, 2)}\n`,
      "utf8",
    );

    const quoteWindows = quoteObservations
      .filter((observation) => observation.quote_available)
      .map((observation) => ({
        arrival_date: observation.check_in_date,
        departure_date: observation.check_out_date,
        nights: observation.nights,
        subtotal: observation.base_total ?? 0,
        total: observation.grand_total ?? observation.quoted_total ?? 0,
      }));

    const extractionMs = Date.now() - extractionStartedAt;
    const totalMs = Date.now() - fetchStartedAt;
    const quoteContext: DetailRecord360Blue["quote_context"] = {
      unit_id: propertyProfile.unit_id,
      cart_create_endpoint: BLUE360_CART_CREATE_ENDPOINT,
    };

    return {
      external_listing_id: externalListingId,
      detail_url: detailUrl,
      fetched_at: new Date().toISOString(),
      title,
      h1,
      canonical_url: canonicalUrl,
      meta_description: metaDescription,
      json_ld_name: jsonLd.name,
      json_ld_description: jsonLd.description,
      description_expanded: descriptionExpanded,
      rooms_guidance: false,
      amenities,
      location,
      media_gallery: mediaGallery,
      property_profile: propertyProfile,
      quote_context: quoteContext,
      normalized_availability: normalizedAvailability,
      normalized_rates: {
        source: "pm_360blue",
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
        advertised_rate_texts: extracted.advertisedRateTexts,
        matched_nightly_snippets: extracted.matchedNightlySnippets,
        observations_count: quoteObservations.length,
        observations_path: quoteObservationsPath,
        observations: [],
        quote_windows_count: quoteWindows.length,
        quote_windows_path: quoteObservationsPath,
        quote_windows: [],
      },
      normalized_matching_profile: {
        source: "pm_360blue",
        external_listing_id: externalListingId,
        name,
        description,
        match_signals: {
          description_normalized: descriptionNormalized,
          description_sha256: hashSha256(descriptionNormalized),
          title_normalized: titleNormalized,
          title_sha256: hashSha256(titleNormalized),
          listing_composite_key: [
            "pm_360blue",
            externalListingId,
            hashSha256(descriptionNormalized),
            hashSha256(titleNormalized),
          ].join("::"),
        },
      },
      html_path: htmlPath,
      body_text_excerpt: bodyText.slice(0, 25000),
      scrape_metrics: {
        total_ms: totalMs,
        page_load_and_expand_ms: pageLoadAndExpandMs,
        extraction_ms: extractionMs,
        calendar_pagination_clicks: calendarPageClicks,
        calendar_iterations: calendarIterationsUsed,
      },
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    reportDetailProgress?.(
      `detail ${externalListingId} fetchDetail failed: ${message}`,
    );
    return null;
  } finally {
    await page.close();
  }
}

export function create360BlueAdapter(): ScraperAdapter<DetailRecord360Blue> {
  return {
    managerKey: "360blue",
    scriptLabel: "360blue",
    defaultAnchorUrl: DEFAULT_ANCHOR_URL,
    detailFetchDelayMs: Math.max(
      0,
      Number(process.env.BLUE360_DETAIL_FETCH_DELAY_MS ?? "150") || 150,
    ),
    detailFetchConcurrency: Math.max(
      1,
      Number(process.env.BLUE360_DETAIL_FETCH_CONCURRENCY ?? "4") || 4,
    ),
    availabilityHorizonDays: Math.max(
      1,
      Number(process.env.BLUE360_AVAILABILITY_HORIZON_DAYS ?? "730") || 730,
    ),
    maxCalendarAdvanceMonths: Math.max(
      6,
      Number(process.env.BLUE360_CALENDAR_MAX_MONTHS ?? "26") || 26,
    ),
    isValidDetailUrl(value: string): string | null {
      return toValidDetailUrl(value);
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
        context.mode,
        context.existingDetailJsonPath,
        context.reportDetailProgress,
      );
    },
    async runQuoteCapture(argv, progress) {
      const normalizedArgs = await normalizeAdapterQuoteScopeArgs(
        "360blue",
        argv,
      );
      await runRuntimeAdapterQuoteCli(
        {
          adapterKey: "360blue",
          executeSingleQuote: execute360BlueSingleQuote,
          maxAttemptsEnvVar: "BLUE360_RATE_QUOTE_MAX_ATTEMPTS",
          defaultQuoteTimeoutMs: 12000,
          defaultQuoteMaxAttempts: 2,
          defaultEndpointPath: "/api/nrbe/reservation-quotes.json",
          defaultTaxPct: 0.12,
          defaultBaseNightly: 500,
        },
        normalizedArgs,
        progress,
      );
    },
  };
}
