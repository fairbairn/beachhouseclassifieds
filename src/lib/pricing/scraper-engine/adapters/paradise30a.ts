import { executeParadise30aSingleQuote } from "@/lib/pricing/quote-runtime/adapters/paradise30a";
import { runRuntimeAdapterQuoteCli } from "@/lib/pricing/quotes/shared/runtime-adapter-quote-runner";
import { canonicalizeExternalListingId } from "@/lib/pricing/shared/external-listing-id";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { normalizeAdapterQuoteScopeArgs } from "../quote-scope";
import type { DetailRecordBase, ScrapedLink, ScraperAdapter } from "../types";

type ParadiseDayCode = "A" | "U" | "I" | "O" | "X";
type CanonicalDayCode = "Y" | "N";
type CanonicalChangeoverCode = "C" | "I" | "O" | "X";

type Paradise30ADetailRecord = DetailRecordBase & {
  listing_flags: {
    non_bookable_online: boolean;
    availability_validation_exempt: boolean;
    availability_validation_exempt_reason_code: string | null;
    availability_validation_exempt_reason: string | null;
  };
  title: string;
  h1: string;
  canonical_url: string;
  meta_description: string;
  description_expanded: string;
  rooms_guidance: string[] | false;
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
    source: "cwr_router";
    unit_id: string;
    listing_id: string;
    locid: string | null;
    detail_url: string;
  };
  normalized_matching_profile: {
    source: "pm_paradise30a";
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
    source: "pm_paradise30a";
    external_listing_id: string;
    captured_at: string;
    availability_source: "listing_calendar" | "fallback_unavailable";
    validation_exempt: boolean;
    validation_exempt_reason_code: string | null;
    validation_exempt_reason: string | null;
    validation_exempt_evidence: string[];
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
      status_code: ParadiseDayCode;
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
  pricing_api_hints: {
    provider: "cwr-router";
    endpoint_path: "/vacation-rentals/router/";
    method_names: {
      pre_reservation_price: "getPrice";
    };
    required_payload_fields: string[];
    notes: string;
  };
};

const BASE_HOST =
  process.env.PARADISE30A_BASE_HOST?.trim() || "https://www.paradise30a.com";
const DEFAULT_ANCHOR_URL =
  process.env.PARADISE30A_ANCHOR_URL?.trim() ||
  `${BASE_HOST}/vacation-rentals/results/`;
const DETAIL_PATH_PREFIX = "/vacation-rentals/";
const OUTPUT_ROOT = resolve(
  process.cwd(),
  "src",
  "lib",
  "data",
  "external-sources",
  "paradise30a",
);
const OUTPUT_DETAILS_HTML_DIR = resolve(OUTPUT_ROOT, "details", "html");
const PARADISE30A_ROUTER_PATH = "/vacation-rentals/router/";

const NON_BOOKABLE_ONLINE_REASON_CODE = "non_bookable_online";

function normalizeDetailUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const normalizedHost = new URL(BASE_HOST);
    if (
      parsed.hostname.toLowerCase() !== normalizedHost.hostname.toLowerCase()
    ) {
      return null;
    }

    if (!parsed.pathname.toLowerCase().startsWith(DETAIL_PATH_PREFIX)) {
      return null;
    }

    const leaf = parsed.pathname.split("/").filter(Boolean).at(-1) ?? "";
    if (!leaf || leaf === "vacation-rentals") {
      return null;
    }

    return `${parsed.origin}${parsed.pathname}`.replace(/\/$/, "");
  } catch {
    return null;
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

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&ndash;|&mdash;/gi, "-")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
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

function detectNonBookableOnlineAvailabilityExemption(html: string): {
  exempt: boolean;
  reasonCode: string | null;
  reason: string | null;
  evidence: string[];
} {
  const phraseChecks: Array<{ pattern: RegExp; evidence: string }> = [
    {
      pattern: /this rental cannot be booked online/i,
      evidence: "this rental cannot be booked online",
    },
    {
      pattern: /request information/i,
      evidence: "request information",
    },
    {
      pattern: /contact our reservation staff/i,
      evidence: "contact our reservation staff",
    },
    {
      pattern: /send us a note through the form below/i,
      evidence: "send us a note through the form below",
    },
  ];

  const evidence = phraseChecks
    .filter((check) => check.pattern.test(html))
    .map((check) => check.evidence);

  if (evidence.length === 0) {
    return {
      exempt: false,
      reasonCode: null,
      reason: null,
      evidence: [],
    };
  }

  return {
    exempt: true,
    reasonCode: NON_BOOKABLE_ONLINE_REASON_CODE,
    reason:
      "Listing explicitly indicates online booking is disabled and requires reservation staff contact.",
    evidence: dedupePreserveOrder(evidence),
  };
}

function dedupePreserveOrder(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
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

function formatIsoDateFromSlash(value: string): string | null {
  const match = value.trim().match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (!match) {
    return null;
  }
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function parseIsoDate(value: string): Date | null {
  const iso = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    return null;
  }
  const parsed = new Date(`${iso}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isoFromDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function eachIsoDateInclusive(startIso: string, endIso: string): string[] {
  const start = parseIsoDate(startIso);
  const end = parseIsoDate(endIso);
  if (!start || !end || end < start) {
    return [];
  }

  const out: string[] = [];
  const cursor = new Date(start.getTime());
  while (cursor <= end) {
    out.push(isoFromDate(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

function weekdayIndexSunday0(isoDate: string): number | null {
  const parsed = parseIsoDate(isoDate);
  if (!parsed) {
    return null;
  }
  return parsed.getUTCDay();
}

function extractBedroomBreakdownLines(rawDescriptionHtml: string): string[] {
  const withBreaks = rawDescriptionHtml
    .replace(/<\/p>/gi, "\n")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/h[1-6]>/gi, "\n")
    .replace(/<\/div>/gi, "\n");

  const normalized = decodeEntities(stripHtml(withBreaks))
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n+/g, "\n")
    .trim();

  if (!normalized) {
    return [];
  }

  const lines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const sectionStartIndex = lines.findIndex((line) =>
    /^bedroom\s+breakdown\s*:?$/i.test(line),
  );
  if (sectionStartIndex < 0) {
    return [];
  }

  const guidance: string[] = [];
  for (let index = sectionStartIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line) {
      continue;
    }

    if (
      /^amenities\s*:?$/i.test(line) ||
      /^location\s*:?$/i.test(line) ||
      /^house\s+rules\s*:?$/i.test(line) ||
      /^reviews?\s*:?$/i.test(line)
    ) {
      break;
    }

    const cleaned = line.replace(/^[-*]\s*/, "").trim();
    if (!cleaned) {
      continue;
    }

    if (/^bedroom\s+breakdown\s*:?$/i.test(cleaned)) {
      continue;
    }

    // Keep floor headers and bedroom lines as guidance entries.
    if (/floor/i.test(cleaned) || /bedroom|bunk|sleeps?/i.test(cleaned)) {
      guidance.push(cleaned);
    }
  }

  return dedupePreserveOrder(guidance);
}

function addDays(isoDate: string, offset: number): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function buildFallbackAvailability(horizonDays: number): {
  windowStart: string;
  windowEnd: string;
  dayCodes: string;
  days: Paradise30ADetailRecord["normalized_availability"]["days"];
} {
  const safeHorizon = Math.max(30, horizonDays);
  const windowStart = new Date().toISOString().slice(0, 10);
  const days: Paradise30ADetailRecord["normalized_availability"]["days"] = [];

  for (let index = 0; index < safeHorizon; index += 1) {
    const date = addDays(windowStart, index);
    days.push({
      date,
      day_code: "N",
      status_code: "U",
      changeover_code: "X",
      is_available: false,
      is_available_for_checkin: false,
      is_available_for_checkout: false,
      booking_day_state: "blocked",
      min_nights_required: null,
    });
  }

  const windowEnd = days[days.length - 1]?.date ?? windowStart;
  return {
    windowStart,
    windowEnd,
    dayCodes: "U".repeat(days.length),
    days,
  };
}

type CalendarBooking = {
  start: string;
  end: string;
};

type CalendarMinDays = {
  startDate: string;
  endDate: string;
  minimum: number;
};

type CalendarTurnDays = {
  startDate: string;
  endDate: string;
  checkin: string;
  checkout: string;
  enforceWeekly?: number;
};

type ParsedCalendarPayload = {
  bookings: CalendarBooking[];
  minDays: CalendarMinDays[];
  turnDays: CalendarTurnDays[];
};

function parseCalendarPayload(html: string): ParsedCalendarPayload | null {
  const bookingsMatch = html.match(
    /bookings\s*:\s*(\[[\s\S]*?\])\s*,\s*rates\s*:/i,
  );
  const minDaysMatch = html.match(
    /minDays\s*:\s*(\[[\s\S]*?\])\s*,\s*turnDays\s*:/i,
  );
  const turnDaysMatch = html.match(
    /turnDays\s*:\s*(\[[\s\S]*?\])\s*,\s*displayCalRates\s*:/i,
  );

  if (!bookingsMatch?.[1] || !minDaysMatch?.[1] || !turnDaysMatch?.[1]) {
    return null;
  }

  try {
    const bookings = JSON.parse(bookingsMatch[1]) as CalendarBooking[];
    const minDays = JSON.parse(minDaysMatch[1]) as CalendarMinDays[];
    const turnDays = JSON.parse(turnDaysMatch[1]) as CalendarTurnDays[];
    if (
      !Array.isArray(bookings) ||
      !Array.isArray(minDays) ||
      !Array.isArray(turnDays)
    ) {
      return null;
    }
    return { bookings, minDays, turnDays };
  } catch {
    return null;
  }
}

function toCanonicalDayCodeFromStatus(
  status: ParadiseDayCode,
): CanonicalDayCode {
  return status === "A" || status === "O" ? "Y" : "N";
}

function toChangeoverCodeFromStatus(
  status: ParadiseDayCode,
): CanonicalChangeoverCode {
  if (status === "I") {
    return "I";
  }
  if (status === "O") {
    return "O";
  }
  return status === "A" ? "C" : "X";
}

function applyStatusCodeToDay(
  day: Paradise30ADetailRecord["normalized_availability"]["days"][number],
  statusCode: ParadiseDayCode,
): void {
  day.status_code = statusCode;
  day.day_code = toCanonicalDayCodeFromStatus(statusCode);
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

function enforceExplicitTurnDayBoundaries(
  days: Paradise30ADetailRecord["normalized_availability"]["days"],
): void {
  if (days.length < 2) {
    return;
  }

  for (let index = 1; index < days.length; index += 1) {
    const previousDay = days[index - 1];
    const currentDay = days[index];
    if (!previousDay || !currentDay) {
      continue;
    }

    if (previousDay.status_code === "U" && currentDay.status_code === "A") {
      applyStatusCodeToDay(currentDay, "I");
      continue;
    }

    if (previousDay.status_code === "A" && currentDay.status_code === "U") {
      applyStatusCodeToDay(previousDay, "O");
    }
  }
}

function buildAvailabilityFromCalendarPayload(payload: ParsedCalendarPayload): {
  windowStart: string;
  windowEnd: string;
  dayCodes: string;
  days: Paradise30ADetailRecord["normalized_availability"]["days"];
  minNightRules: Paradise30ADetailRecord["normalized_availability"]["min_night_rules"];
  counts: Paradise30ADetailRecord["normalized_availability"]["counts"];
} | null {
  const allRangeDates = [
    ...payload.bookings.flatMap((entry) => [entry.start, entry.end]),
    ...payload.minDays.flatMap((entry) => [entry.startDate, entry.endDate]),
    ...payload.turnDays.flatMap((entry) => [entry.startDate, entry.endDate]),
  ]
    .map((value) => formatIsoDateFromSlash(String(value)))
    .filter((value): value is string => Boolean(value));

  if (allRangeDates.length === 0) {
    return null;
  }

  const sortedRangeDates = Array.from(new Set(allRangeDates)).sort((a, b) =>
    a.localeCompare(b),
  );
  const windowStart = sortedRangeDates[0] ?? "";
  const windowEnd = sortedRangeDates[sortedRangeDates.length - 1] ?? "";
  if (!windowStart || !windowEnd) {
    return null;
  }

  const bookingRanges = payload.bookings
    .map((entry) => {
      const start = formatIsoDateFromSlash(String(entry.start));
      const end = formatIsoDateFromSlash(String(entry.end));
      if (!start || !end) {
        return null;
      }
      return { start, end };
    })
    .filter((entry): entry is { start: string; end: string } => Boolean(entry));

  const minDayRules = payload.minDays
    .map((entry) => {
      const start = formatIsoDateFromSlash(String(entry.startDate));
      const end = formatIsoDateFromSlash(String(entry.endDate));
      const minimum = Number(entry.minimum);
      if (!start || !end || !Number.isFinite(minimum) || minimum <= 0) {
        return null;
      }
      return {
        start_date: start,
        end_date: end,
        min_nights: Math.floor(minimum),
        raw_rule: `${start}..${end}:${Math.floor(minimum)}`,
      };
    })
    .filter(
      (
        entry,
      ): entry is {
        start_date: string;
        end_date: string;
        min_nights: number;
        raw_rule: string;
      } => Boolean(entry),
    );

  const turnRules = payload.turnDays
    .map((entry) => {
      const start = formatIsoDateFromSlash(String(entry.startDate));
      const end = formatIsoDateFromSlash(String(entry.endDate));
      if (!start || !end) {
        return null;
      }

      let checkin: number[] = [];
      let checkout: number[] = [];
      try {
        checkin = JSON.parse(entry.checkin) as number[];
        checkout = JSON.parse(entry.checkout) as number[];
      } catch {
        return null;
      }

      if (
        !Array.isArray(checkin) ||
        !Array.isArray(checkout) ||
        checkin.length < 7 ||
        checkout.length < 7
      ) {
        return null;
      }

      return {
        start,
        end,
        checkin,
        checkout,
      };
    })
    .filter(
      (
        entry,
      ): entry is {
        start: string;
        end: string;
        checkin: number[];
        checkout: number[];
      } => Boolean(entry),
    );

  const dayDates = eachIsoDateInclusive(windowStart, windowEnd);
  if (dayDates.length === 0) {
    return null;
  }

  const days: Paradise30ADetailRecord["normalized_availability"]["days"] = [];

  for (const dateIso of dayDates) {
    const weekday = weekdayIndexSunday0(dateIso);
    let canCheckin = true;
    let canCheckout = true;

    const turnRule = turnRules.find(
      (rule) => dateIso >= rule.start && dateIso <= rule.end,
    );
    if (turnRule && weekday !== null) {
      canCheckin = Number(turnRule.checkin[weekday] ?? 0) === 1;
      canCheckout = Number(turnRule.checkout[weekday] ?? 0) === 1;
    }

    const minRule = minDayRules.find(
      (rule) => dateIso >= rule.start_date && dateIso <= rule.end_date,
    );
    const booking = bookingRanges.find(
      (range) => dateIso >= range.start && dateIso <= range.end,
    );

    let statusCode: ParadiseDayCode;
    if (booking) {
      if (dateIso === booking.start) {
        statusCode = "O";
      } else if (dateIso === booking.end) {
        statusCode = "I";
      } else {
        statusCode = "U";
      }
    } else if (canCheckin && canCheckout) {
      statusCode = "A";
    } else if (canCheckin && !canCheckout) {
      statusCode = "I";
    } else if (!canCheckin && canCheckout) {
      statusCode = "O";
    } else {
      statusCode = "U";
    }

    const day: Paradise30ADetailRecord["normalized_availability"]["days"][number] =
      {
        date: dateIso,
        day_code: toCanonicalDayCodeFromStatus(statusCode),
        status_code: statusCode,
        changeover_code: toChangeoverCodeFromStatus(statusCode),
        is_available: statusCode === "A" || statusCode === "O",
        is_available_for_checkin: statusCode === "A" || statusCode === "I",
        is_available_for_checkout: statusCode === "A" || statusCode === "O",
        booking_day_state:
          statusCode === "A" || statusCode === "O"
            ? "bookable"
            : statusCode === "U" || statusCode === "I"
              ? "blocked"
              : "unknown",
        min_nights_required: minRule ? minRule.min_nights : null,
      };

    days.push(day);
  }

  enforceExplicitTurnDayBoundaries(days);

  let available = 0;
  let unavailable = 0;
  let checkinOnly = 0;
  let checkoutOnly = 0;
  let other = 0;
  let bookingAvailable = 0;
  let bookingUnavailable = 0;
  let bookingUnknown = 0;

  for (const day of days) {
    const statusCode = day.status_code;
    if (statusCode === "A") {
      available += 1;
    } else if (statusCode === "U") {
      unavailable += 1;
    } else if (statusCode === "I") {
      checkinOnly += 1;
    } else if (statusCode === "O") {
      checkoutOnly += 1;
    } else {
      other += 1;
    }

    if (day.booking_day_state === "bookable") {
      bookingAvailable += 1;
    } else if (day.booking_day_state === "blocked") {
      bookingUnavailable += 1;
    } else {
      bookingUnknown += 1;
    }
  }

  const dayCodes = days.map((day) => day.status_code).join("");
  return {
    windowStart,
    windowEnd,
    dayCodes,
    days,
    minNightRules: minDayRules,
    counts: {
      available,
      unavailable,
      checkin_only: checkinOnly,
      checkout_only: checkoutOnly,
      other,
      booking_available: bookingAvailable,
      booking_unavailable: bookingUnavailable,
      booking_unknown: bookingUnknown,
    },
  };
}

function extractSectionHtmlById(html: string, sectionId: string): string {
  const sectionPattern = new RegExp(
    `<section[^>]*id=["']${sectionId}["'][^>]*>([\\s\\S]*?)<\\/section>`,
    "i",
  );
  const match = html.match(sectionPattern);
  return match?.[1] ?? "";
}

function extractOverviewDescription(html: string): string {
  const section = extractSectionHtmlById(html, "description");
  if (!section) {
    return "";
  }

  const nestedMatch = section.match(
    /<div[^>]*class=["'][^"']*detailsec-content[^"']*["'][^>]*>\s*<div[^>]*class=["'][^"']*detailsec-content[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>/i,
  );
  if (nestedMatch?.[1]) {
    return decodeEntities(stripHtml(nestedMatch[1])).trim();
  }

  const firstBlock = section.match(
    /<div[^>]*class=["'][^"']*detailsec-content[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
  );
  return decodeEntities(stripHtml(firstBlock?.[1] ?? section)).trim();
}

function extractAmenitiesFromSection(html: string): {
  categories: Record<string, string[]>;
  all: string[];
} {
  const section = extractSectionHtmlById(html, "amenities");
  if (!section) {
    return { categories: {}, all: [] };
  }

  const categories: Record<string, string[]> = {};

  const groupStarts = Array.from(
    section.matchAll(
      /<div[^>]*class=["'][^"']*amen-group-wrap[^"']*["'][^>]*>/gi,
    ),
  )
    .map((match) => match.index)
    .filter((index): index is number => typeof index === "number");

  for (let index = 0; index < groupStarts.length; index += 1) {
    const start = groupStarts[index];
    const end = groupStarts[index + 1] ?? section.length;
    const groupHtml = section.slice(start, end);

    const categoryName = decodeEntities(
      stripHtml(
        groupHtml.match(
          /<div[^>]*class=["'][^"']*amencat[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
        )?.[1] ?? "",
      ),
    ).trim();

    const amenityItems = Array.from(
      groupHtml.matchAll(
        /<div[^>]*class=["'][^"']*pdamenity[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi,
      ),
    )
      .map((match) => decodeEntities(stripHtml(match[1] ?? "")).trim())
      .filter((value) => value.length > 0);

    if (categoryName && amenityItems.length > 0) {
      categories[categoryName] = dedupePreserveOrder(amenityItems);
    }
  }

  const all = dedupePreserveOrder(
    Object.values(categories)
      .flat()
      .map((value) => value.trim())
      .filter(Boolean),
  );

  return { categories, all };
}

function extractFirst(regex: RegExp, value: string): string {
  const match = value.match(regex);
  if (!match?.[1]) {
    return "";
  }
  return decodeEntities(stripHtml(match[1]));
}

function extractMetaContent(html: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(
    `<meta[^>]+(?:name|property)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`,
    "i",
  );
  return decodeEntities(stripHtml(html.match(regex)?.[1] ?? ""));
}

function extractImageUrls(html: string): string[] {
  const urls = new Set<string>();
  for (const match of html.matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
    const value = match[0];
    if (!value) {
      continue;
    }

    if (!/\/unitimages\/\d+\/image_/i.test(value)) {
      continue;
    }

    urls.add(value.replace(/["',)]$/, ""));
  }
  return Array.from(urls);
}

type ParadisePropDetails = {
  unit_id?: string;
  prop_number?: string;
  address?: string;
  city?: string;
  state?: string;
  bed?: number;
  bath?: number;
  sleeps?: number;
  description?: string;
  area?: string;
  geocode?: string;
};

function extractPropDetails(html: string): ParadisePropDetails | null {
  const match = html.match(
    /propDetails\s*:\s*(\{[\s\S]*?\})\s*,\s*[A-Za-z_$][\w$]*\s*:/i,
  );
  if (!match?.[1]) {
    return null;
  }

  try {
    const parsed = JSON.parse(match[1]) as ParadisePropDetails;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function toNumberOrNull(value: unknown): number | null {
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

function pickFirstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string") {
      const trimmed = decodeEntities(value).trim();
      if (trimmed) {
        return trimmed;
      }
    }
  }
  return "";
}

function extractIconMetric(
  html: string,
  label: "Bedrooms" | "Bathrooms" | "Sleeps",
): number | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(
    new RegExp(`${escaped}\\s*:\\s*(\\d+(?:\\.\\d+)?)`, "i"),
  );
  if (!match?.[1]) {
    return null;
  }
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractLatLon(html: string): {
  latitude: number | null;
  longitude: number | null;
} {
  const geocodeMatch = html.match(
    /"geocode"\s*:\s*"\s*(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)\s*"/i,
  );
  if (geocodeMatch?.[1] && geocodeMatch?.[2]) {
    const latitude = Number(geocodeMatch[1]);
    const longitude = Number(geocodeMatch[2]);
    if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
      return {
        latitude,
        longitude,
      };
    }
  }

  const latMatch = html.match(
    /(?:latitude|\blat\b)\s*[:=]\s*["']?(-?\d{1,2}\.\d+)/i,
  );
  const lonMatch = html.match(
    /(?:longitude|\blng\b|\blon\b|\blong\b)\s*[:=]\s*["']?(-?\d{1,3}\.\d+)/i,
  );

  const latitude = latMatch ? Number(latMatch[1]) : NaN;
  const longitude = lonMatch ? Number(lonMatch[1]) : NaN;

  return {
    latitude: Number.isFinite(latitude) ? latitude : null,
    longitude: Number.isFinite(longitude) ? longitude : null,
  };
}

function extractQuoteIds(
  html: string,
  detailUrl: string,
): {
  unitId: string;
  listingId: string;
  locid: string | null;
} {
  const unitIdFromHtml =
    html.match(/(?:unitId|unit_id)\s*[:=]\s*["']?(\d+)/i)?.[1] ??
    html.match(/"id"\s*:\s*"?(\d+)"/i)?.[1] ??
    "";

  const parsedUrl = new URL(detailUrl);
  const unitIdFromUrl = parsedUrl.searchParams.get("id")?.trim() ?? "";
  const listingId = canonicalizeExternalListingId(parsedUrl.pathname);
  const locidFromHtml =
    html.match(/(?:locid|locId|locationId)\s*[:=]\s*["']?([\w-]+)/i)?.[1] ??
    null;

  const resolvedUnitId = unitIdFromHtml || unitIdFromUrl || listingId;

  return {
    unitId: resolvedUnitId,
    listingId,
    locid: locidFromHtml,
  };
}

async function discoverListings(
  page: import("playwright").Page,
  anchorUrl: string,
  _maxScrollSteps: number,
  _scrollPauseMs: number,
  reportProgress: (message: string) => void,
): Promise<ScrapedLink[]> {
  await page.goto(anchorUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

  // Paradise renders listing links on initial results load; avoid expensive scroll loops.
  try {
    await page.waitForFunction(
      () => {
        const anchors = Array.from(
          document.querySelectorAll("#list-pane > div.results a[href]"),
        );
        const matching = anchors.filter((anchor) => {
          const href = (anchor as HTMLAnchorElement).href || "";
          return /\/vacation-rentals\/rental\//i.test(href);
        });
        return matching.length >= 80;
      },
      { timeout: 10000 },
    );
  } catch {
    // Fall through to extraction; we still parse whatever is available.
  }

  const links = await page.$$eval(
    "#list-pane > div.results a[href]",
    (anchors) =>
      anchors.map((anchor) => ({
        href: (anchor as HTMLAnchorElement).href,
        text: ((anchor as HTMLAnchorElement).textContent ?? "").trim(),
      })),
  );

  const normalizedHost = new URL(BASE_HOST).hostname.toLowerCase();
  const deduped = new Map<string, ScrapedLink>();

  for (const link of links) {
    try {
      const parsed = new URL(link.href);
      if (parsed.hostname.toLowerCase() !== normalizedHost) {
        continue;
      }

      if (!parsed.pathname.toLowerCase().startsWith(DETAIL_PATH_PREFIX)) {
        continue;
      }

      if (/\/checkout\/?$/i.test(parsed.pathname)) {
        continue;
      }

      if (/\/router\/?$/i.test(parsed.pathname)) {
        continue;
      }

      const normalized = normalizeDetailUrl(parsed.toString());
      if (!normalized) {
        continue;
      }

      if (!deduped.has(normalized)) {
        deduped.set(normalized, {
          link: normalized,
          source_url: anchorUrl,
          anchor_text: link.text,
        });
      }
    } catch {
      continue;
    }
  }

  const results = Array.from(deduped.values()).sort((a, b) =>
    a.link.localeCompare(b.link),
  );

  reportProgress(
    `discovered ${results.length} paradise30a listing detail links`,
  );
  return results;
}

async function fetchDetail(
  detailUrl: string,
  availabilityHorizonDays: number,
): Promise<Paradise30ADetailRecord> {
  const response = await fetch(detailUrl, {
    headers: {
      accept: "text/html,application/xhtml+xml",
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch detail page ${detailUrl}: HTTP ${response.status}`,
    );
  }

  const html = await response.text();
  const fetchedAt = new Date().toISOString();
  const externalListingId = canonicalizeExternalListingId(
    new URL(detailUrl).pathname,
  );

  const htmlPath = resolve(
    OUTPUT_DETAILS_HTML_DIR,
    `${externalListingId}.html`,
  );
  await writeFile(htmlPath, html, "utf8");

  const title =
    extractFirst(/<title[^>]*>([\s\S]*?)<\/title>/i, html) || externalListingId;
  const h1 = extractFirst(/<h1[^>]*>([\s\S]*?)<\/h1>/i, html) || title;
  const canonicalUrl =
    extractFirst(
      /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i,
      html,
    ) || detailUrl;
  const metaDescription =
    extractMetaContent(html, "description") ||
    extractMetaContent(html, "og:description");

  const propDetails = extractPropDetails(html);
  const overviewDescription = extractOverviewDescription(html);
  const amenities = extractAmenitiesFromSection(html);
  const calendarPayload = parseCalendarPayload(html);
  const parsedAvailability = calendarPayload
    ? buildAvailabilityFromCalendarPayload(calendarPayload)
    : null;
  const nonBookableOnlineExemption =
    detectNonBookableOnlineAvailabilityExemption(html);

  const descriptionExpanded = pickFirstString(
    overviewDescription,
    propDetails?.description,
    metaDescription,
  ).slice(0, 40000);

  const roomsGuidanceLines = extractBedroomBreakdownLines(
    overviewDescription || html,
  );

  const imageUrls = dedupePreserveOrder(extractImageUrls(html));
  const { latitude, longitude } = extractLatLon(html);
  const quoteIds = extractQuoteIds(html, detailUrl);

  const beds =
    extractIconMetric(html, "Bedrooms") ??
    toNumberOrNull(propDetails?.bed) ??
    parseFirstNumber(
      descriptionExpanded.match(/bedrooms?\s*[:-]?\s*(\d+(?:\.\d+)?)/i)?.[1] ??
        "",
    );
  const baths =
    extractIconMetric(html, "Bathrooms") ??
    toNumberOrNull(propDetails?.bath) ??
    parseFirstNumber(
      descriptionExpanded.match(/bathrooms?\s*[:-]?\s*(\d+(?:\.\d+)?)/i)?.[1] ??
        "",
    );
  const sleeps =
    extractIconMetric(html, "Sleeps") ??
    toNumberOrNull(propDetails?.sleeps) ??
    parseFirstNumber(
      descriptionExpanded.match(/sleeps?\s*(\d+(?:\.\d+)?)/i)?.[1] ?? "",
    );

  const city =
    pickFirstString(propDetails?.city) ||
    extractFirst(/\b([A-Za-z\s]+),\s*FL\b/, `${title} ${descriptionExpanded}`);
  const state = pickFirstString(propDetails?.state) || "FL";
  const address = pickFirstString(propDetails?.address);
  const area = pickFirstString(propDetails?.area);
  const availability =
    parsedAvailability ?? buildFallbackAvailability(availabilityHorizonDays);

  const normalizedName = normalizeForMatch(h1 || title || externalListingId);
  const normalizedDescription = normalizeForMatch(descriptionExpanded);

  return {
    external_listing_id: externalListingId,
    detail_url: detailUrl,
    fetched_at: fetchedAt,
    html_path: htmlPath,
    listing_flags: {
      non_bookable_online: nonBookableOnlineExemption.exempt,
      availability_validation_exempt: nonBookableOnlineExemption.exempt,
      availability_validation_exempt_reason_code:
        nonBookableOnlineExemption.reasonCode,
      availability_validation_exempt_reason: nonBookableOnlineExemption.reason,
    },
    title,
    h1,
    canonical_url: canonicalUrl,
    meta_description: metaDescription,
    description_expanded: descriptionExpanded,
    rooms_guidance: roomsGuidanceLines.length > 0 ? roomsGuidanceLines : false,
    amenities,
    location: {
      address,
      location_label: city || area,
      directions_url: "",
      directions_daddr: address,
      latitude,
      longitude,
    },
    media_gallery: {
      image_count: imageUrls.length,
      image_urls: imageUrls,
    },
    property_profile: {
      unit_id: quoteIds.unitId || pickFirstString(propDetails?.unit_id),
      area,
      location: city || area,
      beds,
      baths,
      sleeps,
      city,
      state,
    },
    quote_context: {
      source: "cwr_router",
      unit_id: quoteIds.unitId,
      listing_id: quoteIds.listingId,
      locid: quoteIds.locid,
      detail_url: detailUrl,
    },
    normalized_matching_profile: {
      source: "pm_paradise30a",
      external_listing_id: externalListingId,
      name: h1 || title,
      description: descriptionExpanded,
      match_signals: {
        description_normalized: normalizedDescription,
        description_sha256: hashSha256(normalizedDescription),
        title_normalized: normalizedName,
        title_sha256: hashSha256(normalizedName),
        listing_composite_key: hashSha256(
          `${externalListingId}|${normalizedName}`,
        ),
      },
    },
    normalized_availability: {
      source: "pm_paradise30a",
      external_listing_id: externalListingId,
      captured_at: fetchedAt,
      availability_source: parsedAvailability
        ? "listing_calendar"
        : "fallback_unavailable",
      validation_exempt: nonBookableOnlineExemption.exempt,
      validation_exempt_reason_code: nonBookableOnlineExemption.reasonCode,
      validation_exempt_reason: nonBookableOnlineExemption.reason,
      validation_exempt_evidence: nonBookableOnlineExemption.evidence,
      has_calendar_widget: parsedAvailability !== null,
      booking_restrictions:
        parsedAvailability !== null
          ? ["embedded_calendar_component"]
          : nonBookableOnlineExemption.exempt
            ? ["non_bookable_online"]
            : [],
      min_night_rules: parsedAvailability?.minNightRules ?? [],
      window_start: availability.windowStart,
      window_end: availability.windowEnd,
      code_legend: {
        A: "available",
        U: "unavailable",
        I: "checkin_only",
        O: "checkout_only",
        X: "other",
      },
      day_codes: availability.dayCodes,
      days: availability.days,
      counts: parsedAvailability?.counts ?? {
        available: 0,
        unavailable: availability.days.length,
        checkin_only: 0,
        checkout_only: 0,
        other: 0,
        booking_available: 0,
        booking_unavailable: availability.days.length,
        booking_unknown: 0,
      },
    },
    pricing_api_hints: {
      provider: "cwr-router",
      endpoint_path: PARADISE30A_ROUTER_PATH,
      method_names: {
        pre_reservation_price: "getPrice",
      },
      required_payload_fields: [
        "call",
        "unitId",
        "people",
        "arrive",
        "depart",
        "nights",
        "optIn",
        "promoCode",
        "sdpBool",
      ],
      notes:
        "Router-family quote endpoint. Includes locid in checkout handoff when available.",
    },
  };
}

export function createParadise30AAdapter(): ScraperAdapter<Paradise30ADetailRecord> {
  return {
    managerKey: "paradise30a",
    scriptLabel: "paradise30a",
    defaultAnchorUrl: DEFAULT_ANCHOR_URL,
    detailFetchDelayMs: Math.max(
      0,
      Number(process.env.PARADISE30A_DETAIL_FETCH_DELAY_MS ?? "250") || 250,
    ),
    detailFetchConcurrency: Math.max(
      1,
      Number(process.env.PARADISE30A_FETCH_CONCURRENCY ?? "6") || 6,
    ),
    availabilityHorizonDays: Math.max(
      1,
      Number(process.env.PARADISE30A_AVAILABILITY_HORIZON_DAYS ?? "486") || 486,
    ),
    maxCalendarAdvanceMonths: Math.max(
      1,
      Number(process.env.PARADISE30A_CALENDAR_MAX_MONTHS ?? "18") || 18,
    ),
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
        "paradise30a",
        argv,
      );
      await runRuntimeAdapterQuoteCli(
        {
          adapterKey: "paradise30a",
          executeSingleQuote: executeParadise30aSingleQuote,
          defaultQuoteTimeoutMs: 20000,
          defaultQuoteMaxAttempts: 2,
          defaultEndpointPath: PARADISE30A_ROUTER_PATH,
          defaultTaxPct: 0.12,
          defaultBaseNightly: 700,
        },
        normalizedArgs,
        progress,
      );
    },
    async runSingleQuoteObservation(input) {
      const quote = await executeParadise30aSingleQuote({
        listingId: input.listingId,
        checkInIso: input.checkInIso,
        checkOutIso: input.checkOutIso,
        adults: input.adults,
        children: input.children,
        quoteContext:
          input.quoteContext && typeof input.quoteContext === "object"
            ? input.quoteContext
            : null,
      });

      if (!quote.success) {
        return {
          elapsedMs: quote.elapsedMs,
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
            handoffUrl:
              typeof input.handoffUrl === "string" && input.handoffUrl.trim()
                ? input.handoffUrl
                : null,
            reason: quote.error.message,
          },
        };
      }

      return {
        elapsedMs: quote.elapsedMs,
        observation: {
          ...quote.observation,
          reason: quote.observation.quoteAvailable ? null : "quote_unavailable",
        },
      };
    },
  };
}
