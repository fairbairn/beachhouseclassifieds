import { executeStayon30aSingleQuote } from "@/lib/pricing/quote-runtime/adapters/stayon30a";
import { runRuntimeAdapterQuoteCli } from "@/lib/pricing/quotes/shared/runtime-adapter-quote-runner";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { normalizeAdapterQuoteScopeArgs } from "../quote-scope";
import type { DetailRecordBase, ScrapedLink, ScraperAdapter } from "../types";

type StayOnStatusCode = "A" | "U" | "I" | "O" | "X";
type CanonicalDayCode = "Y" | "N";
type CanonicalChangeoverCode = "C" | "I" | "O" | "X";

function toDayCodeFromStatus(status: StayOnStatusCode): CanonicalDayCode {
  return status === "A" || status === "O" ? "Y" : "N";
}

function toChangeoverCodeFromStatus(
  status: StayOnStatusCode,
): CanonicalChangeoverCode {
  if (status === "I") {
    return "I";
  }
  if (status === "O") {
    return "O";
  }
  return status === "A" ? "C" : "X";
}

type StayDetailRecord = DetailRecordBase & {
  quote_context: {
    listing_id: string;
    unit_id: string;
    detail_url: string;
    property_id?: string;
  };
  title: string;
  h1: string;
  canonical_url: string;
  meta_description: string;
  description_expanded: string;
  rooms_guidance: string[];
  amenities: {
    categories: Record<string, string[]>;
    all: string[];
  };
  location: {
    address: string;
    city: string;
    state: string;
    postal_code: string;
    country: string;
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
    beds: number | null;
    baths: number | null;
    sleeps: number | null;
    city: string;
    state: string;
    zip: string;
  };
  normalized_matching_profile: {
    source: "pm_stayon30a";
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
    source: "pm_stayon30a";
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
      day_code: CanonicalDayCode;
      changeover_code: CanonicalChangeoverCode;
      is_available: boolean;
      status_code: StayOnStatusCode;
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
    begin_date: string;
    end_date: string;
    day_codes: string;
  };
  pricing_api_hints: {
    provider: "homelocal-wp-json-quotes";
    endpoint_path: "/wp-json/homelocal/v1/quotes";
    method_names: {
      quotes: "POST /wp-json/homelocal/v1/quotes";
    };
    notes: string;
  };
};

const DEFAULT_ANCHOR_URL = "https://stayon30a.com/stays/";
const OUTPUT_ROOT = resolve(
  process.cwd(),
  "src",
  "lib",
  "data",
  "external-sources",
  "stayon30a",
);
const OUTPUT_DETAILS_HTML_DIR = resolve(OUTPUT_ROOT, "details", "html");

const MAX_CLICK_CYCLES = 24;
const CLICK_WAIT_MS = 1200;
const GROWTH_POLL_ROUNDS = 10;

function normalizeLink(url: string): string {
  return url.split("#")[0]?.replace(/\/$/, "") ?? url;
}

function extractFirst(regex: RegExp, value: string): string {
  const match = value.match(regex);
  if (!match?.[1]) {
    return "";
  }
  return stripHtml(match[1]).trim();
}

function stripHtml(value: string): string {
  return value
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_match, codePointText: string) => {
      const codePoint = Number(codePointText);
      if (!Number.isFinite(codePoint)) {
        return _match;
      }
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return _match;
      }
    })
    .replace(/&#x([0-9a-f]+);/gi, (_match, hexText: string) => {
      const codePoint = Number.parseInt(hexText, 16);
      if (!Number.isFinite(codePoint)) {
        return _match;
      }
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return _match;
      }
    })
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/gi, "'")
    .replace(/&#8211;/gi, "-")
    .replace(/&#8212;/gi, "-")
    .replace(/&#8216;|&#8217;/gi, "'")
    .replace(/&#8220;|&#8221;/gi, '"');
}

function stripHtmlPreserveLineBreaks(value: string): string {
  return decodeHtmlEntities(
    value
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<\/div>/gi, "\n")
      .replace(/<\/li>/gi, "\n")
      .replace(/<\/h[1-6]>/gi, "\n")
      .replace(/<li[^>]*>/gi, "- ")
      .replace(/<[^>]*>/g, "")
      .replace(/\r/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  );
}

function cleanAboutSpaceDescriptionText(value: string): string {
  return value
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^(?:close\s*)+/i, "")
    .replace(/^(?:about\s*this\s*space\s*)+/i, "")
    .trim();
}

function extractAboutSpacePopupDescription(html: string): string {
  const aboutDialogSlice = extractFirst(
    /<h[1-6][^>]*>\s*About\s*this\s*space\s*<\/h[1-6]>[\s\S]*?<div[^>]*style\s*=\s*["'][^"']*white-space\s*:\s*pre-wrap[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    html,
  );
  const preWrapText = aboutDialogSlice;
  if (preWrapText) {
    return cleanAboutSpaceDescriptionText(
      stripHtmlPreserveLineBreaks(preWrapText),
    ).slice(0, 20000);
  }

  const aboutPopupSlice = extractFirst(
    /<h[1-6][^>]*>\s*About\s*this\s*space\s*<\/h[1-6]>[\s\S]*?<div[^>]*class\s*=\s*["'][^"']*(?:popup|modal|dialog)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    html,
  );
  if (aboutPopupSlice) {
    const popupText = cleanAboutSpaceDescriptionText(
      stripHtmlPreserveLineBreaks(aboutPopupSlice),
    );
    if (popupText.length >= 120) {
      return popupText.slice(0, 20000);
    }
  }

  const aboutSection = extractFirst(
    /About\s*this\s*space([\s\S]*?)Other\s+things\s+to\s+note/i,
    html,
  );
  if (aboutSection) {
    return cleanAboutSpaceDescriptionText(
      stripHtmlPreserveLineBreaks(aboutSection),
    ).slice(0, 20000);
  }

  return "";
}

async function activateDetailPopups(
  page: Awaited<
    ReturnType<{ newPage: () => Promise<DiscoverContext["page"]> }["newPage"]>
  >,
): Promise<string> {
  const extractVisibleAboutSpaceDialogText = async (): Promise<string> =>
    page.evaluate(() => {
      const headings = Array.from(
        document.querySelectorAll<HTMLElement>(
          "h1, h2, h3, .elementor-heading-title",
        ),
      ).filter((heading) => {
        const normalized = (heading.textContent ?? "")
          .replace(/[\u200B-\u200D\uFEFF]/g, "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
        return normalized === "about this space";
      });

      for (const heading of headings) {
        const headingStyle = window.getComputedStyle(heading);
        const headingRect = heading.getBoundingClientRect();
        const headingVisible =
          headingStyle.display !== "none" &&
          headingStyle.visibility !== "hidden" &&
          Number(headingStyle.opacity || "1") > 0 &&
          headingRect.width > 0 &&
          headingRect.height > 0;
        if (!headingVisible) {
          continue;
        }

        let container =
          heading.closest<HTMLElement>(
            "[role='dialog'], .dialog-widget-content, .elementor-popup-modal, .elementor-location-popup",
          ) ?? heading.parentElement;
        while (
          container &&
          (container.textContent ?? "").length < 220 &&
          container.parentElement
        ) {
          container = container.parentElement;
        }
        if (!container) {
          continue;
        }

        const containerStyle = window.getComputedStyle(container);
        const containerRect = container.getBoundingClientRect();
        const containerVisible =
          containerStyle.display !== "none" &&
          containerStyle.visibility !== "hidden" &&
          Number(containerStyle.opacity || "1") > 0 &&
          containerRect.width > 0 &&
          containerRect.height > 0;
        if (!containerVisible) {
          continue;
        }

        const text = (container.textContent ?? "")
          .replace(/[\u200B-\u200D\uFEFF]/g, "")
          .replace(/\s+/g, " ")
          .replace(/^(?:close\s*)+/i, "")
          .replace(/^(?:about\s*this\s*space\s*)+/i, "")
          .replace(/\bclose\b/gi, " ")
          .trim();

        if (text.length >= 120) {
          return text.slice(0, 20000);
        }
      }

      return "";
    });

  let popupText = await extractVisibleAboutSpaceDialogText();
  if (popupText) {
    return popupText;
  }

  const clickVisibleByText = async (matcher: RegExp): Promise<boolean> =>
    page.evaluate((patternSource) => {
      const pattern = new RegExp(patternSource, "i");
      const candidates = Array.from(
        document.querySelectorAll<HTMLElement>("button, a, [role='button']"),
      );
      const target = candidates.find((element) => {
        const style = window.getComputedStyle(element);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          Number(style.opacity || "1") <= 0
        ) {
          return false;
        }
        const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
        return pattern.test(text);
      });
      if (!target) {
        return false;
      }
      target.click();
      return true;
    }, matcher.source);

  const clickPopupTrigger = async (selector: string): Promise<void> => {
    const clicked = await page.evaluate((selectorText) => {
      const candidates = Array.from(
        document.querySelectorAll<HTMLElement>(selectorText),
      );
      const target = candidates.find((element) => {
        const style = window.getComputedStyle(element);
        const visible =
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(style.opacity || "1") > 0;
        return visible;
      });
      if (!target) {
        return false;
      }
      target.click();
      return true;
    }, selector);

    if (clicked) {
      await page.waitForTimeout(450);
    }
  };

  if (await clickVisibleByText(/about\s*this\s*space/)) {
    await page.waitForTimeout(500);
    popupText = await extractVisibleAboutSpaceDialogText();
    if (popupText) {
      return popupText;
    }
  }

  await clickPopupTrigger(
    ".show-more-popup .elementor-button, .show-more-popup a, .show-more-popup button",
  );
  popupText = await extractVisibleAboutSpaceDialogText();
  if (popupText) {
    return popupText;
  }

  if (await clickVisibleByText(/show\s*more/)) {
    await page.waitForTimeout(500);
    popupText = await extractVisibleAboutSpaceDialogText();
    if (popupText) {
      return popupText;
    }
  }

  return "";
}

type PopupAmenitiesCapture = {
  categories: Record<string, string[]>;
  all: string[];
};

function dedupeAmenityCategories(
  categories: Record<string, string[]>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [category, values] of Object.entries(categories)) {
    const cleanedCategory = category.trim();
    if (!cleanedCategory) {
      continue;
    }
    const deduped = dedupePreserveOrder(
      values.map((value) => value.trim()).filter((value) => value.length > 0),
    );
    if (deduped.length > 0) {
      out[cleanedCategory] = deduped;
    }
  }
  return out;
}

function extractAmenitiesFromPopupHtml(html: string): PopupAmenitiesCapture {
  const headingMatch =
    /<h[1-6][^>]*>\s*What\s*this\s*place\s*offers\s*<\/h[1-6]>/i.exec(html);
  if (!headingMatch || typeof headingMatch.index !== "number") {
    return { categories: {}, all: [] };
  }

  const afterHeading = html.slice(headingMatch.index + headingMatch[0].length);
  const dialogEnd = afterHeading.search(/<\/dialog>/i);
  const region =
    dialogEnd >= 0
      ? afterHeading.slice(0, dialogEnd)
      : afterHeading.slice(0, 300000);

  const headings = Array.from(region.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/gi));
  if (headings.length === 0) {
    return { categories: {}, all: [] };
  }

  const categories: Record<string, string[]> = {};
  const all: string[] = [];

  for (let index = 0; index < headings.length; index += 1) {
    const current = headings[index];
    if (!current || typeof current.index !== "number") {
      continue;
    }

    const category = stripHtml(current[1] ?? "")
      .replace(/\s+/g, " ")
      .trim();
    if (!category) {
      continue;
    }

    const segmentStart = current.index + current[0].length;
    const next = headings[index + 1];
    const segmentEnd =
      next && typeof next.index === "number" ? next.index : region.length;
    const segment = region.slice(segmentStart, segmentEnd);

    const values = Array.from(segment.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi))
      .map((match) =>
        stripHtml(match[1] ?? "")
          .replace(/\s+/g, " ")
          .trim(),
      )
      .filter((value) => value.length > 0);

    if (values.length === 0) {
      continue;
    }

    categories[category] = dedupePreserveOrder(values);
    all.push(...values);
  }

  return {
    categories: dedupeAmenityCategories(categories),
    all: dedupePreserveOrder(all),
  };
}

async function extractAmenitiesFromPopupDialog(
  page: Awaited<
    ReturnType<{ newPage: () => Promise<DiscoverContext["page"]> }["newPage"]>
  >,
): Promise<PopupAmenitiesCapture> {
  return page.evaluate(() => {
    const heading = Array.from(
      document.querySelectorAll<HTMLElement>("h1, h2, h3"),
    ).find((node) => {
      const text = (node.textContent ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
      if (text !== "what this place offers") {
        return false;
      }
      const style = window.getComputedStyle(node);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        Number(style.opacity || "1") <= 0
      ) {
        return false;
      }
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });

    if (!heading) {
      return { categories: {}, all: [] };
    }

    const dialog =
      heading.closest<HTMLElement>(
        "[role='dialog'], .dialog-widget-content, .elementor-popup-modal, .elementor-location-popup",
      ) ?? heading.parentElement;
    if (!dialog) {
      return { categories: {}, all: [] };
    }
    const dialogStyle = window.getComputedStyle(dialog);
    if (
      dialogStyle.display === "none" ||
      dialogStyle.visibility === "hidden" ||
      Number(dialogStyle.opacity || "1") <= 0
    ) {
      return { categories: {}, all: [] };
    }
    const dialogRect = dialog.getBoundingClientRect();
    if (!(dialogRect.width > 0 && dialogRect.height > 0)) {
      return { categories: {}, all: [] };
    }

    const categories: Record<string, string[]> = {};
    const all: string[] = [];

    for (const section of Array.from(
      dialog.querySelectorAll<HTMLElement>("section, div"),
    )) {
      const categoryHeading = section.querySelector<HTMLElement>("h3");
      if (!categoryHeading) {
        continue;
      }
      const category = (categoryHeading.textContent ?? "")
        .replace(/\s+/g, " ")
        .trim();
      if (!category) {
        continue;
      }

      const values = Array.from(section.querySelectorAll<HTMLElement>("li"))
        .map((item) => (item.textContent ?? "").replace(/\s+/g, " ").trim())
        .filter((value) => value.length > 0);
      if (values.length === 0) {
        continue;
      }

      categories[category] = values;
      all.push(...values);
    }

    if (Object.keys(categories).length === 0) {
      const fallback = Array.from(dialog.querySelectorAll<HTMLElement>("li"))
        .map((item) => (item.textContent ?? "").replace(/\s+/g, " ").trim())
        .filter((value) => value.length > 0);
      if (fallback.length > 0) {
        categories["Popup Amenities"] = fallback;
        all.push(...fallback);
      }
    }

    return { categories, all };
  });
}

async function captureModalPopupContent(
  page: Awaited<
    ReturnType<{ newPage: () => Promise<DiscoverContext["page"]> }["newPage"]>
  >,
): Promise<{
  aboutDescription: string;
  popupAmenities: PopupAmenitiesCapture;
  popupAmenitiesHtml: string;
  galleryPopupHtml: string;
  galleryCarouselImageUrls: string[];
}> {
  try {
    await page.setViewportSize({ width: 1440, height: 2200 });
    await page.waitForTimeout(150);
  } catch {
    // Keep default viewport if resize is unsupported.
  }

  const clickVisibleButtonByExactText = async (
    textPattern: RegExp,
  ): Promise<boolean> =>
    page.evaluate(
      String.raw`(() => {
        const pattern = new RegExp(` +
        JSON.stringify(textPattern.source) +
        String.raw`, 'i');
        const isVisible = (node) => {
          if (!(node instanceof HTMLElement)) return false;
          const style = window.getComputedStyle(node);
          if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') <= 0) {
            return false;
          }
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };

        const nodes = Array.from(document.querySelectorAll("button, a, [role='button']"));
        const target = nodes.find((node) => {
          if (!isVisible(node)) return false;
          const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
          return pattern.test(text);
        });
        if (target) {
          target.click();
          return true;
        }

        const fallbackNode = Array.from(document.querySelectorAll('*')).find((node) => {
          if (!isVisible(node)) return false;
          const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
          if (!pattern.test(text)) return false;
          const interactive = node.closest("button, a, [role='button']");
          return Boolean(interactive && isVisible(interactive));
        });

        const interactive = fallbackNode ? fallbackNode.closest("button, a, [role='button']") : null;
        if (!interactive || !isVisible(interactive)) {
          return false;
        }
        interactive.click();
        return true;
      })()`,
    );

  const closeActiveDialog = async (): Promise<void> => {
    await page.evaluate(() => {
      const closeButton = Array.from(
        document.querySelectorAll<HTMLElement>("button, [role='button']"),
      ).find((node) => {
        const ariaLabel = (node.getAttribute("aria-label") ?? "").toLowerCase();
        if (!ariaLabel.includes("close")) {
          return false;
        }
        const style = window.getComputedStyle(node);
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(style.opacity || "1") > 0
        );
      });
      closeButton?.click();
    });
    await page.waitForTimeout(250);
  };

  let aboutDescription = await activateDetailPopups(page);
  let popupAmenities: PopupAmenitiesCapture = { categories: {}, all: [] };
  let popupAmenitiesHtml = "";
  let galleryPopupHtml = "";
  let galleryCarouselImageUrls: string[] = [];

  const collectGalleryPopupImageUrls = async (): Promise<string[]> =>
    page.evaluate(String.raw`(() => {
      const isVisible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') <= 0) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const normalizeTo1920 = (value) => {
        if (!value) return '';
        try {
          const parsed = new URL(value, window.location.href);
          if (!parsed.hostname.toLowerCase().endsWith('assets.guesty.com')) return '';
          parsed.pathname = parsed.pathname
            .replace(/\/{2,}/g, '/')
            .replace(/(\/image\/upload\/)([^/]+)\//i, '$1w_1920,q_auto,f_auto/');
          parsed.search = '';
          parsed.hash = '';
          return parsed.toString();
        } catch {
          return '';
        }
      };

      const extractGuestyUrls = (value) => {
        if (!value) return [];
        const decoded = String(value)
          .replace(/\\u002F/gi, '/')
          .replace(/\\\//g, '/')
          .trim();
        return decoded.match(/https?:\/\/assets\.guesty\.com\/[^\s"'<>]+/gi) || [];
      };

      const dialogs = Array.from(document.querySelectorAll("[role='dialog'], dialog"))
        .filter((dialog) => isVisible(dialog));

      const dialogByImageDensity = dialogs
        .map((dialog) => {
          const imgs = Array.from(dialog.querySelectorAll('img'));
          let score = 0;
          for (const img of imgs) {
            const candidates = [
              img.currentSrc || '',
              img.getAttribute('src') || '',
              img.getAttribute('data-src') || '',
              img.getAttribute('srcset') || '',
              img.getAttribute('data-srcset') || '',
            ];
            for (const candidate of candidates) {
              if (candidate && candidate.includes('assets.guesty.com')) {
                score += 1;
              }
            }
          }
          return { dialog, score };
        })
        .sort((a, b) => b.score - a.score);

      const targetDialog = dialogByImageDensity[0]?.dialog || null;
      if (!targetDialog) return [];

      const byAsset = new Map();
      for (const img of Array.from(targetDialog.querySelectorAll('img'))) {
        const candidates = [
          img.currentSrc || '',
          img.getAttribute('src') || '',
          img.getAttribute('data-src') || '',
          img.getAttribute('srcset') || '',
          img.getAttribute('data-srcset') || '',
        ];

        for (const candidate of candidates) {
          for (const rawUrl of extractGuestyUrls(candidate)) {
            const normalized = normalizeTo1920(rawUrl);
            if (!normalized) continue;

            let key = normalized;
            let width = Number(normalized.match(/\/w_(\d{2,5})\b/i)?.[1] || 0);
            if (!Number.isFinite(width)) width = 0;

            try {
              const parsed = new URL(normalized);
              const last = parsed.pathname.split('/').filter(Boolean).at(-1) || '';
              if (last) key = last.toLowerCase();
            } catch {
              // Keep URL key fallback.
            }

            const existing = byAsset.get(key);
            if (!existing || width > existing.width) {
              byAsset.set(key, { url: normalized, width });
            }
          }
        }
      }

      return Array.from(byAsset.values()).map((entry) => entry.url);
    })()`);

  const collectCarouselPrimaryImageUrls = async (): Promise<string[]> => {
    const openFirstThumb = await page.evaluate(String.raw`(() => {
      const isVisible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') <= 0) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const dialogs = Array.from(document.querySelectorAll("[role='dialog'], dialog"))
        .filter((dialog) => isVisible(dialog))
        .sort((a, b) => {
          const aRect = a.getBoundingClientRect();
          const bRect = b.getBoundingClientRect();
          return bRect.width * bRect.height - aRect.width * aRect.height;
        });

      const isLikelyThumb = (node) => {
        if (!(node instanceof HTMLElement) || !isVisible(node)) return false;
        const label = ((node.getAttribute('aria-label') || '') + ' ' + (node.textContent || ''))
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase();
        if (!label) return false;
        if (label.includes('close') || label.includes('back') || label.includes('next') || label.includes('previous')) {
          return false;
        }
        if (label.includes('photo') && /\b\d+\b/.test(label)) return true;
        return false;
      };

      for (const dialog of dialogs) {
        const nodes = Array.from(dialog.querySelectorAll("button, [role='button'], a"));
        const thumbByLabel = nodes.find((node) => isLikelyThumb(node));
        if (thumbByLabel) {
          thumbByLabel.click();
          return true;
        }

        const thumbWithImage = nodes.find((node) => {
          if (!(node instanceof HTMLElement) || !isVisible(node)) return false;
          const label = ((node.getAttribute('aria-label') || '') + ' ' + (node.textContent || ''))
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
          if (label.includes('close') || label.includes('back') || label.includes('next') || label.includes('previous')) {
            return false;
          }
          const img = node.querySelector('img');
          return img !== null;
        });
        if (thumbWithImage) {
          thumbWithImage.click();
          return true;
        }
      }

      return false;
    })()`);

    if (!openFirstThumb) {
      return [];
    }

    await page.waitForTimeout(250);

    const byAsset = new Map<string, { url: string; width: number }>();
    const seenMarkers = new Set<string>();
    let lastMarker = "";
    let stagnantMarkerCount = 0;
    const maxSteps = 220;

    for (let step = 0; step < maxSteps; step += 1) {
      const state = await page.evaluate(String.raw`(() => {
        const isVisible = (el) => {
          if (!(el instanceof HTMLElement)) return false;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') <= 0) return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        const toGuesty = (value) => {
          if (!value) return '';
          const decoded = String(value)
            .replace(/\\u002F/gi, '/')
            .replace(/\\\//g, '/')
            .replace(/&quot;.*$/i, '')
            .replace(/&#34;.*$/i, '')
            .replace(/&#39;.*$/i, '')
            .trim();
          const m = decoded.match(/https?:\/\/assets\.guesty\.com\/[^\s"'<>]+/i);
          if (!m || !m[0]) return '';
          try {
            const parsed = new URL(m[0], window.location.href);
            if (!parsed.hostname.toLowerCase().endsWith('assets.guesty.com')) return '';
            parsed.pathname = parsed.pathname.replace(/\/{2,}/g, '/');
            parsed.search = '';
            parsed.hash = '';
            return parsed.toString();
          } catch {
            return '';
          }
        };

        const dialogs = Array.from(document.querySelectorAll("[role='dialog'], dialog"))
          .filter((candidate) => isVisible(candidate));
        const withScores = dialogs.map((dialog) => {
          const aria = (dialog.getAttribute('aria-label') || '');
          const text = (dialog.textContent || '');
          const scope = (aria + ' ' + text).replace(/\s+/g, ' ').trim();
          const ofMatch = scope.match(/photo\s*(\d+)\s*of\s*(\d+)/i);
          const slashMatch = scope.match(/\b(\d+)\s*\/\s*(\d+)\b/);
          const total = ofMatch ? Number(ofMatch[2]) : slashMatch ? Number(slashMatch[2]) : 0;
          const score = (ofMatch ? 5000 : 0) + (total > 0 ? total : 0);
          return { dialog, scope, ofMatch, slashMatch, score };
        });
        withScores.sort((a, b) => b.score - a.score);
        const best = withScores.find((item) => item.score > 0) || null;
        const dialog = best?.dialog || null;
        if (!dialog) {
          return { found: false, marker: '', total: 0, activeUrl: '', width: 0, canNext: false };
        }

        const scopeText = (best?.scope || ((dialog.getAttribute('aria-label') || '') + ' ' + (dialog.textContent || ''))).replace(/\s+/g, ' ').trim();
        const ofMatch = best?.ofMatch || scopeText.match(/photo\s*(\d+)\s*of\s*(\d+)/i);
        const slashMatch = best?.slashMatch || scopeText.match(/\b(\d+)\s*\/\s*(\d+)\b/);
        const index = ofMatch ? Number(ofMatch[1]) : slashMatch ? Number(slashMatch[1]) : 0;
        const total = ofMatch ? Number(ofMatch[2]) : slashMatch ? Number(slashMatch[2]) : 0;
        const marker = (index > 0 ? String(index) : '?') + '/' + (total > 0 ? String(total) : '?');

        let activeUrl = '';
        let bestArea = 0;
        let bestWidth = 0;
        for (const img of Array.from(dialog.querySelectorAll('img'))) {
          if (!isVisible(img)) continue;
          const rect = img.getBoundingClientRect();
          const area = rect.width * rect.height;
          if (area <= bestArea) continue;
          const url =
            toGuesty(img.currentSrc || '') ||
            toGuesty(img.getAttribute('src') || '') ||
            toGuesty(img.getAttribute('data-src') || '') ||
            toGuesty(img.getAttribute('srcset') || '') ||
            toGuesty(img.getAttribute('data-srcset') || '');
          if (!url) continue;
          activeUrl = url;
          bestArea = area;
          bestWidth = Number(url.match(/\/w_(\d{2,5})\b/i)?.[1] || 0);
        }

        const nextButton = Array.from(dialog.querySelectorAll("button, [role='button']")).find((node) => {
          if (!isVisible(node)) return false;
          const label = ((node.getAttribute('aria-label') || '') + ' ' + (node.textContent || '')).replace(/\s+/g, ' ').trim().toLowerCase();
          return label.includes('next photo') || label === 'next';
        });

        return {
          found: true,
          marker,
          total,
          activeUrl,
          width: bestWidth,
          canNext: Boolean(nextButton),
        };
      })()`);

      if (!state.found) {
        break;
      }

      if (state.marker === lastMarker) {
        stagnantMarkerCount += 1;
      } else {
        stagnantMarkerCount = 0;
      }
      lastMarker = state.marker;

      if (stagnantMarkerCount >= 4) {
        break;
      }

      const key = (() => {
        try {
          const parsed = new URL(state.activeUrl);
          return (
            parsed.pathname.split("/").filter(Boolean).at(-1)?.toLowerCase() ??
            ""
          );
        } catch {
          return "";
        }
      })();
      const dedupeKey = key || state.activeUrl;
      if (dedupeKey && state.activeUrl) {
        const existing = byAsset.get(dedupeKey);
        if (!existing || (state.width ?? 0) > existing.width) {
          byAsset.set(dedupeKey, {
            url: state.activeUrl,
            width: Number(state.width ?? 0),
          });
        }
      }

      if (seenMarkers.has(state.marker)) {
        break;
      }
      seenMarkers.add(state.marker);

      if (state.total > 0 && byAsset.size >= state.total) {
        break;
      }
      if (!state.canNext) {
        break;
      }

      await page.evaluate(String.raw`(() => {
        const isVisible = (el) => {
          if (!(el instanceof HTMLElement)) return false;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') <= 0) return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        const dialogs = Array.from(document.querySelectorAll("[role='dialog'], dialog")).filter((candidate) => isVisible(candidate));
        const dialog = dialogs.find((candidate) => {
          const text = ((candidate.getAttribute('aria-label') || '') + ' ' + (candidate.textContent || '')).toLowerCase();
          return /photo\s*\d+\s*of\s*\d+/i.test(text) || /\b\d+\s*\/\s*\d+\b/.test(text);
        });
        if (!dialog) return;
        const nextButton = Array.from(dialog.querySelectorAll("button, [role='button']")).find((node) => {
          if (!isVisible(node)) return false;
          const label = ((node.getAttribute('aria-label') || '') + ' ' + (node.textContent || '')).replace(/\s+/g, ' ').trim().toLowerCase();
          return label.includes('next photo') || label === 'next';
        });
        nextButton?.click();
      })()`);

      await page.waitForTimeout(280);
    }

    return Array.from(byAsset.values()).map((entry) => entry.url);
  };

  const clickedAbout = await clickVisibleButtonByExactText(/^show\s+more$/i);
  if (clickedAbout) {
    await page.waitForTimeout(600);
    const openedAbout = await activateDetailPopups(page);
    if (openedAbout.length > aboutDescription.length) {
      aboutDescription = openedAbout;
    }
    await closeActiveDialog();
  }

  const clickedAmenities = await clickVisibleButtonByExactText(
    /^show\s+all\s+amenities$/i,
  );
  if (clickedAmenities) {
    await page.waitForTimeout(600);
    popupAmenitiesHtml = await page.content();
    popupAmenities = await extractAmenitiesFromPopupDialog(page);
    await closeActiveDialog();
  }

  const clickedPhotos =
    await clickVisibleButtonByExactText(/^show\s+all\s+photos/i);
  if (clickedPhotos) {
    await page.waitForTimeout(700);
    galleryPopupHtml = await page.content();
    const popupImageUrls = await collectGalleryPopupImageUrls();
    const expectedPopupCount = parseInt(
      extractFirst(/show\s+all\s+photos\s*\((\d+)\)/i, galleryPopupHtml) ||
        extractFirst(/photo\s+\d+\s+of\s+(\d+)/i, galleryPopupHtml) ||
        "",
      10,
    );

    if (
      popupImageUrls.length > 0 &&
      (!Number.isFinite(expectedPopupCount) || expectedPopupCount <= 0)
    ) {
      galleryCarouselImageUrls = popupImageUrls;
    } else if (popupImageUrls.length >= expectedPopupCount) {
      galleryCarouselImageUrls = popupImageUrls;
    } else {
      const carouselImageUrls = await collectCarouselPrimaryImageUrls();
      galleryCarouselImageUrls = dedupePreserveOrder([
        ...popupImageUrls,
        ...carouselImageUrls,
      ]);
    }
    await closeActiveDialog();
  }

  return {
    aboutDescription,
    popupAmenities: {
      categories: dedupeAmenityCategories(popupAmenities.categories),
      all: dedupePreserveOrder(popupAmenities.all),
    },
    popupAmenitiesHtml,
    galleryPopupHtml,
    galleryCarouselImageUrls,
  };
}

async function advanceAvailabilityCalendarAndCaptureHtml(
  page: Awaited<
    ReturnType<{ newPage: () => Promise<DiscoverContext["page"]> }["newPage"]>
  >,
  maxAdvanceMonths: number,
): Promise<string> {
  const normalizedMaxAdvanceMonths = Math.max(0, maxAdvanceMonths || 0);
  const capturedSnapshots: string[] = [];

  const signature = async (): Promise<{
    key: string;
    maxDate: string;
    nextDisabled: boolean;
  } | null> =>
    page.evaluate(() => {
      const container = document.querySelector<HTMLElement>(
        ".homelocal-availability-calendar-container",
      );
      if (container) {
        const active = container.querySelector<HTMLElement>(
          ".calendar.tns-slide-active",
        );
        const activeYear = active?.getAttribute("data-y") ?? "";
        const activeMonth = active?.getAttribute("data-m") ?? "";

        let maxDate = "";
        for (const node of container.querySelectorAll<HTMLElement>(
          ".day.day-of-month[data-date]",
        )) {
          const value = node.getAttribute("data-date") ?? "";
          if (value && value > maxDate) {
            maxDate = value;
          }
        }

        const nextButton = container.querySelector<HTMLButtonElement>(
          "button[data-controls='next']",
        );
        const nextDisabled =
          !nextButton ||
          nextButton.disabled ||
          nextButton.getAttribute("aria-disabled") === "true";

        return {
          key: `${activeYear}-${activeMonth}`,
          maxDate,
          nextDisabled,
        };
      }

      const redesignedSection = document.querySelector<HTMLElement>(
        "section[aria-labelledby='availability']",
      );
      if (!redesignedSection) {
        return null;
      }

      const monthLabels = Array.from(
        redesignedSection.querySelectorAll<HTMLElement>("h3[id*='month']"),
      )
        .map((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim())
        .filter(Boolean);

      const statusText = (
        redesignedSection.querySelector<HTMLElement>("p.sr-only[role='status']")
          ?.textContent ?? ""
      )
        .replace(/\s+/g, " ")
        .trim();

      const nextButton = Array.from(
        redesignedSection.querySelectorAll<HTMLButtonElement>(
          "button[aria-label]",
        ),
      ).find((button) =>
        /next month/i.test(button.getAttribute("aria-label") ?? ""),
      );

      const nextDisabled =
        !nextButton ||
        nextButton.disabled ||
        nextButton.getAttribute("aria-disabled") === "true";

      return {
        key: `${statusText}::${monthLabels.join("|")}`,
        maxDate: "",
        nextDisabled,
      };
    });

  await page.evaluate(() => {
    const container = document.querySelector<HTMLElement>(
      ".homelocal-availability-calendar-container",
    );
    if (container) {
      container.scrollIntoView({ block: "center", behavior: "instant" });
      return;
    }

    const redesignedSection = document.querySelector<HTMLElement>(
      "section[aria-labelledby='availability']",
    );
    redesignedSection?.scrollIntoView({ block: "center", behavior: "instant" });
  });
  await page.waitForTimeout(300);
  capturedSnapshots.push(await page.content());

  let stagnantClicks = 0;
  for (
    let clickIndex = 0;
    clickIndex < normalizedMaxAdvanceMonths;
    clickIndex += 1
  ) {
    const before = await signature();
    if (!before || before.nextDisabled) {
      break;
    }

    const clicked = await page.evaluate(() => {
      const container = document.querySelector<HTMLElement>(
        ".homelocal-availability-calendar-container",
      );
      if (container) {
        const nextButton = container.querySelector<HTMLButtonElement>(
          "button[data-controls='next']",
        );
        if (
          !nextButton ||
          nextButton.disabled ||
          nextButton.getAttribute("aria-disabled") === "true"
        ) {
          return false;
        }
        nextButton.click();
        return true;
      }

      const redesignedSection = document.querySelector<HTMLElement>(
        "section[aria-labelledby='availability']",
      );
      const nextButton = Array.from(
        redesignedSection?.querySelectorAll<HTMLButtonElement>(
          "button[aria-label]",
        ) ?? [],
      ).find((button) =>
        /next month/i.test(button.getAttribute("aria-label") ?? ""),
      );

      if (
        !nextButton ||
        nextButton.disabled ||
        nextButton.getAttribute("aria-disabled") === "true"
      ) {
        return false;
      }

      nextButton.click();
      return true;
    });

    if (!clicked) {
      break;
    }

    let changed = false;
    for (let poll = 0; poll < 10; poll += 1) {
      await page.waitForTimeout(180);
      const after = await signature();
      if (!after) {
        break;
      }
      if (after.key !== before.key || after.maxDate > before.maxDate) {
        changed = true;
        break;
      }
    }

    if (!changed) {
      stagnantClicks += 1;
      if (stagnantClicks >= 2) {
        break;
      }
      continue;
    }

    stagnantClicks = 0;
    capturedSnapshots.push(await page.content());
  }

  if (capturedSnapshots.length === 0) {
    return page.content();
  }
  return capturedSnapshots.join("\n<!-- stayon30a-calendar-snapshot -->\n");
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

function parseNumberLike(
  value: string | number | null | undefined,
): number | null {
  const numeric = Number(String(value ?? "").trim());
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return numeric;
}

function parseCoordinateLike(
  value: string | number | null | undefined,
  axis: "lat" | "lng",
): number | null {
  const parsed = parseNumberLike(value);
  if (parsed === null) {
    return null;
  }

  if (Math.abs(parsed) < 1e-9) {
    return null;
  }

  if (axis === "lat") {
    return parsed >= -90 && parsed <= 90 ? parsed : null;
  }

  return parsed >= -180 && parsed <= 180 ? parsed : null;
}

function parsePositiveNumberLike(
  value: string | number | null | undefined,
): number | null {
  const parsed = parseNumberLike(value);
  if (parsed === null || parsed <= 0) {
    return null;
  }
  return parsed;
}

function extractSectionBetween(
  html: string,
  startMarker: string,
  endMarker: string,
): string {
  const start = html.indexOf(startMarker);
  if (start < 0) {
    return "";
  }
  const end = html.indexOf(endMarker, start + startMarker.length);
  if (end < 0) {
    return "";
  }
  return html.slice(start, end);
}

function extractFirstDivBlockByClass(html: string, classToken: string): string {
  const startPattern = new RegExp(
    `<div[^>]+class\\s*=\\s*["'][^"']*\\b${classToken}\\b[^"']*["'][^>]*>`,
    "i",
  );
  const startMatch = startPattern.exec(html);
  if (!startMatch || typeof startMatch.index !== "number") {
    return "";
  }

  const startIndex = startMatch.index;
  const tagScanner = /<\/?div\b[^>]*>/gi;
  tagScanner.lastIndex = startIndex;

  let depth = 0;
  let firstTagSeen = false;
  let match: RegExpExecArray | null;

  while ((match = tagScanner.exec(html)) !== null) {
    const token = match[0] ?? "";
    const isClosingTag = /^<\/div/i.test(token);

    if (!firstTagSeen) {
      firstTagSeen = true;
      depth = 1;
      continue;
    }

    depth += isClosingTag ? -1 : 1;
    if (depth === 0) {
      return html.slice(startIndex, tagScanner.lastIndex);
    }
  }

  return html.slice(startIndex);
}

function extractJsonLdObjects(html: string): Array<Record<string, unknown>> {
  const scripts = html.match(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi,
  );
  if (!scripts?.length) {
    return [];
  }

  const objects: Array<Record<string, unknown>> = [];
  for (const script of scripts) {
    const jsonText = script
      .replace(/<script[^>]*>/i, "")
      .replace(/<\/script>\s*$/i, "")
      .trim();

    if (!jsonText) {
      continue;
    }

    try {
      const parsed = JSON.parse(jsonText) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item === "object") {
            objects.push(item as Record<string, unknown>);
          }
        }
      } else if (parsed && typeof parsed === "object") {
        objects.push(parsed as Record<string, unknown>);

        const graph = (parsed as Record<string, unknown>)["@graph"];
        if (Array.isArray(graph)) {
          for (const item of graph) {
            if (item && typeof item === "object") {
              objects.push(item as Record<string, unknown>);
            }
          }
        }
      }
    } catch {
      // Ignore malformed JSON-LD blocks.
    }
  }

  return objects;
}

function extractGeoFromJsonLdObjects(
  jsonLdObjects: Array<Record<string, unknown>>,
): { latitude: number; longitude: number } | null {
  for (const object of jsonLdObjects) {
    const latDirect = parseCoordinateLike(
      object.latitude as string | number | null,
      "lat",
    );
    const lngDirect = parseCoordinateLike(
      object.longitude as string | number | null,
      "lng",
    );
    if (latDirect !== null && lngDirect !== null) {
      return { latitude: latDirect, longitude: lngDirect };
    }

    const geo =
      object && typeof object.geo === "object"
        ? (object.geo as Record<string, unknown>)
        : null;
    if (!geo) {
      continue;
    }

    const latGeo = parseCoordinateLike(
      geo.latitude as string | number | null,
      "lat",
    );
    const lngGeo = parseCoordinateLike(
      geo.longitude as string | number | null,
      "lng",
    );
    if (latGeo !== null && lngGeo !== null) {
      return { latitude: latGeo, longitude: lngGeo };
    }
  }

  return null;
}

function extractGoogleMapsHrefGeo(
  html: string,
): { latitude: number; longitude: number } | null {
  const match = html.match(
    /https?:\/\/www\.google\.com\/maps\/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),/i,
  );
  if (!match) {
    return null;
  }

  const latitude = parseCoordinateLike(match[1], "lat");
  const longitude = parseCoordinateLike(match[2], "lng");
  if (latitude === null || longitude === null) {
    return null;
  }

  return { latitude, longitude };
}

function extractLeafletConfig(html: string): {
  latitude: number | null;
  longitude: number | null;
  propertyId: string | null;
} {
  const scriptMatch = html.match(/\}\)\((\{[\s\S]*?"mapId"[\s\S]*?\})\);/i);
  if (!scriptMatch?.[1]) {
    return {
      latitude: null,
      longitude: null,
      propertyId: null,
    };
  }

  try {
    const parsed = JSON.parse(scriptMatch[1]) as Record<string, unknown>;
    const latitude = parseCoordinateLike(parsed.lat as string | number, "lat");
    const longitude = parseCoordinateLike(parsed.lng as string | number, "lng");

    const mapId = String(parsed.mapId ?? "");
    const propertyId = mapId.match(/(\d+)/)?.[1] ?? null;

    return {
      latitude,
      longitude,
      propertyId,
    };
  } catch {
    return {
      latitude: null,
      longitude: null,
      propertyId: null,
    };
  }
}

function collectMediaUrls(
  html: string,
  baseUrl: string,
  lodgingJsonLd: Record<string, unknown> | null,
): string[] {
  const mediaByKey = new Map<string, { url: string; width: number }>();
  const expectedPhotoCount = parseInt(
    extractFirst(/show\s+all\s+photos\s*\((\d+)\)/i, html) ||
      extractFirst(/photo\s+\d+\s+of\s+(\d+)/i, html) ||
      "",
    10,
  );

  const canonicalizeMediaUrl = (value: string): string | null => {
    let parsed: URL;
    try {
      parsed = new URL(value, baseUrl);
    } catch {
      return null;
    }

    const host = parsed.hostname.toLowerCase();
    if (!host.endsWith("assets.guesty.com")) {
      return null;
    }
    parsed.pathname = parsed.pathname
      .replace(/\/{2,}/g, "/")
      .replace(/(\/image\/upload\/)([^/]+)\//i, "$1w_1920,q_auto,f_auto/");

    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  };

  const mediaKeyAndWidth = (
    urlText: string,
  ): { key: string; width: number } => {
    let width = Number(urlText.match(/\/w_(\d{2,5})\b/i)?.[1] ?? "0");
    if (!Number.isFinite(width)) {
      width = 0;
    }

    try {
      const parsed = new URL(urlText);
      const last = parsed.pathname.split("/").filter(Boolean).at(-1) ?? "";
      if (last) {
        const normalizedLast = last.trim().toLowerCase();
        if (normalizedLast) {
          return { key: normalizedLast, width };
        }
      }
    } catch {
      // Fall through to URL key.
    }

    return { key: urlText, width };
  };

  const trimToExpectedPhotoCount = (urls: string[]): string[] => {
    if (urls.length === 0) {
      return urls;
    }

    const expectedCount = expectedPhotoCount;

    if (!Number.isFinite(expectedCount) || expectedCount <= 0) {
      return urls;
    }

    const extensionUrls = urls.filter((url) =>
      /\.(jpg|jpeg|png|webp|avif)(?:$|[?#/])/i.test(url),
    );
    const candidateUrls =
      extensionUrls.length >= expectedCount ? extensionUrls : urls;

    if (candidateUrls.length <= expectedCount) {
      return candidateUrls;
    }

    return candidateUrls.slice(0, expectedCount);
  };

  const addIfUseful = (value: unknown): void => {
    if (typeof value !== "string" || value.trim().length === 0) {
      return;
    }
    const decoded = decodeHtmlEntities(value)
      .replace(/\\u002F/gi, "/")
      .replace(/\\\//g, "/")
      .trim();
    const matches = decoded.match(
      /https?:\/\/assets\.guesty\.com\/[^\s"'<>]+/gi,
    );
    for (const rawMatch of matches ?? []) {
      const cleaned = rawMatch
        .replace(/&quot;.*$/i, "")
        .replace(/&#34;.*$/i, "")
        .replace(/&#39;.*$/i, "")
        .replace(/[),;]+$/g, "")
        .trim();
      if (!cleaned) {
        continue;
      }

      const canonical = canonicalizeMediaUrl(cleaned);
      if (!canonical) {
        continue;
      }
      const { key, width } = mediaKeyAndWidth(canonical);
      const existing = mediaByKey.get(key);
      if (!existing || width > existing.width) {
        mediaByKey.set(key, { url: canonical, width });
      }
    }
  };

  const galleryScopedHtml = extractFirstDivBlockByClass(
    html,
    "acf-photo-gallery",
  );

  const extractAttribute = (tagHtml: string, attributeName: string): string => {
    const attrMatch = new RegExp(
      `\\b${attributeName}\\s*=\\s*["']([^"']+)["']`,
      "i",
    ).exec(tagHtml);
    return attrMatch?.[1]?.trim() ?? "";
  };

  for (const anchorMatch of galleryScopedHtml.matchAll(/<a\b[^>]*>/gi)) {
    const anchorTag = anchorMatch[0] ?? "";
    if (!/\bglightbox\b/i.test(anchorTag)) {
      continue;
    }
    const galleryName = extractAttribute(anchorTag, "data-gallery");
    if (galleryName.toLowerCase() !== "property-gallery") {
      continue;
    }
    const href = extractAttribute(anchorTag, "href");
    addIfUseful(href);
  }

  const orderedGalleryUrls = Array.from(mediaByKey.values()).map(
    (entry) => entry.url,
  );
  if (orderedGalleryUrls.length > 0) {
    if (
      !Number.isFinite(expectedPhotoCount) ||
      expectedPhotoCount <= 0 ||
      orderedGalleryUrls.length >= expectedPhotoCount
    ) {
      return trimToExpectedPhotoCount(orderedGalleryUrls);
    }
  }

  const guestyUrlMatches = html.match(
    /https?:\/\/assets\.guesty\.com\/(?:image\/upload\/[^"'\s<>]+|production\/[^"'\s<>]+)/gi,
  );
  for (const rawUrl of guestyUrlMatches ?? []) {
    addIfUseful(rawUrl);
  }

  const canonicalUrls = Array.from(mediaByKey.values()).map(
    (entry) => entry.url,
  );
  if (canonicalUrls.length > 0) {
    return trimToExpectedPhotoCount(canonicalUrls);
  }

  // Fallback to listing JSON-LD image set when gallery signals are absent.
  const listingImages = lodgingJsonLd?.image;
  if (typeof listingImages === "string") {
    addIfUseful(listingImages);
  }
  if (Array.isArray(listingImages)) {
    for (const image of listingImages) {
      addIfUseful(image);
    }
  }

  return trimToExpectedPhotoCount(
    Array.from(mediaByKey.values()).map((entry) => entry.url),
  );
}

function prettifyAmenityToken(value: string): string {
  const withSpaces = value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!withSpaces) {
    return "";
  }
  return withSpaces
    .split(" ")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function extractAmenitiesFromJsonLd(
  lodgingJsonLd: Record<string, unknown> | null,
): string[] {
  const containsPlace =
    lodgingJsonLd && typeof lodgingJsonLd.containsPlace === "object"
      ? (lodgingJsonLd.containsPlace as Record<string, unknown>)
      : null;
  const amenityFeature = Array.isArray(containsPlace?.amenityFeature)
    ? containsPlace.amenityFeature
    : [];

  const amenities: string[] = [];
  for (const feature of amenityFeature) {
    if (!feature || typeof feature !== "object") {
      continue;
    }
    const value = (feature as Record<string, unknown>).value;
    if (value !== true && value !== "true" && value !== 1) {
      continue;
    }
    const name = prettifyAmenityToken(
      String((feature as Record<string, unknown>).name ?? ""),
    );
    if (name) {
      amenities.push(name);
    }
  }

  return dedupePreserveOrder(amenities);
}

function extractBedGuidanceFromJsonLd(
  lodgingJsonLd: Record<string, unknown> | null,
): string[] {
  const containsPlace =
    lodgingJsonLd && typeof lodgingJsonLd.containsPlace === "object"
      ? (lodgingJsonLd.containsPlace as Record<string, unknown>)
      : null;
  const beds = Array.isArray(containsPlace?.bed) ? containsPlace.bed : [];
  const lines: string[] = [];
  for (const bed of beds) {
    if (!bed || typeof bed !== "object") {
      continue;
    }
    const entry = bed as Record<string, unknown>;
    const type = prettifyAmenityToken(String(entry.typeOfBed ?? ""));
    const count = parsePositiveNumberLike(
      entry.numberOfBeds as number | string,
    );
    if (!type) {
      continue;
    }
    lines.push(count ? `${type}: ${count}` : type);
  }
  return dedupePreserveOrder(lines);
}

function buildCapacityFallbackGuidance(input: {
  beds: number | null;
  baths: number | null;
  sleeps: number | null;
}): string[] {
  const parts: string[] = [];
  if (input.beds && input.beds > 0) {
    parts.push(`Bedrooms: ${input.beds}`);
  }
  if (input.baths && input.baths > 0) {
    parts.push(`Bathrooms: ${input.baths}`);
  }
  if (input.sleeps && input.sleeps > 0) {
    parts.push(`Sleeps: ${input.sleeps}`);
  }

  if (parts.length === 0) {
    return [];
  }

  return [parts.join(" | ")];
}

function extractSectionByLabel(plainText: string, label: string): string {
  const lower = plainText.toLowerCase();
  const start = lower.indexOf(label.toLowerCase());
  if (start < 0) {
    return "";
  }

  const endCandidates = [
    lower.indexOf("where you'll be", start + 1),
    lower.indexOf("things to know", start + 1),
    lower.indexOf("cancellation policy", start + 1),
    lower.indexOf("availability calendar", start + 1),
  ].filter((index) => index > start);

  const end =
    endCandidates.length > 0
      ? Math.min(...endCandidates)
      : Math.min(plainText.length, start + 1200);

  return plainText.slice(start, end).trim();
}

function extractListingKeyFromDetailUrl(detailUrl: string): string | null {
  try {
    const parsed = new URL(detailUrl);
    if (!parsed.hostname.endsWith("stayon30a.com")) {
      return null;
    }

    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length === 0) {
      return null;
    }

    if (parts[0] === "property" && parts[1]) {
      return parts[1].trim().toLowerCase();
    }

    const numeric = parts[0]?.match(/\d+/)?.[0] ?? null;
    return numeric;
  } catch {
    return null;
  }
}

function canonicalizeStayDetailUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.endsWith("stayon30a.com")) {
      return null;
    }

    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length === 0) {
      return null;
    }

    if (parts[0] === "property" && parts[1]) {
      return `https://www.stayon30a.com/property/${parts[1].trim().toLowerCase()}`;
    }

    const numeric = parts[0]?.match(/\d+/)?.[0] ?? null;
    if (!numeric) {
      return null;
    }
    return `https://www.stayon30a.com/${numeric}`;
  } catch {
    return null;
  }
}

function extractHomeLocalPropertyId(html: string): string | null {
  const matchers = [
    /"property_id"\s*:\s*(\d+)/i,
    /property_id\s*=\s*["']?(\d+)["']?/i,
    /"propertyId"\s*:\s*(\d+)/i,
    /"item_id"\s*:\s*"([a-f0-9]{24})"/i,
    /\\"item_id\\"\s*:\s*\\"([a-f0-9]{24})\\"/i,
    /"listingId"\s*:\s*"([a-f0-9]{24})"/i,
    /\\"listingId\\"\s*:\s*\\"([a-f0-9]{24})\\"/i,
  ];

  for (const matcher of matchers) {
    const match = html.match(matcher);
    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
}

function formatDateIso(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const MONTH_TO_INDEX: Record<string, number> = {
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

function parseIsoDateFromLongForm(value: string): string | null {
  const match = value.match(
    /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s*(\d{4})/i,
  );
  if (!match?.[1] || !match[2] || !match[3]) {
    return null;
  }

  const month = MONTH_TO_INDEX[match[1].toLowerCase()];
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (!month || !Number.isFinite(day) || !Number.isFinite(year)) {
    return null;
  }

  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function mapDayStateToStatusCode(input: {
  checkinAvailable: boolean;
  checkoutAvailable: boolean;
}): StayOnStatusCode {
  if (input.checkinAvailable && input.checkoutAvailable) {
    return "A";
  }
  if (input.checkinAvailable && !input.checkoutAvailable) {
    return "I";
  }
  if (!input.checkinAvailable && input.checkoutAvailable) {
    return "O";
  }
  return "U";
}

function applyStatusCodeToDay(
  day: StayDetailRecord["normalized_availability"]["days"][number],
  statusCode: StayOnStatusCode,
): StayDetailRecord["normalized_availability"]["days"][number] {
  return {
    ...day,
    day_code: toDayCodeFromStatus(statusCode),
    changeover_code: toChangeoverCodeFromStatus(statusCode),
    is_available: statusCode === "A" || statusCode === "O",
    status_code: statusCode,
    is_available_for_checkin: statusCode === "A" || statusCode === "I",
    is_available_for_checkout: statusCode === "A" || statusCode === "O",
    booking_day_state:
      statusCode === "A" || statusCode === "O" ? "bookable" : "blocked",
  };
}

function inferTurnBoundaryStatuses(
  days: StayDetailRecord["normalized_availability"]["days"],
): StayDetailRecord["normalized_availability"]["days"] {
  if (days.length < 2) {
    return days;
  }

  const nextDays = days.map((day) => ({ ...day }));
  for (let index = 1; index < nextDays.length; index += 1) {
    const prev = nextDays[index - 1];
    const curr = nextDays[index];
    if (!prev || !curr) {
      continue;
    }

    // Preserve source-provided boundary signals when already present.
    if (prev.status_code !== "A" && prev.status_code !== "U") {
      continue;
    }
    if (curr.status_code !== "A" && curr.status_code !== "U") {
      continue;
    }

    if (prev.status_code === "U" && curr.status_code === "A") {
      nextDays[index] = applyStatusCodeToDay(curr, "I");
      continue;
    }

    if (prev.status_code === "A" && curr.status_code === "U") {
      nextDays[index - 1] = applyStatusCodeToDay(prev, "O");
    }
  }

  return nextDays;
}

function extractNormalizedAvailabilityDaysFromCalendar(
  html: string,
  horizonDays: number,
): StayDetailRecord["normalized_availability"]["days"] {
  const dayByDate = new Map<
    string,
    StayDetailRecord["normalized_availability"]["days"][number]
  >();

  for (const match of html.matchAll(
    /<div\b[^>]*\bdata-date\s*=\s*"(\d{4}-\d{2}-\d{2})"[^>]*>/gi,
  )) {
    const dayTag = match[0] ?? "";
    const date = match[1] ?? "";
    if (!date || dayByDate.has(date)) {
      continue;
    }

    const classAttr =
      dayTag.match(/\bclass\s*=\s*"([^"]+)"/i)?.[1]?.toLowerCase() ?? "";
    if (!classAttr.includes("day-of-month")) {
      continue;
    }

    const checkinAvailable = classAttr.includes("checkin-available");
    const checkoutAvailable = classAttr.includes("checkout-available");
    const hasCheckinFlag = /\bcheckin-(available|booked|blocked)\b/.test(
      classAttr,
    );
    const hasCheckoutFlag = /\bcheckout-(available|booked|blocked)\b/.test(
      classAttr,
    );
    if (!hasCheckinFlag && !hasCheckoutFlag) {
      continue;
    }

    const statusCode = mapDayStateToStatusCode({
      checkinAvailable,
      checkoutAvailable,
    });

    dayByDate.set(date, {
      date,
      day_code: toDayCodeFromStatus(statusCode),
      changeover_code: toChangeoverCodeFromStatus(statusCode),
      is_available: statusCode === "A" || statusCode === "O",
      status_code: statusCode,
      is_available_for_checkin: checkinAvailable,
      is_available_for_checkout: checkoutAvailable,
      booking_day_state:
        statusCode === "A" || statusCode === "O" ? "bookable" : "blocked",
    });
  }

  const days = Array.from(dayByDate.values()).sort((left, right) =>
    left.date.localeCompare(right.date),
  );
  if (days.length === 0) {
    // Fallback for redesigned calendar markup where day states are rendered
    // as button text inside table-based availability sections.
    for (const match of html.matchAll(
      /<button\b[^>]*>([\s\S]*?)<\/button>/gi,
    )) {
      const buttonHtml = match[0] ?? "";
      const buttonText = stripHtml(buttonHtml).replace(/\s+/g, " ").trim();
      if (!buttonText) {
        continue;
      }

      const dateIso = parseIsoDateFromLongForm(buttonText);
      if (!dateIso) {
        continue;
      }

      const normalizedText = buttonText.toLowerCase();
      if (normalizedText.includes("past")) {
        continue;
      }

      let statusCode: StayOnStatusCode | null = null;
      if (normalizedText.includes("available")) {
        statusCode = normalizedText.includes("not available") ? "U" : "A";
      } else if (normalizedText.includes("booked")) {
        statusCode = "U";
      }

      if (!statusCode) {
        continue;
      }

      const nextValue = {
        date: dateIso,
        day_code: toDayCodeFromStatus(statusCode),
        changeover_code: toChangeoverCodeFromStatus(statusCode),
        is_available: statusCode === "A" || statusCode === "O",
        status_code: statusCode,
        is_available_for_checkin: statusCode === "A" || statusCode === "I",
        is_available_for_checkout: statusCode === "A" || statusCode === "O",
        booking_day_state:
          statusCode === "A" || statusCode === "O" ? "bookable" : "blocked",
      } satisfies StayDetailRecord["normalized_availability"]["days"][number];

      const existing = dayByDate.get(dateIso);
      if (!existing) {
        dayByDate.set(dateIso, nextValue);
      } else if (!existing.is_available && nextValue.is_available) {
        dayByDate.set(dateIso, nextValue);
      }
    }
  }

  const fallbackDays = Array.from(dayByDate.values()).sort((left, right) =>
    left.date.localeCompare(right.date),
  );
  if (fallbackDays.length === 0) {
    return [];
  }

  const todayIso = formatDateIso(new Date());
  const filteredFromToday = fallbackDays.filter((day) => day.date >= todayIso);
  const baseline =
    filteredFromToday.length > 0 ? filteredFromToday : fallbackDays;
  const maxDays = Math.max(1, horizonDays || baseline.length);
  return inferTurnBoundaryStatuses(baseline.slice(0, maxDays));
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

function extractRoomDetailsGuidanceFromDescription(
  description: string,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const lines = description
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  for (const line of lines) {
    if (line.length < 10 || line.length > 240) {
      continue;
    }

    const normalized = line.toLowerCase();
    const hasRoomLabel =
      normalized.includes("bedroom") ||
      /^bed\s*\d+\s*:/i.test(normalized) ||
      normalized.includes("bunk room");
    if (!hasRoomLabel) {
      continue;
    }
    if (
      !/king|queen|full|double|twin|single|bunk|trundle|murphy|sofa\s*bed|daybed|futon|sleeps?/i.test(
        normalized,
      )
    ) {
      continue;
    }

    const cleaned = line
      .replace(/^[-*]\s*/, "")
      .replace(/\s*:\s*/g, ": ")
      .trim();
    if (seen.has(cleaned)) {
      continue;
    }

    seen.add(cleaned);
    out.push(cleaned);
  }

  const inlineMatches = description.matchAll(
    /(?:bedroom\s*#?\s*\d+\s*:\s*[^\.\n]{8,220}|bunk\s*room[^\.\n]{8,220})/gi,
  );
  for (const match of inlineMatches) {
    const raw = (match[0] ?? "").replace(/\s+/g, " ").trim();
    if (!raw) {
      continue;
    }
    const normalized = raw.toLowerCase();
    if (
      !/king|queen|full|double|twin|single|bunk|trundle|murphy|sofa\s*bed|daybed|futon|sleeps?/i.test(
        normalized,
      )
    ) {
      continue;
    }
    if (seen.has(raw)) {
      continue;
    }
    seen.add(raw);
    out.push(raw);
  }

  return out.slice(0, 80);
}

async function discoverListings(
  page: Parameters<
    ScraperAdapter<StayDetailRecord>["discoverListings"]
  >[0]["page"],
  anchorUrl: string,
  maxScrollSteps: number,
  scrollPauseMs: number,
  _networkIdleWaitMs: number,
  reportProgress: (message: string) => void,
): Promise<ScrapedLink[]> {
  const discoveredLinks = new Set<string>();

  const collectLinks = async (): Promise<number> => {
    const links = await page.evaluate(() => {
      const values = new Set<string>();
      const anchors = Array.from(document.querySelectorAll("a[href]"));
      for (const anchor of anchors) {
        const href = (anchor as HTMLAnchorElement).href;
        if (!href) {
          continue;
        }
        try {
          const parsed = new URL(href, window.location.origin);
          if (!parsed.hostname.endsWith("stayon30a.com")) {
            continue;
          }
          const parts = parsed.pathname.split("/").filter(Boolean);
          if (parts[0] === "property" && parts[1]) {
            values.add(
              `https://www.stayon30a.com/property/${parts[1].trim().toLowerCase()}`,
            );
          }
        } catch {
          // Ignore malformed href entries.
        }
      }
      return Array.from(values);
    });

    for (const link of links) {
      discoveredLinks.add(link);
    }

    return discoveredLinks.size;
  };

  await page.goto(anchorUrl, {
    waitUntil: "domcontentloaded",
    timeout: 120000,
  });

  await page.waitForTimeout(Math.max(1800, scrollPauseMs * 2));
  await collectLinks();

  const maxCycles = Math.min(maxScrollSteps, MAX_CLICK_CYCLES);
  for (let cycle = 0; cycle < maxCycles; cycle += 1) {
    const beforeCount = discoveredLinks.size;

    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });

    await page.waitForTimeout(CLICK_WAIT_MS);

    for (let poll = 0; poll < GROWTH_POLL_ROUNDS; poll += 1) {
      const currentCount = await collectLinks();
      if (currentCount > beforeCount) {
        break;
      }
      await page.waitForTimeout(350);
    }

    if (discoveredLinks.size === beforeCount && cycle > 2) {
      break;
    }

    if ((cycle + 1) % 3 === 0) {
      reportProgress(
        `infinite-scroll cycle ${cycle + 1}/${maxCycles}; links=${discoveredLinks.size}`,
      );
    }
  }

  const sortedLinks = Array.from(discoveredLinks).sort((left, right) =>
    left.localeCompare(right),
  );

  return sortedLinks.map((link) => ({
    link: normalizeLink(link),
    source_url: anchorUrl,
    anchor_text: "dom-infinite-scroll",
  }));
}

async function fetchDetail(
  browser: { newPage: () => Promise<DiscoverContext["page"]> },
  detailUrl: string,
  availabilityHorizonDays: number,
  maxCalendarAdvanceMonths: number,
  reportDetailProgress?: (message: string) => void,
): Promise<StayDetailRecord | null> {
  const listingKey = extractListingKeyFromDetailUrl(detailUrl);
  if (!listingKey) {
    return null;
  }

  try {
    const page = await browser.newPage();
    let finalUrl = detailUrl;
    let html = "";
    let prePopupHtml = "";
    let availabilityHtml = "";
    let popupDescriptionFromDialog = "";
    let popupAmenitiesFromDialog: PopupAmenitiesCapture = {
      categories: {},
      all: [],
    };
    let popupAmenitiesHtml = "";
    let galleryPopupHtml = "";
    let galleryCarouselImageUrls: string[] = [];
    let detailStatus: number | null = null;
    try {
      const detailResponse = await page.goto(detailUrl, {
        waitUntil: "domcontentloaded",
        timeout: 120000,
      });
      detailStatus = detailResponse?.status() ?? null;
      finalUrl = page.url();
      if (detailStatus === 200) {
        prePopupHtml = await page.content();
        const popupCapture = await captureModalPopupContent(page);
        popupDescriptionFromDialog = popupCapture.aboutDescription;
        popupAmenitiesFromDialog = popupCapture.popupAmenities;
        popupAmenitiesHtml = popupCapture.popupAmenitiesHtml;
        galleryPopupHtml = popupCapture.galleryPopupHtml;
        galleryCarouselImageUrls = popupCapture.galleryCarouselImageUrls;
        html = await page.content();
        availabilityHtml = await advanceAvailabilityCalendarAndCaptureHtml(
          page,
          maxCalendarAdvanceMonths,
        );
      } else {
        html = "";
        prePopupHtml = "";
        availabilityHtml = "";
      }
    } finally {
      await page.close();
    }

    if (detailStatus !== 200 || !html) {
      reportDetailProgress?.(
        `detail gate failed detail_url=${detailUrl} status=${String(detailStatus)} final_url=${finalUrl} html_present=${String(Boolean(html))}`,
      );
      console.warn(
        `[stayon30a] detail gate failed for ${detailUrl}: status=${String(detailStatus)} final_url=${finalUrl} html_present=${String(Boolean(html))}`,
      );
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
      ) || detailUrl;

    const metaDescription =
      extractFirst(
        /<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["'][^>]*>/i,
        html,
      ).slice(0, 2000) ||
      extractFirst(
        /<meta[^>]+content=["']([\s\S]*?)["'][^>]+name=["']description["'][^>]*>/i,
        html,
      ).slice(0, 2000);

    const jsonLdObjects = extractJsonLdObjects(html);
    const lodgingJsonLd =
      jsonLdObjects.find((item) => {
        const itemType = String(item["@type"] ?? "").toLowerCase();
        return (
          itemType.includes("vacationrental") ||
          itemType.includes("lodging") ||
          itemType.includes("accommodation")
        );
      }) ??
      jsonLdObjects[0] ??
      null;

    const descriptionSection = extractSectionBetween(
      html,
      'class="property_description"',
      "</section><!--End description-->",
    );
    const plainText = stripHtml(html);
    const thingsToKnowSection = extractSectionByLabel(
      plainText,
      "Things to know",
    );
    const cancellationPolicySection = extractSectionByLabel(
      plainText,
      "Cancellation policy",
    );

    const popupDescriptionRaw =
      popupDescriptionFromDialog || extractAboutSpacePopupDescription(html);
    const popupDescription =
      cleanAboutSpaceDescriptionText(popupDescriptionRaw);

    const descriptionExpanded =
      popupDescription ||
      [
        stripHtml(descriptionSection)
          .replace(/^description\s+/i, "")
          .trim(),
        stripHtml(
          typeof lodgingJsonLd?.description === "string"
            ? lodgingJsonLd.description
            : metaDescription,
        ).trim(),
        thingsToKnowSection,
        cancellationPolicySection,
      ]
        .filter((value) => value.length > 0)
        .join("\n\n")
        .slice(0, 20000);

    const amenitiesSection = extractSectionBetween(
      html,
      'id="property-amenities"',
      "</section>",
    );
    const categoryMap: Record<string, string[]> = {};
    let activeCategory = "General";
    const amenityBlocks = amenitiesSection.matchAll(
      /<div[^>]+class=["'][^"']*(amenity_group|amenity_item)[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi,
    );
    for (const block of amenityBlocks) {
      const kind = (block[1] ?? "").trim();
      const rawText = stripHtml(block[2] ?? "").trim();
      if (!rawText) {
        continue;
      }
      if (kind === "amenity_group") {
        activeCategory = rawText;
        if (!categoryMap[activeCategory]) {
          categoryMap[activeCategory] = [];
        }
        continue;
      }
      if (!categoryMap[activeCategory]) {
        categoryMap[activeCategory] = [];
      }
      if (!categoryMap[activeCategory].includes(rawText)) {
        categoryMap[activeCategory].push(rawText);
      }
    }

    const amenitiesFromJsonLd = extractAmenitiesFromJsonLd(lodgingJsonLd);

    for (const [category, values] of Object.entries(
      popupAmenitiesFromDialog.categories,
    )) {
      if (!categoryMap[category]) {
        categoryMap[category] = [];
      }
      for (const value of values) {
        if (!categoryMap[category].includes(value)) {
          categoryMap[category].push(value);
        }
      }
    }

    const amenitiesAll = dedupePreserveOrder([
      ...Object.values(categoryMap).flat().filter(Boolean),
      ...popupAmenitiesFromDialog.all,
      ...amenitiesFromJsonLd,
    ]);
    if (amenitiesFromJsonLd.length > 0 && !categoryMap["HomeLocal JSON-LD"]) {
      categoryMap["HomeLocal JSON-LD"] = amenitiesFromJsonLd;
    }

    const jsonLdAddress =
      lodgingJsonLd && typeof lodgingJsonLd.address === "object"
        ? (lodgingJsonLd.address as Record<string, unknown>)
        : null;
    const jsonLdGeo =
      lodgingJsonLd && typeof lodgingJsonLd.geo === "object"
        ? (lodgingJsonLd.geo as Record<string, unknown>)
        : null;
    const jsonLdContainsPlace =
      lodgingJsonLd && typeof lodgingJsonLd.containsPlace === "object"
        ? (lodgingJsonLd.containsPlace as Record<string, unknown>)
        : null;
    const containsPlaceOccupancy =
      jsonLdContainsPlace && typeof jsonLdContainsPlace.occupancy === "object"
        ? (jsonLdContainsPlace.occupancy as Record<string, unknown>)
        : null;
    const jsonLdAnyGeo = extractGeoFromJsonLdObjects(jsonLdObjects);
    const googleMapsHrefGeo = extractGoogleMapsHrefGeo(html);
    const leafletConfig = extractLeafletConfig(html);

    const location = {
      address: stripHtml(
        [
          jsonLdAddress?.streetAddress,
          jsonLdAddress?.addressLocality,
          jsonLdAddress?.addressRegion,
          jsonLdAddress?.postalCode,
        ]
          .map((part) => String(part ?? "").trim())
          .filter(Boolean)
          .join(", "),
      ).slice(0, 500),
      city: String(jsonLdAddress?.addressLocality ?? "").trim(),
      state: String(jsonLdAddress?.addressRegion ?? "").trim(),
      postal_code: String(jsonLdAddress?.postalCode ?? "").trim(),
      country: String(jsonLdAddress?.addressCountry ?? "").trim(),
      latitude:
        parseCoordinateLike(
          jsonLdGeo?.latitude as string | number | null,
          "lat",
        ) ??
        jsonLdAnyGeo?.latitude ??
        leafletConfig.latitude ??
        googleMapsHrefGeo?.latitude ??
        null,
      longitude:
        parseCoordinateLike(
          jsonLdGeo?.longitude as string | number | null,
          "lng",
        ) ??
        jsonLdAnyGeo?.longitude ??
        leafletConfig.longitude ??
        googleMapsHrefGeo?.longitude ??
        null,
    };

    const capacitySourceText = stripHtml(html);
    const beds =
      parsePositiveNumberLike(
        (jsonLdContainsPlace?.numberOfBedrooms as string | number | null) ??
          (lodgingJsonLd?.numberOfBedrooms as string | number | null) ??
          null,
      ) ??
      parsePositiveNumberLike(
        extractFirst(/\b(\d+(?:\.\d+)?)\s*beds?\b/i, capacitySourceText) ||
          extractFirst(
            /\bbeds?\s*[:-]?\s*(\d+(?:\.\d+)?)\b/i,
            capacitySourceText,
          ),
      );
    const baths =
      parsePositiveNumberLike(
        (jsonLdContainsPlace?.numberOfBathroomsTotal as
          | string
          | number
          | null) ??
          (jsonLdContainsPlace?.numberOfBathrooms as string | number | null) ??
          (lodgingJsonLd?.numberOfBathroomsTotal as string | number | null) ??
          (lodgingJsonLd?.numberOfBathrooms as string | number | null) ??
          null,
      ) ??
      parsePositiveNumberLike(
        extractFirst(
          /\b(\d+(?:\.\d+)?)\s*bath(?:room)?s?\b/i,
          capacitySourceText,
        ) ||
          extractFirst(
            /\bbath(?:room)?s?\s*[:-]?\s*(\d+(?:\.\d+)?)\b/i,
            capacitySourceText,
          ),
      );
    const sleeps =
      parsePositiveNumberLike(
        (containsPlaceOccupancy?.value as string | number | null) ??
          (containsPlaceOccupancy?.maxValue as string | number | null) ??
          (jsonLdContainsPlace?.maximumAttendeeCapacity as
            | string
            | number
            | null) ??
          (lodgingJsonLd?.maximumAttendeeCapacity as string | number | null) ??
          ((lodgingJsonLd?.occupancy as Record<string, unknown> | null)
            ?.value as string | number | null) ??
          ((lodgingJsonLd?.occupancy as Record<string, unknown> | null)
            ?.maxValue as string | number | null) ??
          null,
      ) ??
      parsePositiveNumberLike(
        extractFirst(/\b(\d+)\s*guests?\b/i, capacitySourceText) ||
          extractFirst(/\bguests?\s*[:-]?\s*(\d+)\b/i, capacitySourceText) ||
          extractFirst(/\bsleeps?\s*[:-]?\s*(\d+)\b/i, capacitySourceText),
      );

    const fallbackMediaUrls = collectMediaUrls(
      [prePopupHtml, galleryPopupHtml, html].filter(Boolean).join("\n"),
      finalUrl,
      lodgingJsonLd,
    );
    const mediaUrls =
      galleryCarouselImageUrls.length > 0
        ? dedupePreserveOrder(galleryCarouselImageUrls)
        : fallbackMediaUrls;
    const propertyId =
      extractHomeLocalPropertyId(html) ?? leafletConfig.propertyId;

    const htmlPath = resolve(OUTPUT_DETAILS_HTML_DIR, `${listingKey}.html`);
    await writeFile(htmlPath, `${html}\n`, "utf8");

    const normalizedDays = extractNormalizedAvailabilityDaysFromCalendar(
      availabilityHtml || prePopupHtml || html,
      availabilityHorizonDays,
    );
    const available = normalizedDays.filter(
      (day) => day.status_code === "A" || day.status_code === "O",
    ).length;
    const notAvailable = normalizedDays.filter(
      (day) => day.status_code === "U" || day.status_code === "I",
    ).length;
    const other = normalizedDays.length - available - notAvailable;
    const windowStart = normalizedDays[0]?.date ?? "";
    const windowEnd = normalizedDays[normalizedDays.length - 1]?.date ?? "";

    const description =
      descriptionExpanded || stripHtml(metaDescription).slice(0, 20000);
    const extractedRoomDetailsGuidance = dedupePreserveOrder([
      ...extractBedGuidanceFromJsonLd(lodgingJsonLd),
      ...extractRoomDetailsGuidanceFromDescription(description),
    ]).slice(0, 80);
    const roomDetailsGuidance =
      extractedRoomDetailsGuidance.length > 0
        ? extractedRoomDetailsGuidance
        : buildCapacityFallbackGuidance({ beds, baths, sleeps });
    const name = stripHtml(h1 || title).slice(0, 240);
    const descriptionNormalized = normalizeForMatch(description);
    const titleNormalized = normalizeForMatch(name);

    return {
      external_listing_id: listingKey,
      detail_url: finalUrl,
      fetched_at: new Date().toISOString(),
      quote_context: {
        listing_id: listingKey,
        unit_id: listingKey,
        detail_url: finalUrl,
        ...(propertyId ? { property_id: propertyId } : {}),
      },
      title,
      h1,
      canonical_url: canonicalUrl,
      meta_description: metaDescription,
      description_expanded: descriptionExpanded,
      rooms_guidance: roomDetailsGuidance,
      amenities: {
        categories: categoryMap,
        all: amenitiesAll,
      },
      location,
      media_gallery: {
        image_count: mediaUrls.length,
        image_urls: mediaUrls,
      },
      property_profile: {
        unit_id: listingKey,
        property_code: propertyId ?? listingKey,
        beds,
        baths,
        sleeps,
        city: location.city,
        state: location.state,
        zip: location.postal_code,
      },
      normalized_matching_profile: {
        source: "pm_stayon30a",
        external_listing_id: listingKey,
        name,
        description,
        match_signals: {
          description_normalized: descriptionNormalized,
          description_sha256: hashSha256(descriptionNormalized),
          title_normalized: titleNormalized,
          title_sha256: hashSha256(titleNormalized),
          listing_composite_key: [
            "pm_stayon30a",
            listingKey,
            hashSha256(descriptionNormalized),
            hashSha256(titleNormalized),
          ].join("::"),
        },
      },
      normalized_availability: {
        source: "pm_stayon30a",
        external_listing_id: listingKey,
        captured_at: new Date().toISOString(),
        window_start: windowStart,
        window_end: windowEnd,
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
        begin_date: windowStart,
        end_date: windowEnd,
        day_codes: normalizedDays.map((day) => day.status_code).join(""),
      },
      pricing_api_hints: {
        provider: "homelocal-wp-json-quotes",
        endpoint_path: "/wp-json/homelocal/v1/quotes",
        method_names: {
          quotes: "POST /wp-json/homelocal/v1/quotes",
        },
        notes:
          "HomeLocal platform: quote runtime uses property_id from detail page when present.",
      },
      html_path: htmlPath,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reportDetailProgress?.(
      `detail request_error detail_url=${detailUrl} message=${message}`,
    );
    return null;
  }
}

export function createStayOn30AAdapter(): ScraperAdapter<StayDetailRecord> {
  return {
    managerKey: "stayon30a",
    scriptLabel: "stayon30a",
    defaultAnchorUrl: DEFAULT_ANCHOR_URL,
    detailFetchDelayMs: Math.max(
      0,
      Number(process.env.STAYON30A_DETAIL_FETCH_DELAY_MS ?? "250") || 250,
    ),
    detailFetchConcurrency: Math.max(
      1,
      Number(process.env.STAYON30A_FETCH_CONCURRENCY ?? "6") || 6,
    ),
    availabilityHorizonDays: Math.max(
      1,
      Number(process.env.STAYON30A_AVAILABILITY_HORIZON_DAYS ?? "730") || 730,
    ),
    maxCalendarAdvanceMonths: 24,
    isValidDetailUrl(value: string): string | null {
      try {
        return canonicalizeStayDetailUrl(value.trim());
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
        context.browser as { newPage: () => Promise<DiscoverContext["page"]> },
        context.detailUrl,
        context.availabilityHorizonDays,
        context.maxCalendarAdvanceMonths,
        context.reportDetailProgress,
      );
    },
    async runQuoteCapture(argv, progress) {
      const normalizedArgs = await normalizeAdapterQuoteScopeArgs(
        "stayon30a",
        argv,
      );
      await runRuntimeAdapterQuoteCli(
        {
          adapterKey: "stayon30a",
          executeSingleQuote: executeStayon30aSingleQuote,
          defaultQuoteTimeoutMs: 20000,
          defaultQuoteMaxAttempts: 2,
          defaultEndpointPath: "/wp-json/homelocal/v1/quotes",
          defaultTaxPct: 0.12,
          defaultBaseNightly: 650,
        },
        normalizedArgs,
        progress,
      );
    },
    async runSingleQuoteObservation(input) {
      const result = await executeStayon30aSingleQuote({
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
          handoffUrl: null,
          reason: result.error.message,
        },
      };
    },
  };
}
