import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { Browser, Page } from "playwright";

import {
  assertCanonicalQuotesSidecarRecord,
  type CanonicalQuoteObservation,
  type CanonicalQuotesSidecarRecord,
} from "@/lib/pricing/contracts/quote-observations-contract";
import { executeHomeownerscollection30aSingleQuote } from "@/lib/pricing/quote-runtime/adapters/homeownerscollection30a";
import { runRuntimeAdapterQuoteCli } from "@/lib/pricing/quotes/shared/runtime-adapter-quote-runner";
import { normalizeAdapterQuoteScopeArgs } from "../quote-scope";

import type { DetailRecordBase, ScrapedLink, ScraperAdapter } from "../types";

type LuxuryDayCode = "A" | "U" | "I" | "O" | "X";

type HomeownersFeeLine = {
  name: string;
  amount: number;
};

type HomeownersRateObservation = {
  start_date: string;
  end_date: string;
  nights: number;
  quote_available: boolean;
  quoted_total: number | null;
  buy_url: string | null;
  base_total: number | null;
  taxes_total: number | null;
  fees_total_excl_taxes: number | null;
  fee_lines: HomeownersFeeLine[];
  grand_total: number | null;
  nightly_rate_proxy: number | null;
  discount_name: string | null;
  reliability:
    | "buy_page_charges"
    | "rcapi_total_proxy"
    | "unavailable"
    | "parse_failed";
};

type LuxuryDetailRecord = DetailRecordBase & {
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
  quote_context: {
    source: "detail_html_and_rcapi";
    entity_id: number | null;
    detail_url: string;
    quote_coupon: string;
  };
  normalized_matching_profile: {
    source: "pm_homeownerscollection30a";
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
    source: "pm_homeownerscollection30a";
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
      status_code: LuxuryDayCode;
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
    source: "pm_homeownerscollection30a";
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
      changeover_code: LuxuryDayCode;
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
    endpoint_path: "/rcapi/item/avail/search";
    quote_window_days: number;
    quote_sample_step_days: number;
    quote_nights: number;
    quote_max_queries: number;
    quote_coupon: string;
    observations_count: number;
    observations_path: string | null;
    observations: HomeownersRateObservation[];
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
  "https://homeownerscollection.com/seaside-vacation-rentals#q=*%3A*";
const EXPECTED_LISTING_COUNT = 208;
const OUTPUT_ROOT = resolve(
  process.cwd(),
  "src",
  "lib",
  "data",
  "external-sources",
  "homeownerscollection30a",
);
const OUTPUT_DETAILS_HTML_DIR = resolve(OUTPUT_ROOT, "details", "html");
const OUTPUT_DETAILS_QUOTES_DIR = resolve(OUTPUT_ROOT, "details", "quotes");

const HOMEOWNERS_ORIGIN = "https://homeownerscollection.com";
const HOMEOWNERS_RCAPI_PATH = "/rcapi/item/avail/search";

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

function medianNumber(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return roundCurrency((sorted[middle - 1]! + sorted[middle]!) / 2);
  }
  return roundCurrency(sorted[middle]!);
}

function toCanonicalHomeownersObservation(input: {
  observation: HomeownersRateObservation;
  externalListingId: string;
  capturedAtIso: string;
  currency: string;
  fallbackBaseNightly: number;
}): CanonicalQuoteObservation {
  const { observation, externalListingId, capturedAtIso, currency } = input;

  const baseNightly =
    observation.nightly_rate_proxy && observation.nightly_rate_proxy > 0
      ? roundCurrency(observation.nightly_rate_proxy)
      : input.fallbackBaseNightly;
  const baseTotal =
    observation.base_total && observation.base_total > 0
      ? roundCurrency(observation.base_total)
      : roundCurrency(baseNightly * observation.nights);
  const taxesTotal = Math.max(0, roundCurrency(observation.taxes_total ?? 0));
  const feesTotal = Math.max(
    0,
    roundCurrency(observation.fees_total_excl_taxes ?? 0),
  );
  const grandTotal =
    observation.grand_total && observation.grand_total > 0
      ? roundCurrency(observation.grand_total)
      : roundCurrency(baseTotal + taxesTotal + feesTotal);
  const quotedTotal =
    observation.quoted_total && observation.quoted_total > 0
      ? roundCurrency(observation.quoted_total)
      : grandTotal;
  const allInNightly =
    observation.nights > 0
      ? roundCurrency(grandTotal / observation.nights)
      : roundCurrency(grandTotal);

  const feePctOfBase = baseTotal > 0 ? roundCurrency(feesTotal / baseTotal) : 0;
  const taxPctOfBase =
    baseTotal > 0 ? roundCurrency(taxesTotal / baseTotal) : 0;
  const nonBasePctOfTotal =
    quotedTotal > 0 ? roundCurrency((taxesTotal + feesTotal) / quotedTotal) : 0;
  const allInMultiplier =
    baseTotal > 0 ? roundCurrency(quotedTotal / baseTotal) : 1;

  return {
    sampled_at: capturedAtIso,
    captured_at: capturedAtIso,
    source_listing_id: externalListingId,
    currency,
    start_date: observation.start_date,
    end_date: observation.end_date,
    check_in_date: observation.start_date,
    check_out_date: observation.end_date,
    nights: observation.nights,
    base_nightly: baseNightly,
    all_in_nightly: allInNightly,
    quote_available: observation.quote_available,
    quote_unavailable_reason: observation.quote_available
      ? null
      : "Dates unavailable for selected stay window",
    base_total: baseTotal,
    taxes_total: taxesTotal,
    fees_total_excl_taxes: feesTotal,
    fee_lines: observation.fee_lines,
    grand_total: grandTotal,
    quoted_total: quotedTotal,
    fee_pct_of_base: feePctOfBase,
    tax_pct_of_base: taxPctOfBase,
    non_base_pct_of_total: nonBasePctOfTotal,
    all_in_multiplier: allInMultiplier,
    handoff_url: observation.buy_url,
    source: "quote_api",
  };
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function addDaysToIsoDate(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime())) {
    return isoDate;
  }
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function toUsDate(isoDate: string): string {
  const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return isoDate;
  }
  return `${match[2]}/${match[3]}/${match[1]}`;
}

function parseUsdAmountFromText(value: string): number | null {
  const matches = Array.from(value.matchAll(/\$([0-9][0-9,]*\.[0-9]{2})/g));
  const match = matches[matches.length - 1];
  if (!match?.[1]) {
    return null;
  }
  const parsed = Number((match[1] ?? "").replace(/,/g, ""));
  return Number.isFinite(parsed) ? roundCurrency(parsed) : null;
}

function decodeMinimalEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function nextUpcomingSaturdayIso(fromIsoDate: string): string {
  const date = new Date(`${fromIsoDate}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime())) {
    return fromIsoDate;
  }
  const day = date.getUTCDay();
  const delta = (6 - day + 7) % 7;
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function toUtcMidnightMs(isoDate: string): number {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) ? date.getTime() : 0;
}

function extractEntityIdFromHtml(html: string): number | null {
  const patterns = [
    /rcav%5Beid%5D=(\d+)/i,
    /[?&]eid=(\d+)(?:&|"|')/i,
    /["']eid["']\s*:\s*(\d+)/i,
    /["']eid["']\s*:\s*["'](\d+)["']/i,
    /eid\\"\s*:\s*\\"(\d+)\\"/i,
    /\/rescms\/item\/(\d+)\/buy/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (!match?.[1]) {
      continue;
    }
    const parsed = Number(match[1]);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return null;
}

function normalizeLink(url: string): string {
  return url.split("#")[0]?.replace(/\/$/, "") ?? url;
}

function normalizeDetailUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`.replace(/\/$/, "");
  } catch {
    return normalizeLink(url);
  }
}

function isLikelyDetailPath(pathname: string): boolean {
  const normalizedPath = pathname.toLowerCase().replace(/\/+$/, "");
  if (!normalizedPath.startsWith("/seaside-vacation-rentals/")) {
    return false;
  }

  const slug = normalizedPath.split("/").filter(Boolean).at(-1) ?? "";
  if (
    !slug ||
    slug === "seaside-vacation-rentals" ||
    slug === "search-results" ||
    slug === "results"
  ) {
    return false;
  }

  return /^[a-z0-9][a-z0-9-]*$/i.test(slug);
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
    const parsed = new URL(cleaned);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "";
  }
}

function extractFieldLocationFromHtml(html: string): {
  street: string;
  latitude: number | null;
  longitude: number | null;
} {
  const fieldLocationChunkMatch = html.match(
    /["']field_location["']\s*:\s*\{[\s\S]*?\}\s*,\s*["']field_teaser_image["']/i,
  );
  const fieldLocationChunk = fieldLocationChunkMatch
    ? fieldLocationChunkMatch[0]
    : html;

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

  return {
    street,
    latitude: Number.isFinite(latitude) ? latitude : null,
    longitude: Number.isFinite(longitude) ? longitude : null,
  };
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

type BuyPageChargeSummary = {
  base_total: number | null;
  taxes_total: number | null;
  fees_total_excl_taxes: number | null;
  fee_lines: HomeownersFeeLine[];
  grand_total: number | null;
};

function parseBuyPageChargeSummary(html: string): BuyPageChargeSummary | null {
  const wrapperMatch = html.match(
    /<div id="charges-wrapper"[\s\S]*?<\/fieldset>\s*<\/div>/i,
  );
  const wrapper = wrapperMatch?.[0] ?? "";
  if (!wrapper) {
    return null;
  }

  const feeLines: HomeownersFeeLine[] = [];
  let baseTotal: number | null = null;
  let taxesTotal: number | null = null;
  let grandTotal: number | null = null;

  const rows = wrapper.matchAll(/<tr class="([^"]*)">([\s\S]*?)<\/tr>/gi);
  for (const row of rows) {
    const rowClass = (row[1] ?? "").toLowerCase();
    const rowHtml = row[2] ?? "";
    const amount = parseUsdAmountFromText(rowHtml);
    if (amount === null) {
      continue;
    }

    const text = decodeMinimalEntities(stripHtml(rowHtml));
    const normalizedText = text.toLowerCase();

    if (rowClass.includes("line-item")) {
      if (normalizedText.includes("lodging:")) {
        baseTotal = amount;
        continue;
      }

      const feeName = text
        .replace(/you save\s+\$[0-9,]+\.[0-9]{2}/gi, "")
        .replace(/show details \+/gi, "")
        .replace(/hide details -/gi, "")
        .replace(/i accept this charge/gi, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120);

      if (feeName) {
        feeLines.push({ name: feeName, amount });
      }
      continue;
    }

    if (rowClass.includes("tax")) {
      taxesTotal = amount;
      continue;
    }

    if (rowClass.includes("total") && !rowClass.includes("sub-total")) {
      grandTotal = amount;
    }
  }

  const feesTotalExclTaxes =
    feeLines.length > 0
      ? roundCurrency(feeLines.reduce((sum, line) => sum + line.amount, 0))
      : null;

  return {
    base_total: baseTotal,
    taxes_total: taxesTotal,
    fees_total_excl_taxes: feesTotalExclTaxes,
    fee_lines: feeLines,
    grand_total: grandTotal,
  };
}

type RcapiPriceNode = {
  p?: string;
  c?: string;
  dn?: string | null;
  qp?: {
    rcav?: {
      begin?: string;
      end?: string;
      adult?: string;
      child?: string;
      eid?: string;
      coupon?: string;
      IDs?: Record<string, string[]>;
    };
    special_data?: {
      processor?: string;
      special_nid?: string;
    };
    eid?: number;
  };
};

type RcapiSearchItem = {
  eid?: number;
  prices?: RcapiPriceNode[];
};

function buildBuyUrlFromQuote(
  fallbackEid: number,
  fallbackBeginIso: string,
  fallbackEndIso: string,
  quoteNode: RcapiPriceNode | null,
): string | null {
  const params = new URLSearchParams();
  const qp = quoteNode?.qp;
  const rcav = qp?.rcav;

  const begin = rcav?.begin?.trim() || toUsDate(fallbackBeginIso);
  const end = rcav?.end?.trim() || toUsDate(fallbackEndIso);
  const adult = rcav?.adult?.trim() || "1";
  const child = rcav?.child?.trim() || "0";
  const eidRaw = rcav?.eid?.trim() || String(qp?.eid ?? fallbackEid);
  const coupon = rcav?.coupon?.trim() ?? "";

  params.set("rcav[begin]", begin);
  params.set("rcav[end]", end);
  params.set("rcav[adult]", adult);
  params.set("rcav[child]", child);
  params.set("rcav[eid]", eidRaw);
  params.set("rcav[coupon]", coupon);

  if (rcav?.IDs && typeof rcav.IDs === "object") {
    for (const [key, values] of Object.entries(rcav.IDs)) {
      for (const value of values ?? []) {
        if (typeof value === "string" && value.trim()) {
          params.append(`rcav[IDs][${key}][]`, value.trim());
        }
      }
    }
  }

  if (qp?.special_data?.processor) {
    params.set("special_data[processor]", qp.special_data.processor);
  }
  if (qp?.special_data?.special_nid) {
    params.set("special_data[special_nid]", qp.special_data.special_nid);
  }

  params.set("eid", eidRaw);
  return `${HOMEOWNERS_ORIGIN}/rescms/item/${eidRaw}/buy?${params.toString()}`;
}

async function fetchRcapiQuote(
  eid: number,
  checkInIso: string,
  checkOutIso: string,
  couponCode: string,
  referer: string,
): Promise<{
  quote_available: boolean;
  currency: string;
  quoted_total: number | null;
  discount_name: string | null;
  quote_node: RcapiPriceNode | null;
}> {
  const params = new URLSearchParams();
  params.set("rcav[begin]", toUsDate(checkInIso));
  params.set("rcav[end]", toUsDate(checkOutIso));
  params.set("rcav[adult]", "1");
  params.set("rcav[child]", "0");
  params.set("rcav[eid]", String(eid));
  params.set("rcav[coupon]", couponCode);
  params.set("rcav[flex]", "");
  params.set("rcav[flex_type]", "d");

  const url = `${HOMEOWNERS_ORIGIN}${HOMEOWNERS_RCAPI_PATH}?${params.toString()}`;
  const response = await fetch(url, {
    headers: {
      accept: "application/json, text/plain, */*",
      "x-requested-with": "XMLHttpRequest",
      referer,
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
    },
  });

  if (!response.ok) {
    return {
      quote_available: false,
      currency: "USD",
      quoted_total: null,
      discount_name: null,
      quote_node: null,
    };
  }

  const payload = (await response.json()) as unknown;
  const list = Array.isArray(payload) ? (payload as RcapiSearchItem[]) : [];
  const first = list[0];
  const priceNode = first?.prices?.[0] ?? null;
  const quotedTotalRaw = Number(priceNode?.p ?? "");
  const quotedTotal =
    Number.isFinite(quotedTotalRaw) && quotedTotalRaw > 0
      ? roundCurrency(quotedTotalRaw)
      : null;

  return {
    quote_available: quotedTotal !== null,
    currency: priceNode?.c?.trim() || "USD",
    quoted_total: quotedTotal,
    discount_name:
      typeof priceNode?.dn === "string" && priceNode.dn.trim().length > 0
        ? priceNode.dn.trim()
        : null,
    quote_node: priceNode,
  };
}

async function fetchBuyPageSummary(
  buyUrl: string,
  referer: string,
): Promise<BuyPageChargeSummary | null> {
  const response = await fetch(buyUrl, {
    headers: {
      accept: "text/html,application/xhtml+xml",
      referer,
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
    },
  });

  if (!response.ok) {
    return null;
  }

  const html = await response.text();
  return parseBuyPageChargeSummary(html);
}

function buildAvailabilityCounts(
  days: LuxuryDetailRecord["normalized_availability"]["days"],
): LuxuryDetailRecord["normalized_availability"]["counts"] {
  return {
    available: days.filter((day) => day.status_code === "A").length,
    unavailable: days.filter((day) => day.status_code === "U").length,
    checkin_only: days.filter((day) => day.status_code === "I").length,
    checkout_only: days.filter((day) => day.status_code === "O").length,
    other: days.filter((day) => day.status_code === "X").length,
    booking_available: days.filter(
      (day) => day.booking_day_state === "bookable",
    ).length,
    booking_unavailable: days.filter(
      (day) => day.booking_day_state === "blocked",
    ).length,
    booking_unknown: days.filter((day) => day.booking_day_state === "unknown")
      .length,
  };
}

async function buildWeeklyRateArtifacts(input: {
  externalListingId: string;
  detailUrl: string;
  entityId: number;
  availabilityDays: LuxuryDetailRecord["normalized_availability"]["days"];
  todayIso: string;
}): Promise<{
  availabilityDays: LuxuryDetailRecord["normalized_availability"]["days"];
  normalizedRates: LuxuryDetailRecord["normalized_rates"];
  ratesRaw: LuxuryDetailRecord["rates_raw"];
}> {
  const ratesWindowDays = Math.max(
    112,
    Number(process.env.HOMEOWNERSCOLLECTION30A_RATES_WINDOW_DAYS ?? "168") ||
      168,
  );
  const ratesSampleStepDays = Math.max(
    7,
    Number(process.env.HOMEOWNERSCOLLECTION30A_RATES_SAMPLE_STEP_DAYS ?? "7") ||
      7,
  );
  const quoteNights = Math.max(
    7,
    Number(process.env.HOMEOWNERSCOLLECTION30A_RATES_QUOTE_NIGHTS ?? "7") || 7,
  );
  const ratesMaxQueries = Math.max(
    1,
    Number(process.env.HOMEOWNERSCOLLECTION30A_RATES_MAX_QUERIES ?? "24") || 24,
  );
  const quoteCoupon =
    process.env.HOMEOWNERSCOLLECTION30A_RATES_QUOTE_COUPON ?? "INVALIDCODE";

  const ratesStartIso = nextUpcomingSaturdayIso(input.todayIso);
  const ratesWindowEndIso = addDaysToIsoDate(
    ratesStartIso,
    ratesWindowDays - 1,
  );

  const windowDates = Array.from({ length: ratesWindowDays }, (_, index) =>
    addDaysToIsoDate(ratesStartIso, index),
  );

  const availabilityByDate = new Map<
    string,
    LuxuryDetailRecord["normalized_availability"]["days"][number]
  >();
  for (const day of input.availabilityDays) {
    availabilityByDate.set(day.date, { ...day });
  }
  for (const date of windowDates) {
    if (availabilityByDate.has(date)) {
      continue;
    }
    availabilityByDate.set(date, {
      date,
      status_code: "X",
      is_available: false,
      is_available_for_checkin: false,
      is_available_for_checkout: false,
      booking_day_state: "unknown",
      min_nights_required: null,
    });
  }

  const normalizedRateDays: LuxuryDetailRecord["normalized_rates"]["days"] =
    windowDates.map((date) => {
      const day = availabilityByDate.get(date);
      const statusCode = day?.status_code ?? "X";
      const isBooked =
        statusCode === "A" || statusCode === "O"
          ? false
          : statusCode === "U" || statusCode === "I"
            ? true
            : null;

      return {
        date,
        nightly_rate: null,
        min_nights: day?.min_nights_required ?? null,
        is_booked: isBooked,
        changeover_code: statusCode,
        season_name:
          statusCode === "U" || statusCode === "I"
            ? "not_available"
            : "quote_pending",
      };
    });

  const sampleStartDates: string[] = [];
  for (
    let cursor = ratesStartIso;
    cursor <= ratesWindowEndIso && sampleStartDates.length < ratesMaxQueries;
    cursor = addDaysToIsoDate(cursor, ratesSampleStepDays)
  ) {
    sampleStartDates.push(cursor);
  }

  const observations: HomeownersRateObservation[] = [];
  const sampledRatesByDate = new Map<string, number>();
  let currency = "USD";

  for (const startDate of sampleStartDates) {
    const availabilityDay = availabilityByDate.get(startDate);
    if (!availabilityDay) {
      continue;
    }

    const endDate = addDaysToIsoDate(startDate, quoteNights);
    const quote = await fetchRcapiQuote(
      input.entityId,
      startDate,
      endDate,
      quoteCoupon,
      input.detailUrl,
    );
    currency = quote.currency || currency;

    if (!quote.quote_available) {
      const unavailableBuyUrl = buildBuyUrlFromQuote(
        input.entityId,
        startDate,
        endDate,
        quote.quote_node,
      );

      availabilityDay.status_code = "U";
      availabilityDay.is_available = false;
      availabilityDay.is_available_for_checkin = false;
      availabilityDay.is_available_for_checkout = false;
      availabilityDay.booking_day_state = "blocked";

      observations.push({
        start_date: startDate,
        end_date: endDate,
        nights: quoteNights,
        quote_available: false,
        quoted_total: null,
        buy_url: unavailableBuyUrl,
        base_total: null,
        taxes_total: null,
        fees_total_excl_taxes: null,
        fee_lines: [],
        grand_total: null,
        nightly_rate_proxy: null,
        discount_name: quote.discount_name,
        reliability: "unavailable",
      });
      continue;
    }

    const buyUrl = buildBuyUrlFromQuote(
      input.entityId,
      startDate,
      endDate,
      quote.quote_node,
    );

    const buySummary = buyUrl
      ? await fetchBuyPageSummary(buyUrl, input.detailUrl)
      : null;

    const baseTotal =
      buySummary?.base_total ??
      (quote.quoted_total !== null ? roundCurrency(quote.quoted_total) : null);
    const nightlyRateProxy =
      baseTotal !== null && quoteNights > 0
        ? roundCurrency(baseTotal / quoteNights)
        : null;

    if (nightlyRateProxy !== null) {
      sampledRatesByDate.set(startDate, nightlyRateProxy);
      availabilityDay.status_code = "A";
      availabilityDay.is_available = true;
      availabilityDay.is_available_for_checkin = true;
      availabilityDay.is_available_for_checkout = true;
      availabilityDay.booking_day_state = "bookable";
    }

    observations.push({
      start_date: startDate,
      end_date: endDate,
      nights: quoteNights,
      quote_available: true,
      quoted_total: quote.quoted_total,
      buy_url: buyUrl,
      base_total: baseTotal,
      taxes_total: buySummary?.taxes_total ?? null,
      fees_total_excl_taxes: buySummary?.fees_total_excl_taxes ?? null,
      fee_lines: buySummary?.fee_lines ?? [],
      grand_total: buySummary?.grand_total ?? null,
      nightly_rate_proxy: nightlyRateProxy,
      discount_name: quote.discount_name,
      reliability:
        buySummary && buySummary.base_total !== null
          ? "buy_page_charges"
          : quote.quoted_total !== null
            ? "rcapi_total_proxy"
            : "parse_failed",
    });
  }

  const sampledPoints = Array.from(sampledRatesByDate.entries())
    .map(([date, nightlyRate]) => ({
      date,
      nightlyRate,
      ts: toUtcMidnightMs(date),
    }))
    .sort((left, right) => left.ts - right.ts);

  const sampledRateValues = sampledPoints.map((point) => point.nightlyRate);
  const fallbackDerivedNightly =
    medianNumber(sampledRateValues) ??
    roundCurrency(
      Math.max(
        1,
        Number(
          process.env.HOMEOWNERSCOLLECTION30A_RATES_DERIVED_NIGHTLY_DEFAULT ??
            "650",
        ) || 650,
      ),
    );

  for (const day of normalizedRateDays) {
    const availability = availabilityByDate.get(day.date);
    const isAvailable = availability ? availability.is_available : false;
    const isUnknownAvailability = (availability?.status_code ?? "X") === "X";
    day.changeover_code = availability?.status_code ?? day.changeover_code;
    day.min_nights = availability?.min_nights_required ?? day.min_nights;
    day.is_booked =
      availability?.status_code === "A" || availability?.status_code === "O"
        ? false
        : availability?.status_code === "U" || availability?.status_code === "I"
          ? true
          : null;

    if (!isAvailable && !isUnknownAvailability) {
      day.season_name = "not_available";
      continue;
    }

    const sampled = sampledRatesByDate.get(day.date);
    if (typeof sampled === "number") {
      day.nightly_rate = sampled;
      day.season_name = "quote_weekly_sample";
      continue;
    }

    if (sampledPoints.length === 0) {
      day.nightly_rate = fallbackDerivedNightly;
      day.season_name = "quote_derived_default";
      continue;
    }

    const ts = toUtcMidnightMs(day.date);
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
      day.nightly_rate = roundCurrency(
        prevPoint.nightlyRate +
          (nextPoint.nightlyRate - prevPoint.nightlyRate) * ratio,
      );
      day.season_name = "quote_weekly_interpolated";
      continue;
    }

    if (prevPoint) {
      day.nightly_rate = prevPoint.nightlyRate;
      day.season_name = "quote_weekly_carry_forward";
      continue;
    }

    if (nextPoint) {
      day.nightly_rate = nextPoint.nightlyRate;
      day.season_name = "quote_weekly_backfill";
      continue;
    }

    day.nightly_rate = fallbackDerivedNightly;
    day.season_name = "quote_derived_default";
  }

  const collectedRates = normalizedRateDays
    .map((day) => day.nightly_rate)
    .filter((value): value is number => Number.isFinite(value));

  const updatedAvailabilityDays = input.availabilityDays.map((day) => {
    const updated = availabilityByDate.get(day.date);
    return updated ? updated : day;
  });

  const seenAvailabilityDates = new Set(
    updatedAvailabilityDays.map((day) => day.date),
  );
  for (const date of windowDates) {
    if (seenAvailabilityDates.has(date)) {
      continue;
    }
    const candidate = availabilityByDate.get(date);
    if (!candidate) {
      continue;
    }
    updatedAvailabilityDays.push(candidate);
    seenAvailabilityDates.add(date);
  }
  updatedAvailabilityDays.sort((left, right) =>
    left.date.localeCompare(right.date),
  );

  return {
    availabilityDays: updatedAvailabilityDays,
    normalizedRates: {
      source: "pm_homeownerscollection30a",
      external_listing_id: input.externalListingId,
      captured_at: new Date().toISOString(),
      currency,
      window_start: normalizedRateDays[0]?.date ?? "",
      window_end: normalizedRateDays[normalizedRateDays.length - 1]?.date ?? "",
      days: normalizedRateDays,
      stats: {
        days_with_rate: collectedRates.length,
        min_nightly_rate:
          collectedRates.length > 0 ? Math.min(...collectedRates) : null,
        max_nightly_rate:
          collectedRates.length > 0 ? Math.max(...collectedRates) : null,
        avg_nightly_rate:
          collectedRates.length > 0
            ? roundCurrency(
                collectedRates.reduce((sum, value) => sum + value, 0) /
                  collectedRates.length,
              )
            : null,
      },
    },
    ratesRaw: {
      endpoint_path: "/rcapi/item/avail/search",
      quote_window_days: ratesWindowDays,
      quote_sample_step_days: ratesSampleStepDays,
      quote_nights: quoteNights,
      quote_max_queries: ratesMaxQueries,
      quote_coupon: quoteCoupon,
      observations_count: observations.length,
      observations_path: null,
      observations,
    },
  };
}

async function installEvaluateNameShim(page: Page): Promise<void> {
  const shim = "window.__name = window.__name || ((target) => target);";
  await page.addInitScript(shim);
  await page.evaluate(shim);
}

async function clickTab(page: Page, tabText: string): Promise<boolean> {
  const target = tabText.toLowerCase();
  const result = await page.evaluate((targetText) => {
    const nodes = Array.from(
      document.querySelectorAll("a, button, [role='tab'], [role='button']"),
    );

    for (const node of nodes) {
      const element = node as HTMLElement;
      if (element.offsetParent === null) {
        continue;
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
  }, target);

  if (result) {
    await page.waitForTimeout(900);
  }
  return result;
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

  const readDiscoverySnapshot = async (): Promise<{
    rows: Array<{ href: string; text: string }>;
    expectedCount: number | null;
  }> =>
    page.evaluate(() => {
      const rows: Array<{ href: string; text: string }> = [];
      const seen = new Set<string>();

      const toNormalized = (hrefValue: string): string => {
        try {
          const absolute = new URL(hrefValue, window.location.origin);
          if (!absolute.hostname.endsWith("homeownerscollection.com")) {
            return "";
          }

          const normalizedPath = absolute.pathname
            .toLowerCase()
            .replace(/\/+$/, "");
          if (!normalizedPath.startsWith("/seaside-vacation-rentals/")) {
            return "";
          }

          const slug = normalizedPath.split("/").filter(Boolean).at(-1) ?? "";
          if (
            !slug ||
            slug === "seaside-vacation-rentals" ||
            slug === "search-results" ||
            slug === "results"
          ) {
            return "";
          }

          if (!/^[a-z0-9][a-z0-9-]*$/i.test(slug)) {
            return "";
          }

          return `${absolute.origin}${absolute.pathname}`.replace(/\/$/, "");
        } catch {
          return "";
        }
      };

      for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
        const hrefRaw =
          (anchor as HTMLAnchorElement).getAttribute("href") ?? "";
        if (!hrefRaw) {
          continue;
        }

        const normalized = toNormalized(hrefRaw);
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
    });

  let discovery = await readDiscoverySnapshot();
  let previousCount = discovery.rows.length;
  let stagnantSteps = 0;
  const effectiveScrollSteps = Math.max(8, maxScrollSteps);
  const effectivePauseMs = Math.max(350, Math.min(scrollPauseMs, 1200));

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
      discovery.rows.length >= discovery.expectedCount
    ) {
      reportProgress(
        `discovery reached expected count after scroll step ${step}: ${discovery.rows.length}/${discovery.expectedCount}`,
      );
      break;
    }

    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });
    await page.waitForTimeout(effectivePauseMs);

    discovery = await readDiscoverySnapshot();
    if (discovery.rows.length > previousCount) {
      reportProgress(
        `discovery grew to ${discovery.rows.length}${
          discovery.expectedCount ? `/${discovery.expectedCount}` : ""
        } at scroll step ${step + 1}`,
      );
      previousCount = discovery.rows.length;
      stagnantSteps = 0;
      continue;
    }

    stagnantSteps += 1;
    if (stagnantSteps >= 3) {
      break;
    }
  }

  if (discovery.expectedCount !== null) {
    reportProgress(
      `discovery final captured=${discovery.rows.length}/${discovery.expectedCount}`,
    );
  } else {
    reportProgress(`discovery final captured=${discovery.rows.length}`);
  }

  return discovery.rows.map((row) => ({
    link: normalizeDetailUrl(row.href),
    source_url: anchorUrl,
    anchor_text: row.text,
  }));
}

async function extractAvailabilitySnapshot(page: Page): Promise<{
  hasCalendarWidget: boolean;
  months: string[];
  items: Array<{ date: string; code: LuxuryDayCode }>;
  bookingRestrictions: string[];
}> {
  return page.evaluate(() => {
    const toIsoDate = (
      year: number,
      monthIndex: number,
      day: number,
    ): string => {
      const candidate = new Date(Date.UTC(year, monthIndex, day));
      if (
        candidate.getUTCFullYear() !== year ||
        candidate.getUTCMonth() !== monthIndex ||
        candidate.getUTCDate() !== day
      ) {
        return "";
      }
      return candidate.toISOString().slice(0, 10);
    };

    const parseMonthHeader = (
      value: string,
    ): { year: number; monthIndex: number } | null => {
      const cleaned = value.replace(/\s+/g, " ").trim();
      const match = cleaned.match(/^([A-Za-z]+)\s+(\d{4})$/);
      if (!match) {
        return null;
      }

      const months: Record<string, number> = {
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

      const monthIndex = months[(match[1] ?? "").toLowerCase()];
      const year = Number(match[2]);
      if (!Number.isFinite(monthIndex) || !Number.isFinite(year)) {
        return null;
      }

      return { year, monthIndex };
    };

    const items: Array<{ date: string; code: LuxuryDayCode }> = [];
    const monthHeaders: string[] = [];

    const groups = Array.from(
      document.querySelectorAll(
        ".group-availability .rc-calendar.rcav-month, .rc-calendar.rcav-month, .ui-datepicker-group, .ui-datepicker-calendar, [class*='datepicker-group']",
      ),
    );

    const visited = new Set<Element>();
    for (const group of groups) {
      const container =
        group.matches(".ui-datepicker-group") ||
        group.matches("[class*='datepicker-group']")
          ? group
          : (group.closest(
              ".ui-datepicker-group, [class*='datepicker-group']",
            ) ?? group);

      if (visited.has(container)) {
        continue;
      }
      visited.add(container);

      const monthLabel =
        container.querySelector("caption")?.textContent ??
        container.querySelector(".ui-datepicker-title")?.textContent ??
        container.querySelector(".month")?.textContent ??
        container.querySelector("h2, h3, h4")?.textContent ??
        "";

      const monthText = monthLabel.replace(/\s+/g, " ").trim();
      if (monthText) {
        monthHeaders.push(monthText);
      }

      let monthMeta = parseMonthHeader(monthText);
      if (!monthMeta) {
        const element = container as HTMLElement;
        const dataYear = Number(element.getAttribute("data-year") ?? "");
        const dataMonth = Number(element.getAttribute("data-month") ?? "");
        if (Number.isFinite(dataYear) && Number.isFinite(dataMonth)) {
          const normalizedMonth =
            dataMonth >= 1 && dataMonth <= 12 ? dataMonth - 1 : dataMonth;
          if (normalizedMonth >= 0 && normalizedMonth <= 11) {
            monthMeta = {
              year: Math.floor(dataYear),
              monthIndex: Math.floor(normalizedMonth),
            };
          }
        }
      }

      if (!monthMeta) {
        continue;
      }

      const dayCells = Array.from(
        container.querySelectorAll(
          "td.day, td[class*='av-'], .day.av-O, .day.av-X, .rc-calendar td",
        ),
      );

      for (const cell of dayCells) {
        const classBlob = String(
          (cell as HTMLElement).className || "",
        ).toLowerCase();
        if (!/\bav-/.test(classBlob)) {
          continue;
        }

        const dayText = (
          (cell.textContent ?? "").match(/\d{1,2}/)?.[0] ?? ""
        ).trim();
        const day = Number(dayText);
        if (!Number.isFinite(day) || day <= 0 || day > 31) {
          continue;
        }

        const date = toIsoDate(monthMeta.year, monthMeta.monthIndex, day);
        if (!date) {
          continue;
        }

        let code: LuxuryDayCode = "X";
        if (classBlob.includes("av-in")) {
          code = "I";
        } else if (classBlob.includes("av-out")) {
          code = "O";
        } else if (classBlob.includes("av-o")) {
          code = "A";
        } else if (classBlob.includes("av-x")) {
          code = "U";
        }

        items.push({ date, code });
      }
    }

    const keyText = Array.from(
      document.querySelectorAll(".rcav-key, .bre-ui-datepicker-extras, .label"),
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
        ".group-availability .rc-calendar.rcav-month, .rc-calendar.rcav-month, .ui-datepicker, .ui-datepicker-inline, .rcav-key",
      ),
      months: Array.from(new Set(monthHeaders)),
      items,
      bookingRestrictions: Array.from(new Set(keyText)).slice(0, 40),
    };
  });
}

async function extractDescriptionText(page: Page): Promise<string> {
  await clickTab(page, "Description");

  return page.evaluate(() => {
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
  });
}

async function fetchDetail(
  browser: Browser,
  detailUrl: string,
  availabilityHorizonDays: number,
  maxCalendarAdvanceMonths: number,
  refreshMode: "full" | "dynamic" | "static",
  existingDetailJsonPath?: string | null,
  reportDetailProgress?: (message: string) => void,
): Promise<LuxuryDetailRecord | null> {
  const logStage = (stage: string, message: string): void => {
    if (!reportDetailProgress) {
      return;
    }
    const listingId = extractExternalListingId(detailUrl);
    reportDetailProgress(
      `detail ${listingId} [mode=${refreshMode}] [${stage}] ${message}`,
    );
  };

  if (refreshMode === "dynamic" && existingDetailJsonPath) {
    try {
      logStage("DYNAMIC_BASELINE", "start");
      const existingRaw = await readFile(existingDetailJsonPath, "utf8");
      const existing = JSON.parse(existingRaw) as LuxuryDetailRecord;
      const externalListingId =
        existing.external_listing_id || extractExternalListingId(detailUrl);

      const now = new Date();
      const todayIso = now.toISOString().slice(0, 10);
      const horizonIso = addDaysToIsoDate(todayIso, availabilityHorizonDays);

      const availabilityDays =
        (existing.normalized_availability?.days ?? [])
          .filter((day) => isIsoDate(day.date))
          .filter((day) => day.date >= todayIso && day.date <= horizonIso)
          .map((day) => ({ ...day })) ?? [];

      if (availabilityDays.length === 0) {
        logStage(
          "DYNAMIC_BASELINE",
          "missing baseline availability; falling back to full pull",
        );
      } else {
        const htmlCandidates = [existing.html_path, existingDetailJsonPath]
          .filter((value): value is string => typeof value === "string")
          .map((value) =>
            isAbsolute(value) ? value : resolve(process.cwd(), value),
          )
          .slice(0, 2);

        let entityId: number | null = null;
        for (const candidate of htmlCandidates) {
          if (!candidate) {
            continue;
          }
          try {
            const raw = await readFile(candidate, "utf8");
            entityId = extractEntityIdFromHtml(raw);
            if (entityId) {
              break;
            }
          } catch {
            // Best-effort path only.
          }
        }

        if (!entityId) {
          const parsedFromUnitId = Number(existing.property_profile?.unit_id);
          if (Number.isFinite(parsedFromUnitId) && parsedFromUnitId > 0) {
            entityId = parsedFromUnitId;
          }
        }

        if (entityId) {
          logStage(
            "API_RATE_CALLS",
            `start eid=${entityId} availability_days=${availabilityDays.length}`,
          );
          const rateArtifacts = await buildWeeklyRateArtifacts({
            externalListingId,
            detailUrl,
            entityId,
            availabilityDays,
            todayIso,
          });

          logStage(
            "API_RATE_CALLS",
            `done observations=${rateArtifacts.ratesRaw.observations.length} priced_days=${rateArtifacts.normalizedRates.stats.days_with_rate}`,
          );

          return {
            ...existing,
            detail_url: detailUrl,
            external_listing_id: externalListingId,
            fetched_at: new Date().toISOString(),
            normalized_availability: {
              ...existing.normalized_availability,
              source: "pm_homeownerscollection30a",
              external_listing_id: externalListingId,
              captured_at: new Date().toISOString(),
              has_calendar_widget:
                existing.normalized_availability?.has_calendar_widget ?? true,
              booking_restrictions:
                existing.normalized_availability?.booking_restrictions ?? [],
              min_night_rules:
                existing.normalized_availability?.min_night_rules ?? [],
              window_start: rateArtifacts.availabilityDays[0]?.date ?? "",
              window_end:
                rateArtifacts.availabilityDays[
                  rateArtifacts.availabilityDays.length - 1
                ]?.date ?? "",
              code_legend: {
                A: "available",
                U: "unavailable",
                I: "checkin_only",
                O: "checkout_only",
                X: "other",
              },
              day_codes: rateArtifacts.availabilityDays
                .map((day) => day.status_code)
                .join(""),
              days: rateArtifacts.availabilityDays,
              counts: buildAvailabilityCounts(rateArtifacts.availabilityDays),
            },
            normalized_rates: rateArtifacts.normalizedRates,
            rates_raw: rateArtifacts.ratesRaw,
          };
        }

        logStage(
          "DYNAMIC_BASELINE",
          "missing entity id for quote API; falling back to full pull",
        );
      }
    } catch {
      logStage(
        "DYNAMIC_BASELINE",
        "unable to load baseline detail; falling back to full pull",
      );
    }
  }

  const startedAt = Date.now();
  const page = await browser.newPage();

  try {
    await installEvaluateNameShim(page);

    const beforeLoad = Date.now();
    await page.goto(detailUrl, {
      waitUntil: "domcontentloaded",
      timeout: 120000,
    });
    await page.waitForTimeout(1800);
    const pageLoadMs = Date.now() - beforeLoad;

    const extracted = await page.evaluate(() => {
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
          const heading = document.querySelector("h1");
          if (!heading) {
            return "";
          }

          const clone = heading.cloneNode(true) as HTMLElement;
          for (const nested of Array.from(
            clone.querySelectorAll(
              ".collapsible, .group-beds-baths-wrapper, .rc-lodging-detail",
            ),
          )) {
            nested.remove();
          }

          return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
        })(),
        canonical:
          document
            .querySelector("link[rel='canonical']")
            ?.getAttribute("href") ?? "",
        metaDescription: getMeta("description") || getMeta("og:description"),
        sleepsText:
          document.querySelector(".rc-lodging-occ")?.textContent?.trim() ?? "",
        bedroomsText:
          document.querySelector(".rc-lodging-beds")?.textContent?.trim() ?? "",
        bathroomsText:
          document.querySelector(".rc-lodging-baths")?.textContent?.trim() ??
          "",
        neighborhoodText:
          document
            .querySelector(".rc-core-cat-evrn_client_1 li")
            ?.textContent?.trim() ??
          document
            .querySelector(".rc-core-cat-evrn_client_1")
            ?.textContent?.trim() ??
          "",
        unitId:
          document
            .querySelector('[name="entity_id"][content], [data-entity-id]')
            ?.getAttribute("content")
            ?.trim() ??
          document
            .querySelector("[data-item-id], [data-id]")
            ?.getAttribute("data-item-id")
            ?.trim() ??
          "",
        entityIdText: (() => {
          const maybeWindow = window as unknown as {
            Drupal?: {
              settings?: {
                rcItemAvailForm?: Array<{
                  eid?: string | number;
                }>;
              };
            };
          };

          const fromSettings =
            maybeWindow.Drupal?.settings?.rcItemAvailForm?.[0]?.eid;
          if (
            typeof fromSettings === "number" &&
            Number.isFinite(fromSettings) &&
            fromSettings > 0
          ) {
            return String(fromSettings);
          }

          if (
            typeof fromSettings === "string" &&
            fromSettings.trim().length > 0
          ) {
            return fromSettings.trim();
          }

          return "";
        })(),
        amenitiesCategories: (() => {
          const categories: Record<string, string[]> = {};
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
          return categories;
        })(),
        galleryUrls: (() => {
          const urls: string[] = [];
          const mediaRoot =
            document.querySelector("#Media") ??
            document.querySelector('[id="media"]');
          if (!mediaRoot) {
            return urls;
          }

          const attrValues = Array.from(
            mediaRoot.querySelectorAll(
              "a[href], img[src], img[data-src], img[data-rsTmb], [data-rsBigImg], [data-image]",
            ),
          );

          for (const node of attrValues) {
            const attrs = [
              node.getAttribute("href"),
              node.getAttribute("src"),
              node.getAttribute("data-src"),
              node.getAttribute("data-rsTmb"),
              node.getAttribute("data-rsBigImg"),
              node.getAttribute("data-image"),
            ];
            for (const raw of attrs) {
              if (!raw) {
                continue;
              }
              try {
                const absolute = new URL(
                  raw,
                  window.location.origin,
                ).toString();
                if (
                  /\.(jpe?g|png|webp|gif)(\?|$)/i.test(absolute) ||
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
    });

    const descriptionText = (await extractDescriptionText(page)).slice(
      0,
      15000,
    );
    const descriptionExpanded = stripHtml(descriptionText).slice(0, 30000);

    await clickTab(page, "Availability");

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

    let calendarClicks = 0;
    let calendarIterations = 0;
    let stagnantIterations = 0;

    const now = new Date();
    const todayIso = now.toISOString().slice(0, 10);
    const horizon = new Date(now);
    horizon.setUTCDate(horizon.getUTCDate() + availabilityHorizonDays);
    const horizonIso = horizon.toISOString().slice(0, 10);

    for (
      let iteration = 0;
      iteration < Math.max(1, maxCalendarAdvanceMonths);
      iteration += 1
    ) {
      calendarIterations += 1;

      const snapshot = await extractAvailabilitySnapshot(page);
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

      const clickedNext = await page.evaluate(() => {
        const nodes = Array.from(
          document.querySelectorAll(
            "a.ui-datepicker-next, button.next, a.next, .rc-calendar-next, [class*='calendar'] .next, [class*='datepicker'] [title*='Next' i], [class*='datepicker'] [aria-label*='Next' i], button[title*='Next' i], a[title*='Next' i], button[aria-label*='Next' i], a[aria-label*='Next' i]",
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
      });

      if (!clickedNext) {
        break;
      }

      calendarClicks += 1;
      await page.waitForTimeout(750);
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
          status_code: code,
          is_available: code === "A" || code === "O",
          is_available_for_checkin: code === "A" || code === "I",
          is_available_for_checkout: code === "A" || code === "O",
          booking_day_state: bookingDayState,
          min_nights_required: null,
        };
      });

    const externalListingId = extractExternalListingId(detailUrl);
    const htmlPath = resolve(
      OUTPUT_DETAILS_HTML_DIR,
      `${externalListingId}.html`,
    );
    const html = await page.content();
    await writeFile(htmlPath, html, "utf8");

    const extractedEntityId = Number((extracted.entityIdText ?? "").trim());
    const entityId =
      Number.isFinite(extractedEntityId) && extractedEntityId > 0
        ? extractedEntityId
        : extractEntityIdFromHtml(html);
    const rateArtifacts = entityId
      ? await buildWeeklyRateArtifacts({
          externalListingId,
          detailUrl,
          entityId,
          availabilityDays: normalizedDays,
          todayIso,
        })
      : {
          availabilityDays: normalizedDays,
          normalizedRates: {
            source: "pm_homeownerscollection30a" as const,
            external_listing_id: externalListingId,
            captured_at: new Date().toISOString(),
            currency: "USD",
            window_start: "",
            window_end: "",
            days: [],
            stats: {
              days_with_rate: 0,
              min_nightly_rate: null,
              max_nightly_rate: null,
              avg_nightly_rate: null,
            },
          },
          ratesRaw: {
            endpoint_path: "/rcapi/item/avail/search" as const,
            quote_window_days: 0,
            quote_sample_step_days: 0,
            quote_nights: 0,
            quote_max_queries: 0,
            quote_coupon: "",
            observations_count: 0,
            observations_path: null,
            observations: [],
          },
        };

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
        items.map((item) => stripHtml(item).slice(0, 200)),
      );
      if (!cleanCategory || cleanItems.length === 0) {
        continue;
      }
      amenitiesCategories[cleanCategory] = cleanItems;
    }

    const amenitiesAll = dedupePreserveOrder(
      Object.values(amenitiesCategories).flat(),
    );
    const amenities: LuxuryDetailRecord["amenities"] = {
      categories: amenitiesCategories,
      all: amenitiesAll,
    };

    const mediaUrls = dedupePreserveOrder(
      extracted.galleryUrls
        .map((url) => normalizeGalleryUrl(url))
        .filter(Boolean),
    );
    const mediaGallery: LuxuryDetailRecord["media_gallery"] = {
      image_count: mediaUrls.length,
      image_urls: mediaUrls,
    };

    const streetAddress = stripHtml(locationPayload.street).slice(0, 240);
    const directionsQuery =
      streetAddress ||
      (locationPayload.latitude !== null && locationPayload.longitude !== null
        ? `${locationPayload.latitude},${locationPayload.longitude}`
        : "");

    const location: LuxuryDetailRecord["location"] = {
      address: streetAddress,
      location_label: neighborhood,
      directions_url: directionsQuery
        ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(directionsQuery)}`
        : "",
      directions_daddr: directionsQuery,
      latitude: locationPayload.latitude,
      longitude: locationPayload.longitude,
    };

    const listingName = normalizeListingName(
      extracted.h1 || extracted.title || externalListingId,
    );

    const normalizedMatchingProfile = {
      source: "pm_homeownerscollection30a" as const,
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

    await mkdir(OUTPUT_DETAILS_QUOTES_DIR, { recursive: true });
    const quoteObservationsPath = resolve(
      OUTPUT_DETAILS_QUOTES_DIR,
      `${externalListingId}.json`,
    );
    const sidecarCapturedAt = new Date().toISOString();
    const fallbackBaseNightly =
      medianNumber(
        rateArtifacts.normalizedRates.days
          .map((day) => day.nightly_rate)
          .filter(
            (value): value is number =>
              typeof value === "number" && Number.isFinite(value) && value > 0,
          ),
      ) ?? 1;
    const canonicalObservations = rateArtifacts.ratesRaw.observations.map(
      (observation) =>
        toCanonicalHomeownersObservation({
          observation,
          externalListingId,
          capturedAtIso: sidecarCapturedAt,
          currency: rateArtifacts.normalizedRates.currency || "USD",
          fallbackBaseNightly,
        }),
    );
    const quoteSidecar: CanonicalQuotesSidecarRecord = {
      adapter_key: "homeownerscollection30a",
      external_listing_id: externalListingId,
      detail_url: detailUrl,
      captured_at: sidecarCapturedAt,
      currency: rateArtifacts.normalizedRates.currency || "USD",
      quote_window_cadence: "weekly_sat_to_sat",
      quote_window_gap_policy: "record_unavailable_without_date_shift",
      quote_window_anchor_date: nextUpcomingSaturdayIso(
        sidecarCapturedAt.slice(0, 10),
      ),
      quote_window_days: rateArtifacts.ratesRaw.quote_window_days,
      quote_sample_step_days: rateArtifacts.ratesRaw.quote_sample_step_days,
      quote_nights: rateArtifacts.ratesRaw.quote_nights,
      quote_max_queries: rateArtifacts.ratesRaw.quote_max_queries,
      endpoint_path: rateArtifacts.ratesRaw.endpoint_path,
      quote_coupon: rateArtifacts.ratesRaw.quote_coupon,
      observations: canonicalObservations,
    };
    assertCanonicalQuotesSidecarRecord(quoteSidecar);
    await writeFile(
      quoteObservationsPath,
      `${JSON.stringify(quoteSidecar, null, 2)}\n`,
      "utf8",
    );

    const ratesRawSlim: LuxuryDetailRecord["rates_raw"] = {
      endpoint_path: rateArtifacts.ratesRaw.endpoint_path,
      quote_window_days: rateArtifacts.ratesRaw.quote_window_days,
      quote_sample_step_days: rateArtifacts.ratesRaw.quote_sample_step_days,
      quote_nights: rateArtifacts.ratesRaw.quote_nights,
      quote_max_queries: rateArtifacts.ratesRaw.quote_max_queries,
      quote_coupon: rateArtifacts.ratesRaw.quote_coupon,
      observations_count: rateArtifacts.ratesRaw.observations.length,
      observations_path: quoteObservationsPath,
      observations: [],
    };

    return {
      external_listing_id: externalListingId,
      detail_url: detailUrl,
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
      quote_context: {
        source: "detail_html_and_rcapi",
        entity_id: entityId ?? null,
        detail_url: detailUrl,
        quote_coupon:
          process.env.HOMEOWNERSCOLLECTION30A_RATES_QUOTE_COUPON ??
          "INVALIDCODE",
      },
      normalized_matching_profile: normalizedMatchingProfile,
      normalized_availability: {
        source: "pm_homeownerscollection30a",
        external_listing_id: externalListingId,
        captured_at: new Date().toISOString(),
        has_calendar_widget: rateArtifacts.availabilityDays.length > 0,
        booking_restrictions: Array.from(bookingRestrictions),
        min_night_rules: [],
        window_start: rateArtifacts.availabilityDays[0]?.date ?? "",
        window_end:
          rateArtifacts.availabilityDays[
            rateArtifacts.availabilityDays.length - 1
          ]?.date ?? "",
        code_legend: {
          A: "available",
          U: "unavailable",
          I: "checkin_only",
          O: "checkout_only",
          X: "other",
        },
        day_codes: rateArtifacts.availabilityDays
          .map((day) => day.status_code)
          .join(""),
        days: rateArtifacts.availabilityDays,
        counts: buildAvailabilityCounts(rateArtifacts.availabilityDays),
      },
      normalized_rates: rateArtifacts.normalizedRates,
      rates_raw: ratesRawSlim,
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
    console.warn(
      `[homeownerscollection30a] detail pull failed for ${detailUrl}: ${message}`,
    );
    return null;
  } finally {
    await page.close();
  }
}

export function createHomeownersCollection30AAdapter(): ScraperAdapter<LuxuryDetailRecord> {
  return {
    managerKey: "homeownerscollection30a",
    scriptLabel: "homeownerscollection30a",
    defaultAnchorUrl: DEFAULT_ANCHOR_URL,
    detailFetchDelayMs: Math.max(
      0,
      Number(
        process.env.HOMEOWNERSCOLLECTION30A_DETAIL_FETCH_DELAY_MS ?? "120",
      ) || 120,
    ),
    detailFetchConcurrency: Math.max(
      1,
      Number(
        process.env.HOMEOWNERSCOLLECTION30A_DETAIL_FETCH_CONCURRENCY ?? "4",
      ) || 4,
    ),
    availabilityHorizonDays: Math.max(
      1,
      Number(
        process.env.HOMEOWNERSCOLLECTION30A_AVAILABILITY_HORIZON_DAYS ?? "730",
      ) || 730,
    ),
    maxCalendarAdvanceMonths: Math.max(
      8,
      Number(process.env.HOMEOWNERSCOLLECTION30A_CALENDAR_MAX_MONTHS ?? "26") ||
        26,
    ),
    isValidDetailUrl(value: string): string | null {
      try {
        const parsed = new URL(value.trim());
        if (
          !parsed.hostname.endsWith("homeownerscollection.com") ||
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
        context.refreshMode,
        context.existingDetailJsonPath,
        context.reportDetailProgress,
      );
    },
    async runQuoteCapture(argv, progress) {
      const normalizedArgs = await normalizeAdapterQuoteScopeArgs(
        "homeownerscollection30a",
        argv,
      );
      await runRuntimeAdapterQuoteCli(
        {
          adapterKey: "homeownerscollection30a",
          executeSingleQuote: executeHomeownerscollection30aSingleQuote,
          defaultQuoteTimeoutMs: 20000,
          defaultQuoteMaxAttempts: 2,
          defaultEndpointPath: HOMEOWNERS_RCAPI_PATH,
          defaultTaxPct: 0.12,
          defaultBaseNightly: 650,
        },
        normalizedArgs,
        progress,
      );
    },
  };
}
