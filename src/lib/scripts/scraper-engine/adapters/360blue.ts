import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";

import type { DetailRecordBase, ScrapedLink, ScraperAdapter } from "../types";

type BookingDayState = "bookable" | "blocked" | "unknown";

type MinNightRule = {
  start_date: string;
  end_date: string;
  min_nights: number;
  raw_rule: string;
};

type DetailRecord360Blue = DetailRecordBase & {
  title: string;
  h1: string;
  canonical_url: string;
  meta_description: string;
  json_ld_name: string;
  json_ld_description: string;
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
): Promise<DetailRecord360Blue | null> {
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

    const dayCodeByDate = new Map<string, "A" | "U" | "I" | "O" | "X">();
    let lastSignature = "";
    let calendarPageClicks = 0;
    let calendarIterationsUsed = 0;

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
      unit_id: externalListingId,
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
    const location: DetailRecord360Blue["location"] = {
      address: parsedAddress,
      location_label: shortAddress,
      directions_url: directionsQuery
        ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(directionsQuery)}`
        : "",
      directions_daddr: directionsQuery,
      latitude: null,
      longitude: null,
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
      description_expanded: descriptionExpanded,
      amenities,
      location,
      media_gallery: mediaGallery,
      property_profile: propertyProfile,
      normalized_availability: normalizedAvailability,
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
  } catch {
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
      );
    },
  };
}
