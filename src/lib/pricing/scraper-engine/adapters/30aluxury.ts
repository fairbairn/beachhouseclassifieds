import { execute30ALuxurySingleQuote } from "@/lib/pricing/quote-runtime/adapters/30aluxury";
import { runRuntimeAdapterQuoteCli } from "@/lib/pricing/quotes/shared/runtime-adapter-quote-runner";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";

import { normalizeAdapterQuoteScopeArgs } from "../quote-scope";
import type { DetailRecordBase, ScrapedLink, ScraperAdapter } from "../types";

type LuxuryDayCode = "A" | "U" | "I" | "O" | "X";

type LuxuryDetailRecord = DetailRecordBase & {
  quote_context: {
    entity_id: number;
    ids_tuple: string;
    rc_type: string;
    detail_url: string;
  };
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
    source: "pm_30aluxury";
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
    source: "pm_30aluxury";
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
  scrape_metrics: {
    total_ms: number;
    page_load_ms: number;
    extraction_ms: number;
    calendar_clicks: number;
    calendar_iterations: number;
  };
};

const DEFAULT_ANCHOR_URL =
  "https://www.30aluxuryvacations.com/vacation-rentals#q=*%3A*";
const OUTPUT_ROOT = resolve(
  process.cwd(),
  "src",
  "lib",
  "data",
  "external-sources",
  "30aluxury",
);
const OUTPUT_DETAILS_HTML_DIR = resolve(OUTPUT_ROOT, "details", "html");

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
  if (!normalizedPath.startsWith("/vacation-rentals/")) {
    return false;
  }

  const slug = normalizedPath.split("/").filter(Boolean).at(-1) ?? "";
  if (
    !slug ||
    slug === "vacation-rentals" ||
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

function parseEntityIdFromHtml(html: string): number | null {
  const patterns = [
    /['"]eid['"]\s*:\s*['"](\d+)['"]/i,
    /\brc-eid-(\d+)\b/i,
    /\bitem_id:(\d+)\b/i,
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

function parseIdsTupleFromHtml(html: string): string | null {
  const patterns = [
    /['"]id['"]\s*:\s*['"](\d+-\d+)['"]/i,
    /\brcav%5BIDs%5D%5B\d+%5D%5B%5D=(\d+-\d+)\b/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return null;
}

function parseRcTypeFromHtml(html: string): string {
  const match = html.match(/['"]type['"]\s*:\s*['"](\d+)['"]/i);
  if (match?.[1]) {
    return match[1].trim();
  }
  return "8";
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
          if (!absolute.hostname.endsWith("30aluxuryvacations.com")) {
            return "";
          }

          const normalizedPath = absolute.pathname
            .toLowerCase()
            .replace(/\/+$/, "");
          if (!normalizedPath.startsWith("/vacation-rentals/")) {
            return "";
          }

          const slug = normalizedPath.split("/").filter(Boolean).at(-1) ?? "";
          if (
            !slug ||
            slug === "vacation-rentals" ||
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
): Promise<LuxuryDetailRecord | null> {
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
        h1: document.querySelector("h1")?.textContent ?? "",
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
        amenitiesCategories: (() => {
          const categories: Record<string, string[]> = {};
          const fields = Array.from(
            document.querySelectorAll(
              '#amenities .field, section#amenities .field, [id="amenities"] .field',
            ),
          );
          for (const field of fields) {
            const heading =
              field.querySelector("h2.field-label")?.textContent ??
              field.querySelector("h3")?.textContent ??
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

    const entityId = parseEntityIdFromHtml(html);
    const idsTuple = parseIdsTupleFromHtml(html);
    const rcType = parseRcTypeFromHtml(html);
    if (!entityId || !idsTuple) {
      throw new Error(
        "Missing required quote identifiers (entity_id or ids_tuple) in detail HTML",
      );
    }

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

    const normalizedMatchingProfile = {
      source: "pm_30aluxury" as const,
      external_listing_id: externalListingId,
      name: stripHtml(extracted.h1 || extracted.title).slice(0, 240),
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
        title_normalized: normalizeForMatch(
          stripHtml(extracted.h1 || extracted.title).slice(0, 240),
        ),
        title_sha256: hashSha256(
          normalizeForMatch(
            stripHtml(extracted.h1 || extracted.title).slice(0, 240),
          ),
        ),
        listing_composite_key: hashSha256(
          `${externalListingId}|${normalizeForMatch(stripHtml(extracted.h1 || extracted.title).slice(0, 240))}`,
        ),
      },
    };

    const extractionMs = Date.now() - beforeLoad - pageLoadMs;
    const totalMs = Date.now() - startedAt;

    return {
      external_listing_id: externalListingId,
      detail_url: detailUrl,
      quote_context: {
        entity_id: entityId,
        ids_tuple: idsTuple,
        rc_type: rcType,
        detail_url: detailUrl,
      },
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
      normalized_availability: {
        source: "pm_30aluxury",
        external_listing_id: externalListingId,
        captured_at: new Date().toISOString(),
        has_calendar_widget: normalizedDays.length > 0,
        booking_restrictions: Array.from(bookingRestrictions),
        min_night_rules: [],
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
      },
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
    console.warn(`[30aluxury] detail pull failed for ${detailUrl}: ${message}`);
    return null;
  } finally {
    await page.close();
  }
}

export function create30ALuxuryAdapter(): ScraperAdapter<LuxuryDetailRecord> {
  return {
    managerKey: "30aluxury",
    scriptLabel: "30aluxury",
    defaultAnchorUrl: DEFAULT_ANCHOR_URL,
    detailFetchDelayMs: Math.max(
      0,
      Number(process.env.LUXURY30A_DETAIL_FETCH_DELAY_MS ?? "120") || 120,
    ),
    detailFetchConcurrency: Math.max(
      1,
      Number(process.env.LUXURY30A_DETAIL_FETCH_CONCURRENCY ?? "4") || 4,
    ),
    availabilityHorizonDays: Math.max(
      1,
      Number(process.env.LUXURY30A_AVAILABILITY_HORIZON_DAYS ?? "730") || 730,
    ),
    maxCalendarAdvanceMonths: Math.max(
      8,
      Number(process.env.LUXURY30A_CALENDAR_MAX_MONTHS ?? "26") || 26,
    ),
    isValidDetailUrl(value: string): string | null {
      try {
        const parsed = new URL(value.trim());
        if (
          !parsed.hostname.endsWith("30aluxuryvacations.com") ||
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
      );
    },
    async runQuoteCapture(argv, progress) {
      const normalizedArgs = await normalizeAdapterQuoteScopeArgs(
        "30aluxury",
        argv,
      );
      await runRuntimeAdapterQuoteCli(
        {
          adapterKey: "30aluxury",
          executeSingleQuote: execute30ALuxurySingleQuote,
          defaultQuoteTimeoutMs: 20000,
          defaultQuoteMaxAttempts: 2,
          defaultEndpointPath: "/rescms/ajax/item/pricing/quote",
          defaultTaxPct: 0.12,
          defaultBaseNightly: 700,
        },
        normalizedArgs,
        progress,
      );
    },
  };
}
