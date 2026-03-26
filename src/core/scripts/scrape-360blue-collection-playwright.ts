import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createScrapeProgress } from "../tooling/terminal/scrape-progress";

const DEFAULT_URL = "https://www.360blue.com/travel-collections/30A";
const MAX_SCROLL_STEPS = 60;
const SCROLL_PAUSE_MS = 1000;
const NETWORK_IDLE_WAIT_MS = 800;
const DETAIL_FETCH_DELAY_MS = Number(
  process.env.BLUE360_DETAIL_FETCH_DELAY_MS ?? "150",
);
const DETAIL_FETCH_CONCURRENCY = Math.max(
  1,
  Number(process.env.BLUE360_DETAIL_FETCH_CONCURRENCY ?? "4") || 4,
);
const AVAILABILITY_HORIZON_DAYS = Math.max(
  1,
  Number(process.env.BLUE360_AVAILABILITY_HORIZON_DAYS ?? "730") || 730,
);
const MAX_CALENDAR_ADVANCE_MONTHS = Math.max(
  6,
  Number(process.env.BLUE360_CALENDAR_MAX_MONTHS ?? "26") || 26,
);
const OUTPUT_ROOT = resolve(
  process.cwd(),
  "src",
  "lib",
  "data",
  "external-sources",
  "360blue",
);
const OUTPUT_DETAILS_HTML_DIR = resolve(OUTPUT_ROOT, "details", "html");
const OUTPUT_DETAILS_JSON_DIR = resolve(OUTPUT_ROOT, "details", "json");

type RunOptions = {
  anchorUrl: string;
  maxListings: number | null;
  startIndex: number;
  detailUrl: string | null;
  detailUrlsFile: string | null;
  refreshKnown: boolean;
};

type BookingDayState = "bookable" | "blocked" | "unknown";

type MinNightRule = {
  start_date: string;
  end_date: string;
  min_nights: number;
  raw_rule: string;
};

type Blue360DetailData = {
  external_listing_id: string;
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
  availability_signal_hints: string[];
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
      status_code: "A" | "U" | "I" | "O" | "X";
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
  normalized_matching_profile: {
    source: "pm_360blue";
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
  html_path: string;
  body_text_excerpt: string;
  scrape_metrics: {
    total_ms: number;
    page_load_and_expand_ms: number;
    extraction_ms: number;
    calendar_pagination_clicks: number;
    calendar_iterations: number;
  };
};

type ScrapedLink = {
  link: string;
  source_url: string;
  anchor_text: string;
};

type PlaywrightBrowserModule = {
  chromium: {
    launch(options?: Record<string, unknown>): Promise<{
      newPage(): Promise<{
        goto(url: string, options?: Record<string, unknown>): Promise<unknown>;
        waitForTimeout(ms: number): Promise<void>;
        evaluate<TReturn>(fn: () => TReturn): Promise<TReturn>;
        close(): Promise<void>;
      }>;
      close(): Promise<void>;
    }>;
  };
};

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

function extractAvailabilitySignalHints(html: string): string[] {
  const matches = Array.from(html.matchAll(/https?:\/\/[^"'\s<>()]+/gi))
    .map((match) => match[0] ?? "")
    .filter((value) => {
      const lower = value.toLowerCase();
      return (
        lower.includes("calendar") ||
        lower.includes("availability") ||
        lower.includes("quote") ||
        lower.includes("rate") ||
        lower.includes("book") ||
        lower.includes("api") ||
        lower.includes("graphql")
      );
    });

  return Array.from(new Set(matches)).slice(0, 40);
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

function extractNormalizedMatchingProfile(
  externalListingId: string,
  title: string,
  h1: string,
  propertyDescription: string,
  metaDescription: string,
  jsonLdName: string,
  jsonLdDescription: string,
  jsonLdBlocks: Array<{ parsed: unknown | null }>,
): Blue360DetailData["normalized_matching_profile"] {
  const base: Blue360DetailData["normalized_matching_profile"] = {
    source: "pm_360blue",
    external_listing_id: externalListingId,
    name: h1 || jsonLdName || title,
    description: jsonLdDescription || propertyDescription || metaDescription,
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

  const candidateBlock = jsonLdBlocks.find((block) => {
    if (!block.parsed || typeof block.parsed !== "object") {
      return false;
    }

    const parsed = block.parsed as Record<string, unknown>;
    const type = parsed["@type"];
    if (typeof type === "string") {
      const lower = type.toLowerCase();
      return (
        lower.includes("vacation") ||
        lower.includes("lodging") ||
        lower.includes("residence") ||
        lower.includes("house") ||
        lower.includes("product")
      );
    }

    return false;
  });

  if (candidateBlock?.parsed && typeof candidateBlock.parsed === "object") {
    const parsed = candidateBlock.parsed as Record<string, unknown>;

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

    base.attributes.bedrooms = toNumberOrNull(parsed.numberOfBedrooms);
    base.attributes.bathrooms_total = toNumberOrNull(
      parsed.numberOfBathroomsTotal,
    );

    const occupancy = parsed.occupancy;
    if (occupancy && typeof occupancy === "object") {
      base.attributes.occupancy = toNumberOrNull(
        (occupancy as Record<string, unknown>).value,
      );
    }

    const aggregateRating = parsed.aggregateRating;
    if (aggregateRating && typeof aggregateRating === "object") {
      const ratingObj = aggregateRating as Record<string, unknown>;
      base.attributes.rating_value = toNumberOrNull(ratingObj.ratingValue);
      base.attributes.review_count = toNumberOrNull(ratingObj.reviewCount);
    }
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
    externalListingId,
    base.match_signals.description_sha256,
    base.match_signals.title_sha256,
    base.match_signals.address_sha256,
  ].join("::");

  return base;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function loadDetailUrlsFromFile(filePath: string): Promise<string[]> {
  const raw = await readFile(filePath, "utf8");
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  const urls: string[] = [];
  for (const line of lines) {
    const parsed = toValidDetailUrl(line);
    if (parsed) {
      urls.push(parsed);
    }
  }

  return Array.from(new Set(urls));
}

async function loadKnownDetailUrlsFromArtifacts(): Promise<string[]> {
  const urls: string[] = [];

  const manifestPaths = [
    resolve(OUTPUT_ROOT, "details", "index.json"),
    resolve(OUTPUT_ROOT, "details", "index-subset.json"),
  ];

  for (const manifestPath of manifestPaths) {
    try {
      const raw = await readFile(manifestPath, "utf8");
      const parsed = JSON.parse(raw) as Array<{ detail_url?: unknown }>;
      if (!Array.isArray(parsed)) {
        continue;
      }
      for (const record of parsed) {
        if (!record || typeof record !== "object") {
          continue;
        }
        const candidate =
          typeof record.detail_url === "string" ? record.detail_url : "";
        const valid = toValidDetailUrl(candidate);
        if (valid) {
          urls.push(valid);
        }
      }
    } catch {
      // Skip missing or invalid manifest files.
    }
  }

  try {
    const names = await readdir(OUTPUT_DETAILS_JSON_DIR, {
      withFileTypes: true,
    });
    for (const name of names) {
      if (!name.isFile() || !name.name.endsWith(".json")) {
        continue;
      }
      const filePath = resolve(OUTPUT_DETAILS_JSON_DIR, name.name);
      try {
        const raw = await readFile(filePath, "utf8");
        const parsed = JSON.parse(raw) as { detail_url?: unknown };
        const candidate =
          parsed && typeof parsed.detail_url === "string"
            ? parsed.detail_url
            : "";
        const valid = toValidDetailUrl(candidate);
        if (valid) {
          urls.push(valid);
        }
      } catch {
        // Ignore malformed detail JSON files.
      }
    }
  } catch {
    // Detail directory may not exist yet.
  }

  return Array.from(new Set(urls));
}

async function fetchDetailPage(
  browser: Awaited<ReturnType<PlaywrightBrowserModule["chromium"]["launch"]>>,
  detailUrl: string,
): Promise<Blue360DetailData | null> {
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
      const shortAddress =
        document
          .querySelector(".cmp-property-description__short-address")
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
      const bodyText = document.body?.innerText ?? "";
      const html = document.documentElement.outerHTML;
      return {
        title: document.title ?? "",
        propertyName,
        shortAddress,
        propertyDescription,
        h1,
        canonical,
        metaDescription,
        bodyText,
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
    const shortAddress = stripHtml(extracted.shortAddress).slice(0, 300);
    const canonicalUrl = extracted.canonical || detailUrl;
    const metaDescription = stripHtml(extracted.metaDescription).slice(0, 1200);
    const bodyText = extracted.bodyText.replace(/\s+/g, " ").trim();

    const jsonLdBlocks = extractJsonLdBlocks(html);
    const jsonLd = parseJsonLd(jsonLdBlocks);
    const availabilitySignalHints = extractAvailabilitySignalHints(html);

    const calendarIterations = MAX_CALENDAR_ADVANCE_MONTHS;
    const horizonDate = new Date();
    horizonDate.setUTCDate(
      horizonDate.getUTCDate() + AVAILABILITY_HORIZON_DAYS,
    );

    const dayCodeByDate = new Map<string, "A" | "U" | "I" | "O" | "X">();
    let lastSignature = "";
    let calendarPageClicks = 0;
    let calendarIterationsUsed = 0;

    for (let iteration = 0; iteration < calendarIterations; iteration += 1) {
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
        if (!dayCodeByDate.has(item.date)) {
          dayCodeByDate.set(item.date, item.code);
        }
      }

      const newestDate = Array.from(dayCodeByDate.keys()).sort().at(-1) ?? "";
      if (newestDate && newestDate >= horizonDate.toISOString().slice(0, 10)) {
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

    const todayIso = new Date().toISOString().slice(0, 10);
    const horizonIso = horizonDate.toISOString().slice(0, 10);
    const normalizedDays = Array.from(dayCodeByDate.entries())
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
          status_code: code,
          is_available: code === "A" || code === "O",
          is_available_for_checkin: code === "A" || code === "O",
          is_available_for_checkout: code === "A" || code === "O",
          booking_day_state: bookingDayState,
          min_nights_required: resolveMinNightsForDate(date, minNightRules),
        };
      });

    const normalizedAvailability: Blue360DetailData["normalized_availability"] =
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

    const occupancyFromBody =
      Number(bodyText.match(/Sleeps\s+(\d+)/i)?.[1] ?? "") || null;
    const bedroomsFromBody =
      Number(bodyText.match(/Bedrooms\s+(\d+)/i)?.[1] ?? "") || null;
    const fullBathsFromBody =
      Number(bodyText.match(/Full Baths\s+(\d+)/i)?.[1] ?? "") || null;
    const halfBathsFromBody =
      Number(bodyText.match(/Half Baths\s+(\d+)/i)?.[1] ?? "") || null;

    const normalizedMatchingProfile = extractNormalizedMatchingProfile(
      externalListingId,
      title,
      h1,
      propertyDescription,
      metaDescription,
      jsonLd.name,
      jsonLd.description,
      jsonLdBlocks,
    );

    if (!normalizedMatchingProfile.description && propertyDescription) {
      normalizedMatchingProfile.description = propertyDescription;
      const normalizedDescription = normalizeForMatch(propertyDescription);
      normalizedMatchingProfile.match_signals.description_normalized =
        normalizedDescription;
      normalizedMatchingProfile.match_signals.description_sha256 = hashSha256(
        normalizedDescription,
      );
      normalizedMatchingProfile.match_signals.listing_composite_key = [
        normalizedMatchingProfile.source,
        externalListingId,
        normalizedMatchingProfile.match_signals.description_sha256,
        normalizedMatchingProfile.match_signals.title_sha256,
        normalizedMatchingProfile.match_signals.address_sha256,
      ].join("::");
    }

    if (!normalizedMatchingProfile.address.locality && shortAddress) {
      const parts = shortAddress
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
      normalizedMatchingProfile.address.locality = parts[0] ?? "";
      normalizedMatchingProfile.address.region = parts[1] ?? "";
      const normalizedAddress = normalizeForMatch(
        [
          normalizedMatchingProfile.address.street,
          normalizedMatchingProfile.address.locality,
          normalizedMatchingProfile.address.region,
          normalizedMatchingProfile.address.postal_code,
          normalizedMatchingProfile.address.country,
        ]
          .filter(Boolean)
          .join(" "),
      );
      normalizedMatchingProfile.match_signals.address_normalized =
        normalizedAddress;
      normalizedMatchingProfile.match_signals.address_sha256 =
        hashSha256(normalizedAddress);
      normalizedMatchingProfile.match_signals.listing_composite_key = [
        normalizedMatchingProfile.source,
        externalListingId,
        normalizedMatchingProfile.match_signals.description_sha256,
        normalizedMatchingProfile.match_signals.title_sha256,
        normalizedMatchingProfile.match_signals.address_sha256,
      ].join("::");
    }

    if (
      normalizedMatchingProfile.attributes.occupancy === null &&
      occupancyFromBody !== null
    ) {
      normalizedMatchingProfile.attributes.occupancy = occupancyFromBody;
    }
    if (
      normalizedMatchingProfile.attributes.bedrooms === null &&
      bedroomsFromBody !== null
    ) {
      normalizedMatchingProfile.attributes.bedrooms = bedroomsFromBody;
    }
    if (
      normalizedMatchingProfile.attributes.bathrooms_total === null &&
      fullBathsFromBody !== null
    ) {
      const totalBathrooms =
        fullBathsFromBody +
        (halfBathsFromBody !== null ? halfBathsFromBody * 0.5 : 0);
      normalizedMatchingProfile.attributes.bathrooms_total = totalBathrooms;
    }

    const htmlPath = resolve(
      OUTPUT_DETAILS_HTML_DIR,
      `${externalListingId}.html`,
    );
    await writeFile(htmlPath, `${html}\n`, "utf8");
    const extractionMs = Date.now() - extractionStartedAt;
    const totalMs = Date.now() - fetchStartedAt;

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
      json_ld_blocks: jsonLdBlocks,
      availability_signal_hints: availabilitySignalHints,
      normalized_availability: normalizedAvailability,
      normalized_matching_profile: normalizedMatchingProfile,
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
  } catch {
    return null;
  } finally {
    await page.close();
  }
}

function parseRunOptions(argv: string[]): RunOptions {
  let anchorUrl = DEFAULT_URL;
  let maxListings: number | null = null;
  let startIndex = 0;
  let detailUrl: string | null = null;
  let detailUrlsFile: string | null = null;
  let refreshKnown = false;

  let index = 2;
  if (argv[index] && !argv[index]?.startsWith("--")) {
    anchorUrl = argv[index] as string;
    index += 1;
  }

  for (; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    if (arg === "--max-listings" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        maxListings = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--start-index" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed >= 0) {
        startIndex = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--detail-url" && value) {
      detailUrl = value;
      index += 1;
      continue;
    }

    if (arg === "--detail-urls-file" && value) {
      detailUrlsFile = value;
      index += 1;
      continue;
    }

    if (arg === "--refresh-known") {
      refreshKnown = true;
    }
  }

  return {
    anchorUrl,
    maxListings,
    startIndex,
    detailUrl,
    detailUrlsFile,
    refreshKnown,
  };
}

async function loadPlaywright(): Promise<PlaywrightBrowserModule> {
  try {
    const module = (await import("playwright")) as PlaywrightBrowserModule;
    return module;
  } catch {
    throw new Error(
      "Playwright is not installed. Run: npm install -D playwright && npx playwright install chromium",
    );
  }
}

async function run(): Promise<void> {
  const progress = createScrapeProgress({ script: "360blue" });
  const options = parseRunOptions(process.argv);

  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ headless: true });

  try {
    if (options.detailUrl) {
      let parsedDetail: URL;
      try {
        parsedDetail = new URL(options.detailUrl);
      } catch {
        throw new Error(`Invalid detail URL: ${options.detailUrl}`);
      }

      const root = process.cwd();
      const reportsDir = resolve(root, ".tmp", "reports");
      await mkdir(reportsDir, { recursive: true });
      await mkdir(OUTPUT_DETAILS_HTML_DIR, { recursive: true });
      await mkdir(OUTPUT_DETAILS_JSON_DIR, { recursive: true });

      progress.phase("direct detail mode: pulling one listing detail page");
      const detail = await fetchDetailPage(browser, parsedDetail.toString());
      if (!detail) {
        throw new Error("Direct detail scrape failed for requested URL");
      }

      const detailPath = resolve(
        OUTPUT_DETAILS_JSON_DIR,
        `${detail.external_listing_id}.json`,
      );
      await writeFile(
        detailPath,
        `${JSON.stringify(detail, null, 2)}\n`,
        "utf8",
      );

      const directReportPath = resolve(
        reportsDir,
        "360blue-direct-detail-report.json",
      );
      await writeFile(
        directReportPath,
        `${JSON.stringify(
          {
            generated_at: new Date().toISOString(),
            mode: "direct_detail",
            detail_url: parsedDetail.toString(),
            external_listing_id: detail.external_listing_id,
            metrics: detail.scrape_metrics,
            normalized_availability: {
              window_start: detail.normalized_availability.window_start,
              window_end: detail.normalized_availability.window_end,
              counts: detail.normalized_availability.counts,
              min_night_rules: detail.normalized_availability.min_night_rules,
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      progress.success(
        `direct detail scrape complete (id=${detail.external_listing_id}, total_ms=${detail.scrape_metrics.total_ms})`,
      );
      console.log("360Blue direct detail scrape complete.");
      console.log(`- detail_url: ${parsedDetail.toString()}`);
      console.log(`- external_listing_id: ${detail.external_listing_id}`);
      console.log(`- total_ms: ${detail.scrape_metrics.total_ms}`);
      console.log(
        `- page_load_and_expand_ms: ${detail.scrape_metrics.page_load_and_expand_ms}`,
      );
      console.log(`- extraction_ms: ${detail.scrape_metrics.extraction_ms}`);
      console.log(
        `- calendar_pagination_clicks: ${detail.scrape_metrics.calendar_pagination_clicks}`,
      );
      console.log(
        `- calendar_iterations: ${detail.scrape_metrics.calendar_iterations}`,
      );
      console.log(`- detail_json: ${detailPath}`);
      console.log(`- report_json: ${directReportPath}`);
      return;
    }

    if (options.refreshKnown || options.detailUrlsFile) {
      const root = process.cwd();
      const reportsDir = resolve(root, ".tmp", "reports");
      await mkdir(reportsDir, { recursive: true });
      await mkdir(OUTPUT_DETAILS_HTML_DIR, { recursive: true });
      await mkdir(OUTPUT_DETAILS_JSON_DIR, { recursive: true });

      const knownUrls = options.refreshKnown
        ? await loadKnownDetailUrlsFromArtifacts()
        : [];
      const fileUrls = options.detailUrlsFile
        ? await loadDetailUrlsFromFile(options.detailUrlsFile)
        : [];

      const merged = Array.from(new Set([...knownUrls, ...fileUrls])).sort();
      const startIndex = Math.min(options.startIndex, merged.length);
      const selectedUrls =
        options.maxListings === null
          ? merged.slice(startIndex)
          : merged.slice(startIndex, startIndex + options.maxListings);

      if (selectedUrls.length === 0) {
        throw new Error(
          "No known detail URLs available. Use --detail-urls-file or run a collection scrape first.",
        );
      }

      progress.phase(
        `refresh mode: pulling known detail pages (count=${selectedUrls.length}, concurrency=${DETAIL_FETCH_CONCURRENCY})`,
      );

      const detailRecords: Blue360DetailData[] = [];
      const failedDetailUrls: string[] = [];
      const detailResults: Array<Blue360DetailData | null> = new Array(
        selectedUrls.length,
      ).fill(null);

      let nextIndex = 0;
      let processed = 0;
      const workerCount = Math.min(
        DETAIL_FETCH_CONCURRENCY,
        selectedUrls.length,
      );

      const worker = async (): Promise<void> => {
        while (true) {
          const currentIndex = nextIndex;
          nextIndex += 1;
          if (currentIndex >= selectedUrls.length) {
            return;
          }

          const detailUrl = selectedUrls[currentIndex] as string;
          const detail = await fetchDetailPage(browser, detailUrl);
          detailResults[currentIndex] = detail;
          processed += 1;

          if (processed % 5 === 0 || processed === selectedUrls.length) {
            progress.tick(
              `details processed ${processed}/${selectedUrls.length}`,
            );
          }

          if (DETAIL_FETCH_DELAY_MS > 0) {
            await sleep(DETAIL_FETCH_DELAY_MS);
          }
        }
      };

      await Promise.all(Array.from({ length: workerCount }, () => worker()));

      for (let index = 0; index < selectedUrls.length; index += 1) {
        const detailUrl = selectedUrls[index] as string;
        const detail = detailResults[index];

        if (!detail) {
          failedDetailUrls.push(detailUrl);
          continue;
        }

        detailRecords.push(detail);
        const detailPath = resolve(
          OUTPUT_DETAILS_JSON_DIR,
          `${detail.external_listing_id}.json`,
        );
        await writeFile(
          detailPath,
          `${JSON.stringify(detail, null, 2)}\n`,
          "utf8",
        );
      }

      const refreshReportPath = resolve(
        reportsDir,
        "360blue-refresh-known-report.json",
      );
      await writeFile(
        refreshReportPath,
        `${JSON.stringify(
          {
            generated_at: new Date().toISOString(),
            mode: "refresh_known_details",
            source_count: merged.length,
            start_index: startIndex,
            max_listings: options.maxListings,
            selected_count: selectedUrls.length,
            detail_pages_pulled: detailRecords.length,
            detail_pages_failed: failedDetailUrls.length,
            failed_detail_urls: failedDetailUrls,
            selected_urls: selectedUrls,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      progress.success(
        `refresh scrape complete (selected=${selectedUrls.length}, details=${detailRecords.length})`,
      );
      console.log("360Blue refresh-known scrape complete.");
      console.log(`- known_urls_discovered: ${merged.length}`);
      console.log(`- urls_selected: ${selectedUrls.length}`);
      console.log(`- detail_pages_pulled: ${detailRecords.length}`);
      console.log(`- detail_pages_failed: ${failedDetailUrls.length}`);
      console.log(`- report_json: ${refreshReportPath}`);
      return;
    }

    const anchorUrl = options.anchorUrl;

    let parsedAnchor: URL;
    try {
      parsedAnchor = new URL(anchorUrl);
    } catch {
      throw new Error(`Invalid URL: ${anchorUrl}`);
    }

    progress.phase("opening collection page");
    const page = await browser.newPage();
    await page.goto(parsedAnchor.toString(), {
      waitUntil: "domcontentloaded",
      timeout: 120000,
    });

    let previousHeight = 0;
    progress.phase("scrolling to load listing cards");
    for (let step = 0; step < MAX_SCROLL_STEPS; step += 1) {
      await page.evaluate(() => {
        window.scrollBy(0, window.innerHeight * 1.5);
      });

      await page.waitForTimeout(SCROLL_PAUSE_MS);

      const currentHeight = await page.evaluate(
        () => document.body.scrollHeight,
      );
      if (currentHeight === previousHeight) {
        await page.waitForTimeout(NETWORK_IDLE_WAIT_MS);
        const recheckHeight = await page.evaluate(
          () => document.body.scrollHeight,
        );
        if (recheckHeight === currentHeight) {
          break;
        }
      }

      previousHeight = currentHeight;

      if ((step + 1) % 10 === 0) {
        progress.tick(`scroll steps completed: ${step + 1}`);
      }
    }

    progress.phase("extracting property links");
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

      let parsed: URL;
      try {
        parsed = new URL(href);
      } catch {
        continue;
      }

      const isPropertyUrl =
        (parsed.hostname.endsWith("360blue.com") ||
          parsed.hostname.endsWith("callistavacations.com")) &&
        parsed.pathname.includes("/properties/");

      if (!isPropertyUrl) {
        continue;
      }

      const normalized = normalizeLink(parsed.toString());
      if (seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);

      rows.push({
        link: normalized,
        source_url: parsedAnchor.toString(),
        anchor_text: typeof row.text === "string" ? row.text : "",
      });
    }

    rows.sort((left, right) => left.link.localeCompare(right.link));

    const totalDiscovered = rows.length;
    const startIndex = Math.min(options.startIndex, totalDiscovered);
    const subsetRows =
      options.maxListings === null
        ? rows.slice(startIndex)
        : rows.slice(startIndex, startIndex + options.maxListings);
    const isSubsetMode = options.maxListings !== null || options.startIndex > 0;

    const root = process.cwd();
    const reportsDir = resolve(root, ".tmp", "reports");
    const externalSourceDir = resolve(
      root,
      "src",
      "lib",
      "data",
      "external-sources",
    );

    await mkdir(reportsDir, { recursive: true });
    await mkdir(externalSourceDir, { recursive: true });
    await mkdir(OUTPUT_DETAILS_HTML_DIR, { recursive: true });
    await mkdir(OUTPUT_DETAILS_JSON_DIR, { recursive: true });

    progress.phase(
      `pulling detail pages from selected subset (count=${subsetRows.length}, concurrency=${DETAIL_FETCH_CONCURRENCY})`,
    );

    const detailRecords: Blue360DetailData[] = [];
    const failedDetailUrls: string[] = [];
    const detailResults: Array<Blue360DetailData | null> = new Array(
      subsetRows.length,
    ).fill(null);

    let nextIndex = 0;
    let processed = 0;
    const workerCount = Math.min(DETAIL_FETCH_CONCURRENCY, subsetRows.length);

    const worker = async (): Promise<void> => {
      while (true) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        if (currentIndex >= subsetRows.length) {
          return;
        }

        const row = subsetRows[currentIndex] as ScrapedLink;
        const detail = await fetchDetailPage(browser, row.link);
        detailResults[currentIndex] = detail;
        processed += 1;

        if (processed % 5 === 0 || processed === subsetRows.length) {
          progress.tick(`details processed ${processed}/${subsetRows.length}`);
        }

        if (DETAIL_FETCH_DELAY_MS > 0) {
          await sleep(DETAIL_FETCH_DELAY_MS);
        }
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    for (let index = 0; index < subsetRows.length; index += 1) {
      const row = subsetRows[index] as ScrapedLink;
      const detail = detailResults[index];

      if (!detail) {
        failedDetailUrls.push(row.link);
        continue;
      }

      detailRecords.push(detail);
      const detailPath = resolve(
        OUTPUT_DETAILS_JSON_DIR,
        `${detail.external_listing_id}.json`,
      );
      await writeFile(
        detailPath,
        `${JSON.stringify(detail, null, 2)}\n`,
        "utf8",
      );
    }

    const payload = {
      generated_at: new Date().toISOString(),
      source_url: parsedAnchor.toString(),
      total_links_discovered: totalDiscovered,
      link_count: subsetRows.length,
      start_index: startIndex,
      max_listings: options.maxListings,
      is_subset_mode: isSubsetMode,
      detail_pages_pulled: detailRecords.length,
      detail_pages_failed: failedDetailUrls.length,
      failed_detail_urls: failedDetailUrls,
      links: subsetRows,
    };

    const reportFileName = isSubsetMode
      ? "360blue-30a-playwright-links-subset.json"
      : "360blue-30a-playwright-links.json";
    const sourceFileName = isSubsetMode
      ? "360blue_listings_subset.json"
      : "360blue_listings.json";

    const reportPath = resolve(reportsDir, reportFileName);
    const sourcePath = resolve(externalSourceDir, sourceFileName);
    const detailManifestPath = resolve(
      OUTPUT_ROOT,
      "details",
      isSubsetMode ? "index-subset.json" : "index.json",
    );

    await writeFile(
      reportPath,
      `${JSON.stringify(payload, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      sourcePath,
      `${JSON.stringify(subsetRows, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      detailManifestPath,
      `${JSON.stringify(detailRecords, null, 2)}\n`,
      "utf8",
    );

    progress.success(
      `collection+detail scrape complete (discovered=${totalDiscovered}, selected=${subsetRows.length}, details=${detailRecords.length})`,
    );
    console.log("360Blue Playwright scrape complete.");
    console.log(`- source_url: ${parsedAnchor.toString()}`);
    console.log(`- total_links_discovered: ${totalDiscovered}`);
    console.log(`- links_selected: ${subsetRows.length}`);
    console.log(`- start_index: ${startIndex}`);
    console.log(`- max_listings: ${options.maxListings ?? "all"}`);
    console.log(`- subset_mode: ${isSubsetMode}`);
    console.log(`- detail_pages_pulled: ${detailRecords.length}`);
    console.log(`- detail_pages_failed: ${failedDetailUrls.length}`);
    console.log(`- report_json: ${reportPath}`);
    console.log(`- external_source_json: ${sourcePath}`);
    console.log(`- details_manifest_json: ${detailManifestPath}`);
  } finally {
    await browser.close();
  }
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`360Blue Playwright scrape failed: ${message}`);
  process.exit(1);
});
