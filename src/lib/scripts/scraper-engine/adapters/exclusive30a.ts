import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { DetailRecordBase, ScrapedLink, ScraperAdapter } from "../types";

type ExclusiveBookedDay = {
  d?: string;
  departure_okay?: number;
};

type ExclusiveDetailRecord = DetailRecordBase & {
  title: string;
  h1: string;
  canonical_url: string;
  meta_description: string;
  normalized_matching_profile: {
    source: "pm_exclusive30a";
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
    source: "pm_exclusive30a";
    external_listing_id: string;
    captured_at: string;
    window_start: string;
    window_end: string;
    code_legend: {
      Y: "available";
      N: "not_available";
    };
    day_codes: string;
    days: Array<{
      date: string;
      is_available: boolean;
      status_code: string;
      is_available_for_checkin: boolean;
      is_available_for_checkout: boolean;
      booking_day_state: "bookable" | "blocked" | "unknown";
    }>;
    counts: {
      available: number;
      not_available: number;
      other: number;
      booking_available: number;
      booking_unavailable: number;
      booking_unknown: number;
    };
  };
  availability_raw: {
    booked_days: ExclusiveBookedDay[];
  };
};

const DEFAULT_ANCHOR_URL = "https://www.exclusive30a.com/vacation-rentals";
const OUTPUT_ROOT = resolve(
  process.cwd(),
  "src",
  "lib",
  "data",
  "external-sources",
  "exclusive30a",
);
const OUTPUT_DETAILS_HTML_DIR = resolve(OUTPUT_ROOT, "details", "html");

function stripHtml(value: string): string {
  return value
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractFirst(regex: RegExp, value: string): string {
  const match = value.match(regex);
  if (!match?.[1]) {
    return "";
  }
  return stripHtml(match[1]).trim();
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

function normalizeDetailUrl(value: string): string | null {
  try {
    const parsed = new URL(value.trim());
    if (!parsed.hostname.endsWith("exclusive30a.com")) {
      return null;
    }

    const cleanPath = parsed.pathname.replace(/\/$/, "");
    const parts = cleanPath.split("/").filter(Boolean);
    if (parts.length < 2 || parts[0] !== "vacation-rentals") {
      return null;
    }

    const slug = parts[1];
    if (!slug) {
      return null;
    }

    return `${parsed.origin}/vacation-rentals/${slug}`;
  } catch {
    return null;
  }
}

function parsePageNumber(raw: string): number | null {
  const numberValue = Number(raw);
  if (!Number.isInteger(numberValue) || numberValue < 1) {
    return null;
  }
  return numberValue;
}

function parseBookedDaysFromHtml(html: string): ExclusiveBookedDay[] {
  const match = html.match(/var\s+booked_days\s*=\s*(\[[\s\S]*?\]);/i);
  if (!match?.[1]) {
    return [];
  }

  try {
    const parsed = JSON.parse(match[1]) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((entry) => entry && typeof entry === "object") as
      | ExclusiveBookedDay[]
      | [];
  } catch {
    return [];
  }
}

function extractListingIdFromHtml(html: string, detailUrl: string): string {
  const unitDataId = html.match(
    /var\s+unitData\s*=\s*\{[\s\S]*?unitID['"]?\s*:\s*(\d+)/i,
  )?.[1];
  if (unitDataId) {
    return unitDataId;
  }

  const dataFavId = html.match(/data-favid=["'](\d+)["']/i)?.[1];
  if (dataFavId) {
    return dataFavId;
  }

  const ecommerceItemId = html.match(
    /['"]item_id['"]\s*:\s*['"]?(\d+)['"]?/i,
  )?.[1];
  if (ecommerceItemId) {
    return ecommerceItemId;
  }

  const normalized = normalizeDetailUrl(detailUrl);
  if (!normalized) {
    return "unknown";
  }

  const parts = new URL(normalized).pathname.split("/").filter(Boolean);
  return parts[1] || "unknown";
}

function yyyymmddToIso(value: string): string | null {
  const normalized = value.trim();
  if (!/^\d{8}$/.test(normalized)) {
    return null;
  }

  const year = Number(normalized.slice(0, 4));
  const month = Number(normalized.slice(4, 6));
  const day = Number(normalized.slice(6, 8));

  if (year < 1900 || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return formatDateIso(date);
}

function formatDateIso(value: Date): string {
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  const day = String(value.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function collectLinksOnCurrentPage(
  page: Parameters<
    ScraperAdapter<ExclusiveDetailRecord>["discoverListings"]
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
          url.hostname.endsWith("exclusive30a.com") &&
          parts[0] === "vacation-rentals" &&
          parts.length >= 2
        ) {
          detailLinks.add(`${url.origin}/vacation-rentals/${parts[1]}`);
        }

        const pageParam = url.searchParams.get("page");
        if (pageParam) {
          const pageNumber = Number(pageParam);
          if (Number.isInteger(pageNumber) && pageNumber > 0) {
            pageNumbers.add(pageNumber);
          }
        }
      } catch {
        // Ignore invalid URLs.
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

async function discoverListings(
  page: Parameters<
    ScraperAdapter<ExclusiveDetailRecord>["discoverListings"]
  >[0]["page"],
  anchorUrl: string,
  maxScrollSteps: number,
  scrollPauseMs: number,
  reportProgress: (message: string) => void,
): Promise<ScrapedLink[]> {
  const discovered = new Set<string>();
  const sourceByLink = new Map<string, string>();

  await page.goto(anchorUrl, {
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
    sourceByLink.set(normalized, anchorUrl);
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
      `pagination detected; traversing ${pageTraversalLimit} pages (reported max=${maxPage})`,
    );
  }

  const start = new URL(anchorUrl);
  for (let pageNumber = 2; pageNumber <= pageTraversalLimit; pageNumber += 1) {
    const pageUrl = new URL(start.toString());
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
        `pagination page ${pageNumber}/${pageTraversalLimit}; links=${discovered.size}`,
      );
    }
  }

  return Array.from(discovered)
    .sort((a, b) => a.localeCompare(b))
    .map((link) => ({
      link,
      source_url: sourceByLink.get(link) ?? anchorUrl,
      anchor_text: "view-home",
    }));
}

async function fetchDetail(
  detailUrl: string,
  availabilityHorizonDays: number,
): Promise<ExclusiveDetailRecord | null> {
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
    const listingId = extractListingIdFromHtml(html, normalizedDetailUrl);

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

    const htmlPath = resolve(OUTPUT_DETAILS_HTML_DIR, `${listingId}.html`);
    await writeFile(htmlPath, `${html}\n`, "utf8");

    const bookedDays = parseBookedDaysFromHtml(html);
    const bookedByDate = new Map<string, ExclusiveBookedDay>();
    for (const entry of bookedDays) {
      const raw = typeof entry.d === "string" ? entry.d : "";
      const iso = yyyymmddToIso(raw);
      if (!iso) {
        continue;
      }
      bookedByDate.set(iso, entry);
    }

    const now = new Date();
    const today = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );

    const normalizedDays: ExclusiveDetailRecord["normalized_availability"]["days"] =
      [];
    for (let offset = 0; offset <= availabilityHorizonDays; offset += 1) {
      const current = new Date(today);
      current.setUTCDate(today.getUTCDate() + offset);
      const date = formatDateIso(current);

      const booked = bookedByDate.get(date);
      if (booked) {
        const checkoutOk = Number(booked.departure_okay) === 1;
        normalizedDays.push({
          date,
          is_available: false,
          is_available_for_checkin: false,
          is_available_for_checkout: checkoutOk,
          status_code: "N",
          booking_day_state: "blocked",
        });
      } else {
        normalizedDays.push({
          date,
          is_available: true,
          is_available_for_checkin: true,
          is_available_for_checkout: true,
          status_code: "Y",
          booking_day_state: "bookable",
        });
      }
    }

    const available = normalizedDays.filter(
      (day) => day.status_code === "Y",
    ).length;
    const notAvailable = normalizedDays.filter(
      (day) => day.status_code === "N",
    ).length;
    const other = normalizedDays.length - available - notAvailable;

    const name = stripHtml(h1 || title).slice(0, 240);
    const description = stripHtml(metaDescription).slice(0, 20000);
    const titleNormalized = normalizeForMatch(name);
    const descriptionNormalized = normalizeForMatch(description);
    const descriptionHash = hashSha256(descriptionNormalized);
    const titleHash = hashSha256(titleNormalized);

    return {
      external_listing_id: listingId,
      detail_url: normalizedDetailUrl,
      fetched_at: new Date().toISOString(),
      title,
      h1,
      canonical_url: canonicalUrl,
      meta_description: metaDescription,
      normalized_matching_profile: {
        source: "pm_exclusive30a",
        external_listing_id: listingId,
        name,
        description,
        match_signals: {
          description_normalized: descriptionNormalized,
          description_sha256: descriptionHash,
          title_normalized: titleNormalized,
          title_sha256: titleHash,
          listing_composite_key: [
            "pm_exclusive30a",
            listingId,
            descriptionHash,
            titleHash,
          ].join("::"),
        },
      },
      normalized_availability: {
        source: "pm_exclusive30a",
        external_listing_id: listingId,
        captured_at: new Date().toISOString(),
        window_start: normalizedDays[0]?.date ?? "",
        window_end: normalizedDays[normalizedDays.length - 1]?.date ?? "",
        code_legend: {
          Y: "available",
          N: "not_available",
        },
        day_codes: normalizedDays.map((day) => day.status_code).join(""),
        days: normalizedDays,
        counts: {
          available,
          not_available: notAvailable,
          other,
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
      availability_raw: {
        booked_days: bookedDays,
      },
      html_path: htmlPath,
    };
  } catch {
    return null;
  }
}

export function createExclusive30AAdapter(): ScraperAdapter<ExclusiveDetailRecord> {
  return {
    managerKey: "exclusive30a",
    scriptLabel: "exclusive30a",
    defaultAnchorUrl: DEFAULT_ANCHOR_URL,
    detailFetchDelayMs: Math.max(
      0,
      Number(process.env.EXCLUSIVE30A_DETAIL_FETCH_DELAY_MS ?? "250") || 250,
    ),
    detailFetchConcurrency: Math.max(
      1,
      Number(process.env.EXCLUSIVE30A_FETCH_CONCURRENCY ?? "6") || 6,
    ),
    availabilityHorizonDays: Math.max(
      1,
      Number(process.env.EXCLUSIVE30A_AVAILABILITY_HORIZON_DAYS ?? "730") ||
        730,
    ),
    maxCalendarAdvanceMonths: 24,
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
  };
}
