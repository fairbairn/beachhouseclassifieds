import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Page } from "playwright";

import type { DetailRecordBase, ScrapedLink, ScraperAdapter } from "../types";

type LuxeDayCode = "A" | "U" | "X";

type LuxeDetailRecord = DetailRecordBase & {
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
    source: "pm_luxe30a";
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
    source: "pm_luxe30a";
    external_listing_id: string;
    captured_at: string;
    has_calendar_widget: boolean;
    window_start: string;
    window_end: string;
    code_legend: {
      A: "available";
      U: "unavailable";
      X: "other";
    };
    day_codes: string;
    days: Array<{
      date: string;
      status_code: LuxeDayCode;
      is_available: boolean;
      is_available_for_checkin: boolean;
      is_available_for_checkout: boolean;
      booking_day_state: "bookable" | "blocked" | "unknown";
      min_nights_required: number | null;
    }>;
    counts: {
      available: number;
      unavailable: number;
      other: number;
      booking_available: number;
      booking_unavailable: number;
      booking_unknown: number;
    };
  };
  availability_raw: {
    calendar_cell_count: number;
    extracted_month_labels: string[];
  };
};

const DEFAULT_ANCHOR_URL =
  "https://luxe30a.guestybookings.com/en/properties?minOccupancy=1&propertyType=HOUSE";
const EXPECTED_LISTING_COUNT = 12;

const OUTPUT_ROOT = resolve(
  process.cwd(),
  "src",
  "lib",
  "data",
  "external-sources",
  "luxe30a",
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

function parseNumberLike(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const match = value.match(/\d+(?:\.\d+)?/);
    if (!match) {
      return null;
    }
    const parsed = Number(match[0]);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function absoluteHttpUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const normalized = new URL(trimmed, "https://luxe30a.guestybookings.com")
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

function normalizeDetailUrl(value: string): string | null {
  try {
    const parsed = new URL(value.trim(), "https://luxe30a.guestybookings.com");
    if (!parsed.hostname.endsWith("luxe30a.guestybookings.com")) {
      return null;
    }

    const path = parsed.pathname.replace(/\/+$/, "");
    const idMatch = path.match(/\/properties\/([a-f0-9]{24})$/i);
    if (!idMatch?.[1]) {
      return null;
    }

    return `${parsed.origin}/en/properties/${idMatch[1]}`;
  } catch {
    return null;
  }
}

function extractPropertyId(detailUrl: string): string {
  const normalized = normalizeDetailUrl(detailUrl);
  if (!normalized) {
    return "unknown";
  }

  const match = normalized.match(/\/([a-f0-9]{24})$/i);
  return match?.[1] ?? "unknown";
}

function extractCityStateFromTitle(title: string): {
  city: string;
  state: string;
} {
  const parts = title
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);

  const city = parts.length >= 2 ? (parts[1] ?? "") : "";
  return {
    city,
    state: city ? "FL" : "",
  };
}

function dedupePreserve(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const cleaned = value.trim();
    if (!cleaned) {
      continue;
    }
    if (seen.has(cleaned)) {
      continue;
    }
    seen.add(cleaned);
    out.push(cleaned);
  }

  return out;
}

async function discoverListings(
  page: Parameters<
    ScraperAdapter<LuxeDetailRecord>["discoverListings"]
  >[0]["page"],
  anchorUrl: string,
  maxScrollSteps: number,
  scrollPauseMs: number,
  reportProgress: (message: string) => void,
): Promise<ScrapedLink[]> {
  const discovered = new Set<string>();
  const sourceByLink = new Map<string, string>();

  const ingestLink = (value: string, source: string): void => {
    const normalized = normalizeDetailUrl(value);
    if (!normalized || discovered.has(normalized)) {
      return;
    }
    discovered.add(normalized);
    sourceByLink.set(normalized, source);
  };

  page.on("response", (response) => {
    void (async () => {
      try {
        const url = response.url();
        const contentType = (
          response.headers()["content-type"] || ""
        ).toLowerCase();
        if (!contentType.includes("json") && !url.includes("properties")) {
          return;
        }

        const payload = await response.text();
        if (!payload || payload.length > 3_000_000) {
          return;
        }

        const linkMatches =
          payload.match(/\/en\/properties\/([a-f0-9]{24})(?:["'&?]|$)/gi) ?? [];
        for (const raw of linkMatches) {
          const id = raw.match(/([a-f0-9]{24})/i)?.[1] ?? "";
          if (!id) {
            continue;
          }
          ingestLink(
            `https://luxe30a.guestybookings.com/en/properties/${id}`,
            anchorUrl,
          );
        }
      } catch {
        // Ignore network payload parse failures.
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
      const anchors = Array.from(document.querySelectorAll("a[href]"));
      for (const anchor of anchors) {
        const href = anchor.getAttribute("href") || "";
        if (!href) {
          continue;
        }

        try {
          const resolved = new URL(href, window.location.origin).toString();
          const idMatch = resolved.match(
            /\/properties\/([a-f0-9]{24})(?:\?|$)/i,
          );
          if (!idMatch?.[1]) {
            continue;
          }
          values.add(`${window.location.origin}/en/properties/${idMatch[1]}`);
        } catch {
          // Ignore malformed href.
        }
      }

      const htmlMatches =
        document.documentElement.outerHTML.match(
          /\/en\/properties\/([a-f0-9]{24})(?:["'&?]|$)/gi,
        ) ?? [];
      for (const match of htmlMatches) {
        const id = match.match(/([a-f0-9]{24})/i)?.[1] ?? "";
        if (id) {
          values.add(`${window.location.origin}/en/properties/${id}`);
        }
      }

      return Array.from(values);
    });

    const before = discovered.size;
    for (const link of links) {
      ingestLink(link, anchorUrl);
    }
    return discovered.size - before;
  };

  await ingestFromDom();
  reportProgress(`initial discovery links=${discovered.size}`);

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

    const added = await ingestFromDom();
    if (added > 0) {
      noGrowthRounds = 0;
    } else {
      noGrowthRounds += 1;
    }

    if ((step + 1) % 3 === 0 || added > 0) {
      reportProgress(
        `scroll step ${step + 1}/${maxScrollSteps}: links=${discovered.size}`,
      );
    }

    if (discovered.size >= EXPECTED_LISTING_COUNT) {
      reportProgress(
        `stopping discovery at step ${step + 1}; reached expected listing count ${EXPECTED_LISTING_COUNT}`,
      );
      break;
    }

    if (noGrowthRounds >= 8) {
      reportProgress(
        `stopping discovery at step ${step + 1}; no growth for ${noGrowthRounds} rounds`,
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

async function expandDetailSections(page: Page): Promise<void> {
  const clickNeedles = [
    "read more",
    "show more",
    "show all amenities",
    "show all",
    "view all",
    "amenities",
  ];

  for (let cycle = 0; cycle < 3; cycle += 1) {
    const clicked = await page.evaluate((needles: string[]) => {
      let count = 0;
      const nodes = Array.from(
        document.querySelectorAll("button, a, [role='button']"),
      );
      for (const node of nodes) {
        const el = node as HTMLElement;
        if (el.offsetParent === null) {
          continue;
        }
        const text =
          `${el.textContent || ""} ${el.getAttribute("aria-label") || ""}`
            .toLowerCase()
            .replace(/\s+/g, " ")
            .trim();
        if (!text) {
          continue;
        }
        if (needles.some((needle) => text.includes(needle))) {
          el.click();
          count += 1;
        }
      }
      return count;
    }, clickNeedles);

    if (!clicked) {
      break;
    }

    await page.waitForTimeout(350);
  }

  await page
    .evaluate(() => {
      const dateButton =
        document.querySelector("#date-picker-range") ||
        Array.from(document.querySelectorAll("button, [role='button']")).find(
          (node) => {
            const text =
              `${node.textContent || ""} ${node.getAttribute("aria-label") || ""}`
                .toLowerCase()
                .replace(/\s+/g, " ")
                .trim();
            return text.includes("start date") && text.includes("end date");
          },
        );

      if (dateButton instanceof HTMLElement) {
        dateButton.click();
      }
    })
    .catch(() => undefined);

  await page.waitForTimeout(400);
}

async function fetchDetail(
  browser: Parameters<
    ScraperAdapter<LuxeDetailRecord>["fetchDetail"]
  >[0]["browser"],
  detailUrl: string,
  availabilityHorizonDays: number,
  maxCalendarAdvanceMonths: number,
): Promise<LuxeDetailRecord | null> {
  const normalizedDetailUrl = normalizeDetailUrl(detailUrl);
  if (!normalizedDetailUrl) {
    return null;
  }

  const page = await browser.newPage();
  const externalListingId = extractPropertyId(normalizedDetailUrl);
  let listingApiData: Record<string, unknown> | null = null;
  const calendarApiDataByDate = new Map<string, Record<string, unknown>>();

  page.on("response", (response) => {
    void (async () => {
      try {
        if (!response.ok()) {
          return;
        }

        const responseUrl = response.url();
        const listingBasePath = `/listings/${externalListingId}`;
        if (!responseUrl.includes(listingBasePath)) {
          return;
        }

        const contentType = (
          response.headers()["content-type"] || ""
        ).toLowerCase();
        if (!contentType.includes("json")) {
          return;
        }

        const payload = await response.json();

        if (responseUrl.includes(`${listingBasePath}/calendar`)) {
          if (Array.isArray(payload)) {
            for (const entry of payload) {
              if (typeof entry !== "object" || entry === null) {
                continue;
              }
              const date =
                typeof (entry as Record<string, unknown>).date === "string"
                  ? (entry as Record<string, unknown>).date
                  : "";
              if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
                continue;
              }
              calendarApiDataByDate.set(date, entry as Record<string, unknown>);
            }
          }
          return;
        }

        const isCanonicalListingEndpoint =
          responseUrl.includes(`${listingBasePath}?`) ||
          responseUrl.endsWith(listingBasePath);

        if (
          isCanonicalListingEndpoint &&
          typeof payload === "object" &&
          payload !== null
        ) {
          const parsedPayload = payload as Record<string, unknown>;
          if (
            listingApiData === null ||
            parsedPayload.accommodates !== undefined
          ) {
            listingApiData = parsedPayload;
          }
        }
      } catch {
        // Ignore response parsing errors.
      }
    })();
  });

  try {
    await page.goto(normalizedDetailUrl, {
      waitUntil: "domcontentloaded",
      timeout: 120000,
    });
    await page.waitForTimeout(1400);

    await expandDetailSections(page);

    for (
      let monthStep = 0;
      monthStep < maxCalendarAdvanceMonths;
      monthStep += 1
    ) {
      const advanced = await page.evaluate(() => {
        const controls = Array.from(
          document.querySelectorAll(
            "button[aria-label], [role='button'][aria-label]",
          ),
        );

        const nextControl = controls.find((node) => {
          const label = (node.getAttribute("aria-label") || "")
            .toLowerCase()
            .replace(/\s+/g, " ")
            .trim();
          if (!label) {
            return false;
          }
          if (/(previous|prev) month/.test(label)) {
            return false;
          }
          return /(next month|next|forward|go to next month)/.test(label);
        });

        if (!(nextControl instanceof HTMLElement)) {
          return false;
        }

        const disabled =
          nextControl.hasAttribute("disabled") ||
          (nextControl.getAttribute("aria-disabled") || "").toLowerCase() ===
            "true";

        if (disabled) {
          return false;
        }

        nextControl.click();
        return true;
      });

      if (!advanced) {
        break;
      }

      await page.waitForTimeout(250);
    }

    await page.waitForTimeout(800);

    const extracted = await page.evaluate((horizonDays: number) => {
      const title = document.title || "";
      const h1 = (document.querySelector("h1")?.textContent || "")
        .replace(/\s+/g, " ")
        .trim();
      const canonical =
        document
          .querySelector("link[rel='canonical']")
          ?.getAttribute("href")
          ?.trim() || "";

      const metaDescription =
        document
          .querySelector("meta[name='description']")
          ?.getAttribute("content")
          ?.trim() ||
        document
          .querySelector("meta[property='og:description']")
          ?.getAttribute("content")
          ?.trim() ||
        "";

      const descriptionParts: string[] = [];
      const descriptionSelectors = [
        "[class*='description'] p",
        "[class*='desciption'] p",
        "[class*='descriptionText'] p",
        "[class*='desciptionSection'] p",
      ];

      for (const selector of descriptionSelectors) {
        const nodes = Array.from(document.querySelectorAll(selector));
        for (const node of nodes) {
          const text = (node.textContent || "").replace(/\s+/g, " ").trim();
          if (text.length >= 30) {
            descriptionParts.push(text);
          }
        }
      }

      if (descriptionParts.length === 0) {
        const heading = Array.from(
          document.querySelectorAll("h2, h3, h4"),
        ).find((node) => /description/i.test(node.textContent || ""));

        if (heading?.parentElement) {
          const siblings: Element[] = [];
          let current: Element | null = heading.parentElement;
          for (let i = 0; i < 5 && current; i += 1) {
            siblings.push(current);
            current = current.nextElementSibling;
          }
          for (const node of siblings) {
            const text = (node.textContent || "").replace(/\s+/g, " ").trim();
            if (text.length >= 30) {
              descriptionParts.push(text);
            }
          }
        }
      }

      const descriptionExpanded = Array.from(new Set(descriptionParts)).join(
        "\n\n",
      );

      const amenityValues: string[] = [];
      const amenityHeading = Array.from(
        document.querySelectorAll("h2, h3, h4"),
      ).find((node) => /amenities/i.test(node.textContent || ""));
      const amenityRoot = amenityHeading?.parentElement ?? document.body;
      const amenityNodes = Array.from(
        amenityRoot.querySelectorAll("li, p, span, div"),
      );

      for (const node of amenityNodes) {
        const value = (node.textContent || "").replace(/\s+/g, " ").trim();
        if (!value || value.length < 2 || value.length > 80) {
          continue;
        }
        if (!/[a-z]/i.test(value)) {
          continue;
        }
        if (
          /^(amenities|show all|show more|usd|book now|start date|end date)$/i.test(
            value,
          )
        ) {
          continue;
        }
        if (/^(bedrooms?|bathrooms?|guests?|reviews?)$/i.test(value)) {
          continue;
        }
        if (/^\d+(\.\d+)?$/.test(value)) {
          continue;
        }
        amenityValues.push(value);
      }

      const amenityAll = Array.from(new Set(amenityValues));

      const imageUrls = new Set<string>();
      for (const node of Array.from(
        document.querySelectorAll(
          "meta[property='og:image'], meta[name='twitter:image']",
        ),
      )) {
        const raw = (node.getAttribute("content") || "").trim();
        if (!raw) {
          continue;
        }
        try {
          const url = new URL(raw, window.location.origin).toString();
          if (!/^https?:\/\//i.test(url)) {
            continue;
          }
          if (!/assets\.guesty\.com/i.test(url)) {
            continue;
          }
          imageUrls.add(url);
        } catch {
          // Ignore malformed URL.
        }
      }

      for (const node of Array.from(
        document.querySelectorAll("img[src], img[data-src], img[srcset]"),
      )) {
        const direct = [
          node.getAttribute("src"),
          node.getAttribute("data-src"),
        ];
        for (const maybeUrl of direct) {
          const raw = (maybeUrl || "").trim();
          if (!raw) {
            continue;
          }
          try {
            const url = new URL(raw, window.location.origin).toString();
            if (/^https?:\/\//i.test(url) && /assets\.guesty\.com/i.test(url)) {
              imageUrls.add(url);
            }
          } catch {
            // Ignore malformed URL.
          }
        }

        const srcSet = node.getAttribute("srcset") || "";
        for (const part of srcSet.split(",")) {
          const first = part.trim().split(/\s+/)[0] || "";
          if (!first) {
            continue;
          }
          try {
            const url = new URL(first, window.location.origin).toString();
            if (/^https?:\/\//i.test(url) && /assets\.guesty\.com/i.test(url)) {
              imageUrls.add(url);
            }
          } catch {
            // Ignore malformed URL.
          }
        }
      }

      const pageText = (document.body?.innerText || "")
        .replace(/\s+/g, " ")
        .trim();

      const beds =
        Number(
          (pageText.match(/(\d+(?:\.\d+)?)\s+bedrooms?/i)?.[1] || "").trim(),
        ) || null;
      const baths =
        Number(
          (pageText.match(/(\d+(?:\.\d+)?)\s+bathrooms?/i)?.[1] || "").trim(),
        ) || null;
      const sleeps =
        Number(
          (
            pageText.match(/(?:sleeps\s+|up to\s+)(\d+(?:\.\d+)?)/i)?.[1] || ""
          ).trim(),
        ) ||
        Number(
          (pageText.match(/(\d+(?:\.\d+)?)\s+guests?/i)?.[1] || "").trim(),
        ) ||
        null;

      const latMatch = document.documentElement.outerHTML.match(
        /"lat(?:itude)?"\s*[:=]\s*(-?\d+\.\d+)/i,
      );
      const lngMatch = document.documentElement.outerHTML.match(
        /"lng(?:itude)?"\s*[:=]\s*(-?\d+\.\d+)/i,
      );
      const latitude = latMatch?.[1] ? Number(latMatch[1]) : null;
      const longitude = lngMatch?.[1] ? Number(lngMatch[1]) : null;

      const monthLabels = Array.from(
        document.querySelectorAll(
          "[class*='month'], [aria-live='polite'] [class*='caption']",
        ),
      )
        .map((node) => (node.textContent || "").replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .slice(0, 24);

      const now = new Date();
      const cutoff = new Date(now);
      cutoff.setUTCDate(cutoff.getUTCDate() + Math.max(1, horizonDays));

      const dayRows: Array<{
        date: string;
        status_code: LuxeDayCode;
        is_available: boolean;
        is_available_for_checkin: boolean;
        is_available_for_checkout: boolean;
        booking_day_state: "bookable" | "blocked" | "unknown";
        min_nights_required: number | null;
      }> = [];

      const dateButtons = Array.from(
        document.querySelectorAll(
          "[role='dialog'] button[aria-label], [data-state='open'] button[aria-label], [role='grid'] button[aria-label]",
        ),
      );

      for (const button of dateButtons) {
        const label = (button.getAttribute("aria-label") || "")
          .replace(/\s+/g, " ")
          .trim();
        if (!label) {
          continue;
        }

        const attrDateRaw =
          (
            button.getAttribute("data-date") ||
            button.getAttribute("value") ||
            ""
          )
            .trim()
            .match(/^\d{4}-\d{2}-\d{2}$/)?.[0] || "";

        const parsedDate = attrDateRaw
          ? new Date(attrDateRaw)
          : new Date(label);
        if (Number.isNaN(parsedDate.getTime())) {
          continue;
        }

        if (parsedDate < now || parsedDate > cutoff) {
          continue;
        }

        const isoDate = parsedDate.toISOString().slice(0, 10);
        const disabled =
          button.hasAttribute("disabled") ||
          (button.getAttribute("aria-disabled") || "").toLowerCase() === "true";

        const statusCode: LuxeDayCode = disabled ? "U" : "A";
        dayRows.push({
          date: isoDate,
          status_code: statusCode,
          is_available: statusCode === "A",
          is_available_for_checkin: statusCode === "A",
          is_available_for_checkout: statusCode === "A",
          booking_day_state: statusCode === "A" ? "bookable" : "blocked",
          min_nights_required: null,
        });
      }

      dayRows.sort((a, b) => a.date.localeCompare(b.date));

      return {
        title,
        h1,
        canonical,
        metaDescription,
        descriptionExpanded,
        amenityAll,
        locationLabelFromTitle: (title.split("|")[1] || "").trim(),
        imageUrls: Array.from(imageUrls),
        beds: Number.isFinite(beds || NaN) ? beds : null,
        baths: Number.isFinite(baths || NaN) ? baths : null,
        sleeps: Number.isFinite(sleeps || NaN) ? sleeps : null,
        latitude: Number.isFinite(latitude || NaN) ? latitude : null,
        longitude: Number.isFinite(longitude || NaN) ? longitude : null,
        hasCalendarWidget: !!document.querySelector(
          "#date-picker-range, [role='dialog'] [role='grid'], [class*='calendar']",
        ),
        availabilityDays: dayRows,
        monthLabels,
      };
    }, availabilityHorizonDays);

    const html = await page.content();
    const htmlPath = resolve(
      OUTPUT_DETAILS_HTML_DIR,
      `${externalListingId}.html`,
    );
    await writeFile(htmlPath, `${html}\n`, "utf8");

    const listingFromApi = listingApiData;
    const calendarFromApi = Array.from(calendarApiDataByDate.values())
      .sort((left, right) => {
        const leftDate =
          typeof left.date === "string" ? left.date : "9999-99-99";
        const rightDate =
          typeof right.date === "string" ? right.date : "9999-99-99";
        return leftDate.localeCompare(rightDate);
      })
      .slice(0, Math.max(availabilityHorizonDays + 7, 30));

    const titleFromApi =
      listingFromApi && typeof listingFromApi.title === "string"
        ? listingFromApi.title
        : "";
    const descriptionFromApi =
      listingFromApi && typeof listingFromApi.publicDescription === "string"
        ? listingFromApi.publicDescription
        : "";

    const title = stripHtml(titleFromApi || extracted.title).slice(0, 240);
    const h1 = stripHtml(extracted.h1).slice(0, 240) || title;
    const canonicalUrl = extracted.canonical || normalizedDetailUrl;
    const metaDescription = stripHtml(extracted.metaDescription).slice(0, 2000);
    const descriptionExpanded = stripHtml(
      descriptionFromApi || extracted.descriptionExpanded,
    ).slice(0, 20000);

    const description = descriptionExpanded || metaDescription;
    const name = h1 || title;
    const descriptionNormalized = normalizeForMatch(description);
    const titleNormalized = normalizeForMatch(name);

    const imageUrls = dedupePreserve(
      extracted.imageUrls
        .map((value: string) => absoluteHttpUrl(value))
        .filter((value: string | null): value is string => Boolean(value)),
    );

    const amenitiesFromApi =
      listingFromApi && Array.isArray(listingFromApi.amenities)
        ? listingFromApi.amenities
            .map((value) => (typeof value === "string" ? value : ""))
            .filter(Boolean)
        : [];

    const amenitiesAll = dedupePreserve(
      [...amenitiesFromApi, ...extracted.amenityAll]
        .map((value: string) => stripHtml(value))
        .filter((value: string) => value.length > 1),
    );

    const amenitiesCategories: Record<string, string[]> = {
      "Property Amenities": amenitiesAll,
    };

    const addressFromApi =
      listingFromApi &&
      typeof listingFromApi.address === "object" &&
      listingFromApi.address !== null
        ? (listingFromApi.address as Record<string, unknown>)
        : null;

    const cityFromApi =
      addressFromApi && typeof addressFromApi.city === "string"
        ? addressFromApi.city
        : "";
    const stateFromApi =
      addressFromApi && typeof addressFromApi.state === "string"
        ? addressFromApi.state
        : "";
    const streetFromApi =
      addressFromApi && typeof addressFromApi.street === "string"
        ? addressFromApi.street
        : "";
    const zipcodeFromApi =
      addressFromApi && typeof addressFromApi.zipcode === "string"
        ? addressFromApi.zipcode
        : "";
    const countryFromApi =
      addressFromApi && typeof addressFromApi.country === "string"
        ? addressFromApi.country
        : "";

    const inferred = extractCityStateFromTitle(title || h1);
    const city = cityFromApi || inferred.city;
    const state = stateFromApi || inferred.state;
    const locationLabel =
      extracted.locationLabelFromTitle ||
      [city, state].filter(Boolean).join(", ");
    const addressText = [
      streetFromApi,
      city,
      state,
      zipcodeFromApi,
      countryFromApi,
    ]
      .map((value) => (value || "").trim())
      .filter(Boolean)
      .join(", ");
    const directionsDaddr = [locationLabel, "Florida"]
      .filter(Boolean)
      .join(", ");
    const directionsUrl = directionsDaddr
      ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(directionsDaddr)}`
      : "";

    const domAvailabilityDays = (
      extracted.availabilityDays as Array<{
        date: string;
        status_code: LuxeDayCode;
        is_available: boolean;
        is_available_for_checkin: boolean;
        is_available_for_checkout: boolean;
        booking_day_state: "bookable" | "blocked" | "unknown";
        min_nights_required: number | null;
      }>
    ).filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day.date));

    const apiAvailabilityDays = Array.isArray(calendarFromApi)
      ? calendarFromApi
          .map((entry) => {
            const date = typeof entry.date === "string" ? entry.date : "";
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
              return null;
            }

            const status =
              typeof entry.status === "string"
                ? entry.status.toLowerCase()
                : "";

            let statusCode: LuxeDayCode = "X";
            if (status === "available") {
              statusCode = "A";
            } else if (status === "unavailable") {
              statusCode = "U";
            }

            const cta =
              typeof entry.cta === "boolean" ? entry.cta : statusCode === "A";
            const ctd =
              typeof entry.ctd === "boolean" ? entry.ctd : statusCode === "A";
            const minNights =
              typeof entry.minNights === "number" &&
              Number.isFinite(entry.minNights)
                ? Math.max(0, Math.floor(entry.minNights))
                : null;

            return {
              date,
              status_code: statusCode,
              is_available: statusCode === "A",
              is_available_for_checkin: cta,
              is_available_for_checkout: ctd,
              booking_day_state:
                statusCode === "A"
                  ? "bookable"
                  : statusCode === "U"
                    ? "blocked"
                    : "unknown",
              min_nights_required: minNights,
            };
          })
          .filter(
            (
              day,
            ): day is {
              date: string;
              status_code: LuxeDayCode;
              is_available: boolean;
              is_available_for_checkin: boolean;
              is_available_for_checkout: boolean;
              booking_day_state: "bookable" | "blocked" | "unknown";
              min_nights_required: number | null;
            } => Boolean(day),
          )
      : [];

    const availabilityDays =
      apiAvailabilityDays.length > 0
        ? apiAvailabilityDays
        : domAvailabilityDays;

    const available = availabilityDays.filter(
      (day) => day.status_code === "A",
    ).length;
    const unavailable = availabilityDays.filter(
      (day) => day.status_code === "U",
    ).length;
    const other = availabilityDays.length - available - unavailable;

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
        address: addressText,
        location_label: locationLabel,
        directions_url: directionsUrl,
        directions_daddr: directionsDaddr,
        latitude: parseNumberLike(
          (addressFromApi?.lat as unknown) ??
            (addressFromApi?.latitude as unknown) ??
            extracted.latitude,
        ),
        longitude: parseNumberLike(
          (addressFromApi?.lng as unknown) ??
            (addressFromApi?.lon as unknown) ??
            (addressFromApi?.longitude as unknown) ??
            extracted.longitude,
        ),
      },
      media_gallery: {
        image_count: imageUrls.length,
        image_urls: imageUrls,
      },
      property_profile: {
        unit_id: externalListingId,
        area: "30A",
        location: locationLabel,
        beds: parseNumberLike(extracted.beds),
        baths: parseNumberLike(extracted.baths),
        sleeps:
          parseNumberLike(
            (listingFromApi?.accommodates as unknown) ?? extracted.sleeps,
          ) ?? parseNumberLike(extracted.sleeps),
        city,
        state,
      },
      normalized_matching_profile: {
        source: "pm_luxe30a",
        external_listing_id: externalListingId,
        name,
        description,
        match_signals: {
          description_normalized: descriptionNormalized,
          description_sha256: hashSha256(descriptionNormalized),
          title_normalized: titleNormalized,
          title_sha256: hashSha256(titleNormalized),
          listing_composite_key: [
            "pm_luxe30a",
            externalListingId,
            hashSha256(descriptionNormalized),
            hashSha256(titleNormalized),
          ].join("::"),
        },
      },
      normalized_availability: {
        source: "pm_luxe30a",
        external_listing_id: externalListingId,
        captured_at: new Date().toISOString(),
        has_calendar_widget:
          Boolean(extracted.hasCalendarWidget) ||
          apiAvailabilityDays.length > 0,
        window_start: availabilityDays[0]?.date ?? "",
        window_end: availabilityDays[availabilityDays.length - 1]?.date ?? "",
        code_legend: {
          A: "available",
          U: "unavailable",
          X: "other",
        },
        day_codes: availabilityDays.map((day) => day.status_code).join(""),
        days: availabilityDays,
        counts: {
          available,
          unavailable,
          other,
          booking_available: availabilityDays.filter(
            (day) => day.booking_day_state === "bookable",
          ).length,
          booking_unavailable: availabilityDays.filter(
            (day) => day.booking_day_state === "blocked",
          ).length,
          booking_unknown: availabilityDays.filter(
            (day) => day.booking_day_state === "unknown",
          ).length,
        },
      },
      availability_raw: {
        calendar_cell_count: availabilityDays.length,
        extracted_month_labels: dedupePreserve(
          extracted.monthLabels as string[],
        ),
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `luxe30a fetchDetail failed for ${normalizedDetailUrl}: ${message}`,
    );
    return null;
  } finally {
    await page.close();
  }
}

export function createLuxe30AAdapter(): ScraperAdapter<LuxeDetailRecord> {
  return {
    managerKey: "luxe30a",
    scriptLabel: "luxe30a",
    defaultAnchorUrl: DEFAULT_ANCHOR_URL,
    detailFetchDelayMs: Math.max(
      0,
      Number(process.env.LUXE30A_DETAIL_FETCH_DELAY_MS ?? "500") || 500,
    ),
    detailFetchConcurrency: Math.max(
      1,
      Number(process.env.LUXE30A_FETCH_CONCURRENCY ?? "2") || 2,
    ),
    availabilityHorizonDays: Math.max(
      1,
      Number(process.env.LUXE30A_AVAILABILITY_HORIZON_DAYS ?? "730") || 730,
    ),
    maxCalendarAdvanceMonths: Math.max(
      1,
      Number(process.env.LUXE30A_MAX_CALENDAR_ADVANCE_MONTHS ?? "24") || 24,
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
  };
}
