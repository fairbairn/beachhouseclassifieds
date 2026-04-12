import { executeOceanreef30aSingleQuote } from "@/lib/pricing/quote-runtime/adapters/oceanreef30a";
import { runRuntimeAdapterQuoteCli } from "@/lib/pricing/quotes/shared/runtime-adapter-quote-runner";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { normalizeAdapterQuoteScopeArgs } from "../quote-scope";
import type { DetailRecordBase, ScrapedLink, ScraperAdapter } from "../types";

type OceanReefDayCode = "A" | "U" | "I" | "O" | "X";

type OceanReefDetailRecord = DetailRecordBase & {
  quote_context?: {
    unit_id: string;
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
    source: "pm_oceanreef30a";
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
    source: "pm_oceanreef30a";
    external_listing_id: string;
    captured_at: string;
    window_start: string;
    window_end: string;
    code_legend: {
      A: "available";
      U: "booked";
      I: "checkin_only";
      O: "checkout_only";
      X: "other";
    };
    day_codes: string;
    days: Array<{
      date: string;
      status_code: OceanReefDayCode;
      is_available: boolean;
      is_available_for_checkin: boolean;
      is_available_for_checkout: boolean;
      booking_day_state: "bookable" | "blocked" | "unknown";
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
    expected_listing_count: number;
    observed_day_cell_count: number;
    observed_status_classes: string[];
  };
};

const DEFAULT_ANCHOR_URL =
  "https://www.oceanreefresorts.com/vacation-rentals?type=4&location=3";

const OUTPUT_ROOT = resolve(
  process.cwd(),
  "src",
  "lib",
  "data",
  "external-sources",
  "oceanreef30a",
);
const OUTPUT_DETAILS_HTML_DIR = resolve(OUTPUT_ROOT, "details", "html");

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

function extractFirst(regex: RegExp, value: string): string {
  const match = value.match(regex);
  if (!match?.[1]) {
    return "";
  }
  return stripHtml(match[1]).trim();
}

function parseNumberLike(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().replace(/,/g, "");
    if (!normalized) {
      return null;
    }
    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function absoluteHttpUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const normalized = new URL(trimmed, "https://www.oceanreefresorts.com")
      .toString()
      .trim();
    if (!/^https?:\/\//i.test(normalized)) {
      return null;
    }
    return normalized;
  } catch {
    return null;
  }
}

function parseJsonLdObjects(html: string): Record<string, unknown>[] {
  const objects: Record<string, unknown>[] = [];
  const scriptRegex =
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

  for (const match of html.matchAll(scriptRegex)) {
    const raw = match[1]?.trim();
    if (!raw) {
      continue;
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item === "object") {
            objects.push(item as Record<string, unknown>);
          }
        }
        continue;
      }

      if (parsed && typeof parsed === "object") {
        objects.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Ignore malformed json-ld blobs.
    }
  }

  return objects;
}

function pickProductSchema(
  schemaObjects: Record<string, unknown>[],
): Record<string, unknown> | null {
  for (const item of schemaObjects) {
    const type = item["@type"];
    if (typeof type === "string" && type.toLowerCase() === "product") {
      return item;
    }
    if (
      Array.isArray(type) &&
      type.some(
        (entry) =>
          typeof entry === "string" && entry.toLowerCase() === "product",
      )
    ) {
      return item;
    }
  }

  return null;
}

function splitSrcsetCandidates(value: string): string[] {
  return value
    .split(",")
    .map((segment) => segment.trim())
    .map((segment) => segment.split(/\s+/)[0] || "")
    .filter(Boolean);
}

function unwrapTrackhsImageSource(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  const decoded = decodeURIComponent(trimmed);
  const lastHttps = decoded.lastIndexOf("https://");
  const lastHttp = decoded.lastIndexOf("http://");
  const startIndex = Math.max(lastHttps, lastHttp);

  if (startIndex > 0) {
    return decoded.slice(startIndex).trim();
  }

  return decoded;
}

function normalizeOceanReefGalleryUrl(value: string): string | null {
  const unwrapped = unwrapTrackhsImageSource(value);
  const normalized = absoluteHttpUrl(unwrapped);
  if (!normalized) {
    return null;
  }

  try {
    const parsed = new URL(normalized);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname;

    const isOceanReefImageBucket =
      host === "track-pm.s3.amazonaws.com" &&
      path.startsWith("/oceanreefresorts/image/");

    if (!isOceanReefImageBucket) {
      return null;
    }

    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return null;
  }
}

function collectMediaUrls(html: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();

  const push = (candidate: string) => {
    const normalized = normalizeOceanReefGalleryUrl(candidate);
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    urls.push(normalized);
  };

  for (const match of html.matchAll(/data-srcset=["']([^"']+)["']/gi)) {
    const srcset = match[1]?.trim() || "";
    for (const candidate of splitSrcsetCandidates(srcset)) {
      push(candidate);
    }
  }

  for (const match of html.matchAll(/srcset=["']([^"']+)["']/gi)) {
    const srcset = match[1]?.trim() || "";
    for (const candidate of splitSrcsetCandidates(srcset)) {
      push(candidate);
    }
  }

  for (const match of html.matchAll(/data-thumb=["']([^"']+)["']/gi)) {
    push(match[1] || "");
  }

  for (const match of html.matchAll(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi)) {
    push(match[1] || "");
  }

  return urls;
}

function extractAmenities(html: string): string[] {
  const values: string[] = [];
  const seen = new Set<string>();
  const amenityRegex =
    /<span[^>]+class=["'][^"']*pdp-amenities-item-text[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi;

  for (const match of html.matchAll(amenityRegex)) {
    const text = stripHtml(match[1] || "").trim();
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    values.push(text);
  }

  return values;
}

function extractBathersCount(html: string): number | null {
  const bathroomLabelIndex = html.search(/<title>\s*Bathroom\s*<\/title>/i);
  if (bathroomLabelIndex >= 0) {
    const tail = html.slice(bathroomLabelIndex, bathroomLabelIndex + 500);
    const fromDetails = tail.match(
      /property-details-text[^>]*>\s*([0-9]+(?:\.[0-9]+)?)\s*Bath/i,
    )?.[1];
    const parsed = parseNumberLike(fromDetails ?? null);
    if (parsed !== null) {
      return parsed;
    }
  }

  const fallback = html.match(/\b([0-9]+(?:\.[0-9]+)?)\s*Baths?\b/i)?.[1];
  return parseNumberLike(fallback ?? null);
}

function formatDateIso(value: Date): string {
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  const day = String(value.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseUsDateToIso(value: string): string | null {
  const match = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) {
    return null;
  }

  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (!month || !day || !year) {
    return null;
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return formatDateIso(date);
}

function normalizeDetailUrl(value: string): string | null {
  try {
    const parsed = new URL(value.trim());
    if (!parsed.hostname.endsWith("oceanreefresorts.com")) {
      return null;
    }

    const cleanPath = parsed.pathname.replace(/\/+$/, "");
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

async function collectListingLinks(
  page: Parameters<
    ScraperAdapter<OceanReefDetailRecord>["discoverListings"]
  >[0]["page"],
): Promise<{ links: string[]; expectedCount: number }> {
  return page.evaluate(() => {
    const discovered = new Set<string>();
    const anchors = Array.from(
      document.querySelectorAll(
        ".srp-results a[href], a.be-property-widget-img-link[href], a[href]",
      ),
    );

    for (const anchor of anchors) {
      const href = anchor.getAttribute("href") || "";
      if (!href) {
        continue;
      }

      try {
        const url = new URL(href, window.location.origin);
        const cleanPath = url.pathname.replace(/\/+$/, "");
        const parts = cleanPath.split("/").filter(Boolean);
        if (parts.length >= 2 && parts[0] === "vacation-rentals") {
          discovered.add(`${url.origin}/vacation-rentals/${parts[1]}`);
        }
      } catch {
        // Ignore invalid href values.
      }
    }

    const expectedIds = new Set<string>();
    const idInputs = Array.from(
      document.querySelectorAll("input[id^='page'][id$='propertyIDs']"),
    );
    for (const input of idInputs) {
      const raw = (input.getAttribute("value") || "").split(",");
      for (const id of raw) {
        const normalized = id.trim();
        if (/^\d+$/.test(normalized)) {
          expectedIds.add(normalized);
        }
      }
    }

    return {
      links: Array.from(discovered),
      expectedCount: expectedIds.size,
    };
  });
}

async function discoverListings(
  page: Parameters<
    ScraperAdapter<OceanReefDetailRecord>["discoverListings"]
  >[0]["page"],
  anchorUrl: string,
  maxScrollSteps: number,
  scrollPauseMs: number,
  reportProgress: (message: string) => void,
): Promise<ScrapedLink[]> {
  const sourceByLink = new Map<string, string>();
  const discovered = new Set<string>();

  await page.goto(anchorUrl, {
    waitUntil: "domcontentloaded",
    timeout: 120000,
  });

  await page.waitForTimeout(Math.max(900, scrollPauseMs));

  let expectedCount = 0;
  let noGrowthRounds = 0;

  const ingestSnapshot = async (): Promise<number> => {
    const snapshot = await collectListingLinks(page);
    expectedCount = Math.max(expectedCount, snapshot.expectedCount);

    let added = 0;
    for (const link of snapshot.links) {
      const normalized = normalizeDetailUrl(link);
      if (!normalized || discovered.has(normalized)) {
        continue;
      }
      discovered.add(normalized);
      sourceByLink.set(normalized, anchorUrl);
      added += 1;
    }

    return added;
  };

  await ingestSnapshot();

  reportProgress(
    `initial inventory snapshot: links=${discovered.size}, expected=${expectedCount || "unknown"}`,
  );

  for (let step = 0; step < maxScrollSteps; step += 1) {
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });

    await page.mouse.wheel(0, 2200);

    const clickedPaginationControl = await page.evaluate(() => {
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

        const text = (element.textContent || "").toLowerCase();
        if (
          text.includes("load more") ||
          text.includes("show more") ||
          text.includes("next")
        ) {
          element.click();
          return true;
        }
      }

      return false;
    });

    await page.waitForTimeout(Math.max(500, scrollPauseMs));

    if (clickedPaginationControl) {
      await page.waitForTimeout(500);
    }

    const beforeCount = discovered.size;
    const added = await ingestSnapshot();
    const afterCount = discovered.size;

    if (added === 0 && afterCount === beforeCount) {
      noGrowthRounds += 1;
    } else {
      noGrowthRounds = 0;
    }

    if ((step + 1) % 4 === 0 || added > 0) {
      reportProgress(
        `scroll step ${step + 1}/${maxScrollSteps}: links=${afterCount}, expected=${expectedCount || "unknown"}`,
      );
    }

    if (expectedCount > 0 && afterCount >= expectedCount) {
      reportProgress(
        `stopping at step ${step + 1}; reached expected listing count ${expectedCount}`,
      );
      break;
    }

    if (noGrowthRounds >= 8) {
      reportProgress(
        `stopping at step ${step + 1}; no growth for ${noGrowthRounds} rounds`,
      );
      break;
    }
  }

  return Array.from(discovered)
    .sort((left, right) => left.localeCompare(right))
    .map((link) => ({
      link,
      source_url: sourceByLink.get(link) ?? anchorUrl,
      anchor_text: "srp-scroll",
    }));
}

function extractPropertyUnitId(html: string): string | null {
  const inputPropertyId = html.match(
    /<input[^>]+name=["']propertyID["'][^>]+value=["'](\d+)["'][^>]*>/i,
  )?.[1];
  if (inputPropertyId) {
    return inputPropertyId;
  }

  const widgetUnitCode = html.match(/data-unitcode=["'](\d+)["']/i)?.[1];
  if (widgetUnitCode) {
    return widgetUnitCode;
  }

  return null;
}

function extractExternalListingId(detailUrl: string): string {
  const normalized = normalizeDetailUrl(detailUrl);
  if (!normalized) {
    return "unknown";
  }

  const parts = new URL(normalized).pathname.split("/").filter(Boolean);
  return parts[1] || "unknown";
}

function mapCalendarClassToCode(statusClass: string): OceanReefDayCode {
  if (statusClass.includes("available")) {
    return "A";
  }
  if (statusClass.includes("check-in")) {
    return "I";
  }
  if (statusClass.includes("check-out")) {
    return "O";
  }
  if (statusClass.includes("booked")) {
    return "U";
  }
  return "X";
}

function extractAvailabilityFromHtml(
  html: string,
  availabilityHorizonDays: number,
): {
  days: OceanReefDetailRecord["normalized_availability"]["days"];
  dayCodes: string;
  observedCount: number;
  observedStatusClasses: string[];
} {
  const now = new Date();
  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const horizon = new Date(today);
  horizon.setUTCDate(horizon.getUTCDate() + availabilityHorizonDays);

  const dayByDate = new Map<
    string,
    {
      date: string;
      status_code: OceanReefDayCode;
      is_available: boolean;
      is_available_for_checkin: boolean;
      is_available_for_checkout: boolean;
      booking_day_state: "bookable" | "blocked" | "unknown";
    }
  >();

  const observedStatusClassSet = new Set<string>();
  const dayCellRegex =
    /<td[^>]*class=["']([^"']*)["'][^>]*data-date=["']([^"']+)["'][^>]*>/gi;
  let match: RegExpExecArray | null = dayCellRegex.exec(html);

  while (match) {
    const className = String(match[1] || "").trim();
    const dateRaw = String(match[2] || "").trim();
    const iso = parseUsDateToIso(dateRaw);

    observedStatusClassSet.add(className);

    if (iso) {
      const date = new Date(`${iso}T00:00:00.000Z`);
      if (date >= today && date <= horizon) {
        const statusCode = mapCalendarClassToCode(className);
        const bookingDayState: "bookable" | "blocked" | "unknown" =
          statusCode === "A"
            ? "bookable"
            : statusCode === "U"
              ? "blocked"
              : "unknown";

        dayByDate.set(iso, {
          date: iso,
          status_code: statusCode,
          is_available: statusCode === "A",
          is_available_for_checkin: statusCode === "A" || statusCode === "I",
          is_available_for_checkout: statusCode === "A" || statusCode === "O",
          booking_day_state: bookingDayState,
        });
      }
    }

    match = dayCellRegex.exec(html);
  }

  const days = Array.from(dayByDate.values()).sort((left, right) =>
    left.date.localeCompare(right.date),
  );

  return {
    days,
    dayCodes: days.map((day) => day.status_code).join(""),
    observedCount: dayByDate.size,
    observedStatusClasses: Array.from(observedStatusClassSet).sort((a, b) =>
      a.localeCompare(b),
    ),
  };
}

async function fetchDetail(
  detailUrl: string,
  availabilityHorizonDays: number,
): Promise<OceanReefDetailRecord | null> {
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

    const schemaObjects = parseJsonLdObjects(html);
    const productSchema = pickProductSchema(schemaObjects);
    const schemaDescription =
      typeof productSchema?.description === "string"
        ? stripHtml(productSchema.description)
        : "";

    const descriptionExpandedRaw =
      extractFirst(
        /<div[^>]+id=["']pdpDescription["'][^>]*>[\s\S]*?<div[^>]+class=["'][^"']*pdp-section-body[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>/i,
        html,
      ) || schemaDescription;
    const descriptionExpanded = stripHtml(descriptionExpandedRaw).slice(
      0,
      50000,
    );

    const amenitiesAll = extractAmenities(html);

    const widgetMatch =
      html.match(
        /<div[^>]+class=["'][^"']*be-property-widget[^"']*["'][^>]*>/i,
      )?.[0] || "";
    const locationAddress =
      widgetMatch.match(/data-straddress1=["']([^"']*)["']/i)?.[1]?.trim() ||
      "";
    const locationLabel =
      widgetMatch.match(/data-strlocation=["']([^"']*)["']/i)?.[1]?.trim() ||
      "";
    const latitude = parseNumberLike(
      widgetMatch.match(/data-latitude=["']([^"']*)["']/i)?.[1] ?? null,
    );
    const longitude = parseNumberLike(
      widgetMatch.match(/data-longitude=["']([^"']*)["']/i)?.[1] ?? null,
    );

    const beds = parseNumberLike(
      widgetMatch.match(/data-dblbeds=["']([^"']*)["']/i)?.[1] ?? null,
    );
    const sleeps = parseNumberLike(
      widgetMatch.match(/data-intoccu=["']([^"']*)["']/i)?.[1] ?? null,
    );
    const baths = extractBathersCount(html);

    const mediaUrls = collectMediaUrls(html);

    const externalListingId = extractExternalListingId(normalizedDetailUrl);
    const unitId = extractPropertyUnitId(html);
    const htmlPath = resolve(
      OUTPUT_DETAILS_HTML_DIR,
      `${externalListingId}.html`,
    );
    await writeFile(htmlPath, `${html}\n`, "utf8");

    const availability = extractAvailabilityFromHtml(
      html,
      availabilityHorizonDays,
    );
    const description = stripHtml(metaDescription).slice(0, 20000);
    const name = stripHtml(h1 || title).slice(0, 240);
    const descriptionNormalized = normalizeForMatch(description);
    const titleNormalized = normalizeForMatch(name);

    const available = availability.days.filter(
      (day) => day.status_code === "A",
    ).length;
    const unavailable = availability.days.filter(
      (day) => day.status_code === "U",
    ).length;
    const checkinOnly = availability.days.filter(
      (day) => day.status_code === "I",
    ).length;
    const checkoutOnly = availability.days.filter(
      (day) => day.status_code === "O",
    ).length;
    const other =
      availability.days.length -
      available -
      unavailable -
      checkinOnly -
      checkoutOnly;

    return {
      external_listing_id: externalListingId,
      detail_url: normalizedDetailUrl,
      ...(unitId
        ? {
            quote_context: {
              unit_id: unitId,
              detail_url: normalizedDetailUrl,
            },
          }
        : {}),
      fetched_at: new Date().toISOString(),
      title,
      h1,
      canonical_url: canonicalUrl,
      meta_description: metaDescription,
      description_expanded: descriptionExpanded,
      amenities: {
        categories: {
          General: amenitiesAll,
        },
        all: amenitiesAll,
      },
      location: {
        address: locationAddress,
        location_label: locationLabel,
        directions_url:
          absoluteHttpUrl(
            `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
              locationAddress || locationLabel,
            )}`,
          ) || "",
        directions_daddr: locationAddress || locationLabel,
        latitude,
        longitude,
      },
      media_gallery: {
        image_count: mediaUrls.length,
        image_urls: mediaUrls,
      },
      property_profile: {
        unit_id: unitId ?? externalListingId,
        area: locationLabel,
        location: locationLabel,
        beds,
        baths,
        sleeps,
        city: "",
        state: "",
      },
      normalized_matching_profile: {
        source: "pm_oceanreef30a",
        external_listing_id: externalListingId,
        name,
        description,
        match_signals: {
          description_normalized: descriptionNormalized,
          description_sha256: hashSha256(descriptionNormalized),
          title_normalized: titleNormalized,
          title_sha256: hashSha256(titleNormalized),
          listing_composite_key: [
            "pm_oceanreef30a",
            externalListingId,
            hashSha256(descriptionNormalized),
            hashSha256(titleNormalized),
          ].join("::"),
        },
      },
      normalized_availability: {
        source: "pm_oceanreef30a",
        external_listing_id: externalListingId,
        captured_at: new Date().toISOString(),
        window_start: availability.days[0]?.date ?? "",
        window_end: availability.days[availability.days.length - 1]?.date ?? "",
        code_legend: {
          A: "available",
          U: "booked",
          I: "checkin_only",
          O: "checkout_only",
          X: "other",
        },
        day_codes: availability.dayCodes,
        days: availability.days,
        counts: {
          available,
          unavailable,
          checkin_only: checkinOnly,
          checkout_only: checkoutOnly,
          other,
          booking_available: availability.days.filter(
            (day) => day.booking_day_state === "bookable",
          ).length,
          booking_unavailable: availability.days.filter(
            (day) => day.booking_day_state === "blocked",
          ).length,
          booking_unknown: availability.days.filter(
            (day) => day.booking_day_state === "unknown",
          ).length,
        },
      },
      availability_raw: {
        expected_listing_count: 0,
        observed_day_cell_count: availability.observedCount,
        observed_status_classes: availability.observedStatusClasses,
      },
      html_path: htmlPath,
    };
  } catch {
    return null;
  }
}

export function createOceanReef30AAdapter(): ScraperAdapter<OceanReefDetailRecord> {
  return {
    managerKey: "oceanreef30a",
    scriptLabel: "oceanreef30a",
    defaultAnchorUrl: DEFAULT_ANCHOR_URL,
    detailFetchDelayMs: Math.max(
      0,
      Number(process.env.OCEANREEF30A_DETAIL_FETCH_DELAY_MS ?? "300") || 300,
    ),
    detailFetchConcurrency: Math.max(
      1,
      Number(process.env.OCEANREEF30A_FETCH_CONCURRENCY ?? "4") || 4,
    ),
    availabilityHorizonDays: Math.max(
      1,
      Number(process.env.OCEANREEF30A_AVAILABILITY_HORIZON_DAYS ?? "730") ||
        730,
    ),
    maxCalendarAdvanceMonths: Math.max(
      1,
      Number(process.env.OCEANREEF30A_MAX_CALENDAR_ADVANCE_MONTHS ?? "24") ||
        24,
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
        "oceanreef30a",
        argv,
      );
      await runRuntimeAdapterQuoteCli(
        {
          adapterKey: "oceanreef30a",
          executeSingleQuote: executeOceanreef30aSingleQuote,
          defaultQuoteTimeoutMs: 20000,
          defaultQuoteMaxAttempts: 2,
          defaultEndpointPath: "/ajax/pricesummary/",
          defaultTaxPct: 0.12,
          defaultBaseNightly: 650,
        },
        normalizedArgs,
        progress,
      );
    },
    async runSingleQuoteObservation(input, progress) {
      const result = await executeOceanreef30aSingleQuote({
        listingId: input.listingId,
        checkInIso: input.checkInIso,
        checkOutIso: input.checkOutIso,
        adults: input.adults,
        children: input.children,
        quoteContext: input.quoteContext ?? null,
        options: {
          timeoutMs: Number(process.env.QUOTE_CAPTURE_TIMEOUT_MS ?? "20000"),
        },
      });

      if (result.success) {
        return {
          elapsedMs: result.elapsedMs,
          observation: {
            ...result.observation,
            reason: result.observation.quoteAvailable
              ? null
              : "quote_unavailable",
          },
        };
      }

      progress?.tick(
        `runtime quote failed listing=${input.listingId} code=${result.error.code}`,
      );

      return {
        elapsedMs: result.elapsedMs,
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
          reason: result.error.code,
        },
      };
    },
  };
}
