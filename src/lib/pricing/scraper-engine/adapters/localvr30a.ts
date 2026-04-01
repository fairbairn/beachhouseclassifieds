import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { normalizeAdapterQuoteScopeArgs } from "../quote-scope";
import type { DetailRecordBase, ScrapedLink, ScraperAdapter } from "../types";
import { runLocalvr30aQuoteCli } from "./quotes/localvr30a";

type LocalVrDayCode = "A" | "U" | "I" | "O" | "X";

type LocalVrDetailRecord = DetailRecordBase & {
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
    source: "pm_localvr30a";
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
    source: "pm_localvr30a";
    external_listing_id: string;
    captured_at: string;
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
      status_code: LocalVrDayCode;
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
    expected_listing_count: number;
    observed_day_cell_count: number;
    observed_status_labels: string[];
  };
};

type GuestyProperty = {
  _id?: unknown;
  title?: unknown;
  nickname?: unknown;
  address?: {
    city?: unknown;
  };
};

const DEFAULT_ANCHOR_URL =
  "https://stay.golocalvr.com/listings?city=Carillon+Beach%2CDestin%2CInlet+Beach%2CMiramar+Beach%2CPanama+City+Beach%2CRosemary+Beach%2CSanta+Rosa+Beach%2CSeacrest%2CSeagrove%2CWatersound&guests=1&view=list&adults=1&children=0&infants=0";

const EXPECTED_LISTING_COUNT = 42;

const OUTPUT_ROOT = resolve(
  process.cwd(),
  "src",
  "lib",
  "data",
  "external-sources",
  "localvr30a",
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
    const parsed = Number(value.trim());
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
    const normalized = new URL(trimmed, "https://stay.golocalvr.com")
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

function pickHotelSchema(
  schemaObjects: Record<string, unknown>[],
): Record<string, unknown> | null {
  for (const item of schemaObjects) {
    const type = item["@type"];
    if (typeof type === "string" && type.toLowerCase() === "hotel") {
      return item;
    }
    if (
      Array.isArray(type) &&
      type.some(
        (entry) => typeof entry === "string" && entry.toLowerCase() === "hotel",
      )
    ) {
      return item;
    }
  }

  return null;
}

function normalizeDetailUrl(value: string): string | null {
  try {
    const parsed = new URL(value.trim());
    if (!parsed.hostname.endsWith("stay.golocalvr.com")) {
      return null;
    }

    const path = parsed.pathname.replace(/\/+$/, "");
    const parts = path.split("/").filter(Boolean);
    if (parts.length < 2 || parts[0] !== "property") {
      return null;
    }

    const slugAndId = parts[1];
    if (!slugAndId) {
      return null;
    }

    return `${parsed.origin}/property/${slugAndId}`;
  } catch {
    return null;
  }
}

function normalizeCity(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function extractPropertyId(detailUrl: string): string {
  const normalized = normalizeDetailUrl(detailUrl);
  if (!normalized) {
    return "unknown";
  }

  const slug = new URL(normalized).pathname.split("/").filter(Boolean)[1] || "";
  const id = slug.match(/([a-f0-9]{24})$/i)?.[1];
  return id || slug || "unknown";
}

function mapAvailabilityStatus(
  status: string,
  cta: boolean,
  ctd: boolean,
): LocalVrDayCode {
  const normalizedStatus = status.toLowerCase();

  if (
    normalizedStatus.includes("booked") ||
    normalizedStatus.includes("unavailable")
  ) {
    return "U";
  }

  if (cta && !ctd) {
    return "I";
  }

  if (!cta && ctd) {
    return "O";
  }

  if (normalizedStatus.includes("available")) {
    return "A";
  }

  return "X";
}

function extractAvailabilityFromHtml(
  html: string,
  availabilityHorizonDays: number,
): {
  days: LocalVrDetailRecord["normalized_availability"]["days"];
  dayCodes: string;
  observedStatusLabels: string[];
} {
  const now = new Date();
  const todayUtc = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const horizonUtc = new Date(todayUtc);
  horizonUtc.setUTCDate(horizonUtc.getUTCDate() + availabilityHorizonDays);

  const dayByDate = new Map<
    string,
    LocalVrDetailRecord["normalized_availability"]["days"][number]
  >();
  const observedStatusLabels = new Set<string>();

  const dayPattern =
    /\\"date\\":\\"(\d{4}-\d{2}-\d{2})\\"[\s\S]*?\\"minNights\\":(\d+)[\s\S]*?\\"status\\":\\"([^\\"]+)\\"[\s\S]*?\\"cta\\":(true|false)[\s\S]*?\\"ctd\\":(true|false)/g;

  let match: RegExpExecArray | null = dayPattern.exec(html);
  while (match) {
    const dateIso = String(match[1] || "");
    const minNightsRaw = Number(match[2] || "0");
    const statusRaw = String(match[3] || "");
    const cta = match[4] === "true";
    const ctd = match[5] === "true";

    const date = new Date(`${dateIso}T00:00:00.000Z`);
    if (
      !Number.isNaN(date.getTime()) &&
      date >= todayUtc &&
      date <= horizonUtc
    ) {
      const code = mapAvailabilityStatus(statusRaw, cta, ctd);
      const bookingDayState: "bookable" | "blocked" | "unknown" =
        code === "A" ? "bookable" : code === "U" ? "blocked" : "unknown";

      dayByDate.set(dateIso, {
        date: dateIso,
        status_code: code,
        is_available: code === "A",
        is_available_for_checkin: code === "A" || code === "I",
        is_available_for_checkout: code === "A" || code === "O",
        booking_day_state: bookingDayState,
        min_nights_required:
          Number.isFinite(minNightsRaw) && minNightsRaw > 0
            ? minNightsRaw
            : null,
      });
      observedStatusLabels.add(statusRaw.toLowerCase());
    }

    match = dayPattern.exec(html);
  }

  const days = Array.from(dayByDate.values()).sort((a, b) =>
    a.date.localeCompare(b.date),
  );

  return {
    days,
    dayCodes: days.map((day) => day.status_code).join(""),
    observedStatusLabels: Array.from(observedStatusLabels).sort((a, b) =>
      a.localeCompare(b),
    ),
  };
}

function extractCitySetFromAnchor(anchorUrl: string): Set<string> {
  const parsed = new URL(anchorUrl);
  const cityParam = parsed.searchParams.get("city") || "";
  const values = cityParam
    .split(",")
    .map((city) => city.trim())
    .filter(Boolean)
    .map((city) => normalizeCity(city));
  return new Set(values);
}

function buildDetailUrlFromProperty(property: GuestyProperty): string | null {
  const id =
    typeof property._id === "string"
      ? property._id.trim()
      : String(property._id || "").trim();
  if (!id || !/^[a-f0-9]{24}$/i.test(id)) {
    return null;
  }

  const title =
    typeof property.title === "string"
      ? property.title
      : typeof property.nickname === "string"
        ? property.nickname
        : "";
  const slug = slugify(title || id);
  if (!slug) {
    return null;
  }

  return `https://stay.golocalvr.com/property/${slug}-${id}`;
}

async function discoverListings(
  page: Parameters<
    ScraperAdapter<LocalVrDetailRecord>["discoverListings"]
  >[0]["page"],
  anchorUrl: string,
  maxScrollSteps: number,
  scrollPauseMs: number,
  reportProgress: (message: string) => void,
): Promise<ScrapedLink[]> {
  const citySet = extractCitySetFromAnchor(anchorUrl);
  const discovered = new Set<string>();
  const sourceByLink = new Map<string, string>();
  const apiLinks = new Set<string>();

  page.on("response", (response) => {
    void (async () => {
      try {
        const url = response.url();
        if (!url.includes("/api/properties") || !url.includes("fetchAll=1")) {
          return;
        }

        const payload = (await response.json()) as {
          properties?: GuestyProperty[];
        };
        if (!Array.isArray(payload.properties)) {
          return;
        }

        for (const property of payload.properties) {
          const city =
            typeof property?.address?.city === "string"
              ? normalizeCity(property.address.city)
              : "";
          if (citySet.size > 0 && !citySet.has(city)) {
            continue;
          }

          const detailUrl = buildDetailUrlFromProperty(property);
          if (!detailUrl) {
            continue;
          }

          const normalized = normalizeDetailUrl(detailUrl);
          if (!normalized) {
            continue;
          }

          apiLinks.add(normalized);
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

  await page.waitForTimeout(Math.max(1500, scrollPauseMs * 2));

  const ingestFromDom = async (): Promise<number> => {
    const links = await page.evaluate(() => {
      const values = new Set<string>();
      for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
        const href = anchor.getAttribute("href") || "";
        if (!href) {
          continue;
        }

        try {
          const url = new URL(href, window.location.origin);
          const path = url.pathname.replace(/\/+$/, "");
          if (!path.startsWith("/property/")) {
            continue;
          }

          const parts = path.split("/").filter(Boolean);
          if (parts.length < 2 || !parts[1]) {
            continue;
          }

          values.add(`${url.origin}/property/${parts[1]}`);
        } catch {
          // Ignore malformed href.
        }
      }

      return Array.from(values);
    });

    let added = 0;
    for (const link of links) {
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

  await ingestFromDom();
  reportProgress(
    `initial inventory snapshot: links=${discovered.size}, api_filtered=${apiLinks.size}`,
  );

  let noGrowthRounds = 0;
  for (let step = 0; step < maxScrollSteps; step += 1) {
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);

      const scrollables = Array.from(document.querySelectorAll("*")).filter(
        (node) => {
          if (!(node instanceof HTMLElement)) {
            return false;
          }
          const computed = window.getComputedStyle(node);
          const overflowY = computed.overflowY;
          return (
            (overflowY === "auto" || overflowY === "scroll") &&
            node.scrollHeight > node.clientHeight + 40
          );
        },
      );

      for (const node of scrollables) {
        if (!(node instanceof HTMLElement)) {
          continue;
        }
        node.scrollTop = node.scrollHeight;
      }
    });

    await page.mouse.wheel(0, 2600);
    await page.waitForTimeout(Math.max(700, scrollPauseMs));

    const before = discovered.size;
    const added = await ingestFromDom();
    const after = discovered.size;

    if (added === 0 && before === after) {
      noGrowthRounds += 1;
    } else {
      noGrowthRounds = 0;
    }

    if ((step + 1) % 4 === 0 || added > 0) {
      reportProgress(
        `scroll step ${step + 1}/${maxScrollSteps}: links=${after}, api_filtered=${apiLinks.size}`,
      );
    }

    if (
      apiLinks.size >= EXPECTED_LISTING_COUNT &&
      after >= EXPECTED_LISTING_COUNT
    ) {
      reportProgress(
        `stopping at step ${step + 1}; reached expected listing count ${EXPECTED_LISTING_COUNT}`,
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

  if (apiLinks.size >= EXPECTED_LISTING_COUNT) {
    discovered.clear();
    for (const link of apiLinks) {
      discovered.add(link);
      sourceByLink.set(link, anchorUrl);
    }
    reportProgress(
      `using city-filtered Guesty listing feed as authoritative source: links=${discovered.size}`,
    );
  } else if (apiLinks.size > discovered.size) {
    for (const link of apiLinks) {
      if (discovered.has(link)) {
        continue;
      }
      discovered.add(link);
      sourceByLink.set(link, anchorUrl);
    }
    reportProgress(
      `supplemented discovery from in-page Guesty feed: links=${discovered.size}`,
    );
  }

  return Array.from(discovered)
    .sort((left, right) => left.localeCompare(right))
    .map((link) => ({
      link,
      source_url: sourceByLink.get(link) ?? anchorUrl,
      anchor_text: "srp-scroll",
    }));
}

async function fetchDetail(
  browser: Parameters<
    ScraperAdapter<LocalVrDetailRecord>["fetchDetail"]
  >[0]["browser"],
  detailUrl: string,
  availabilityHorizonDays: number,
): Promise<LocalVrDetailRecord | null> {
  const normalizedDetailUrl = normalizeDetailUrl(detailUrl);
  if (!normalizedDetailUrl) {
    return null;
  }

  const page = await browser.newPage();

  try {
    await page.goto(normalizedDetailUrl, {
      waitUntil: "domcontentloaded",
      timeout: 120000,
    });

    await page.waitForTimeout(1200);

    for (let cycle = 0; cycle < 3; cycle += 1) {
      const clicks = await page.evaluate(() => {
        let count = 0;
        const nodes = Array.from(
          document.querySelectorAll("button, a, [role='button']"),
        );
        for (const node of nodes) {
          const element = node as HTMLElement;
          if (element.offsetParent === null) {
            continue;
          }
          const text =
            `${element.textContent || ""} ${element.getAttribute("aria-label") || ""}`
              .toLowerCase()
              .replace(/\s+/g, " ")
              .trim();
          if (text.includes("read more") || text.includes("show more")) {
            element.click();
            count += 1;
          }
        }
        return count;
      });

      if (clicks === 0) {
        break;
      }
      await page.waitForTimeout(280);
    }

    const html = await page.content();

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

    const summaryText = await page.evaluate(() => {
      const sections = Array.from(document.querySelectorAll("section, div"));
      for (const section of sections) {
        const header = section.querySelector("h2, h3, h4");
        if (!header) {
          continue;
        }
        const headerText = (header.textContent || "").toLowerCase().trim();
        if (headerText !== "summary") {
          continue;
        }

        const text = (section.textContent || "").replace(/\s+/g, " ").trim();
        if (text.length > 40) {
          return text;
        }
      }

      return "";
    });

    const externalListingId = extractPropertyId(normalizedDetailUrl);
    const htmlPath = resolve(
      OUTPUT_DETAILS_HTML_DIR,
      `${externalListingId}.html`,
    );
    await writeFile(htmlPath, `${html}\n`, "utf8");

    const schemaObjects = parseJsonLdObjects(html);
    const hotelSchema = pickHotelSchema(schemaObjects);

    const availability = extractAvailabilityFromHtml(
      html,
      availabilityHorizonDays,
    );

    const descriptionExpanded =
      stripHtml(summaryText).slice(0, 20000) ||
      stripHtml(String(hotelSchema?.description ?? "")).slice(0, 20000) ||
      stripHtml(metaDescription).slice(0, 20000);
    const description = descriptionExpanded;
    const name = stripHtml(h1 || title).slice(0, 240);
    const descriptionNormalized = normalizeForMatch(description);
    const titleNormalized = normalizeForMatch(name);

    const amenitiesCategories: Record<string, string[]> = {};
    const amenitiesAll: string[] = [];
    const seenAmenity = new Set<string>();
    const schemaAmenities = Array.isArray(hotelSchema?.amenityFeature)
      ? (hotelSchema?.amenityFeature as unknown[])
      : [];
    for (const feature of schemaAmenities) {
      if (!feature || typeof feature !== "object") {
        continue;
      }

      const label = (feature as { name?: unknown }).name;
      if (typeof label !== "string") {
        continue;
      }

      const value = stripHtml(label).trim();
      if (!value) {
        continue;
      }

      if (!amenitiesCategories["Property Amenities"]) {
        amenitiesCategories["Property Amenities"] = [];
      }
      amenitiesCategories["Property Amenities"].push(value);

      const dedupeKey = normalizeForMatch(value);
      if (!dedupeKey || seenAmenity.has(dedupeKey)) {
        continue;
      }
      seenAmenity.add(dedupeKey);
      amenitiesAll.push(value);
    }

    const imageUrls: string[] = [];
    const seenImage = new Set<string>();
    const pushImage = (value: string) => {
      const normalized = absoluteHttpUrl(value);
      if (!normalized) {
        return;
      }

      const key = normalized.toLowerCase();
      if (seenImage.has(key)) {
        return;
      }
      seenImage.add(key);
      imageUrls.push(normalized);
    };

    const schemaImages = hotelSchema?.image;
    if (Array.isArray(schemaImages)) {
      for (const entry of schemaImages) {
        if (typeof entry === "string") {
          pushImage(entry);
        }
      }
    } else if (typeof schemaImages === "string") {
      pushImage(schemaImages);
    }

    const largeImageHrefPattern =
      /href=["'](https?:\/\/assets\.guesty\.com\/image\/upload\/[^"']+)["']/gi;
    for (const match of html.matchAll(largeImageHrefPattern)) {
      if (match[1]) {
        pushImage(match[1]);
      }
    }

    const schemaAddress =
      hotelSchema?.address && typeof hotelSchema.address === "object"
        ? (hotelSchema.address as Record<string, unknown>)
        : null;
    const schemaGeo =
      hotelSchema?.geo && typeof hotelSchema.geo === "object"
        ? (hotelSchema.geo as Record<string, unknown>)
        : null;

    const address = String(schemaAddress?.streetAddress ?? "").trim();
    const city = String(schemaAddress?.addressLocality ?? "").trim();
    const state = String(schemaAddress?.addressRegion ?? "").trim();
    const locationLabel = [city, state].filter(Boolean).join(", ");
    const directionsDaddr = [address, city, state].filter(Boolean).join(", ");
    const directionsUrl = directionsDaddr
      ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(
          directionsDaddr,
        )}`
      : "";
    const latitude = parseNumberLike(schemaGeo?.latitude ?? null);
    const longitude = parseNumberLike(schemaGeo?.longitude ?? null);

    const beds = parseNumberLike(hotelSchema?.numberOfBedrooms ?? null);
    const baths = parseNumberLike(hotelSchema?.numberOfBathroomsTotal ?? null);
    const sleeps = parseNumberLike(
      (
        hotelSchema?.occupancy as
          | {
              value?: unknown;
            }
          | undefined
      )?.value ?? null,
    );

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
      fetched_at: new Date().toISOString(),
      html_path: htmlPath,
      title,
      h1,
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
        directions_url: directionsUrl,
        directions_daddr: directionsDaddr,
        latitude,
        longitude,
      },
      media_gallery: {
        image_count: imageUrls.length,
        image_urls: imageUrls,
      },
      property_profile: {
        unit_id: externalListingId,
        area: "30A",
        location: locationLabel,
        beds,
        baths,
        sleeps,
        city,
        state,
      },
      normalized_matching_profile: {
        source: "pm_localvr30a",
        external_listing_id: externalListingId,
        name,
        description,
        match_signals: {
          description_normalized: descriptionNormalized,
          description_sha256: hashSha256(descriptionNormalized),
          title_normalized: titleNormalized,
          title_sha256: hashSha256(titleNormalized),
          listing_composite_key: [
            "pm_localvr30a",
            externalListingId,
            hashSha256(descriptionNormalized),
            hashSha256(titleNormalized),
          ].join("::"),
        },
      },
      normalized_availability: {
        source: "pm_localvr30a",
        external_listing_id: externalListingId,
        captured_at: new Date().toISOString(),
        window_start: availability.days[0]?.date ?? "",
        window_end: availability.days[availability.days.length - 1]?.date ?? "",
        code_legend: {
          A: "available",
          U: "unavailable",
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
        expected_listing_count: EXPECTED_LISTING_COUNT,
        observed_day_cell_count: availability.days.length,
        observed_status_labels: availability.observedStatusLabels,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `localvr30a fetchDetail failed for ${normalizedDetailUrl}: ${message}`,
    );
    return null;
  } finally {
    await page.close();
  }
}

export function createLocalVR30AAdapter(): ScraperAdapter<LocalVrDetailRecord> {
  return {
    managerKey: "localvr30a",
    scriptLabel: "localvr30a",
    defaultAnchorUrl: DEFAULT_ANCHOR_URL,
    detailFetchDelayMs: Math.max(
      0,
      Number(process.env.LOCALVR30A_DETAIL_FETCH_DELAY_MS ?? "500") || 500,
    ),
    detailFetchConcurrency: Math.max(
      1,
      Number(process.env.LOCALVR30A_FETCH_CONCURRENCY ?? "2") || 2,
    ),
    availabilityHorizonDays: Math.max(
      1,
      Number(process.env.LOCALVR30A_AVAILABILITY_HORIZON_DAYS ?? "730") || 730,
    ),
    maxCalendarAdvanceMonths: Math.max(
      1,
      Number(process.env.LOCALVR30A_MAX_CALENDAR_ADVANCE_MONTHS ?? "24") || 24,
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
      return fetchDetail(
        context.browser,
        context.detailUrl,
        context.availabilityHorizonDays,
      );
    },
    async runQuoteCapture(argv, progress) {
      const normalizedArgs = await normalizeAdapterQuoteScopeArgs(
        "localvr30a",
        argv,
      );
      await runLocalvr30aQuoteCli(normalizedArgs, progress);
    },
  };
}
