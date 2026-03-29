import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { loadActiveExclusions } from "../shared/exclusion-registry";
import type { DetailRecordBase, ScrapedLink, ScraperAdapter } from "../types";

type KeycoDayCode = "A" | "U" | "M" | "X";

type KeycoAvailabilityCalendarDay = {
  date: string;
  minStay: number | null;
  availabilityKey: KeycoDayCode;
};

type KeycoPricingContextResponse = {
  pricing?: {
    isAvailable?: boolean;
    totalBaseRate?: number | null;
    taxes?: number | null;
    pricingFees?: Array<{
      amount?: number | null;
      description?: string | null;
    }> | null;
    averageBaseRateDescription?: string | null;
    errorMessage?: string | null;
  } | null;
  isAvailable?: boolean;
  totalBaseRate?: number | null;
  averageBaseRateDescription?: string | null;
  errorMessage?: string | null;
};

type KeycoRateObservation = {
  start_date: string;
  end_date: string;
  nights: number;
  status: number;
  is_available: boolean;
  total_base_rate: number | null;
  taxes_total: number | null;
  fees_total_excl_taxes: number | null;
  fee_lines: Array<{
    name: string;
    amount: number;
  }>;
  grand_total: number | null;
  nightly_rate_proxy: number | null;
  average_base_rate_description: string | null;
  error_message: string | null;
  reliability: "window_average_proxy" | "unpriced";
};

type KeycoDetailRecord = DetailRecordBase & {
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
    property_code: string;
    unit_slug: string;
    unit_type: string;
    city: string;
    state: string;
    zip: string;
    beds: number | null;
    baths: number | null;
    sleeps: number | null;
  };
  normalized_matching_profile: {
    source: "pm_keyco30a";
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
    source: "pm_keyco30a";
    external_listing_id: string;
    captured_at: string;
    window_start: string;
    window_end: string;
    code_legend: {
      X: "unknown";
    };
    day_codes: string;
    days: Array<{
      date: string;
      status_code: KeycoDayCode;
      is_available: boolean;
      is_available_for_checkin: boolean;
      is_available_for_checkout: boolean;
      booking_day_state: "bookable" | "blocked" | "unknown";
      min_nights_required?: number | null;
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
    source_note: string;
    has_calendar_widget: boolean;
  };
  normalized_rates: {
    source: "pm_keyco30a";
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
    endpoint_path: string;
    quote_window_days: number;
    quote_sample_step_days: number;
    quote_max_queries: number;
    observations_count: number;
    observations_path: string | null;
    observations: KeycoRateObservation[];
  };
};

const DEFAULT_ANCHOR_URL =
  "https://key.co/search?listing_destination=FL+%7C+Grayton+Beach&listing_destination=FL+%7C+Inlet+Beach&listing_destination=FL+%7C+Santa+Rosa+Beach&listing_destination=FL+%7C+Rosemary+Beach&listing_destination=FL+%7C+Seacrest&listing_destination=FL+%7C+Seagrove+Beach&listing_destination=FL+%7C+Seaside&listing_destination=FL+%7C+WaterSound&listing_destination=FL+%7C+Watercolor&listing_adult_count=1&listing_min_bedrooms=3";

const OUTPUT_ROOT = resolve(
  process.cwd(),
  "src",
  "lib",
  "data",
  "external-sources",
  "keyco30a",
);
const OUTPUT_DETAILS_HTML_DIR = resolve(OUTPUT_ROOT, "details", "html");
const OUTPUT_DETAILS_QUOTES_DIR = resolve(OUTPUT_ROOT, "details", "quotes");

type KeycoQuotesSidecarRecord = {
  adapter_key: "keyco30a";
  external_listing_id: string;
  detail_url: string;
  captured_at: string;
  quote_window_days: number;
  quote_sample_step_days: number;
  quote_max_queries: number;
  observations: KeycoRateObservation[];
};

const EXCLUDED_LISTING_IDS = loadActiveExclusions("keyco30a", ["ra3jpPCp6O"]);

function normalizeLink(url: string): string {
  return url.split("#")[0]?.replace(/\/+$/, "") ?? url;
}

function normalizeDetailUrl(value: string): string | null {
  try {
    const parsed = new URL(value.trim());
    if (!parsed.hostname.endsWith("key.co")) {
      return null;
    }

    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length !== 2 || parts[0] !== "listings") {
      return null;
    }

    const id = parts[1] ?? "";
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
      return null;
    }

    return `${parsed.origin}/listings/${id}`;
  } catch {
    return null;
  }
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
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
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

async function writeKeycoQuotesSidecar(input: {
  externalListingId: string;
  detailUrl: string;
  quoteWindowDays: number;
  quoteSampleStepDays: number;
  quoteMaxQueries: number;
  observations: KeycoRateObservation[];
}): Promise<string> {
  await mkdir(OUTPUT_DETAILS_QUOTES_DIR, { recursive: true });
  const sidecarPath = resolve(
    OUTPUT_DETAILS_QUOTES_DIR,
    `${input.externalListingId}.json`,
  );
  const sidecarRecord: KeycoQuotesSidecarRecord = {
    adapter_key: "keyco30a",
    external_listing_id: input.externalListingId,
    detail_url: input.detailUrl,
    captured_at: new Date().toISOString(),
    quote_window_days: input.quoteWindowDays,
    quote_sample_step_days: input.quoteSampleStepDays,
    quote_max_queries: input.quoteMaxQueries,
    observations: input.observations,
  };
  await writeFile(
    sidecarPath,
    `${JSON.stringify(sidecarRecord, null, 2)}\n`,
    "utf8",
  );
  return sidecarPath;
}

function parseNumberLike(
  value: string | number | null | undefined,
): number | null {
  const numeric = Number(String(value ?? "").trim());
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return numeric;
}

function decodeHtmlEntityString(value: string): string {
  return value
    .replace(/\\u002F/g, "/")
    .replace(/\\u003A/g, ":")
    .replace(/\\u003D/g, "=")
    .replace(/\\u0026/g, "&")
    .replace(/\\\//g, "/")
    .replace(/\\"/g, '"')
    .replace(/\\n/g, " ")
    .replace(/\\r/g, " ")
    .replace(/\\t/g, " ")
    .trim();
}

function formatDateIso(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDaysToIsoDate(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return formatDateIso(date);
}

function toUtcMidnightMs(isoDate: string): number {
  return Date.parse(`${isoDate}T00:00:00Z`);
}

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

function isSaturdayIsoDate(isoDate: string): boolean {
  const day = new Date(`${isoDate}T00:00:00Z`).getUTCDay();
  return day === 6;
}

function inferCityStateFromText(value: string): {
  city: string;
  state: string;
} {
  const normalized = value.replace(/\s+/g, " ");
  const match = normalized.match(/\bin\s+([A-Za-z .'-]{2,40}),\s*(FL)\b/i);
  if (!match) {
    return { city: "", state: "FL" };
  }

  return {
    city: (match[1] ?? "").trim(),
    state: (match[2] ?? "FL").toUpperCase(),
  };
}

function dedupe(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = raw.trim();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    out.push(value);
  }
  return out;
}

function parseAvailabilityCalendarFromHtml(
  html: string,
): KeycoAvailabilityCalendarDay[] {
  const parseArrayCandidate = (candidate: string): unknown => {
    try {
      return JSON.parse(candidate);
    } catch {
      try {
        return JSON.parse(decodeHtmlEntityString(candidate));
      } catch {
        return null;
      }
    }
  };

  const extractArray = (source: string): unknown => {
    const patterns = [
      /"availabilityCalendar"\s*:\s*(\[[\s\S]*?\])(?=\s*,\s*"[^"]+"\s*:|\s*[}\]])/,
      /\\"availabilityCalendar\\"\s*:\s*(\[[\s\S]*?\])(?=\s*,\s*\\"[^"]+\\"\s*:|\s*[}\]])/,
    ];

    for (const pattern of patterns) {
      const match = source.match(pattern);
      if (!match?.[1]) {
        continue;
      }
      const parsed = parseArrayCandidate(match[1]);
      if (parsed) {
        return parsed;
      }
    }

    return null;
  };

  const parsed =
    extractArray(html) ?? extractArray(decodeHtmlEntityString(html));

  if (!Array.isArray(parsed)) {
    return [];
  }

  const days: KeycoAvailabilityCalendarDay[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const maybeDate = String((entry as { date?: unknown }).date ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(maybeDate)) {
      continue;
    }

    const rawKey = String(
      (entry as { availabilityKey?: unknown }).availabilityKey ?? "",
    ).trim();
    const availabilityKey: KeycoDayCode =
      rawKey === "A" || rawKey === "U" || rawKey === "M" ? rawKey : "X";

    const rawMinStay = Number((entry as { minStay?: unknown }).minStay);
    const minStay =
      Number.isFinite(rawMinStay) && rawMinStay > 0
        ? Math.floor(rawMinStay)
        : null;

    days.push({
      date: maybeDate,
      minStay,
      availabilityKey,
    });
  }

  return days;
}

async function fetchPricingContext(
  listingId: string,
  startDate: string,
  endDate: string,
): Promise<{
  status: number;
  body: KeycoPricingContextResponse | null;
}> {
  const params = new URLSearchParams({
    startDate,
    endDate,
    adultCount: "1",
    childCount: "0",
    infantCount: "0",
    petCount: "0",
  });

  const endpoint = new URL(
    `/api/listing/${listingId}/pricing-context`,
    "https://key.co",
  );
  endpoint.search = params.toString();

  const response = await fetch(endpoint.toString(), {
    method: "GET",
    headers: {
      accept: "application/json, text/plain, */*",
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
    },
  });

  const text = await response.text();
  if (!text) {
    return { status: response.status, body: null };
  }

  try {
    return {
      status: response.status,
      body: JSON.parse(text) as KeycoPricingContextResponse,
    };
  } catch {
    return { status: response.status, body: null };
  }
}

function buildDescriptionExpanded(candidates: string[]): string {
  const normalized = dedupe(
    candidates
      .map((value) => stripHtml(value))
      .map((value) => value.replace(/\s+/g, " ").trim())
      .filter(Boolean),
  );

  if (normalized.length === 0) {
    return "";
  }

  const selected: string[] = [];
  for (const candidate of normalized) {
    if (selected.some((existing) => existing.includes(candidate))) {
      continue;
    }
    selected.push(candidate);

    const joinedLength = selected.join(" ").length;
    if (joinedLength >= 900 || selected.length >= 3) {
      break;
    }
  }

  return selected.join(" ").slice(0, 20000);
}

function inferCoordinatesFromText(text: string): {
  latitude: number;
  longitude: number;
} | null {
  const normalized = text.toLowerCase();
  const knownAreas: Array<{
    keyword: string;
    latitude: number;
    longitude: number;
  }> = [
    { keyword: "gulf place", latitude: 30.319, longitude: -86.166 },
    { keyword: "seacrest", latitude: 30.275, longitude: -86.04 },
    { keyword: "seagrove", latitude: 30.311, longitude: -86.136 },
    { keyword: "rosemary", latitude: 30.286, longitude: -86.017 },
    { keyword: "watersound", latitude: 30.273, longitude: -86.006 },
    { keyword: "watercolor", latitude: 30.317, longitude: -86.131 },
    { keyword: "grayton", latitude: 30.329, longitude: -86.163 },
    { keyword: "inlet beach", latitude: 30.278, longitude: -86.003 },
    { keyword: "santa rosa beach", latitude: 30.396, longitude: -86.228 },
  ];

  for (const area of knownAreas) {
    if (normalized.includes(area.keyword)) {
      return { latitude: area.latitude, longitude: area.longitude };
    }
  }

  return null;
}

function buildSearchPageUrl(anchorUrl: string, pageNumber: number): string {
  const parsed = new URL(anchorUrl);
  parsed.searchParams.set("page", String(pageNumber));
  return parsed.toString();
}

async function discoverListings(
  page: Parameters<
    ScraperAdapter<KeycoDetailRecord>["discoverListings"]
  >[0]["page"],
  anchorUrl: string,
  maxScrollSteps: number,
  scrollPauseMs: number,
  _networkIdleWaitMs: number,
  reportProgress: (message: string) => void,
): Promise<ScrapedLink[]> {
  const effectiveMaxPages = Math.max(8, Math.min(40, maxScrollSteps));
  const results = new Map<string, string>();
  let discoveredExpectedCount: number | null = null;

  let noGrowthRounds = 0;
  let pageNumber = 1;

  await page.goto(anchorUrl, {
    waitUntil: "domcontentloaded",
    timeout: 120000,
  });

  for (; pageNumber <= effectiveMaxPages; pageNumber += 1) {
    await page.waitForTimeout(Math.max(1200, scrollPauseMs));

    let links: string[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      links = await page.evaluate(() =>
        Array.from(document.querySelectorAll("a[href*='/listings/']"))
          .map((anchor) => (anchor as HTMLAnchorElement).href || "")
          .filter(Boolean),
      );

      if (links.length > 0) {
        break;
      }

      if (attempt === 2 || attempt === 5) {
        await page.evaluate(() => {
          window.scrollTo(0, document.body.scrollHeight);
          window.scrollTo(0, 0);
        });
      }

      await page.waitForTimeout(Math.max(350, Math.floor(scrollPauseMs / 2)));
    }

    let added = 0;
    for (const link of links) {
      const normalized = normalizeDetailUrl(link);
      if (!normalized || results.has(normalized)) {
        continue;
      }
      results.set(normalized, page.url());
      added += 1;
    }

    if (discoveredExpectedCount === null) {
      const homesText = await page.evaluate(() => {
        const match =
          (document.body?.innerText || "").match(
            /\b\d+\s+homes in selected locations\b/i,
          )?.[0] || "";
        return match;
      });
      const parsed = Number((homesText.match(/\d+/) || [""])[0]);
      if (Number.isFinite(parsed) && parsed > 0) {
        discoveredExpectedCount = Math.floor(parsed);
      }
    }

    reportProgress(
      `keyco discovery page=${pageNumber}, captured=${results.size}, added=${added}, expected~${discoveredExpectedCount ?? "dynamic"}`,
    );

    if (added === 0) {
      noGrowthRounds += 1;
    } else {
      noGrowthRounds = 0;
    }

    if (
      discoveredExpectedCount !== null &&
      results.size >= discoveredExpectedCount
    ) {
      break;
    }

    // Keyco occasionally has sparse/duplicate pages before continuing growth.
    // Allow a longer plateau before we decide pagination is exhausted.
    if (pageNumber >= 10 && noGrowthRounds >= 6) {
      break;
    }

    const nextPage = pageNumber + 1;
    const clickedNext = await page.evaluate((targetPage) => {
      const controls = Array.from(
        document.querySelectorAll("a, button, [role='button']"),
      ) as HTMLElement[];

      for (const control of controls) {
        if (control.offsetParent === null) {
          continue;
        }

        const href = (control.getAttribute("href") || "").trim();
        if (!href) {
          continue;
        }

        try {
          const absolute = new URL(href, window.location.href);
          const pageParam = Number(absolute.searchParams.get("page") || "");
          if (Number.isFinite(pageParam) && pageParam === targetPage) {
            control.click();
            return true;
          }
        } catch {
          // Ignore malformed href.
        }
      }

      for (const control of controls) {
        if (control.offsetParent === null) {
          continue;
        }

        if (
          control.getAttribute("disabled") !== null ||
          control.getAttribute("aria-disabled") === "true" ||
          control.className.toLowerCase().includes("disabled")
        ) {
          continue;
        }

        const text = [
          control.textContent || "",
          control.getAttribute("aria-label") || "",
          control.getAttribute("title") || "",
        ]
          .join(" ")
          .toLowerCase()
          .replace(/\s+/g, " ")
          .trim();

        if (
          text === "next" ||
          text.includes(" next") ||
          text.includes("next page")
        ) {
          control.click();
          return true;
        }
      }

      return false;
    }, nextPage);

    if (clickedNext) {
      await page.waitForTimeout(Math.max(900, scrollPauseMs));
      continue;
    }

    try {
      await page.goto(buildSearchPageUrl(anchorUrl, nextPage), {
        waitUntil: "domcontentloaded",
        timeout: 120000,
      });
      await page.waitForTimeout(Math.max(900, scrollPauseMs));
    } catch {
      break;
    }
  }

  return Array.from(results.keys())
    .sort((left, right) => left.localeCompare(right))
    .map((link) => ({
      link,
      source_url: results.get(link) ?? anchorUrl,
      anchor_text: "search-page",
    }));
}

function collectServiceImageUrls(html: string): string[] {
  const matches = Array.from(
    html.matchAll(
      /https:\/\/service-images\.key\.co\/service-images\/[^"'\s)]+/g,
    ),
  )
    .map((match) => decodeHtmlEntityString(match[0]))
    .map((value) => value.replace(/\\+$/, ""))
    .filter((value) =>
      value.startsWith("https://service-images.key.co/service-images/"),
    );

  return dedupe(matches);
}

function extractLatLngFromHtml(html: string): {
  latitude: number | null;
  longitude: number | null;
} {
  const latCandidates = Array.from(
    html.matchAll(/\\?"lat(?:itude)?\\?"\s*:\s*(-?\d{1,2}(?:\.\d+)?)/gi),
  )
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value) && value >= -90 && value <= 90);

  const lonCandidates = Array.from(
    html.matchAll(
      /\\?"(?:lon(?:gitude)?|lng)\\?"\s*:\s*(-?\d{1,3}(?:\.\d+)?)/gi,
    ),
  )
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value) && value >= -180 && value <= 180);

  // Prefer Florida-like coordinates first for 30A listings, then fall back to any valid pair.
  const floridaLat = latCandidates.find((value) => value >= 24 && value <= 32);
  const floridaLon = lonCandidates.find(
    (value) => value >= -88 && value <= -79,
  );

  const latitude = floridaLat ?? latCandidates[0] ?? null;
  const longitude = floridaLon ?? lonCandidates[0] ?? null;

  return { latitude, longitude };
}

async function fetchDetail(
  browser: Parameters<
    ScraperAdapter<KeycoDetailRecord>["fetchDetail"]
  >[0]["browser"],
  detailUrl: string,
  availabilityHorizonDays: number,
  refreshMode: "full" | "dynamic" | "static",
  existingDetailJsonPath?: string | null,
  reportDetailProgress?: (message: string) => void,
): Promise<KeycoDetailRecord | null> {
  const normalizedDetailUrl = normalizeDetailUrl(detailUrl);
  if (!normalizedDetailUrl) {
    return null;
  }

  const externalListingId =
    normalizeLink(normalizedDetailUrl).split("/").filter(Boolean).at(-1) ||
    "unknown";

  if (EXCLUDED_LISTING_IDS.has(externalListingId)) {
    return null;
  }

  const logStage = (stage: string, message: string): void => {
    if (!reportDetailProgress) {
      return;
    }
    reportDetailProgress(
      `detail ${externalListingId} [mode=${refreshMode}] [${stage}] ${message}`,
    );
  };

  if (refreshMode === "dynamic" && existingDetailJsonPath) {
    try {
      logStage("PAGE_HTML_PULL", "skipped (dynamic mode)");
      logStage("PAGE_SCRAPE", "skipped (dynamic mode)");
      logStage(
        "API_AVAIL_REFRESH",
        "start (pricing-context window availability)",
      );

      const existingRaw = await readFile(existingDetailJsonPath, "utf8");
      const existing = JSON.parse(existingRaw) as KeycoDetailRecord;

      const now = new Date();
      const todayUtc = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
      );
      const horizonUtc = new Date(todayUtc);
      horizonUtc.setUTCDate(
        todayUtc.getUTCDate() + Math.max(availabilityHorizonDays, 365),
      );

      const baselineAvailabilityByDate = new Map(
        (existing.normalized_availability?.days ?? []).map(
          (day) => [day.date, day] as const,
        ),
      );

      const availabilityDays: KeycoDetailRecord["normalized_availability"]["days"] =
        [];
      for (
        const cursor = new Date(todayUtc);
        cursor <= horizonUtc;
        cursor.setUTCDate(cursor.getUTCDate() + 1)
      ) {
        const isoDate = formatDateIso(cursor);
        const baseline = baselineAvailabilityByDate.get(isoDate);
        const statusCode: KeycoDayCode =
          baseline?.status_code === "A" ||
          baseline?.status_code === "U" ||
          baseline?.status_code === "M"
            ? baseline.status_code
            : "X";

        availabilityDays.push({
          date: isoDate,
          status_code: statusCode,
          is_available: statusCode === "A",
          is_available_for_checkin: statusCode === "A",
          is_available_for_checkout: statusCode === "A",
          booking_day_state:
            statusCode === "A"
              ? "bookable"
              : statusCode === "U"
                ? "blocked"
                : "unknown",
          min_nights_required: baseline?.min_nights_required ?? null,
        });
      }

      const ratesWindowDays = Math.max(
        168,
        Number(process.env.KEYCO30A_RATES_WINDOW_DAYS ?? "168") || 168,
      );
      const ratesSampleStepDays = Math.max(
        7,
        Number(process.env.KEYCO30A_RATES_SAMPLE_STEP_DAYS ?? "7") || 7,
      );
      const targetQuoteNights = Math.max(
        7,
        Number(process.env.KEYCO30A_RATES_QUOTE_NIGHTS ?? "7") || 7,
      );
      const ratesMaxQueries = Math.max(
        1,
        Number(process.env.KEYCO30A_RATES_MAX_QUERIES ?? "24") || 24,
      );
      const ratesTargetQueries = Math.max(
        1,
        Math.ceil(ratesWindowDays / ratesSampleStepDays),
      );
      const effectiveRatesMaxQueries = Math.min(
        ratesMaxQueries,
        ratesTargetQueries,
      );
      const ratesWindowEndIso = formatDateIso(
        new Date(
          Date.UTC(
            todayUtc.getUTCFullYear(),
            todayUtc.getUTCMonth(),
            todayUtc.getUTCDate() + ratesWindowDays - 1,
          ),
        ),
      );

      const availabilityByDate = new Map(
        availabilityDays.map((day) => [day.date, day] as const),
      );

      const normalizedRateDays: KeycoDetailRecord["normalized_rates"]["days"] =
        availabilityDays
          .filter((day) => day.date <= ratesWindowEndIso)
          .map((day) => ({
            date: day.date,
            nightly_rate: null,
            min_nights: day.min_nights_required ?? null,
            is_booked: day.is_available ? false : true,
            changeover_code: day.status_code,
            season_name: day.is_available ? "quote_pending" : "not_available",
          }));

      const rateObservations: KeycoRateObservation[] = [];
      const sampleDays: Array<(typeof normalizedRateDays)[number]> = [];
      for (
        let cursor = 0;
        cursor < normalizedRateDays.length &&
        sampleDays.length < effectiveRatesMaxQueries;
        cursor += ratesSampleStepDays
      ) {
        let picked: (typeof normalizedRateDays)[number] | null = null;
        const endExclusive = Math.min(
          normalizedRateDays.length,
          cursor + ratesSampleStepDays,
        );

        for (let idx = cursor; idx < endExclusive; idx += 1) {
          const candidate = normalizedRateDays[idx];
          if (!candidate) {
            continue;
          }
          const day = availabilityByDate.get(candidate.date);
          if (!day) {
            continue;
          }
          if (isSaturdayIsoDate(candidate.date)) {
            picked = candidate;
            break;
          }
          if (!picked) {
            picked = candidate;
          }
        }

        if (!picked) {
          continue;
        }

        if (sampleDays.at(-1)?.date === picked.date) {
          continue;
        }

        sampleDays.push(picked);
      }

      const sampledRatesByDate = new Map<string, number>();
      logStage(
        "API_RATE_CALLS",
        `start sample_windows=${sampleDays.length} max_queries=${effectiveRatesMaxQueries}`,
      );
      for (const sampleDay of sampleDays) {
        const day = availabilityByDate.get(sampleDay.date);
        if (!day) {
          continue;
        }

        const nights = Math.max(
          targetQuoteNights,
          day.min_nights_required ?? 0,
        );
        const endDate = addDaysToIsoDate(day.date, nights);
        const pricing = await fetchPricingContext(
          externalListingId,
          day.date,
          endDate,
        );
        const body = pricing.body;
        const pricingNode =
          body?.pricing && typeof body.pricing === "object"
            ? body.pricing
            : body;
        const totalBaseRate = Number(pricingNode?.totalBaseRate);
        const hasRate = Number.isFinite(totalBaseRate) && totalBaseRate > 0;
        const isAvailable =
          typeof pricingNode?.isAvailable === "boolean"
            ? pricingNode.isAvailable
            : typeof body?.isAvailable === "boolean"
              ? body.isAvailable
              : hasRate;

        day.status_code = isAvailable ? "A" : "U";
        day.is_available = isAvailable;
        day.is_available_for_checkin = isAvailable;
        day.is_available_for_checkout = isAvailable;
        day.booking_day_state = isAvailable ? "bookable" : "blocked";
        sampleDay.changeover_code = day.status_code;
        sampleDay.is_booked = !isAvailable;

        const taxesTotalRaw = Number(pricingNode?.taxes);
        const taxesTotal =
          Number.isFinite(taxesTotalRaw) && taxesTotalRaw >= 0
            ? taxesTotalRaw
            : null;
        const feeLines = Array.isArray(pricingNode?.pricingFees)
          ? pricingNode.pricingFees
              .map((line) => {
                const name = String(line?.description ?? "").trim();
                const amount = Number(line?.amount);
                if (!name || !Number.isFinite(amount) || amount < 0) {
                  return null;
                }
                return { name, amount: roundCurrency(amount) };
              })
              .filter(
                (
                  line,
                ): line is {
                  name: string;
                  amount: number;
                } => Boolean(line),
              )
          : [];
        const feesTotalExclTaxes =
          feeLines.length > 0
            ? roundCurrency(
                feeLines.reduce((sum, feeLine) => sum + feeLine.amount, 0),
              )
            : null;
        const grandTotal =
          hasRate && taxesTotal !== null && feesTotalExclTaxes !== null
            ? roundCurrency(totalBaseRate + taxesTotal + feesTotalExclTaxes)
            : null;

        const nightlyRateProxy = hasRate
          ? roundCurrency(totalBaseRate / nights)
          : null;

        if (nightlyRateProxy !== null && isAvailable) {
          sampledRatesByDate.set(day.date, nightlyRateProxy);
          sampleDay.nightly_rate = nightlyRateProxy;
          sampleDay.season_name = "quote_weekly_sample";
        } else {
          sampleDay.season_name = isAvailable
            ? "quote_unavailable"
            : "not_available";
        }

        rateObservations.push({
          start_date: day.date,
          end_date: endDate,
          nights,
          status: pricing.status,
          is_available: isAvailable,
          total_base_rate: hasRate ? totalBaseRate : null,
          taxes_total: taxesTotal,
          fees_total_excl_taxes: feesTotalExclTaxes,
          fee_lines: feeLines,
          grand_total: grandTotal,
          nightly_rate_proxy: nightlyRateProxy,
          average_base_rate_description:
            typeof pricingNode?.averageBaseRateDescription === "string"
              ? pricingNode.averageBaseRateDescription
              : null,
          error_message:
            typeof pricingNode?.errorMessage === "string"
              ? pricingNode.errorMessage
              : null,
          reliability:
            nightlyRateProxy !== null ? "window_average_proxy" : "unpriced",
        });
      }
      logStage(
        "API_RATE_CALLS",
        `done calls=${rateObservations.length} sampled_rates=${sampledRatesByDate.size}`,
      );

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
          rateDay.nightly_rate = roundCurrency(
            prevPoint.nightlyRate +
              (nextPoint.nightlyRate - prevPoint.nightlyRate) * ratio,
          );
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

      const collectedRates = normalizedRateDays
        .map((day) => day.nightly_rate)
        .filter((value): value is number => Number.isFinite(value));
      const minRate = collectedRates.length
        ? Math.min(...collectedRates)
        : null;
      const maxRate = collectedRates.length
        ? Math.max(...collectedRates)
        : null;
      const avgRate = collectedRates.length
        ? Math.round(
            (collectedRates.reduce((sum, value) => sum + value, 0) /
              collectedRates.length) *
              100,
          ) / 100
        : null;

      const dayCodes = availabilityDays.map((day) => day.status_code).join("");
      const counts = {
        available: availabilityDays.filter((day) => day.status_code === "A")
          .length,
        unavailable: availabilityDays.filter((day) => day.status_code === "U")
          .length,
        checkin_only: 0,
        checkout_only: 0,
        other: availabilityDays.filter(
          (day) => day.status_code === "M" || day.status_code === "X",
        ).length,
        booking_available: availabilityDays.filter(
          (day) => day.booking_day_state === "bookable",
        ).length,
        booking_unavailable: availabilityDays.filter(
          (day) => day.booking_day_state === "blocked",
        ).length,
        booking_unknown: availabilityDays.filter(
          (day) => day.booking_day_state === "unknown",
        ).length,
      };
      logStage(
        "API_AVAIL_REFRESH",
        `done available=${counts.available} unavailable=${counts.unavailable} other=${counts.other}`,
      );
      const observationsPath = await writeKeycoQuotesSidecar({
        externalListingId,
        detailUrl: normalizedDetailUrl,
        quoteWindowDays: ratesWindowDays,
        quoteSampleStepDays: ratesSampleStepDays,
        quoteMaxQueries: effectiveRatesMaxQueries,
        observations: rateObservations,
      });

      return {
        ...existing,
        fetched_at: new Date().toISOString(),
        normalized_availability: {
          ...existing.normalized_availability,
          source: "pm_keyco30a",
          external_listing_id: externalListingId,
          captured_at: new Date().toISOString(),
          window_start: availabilityDays[0]?.date ?? "",
          window_end: availabilityDays[availabilityDays.length - 1]?.date ?? "",
          code_legend: {
            A: "available",
            U: "unavailable",
            M: "restricted_or_rule_constrained",
            X: "unknown",
          },
          day_codes: dayCodes,
          days: availabilityDays,
          counts,
        },
        availability_raw: {
          source_note:
            "Dynamic refresh reused existing static detail + baseline availability and refreshed weekly sampled availability/rates via pricing-context API.",
          has_calendar_widget:
            typeof existing.availability_raw?.has_calendar_widget === "boolean"
              ? existing.availability_raw.has_calendar_widget
              : true,
        },
        normalized_rates: {
          source: "pm_keyco30a",
          external_listing_id: externalListingId,
          captured_at: new Date().toISOString(),
          currency: existing.normalized_rates?.currency ?? "USD",
          window_start: normalizedRateDays[0]?.date ?? "",
          window_end:
            normalizedRateDays[normalizedRateDays.length - 1]?.date ?? "",
          days: normalizedRateDays,
          stats: {
            days_with_rate: collectedRates.length,
            min_nightly_rate: minRate,
            max_nightly_rate: maxRate,
            avg_nightly_rate: avgRate,
          },
        },
        rates_raw: {
          endpoint_path: `/api/listing/${externalListingId}/pricing-context`,
          quote_window_days: ratesWindowDays,
          quote_sample_step_days: ratesSampleStepDays,
          quote_max_queries: effectiveRatesMaxQueries,
          observations_count: rateObservations.length,
          observations_path: observationsPath,
          observations: [],
        },
      };
    } catch {
      logStage(
        "DYNAMIC_BASELINE",
        "baseline detail missing/invalid; dynamic mode will fallback to full path",
      );
      // Fallback to full scrape path when baseline detail is missing or invalid.
    }
  }

  logStage("PAGE_HTML_PULL", "start");
  const page = await browser.newPage();

  try {
    await page.goto(normalizedDetailUrl, {
      waitUntil: "domcontentloaded",
      timeout: 120000,
    });
    await page.waitForTimeout(1300);
    logStage("PAGE_HTML_PULL", "done");
    logStage("PAGE_SCRAPE", "start");

    for (let cycle = 0; cycle < 4; cycle += 1) {
      const clicks = await page.evaluate(() => {
        const needles = [
          "read more",
          "show all amenities",
          "view all photos",
          "show more",
        ];

        let count = 0;
        const controls = Array.from(
          document.querySelectorAll("button, a, [role='button']"),
        );

        for (const control of controls) {
          const element = control as HTMLElement;
          if (element.offsetParent === null) {
            continue;
          }

          if (
            element.getAttribute("disabled") !== null ||
            element.getAttribute("aria-disabled") === "true"
          ) {
            continue;
          }

          const text =
            `${element.textContent || ""} ${element.getAttribute("aria-label") || ""}`
              .toLowerCase()
              .replace(/\s+/g, " ")
              .trim();

          if (needles.some((needle) => text.includes(needle))) {
            element.click();
            count += 1;
          }
        }

        return count;
      });

      if (clicks === 0) {
        break;
      }
      await page.waitForTimeout(250);
    }

    const html = await page.content();

    const extracted = await page.evaluate(() => {
      const title = document.title || "";
      const h1 = (document.querySelector("h1")?.textContent || "")
        .replace(/\s+/g, " ")
        .trim();

      const metaDescription = (
        document
          .querySelector('meta[name="description"]')
          ?.getAttribute("content") || ""
      )
        .replace(/\s+/g, " ")
        .trim();

      const canonicalUrl =
        document.querySelector('link[rel="canonical"]')?.getAttribute("href") ||
        location.href;

      const bodyText = (document.body?.innerText || "").replace(/\u00a0/g, " ");

      const descriptionCandidates = bodyText
        .split(/\n+/)
        .map((line) => line.replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .filter((line) => line.length >= 120)
        .filter((line) => !/^\$/.test(line));

      const amenityCandidates = Array.from(
        document.querySelectorAll("li, button, span, div"),
      )
        .map((node) => (node.textContent || "").replace(/\s+/g, " ").trim())
        .filter((text) => text.length >= 3 && text.length <= 100)
        .filter((text) =>
          /pool|wifi|air conditioning|kitchen|washer|dryer|parking|beach|grill|hot tub|balcony|outdoor|pets|tv|heating|elevator|internet/i.test(
            text,
          ),
        );

      const locationCandidates = bodyText
        .split(/\n+/)
        .map((line) => line.replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .filter((line) => /\b[A-Za-z .'-]+,\s*FL\b/i.test(line))
        .slice(0, 12);

      const hasCalendarWidget = /availability|calendar/i.test(bodyText);

      const imageCandidates: string[] = [];
      for (const image of Array.from(document.querySelectorAll("img"))) {
        const src = image.getAttribute("src") || "";
        if (src) {
          imageCandidates.push(src);
        }

        const srcset = image.getAttribute("srcset") || "";
        if (srcset) {
          const entries = srcset
            .split(",")
            .map((part) => part.trim().split(/\s+/)[0] || "")
            .filter(Boolean);
          imageCandidates.push(...entries);
        }
      }

      return {
        title,
        h1,
        canonicalUrl,
        metaDescription,
        descriptionCandidates,
        amenityCandidates,
        locationCandidates,
        imageCandidates,
        hasCalendarWidget,
      };
    });
    logStage("PAGE_SCRAPE", "done");

    const normalizedTitle = stripHtml(extracted.title).slice(0, 240);
    const normalizedH1 = stripHtml(extracted.h1).slice(0, 240);
    const canonicalUrl =
      normalizeDetailUrl(extracted.canonicalUrl) || normalizedDetailUrl;
    const metaDescription = stripHtml(extracted.metaDescription).slice(0, 2000);

    const regexDescriptionCandidates = Array.from(
      html.matchAll(/"description"\s*:\s*"([^"]{120,4000})"/gi),
    ).map((match) => decodeHtmlEntityString(match[1] || ""));

    const allDescriptionCandidates = [
      ...extracted.descriptionCandidates,
      ...regexDescriptionCandidates,
      metaDescription,
    ]
      .filter(Boolean)
      .sort((left, right) => right.length - left.length);

    const descriptionExpanded = buildDescriptionExpanded(
      allDescriptionCandidates,
    );

    const rawAmenityTokens = dedupe(
      extracted.amenityCandidates
        .flatMap((value) => value.split(/[,|/]|(?<=[a-z])(?=[A-Z])/g))
        .map((value) => stripHtml(value))
        .map((value) => value.replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .filter((value) => value.length >= 3 && value.length <= 60)
        .filter(
          (value) => !/^(read more|show more|view all photos)$/i.test(value),
        ),
    );

    const amenitiesAll = rawAmenityTokens
      .filter((value) =>
        /pool|wifi|air conditioning|kitchen|washer|dryer|parking|beach|grill|hot tub|balcony|outdoor|pets|tv|heating|elevator|internet/i.test(
          value,
        ),
      )
      .slice(0, 120);

    const amenitiesCategories: Record<string, string[]> = {
      Features: amenitiesAll,
    };

    const detailUrlObject = new URL(normalizedDetailUrl);

    const imageUrlsFromDom = extracted.imageCandidates
      .map((raw) => {
        const cleaned = decodeHtmlEntityString(raw);
        if (!cleaned) {
          return "";
        }

        if (cleaned.startsWith("/_next/image?")) {
          try {
            const nextImageUrl = new URL(cleaned, detailUrlObject.origin);
            const source = nextImageUrl.searchParams.get("url") || "";
            if (source) {
              return decodeURIComponent(source);
            }
          } catch {
            return "";
          }
        }

        try {
          return new URL(cleaned, detailUrlObject.origin).toString();
        } catch {
          return "";
        }
      })
      .filter(
        (value) =>
          value.startsWith("https://service-images.key.co/service-images/") ||
          value.includes("cloudfront.net"),
      );

    const imageUrls = dedupe([
      ...collectServiceImageUrls(html),
      ...imageUrlsFromDom,
    ]);

    const coordinates = extractLatLngFromHtml(html);
    const fallbackCoordinates = inferCoordinatesFromText(
      `${descriptionExpanded} ${metaDescription} ${extracted.locationCandidates.join(" ")}`,
    );

    const parsedCityState = inferCityStateFromText(
      `${descriptionExpanded} ${metaDescription} ${extracted.locationCandidates.join(" ")}`,
    );

    const locationLabel =
      extracted.locationCandidates.find((value) => /\bFL\b/i.test(value)) ||
      (parsedCityState.city
        ? `${parsedCityState.city}, ${parsedCityState.state}`
        : "");

    const address =
      extracted.locationCandidates.find((value) => value.length >= 8) ||
      locationLabel ||
      `${parsedCityState.city || "30A"}, ${parsedCityState.state || "FL"}`;

    const directionsDaddr = address;

    const name = stripHtml(normalizedH1 || normalizedTitle).slice(0, 240);
    const description = descriptionExpanded || metaDescription;

    const descriptionNormalized = normalizeForMatch(description);
    const titleNormalized = normalizeForMatch(name);

    const city = parsedCityState.city;
    const state = parsedCityState.state || "FL";

    const beds = parseNumberLike(
      extractFirst(
        /\b(\d+(?:\.\d+)?)\s*bed(?:room)?s?\b/i,
        `${description} ${metaDescription}`,
      ),
    );
    const baths = parseNumberLike(
      extractFirst(
        /\b(\d+(?:\.\d+)?)\s*bath(?:room)?s?\b/i,
        `${description} ${metaDescription}`,
      ),
    );
    const sleeps = parseNumberLike(
      extractFirst(
        /\b(?:sleeps?|guests?)\s*(\d+)\b/i,
        `${description} ${metaDescription}`,
      ) ||
        extractFirst(
          /\b(\d+)\s*guests?\b/i,
          `${description} ${metaDescription}`,
        ),
    );

    const now = new Date();
    const todayUtc = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const horizonUtc = new Date(todayUtc);
    horizonUtc.setUTCDate(
      todayUtc.getUTCDate() + Math.max(availabilityHorizonDays, 365),
    );

    const calendarDays = parseAvailabilityCalendarFromHtml(html);
    const calendarByDate = new Map(
      calendarDays.map((day) => [day.date, day] as const),
    );

    const availabilityDays: KeycoDetailRecord["normalized_availability"]["days"] =
      [];
    for (
      const cursor = new Date(todayUtc);
      cursor <= horizonUtc;
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    ) {
      const isoDate = formatDateIso(cursor);
      const calendarDay = calendarByDate.get(isoDate);

      const statusCode: KeycoDayCode = calendarDay?.availabilityKey ?? "X";
      const bookingDayState: "bookable" | "blocked" | "unknown" =
        statusCode === "A"
          ? "bookable"
          : statusCode === "U"
            ? "blocked"
            : "unknown";

      availabilityDays.push({
        date: isoDate,
        status_code: statusCode,
        is_available: statusCode === "A",
        is_available_for_checkin: statusCode === "A",
        is_available_for_checkout: statusCode === "A",
        booking_day_state: bookingDayState,
        min_nights_required: calendarDay?.minStay ?? null,
      });
    }

    const dayCodes = availabilityDays.map((day) => day.status_code).join("");

    const counts = {
      available: availabilityDays.filter((day) => day.status_code === "A")
        .length,
      unavailable: availabilityDays.filter((day) => day.status_code === "U")
        .length,
      checkin_only: 0,
      checkout_only: 0,
      other: availabilityDays.filter(
        (day) => day.status_code === "M" || day.status_code === "X",
      ).length,
      booking_available: availabilityDays.filter(
        (day) => day.booking_day_state === "bookable",
      ).length,
      booking_unavailable: availabilityDays.filter(
        (day) => day.booking_day_state === "blocked",
      ).length,
      booking_unknown: availabilityDays.filter(
        (day) => day.booking_day_state === "unknown",
      ).length,
    };

    const ratesWindowDays = Math.max(
      168,
      Number(process.env.KEYCO30A_RATES_WINDOW_DAYS ?? "168") || 168,
    );
    const ratesSampleStepDays = Math.max(
      7,
      Number(process.env.KEYCO30A_RATES_SAMPLE_STEP_DAYS ?? "7") || 7,
    );
    const targetQuoteNights = Math.max(
      7,
      Number(process.env.KEYCO30A_RATES_QUOTE_NIGHTS ?? "7") || 7,
    );
    const ratesMaxQueries = Math.max(
      1,
      Number(process.env.KEYCO30A_RATES_MAX_QUERIES ?? "24") || 24,
    );
    const ratesTargetQueries = Math.max(
      1,
      Math.ceil(ratesWindowDays / ratesSampleStepDays),
    );
    const effectiveRatesMaxQueries = Math.min(
      ratesMaxQueries,
      ratesTargetQueries,
    );
    const ratesWindowEndIso = formatDateIso(
      new Date(
        Date.UTC(
          todayUtc.getUTCFullYear(),
          todayUtc.getUTCMonth(),
          todayUtc.getUTCDate() + ratesWindowDays - 1,
        ),
      ),
    );

    const availabilityByDate = new Map(
      availabilityDays.map((day) => [day.date, day] as const),
    );

    const normalizedRateDays: KeycoDetailRecord["normalized_rates"]["days"] =
      availabilityDays
        .filter((day) => day.date <= ratesWindowEndIso)
        .map((day) => ({
          date: day.date,
          nightly_rate: null,
          min_nights: day.min_nights_required ?? null,
          is_booked: day.is_available ? false : true,
          changeover_code: day.status_code,
          season_name: day.is_available ? "quote_pending" : "not_available",
        }));

    const rateObservations: KeycoRateObservation[] = [];
    let quoteCount = 0;

    const sampleDays: Array<(typeof normalizedRateDays)[number]> = [];
    for (
      let cursor = 0;
      cursor < normalizedRateDays.length &&
      quoteCount < effectiveRatesMaxQueries;
      cursor += ratesSampleStepDays
    ) {
      let picked: (typeof normalizedRateDays)[number] | null = null;
      const endExclusive = Math.min(
        normalizedRateDays.length,
        cursor + ratesSampleStepDays,
      );

      for (let idx = cursor; idx < endExclusive; idx += 1) {
        const candidate = normalizedRateDays[idx];
        if (!candidate) {
          continue;
        }
        const day = availabilityByDate.get(candidate.date);
        if (!day?.is_available) {
          continue;
        }
        if (isSaturdayIsoDate(candidate.date)) {
          picked = candidate;
          break;
        }
        if (!picked) {
          picked = candidate;
        }
      }

      if (!picked) {
        continue;
      }

      if (sampleDays.at(-1)?.date === picked.date) {
        continue;
      }

      sampleDays.push(picked);
      quoteCount += 1;
    }

    const sampledRatesByDate = new Map<string, number>();
    logStage(
      "API_RATE_CALLS",
      `start sample_windows=${sampleDays.length} max_queries=${effectiveRatesMaxQueries}`,
    );

    for (const sampleDay of sampleDays) {
      const day = availabilityByDate.get(sampleDay.date);
      if (!day || !day.is_available) {
        continue;
      }

      const nights = Math.max(targetQuoteNights, day.min_nights_required ?? 0);
      const endDate = addDaysToIsoDate(day.date, nights);

      const pricing = await fetchPricingContext(
        externalListingId,
        day.date,
        endDate,
      );
      const body = pricing.body;
      const pricingNode =
        body?.pricing && typeof body.pricing === "object" ? body.pricing : body;
      const totalBaseRate = Number(pricingNode?.totalBaseRate);
      const hasRate = Number.isFinite(totalBaseRate) && totalBaseRate > 0;
      const taxesTotalRaw = Number(pricingNode?.taxes);
      const taxesTotal =
        Number.isFinite(taxesTotalRaw) && taxesTotalRaw >= 0
          ? taxesTotalRaw
          : null;
      const feeLines = Array.isArray(pricingNode?.pricingFees)
        ? pricingNode.pricingFees
            .map((line) => {
              const name = String(line?.description ?? "").trim();
              const amount = Number(line?.amount);
              if (!name || !Number.isFinite(amount) || amount < 0) {
                return null;
              }
              return { name, amount: roundCurrency(amount) };
            })
            .filter(
              (
                line,
              ): line is {
                name: string;
                amount: number;
              } => Boolean(line),
            )
        : [];
      const feesTotalExclTaxes =
        feeLines.length > 0
          ? roundCurrency(
              feeLines.reduce((sum, feeLine) => sum + feeLine.amount, 0),
            )
          : null;
      const grandTotal =
        hasRate && taxesTotal !== null && feesTotalExclTaxes !== null
          ? roundCurrency(totalBaseRate + taxesTotal + feesTotalExclTaxes)
          : null;
      const nightlyRateProxy = hasRate
        ? roundCurrency(totalBaseRate / nights)
        : null;
      const isAvailable =
        typeof pricingNode?.isAvailable === "boolean"
          ? pricingNode.isAvailable
          : typeof body?.isAvailable === "boolean"
            ? body.isAvailable
            : hasRate;

      if (nightlyRateProxy !== null) {
        sampledRatesByDate.set(day.date, nightlyRateProxy);
        sampleDay.nightly_rate = nightlyRateProxy;
        sampleDay.season_name = "quote_weekly_sample";
      } else {
        sampleDay.season_name = "quote_unavailable";
      }

      rateObservations.push({
        start_date: day.date,
        end_date: endDate,
        nights,
        status: pricing.status,
        is_available: isAvailable,
        total_base_rate: hasRate ? totalBaseRate : null,
        taxes_total: taxesTotal,
        fees_total_excl_taxes: feesTotalExclTaxes,
        fee_lines: feeLines,
        grand_total: grandTotal,
        nightly_rate_proxy: nightlyRateProxy,
        average_base_rate_description:
          typeof pricingNode?.averageBaseRateDescription === "string"
            ? pricingNode.averageBaseRateDescription
            : null,
        error_message:
          typeof pricingNode?.errorMessage === "string"
            ? pricingNode.errorMessage
            : null,
        reliability:
          nightlyRateProxy !== null ? "window_average_proxy" : "unpriced",
      });

      await page.waitForTimeout(55);
    }
    logStage(
      "API_RATE_CALLS",
      `done calls=${rateObservations.length} sampled_rates=${sampledRatesByDate.size}`,
    );
    logStage(
      "API_AVAIL_REFRESH",
      "skipped (availability sourced from embedded calendar in full mode)",
    );

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
        rateDay.nightly_rate = roundCurrency(
          prevPoint.nightlyRate +
            (nextPoint.nightlyRate - prevPoint.nightlyRate) * ratio,
        );
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

    const collectedRates = normalizedRateDays
      .map((day) => day.nightly_rate)
      .filter((value): value is number => Number.isFinite(value));
    const minRate = collectedRates.length ? Math.min(...collectedRates) : null;
    const maxRate = collectedRates.length ? Math.max(...collectedRates) : null;
    const avgRate = collectedRates.length
      ? Math.round(
          (collectedRates.reduce((sum, value) => sum + value, 0) /
            collectedRates.length) *
            100,
        ) / 100
      : null;

    const htmlPath = resolve(
      OUTPUT_DETAILS_HTML_DIR,
      `${externalListingId}.html`,
    );
    await writeFile(htmlPath, `${html}\n`, "utf8");
    const observationsPath = await writeKeycoQuotesSidecar({
      externalListingId,
      detailUrl: normalizedDetailUrl,
      quoteWindowDays: ratesWindowDays,
      quoteSampleStepDays: ratesSampleStepDays,
      quoteMaxQueries: effectiveRatesMaxQueries,
      observations: rateObservations,
    });

    return {
      external_listing_id: externalListingId,
      detail_url: normalizedDetailUrl,
      fetched_at: new Date().toISOString(),
      title: normalizedTitle,
      h1: normalizedH1,
      canonical_url: canonicalUrl,
      meta_description: metaDescription,
      description_expanded: descriptionExpanded,
      amenities: {
        categories: amenitiesCategories,
        all: amenitiesAll,
      },
      location: {
        address,
        location_label: locationLabel,
        directions_url: directionsDaddr
          ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(directionsDaddr)}`
          : "",
        directions_daddr: directionsDaddr,
        latitude: coordinates.latitude ?? fallbackCoordinates?.latitude ?? null,
        longitude:
          coordinates.longitude ?? fallbackCoordinates?.longitude ?? null,
      },
      media_gallery: {
        image_count: imageUrls.length,
        image_urls: imageUrls,
      },
      property_profile: {
        unit_id: externalListingId,
        property_code: externalListingId,
        unit_slug: externalListingId,
        unit_type: "Vacation Home",
        city,
        state,
        zip: "",
        beds,
        baths,
        sleeps,
      },
      normalized_matching_profile: {
        source: "pm_keyco30a",
        external_listing_id: externalListingId,
        name,
        description,
        match_signals: {
          description_normalized: descriptionNormalized,
          description_sha256: hashSha256(descriptionNormalized),
          title_normalized: titleNormalized,
          title_sha256: hashSha256(titleNormalized),
          listing_composite_key: [
            "pm_keyco30a",
            externalListingId,
            hashSha256(descriptionNormalized),
            hashSha256(titleNormalized),
          ].join("::"),
        },
      },
      normalized_availability: {
        source: "pm_keyco30a",
        external_listing_id: externalListingId,
        captured_at: new Date().toISOString(),
        window_start: availabilityDays[0]?.date ?? "",
        window_end: availabilityDays[availabilityDays.length - 1]?.date ?? "",
        code_legend: {
          A: "available",
          U: "unavailable",
          M: "restricted_or_rule_constrained",
          X: "unknown",
        },
        day_codes: dayCodes,
        days: availabilityDays,
        counts,
      },
      availability_raw: {
        source_note: calendarDays.length
          ? "Parsed embedded availabilityCalendar data from listing payload."
          : "No embedded availabilityCalendar payload parsed; using unknown-coded normalized window.",
        has_calendar_widget: extracted.hasCalendarWidget,
      },
      normalized_rates: {
        source: "pm_keyco30a",
        external_listing_id: externalListingId,
        captured_at: new Date().toISOString(),
        currency: "USD",
        window_start: normalizedRateDays[0]?.date ?? "",
        window_end:
          normalizedRateDays[normalizedRateDays.length - 1]?.date ?? "",
        days: normalizedRateDays,
        stats: {
          days_with_rate: collectedRates.length,
          min_nightly_rate: minRate,
          max_nightly_rate: maxRate,
          avg_nightly_rate: avgRate,
        },
      },
      rates_raw: {
        endpoint_path: `/api/listing/${externalListingId}/pricing-context`,
        quote_window_days: ratesWindowDays,
        quote_sample_step_days: ratesSampleStepDays,
        quote_max_queries: effectiveRatesMaxQueries,
        observations_count: rateObservations.length,
        observations_path: observationsPath,
        observations: [],
      },
      html_path: htmlPath,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `keyco30a fetchDetail failed for ${normalizedDetailUrl}: ${message}`,
    );
    return null;
  } finally {
    await page.close();
  }
}

export function createKeyco30AAdapter(): ScraperAdapter<KeycoDetailRecord> {
  return {
    managerKey: "keyco30a",
    scriptLabel: "keyco30a",
    defaultAnchorUrl: DEFAULT_ANCHOR_URL,
    detailFetchDelayMs: Math.max(
      0,
      Number(process.env.KEYCO30A_DETAIL_FETCH_DELAY_MS ?? "350") || 350,
    ),
    detailFetchConcurrency: Math.max(
      1,
      Number(process.env.KEYCO30A_FETCH_CONCURRENCY ?? "4") || 4,
    ),
    availabilityHorizonDays: Math.max(
      365,
      Number(process.env.KEYCO30A_AVAILABILITY_HORIZON_DAYS ?? "730") || 730,
    ),
    maxCalendarAdvanceMonths: 0,
    isValidDetailUrl(value: string): string | null {
      return normalizeDetailUrl(value);
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
        context.refreshMode,
        context.existingDetailJsonPath,
        context.reportDetailProgress,
      );
    },
  };
}
