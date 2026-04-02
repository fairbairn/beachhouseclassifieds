import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  runRealjoy30aQuoteCli,
  runRealjoy30aSingleQuoteObservation,
} from "./quotes/realjoy30a";

import { normalizeAdapterQuoteScopeArgs } from "../quote-scope";
import type { DetailRecordBase, ScrapedLink, ScraperAdapter } from "../types";

type RealJoyDayCode = "A" | "U" | "I" | "O" | "X";

type RealJoyDetailRecord = DetailRecordBase & {
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
    source: "pm_realjoy30a";
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
    source: "pm_realjoy30a";
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
      status_code: RealJoyDayCode;
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
  "https://www.realjoy.com/beach-rentals?sortBy=Random&mapsearch=1&sleeps=Any&bedrooms=Any&location=2&type=2";

const OUTPUT_ROOT = resolve(
  process.cwd(),
  "src",
  "lib",
  "data",
  "external-sources",
  "realjoy30a",
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

function normalizeDetailUrl(value: string): string | null {
  try {
    const parsed = new URL(value.trim());
    if (!parsed.hostname.endsWith("realjoy.com")) {
      return null;
    }

    const cleanPath = parsed.pathname.replace(/\/+$/, "");
    const parts = cleanPath.split("/").filter(Boolean);
    if (parts.length < 2 || parts[0] !== "beach-rentals") {
      return null;
    }

    const slug = parts[1];
    if (!slug) {
      return null;
    }

    // Keep only concrete listing detail pages.
    if (
      slug.endsWith("vacation-rentals") ||
      slug === "beach-rentals" ||
      slug === "vacation-condo-rentals" ||
      slug === "townhome-rentals" ||
      slug === "studio-rentals"
    ) {
      return null;
    }

    return `${parsed.origin}/beach-rentals/${slug}`;
  } catch {
    return null;
  }
}

function extractExternalListingId(html: string, detailUrl: string): string {
  const unitCode = html.match(/["']unitcode["']\s*:\s*["']?(\d+)["']?/i)?.[1];
  if (unitCode) {
    return unitCode;
  }

  const pageUnitCode = html.match(/data-unitcode=["'](\d+)["']/i)?.[1];
  if (pageUnitCode) {
    return pageUnitCode;
  }

  const normalized = normalizeDetailUrl(detailUrl);
  if (!normalized) {
    return "unknown";
  }

  const parts = new URL(normalized).pathname.split("/").filter(Boolean);
  return parts[1] || "unknown";
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

function splitSrcsetCandidates(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim().split(/\s+/)[0] || "")
    .filter(Boolean);
}

function toAbsoluteHttpUrl(value: string, baseUrl: string): string | null {
  const raw = value.trim();
  if (!raw) {
    return null;
  }
  try {
    return new URL(raw, baseUrl).toString();
  } catch {
    return null;
  }
}

function collectRealJoyMediaUrls(
  candidates: string[],
  baseUrl: string,
): string[] {
  const urls = new Set<string>();

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    const parts = candidate.includes(",")
      ? splitSrcsetCandidates(candidate)
      : [candidate];

    for (const part of parts) {
      const absolute = toAbsoluteHttpUrl(part, baseUrl);
      if (!absolute) {
        continue;
      }

      if (
        absolute.includes("track-pm.s3.amazonaws.com/realjoy/image") ||
        absolute.includes("img.trackhs.com")
      ) {
        urls.add(absolute);
      }
    }
  }

  return Array.from(urls);
}

function parseMonthHeader(
  value: string,
): { year: number; month: number } | null {
  const monthMap: Record<string, number> = {
    january: 1,
    february: 2,
    march: 3,
    april: 4,
    may: 5,
    june: 6,
    july: 7,
    august: 8,
    september: 9,
    october: 10,
    november: 11,
    december: 12,
  };

  const normalized = value.replace(/\s+/g, " ").trim().toLowerCase();
  const match = normalized.match(/^([a-z]+)\s+(\d{4})$/);
  if (!match?.[1] || !match[2]) {
    return null;
  }

  const month = monthMap[match[1]];
  const year = Number(match[2]);
  if (!month || !Number.isInteger(year)) {
    return null;
  }

  return { year, month };
}

async function collectListingSnapshot(
  page: Parameters<
    ScraperAdapter<RealJoyDetailRecord>["discoverListings"]
  >[0]["page"],
): Promise<{ urls: string[]; propertyIds: string[] }> {
  return page.evaluate(() => {
    const urls = new Set<string>();
    const propertyIds = new Set<string>();

    const anchors = Array.from(document.querySelectorAll("a[href]"));
    for (const anchor of anchors) {
      const href = anchor.getAttribute("href") || "";
      if (!href) {
        continue;
      }

      try {
        const url = new URL(href, window.location.origin);
        const path = url.pathname.replace(/\/+$/, "");
        const parts = path.split("/").filter(Boolean);
        if (parts.length >= 2 && parts[0] === "beach-rentals") {
          urls.add(`${url.origin}/beach-rentals/${parts[1]}`);
        }
      } catch {
        // Ignore malformed href values.
      }
    }

    const idInputs = Array.from(
      document.querySelectorAll(
        "input[id$='propertyIDs'], input[name$='propertyIDs']",
      ),
    );
    for (const input of idInputs) {
      const raw = (input.getAttribute("value") || "").split(",");
      for (const id of raw) {
        const normalized = id.trim();
        if (/^\d+$/.test(normalized)) {
          propertyIds.add(normalized);
        }
      }
    }

    return {
      urls: Array.from(urls),
      propertyIds: Array.from(propertyIds),
    };
  });
}

async function discoverListings(
  page: Parameters<
    ScraperAdapter<RealJoyDetailRecord>["discoverListings"]
  >[0]["page"],
  anchorUrl: string,
  maxScrollSteps: number,
  scrollPauseMs: number,
  reportProgress: (message: string) => void,
): Promise<ScrapedLink[]> {
  const sourceByLink = new Map<string, string>();
  const discovered = new Set<string>();
  const expectedPropertyIds = new Set<string>();

  page.on("response", (response) => {
    void (async () => {
      try {
        const url = response.url();
        if (!url.includes("/ajax/map")) {
          return;
        }

        const payload = (await response.json()) as {
          property?: Array<{ seopropertyname?: unknown; unitcode?: unknown }>;
        };
        if (!Array.isArray(payload.property)) {
          return;
        }

        for (const row of payload.property) {
          const path =
            row && typeof row.seopropertyname === "string"
              ? row.seopropertyname
              : "";
          const unitCode =
            row &&
            (typeof row.unitcode === "string" ||
              typeof row.unitcode === "number")
              ? String(row.unitcode)
              : "";

          if (/^\d+$/.test(unitCode)) {
            expectedPropertyIds.add(unitCode);
          }

          if (!path) {
            continue;
          }

          const normalized = normalizeDetailUrl(
            `https://www.realjoy.com${path}`,
          );
          if (!normalized) {
            continue;
          }
          discovered.add(normalized);
          sourceByLink.set(normalized, anchorUrl);
        }
      } catch {
        // Ignore network parsing failures.
      }
    })();
  });

  await page.goto(anchorUrl, {
    waitUntil: "domcontentloaded",
    timeout: 120000,
  });

  await page.waitForTimeout(Math.max(1200, scrollPauseMs));

  const ingestSnapshot = async (): Promise<number> => {
    const snapshot = await collectListingSnapshot(page);
    let added = 0;

    for (const id of snapshot.propertyIds) {
      expectedPropertyIds.add(id);
    }

    for (const link of snapshot.urls) {
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
    `initial inventory snapshot: links=${discovered.size}, expected_ids=${expectedPropertyIds.size || "unknown"}`,
  );

  let noGrowthRounds = 0;
  for (let step = 0; step < maxScrollSteps; step += 1) {
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });
    await page.mouse.wheel(0, 2400);

    const clickedLoadMore = await page.evaluate(() => {
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

        const className = (element.getAttribute("class") || "").toLowerCase();
        const text =
          `${element.textContent || ""} ${element.getAttribute("aria-label") || ""}`
            .toLowerCase()
            .replace(/\s+/g, " ")
            .trim();

        if (
          text.includes("load more") ||
          text.includes("show more") ||
          text.includes("more properties") ||
          className.includes("load-more") ||
          className.includes("be-page-next")
        ) {
          element.click();
          return true;
        }
      }

      return false;
    });

    await page.waitForTimeout(Math.max(600, scrollPauseMs));
    if (clickedLoadMore) {
      await page.waitForTimeout(900);
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
        `scroll step ${step + 1}/${maxScrollSteps}: links=${afterCount}, expected_ids=${expectedPropertyIds.size || "unknown"}`,
      );
    }

    if (
      expectedPropertyIds.size >= 120 &&
      afterCount >= expectedPropertyIds.size
    ) {
      reportProgress(
        `stopping at step ${step + 1}; reached expected listing count ${expectedPropertyIds.size}`,
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

async function fetchDetail(
  browser: Parameters<
    ScraperAdapter<RealJoyDetailRecord>["fetchDetail"]
  >[0]["browser"],
  detailUrl: string,
  availabilityHorizonDays: number,
  maxCalendarAdvanceMonths: number,
): Promise<RealJoyDetailRecord | null> {
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
      const clicked = await page.evaluate(() => {
        let count = 0;
        const controls = Array.from(
          document.querySelectorAll("button, a, [role='button']"),
        );
        for (const control of controls) {
          const element = control as HTMLElement;
          if (element.offsetParent === null) {
            continue;
          }
          const text = (element.textContent || "").toLowerCase();
          if (text.includes("read more") || text.includes("show more")) {
            element.click();
            count += 1;
          }
        }
        return count;
      });

      if (clicked === 0) {
        break;
      }
      await page.waitForTimeout(350);
    }

    const html = await page.content();

    const hasCalendar = await page.evaluate(
      () => document.querySelectorAll(".ui-datepicker td").length > 0,
    );
    if (!hasCalendar) {
      return null;
    }

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

    const externalListingId = extractExternalListingId(
      html,
      normalizedDetailUrl,
    );

    const extractedFromDom = await page.evaluate(() => {
      const widget = document.querySelector(
        ".be-property-widget",
      ) as HTMLElement | null;

      const amenitiesGroups = Array.from(
        document.querySelectorAll(".pdp-amenities-list-group"),
      ).map((group) => {
        const heading = (
          group.querySelector(".pdp-amenities-list-heading")?.textContent || ""
        )
          .replace(/\s+/g, " ")
          .trim();
        const items = Array.from(
          group.querySelectorAll(".pdp-amenities-item-text"),
        )
          .map((node) => (node.textContent || "").replace(/\s+/g, " ").trim())
          .filter(Boolean);

        return { heading, items };
      });

      const labelValues = {
        bedrooms: "",
        bathrooms: "",
        guests: "",
      };

      for (const label of Array.from(
        document.querySelectorAll(".be-property-widget-info-label"),
      )) {
        const title = (label.querySelector("svg title")?.textContent || "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
        const count = (
          label.querySelector(".be-property-widget-info-label-count")
            ?.textContent || ""
        )
          .replace(/\s+/g, " ")
          .trim();

        if (title.includes("bedroom")) {
          labelValues.bedrooms = count;
        } else if (title.includes("bathroom")) {
          labelValues.bathrooms = count;
        } else if (title.includes("guest")) {
          labelValues.guests = count;
        }
      }

      const descriptionText = (
        document.querySelector("#pdpDescription .pdp-section-body")
          ?.textContent || ""
      )
        .replace(/\s+/g, " ")
        .trim();

      const addressText = (
        document.querySelector(
          ".pdp-property-info-list-item-address .pdp-property-info-list-item-text",
        )?.textContent || ""
      )
        .replace(/\s+/g, " ")
        .trim();

      const locationName = (
        document.querySelector(".pdp-location-name")?.textContent || ""
      )
        .replace(/\s+/g, " ")
        .trim();

      const propertyType = (
        document.querySelector(".pdp-type-name")?.textContent || ""
      )
        .replace(/\s+/g, " ")
        .trim();

      const mediaCandidates: string[] = [];
      const ogImage = document.querySelector(
        'meta[property="og:image"]',
      ) as HTMLMetaElement | null;
      if (ogImage?.content) {
        mediaCandidates.push(ogImage.content);
      }
      if (widget?.dataset.photo) {
        mediaCandidates.push(widget.dataset.photo);
      }

      for (const element of Array.from(
        document.querySelectorAll("[data-srcset]"),
      )) {
        const value =
          (element as HTMLElement).getAttribute("data-srcset") || "";
        if (value) {
          mediaCandidates.push(value);
        }
      }

      for (const element of Array.from(
        document.querySelectorAll("[data-thumb]"),
      )) {
        const value = (element as HTMLElement).getAttribute("data-thumb") || "";
        if (value) {
          mediaCandidates.push(value);
        }
      }

      for (const image of Array.from(document.querySelectorAll("img"))) {
        const src = image.getAttribute("src") || "";
        const srcset = image.getAttribute("srcset") || "";
        if (src) {
          mediaCandidates.push(src);
        }
        if (srcset) {
          mediaCandidates.push(srcset);
        }
      }

      return {
        descriptionText,
        amenitiesGroups,
        mediaCandidates,
        widgetData: {
          unitcode: widget?.dataset.unitcode || "",
          id: widget?.dataset.id || "",
          shortname: widget?.dataset.unitshortname || "",
          straddress1: widget?.dataset.straddress1 || "",
          strlocation: widget?.dataset.strlocation || "",
          latitude: widget?.dataset.latitude || "",
          longitude: widget?.dataset.longitude || "",
          dblbeds: widget?.dataset.dblbeds || "",
          intoccu: widget?.dataset.intoccu || "",
        },
        propertyInfo: {
          address: addressText,
          locationName,
          propertyType,
        },
        labelValues,
      };
    });

    const amenitiesCategories: Record<string, string[]> = {};
    const amenitiesAll = new Set<string>();
    for (const group of extractedFromDom.amenitiesGroups) {
      const heading = stripHtml(group.heading || "");
      const uniqueItems = Array.from(
        new Set(
          (group.items || []).map((item) => stripHtml(item)).filter(Boolean),
        ),
      );
      if (!heading || uniqueItems.length === 0) {
        continue;
      }
      amenitiesCategories[heading] = uniqueItems;
      for (const item of uniqueItems) {
        amenitiesAll.add(item);
      }
    }

    const mediaUrls = collectRealJoyMediaUrls(
      extractedFromDom.mediaCandidates,
      normalizedDetailUrl,
    );
    const htmlPath = resolve(
      OUTPUT_DETAILS_HTML_DIR,
      `${externalListingId}.html`,
    );
    await writeFile(htmlPath, `${html}\n`, "utf8");

    const now = new Date();
    const todayUtc = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const horizonUtc = new Date(todayUtc);
    horizonUtc.setUTCDate(horizonUtc.getUTCDate() + availabilityHorizonDays);

    const byDate = new Map<
      string,
      {
        date: string;
        status_code: RealJoyDayCode;
        is_available: boolean;
        is_available_for_checkin: boolean;
        is_available_for_checkout: boolean;
        booking_day_state: "bookable" | "blocked" | "unknown";
      }
    >();
    const observedStatusClassSet = new Set<string>();

    for (
      let monthStep = 0;
      monthStep <= maxCalendarAdvanceMonths;
      monthStep += 1
    ) {
      const visibleMonths = await page.evaluate(() => {
        const groups = Array.from(
          document.querySelectorAll(".ui-datepicker-group"),
        );
        const monthContainers =
          groups.length > 0
            ? groups
            : Array.from(document.querySelectorAll(".ui-datepicker"));

        return monthContainers.map((group) => ({
          title: (
            group.querySelector(".ui-datepicker-title")?.textContent || ""
          )
            .replace(/\s+/g, " ")
            .trim(),
          cells: Array.from(group.querySelectorAll("td")).map((cell) => ({
            className: (cell.getAttribute("class") || "").trim(),
            text: (cell.textContent || "").replace(/\s+/g, "").trim(),
          })),
        }));
      });

      for (const month of visibleMonths) {
        const monthInfo = parseMonthHeader(month.title);
        if (!monthInfo) {
          continue;
        }

        for (const cell of month.cells) {
          observedStatusClassSet.add(cell.className);

          if (cell.className.includes("ui-datepicker-other-month")) {
            continue;
          }

          if (!/^\d{1,2}$/.test(cell.text)) {
            continue;
          }

          const day = Number(cell.text);
          if (!Number.isInteger(day) || day < 1 || day > 31) {
            continue;
          }

          const iso = `${monthInfo.year}-${String(monthInfo.month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
          const date = new Date(`${iso}T00:00:00.000Z`);
          if (
            Number.isNaN(date.getTime()) ||
            date < todayUtc ||
            date > horizonUtc
          ) {
            continue;
          }

          const code = cell.className.includes("check-out")
            ? "O"
            : cell.className.includes("check-in-only") ||
                cell.className.includes("check-in")
              ? "I"
              : cell.className.includes("unavailable") ||
                  cell.className.includes("booked")
                ? "U"
                : cell.className.includes("available")
                  ? "A"
                  : "X";

          const bookingDayState: "bookable" | "blocked" | "unknown" =
            code === "A" ? "bookable" : code === "U" ? "blocked" : "unknown";

          byDate.set(iso, {
            date: iso,
            status_code: code,
            is_available: code === "A",
            is_available_for_checkin: code === "A" || code === "I",
            is_available_for_checkout: code === "A" || code === "O",
            booking_day_state: bookingDayState,
          });
        }
      }

      const movedNext = await page.evaluate(() => {
        const next = document.querySelector(
          ".ui-datepicker-next:not(.ui-state-disabled)",
        );
        if (!(next instanceof HTMLElement)) {
          return false;
        }
        next.click();
        return true;
      });

      if (!movedNext) {
        break;
      }

      await page.waitForTimeout(160);
    }

    const calendar = {
      days: Array.from(byDate.values()).sort((a, b) =>
        a.date.localeCompare(b.date),
      ),
      dayCodes: Array.from(byDate.values())
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((day) => day.status_code)
        .join(""),
      observedCount: byDate.size,
      observedStatusClasses: Array.from(observedStatusClassSet).sort((a, b) =>
        a.localeCompare(b),
      ),
    };

    const descriptionExpanded =
      stripHtml(extractedFromDom.descriptionText).slice(0, 20000) ||
      stripHtml(metaDescription).slice(0, 20000);
    const description = descriptionExpanded;
    const name = stripHtml(h1 || title).slice(0, 240);
    const descriptionNormalized = normalizeForMatch(description);
    const titleNormalized = normalizeForMatch(name);

    const widget = extractedFromDom.widgetData;
    const locationInfo = extractedFromDom.propertyInfo;
    const address =
      widget.straddress1 || locationInfo.address || locationInfo.locationName;
    const locationLabel =
      widget.strlocation ||
      locationInfo.locationName ||
      locationInfo.propertyType;
    const directionsAddress = [address, locationLabel]
      .map((part) => String(part || "").trim())
      .filter(Boolean)
      .join(", ");

    const detailSlug = (() => {
      try {
        return (
          new URL(normalizedDetailUrl).pathname.split("/").filter(Boolean)[1] ||
          ""
        );
      } catch {
        return "";
      }
    })();

    const available = calendar.days.filter(
      (day) => day.status_code === "A",
    ).length;
    const unavailable = calendar.days.filter(
      (day) => day.status_code === "U",
    ).length;
    const checkinOnly = calendar.days.filter(
      (day) => day.status_code === "I",
    ).length;
    const checkoutOnly = calendar.days.filter(
      (day) => day.status_code === "O",
    ).length;
    const other =
      calendar.days.length -
      available -
      unavailable -
      checkinOnly -
      checkoutOnly;

    return {
      external_listing_id: externalListingId,
      detail_url: normalizedDetailUrl,
      fetched_at: new Date().toISOString(),
      title,
      h1,
      canonical_url: canonicalUrl,
      meta_description: metaDescription,
      description_expanded: descriptionExpanded,
      amenities: {
        categories: amenitiesCategories,
        all: Array.from(amenitiesAll),
      },
      location: {
        address,
        location_label: locationLabel,
        directions_url: directionsAddress
          ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(directionsAddress)}`
          : "",
        directions_daddr: directionsAddress,
        latitude: parseNumberLike(widget.latitude),
        longitude: parseNumberLike(widget.longitude),
      },
      media_gallery: {
        image_count: mediaUrls.length,
        image_urls: mediaUrls,
      },
      property_profile: {
        unit_id: widget.unitcode || externalListingId,
        property_code: widget.unitcode || externalListingId,
        unit_slug: detailSlug || widget.id,
        unit_type: locationInfo.propertyType,
        city: widget.strlocation || locationInfo.locationName,
        state: "FL",
        zip: "",
        beds:
          parseNumberLike(widget.dblbeds) ??
          parseNumberLike(extractedFromDom.labelValues.bedrooms),
        baths: parseNumberLike(extractedFromDom.labelValues.bathrooms),
        sleeps:
          parseNumberLike(widget.intoccu) ??
          parseNumberLike(extractedFromDom.labelValues.guests),
      },
      normalized_matching_profile: {
        source: "pm_realjoy30a",
        external_listing_id: externalListingId,
        name,
        description,
        match_signals: {
          description_normalized: descriptionNormalized,
          description_sha256: hashSha256(descriptionNormalized),
          title_normalized: titleNormalized,
          title_sha256: hashSha256(titleNormalized),
          listing_composite_key: [
            "pm_realjoy30a",
            externalListingId,
            hashSha256(descriptionNormalized),
            hashSha256(titleNormalized),
          ].join("::"),
        },
      },
      normalized_availability: {
        source: "pm_realjoy30a",
        external_listing_id: externalListingId,
        captured_at: new Date().toISOString(),
        window_start: calendar.days[0]?.date ?? "",
        window_end: calendar.days[calendar.days.length - 1]?.date ?? "",
        code_legend: {
          A: "available",
          U: "unavailable",
          I: "checkin_only",
          O: "checkout_only",
          X: "other",
        },
        day_codes: calendar.dayCodes,
        days: calendar.days,
        counts: {
          available,
          unavailable,
          checkin_only: checkinOnly,
          checkout_only: checkoutOnly,
          other,
          booking_available: calendar.days.filter(
            (day) => day.booking_day_state === "bookable",
          ).length,
          booking_unavailable: calendar.days.filter(
            (day) => day.booking_day_state === "blocked",
          ).length,
          booking_unknown: calendar.days.filter(
            (day) => day.booking_day_state === "unknown",
          ).length,
        },
      },
      availability_raw: {
        expected_listing_count: 140,
        observed_day_cell_count: calendar.observedCount,
        observed_status_classes: calendar.observedStatusClasses,
      },
      html_path: htmlPath,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `realjoy30a fetchDetail failed for ${normalizedDetailUrl}: ${message}`,
    );
    return null;
  } finally {
    await page.close();
  }
}

export function createRealJoy30AAdapter(): ScraperAdapter<RealJoyDetailRecord> {
  return {
    managerKey: "realjoy30a",
    scriptLabel: "realjoy30a",
    defaultAnchorUrl: DEFAULT_ANCHOR_URL,
    detailFetchDelayMs: Math.max(
      0,
      Number(process.env.REALJOY30A_DETAIL_FETCH_DELAY_MS ?? "500") || 500,
    ),
    detailFetchConcurrency: Math.max(
      1,
      Number(process.env.REALJOY30A_FETCH_CONCURRENCY ?? "2") || 2,
    ),
    availabilityHorizonDays: Math.max(
      1,
      Number(process.env.REALJOY30A_AVAILABILITY_HORIZON_DAYS ?? "730") || 730,
    ),
    maxCalendarAdvanceMonths: Math.max(
      1,
      Number(process.env.REALJOY30A_MAX_CALENDAR_ADVANCE_MONTHS ?? "24") || 24,
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
        context.maxCalendarAdvanceMonths,
      );
    },
    async runQuoteCapture(argv, progress) {
      const normalizedArgs = await normalizeAdapterQuoteScopeArgs(
        "realjoy30a",
        argv,
      );
      await runRealjoy30aQuoteCli(normalizedArgs, progress);
    },
    async runSingleQuoteObservation(input) {
      return runRealjoy30aSingleQuoteObservation(input);
    },
  };
}
