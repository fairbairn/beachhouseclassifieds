import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { Browser, Page } from "playwright";

import {
  assertCanonicalQuotesSidecarRecord,
  type CanonicalQuoteObservation,
  type CanonicalQuotesSidecarRecord,
} from "@/lib/pricing/contracts/quote-observations-contract";
import { normalizeAdapterQuoteScopeArgs } from "../quote-scope";

import type { DetailRecordBase, ScrapedLink, ScraperAdapter } from "../types";
import { runThirtyAEscapesQuoteCli } from "./quotes/30aescapes";

type EscapeDayCode = string;

type EscapeRateObservation = CanonicalQuoteObservation;

type EscapeDetailRecord = DetailRecordBase & {
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
    source: "pm_30aescapes";
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
    source: "pm_30aescapes";
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
      status_code: EscapeDayCode;
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
    source: "pm_30aescapes_quote_api";
    external_listing_id: string;
    captured_at: string;
    currency: string;
    quote_window_days: number;
    quote_sample_step_days: number;
    quote_nights: number;
    quote_max_queries: number;
    assumptions_sample_count: number;
    days: Array<{
      date: string;
      nightly_rate: number | null;
      min_nights: number | null;
      is_booked: boolean | null;
      changeover_code: EscapeDayCode;
      season_name: string;
    }>;
  };
  rates_raw: {
    source: "30aescapes_quote_api";
    endpoint: string;
    method: "POST";
    quote_signature: {
      formtype: string;
      page: string;
      redskyclient: string;
    };
    assumptions_snapshot: {
      sample_count: number;
      avg_fee_pct_of_base: number;
      avg_tax_pct_of_base: number;
      avg_all_in_multiplier: number;
    };
    observations_count: number;
    observations_path: string | null;
    observations: EscapeRateObservation[];
  };
  scrape_metrics: {
    total_ms: number;
    page_load_ms: number;
    extraction_ms: number;
    calendar_clicks: number;
    calendar_iterations: number;
  };
};

const DEFAULT_ANCHOR_URL = "https://www.30aescapes.com/all-30a-rentals";
const OUTPUT_ROOT = resolve(
  process.cwd(),
  "src",
  "lib",
  "data",
  "external-sources",
  "30aescapes",
);
const OUTPUT_DETAILS_HTML_DIR = resolve(OUTPUT_ROOT, "details", "html");
const OUTPUT_DETAILS_QUOTES_DIR = resolve(OUTPUT_ROOT, "details", "quotes");
const PRICING_ASSUMPTIONS_PATH = resolve(
  OUTPUT_ROOT,
  "pricing-assumptions.json",
);
const ESCAPES_QUOTES_ENDPOINT =
  "https://www.30aescapes.com/rentals/ajax/get-pdp-rates.cfm";
const THIRTY_A_ESCAPES_QUOTE_MODULE_VERSION = "2026-03-31.checkout-anchored-v1";

type EscapesAssumptionsStore = {
  assumptions?: {
    sample_count?: number;
    avg_fee_pct_of_base?: number;
    avg_tax_pct_of_base?: number;
    avg_non_base_pct_of_total?: number;
    avg_all_in_multiplier?: number;
  };
};

type EscapesAssumptionsSnapshot = {
  sample_count: number;
  avg_fee_pct_of_base: number;
  avg_tax_pct_of_base: number;
  avg_non_base_pct_of_total: number;
  avg_all_in_multiplier: number;
};

type EscapeQuotesSidecarRecord = CanonicalQuotesSidecarRecord;

let cachedEscapesAssumptions: EscapesAssumptionsStore | null = null;
let escapesQuoteHttpActive = 0;
let escapesQuoteHttpLastStartMs = 0;
const escapesQuoteHttpWaiters: Array<() => void> = [];

function getEscapesQuoteHttpConcurrencyLimit(): number {
  const parsed = Number(process.env.ESCAPES30A_QUOTE_HTTP_CONCURRENCY ?? "3");
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 3;
  }
  return Math.floor(parsed);
}

function getEscapesQuoteHttpMinGapMs(): number {
  const parsed = Number(process.env.ESCAPES30A_QUOTE_HTTP_MIN_GAP_MS ?? "150");
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 150;
  }
  return Math.floor(parsed);
}

async function acquireEscapesQuoteHttpSlot(): Promise<void> {
  while (true) {
    if (escapesQuoteHttpActive < getEscapesQuoteHttpConcurrencyLimit()) {
      escapesQuoteHttpActive += 1;
      break;
    }
    await new Promise<void>((resolve) => {
      escapesQuoteHttpWaiters.push(resolve);
    });
  }

  const minGapMs = getEscapesQuoteHttpMinGapMs();
  const waitMs = escapesQuoteHttpLastStartMs + minGapMs - Date.now();
  if (waitMs > 0) {
    await sleep(waitMs);
  }
  escapesQuoteHttpLastStartMs = Date.now();
}

function releaseEscapesQuoteHttpSlot(): void {
  escapesQuoteHttpActive = Math.max(0, escapesQuoteHttpActive - 1);
  const next = escapesQuoteHttpWaiters.shift();
  next?.();
}

async function withEscapesQuoteHttpRateLimit<T>(
  task: () => Promise<T>,
): Promise<T> {
  await acquireEscapesQuoteHttpSlot();
  try {
    return await task();
  } finally {
    releaseEscapesQuoteHttpSlot();
  }
}

function normalizeLink(url: string): string {
  return url.split("#")[0]?.replace(/\/$/, "") ?? url;
}

function isLikelyDetailPath(pathname: string): boolean {
  const normalizedPath = pathname.toLowerCase().replace(/\/+$/, "");
  if (!/^\/rentals\/[a-z0-9][a-z0-9-]*$/i.test(normalizedPath)) {
    return false;
  }

  const slug = normalizedPath.split("/").filter(Boolean).at(-1) ?? "";
  if (
    slug === "all-30a-rentals" ||
    slug === "search-results" ||
    slug === "results" ||
    slug === "vacation-rentals"
  ) {
    return false;
  }

  return true;
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

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

function safeRatio(
  numerator: number | null,
  denominator: number | null,
): number | null {
  if (
    numerator === null ||
    denominator === null ||
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator <= 0
  ) {
    return null;
  }
  return Number((numerator / denominator).toFixed(6));
}

function coerceMoney(value: number | null | undefined): number | null {
  if (!Number.isFinite(value)) {
    return null;
  }
  return roundCurrency(Number(value));
}

function addDaysToIsoDate(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime())) {
    return isoDate;
  }
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function isSaturdayIsoDate(isoDate: string): boolean {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.getUTCDay() === 6;
}

function firstSaturdayOnOrAfter(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime())) {
    return isoDate;
  }
  const delta = (6 - date.getUTCDay() + 7) % 7;
  date.setUTCDate(date.getUTCDate() + delta);
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
  const parsed = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(parsed) ? roundCurrency(parsed) : null;
}

function extractScriptValueAmount(
  html: string,
  fieldId: string,
): number | null {
  const escaped = fieldId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    String.raw`\$\(\s*['"]#${escaped}['"]\s*\)\.val\(\s*['"]([0-9,]+(?:\.[0-9]{2})?)['"]\s*\)`,
    "i",
  );
  const value = html.match(pattern)?.[1] ?? null;
  return value ? parseUsdAmountFromText(`$${value}`) : null;
}

function parseSetCookieHeader(setCookie: string): string[] {
  if (!setCookie) {
    return [];
  }
  return setCookie
    .split(/,(?=\s*[A-Za-z0-9_.-]+=)/g)
    .map((item) => item.trim());
}

function buildCookieHeader(setCookieValues: string[]): string {
  const cookieMap = new Map<string, string>();
  for (const cookie of setCookieValues) {
    const firstPart = cookie.split(";")[0]?.trim();
    if (!firstPart) {
      continue;
    }
    const eqIndex = firstPart.indexOf("=");
    if (eqIndex <= 0) {
      continue;
    }
    const name = firstPart.slice(0, eqIndex).trim();
    const value = firstPart.slice(eqIndex + 1).trim();
    if (name) {
      cookieMap.set(name, value);
    }
  }
  return [...cookieMap.entries()]
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

function extractEscapesAjaxPath(html: string): string {
  const match = html.match(/(["'])([^"']*get-booknow-rates\.cfm[^"']*)\1/i);
  const extracted = match?.[2]?.trim();
  if (!extracted) {
    return "/rentals/ajax/get-booknow-rates.cfm";
  }
  if (extracted.startsWith("http://") || extracted.startsWith("https://")) {
    try {
      return new URL(extracted).pathname;
    } catch {
      return "/rentals/ajax/get-booknow-rates.cfm";
    }
  }
  if (extracted.startsWith("/")) {
    return extracted;
  }
  if (extracted.startsWith("ajax/")) {
    return `/rentals/${extracted}`;
  }
  return "/rentals/ajax/get-booknow-rates.cfm";
}

function extractTableLabelAmount(html: string, label: string): number | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `<td[^>]*>\\s*${escaped}\\s*<\\/td>\\s*<td[^>]*>\\s*\\$\\s*([0-9,]+(?:\\.[0-9]{2})?)\\s*<\\/td>`,
    "i",
  );
  const value = html.match(pattern)?.[1] ?? null;
  return value ? parseUsdAmountFromText(`$${value}`) : null;
}

function parseRetryDelaysMs(raw: string): number[] {
  const parsed = raw
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .map((value) => Math.floor(value));
  if (parsed.length >= 2) {
    return parsed;
  }
  // Slow upstream responses are common; default to a more patient backoff profile.
  return [0, 1000, 2500, 5000, 9000];
}

function parseObservationRetryDelaysMs(raw: string): number[] {
  const parsed = raw
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .map((value) => Math.floor(value));
  if (parsed.length >= 2) {
    return parsed;
  }
  // Retry the same observation window before moving on.
  return [0, 2500, 7000];
}

async function fetchEscapesBookNowTotals(input: {
  handoffUrl: string;
  refererUrl?: string;
  reportProgress?: (message: string) => void;
}): Promise<{
  quotedTotal: number | null;
  baseTotal: number | null;
  taxesTotal: number | null;
  unavailable: boolean;
}> {
  let handoff: URL;
  try {
    handoff = new URL(input.handoffUrl, "https://www.30aescapes.com");
  } catch {
    return {
      quotedTotal: null,
      baseTotal: null,
      taxesTotal: null,
      unavailable: false,
    };
  }

  const propertyid = handoff.searchParams.get("propertyid")?.trim() ?? "";
  const strcheckin = handoff.searchParams.get("strcheckin")?.trim() ?? "";
  const strcheckout = handoff.searchParams.get("strcheckout")?.trim() ?? "";
  if (!propertyid || !strcheckin || !strcheckout) {
    return {
      quotedTotal: null,
      baseTotal: null,
      taxesTotal: null,
      unavailable: false,
    };
  }

  const parseAjaxPayload = (
    ajaxHtml: string,
  ): {
    quotedTotal: number | null;
    baseTotal: number | null;
    taxesTotal: number | null;
    unavailable: boolean;
  } => {
    const lowered = ajaxHtml.toLowerCase();
    if (
      lowered.includes("property is not available") ||
      lowered.includes("unit has no availability")
    ) {
      return {
        quotedTotal: null,
        baseTotal: null,
        taxesTotal: null,
        unavailable: true,
      };
    }

    const quotedTotal =
      extractTableLabelAmount(ajaxHtml, "Total Amount") ??
      extractScriptValueAmount(ajaxHtml, "BookingValue");
    const taxesTotal =
      extractTableLabelAmount(ajaxHtml, "Taxes") ??
      extractScriptValueAmount(ajaxHtml, "TaxValue");
    const baseTotal =
      extractTableLabelAmount(ajaxHtml, "Rent") ??
      (quotedTotal !== null && taxesTotal !== null
        ? roundCurrency(quotedTotal - taxesTotal)
        : null);

    return {
      quotedTotal,
      baseTotal,
      taxesTotal,
      unavailable: false,
    };
  };

  try {
    const handoffResponse = await withEscapesQuoteHttpRateLimit(() =>
      fetch(handoff.toString(), {
        headers: {
          accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "user-agent": "Mozilla/5.0",
          ...(input.refererUrl ? { referer: input.refererUrl } : {}),
        },
      }),
    );

    if (!handoffResponse.ok) {
      return {
        quotedTotal: null,
        baseTotal: null,
        taxesTotal: null,
        unavailable: false,
      };
    }

    const handoffHtml = await handoffResponse.text();
    const cookieHeader = buildCookieHeader(
      parseSetCookieHeader(handoffResponse.headers.get("set-cookie") ?? ""),
    );

    const ajaxPath = extractEscapesAjaxPath(handoffHtml);
    const ajaxUrl = new URL(ajaxPath, handoff.origin);
    ajaxUrl.searchParams.set("propertyid", propertyid);
    ajaxUrl.searchParams.set("strcheckin", strcheckin);
    ajaxUrl.searchParams.set("strcheckout", strcheckout);
    ajaxUrl.searchParams.set("_", String(Date.now()));

    const attemptDelaysMs = parseRetryDelaysMs(
      process.env.ESCAPES30A_QUOTE_AJAX_RETRY_DELAYS_MS ?? "",
    );
    for (
      let attemptIndex = 0;
      attemptIndex < attemptDelaysMs.length;
      attemptIndex += 1
    ) {
      const delayMs = attemptDelaysMs[attemptIndex] ?? 0;
      if (delayMs > 0) {
        await sleep(delayMs);
      }

      ajaxUrl.searchParams.set("_", String(Date.now()));
      const ajaxResponse = await withEscapesQuoteHttpRateLimit(() =>
        fetch(ajaxUrl.toString(), {
          headers: {
            accept: "text/html, */*;q=0.1",
            "x-requested-with": "XMLHttpRequest",
            "user-agent": "Mozilla/5.0",
            referer: handoff.toString(),
            ...(cookieHeader ? { cookie: cookieHeader } : {}),
          },
        }),
      );

      if (!ajaxResponse.ok) {
        input.reportProgress?.(
          `quote ajax retry ${attemptIndex + 1}/${attemptDelaysMs.length} failed status=${ajaxResponse.status}`,
        );
        if (attemptIndex < attemptDelaysMs.length - 1) {
          continue;
        }
        return {
          quotedTotal: null,
          baseTotal: null,
          taxesTotal: null,
          unavailable: false,
        };
      }

      const ajaxHtml = await ajaxResponse.text();
      const parsed = parseAjaxPayload(ajaxHtml);
      if (parsed.unavailable || parsed.quotedTotal !== null) {
        return parsed;
      }

      input.reportProgress?.(
        `quote ajax retry ${attemptIndex + 1}/${attemptDelaysMs.length} missing total amount`,
      );

      if (attemptIndex < attemptDelaysMs.length - 1) {
        const nextDelayMs = attemptDelaysMs[attemptIndex + 1] ?? 0;
        input.reportProgress?.(
          `quote ajax awaiting next retry delay_ms=${nextDelayMs}`,
        );
      }
    }

    return {
      quotedTotal: null,
      baseTotal: null,
      taxesTotal: null,
      unavailable: false,
    };
  } catch {
    return {
      quotedTotal: null,
      baseTotal: null,
      taxesTotal: null,
      unavailable: false,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function averageRatio(values: Array<number | null | undefined>): number | null {
  const finite = values.filter(
    (value): value is number =>
      Number.isFinite(value) && value !== null && value !== undefined,
  );
  if (finite.length === 0) {
    return null;
  }
  const avg = finite.reduce((sum, value) => sum + value, 0) / finite.length;
  return Number(avg.toFixed(6));
}

function buildObservationAssumptionsSnapshot(
  observations: EscapeRateObservation[],
  fallback: EscapesAssumptionsSnapshot,
): EscapesAssumptionsSnapshot {
  return {
    sample_count: observations.length,
    avg_fee_pct_of_base:
      averageRatio(observations.map((item) => item.fee_pct_of_base)) ??
      fallback.avg_fee_pct_of_base,
    avg_tax_pct_of_base:
      averageRatio(observations.map((item) => item.tax_pct_of_base)) ??
      fallback.avg_tax_pct_of_base,
    avg_non_base_pct_of_total:
      averageRatio(observations.map((item) => item.non_base_pct_of_total)) ??
      fallback.avg_non_base_pct_of_total,
    avg_all_in_multiplier:
      averageRatio(observations.map((item) => item.all_in_multiplier)) ??
      fallback.avg_all_in_multiplier,
  };
}

async function readEscapesAssumptions(): Promise<EscapesAssumptionsStore> {
  if (cachedEscapesAssumptions) {
    return cachedEscapesAssumptions;
  }
  try {
    const raw = await readFile(PRICING_ASSUMPTIONS_PATH, "utf8");
    cachedEscapesAssumptions = JSON.parse(raw) as EscapesAssumptionsStore;
  } catch {
    cachedEscapesAssumptions = {};
  }
  return cachedEscapesAssumptions;
}

async function fetchEscapesQuote(params: {
  propertyId: string;
  unitShortName: string;
  checkInIso: string;
  checkOutIso: string;
  detailUrl?: string;
  reportProgress?: (message: string) => void;
}): Promise<{
  quoteAvailable: boolean;
  unavailableReason: string | null;
  baseTotal: number | null;
  taxesTotal: number | null;
  quotedTotal: number | null;
  handoffUrl: string | null;
  feeLines: Array<{ name: string; amount: number }>;
}> {
  const handoffUrl = `https://www.30aescapes.com/rentals/book-now.cfm?propertyid=${encodeURIComponent(params.propertyId)}&strcheckin=${encodeURIComponent(toUsDate(params.checkInIso))}&strcheckout=${encodeURIComponent(toUsDate(params.checkOutIso))}`;

  const checkoutFirst = await fetchEscapesBookNowTotals({
    handoffUrl,
    refererUrl: params.detailUrl,
    reportProgress: params.reportProgress,
  });
  if (checkoutFirst.unavailable) {
    return {
      quoteAvailable: false,
      unavailableReason: "unavailable",
      baseTotal: null,
      taxesTotal: null,
      quotedTotal: null,
      handoffUrl: null,
      feeLines: [],
    };
  }
  if (checkoutFirst.quotedTotal !== null) {
    const stabilityAttempts = Math.max(
      1,
      Math.floor(
        Number(process.env.ESCAPES30A_QUOTE_STABILITY_ATTEMPTS ?? "3") || 3,
      ),
    );
    const stabilityTolerance = Math.max(
      0,
      Number(process.env.ESCAPES30A_QUOTE_STABILITY_TOLERANCE ?? "1") || 1,
    );

    const checkoutSamples: Array<{
      quotedTotal: number;
      baseTotal: number | null;
      taxesTotal: number | null;
    }> = [
      {
        quotedTotal: checkoutFirst.quotedTotal,
        baseTotal: checkoutFirst.baseTotal,
        taxesTotal: checkoutFirst.taxesTotal,
      },
    ];

    for (let attempt = 1; attempt < stabilityAttempts; attempt += 1) {
      const extra = await fetchEscapesBookNowTotals({
        handoffUrl,
        refererUrl: params.detailUrl,
        reportProgress: params.reportProgress,
      });
      if (extra.unavailable || extra.quotedTotal === null) {
        continue;
      }
      checkoutSamples.push({
        quotedTotal: extra.quotedTotal,
        baseTotal: extra.baseTotal,
        taxesTotal: extra.taxesTotal,
      });
    }

    let selectedSample = checkoutSamples[checkoutSamples.length - 1]!;
    if (checkoutSamples.length >= 2) {
      const totals = checkoutSamples
        .map((sample) => sample.quotedTotal)
        .sort((left, right) => left - right);
      const minTotal = totals[0] ?? 0;
      const maxTotal = totals[totals.length - 1] ?? 0;

      if (maxTotal - minTotal > stabilityTolerance) {
        const medianIndex = Math.floor(totals.length / 2);
        const medianTotal = totals[medianIndex] ?? totals[totals.length - 1]!;
        let closest = checkoutSamples[0]!;
        let closestDiff = Math.abs(closest.quotedTotal - medianTotal);
        for (const sample of checkoutSamples.slice(1)) {
          const diff = Math.abs(sample.quotedTotal - medianTotal);
          if (diff < closestDiff) {
            closest = sample;
            closestDiff = diff;
          }
        }
        selectedSample = closest;
        params.reportProgress?.(
          `quote checkout totals inconsistent samples=${checkoutSamples.map((sample) => sample.quotedTotal.toFixed(2)).join(",")} selected=${selectedSample.quotedTotal.toFixed(2)}`,
        );
      }
    }

    return {
      quoteAvailable: true,
      unavailableReason: null,
      baseTotal: selectedSample.baseTotal,
      taxesTotal: selectedSample.taxesTotal,
      quotedTotal: selectedSample.quotedTotal,
      handoffUrl,
      feeLines: [],
    };
  }

  // Checkout totals are authoritative for 30aescapes parity.
  // If they cannot be extracted, mark as unavailable instead of
  // falling back to ambiguous PDP markup.
  return {
    quoteAvailable: false,
    unavailableReason: "checkout_total_unavailable",
    baseTotal: null,
    taxesTotal: null,
    quotedTotal: null,
    handoffUrl,
    feeLines: [],
  };
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

function extractLatLngFromHtml(
  html: string,
): { lat: number; lng: number } | null {
  const match = html.match(
    /google\.maps\.LatLng\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/i,
  );
  if (!match) {
    return null;
  }

  const lat = Number(match[1]);
  const lng = Number(match[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }

  return { lat, lng };
}

function normalizeGalleryUrl(rawUrl: string): string {
  const cleaned = rawUrl.trim();
  if (!cleaned) {
    return "";
  }

  try {
    const parsed = new URL(cleaned);
    if (
      parsed.hostname === "img.trackhs.com" &&
      parsed.pathname.startsWith("/")
    ) {
      const candidate = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
      if (candidate.startsWith("http://") || candidate.startsWith("https://")) {
        return candidate;
      }
    }
    return parsed.toString();
  } catch {
    return "";
  }
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

function extractInputValueFromHtml(html: string, inputName: string): string {
  const escapedName = inputName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(
    `<input[^>]*name=["']${escapedName}["'][^>]*value=["']([^"']+)["'][^>]*>`,
    "i",
  );
  const match = html.match(regex);
  return (match?.[1] ?? "").trim();
}

function parseRuleDateLabel(value: string): string {
  const cleaned = value.replace(/\s+/g, " ").trim();
  const match = cleaned.match(/^([A-Za-z]+)\.?\s+(\d{1,2}),\s+(\d{4})$/);
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

function parseMinNightRules(rawRules: string[]): Array<{
  start_date: string;
  end_date: string;
  min_nights: number;
  raw_rule: string;
}> {
  const parsedRules: Array<{
    start_date: string;
    end_date: string;
    min_nights: number;
    raw_rule: string;
  }> = [];

  for (const rawRule of rawRules) {
    const match = rawRule.match(
      /^([A-Za-z]{3}\.?\s+\d{1,2},\s+\d{4})\s+[—-]\s+([A-Za-z]{3}\.?\s+\d{1,2},\s+\d{4})\s+(\d+)\s+Night\s+Minimum$/i,
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
  rules: Array<{ start_date: string; end_date: string; min_nights: number }>,
): number | null {
  let matched: number | null = null;
  for (const rule of rules) {
    if (date < rule.start_date || date > rule.end_date) {
      continue;
    }

    matched =
      matched === null ? rule.min_nights : Math.max(matched, rule.min_nights);
  }
  return matched;
}

const ESCAPE_MONTH_BY_NAME: Record<string, number> = {
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

function parseEscapeMonthHeader(
  value: string,
): { year: number; monthIndex: number } | null {
  const cleaned = value.replace(/\s+/g, " ").trim();
  const match = cleaned.match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (!match) {
    return null;
  }

  const monthIndex = ESCAPE_MONTH_BY_NAME[(match[1] ?? "").toLowerCase()];
  const year = Number(match[2]);
  if (!Number.isFinite(monthIndex) || !Number.isFinite(year)) {
    return null;
  }

  return { year, monthIndex };
}

function parseEscapeCalendarFromHtml(
  html: string,
  maxCalendarAdvanceMonths: number,
): {
  hasCalendarWidget: boolean;
  monthsParsed: number;
  items: Array<{ date: string; code: EscapeDayCode }>;
} {
  const tableRegex =
    /<table[^>]*class="[^"]*calendar-table[^"]*"[^>]*>([\s\S]*?)<\/table>/gi;
  const tables: string[] = [];
  let tableMatch: RegExpExecArray | null;
  while (
    (tableMatch = tableRegex.exec(html)) !== null &&
    tables.length < Math.max(1, maxCalendarAdvanceMonths)
  ) {
    tables.push(tableMatch[0]);
  }

  const items: Array<{ date: string; code: EscapeDayCode }> = [];
  for (const tableHtml of tables) {
    const monthText =
      tableHtml.match(
        /<th[^>]*class="[^"]*\bmonth\b[^"]*"[^>]*>\s*(?:<strong>)?\s*([^<]+?)\s*(?:<\/strong>)?\s*<\/th>/i,
      )?.[1] ?? "";
    const monthMeta = parseEscapeMonthHeader(monthText);
    if (!monthMeta) {
      continue;
    }

    const cellRegex =
      /<td[^>]*class="([^"]*)"[^>]*>[\s\S]*?<span>\s*(\d{1,2})\s*<\/span>[\s\S]*?<\/td>/gi;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRegex.exec(tableHtml)) !== null) {
      const classBlob = (cellMatch[1] ?? "").toLowerCase();
      const day = Number(cellMatch[2]);
      if (!Number.isFinite(day) || day <= 0 || day > 31) {
        continue;
      }

      const candidate = new Date(
        Date.UTC(monthMeta.year, monthMeta.monthIndex, day),
      );
      if (
        candidate.getUTCFullYear() !== monthMeta.year ||
        candidate.getUTCMonth() !== monthMeta.monthIndex ||
        candidate.getUTCDate() !== day
      ) {
        continue;
      }

      let code: EscapeDayCode = "X";
      if (
        classBlob.includes("splitviewcheckin") ||
        classBlob.includes("checkin") ||
        classBlob.includes("arrival")
      ) {
        code = "I";
      } else if (
        classBlob.includes("splitviewcheckout") ||
        classBlob.includes("checkout") ||
        classBlob.includes("departure")
      ) {
        code = "O";
      } else if (
        classBlob.includes("unavailable") ||
        classBlob.includes("booked") ||
        classBlob.includes("reserved")
      ) {
        code = "U";
      } else if (
        classBlob.includes("available") ||
        classBlob.includes("bookable")
      ) {
        code = "A";
      }

      items.push({ date: candidate.toISOString().slice(0, 10), code });
    }
  }

  return {
    hasCalendarWidget:
      tables.length > 0 ||
      /id=["']calendar["']|class=["'][^"']*calendar-wrap/i.test(html),
    monthsParsed: tables.length,
    items,
  };
}

export function buildEscapesAvailabilityFromHtml(params: {
  html: string;
  externalListingId: string;
  availabilityHorizonDays: number;
  maxCalendarAdvanceMonths: number;
  capturedAt?: string;
}): EscapeDetailRecord["normalized_availability"] {
  const {
    html,
    externalListingId,
    availabilityHorizonDays,
    maxCalendarAdvanceMonths,
    capturedAt,
  } = params;

  const calendarSnapshot = parseEscapeCalendarFromHtml(
    html,
    maxCalendarAdvanceMonths,
  );
  const dayCodeByDate = new Map<string, EscapeDayCode>();
  const codePriority: Record<string, number> = {
    X: 0,
    A: 1,
    U: 1,
    I: 2,
    O: 2,
  };

  for (const item of calendarSnapshot.items) {
    const previous = dayCodeByDate.get(item.date);
    if (!previous) {
      dayCodeByDate.set(item.date, item.code);
      continue;
    }

    if ((codePriority[item.code] ?? 0) > (codePriority[previous] ?? 0)) {
      dayCodeByDate.set(item.date, item.code);
    }
  }

  const horizonDate = new Date();
  horizonDate.setUTCDate(horizonDate.getUTCDate() + availabilityHorizonDays);
  const todayIso = new Date().toISOString().slice(0, 10);
  const horizonIso = horizonDate.toISOString().slice(0, 10);

  const bodyText = stripHtml(html);
  const bookingRestrictionMatches = Array.from(
    bodyText.matchAll(
      /([A-Za-z]{3}\.?\s+\d{1,2},\s+\d{4}\s+[—-]\s+[A-Za-z]{3}\.?\s+\d{1,2},\s+\d{4}\s+\d+\s+Night\s+Minimum)/g,
    ),
  )
    .map((match) => match[1] ?? "")
    .filter(Boolean);

  const minNightRules = parseMinNightRules(
    Array.from(new Set(bookingRestrictionMatches)).slice(0, 60),
  );

  const normalizedDays = Array.from(dayCodeByDate.entries())
    .filter(([date]) => date >= todayIso && date <= horizonIso)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, code]) => {
      const bookingDayState: "bookable" | "blocked" | "unknown" =
        code === "A" || code === "O"
          ? "bookable"
          : code === "U" || code === "I"
            ? "blocked"
            : "unknown";

      const isAvailableForCheckin = code === "A" || code === "I";
      const isAvailableForCheckout = code === "A" || code === "O";
      const isAvailable = isAvailableForCheckin || isAvailableForCheckout;

      return {
        date,
        status_code: code,
        is_available: isAvailable,
        is_available_for_checkin: isAvailableForCheckin,
        is_available_for_checkout: isAvailableForCheckout,
        booking_day_state: bookingDayState,
        min_nights_required: resolveMinNightsForDate(date, minNightRules),
      };
    });

  return {
    source: "pm_30aescapes",
    external_listing_id: externalListingId,
    captured_at: capturedAt ?? new Date().toISOString(),
    has_calendar_widget: calendarSnapshot.hasCalendarWidget,
    booking_restrictions: Array.from(new Set(bookingRestrictionMatches)).slice(
      0,
      60,
    ),
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
    },
  };
}

async function installEvaluateNameShim(page: Page): Promise<void> {
  const shim = "window.__name = window.__name || ((target) => target);";
  await page.addInitScript(shim);
  await page.evaluate(shim);
}

async function discoverListings(
  page: Page,
  anchorUrl: string,
  maxScrollSteps: number,
  scrollPauseMs: number,
  networkIdleWaitMs: number,
  reportProgress: (message: string) => void,
): Promise<ScrapedLink[]> {
  await installEvaluateNameShim(page);

  const networkRows: Array<{ href: string; text: string }> = [];
  const networkSeen = new Set<string>();
  const effectiveScrollPauseMs = Math.max(180, Math.min(scrollPauseMs, 400));
  let expectedListingCount: number | null = null;
  let previousCandidateCount = 0;
  let previousDomCount = 0;
  let stagnantSteps = 0;
  let stagnantDomSteps = 0;

  page.on("response", (response) => {
    void (async () => {
      try {
        const responseUrl = response.url();
        const parsed = new URL(responseUrl);
        if (!parsed.hostname.endsWith("30aescapes.com")) {
          return;
        }

        const headers = response.headers();
        const contentType = (
          headers["content-type"] ??
          headers["Content-Type"] ??
          ""
        ).toLowerCase();
        const isJsonLike =
          contentType.includes("application/json") ||
          responseUrl.includes("results.cfm") ||
          responseUrl.includes("/ajax/") ||
          responseUrl.includes("graphql");

        if (!isJsonLike) {
          return;
        }

        const bodyText = await response.text();
        if (!bodyText) {
          return;
        }

        const matches =
          bodyText.match(/(?:https?:\/\/[^"'\s<>]+|\/rentals\/[a-z0-9-]+)/gi) ??
          [];
        for (const raw of matches) {
          const value = raw
            .replace(/\\\//g, "/")
            .replace(/"/g, "")
            .replace(/"/g, "")
            .trim();
          if (!value) {
            continue;
          }

          let absolute = value;
          if (value.startsWith("/")) {
            absolute = new URL(value, "https://www.30aescapes.com").toString();
          }

          try {
            const parsedUrl = new URL(absolute);
            if (
              !parsedUrl.hostname.endsWith("30aescapes.com") ||
              !isLikelyDetailPath(parsedUrl.pathname)
            ) {
              continue;
            }
          } catch {
            continue;
          }

          const dedupe = normalizeLink(absolute);
          if (networkSeen.has(dedupe)) {
            continue;
          }
          networkSeen.add(dedupe);
          networkRows.push({ href: absolute, text: "network-response" });
        }
      } catch {
        // Ignore response parsing failures.
      }
    })();
  });

  await page.goto(anchorUrl, {
    waitUntil: "domcontentloaded",
    timeout: 120000,
  });
  await page.waitForTimeout(Math.max(1200, scrollPauseMs * 2));

  const readSnapshot = async (): Promise<{
    domCandidateCount: number;
    pageCount: number | null;
  }> =>
    page.evaluate(() => {
      const viewDetailsHrefSet = new Set<string>();
      const allRentalHrefSet = new Set<string>();

      const toNormalized = (hrefValue: string): string => {
        try {
          const absolute = new URL(
            hrefValue,
            window.location.origin,
          ).toString();
          const parsed = new URL(absolute);
          if (!parsed.hostname.endsWith("30aescapes.com")) {
            return "";
          }

          const normalizedPath = parsed.pathname
            .toLowerCase()
            .replace(/\/+$/, "");
          if (!/^\/rentals\/[a-z0-9][a-z0-9-]*$/i.test(normalizedPath)) {
            return "";
          }

          const slug = normalizedPath.split("/").filter(Boolean).at(-1) ?? "";
          if (
            slug === "all-30a-rentals" ||
            slug === "search-results" ||
            slug === "results" ||
            slug === "vacation-rentals"
          ) {
            return "";
          }

          return `${parsed.origin}${parsed.pathname}`.replace(/\/$/, "");
        } catch {
          return "";
        }
      };

      for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
        const href = (anchor as HTMLAnchorElement).getAttribute("href") ?? "";
        if (!href) {
          continue;
        }

        const normalized = toNormalized(href);
        if (!normalized) {
          continue;
        }

        allRentalHrefSet.add(normalized);

        const label = [
          anchor.textContent ?? "",
          (anchor as HTMLAnchorElement).getAttribute("aria-label") ?? "",
          (anchor as HTMLAnchorElement).getAttribute("title") ?? "",
        ]
          .join(" ")
          .toLowerCase();
        if (label.includes("view details")) {
          viewDetailsHrefSet.add(normalized);
        }
      }

      let pageCount: number | null = null;
      const bodyText = document.body?.innerText ?? "";
      const countMatch = bodyText.match(
        /\b(\d{1,4})\s+(?:properties|rentals)\b/i,
      );
      if (countMatch) {
        const parsed = Number(countMatch[1]);
        if (Number.isFinite(parsed) && parsed > 0) {
          pageCount = Math.floor(parsed);
        }
      }

      return {
        domCandidateCount:
          viewDetailsHrefSet.size > 0
            ? viewDetailsHrefSet.size
            : allRentalHrefSet.size,
        pageCount,
      };
    });

  const initialSnapshot = await readSnapshot();
  if (initialSnapshot.pageCount !== null) {
    expectedListingCount = initialSnapshot.pageCount;
    reportProgress(`discovery target count on page: ${expectedListingCount}`);
  }

  if (
    expectedListingCount !== null &&
    initialSnapshot.domCandidateCount >= expectedListingCount
  ) {
    reportProgress(
      `discovery early-stop: initial page already contains target (${initialSnapshot.domCandidateCount}/${expectedListingCount})`,
    );
  } else {
    previousDomCount = initialSnapshot.domCandidateCount;
    previousCandidateCount =
      initialSnapshot.domCandidateCount + networkSeen.size;

    for (let step = 0; step < maxScrollSteps; step += 1) {
      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);

        const candidates = Array.from(
          document.querySelectorAll(
            "[style*='overflow'], .overflow-auto, .overflow-y-auto, .scroll, .scrollable",
          ),
        );
        for (const candidate of candidates) {
          if (!(candidate instanceof HTMLElement)) {
            continue;
          }
          if (candidate.scrollHeight > candidate.clientHeight + 60) {
            candidate.scrollTop = candidate.scrollHeight;
          }
        }
      });

      await page.waitForTimeout(effectiveScrollPauseMs);

      const shouldAttemptClickSweep = step < 8 || step % 4 === 0;
      const clicked = shouldAttemptClickSweep
        ? await page.evaluate(() => {
            const clickables = Array.from(
              document.querySelectorAll(
                "button, a, [role='button'], input[type='button'], input[type='submit']",
              ),
            );

            let clickedCount = 0;
            for (const clickable of clickables) {
              const el = clickable as HTMLElement;
              if (el.offsetParent === null) {
                continue;
              }
              const label = [
                el.textContent ?? "",
                el.getAttribute("aria-label") ?? "",
                el.getAttribute("title") ?? "",
                el.getAttribute("value") ?? "",
              ]
                .join(" ")
                .toLowerCase();

              if (
                label.includes("load more") ||
                label.includes("show more") ||
                label.includes("view more") ||
                label.includes("next")
              ) {
                el.click();
                clickedCount += 1;
              }
            }

            return clickedCount;
          })
        : 0;

      if (clicked === 0 && step > 12) {
        await page.waitForTimeout(networkIdleWaitMs);
      }

      const shouldSampleSnapshot =
        step < 10 || step % 3 === 2 || step === maxScrollSteps - 1;
      if (!shouldSampleSnapshot) {
        continue;
      }

      const snapshot = await readSnapshot();

      if (expectedListingCount === null && snapshot.pageCount !== null) {
        expectedListingCount = snapshot.pageCount;
        reportProgress(
          `discovery target count on page: ${expectedListingCount}`,
        );
      }

      const candidateCount = snapshot.domCandidateCount + networkSeen.size;
      if (candidateCount > previousCandidateCount) {
        previousCandidateCount = candidateCount;
        stagnantSteps = 0;
      } else {
        stagnantSteps += 1;
      }

      if (snapshot.domCandidateCount > previousDomCount) {
        previousDomCount = snapshot.domCandidateCount;
        stagnantDomSteps = 0;
      } else {
        stagnantDomSteps += 1;
      }

      const reachedTarget =
        expectedListingCount !== null &&
        snapshot.domCandidateCount >= expectedListingCount;
      const stalledOutByDom =
        (snapshot.domCandidateCount >= 150 && stagnantDomSteps >= 4) ||
        (step >= 10 && stagnantDomSteps >= 6);
      const stalledOutByAllSignals = step >= 8 && stagnantSteps >= 5;

      if (reachedTarget && stagnantDomSteps >= 1) {
        reportProgress(
          `discovery early-stop: reached page target (${snapshot.domCandidateCount}/${expectedListingCount})`,
        );
        break;
      }

      if (stalledOutByDom || stalledOutByAllSignals) {
        reportProgress(
          `discovery early-stop: no dom growth for ${stagnantDomSteps} steps (dom=${snapshot.domCandidateCount}, candidates=${candidateCount})`,
        );
        break;
      }

      if ((step + 1) % 10 === 0 || step === maxScrollSteps - 1) {
        reportProgress(`discovery scroll step ${step + 1}/${maxScrollSteps}`);
      }
    }
  }

  const rows = await page.evaluate(() => {
    const normalizeForRow = (hrefValue: string): string => {
      try {
        const absolute = new URL(hrefValue, window.location.origin).toString();
        const parsed = new URL(absolute);
        if (!parsed.hostname.endsWith("30aescapes.com")) {
          return "";
        }

        const normalizedPath = parsed.pathname
          .toLowerCase()
          .replace(/\/+$/, "");
        if (!/^\/rentals\/[a-z0-9][a-z0-9-]*$/i.test(normalizedPath)) {
          return "";
        }

        const slug = normalizedPath.split("/").filter(Boolean).at(-1) ?? "";
        if (
          slug === "all-30a-rentals" ||
          slug === "search-results" ||
          slug === "results" ||
          slug === "vacation-rentals"
        ) {
          return "";
        }

        return `${parsed.origin}${parsed.pathname}`.replace(/\/$/, "");
      } catch {
        return "";
      }
    };

    const normalizeText = (value: string): string =>
      value
        .replace(/\s+/g, " ")
        .replace(/\u00a0/g, " ")
        .trim();

    const titleFromCard = (anchor: Element): string => {
      const card = anchor.closest(
        "article, li, [class*='card'], [class*='result'], [class*='property'], [data-testid*='property'], [data-testid*='result']",
      );

      if (!card) {
        return "";
      }

      const selectors = [
        "h1",
        "h2",
        "h3",
        "h4",
        "[class*='title']",
        "[class*='name']",
      ];

      for (const selector of selectors) {
        const node = card.querySelector(selector);
        const text = normalizeText(node?.textContent ?? "");
        if (!text) {
          continue;
        }
        if (/^view details$/i.test(text)) {
          continue;
        }
        return text;
      }

      return "";
    };

    const out: Array<{ href: string; text: string }> = [];
    const seen = new Set<string>();

    const pushRow = (hrefValue: string, textValue: string): void => {
      const normalized = normalizeForRow(hrefValue);
      if (!normalized || seen.has(normalized)) {
        return;
      }

      seen.add(normalized);
      out.push({ href: normalized, text: textValue });
    };

    const viewDetailsAnchors = Array.from(document.querySelectorAll("a[href]"));
    for (const anchor of viewDetailsAnchors) {
      const href = (anchor as HTMLAnchorElement).getAttribute("href") ?? "";
      if (!href) {
        continue;
      }

      const label = [
        anchor.textContent ?? "",
        (anchor as HTMLAnchorElement).getAttribute("aria-label") ?? "",
        (anchor as HTMLAnchorElement).getAttribute("title") ?? "",
      ]
        .join(" ")
        .toLowerCase();

      if (!label.includes("view details")) {
        continue;
      }

      const title = titleFromCard(anchor);
      pushRow(href, title || "view-details");
    }

    const anchors = Array.from(document.querySelectorAll("a[href]"));
    for (const anchor of anchors) {
      const href = (anchor as HTMLAnchorElement).getAttribute("href") ?? "";
      if (!href) {
        continue;
      }

      const fallbackText = normalizeText((anchor.textContent ?? "").trim());
      if (/^view details$/i.test(fallbackText)) {
        continue;
      }

      const title = titleFromCard(anchor);
      pushRow(href, title || fallbackText);
    }

    return out;
  });

  const allRows = [...rows, ...networkRows];
  reportProgress(
    `discovery candidates collected: dom=${rows.length}, network=${networkRows.length}`,
  );
  const links: ScrapedLink[] = [];
  const seen = new Set<string>();

  for (const row of allRows) {
    const href = typeof row.href === "string" ? row.href : "";
    if (!href) {
      continue;
    }

    let parsed: URL;
    try {
      parsed = new URL(href);
    } catch {
      continue;
    }

    if (
      !parsed.hostname.endsWith("30aescapes.com") ||
      !isLikelyDetailPath(parsed.pathname)
    ) {
      continue;
    }

    const normalized = normalizeLink(parsed.toString());
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);

    links.push({
      link: normalized,
      source_url: anchorUrl,
      anchor_text: typeof row.text === "string" ? row.text : "",
    });
  }

  return links.sort((left, right) => left.link.localeCompare(right.link));
}

async function fetchDetail(
  browser: Browser,
  detailUrl: string,
  availabilityHorizonDays: number,
  maxCalendarAdvanceMonths: number,
  refreshMode: "full" | "dynamic" | "static",
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
): Promise<EscapeDetailRecord | null> {
  const startedAt = Date.now();
  const externalListingId = extractExternalListingId(detailUrl);

  let page: Page | null = null;
  let pageLoadMs = 0;
  let extracted: {
    title: string;
    h1: string;
    canonical: string;
    metaDescription: string;
    description: string;
    descriptionExpanded: string;
    bodyText: string;
    infoPairs: Record<string, string>;
    iconText: string;
    unitId: string;
    propertyId: string;
    unitShortName: string;
    amenitiesCategories: Record<string, string[]>;
    galleryUrls: string[];
    directionsAddress: string;
    html: string;
  } | null = null;
  let normalizedAvailability:
    | EscapeDetailRecord["normalized_availability"]
    | null = null;
  const quoteOnlyMode = mode === "quote";

  try {
    if (quoteOnlyMode && existingDetailJsonPath) {
      try {
        const existingRaw = await readFile(existingDetailJsonPath, "utf8");
        const existing = JSON.parse(existingRaw) as EscapeDetailRecord;
        const existingHtmlPath =
          typeof existing.html_path === "string" ? existing.html_path : "";
        const resolvedExistingHtmlPath = existingHtmlPath
          ? isAbsolute(existingHtmlPath)
            ? existingHtmlPath
            : resolve(process.cwd(), existingHtmlPath)
          : "";
        const existingHtml = existingHtmlPath
          ? await readFile(resolvedExistingHtmlPath, "utf8")
          : "";
        if (
          existingHtml &&
          existing.normalized_availability?.days &&
          existing.normalized_availability.days.length > 0
        ) {
          extracted = {
            title: existing.title ?? "",
            h1: existing.h1 ?? "",
            canonical: existing.canonical_url ?? detailUrl,
            metaDescription: existing.meta_description ?? "",
            description:
              existing.normalized_matching_profile?.description ?? "",
            descriptionExpanded: existing.description_expanded ?? "",
            bodyText: "",
            infoPairs: {
              address: existing.location?.address ?? "",
              location: existing.location?.location_label ?? "",
            },
            iconText: "",
            unitId: existing.property_profile?.unit_id ?? externalListingId,
            propertyId: extractInputValueFromHtml(existingHtml, "propertyid"),
            unitShortName:
              extractInputValueFromHtml(existingHtml, "unitshortname") ||
              extractInputValueFromHtml(existingHtml, "unitcode"),
            amenitiesCategories: existing.amenities?.categories ?? {},
            galleryUrls: existing.media_gallery?.image_urls ?? [],
            directionsAddress: existing.location?.address ?? "",
            html: existingHtml,
          };
          normalizedAvailability = {
            ...existing.normalized_availability,
            captured_at: new Date().toISOString(),
          };
          reportDetailProgress?.(
            `detail ${externalListingId} [refresh=${refreshMode} run=${mode}] using existing detail/html artifacts`,
          );
        }
      } catch {
        // Fall back to a browser refresh path below if reuse fails.
      }
    }

    if (!extracted) {
      if (quoteOnlyMode) {
        throw new Error(
          `mode=quote requires existing detail/html artifacts for ${externalListingId}`,
        );
      }

      page = await browser.newPage();
      await installEvaluateNameShim(page);
      const pageLoadStartedAt = Date.now();
      await page.goto(detailUrl, {
        waitUntil: "domcontentloaded",
        timeout: 120000,
      });
      await page.waitForTimeout(1200);

      await page.evaluate(() => {
        const clickables = Array.from(
          document.querySelectorAll("button, a, [role='button']"),
        );
        for (const clickable of clickables) {
          const el = clickable as HTMLElement;
          const text = [
            el.textContent ?? "",
            el.getAttribute("aria-label") ?? "",
            el.getAttribute("title") ?? "",
          ]
            .join(" ")
            .toLowerCase();

          if (text.includes("read more") || text.includes("show more")) {
            el.click();
          }
        }

        const candidates = Array.from(
          document.querySelectorAll(
            "[style*='overflow'], .overflow-auto, .overflow-y-auto, .scroll, .scrollable",
          ),
        );
        for (const candidate of candidates) {
          if (!(candidate instanceof HTMLElement)) {
            continue;
          }
          if (candidate.scrollHeight > candidate.clientHeight + 40) {
            candidate.scrollTop = candidate.scrollHeight;
          }
        }
      });
      await page.waitForTimeout(450);

      pageLoadMs = Date.now() - pageLoadStartedAt;

      extracted = await page.evaluate(() => {
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

        const descriptionCandidates = [
          ".cmp-property-description__description",
          ".property-description",
          "[data-testid*='description']",
          "[class*='description']",
          "[id*='description']",
          ".description",
        ];

        const descriptions: string[] = [];
        for (const selector of descriptionCandidates) {
          const nodes = Array.from(document.querySelectorAll(selector));
          for (const node of nodes) {
            const text = (node.textContent ?? "").trim();
            if (text.length > 50) {
              descriptions.push(text);
            }
          }
        }

        const bodyText = document.body?.innerText ?? "";
        const descriptionExpanded =
          document
            .querySelector("#description #descBlock")
            ?.textContent?.trim() ??
          document.querySelector("#descBlock")?.textContent?.trim() ??
          "";

        const infoPairs: Record<string, string> = {};
        const infoNodes = Array.from(
          document.querySelectorAll(".property-info .property-info-item"),
        );
        for (const node of infoNodes) {
          const strong = node.querySelector("strong");
          if (!strong) {
            continue;
          }
          const label = (strong.textContent ?? "")
            .replace(/\s+/g, " ")
            .replace(/:\s*$/, "")
            .trim()
            .toLowerCase();
          const clone = node.cloneNode(true) as HTMLElement;
          const strongInClone = clone.querySelector("strong");
          if (strongInClone) {
            strongInClone.remove();
          }
          const value = (clone.textContent ?? "").replace(/\s+/g, " ").trim();
          if (label && value) {
            infoPairs[label] = value;
          }
        }

        const iconText =
          document.querySelector(".property-info.property-info-icons")
            ?.textContent ?? "";

        const propertyDetailsNode = document.querySelector("#propertyDetails");
        const unitId =
          propertyDetailsNode?.getAttribute("data-unitcode")?.trim() ??
          document
            .querySelector('input[name="unitcode"]')
            ?.getAttribute("value")
            ?.trim() ??
          document
            .querySelector('input[name="unitshortname"]')
            ?.getAttribute("value")
            ?.trim() ??
          "";

        const amenitiesCategories: Record<string, string[]> = {};
        const amenitiesRoot = document.querySelector(
          "#amenities .info-wrap-body",
        );
        if (amenitiesRoot) {
          const blocks = Array.from(amenitiesRoot.querySelectorAll("p > b"));
          for (const block of blocks) {
            const category = (block.textContent ?? "")
              .replace(/\s+/g, " ")
              .trim();
            if (!category) {
              continue;
            }
            const parent = block.parentElement;
            const nextList = parent?.nextElementSibling;
            if (!nextList || nextList.tagName.toLowerCase() !== "ul") {
              continue;
            }
            const items = Array.from(nextList.querySelectorAll("li"))
              .map((li) => (li.textContent ?? "").replace(/\s+/g, " ").trim())
              .filter(Boolean);
            if (items.length > 0) {
              amenitiesCategories[category] = items;
            }
          }
        }

        const galleryUrls = Array.from(
          document.querySelectorAll('#hiddenGallery a[rel="pdpGallery"][href]'),
        )
          .map((anchor) => (anchor as HTMLAnchorElement).href)
          .filter(Boolean);

        const directionsAddress =
          infoPairs.address ??
          document
            .querySelector(".property-info-item strong")
            ?.parentElement?.textContent?.replace(/\s+/g, " ")
            .trim() ??
          "";

        const propertyId =
          document
            .querySelector('input[name="propertyid"]')
            ?.getAttribute("value")
            ?.trim() ??
          propertyDetailsNode?.getAttribute("data-propertyid")?.trim() ??
          "";
        const unitShortName =
          document
            .querySelector('input[name="unitshortname"]')
            ?.getAttribute("value")
            ?.trim() ??
          document
            .querySelector('input[name="unitcode"]')
            ?.getAttribute("value")
            ?.trim() ??
          "";

        const html = document.documentElement.outerHTML;
        return {
          title: document.title ?? "",
          h1: document.querySelector("h1")?.textContent?.trim() ?? "",
          canonical,
          metaDescription,
          description:
            descriptions.sort((a, b) => b.length - a.length)[0] ?? "",
          descriptionExpanded,
          bodyText,
          infoPairs,
          iconText,
          unitId,
          propertyId,
          unitShortName,
          amenitiesCategories,
          galleryUrls,
          directionsAddress,
          html,
        };
      });

      normalizedAvailability = buildEscapesAvailabilityFromHtml({
        html: extracted.html,
        externalListingId,
        availabilityHorizonDays,
        maxCalendarAdvanceMonths,
        capturedAt: new Date().toISOString(),
      });
    }

    if (!extracted || !normalizedAvailability) {
      throw new Error("failed to extract detail payload");
    }

    const calendarClicks = 0;
    const calendarIterations = normalizedAvailability.days.length > 0 ? 1 : 0;

    const quoteWindowDays = Math.max(
      168,
      Number(
        process.env.SCRAPER_QUOTE_WINDOW_DAYS ??
          process.env.ESCAPES30A_RATES_WINDOW_DAYS ??
          "168",
      ) || 168,
    );
    const quoteSampleStepDays = Math.max(
      7,
      Number(
        process.env.SCRAPER_QUOTE_SAMPLE_STEP_DAYS ??
          process.env.ESCAPES30A_RATES_SAMPLE_STEP_DAYS ??
          "7",
      ) || 7,
    );
    const quoteNightsDefault = Math.max(
      7,
      Number(
        process.env.SCRAPER_QUOTE_NIGHTS ??
          process.env.ESCAPES30A_RATES_QUOTE_NIGHTS ??
          "7",
      ) || 7,
    );
    const quoteMaxQueries = Math.max(
      1,
      Number(
        process.env.SCRAPER_QUOTE_MAX_QUERIES ??
          process.env.ESCAPES30A_RATES_MAX_QUERIES ??
          "24",
      ) || 24,
    );
    const requestedAnchorDateRaw =
      process.env.SCRAPER_QUOTE_ANCHOR_DATE?.trim() ??
      process.env.ESCAPES30A_RATES_ANCHOR_DATE?.trim() ??
      "";
    const requestedAnchorDate =
      /^\d{4}-\d{2}-\d{2}$/.test(requestedAnchorDateRaw) &&
      isSaturdayIsoDate(requestedAnchorDateRaw)
        ? requestedAnchorDateRaw
        : null;
    if (requestedAnchorDateRaw && !requestedAnchorDate) {
      reportDetailProgress?.(
        `detail ${externalListingId} [refresh=${refreshMode} run=${mode}] invalid quote anchor date=${requestedAnchorDateRaw}; expected Saturday YYYY-MM-DD`,
      );
    }

    const assumptionsStore = await readEscapesAssumptions();
    const assumptionsSnapshot: EscapesAssumptionsSnapshot = {
      sample_count: Math.max(
        0,
        Number(assumptionsStore.assumptions?.sample_count ?? 0) || 0,
      ),
      avg_fee_pct_of_base:
        Number(assumptionsStore.assumptions?.avg_fee_pct_of_base ?? 0) || 0,
      avg_tax_pct_of_base:
        Number(assumptionsStore.assumptions?.avg_tax_pct_of_base ?? 0) || 0,
      avg_non_base_pct_of_total:
        Number(assumptionsStore.assumptions?.avg_non_base_pct_of_total ?? 0) ||
        0,
      avg_all_in_multiplier:
        Number(assumptionsStore.assumptions?.avg_all_in_multiplier ?? 0) || 0,
    };
    const existingRateByDate = new Map<string, number>();
    if (existingDetailJsonPath) {
      try {
        const existingRaw = await readFile(existingDetailJsonPath, "utf8");
        const existing = JSON.parse(existingRaw) as {
          normalized_rates?: {
            days?: Array<{ date?: string; nightly_rate?: number | null }>;
          };
        };
        for (const day of existing.normalized_rates?.days ?? []) {
          const date = String(day.date ?? "");
          const nightly = Number(day.nightly_rate);
          if (date && Number.isFinite(nightly) && nightly > 0) {
            existingRateByDate.set(date, roundCurrency(nightly));
          }
        }
      } catch {
        // Ignore prior-rate read failures.
      }
    }

    const windowDays = normalizedAvailability.days.slice(0, quoteWindowDays);
    const sampledSaturdayDays = windowDays.filter((day) =>
      isSaturdayIsoDate(day.date),
    );
    const sampledDays = (
      requestedAnchorDate
        ? sampledSaturdayDays.filter((day) => day.date >= requestedAnchorDate)
        : sampledSaturdayDays
    ).slice(0, quoteMaxQueries);

    const sampledNightlyByDate = new Map<string, number>();
    const quoteObservations: EscapeRateObservation[] = [];
    const shouldCallQuoteApi = mode.includes("quote");

    const existingNightlyValues = Array.from(existingRateByDate.values());
    const fallbackAnchorNightly =
      medianNumber(existingNightlyValues) ??
      roundCurrency(
        Number(process.env.ESCAPES30A_RATES_DERIVED_NIGHTLY_DEFAULT ?? "650") ||
          650,
      );

    const fallbackTaxPct =
      assumptionsSnapshot.avg_tax_pct_of_base > 0
        ? assumptionsSnapshot.avg_tax_pct_of_base
        : 0;
    const fallbackFeePct =
      assumptionsSnapshot.avg_fee_pct_of_base > 0
        ? assumptionsSnapshot.avg_fee_pct_of_base
        : Math.max(
            0,
            assumptionsSnapshot.avg_all_in_multiplier - 1 - fallbackTaxPct,
          );

    const completeObservation = (input: {
      capturedAt: string;
      day: (typeof sampledDays)[number];
      endDate: string;
      nights: number;
      quoteAvailable: boolean;
      quoteUnavailableReason: string | null;
      baseTotal: number | null;
      taxesTotal: number | null;
      feesTotalExclTaxes: number | null;
      feeLines: Array<{ name: string; amount: number }>;
      quotedTotal: number | null;
      handoffUrl: string | null;
    }): EscapeRateObservation => {
      if (!input.quoteAvailable) {
        const sampledNightlyMedian = medianNumber(
          Array.from(sampledNightlyByDate.values()),
        );
        const sourceNightly =
          existingRateByDate.get(input.day.date) ??
          sampledNightlyMedian ??
          fallbackAnchorNightly;

        const inferredBaseFromNightly = roundCurrency(
          sourceNightly * input.nights,
        );

        let baseTotal = coerceMoney(input.baseTotal) ?? inferredBaseFromNightly;
        let taxesTotal = coerceMoney(input.taxesTotal);
        let feesTotalExclTaxes = coerceMoney(input.feesTotalExclTaxes);
        let grandTotal = coerceMoney(input.quotedTotal);

        if (baseTotal <= 0 && grandTotal !== null && grandTotal > 0) {
          const divisor =
            assumptionsSnapshot.avg_all_in_multiplier > 1
              ? assumptionsSnapshot.avg_all_in_multiplier
              : Math.max(1, 1 + fallbackTaxPct + fallbackFeePct);
          baseTotal = roundCurrency(grandTotal / divisor);
        }

        if (taxesTotal === null) {
          taxesTotal = roundCurrency(baseTotal * fallbackTaxPct);
        }
        if (feesTotalExclTaxes === null) {
          feesTotalExclTaxes = roundCurrency(baseTotal * fallbackFeePct);
        }
        if (grandTotal === null) {
          grandTotal = roundCurrency(
            baseTotal + taxesTotal + feesTotalExclTaxes,
          );
        }

        const feePctOfBase = safeRatio(feesTotalExclTaxes, baseTotal);
        const taxPctOfBase = safeRatio(taxesTotal, baseTotal);
        const nonBasePctOfTotal = safeRatio(
          baseTotal !== null && grandTotal !== null
            ? Math.max(0, grandTotal - baseTotal)
            : null,
          grandTotal,
        );
        const allInMultiplier = safeRatio(grandTotal, baseTotal);
        const baseNightly =
          input.nights > 0 && baseTotal !== null
            ? roundCurrency(baseTotal / input.nights)
            : null;
        const allInNightly =
          input.nights > 0 && grandTotal !== null
            ? roundCurrency(grandTotal / input.nights)
            : null;

        return {
          sampled_at: input.capturedAt,
          captured_at: input.capturedAt,
          source_listing_id: externalListingId,
          currency: "USD",
          start_date: input.day.date,
          end_date: input.endDate,
          check_in_date: input.day.date,
          check_out_date: input.endDate,
          nights: input.nights,
          base_nightly: baseNightly,
          all_in_nightly: allInNightly,
          quote_available: false,
          quote_unavailable_reason: input.quoteUnavailableReason,
          base_total: baseTotal,
          taxes_total: taxesTotal,
          fees_total_excl_taxes: feesTotalExclTaxes,
          fee_lines: input.feeLines,
          grand_total: grandTotal,
          quoted_total: grandTotal,
          fee_pct_of_base: feePctOfBase,
          tax_pct_of_base: taxPctOfBase,
          non_base_pct_of_total: nonBasePctOfTotal,
          all_in_multiplier: allInMultiplier,
          handoff_url: input.handoffUrl,
          source: "quote_api",
        };
      }

      const sampledNightlyMedian = medianNumber(
        Array.from(sampledNightlyByDate.values()),
      );
      const sourceNightly =
        existingRateByDate.get(input.day.date) ??
        sampledNightlyMedian ??
        fallbackAnchorNightly;

      const inferredBaseFromNightly = roundCurrency(
        sourceNightly * input.nights,
      );
      let baseTotal = coerceMoney(input.baseTotal) ?? inferredBaseFromNightly;
      let taxesTotal = coerceMoney(input.taxesTotal);
      let feesTotalExclTaxes = coerceMoney(input.feesTotalExclTaxes);
      let grandTotal = coerceMoney(input.quotedTotal);

      if (baseTotal <= 0 && grandTotal !== null && grandTotal > 0) {
        const divisor =
          assumptionsSnapshot.avg_all_in_multiplier > 1
            ? assumptionsSnapshot.avg_all_in_multiplier
            : Math.max(1, 1 + fallbackTaxPct + fallbackFeePct);
        baseTotal = roundCurrency(grandTotal / divisor);
      }

      if (taxesTotal === null) {
        taxesTotal = roundCurrency(baseTotal * fallbackTaxPct);
      }
      if (feesTotalExclTaxes === null) {
        feesTotalExclTaxes = roundCurrency(baseTotal * fallbackFeePct);
      }
      if (grandTotal === null) {
        grandTotal = roundCurrency(baseTotal + taxesTotal + feesTotalExclTaxes);
      }

      const feePctOfBase = safeRatio(feesTotalExclTaxes, baseTotal);
      const taxPctOfBase = safeRatio(taxesTotal, baseTotal);
      const nonBasePctOfTotal = safeRatio(
        Math.max(0, grandTotal - baseTotal),
        grandTotal,
      );
      const allInMultiplier = safeRatio(grandTotal, baseTotal);
      const baseNightly =
        input.nights > 0 ? roundCurrency(baseTotal / input.nights) : null;
      const allInNightly =
        input.nights > 0 ? roundCurrency(grandTotal / input.nights) : null;

      return {
        sampled_at: input.capturedAt,
        captured_at: input.capturedAt,
        source_listing_id: externalListingId,
        currency: "USD",
        start_date: input.day.date,
        end_date: input.endDate,
        check_in_date: input.day.date,
        check_out_date: input.endDate,
        nights: input.nights,
        base_nightly: baseNightly,
        all_in_nightly: allInNightly,
        quote_available: input.quoteAvailable,
        quote_unavailable_reason: input.quoteUnavailableReason,
        base_total: baseTotal,
        taxes_total: taxesTotal,
        fees_total_excl_taxes: feesTotalExclTaxes,
        fee_lines: input.feeLines,
        grand_total: grandTotal,
        quoted_total: grandTotal,
        fee_pct_of_base: feePctOfBase,
        tax_pct_of_base: taxPctOfBase,
        non_base_pct_of_total: nonBasePctOfTotal,
        all_in_multiplier: allInMultiplier,
        handoff_url: input.handoffUrl,
        source: "quote_api",
      };
    };
    if (shouldCallQuoteApi && extracted.propertyId && extracted.unitShortName) {
      reportDetailProgress?.(
        `detail ${externalListingId} [refresh=${refreshMode} run=${mode}] [API_RATE_CALLS] start sample_windows=${sampledDays.length}`,
      );
      for (
        let sampleIndex = 0;
        sampleIndex < sampledDays.length;
        sampleIndex += 1
      ) {
        const day = sampledDays[sampleIndex]!;
        const capturedAt = new Date().toISOString();
        const nights = quoteNightsDefault;
        const endDate = addDaysToIsoDate(day.date, nights);
        reportDetailProgress?.(
          `detail ${externalListingId} [refresh=${refreshMode} run=${mode}] [API_RATE_CALLS] window ${sampleIndex + 1}/${sampledDays.length} ${day.date} -> ${endDate}`,
        );

        const observationRetryDelaysMs = parseObservationRetryDelaysMs(
          process.env.SCRAPER_QUOTE_OBSERVATION_RETRY_DELAYS_MS ??
            process.env.ESCAPES30A_QUOTE_OBSERVATION_RETRY_DELAYS_MS ??
            "",
        );

        let quote: Awaited<ReturnType<typeof fetchEscapesQuote>> | null = null;

        for (
          let observationAttempt = 0;
          observationAttempt < observationRetryDelaysMs.length;
          observationAttempt += 1
        ) {
          const observationDelayMs =
            observationRetryDelaysMs[observationAttempt] ?? 0;
          if (observationDelayMs > 0) {
            await sleep(observationDelayMs);
          }

          try {
            const attemptedQuote = await fetchEscapesQuote({
              propertyId: extracted.propertyId,
              unitShortName: extracted.unitShortName,
              checkInIso: day.date,
              checkOutIso: endDate,
              detailUrl,
              reportProgress: (message) => {
                reportDetailProgress?.(
                  `detail ${externalListingId} [refresh=${refreshMode} run=${mode}] [API_RATE_CALLS] ${day.date}->${endDate}: ${message}`,
                );
              },
            });

            quote = attemptedQuote;
            if (
              attemptedQuote.quoteAvailable ||
              attemptedQuote.unavailableReason === "unavailable"
            ) {
              break;
            }

            if (observationAttempt < observationRetryDelaysMs.length - 1) {
              const nextDelay =
                observationRetryDelaysMs[observationAttempt + 1] ?? 0;
              reportDetailProgress?.(
                `detail ${externalListingId} [refresh=${refreshMode} run=${mode}] [API_RATE_CALLS] observation retry ${observationAttempt + 1}/${observationRetryDelaysMs.length} ${day.date}->${endDate} reason=${attemptedQuote.unavailableReason ?? "unknown"} next_delay_ms=${nextDelay}`,
              );
            }
          } catch {
            if (observationAttempt < observationRetryDelaysMs.length - 1) {
              const nextDelay =
                observationRetryDelaysMs[observationAttempt + 1] ?? 0;
              reportDetailProgress?.(
                `detail ${externalListingId} [refresh=${refreshMode} run=${mode}] [API_RATE_CALLS] observation retry ${observationAttempt + 1}/${observationRetryDelaysMs.length} ${day.date}->${endDate} reason=request_error next_delay_ms=${nextDelay}`,
              );
            }
          }
        }

        try {
          if (!quote) {
            throw new Error("observation retries exhausted");
          }

          day.is_available = quote.quoteAvailable;
          day.is_available_for_checkin = quote.quoteAvailable;
          day.is_available_for_checkout = quote.quoteAvailable;
          day.booking_day_state = quote.quoteAvailable ? "bookable" : "blocked";
          day.status_code = quote.quoteAvailable ? "A" : "U";

          const quoteBaseTotal =
            Number.isFinite(quote.baseTotal) && (quote.baseTotal ?? 0) > 0
              ? roundCurrency(quote.baseTotal ?? 0)
              : null;
          const quoteTaxesTotal =
            Number.isFinite(quote.taxesTotal) && (quote.taxesTotal ?? 0) >= 0
              ? roundCurrency(quote.taxesTotal ?? 0)
              : null;
          const quoteGrandTotal =
            Number.isFinite(quote.quotedTotal) && (quote.quotedTotal ?? 0) > 0
              ? roundCurrency(quote.quotedTotal ?? 0)
              : null;

          const baseTotal = quote.quoteAvailable ? quoteBaseTotal : null;
          const taxesTotal = quote.quoteAvailable ? quoteTaxesTotal : null;
          const feesTotalExclTaxes =
            quote.quoteAvailable &&
            quoteGrandTotal !== null &&
            quoteBaseTotal !== null &&
            quoteTaxesTotal !== null
              ? roundCurrency(
                  Math.max(
                    0,
                    quoteGrandTotal - quoteBaseTotal - quoteTaxesTotal,
                  ),
                )
              : null;
          const grandTotal = quote.quoteAvailable ? quoteGrandTotal : null;
          const nightly =
            quote.quoteAvailable && baseTotal !== null
              ? roundCurrency(baseTotal / nights)
              : null;

          if (nightly !== null && nightly > 0) {
            sampledNightlyByDate.set(day.date, nightly);
          }

          quoteObservations.push(
            completeObservation({
              capturedAt,
              day,
              endDate,
              nights,
              quoteAvailable: quote.quoteAvailable,
              quoteUnavailableReason: quote.quoteAvailable
                ? quote.unavailableReason
                : (quote.unavailableReason ?? "quote_request_failed"),
              baseTotal,
              taxesTotal,
              feesTotalExclTaxes,
              feeLines: quote.feeLines,
              quotedTotal: grandTotal,
              handoffUrl: quote.handoffUrl,
            }),
          );
        } catch {
          quoteObservations.push(
            completeObservation({
              capturedAt,
              day,
              endDate,
              nights,
              quoteAvailable: false,
              quoteUnavailableReason: "quote_request_failed",
              baseTotal: null,
              taxesTotal: null,
              feesTotalExclTaxes: null,
              feeLines: [],
              quotedTotal: null,
              handoffUrl: null,
            }),
          );
        }
      }
      reportDetailProgress?.(
        `detail ${externalListingId} [refresh=${refreshMode} run=${mode}] [API_RATE_CALLS] done observations=${quoteObservations.length} priced_days=${sampledNightlyByDate.size}`,
      );
    }

    const sampledNightlyValues = Array.from(sampledNightlyByDate.values());
    const derivedNightly =
      medianNumber(sampledNightlyValues) ??
      medianNumber(Array.from(existingRateByDate.values())) ??
      roundCurrency(
        Number(process.env.ESCAPES30A_RATES_DERIVED_NIGHTLY_DEFAULT ?? "650") ||
          650,
      );

    const observedAssumptionsSnapshot = buildObservationAssumptionsSnapshot(
      quoteObservations,
      assumptionsSnapshot,
    );

    const normalizedRates: EscapeDetailRecord["normalized_rates"] = {
      source: "pm_30aescapes_quote_api",
      external_listing_id: externalListingId,
      captured_at: new Date().toISOString(),
      currency: "USD",
      quote_window_days: quoteWindowDays,
      quote_sample_step_days: quoteSampleStepDays,
      quote_nights: quoteNightsDefault,
      quote_max_queries: quoteMaxQueries,
      assumptions_sample_count: observedAssumptionsSnapshot.sample_count,
      days: windowDays.map((day) => {
        const sampled = sampledNightlyByDate.get(day.date);
        const existing = existingRateByDate.get(day.date);
        const nightly =
          sampled ?? (day.is_available ? (existing ?? derivedNightly) : null);
        return {
          date: day.date,
          nightly_rate: nightly,
          min_nights: day.min_nights_required ?? null,
          is_booked: day.is_available ? false : true,
          changeover_code: day.status_code,
          season_name: sampled
            ? "quote_api"
            : day.is_available
              ? existing
                ? "quote_derived_existing"
                : "quote_derived_assumptions"
              : "not_available",
        };
      }),
    };

    let quoteObservationsPath: string | null = null;
    if (shouldCallQuoteApi) {
      await mkdir(OUTPUT_DETAILS_QUOTES_DIR, { recursive: true });
      quoteObservationsPath = resolve(
        OUTPUT_DETAILS_QUOTES_DIR,
        `${externalListingId}.json`,
      );

      if (quoteObservations.length === 0) {
        const fallbackDays =
          sampledDays.length > 0
            ? sampledDays.slice(0, quoteMaxQueries)
            : Array.from({ length: quoteMaxQueries }, (_, index) => {
                const captureDate = new Date().toISOString().slice(0, 10);
                const anchorDate =
                  requestedAnchorDate ?? firstSaturdayOnOrAfter(captureDate);
                const date = addDaysToIsoDate(anchorDate, index * 7);
                return {
                  date,
                  status_code: "U" as const,
                  is_available: false,
                  is_available_for_checkin: false,
                  is_available_for_checkout: false,
                  booking_day_state: "blocked" as const,
                  min_nights_required: quoteNightsDefault,
                };
              });
        for (const day of fallbackDays) {
          const capturedAt = new Date().toISOString();
          const nights = quoteNightsDefault;
          const endDate = addDaysToIsoDate(day.date, nights);
          const estimatedBaseTotal = roundCurrency(
            fallbackAnchorNightly * nights,
          );
          const estimatedTaxesTotal = roundCurrency(
            estimatedBaseTotal * fallbackTaxPct,
          );
          const estimatedFeesTotal = roundCurrency(
            estimatedBaseTotal * fallbackFeePct,
          );
          const estimatedGrandTotal = roundCurrency(
            estimatedBaseTotal + estimatedTaxesTotal + estimatedFeesTotal,
          );

          quoteObservations.push(
            completeObservation({
              capturedAt,
              day,
              endDate,
              nights,
              quoteAvailable: false,
              quoteUnavailableReason:
                "quote_unavailable_fallback_estimated_no_api_windows",
              baseTotal: estimatedBaseTotal,
              taxesTotal: estimatedTaxesTotal,
              feesTotalExclTaxes: estimatedFeesTotal,
              feeLines: [],
              quotedTotal: estimatedGrandTotal,
              handoffUrl: null,
            }),
          );
        }
      }

      const sidecarCapturedAt = new Date().toISOString();
      const sidecarCaptureDate = sidecarCapturedAt.slice(0, 10);
      const sidecarAnchorDate =
        requestedAnchorDate ?? firstSaturdayOnOrAfter(sidecarCaptureDate);
      const quoteSidecarRecord: EscapeQuotesSidecarRecord = {
        adapter_key: "30aescapes",
        quote_module_version: THIRTY_A_ESCAPES_QUOTE_MODULE_VERSION,
        external_listing_id: externalListingId,
        detail_url: detailUrl,
        captured_at: sidecarCapturedAt,
        currency: "USD",
        quote_window_cadence: "weekly_sat_to_sat",
        quote_window_gap_policy: "record_unavailable_without_date_shift",
        quote_window_anchor_date: sidecarAnchorDate,
        quote_window_days: quoteWindowDays,
        quote_sample_step_days: quoteSampleStepDays,
        quote_nights: quoteNightsDefault,
        quote_max_queries: quoteMaxQueries,
        observations: quoteObservations,
      };
      assertCanonicalQuotesSidecarRecord(quoteSidecarRecord);
      await writeFile(
        quoteObservationsPath,
        `${JSON.stringify(quoteSidecarRecord, null, 2)}\n`,
        "utf8",
      );
    }

    const ratesRaw: EscapeDetailRecord["rates_raw"] = {
      source: "30aescapes_quote_api",
      endpoint: ESCAPES_QUOTES_ENDPOINT,
      method: "POST",
      quote_signature: {
        formtype: "details-datepicker",
        page: "0",
        redskyclient: "no",
      },
      assumptions_snapshot: observedAssumptionsSnapshot,
      observations_count: quoteObservations.length,
      observations_path: quoteObservationsPath,
      observations: [],
    };

    const name = stripHtml(extracted.h1 || extracted.title).slice(0, 240);
    const description = stripHtml(
      extracted.description || extracted.metaDescription,
    ).slice(0, 20000);
    const descriptionExpanded = stripHtml(
      extracted.descriptionExpanded || extracted.description,
    ).slice(0, 30000);

    const descriptionNormalized = normalizeForMatch(description);
    const titleNormalized = normalizeForMatch(name);

    const normalizedMatchingProfile: EscapeDetailRecord["normalized_matching_profile"] =
      {
        source: "pm_30aescapes",
        external_listing_id: externalListingId,
        name,
        description,
        match_signals: {
          description_normalized: descriptionNormalized,
          description_sha256: hashSha256(descriptionNormalized),
          title_normalized: titleNormalized,
          title_sha256: hashSha256(titleNormalized),
          listing_composite_key: [
            "pm_30aescapes",
            externalListingId,
            hashSha256(descriptionNormalized),
            hashSha256(titleNormalized),
          ].join("::"),
        },
      };

    const iconTextCompact = extracted.iconText.replace(/\s+/g, " ");
    const beds = parseFirstNumber(
      iconTextCompact.match(/(\d+(?:\.\d+)?)\s*Bedrooms?/i)?.[0] ?? "",
    );
    const baths = parseFirstNumber(
      iconTextCompact.match(/Full\s+Baths?\s*:\s*(\d+(?:\.\d+)?)/i)?.[0] ?? "",
    );
    const sleeps = parseFirstNumber(
      iconTextCompact.match(/Sleeps\s*(\d+(?:\.\d+)?)/i)?.[0] ?? "",
    );

    const address = stripHtml(extracted.infoPairs.address ?? "").slice(0, 240);
    const locationLabel = stripHtml(extracted.infoPairs.location ?? "").slice(
      0,
      240,
    );
    const area = locationLabel;
    const cityState = parseCityStateFromAddress(address);

    const propertyProfile: EscapeDetailRecord["property_profile"] = {
      unit_id: stripHtml(extracted.unitId || externalListingId).slice(0, 120),
      area,
      location: locationLabel,
      beds,
      baths,
      sleeps,
      city: cityState.city,
      state: cityState.state,
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
    const amenities: EscapeDetailRecord["amenities"] = {
      categories: amenitiesCategories,
      all: amenitiesAll,
    };

    const mediaUrls = dedupePreserveOrder(
      extracted.galleryUrls
        .map((url) => normalizeGalleryUrl(url))
        .filter(Boolean),
    );
    const mediaGallery: EscapeDetailRecord["media_gallery"] = {
      image_count: mediaUrls.length,
      image_urls: mediaUrls,
    };

    const latLng = extractLatLngFromHtml(extracted.html);
    const location: EscapeDetailRecord["location"] = {
      address,
      location_label: locationLabel,
      directions_url: address
        ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`
        : "",
      directions_daddr: address,
      latitude: latLng?.lat ?? null,
      longitude: latLng?.lng ?? null,
    };

    const htmlPath = resolve(
      OUTPUT_DETAILS_HTML_DIR,
      `${externalListingId}.html`,
    );
    await writeFile(htmlPath, `${extracted.html}\n`, "utf8");

    const extractionMs = Math.max(0, Date.now() - startedAt - pageLoadMs);
    const totalMs = Date.now() - startedAt;

    return {
      external_listing_id: externalListingId,
      detail_url: detailUrl,
      fetched_at: new Date().toISOString(),
      title: stripHtml(extracted.title).slice(0, 240),
      h1: stripHtml(extracted.h1).slice(0, 240),
      canonical_url: extracted.canonical || detailUrl,
      meta_description: stripHtml(extracted.metaDescription).slice(0, 2000),
      description_expanded: descriptionExpanded,
      amenities,
      location,
      media_gallery: mediaGallery,
      property_profile: propertyProfile,
      normalized_matching_profile: normalizedMatchingProfile,
      normalized_availability: normalizedAvailability,
      normalized_rates: normalizedRates,
      rates_raw: ratesRaw,
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
      `[30aescapes] detail pull failed for ${detailUrl}: ${message}`,
    );
    return null;
  } finally {
    if (page) {
      await page.close();
    }
  }
}

export function create30AEscapesAdapter(): ScraperAdapter<EscapeDetailRecord> {
  return {
    managerKey: "30aescapes",
    scriptLabel: "30aescapes",
    defaultAnchorUrl: DEFAULT_ANCHOR_URL,
    detailFetchDelayMs: Math.max(
      0,
      Number(process.env.ESCAPES30A_DETAIL_FETCH_DELAY_MS ?? "150") || 150,
    ),
    detailFetchConcurrency: Math.max(
      1,
      Number(process.env.ESCAPES30A_DETAIL_FETCH_CONCURRENCY ?? "4") || 4,
    ),
    availabilityHorizonDays: Math.max(
      1,
      Number(process.env.ESCAPES30A_AVAILABILITY_HORIZON_DAYS ?? "730") || 730,
    ),
    maxCalendarAdvanceMonths: Math.max(
      6,
      Number(process.env.ESCAPES30A_CALENDAR_MAX_MONTHS ?? "26") || 26,
    ),
    isValidDetailUrl(value: string): string | null {
      try {
        const parsed = new URL(value.trim());
        if (
          !parsed.hostname.endsWith("30aescapes.com") ||
          !isLikelyDetailPath(parsed.pathname)
        ) {
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
        context.refreshMode,
        context.mode,
        context.existingDetailJsonPath,
        context.reportDetailProgress,
      );
    },
    async runQuoteCapture(argv, progress) {
      const normalizedArgs = await normalizeAdapterQuoteScopeArgs(
        "30aescapes",
        argv,
      );
      await runThirtyAEscapesQuoteCli(normalizedArgs, progress);
    },
    async runSingleQuoteObservation(input) {
      const propertyId = (() => {
        if (input.handoffUrl) {
          try {
            const parsed = new URL(input.handoffUrl);
            const value = parsed.searchParams.get("propertyid")?.trim() ?? "";
            if (value) {
              return value;
            }
          } catch {
            // Fall back to listing id if handoff URL parsing fails.
          }
        }
        return input.listingId.trim();
      })();

      if (!propertyId) {
        return {
          elapsedMs: 0,
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
            reason: "missing_property_id",
          },
        };
      }

      const startedAtMs = Date.now();
      const quote = await fetchEscapesQuote({
        propertyId,
        unitShortName: input.listingId,
        checkInIso: input.checkInIso,
        checkOutIso: input.checkOutIso,
        detailUrl: input.detailUrl,
      });
      const elapsedMs = Date.now() - startedAtMs;

      const feesTotalExclTaxes =
        quote.quotedTotal !== null &&
        quote.baseTotal !== null &&
        quote.taxesTotal !== null
          ? roundCurrency(
              quote.quotedTotal - quote.baseTotal - quote.taxesTotal,
            )
          : null;

      return {
        elapsedMs,
        observation: {
          startDate: input.checkInIso,
          endDate: input.checkOutIso,
          quoteAvailable: quote.quoteAvailable,
          currency: quote.quoteAvailable ? "USD" : null,
          baseTotal: quote.baseTotal,
          taxesTotal: quote.taxesTotal,
          feesTotalExclTaxes,
          grandTotal: quote.quotedTotal,
          quotedTotal: quote.quotedTotal,
          handoffUrl: quote.handoffUrl ?? input.handoffUrl ?? null,
          reason: quote.quoteAvailable
            ? null
            : (quote.unavailableReason ?? "quote_unavailable"),
        },
      };
    },
  };
}
