import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Page } from "playwright";

import type { DetailRecordBase, ScrapedLink, ScraperAdapter } from "../types";

type BeachBlueDayCode = "A" | "U" | "I" | "O" | "X";

type BookingRange = {
  start: string;
  end: string;
};

type MinDayRule = {
  startDate: string;
  endDate: string;
  minimum: number;
};

type ParsedRule = {
  start_date: string;
  end_date: string;
  min_nights: number;
  raw_rule: string;
};

type BeachBlueDetailRecord = DetailRecordBase & {
  title: string;
  h1: string;
  canonical_url: string;
  meta_description: string;
  normalized_matching_profile: {
    source: "pm_beachblue";
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
    source: "pm_beachblue";
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
      status_code: BeachBlueDayCode;
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
};

const DEFAULT_ANCHOR_URL =
  "https://www.beachblueproperties.com/vacation-rentals/results/?searchform=1&cwrsearch=1&Area=30A";
const OUTPUT_ROOT = resolve(
  process.cwd(),
  "src",
  "lib",
  "data",
  "external-sources",
  "beachblue",
);
const OUTPUT_DETAILS_HTML_DIR = resolve(OUTPUT_ROOT, "details", "html");

function normalizeLink(url: string): string {
  return url.split("#")[0]?.replace(/\/$/, "") ?? url;
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

function extractExternalListingId(detailUrl: string): string {
  try {
    const parsed = new URL(detailUrl);
    const parts = parsed.pathname.split("/").filter(Boolean);
    return parts[parts.length - 1] ?? parsed.pathname;
  } catch {
    return detailUrl;
  }
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

function readJsonObjectAfterKey<T extends object>(
  html: string,
  key: string,
): T | null {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const keyMatch = new RegExp(`${escapedKey}\\s*:\\s*\\{`, "m").exec(html);
  if (!keyMatch?.index && keyMatch?.index !== 0) {
    return null;
  }

  const start = (keyMatch.index ?? 0) + keyMatch[0].lastIndexOf("{");
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < html.length; i += 1) {
    const ch = html[i] as string;

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
        const raw = html.slice(start, i + 1);
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

function readJsonArrayAfterKey<T>(html: string, key: string): T[] {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const keyMatch = new RegExp(`${escapedKey}\\s*:\\s*\\[`, "m").exec(html);
  if (!keyMatch?.index && keyMatch?.index !== 0) {
    return [];
  }

  const start = (keyMatch.index ?? 0) + keyMatch[0].lastIndexOf("[");
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < html.length; i += 1) {
    const ch = html[i] as string;

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
        const raw = html.slice(start, i + 1);
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
): Promise<ScrapedLink[]> {
  await installEvaluateNameShim(page);

  await page.goto(anchorUrl, {
    waitUntil: "domcontentloaded",
    timeout: 120000,
  });

  const scrollSteps = Math.max(0, Math.min(10, maxScrollSteps));
  for (let step = 0; step < scrollSteps; step += 1) {
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });
    await page.waitForTimeout(Math.max(250, Math.min(scrollPauseMs, 1000)));
  }

  await page.waitForTimeout(1500);

  return page.evaluate((sourceUrl) => {
    const detailRows: Array<{
      link: string;
      source_url: string;
      anchor_text: string;
    }> = [];
    const seen = new Set<string>();

    const toValid = (value: string): string | null => {
      try {
        const parsed = new URL(value, window.location.origin);
        if (!parsed.hostname.endsWith("beachblueproperties.com")) {
          return null;
        }

        const pathname = parsed.pathname.replace(/\/+$/, "");
        if (!/^\/vacation-rentals\/rental\/\d+-\d+$/i.test(pathname)) {
          return null;
        }

        return `${parsed.origin}${pathname}`;
      } catch {
        return null;
      }
    };

    for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
      const href = (anchor as HTMLAnchorElement).getAttribute("href") ?? "";
      const valid = toValid(href);
      if (!valid || seen.has(valid)) {
        continue;
      }

      seen.add(valid);
      detailRows.push({
        link: valid,
        source_url: sourceUrl,
        anchor_text: ((anchor as HTMLAnchorElement).textContent ?? "")
          .replace(/\s+/g, " ")
          .trim(),
      });
    }

    return detailRows;
  }, anchorUrl);
}

async function fetchDetail(
  detailUrl: string,
  availabilityHorizonDays: number,
): Promise<BeachBlueDetailRecord | null> {
  const externalListingId = extractExternalListingId(detailUrl);

  const headers = {
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    accept: "text/html,application/json,text/plain,*/*",
    referer: detailUrl,
  };

  try {
    const response = await fetch(detailUrl, {
      method: "GET",
      redirect: "follow",
      headers,
    });

    const contentType = (
      response.headers.get("content-type") ?? ""
    ).toLowerCase();
    if (response.status !== 200 || !contentType.includes("text/html")) {
      return null;
    }

    const html = await response.text();
    const htmlPath = resolve(
      OUTPUT_DETAILS_HTML_DIR,
      `${externalListingId}.html`,
    );
    await writeFile(htmlPath, `${html}\n`, "utf8");

    const title = extractFirst(/<title[^>]*>([\s\S]*?)<\/title>/i, html).slice(
      0,
      240,
    );
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
      ).slice(0, 8000) ||
      extractFirst(
        /<meta[^>]+content=["']([\s\S]*?)["'][^>]+name=["']description["'][^>]*>/i,
        html,
      ).slice(0, 8000);

    const propDetails =
      readJsonObjectAfterKey<Record<string, unknown>>(html, "propDetails") ??
      {};
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

    const normalizedDays: BeachBlueDetailRecord["normalized_availability"]["days"] =
      [];
    const cursor = new Date(startDate);
    while (cursor <= endDate) {
      const isoDate = formatIsoDate(cursor);
      const isStart = bookingStart.has(isoDate);
      const isEnd = bookingEnd.has(isoDate);
      const isBooked = bookedOnly.has(isoDate);

      let statusCode: BeachBlueDayCode = "A";
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

    const description = stripHtml(
      String(propDetails.description ?? metaDescription ?? ""),
    ).slice(0, 20000);
    const name = stripHtml(
      String(propDetails.prop_name ?? h1 ?? title ?? ""),
    ).slice(0, 240);
    const descriptionNormalized = normalizeForMatch(description);
    const titleNormalized = normalizeForMatch(name);

    return {
      external_listing_id: externalListingId,
      detail_url: detailUrl,
      fetched_at: new Date().toISOString(),
      html_path: htmlPath,
      title,
      h1,
      canonical_url: canonicalUrl,
      meta_description: metaDescription,
      normalized_matching_profile: {
        source: "pm_beachblue",
        external_listing_id: externalListingId,
        name,
        description,
        match_signals: {
          description_normalized: descriptionNormalized,
          description_sha256: hashSha256(descriptionNormalized),
          title_normalized: titleNormalized,
          title_sha256: hashSha256(titleNormalized),
          listing_composite_key: [
            "pm_beachblue",
            externalListingId,
            hashSha256(descriptionNormalized),
            hashSha256(titleNormalized),
          ].join("::"),
        },
      },
      normalized_availability: {
        source: "pm_beachblue",
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
      property_profile: {
        unit_id: String(propDetails.unit_id ?? externalListingId),
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
    };
  } catch {
    return null;
  }
}

export function createBeachBlueAdapter(): ScraperAdapter<BeachBlueDetailRecord> {
  return {
    managerKey: "beachblue",
    scriptLabel: "beachblue",
    defaultAnchorUrl: DEFAULT_ANCHOR_URL,
    detailFetchDelayMs: Math.max(
      0,
      Number(process.env.BEACHBLUE_DETAIL_FETCH_DELAY_MS ?? "250") || 250,
    ),
    detailFetchConcurrency: Math.max(
      1,
      Number(process.env.BEACHBLUE_FETCH_CONCURRENCY ?? "6") || 6,
    ),
    availabilityHorizonDays: Math.max(
      1,
      Number(process.env.BEACHBLUE_AVAILABILITY_HORIZON_DAYS ?? "486") || 486,
    ),
    maxCalendarAdvanceMonths: 18,
    isValidDetailUrl(value: string): string | null {
      try {
        const parsed = new URL(value.trim());
        if (!parsed.hostname.endsWith("beachblueproperties.com")) {
          return null;
        }

        const pathname = parsed.pathname.replace(/\/+$/, "");
        if (!/^\/vacation-rentals\/rental\/\d+-\d+$/i.test(pathname)) {
          return null;
        }

        return normalizeLink(`${parsed.origin}${pathname}`);
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
      );
    },
    async fetchDetail(context) {
      return fetchDetail(context.detailUrl, context.availabilityHorizonDays);
    },
  };
}
