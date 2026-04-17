import { executeBenchmark30aSingleQuote } from "@/lib/pricing/quote-runtime/adapters/benchmark30a";
import { runRuntimeAdapterQuoteCli } from "@/lib/pricing/quotes/shared/runtime-adapter-quote-runner";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";

import { normalizeAdapterQuoteScopeArgs } from "../quote-scope";
import type { DetailRecordBase, ScrapedLink, ScraperAdapter } from "../types";

type BenchmarkDayCode = "A" | "U" | "I" | "O" | "X";

type BenchmarkMinNightRule = {
  start_date: string;
  end_date: string;
  min_nights: number;
  raw_rule: string;
};

type EmbeddedAvailRange = {
  b?: string;
  e?: string;
  a?: string;
};

type EmbeddedTurnRange = {
  b?: string;
  e?: string;
  t?: string;
};

type EmbeddedRestrRange = {
  b?: string;
  e?: string;
  mn?: number;
};

type EmbeddedRcItemForm = {
  avail?: EmbeddedAvailRange[];
  turn?: EmbeddedTurnRange[];
  restr?: EmbeddedRestrRange[];
};

type BenchmarkDetailRecord = DetailRecordBase & {
  quote_context?: {
    entity_id: number;
    ids_tuple: string;
    detail_url: string;
  };
  title: string;
  h1: string;
  canonical_url: string;
  meta_description: string;
  description_expanded: string;
  rooms_guidance: false;
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
    source: "pm_benchmark30a";
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
    source: "pm_benchmark30a";
    external_listing_id: string;
    captured_at: string;
    has_calendar_widget: boolean;
    booking_restrictions: string[];
    min_night_rules: BenchmarkMinNightRule[];
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
      status_code: BenchmarkDayCode;
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
  "https://www.benchmark30a.com/emerald-coast-vacation-rentals/30a#fq=%7B!tag%3DRiotSolrWidget%2CRiotSolrFacetList-sm_nid%24rc_core_term_type%24name%7Dsm_nid%24rc_core_term_type%24name%3A%22Private%20Home%22&q=im_nid%24rc_core_term_landing_pages%24tid%3A%22115%22";
const OUTPUT_ROOT = resolve(
  process.cwd(),
  "src",
  "lib",
  "data",
  "external-sources",
  "benchmark30a",
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
  if (!normalizedPath.startsWith("/emerald-coast-vacation-rentals/")) {
    return false;
  }

  const slug = normalizedPath.split("/").filter(Boolean).at(-1) ?? "";
  if (!slug) {
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

function extractLatLngFromHtml(html: string): {
  latitude: number | null;
  longitude: number | null;
} {
  const toFiniteInRange = (
    raw: string | undefined,
    min: number,
    max: number,
  ): number | null => {
    if (!raw) {
      return null;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
      return null;
    }
    return parsed;
  };

  // Prefer explicit field_location coordinates from the detail payload object.
  const fieldLocationMatch = html.match(
    /"field_location"[\s\S]{0,1500}?"latitude"\s*:\s*"?(-?\d{1,2}(?:\.\d+)?)"?\s*,\s*"longitude"\s*:\s*"?(-?\d{1,3}(?:\.\d+)?)"?/i,
  );
  if (fieldLocationMatch) {
    const latitude = toFiniteInRange(fieldLocationMatch[1], -90, 90);
    const longitude = toFiniteInRange(fieldLocationMatch[2], -180, 180);
    if (latitude !== null && longitude !== null) {
      return { latitude, longitude };
    }
  }

  const pairCandidates = Array.from(
    html.matchAll(
      /"latitude"\s*:\s*"?(-?\d{1,2}(?:\.\d+)?)"?\s*,\s*"longitude"\s*:\s*"?(-?\d{1,3}(?:\.\d+)?)"?/gi,
    ),
  )
    .map((match) => ({
      latitude: toFiniteInRange(match[1], -90, 90),
      longitude: toFiniteInRange(match[2], -180, 180),
    }))
    .filter(
      (candidate): candidate is { latitude: number; longitude: number } =>
        candidate.latitude !== null && candidate.longitude !== null,
    );

  const floridaPair = pairCandidates.find(
    (candidate) =>
      candidate.latitude >= 24 &&
      candidate.latitude <= 32 &&
      candidate.longitude >= -88 &&
      candidate.longitude <= -79,
  );
  if (floridaPair) {
    return floridaPair;
  }

  const ptMatch = html.match(
    /"pt"\s*:\s*"\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*"/i,
  );
  if (ptMatch) {
    const latitude = toFiniteInRange(ptMatch[1], -90, 90);
    const longitude = toFiniteInRange(ptMatch[2], -180, 180);
    if (latitude !== null && longitude !== null) {
      return { latitude, longitude };
    }
  }

  const llMatch = html.match(
    /maps\.google\.com\/maps\?[^"']*\bll=(-?\d{1,2}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)/i,
  );
  if (llMatch) {
    const latitude = toFiniteInRange(llMatch[1], -90, 90);
    const longitude = toFiniteInRange(llMatch[2], -180, 180);
    if (latitude !== null && longitude !== null) {
      return { latitude, longitude };
    }
  }

  return pairCandidates[0] ?? { latitude: null, longitude: null };
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

function extractBenchmarkQuoteContext(
  html: string,
  detailUrl: string,
): { entity_id: number; ids_tuple: string; detail_url: string } | null {
  const eidMatch = html.match(/"eid":"(\d+)"/i) ?? html.match(/rc-eid-(\d+)/i);
  const entityIdRaw = eidMatch?.[1] ? Number(eidMatch[1]) : Number.NaN;
  const entityId =
    Number.isFinite(entityIdRaw) && entityIdRaw > 0
      ? Math.floor(entityIdRaw)
      : null;

  let idsTuple = "";
  try {
    const parsed = new URL(detailUrl);
    idsTuple =
      parsed.searchParams.get("rcav[IDs][8][0]")?.trim() ??
      parsed.searchParams.get("rcav%5BIDs%5D%5B8%5D%5B0%5D")?.trim() ??
      "";
  } catch {
    // Keep empty and fall back to html parsing below.
  }

  if (!idsTuple) {
    idsTuple = html.match(/"id":"(\d+-\d+)"/i)?.[1]?.trim() ?? "";
  }

  if (!entityId || !idsTuple) {
    return null;
  }

  return {
    entity_id: entityId,
    ids_tuple: idsTuple,
    detail_url: detailUrl,
  };
}

function parseIsoDate(value: string): Date | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
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

function readJsonArrayAfterKey<T>(html: string, key: string): T[] {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const keyMatch = new RegExp(
    `(?:["'])?${escapedKey}(?:["'])?\\s*:\\s*\\[`,
    "m",
  ).exec(html);
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

function buildAvailabilityFromEmbeddedForm(
  form: EmbeddedRcItemForm,
  todayIso: string,
  horizonIso: string,
): {
  days: BenchmarkDetailRecord["normalized_availability"]["days"];
  minNightRules: BenchmarkMinNightRule[];
} {
  const availabilityByDate = new Map<string, BenchmarkDayCode>();
  const turnByDate = new Map<string, BenchmarkDayCode>();

  for (const range of form.avail ?? []) {
    const start = typeof range.b === "string" ? parseIsoDate(range.b) : null;
    const end = typeof range.e === "string" ? parseIsoDate(range.e) : null;
    if (!start || !end || end < start) {
      continue;
    }

    const code: BenchmarkDayCode = range.a === "1" ? "A" : "U";
    const cursor = new Date(start);
    while (cursor <= end) {
      const iso = formatIsoDate(cursor);
      if (iso >= todayIso && iso <= horizonIso) {
        availabilityByDate.set(iso, code);
      }

      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  }

  for (const range of form.turn ?? []) {
    const start = typeof range.b === "string" ? parseIsoDate(range.b) : null;
    const end = typeof range.e === "string" ? parseIsoDate(range.e) : null;
    if (!start || !end || end < start) {
      continue;
    }

    const marker = String(range.t ?? "").toUpperCase();
    let code: BenchmarkDayCode | null = null;
    if (marker === "I") {
      code = "I";
    } else if (marker === "O") {
      code = "O";
    } else if (marker === "X") {
      code = "U";
    } else if (marker === "A") {
      code = "A";
    }

    if (!code) {
      continue;
    }

    const cursor = new Date(start);
    while (cursor <= end) {
      const iso = formatIsoDate(cursor);
      if (iso >= todayIso && iso <= horizonIso) {
        turnByDate.set(iso, code);
      }

      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  }

  const minNightByDate = new Map<string, number>();
  const minNightRules: BenchmarkMinNightRule[] = [];

  for (const range of form.restr ?? []) {
    const start = typeof range.b === "string" ? parseIsoDate(range.b) : null;
    const end = typeof range.e === "string" ? parseIsoDate(range.e) : null;
    const minNights = Number(range.mn);
    if (
      !start ||
      !end ||
      end < start ||
      !Number.isFinite(minNights) ||
      minNights <= 0
    ) {
      continue;
    }

    const startDate = formatIsoDate(start);
    const endDate = formatIsoDate(end);
    minNightRules.push({
      start_date: startDate,
      end_date: endDate,
      min_nights: Math.floor(minNights),
      raw_rule: `${startDate}..${endDate}:${Math.floor(minNights)}`,
    });

    const cursor = new Date(start);
    while (cursor <= end) {
      const iso = formatIsoDate(cursor);
      if (iso >= todayIso && iso <= horizonIso) {
        const previous = minNightByDate.get(iso) ?? 0;
        const next = Math.max(previous, Math.floor(minNights));
        minNightByDate.set(iso, next);
      }

      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  }

  const allDates = new Set<string>([
    ...Array.from(availabilityByDate.keys()),
    ...Array.from(turnByDate.keys()),
  ]);
  const sortedDates = Array.from(allDates).sort((left, right) =>
    left.localeCompare(right),
  );

  const days = sortedDates.map((date) => {
    const statusCode =
      turnByDate.get(date) ?? availabilityByDate.get(date) ?? "X";
    const bookingDayState: "bookable" | "blocked" | "unknown" =
      statusCode === "A"
        ? "bookable"
        : statusCode === "U"
          ? "blocked"
          : "unknown";

    return {
      date,
      status_code: statusCode,
      is_available: statusCode === "A",
      is_available_for_checkin: statusCode === "A" || statusCode === "I",
      is_available_for_checkout: statusCode === "A" || statusCode === "O",
      booking_day_state: bookingDayState,
      min_nights_required: minNightByDate.get(date) ?? null,
    };
  });

  minNightRules.sort((left, right) =>
    left.start_date.localeCompare(right.start_date),
  );

  return {
    days,
    minNightRules,
  };
}

function extractEmbeddedAvailability(
  html: string,
  todayIso: string,
  horizonIso: string,
): {
  days: BenchmarkDetailRecord["normalized_availability"]["days"];
  minNightRules: BenchmarkMinNightRule[];
} {
  const rcItemAvailForms = readJsonArrayAfterKey<EmbeddedRcItemForm>(
    html,
    "rcItemAvailForm",
  );

  for (const form of rcItemAvailForms) {
    const extracted = buildAvailabilityFromEmbeddedForm(
      form,
      todayIso,
      horizonIso,
    );
    if (extracted.days.length > 0) {
      return extracted;
    }
  }

  return {
    days: [],
    minNightRules: [],
  };
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
  _networkIdleWaitMs: number,
  reportProgress: (message: string) => void,
): Promise<ScrapedLink[]> {
  await installEvaluateNameShim(page);

  await page.goto(anchorUrl, {
    waitUntil: "domcontentloaded",
    timeout: 120000,
  });
  await page.waitForTimeout(Math.max(2200, scrollPauseMs));

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
          if (!absolute.hostname.endsWith("benchmark30a.com")) {
            return "";
          }

          const normalizedPath = absolute.pathname
            .toLowerCase()
            .replace(/\/+$/, "");
          if (!normalizedPath.startsWith("/emerald-coast-vacation-rentals/")) {
            return "";
          }

          const slug = normalizedPath.split("/").filter(Boolean).at(-1) ?? "";
          if (!slug || !/^[a-z0-9][a-z0-9-]*$/i.test(slug)) {
            return "";
          }

          return `${absolute.origin}${absolute.pathname}`.replace(/\/$/, "");
        } catch {
          return "";
        }
      };

      const resultRootSelectors = [
        "riot-solr-result-list",
        ".riot-solr-result-list",
        ".view-vacation-rental-listings .view-content",
        "#content riot-solr-search",
      ];

      const candidateRoots = new Set<Element>();
      for (const selector of resultRootSelectors) {
        for (const node of Array.from(document.querySelectorAll(selector))) {
          candidateRoots.add(node);
        }
      }

      // Fall back to card-level discovery when root wrappers vary by template.
      for (const card of Array.from(
        document.querySelectorAll(
          "subtag[data-is='rc-riot-result-list-item'], .rc-riot-result-list-item, .riot-solr-item",
        ),
      )) {
        candidateRoots.add(card);
      }

      const anchors = Array.from(candidateRoots).flatMap((root) =>
        Array.from(root.querySelectorAll("a[href]")),
      );

      for (const anchor of anchors) {
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
      const match = bodyText.match(/\b(\d{1,4})\s+Results\b/i);
      if (match?.[1]) {
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

  const clickLoadMoreIfVisible = async (): Promise<boolean> =>
    page.evaluate(() => {
      const candidates = Array.from(
        document.querySelectorAll(
          "button, a, [role='button'], input[type='button'], input[type='submit']",
        ),
      );

      for (const node of candidates) {
        const element = node as HTMLElement;
        const label = [
          element.textContent ?? "",
          element.getAttribute("aria-label") ?? "",
          element.getAttribute("value") ?? "",
          element.getAttribute("title") ?? "",
        ]
          .join(" ")
          .toLowerCase();

        if (element.offsetParent === null) {
          continue;
        }
        if (
          element.getAttribute("aria-disabled") === "true" ||
          element.getAttribute("disabled") !== null
        ) {
          continue;
        }

        if (/load more|show more|more results|view more|next/.test(label)) {
          element.click();
          return true;
        }
      }

      return false;
    });

  const runIncrementalScrollPass = async (): Promise<void> => {
    await page.evaluate(async () => {
      const wait = (ms: number): Promise<void> =>
        new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

      const scroller =
        document.scrollingElement ?? document.documentElement ?? document.body;
      const stepPx = Math.max(260, Math.floor(window.innerHeight * 0.8));

      let unchangedTicks = 0;
      let previousHeight = scroller.scrollHeight;
      let previousTop = scroller.scrollTop;

      for (let tick = 0; tick < 32; tick += 1) {
        window.scrollBy(0, stepPx);
        window.dispatchEvent(new Event("scroll"));
        await wait(220);

        const topNow = scroller.scrollTop;
        const heightNow = scroller.scrollHeight;
        const nearBottom =
          topNow + window.innerHeight >= Math.max(0, heightNow - 220);

        if (nearBottom) {
          // Let infinite-list observers and async fetches hydrate additional cards.
          await wait(420);
          window.dispatchEvent(new Event("scroll"));
          await wait(260);
        }

        const progressed = topNow > previousTop || heightNow > previousHeight;
        if (!progressed) {
          unchangedTicks += 1;
        } else {
          unchangedTicks = 0;
        }

        previousTop = topNow;
        previousHeight = heightNow;

        if (unchangedTicks >= 6 && nearBottom) {
          break;
        }
      }
    });
  };

  let discovery = await readDiscoverySnapshot();
  const cumulativeLinks = new Map<string, string>();
  for (const row of discovery.rows) {
    cumulativeLinks.set(normalizeDetailUrl(row.href), row.text);
  }

  let previousCount = cumulativeLinks.size;
  let stagnantSteps = 0;
  const effectiveScrollSteps = Math.max(12, maxScrollSteps);
  const effectivePauseMs = Math.max(500, Math.min(scrollPauseMs, 1600));

  if (discovery.expectedCount !== null) {
    reportProgress(
      `discovery expected count from page=${discovery.expectedCount}, initial dom captured=${discovery.rows.length}, cumulative=${cumulativeLinks.size}`,
    );
  }

  for (let step = 0; step < effectiveScrollSteps; step += 1) {
    await runIncrementalScrollPass();
    await page.waitForTimeout(effectivePauseMs);

    const clickedLoadMore = await clickLoadMoreIfVisible();
    if (clickedLoadMore) {
      await page.waitForTimeout(Math.max(900, effectivePauseMs));
    }

    discovery = await readDiscoverySnapshot();
    for (const row of discovery.rows) {
      cumulativeLinks.set(normalizeDetailUrl(row.href), row.text);
    }
    const combinedCount = cumulativeLinks.size;

    if (combinedCount > previousCount) {
      reportProgress(
        `discovery grew to ${combinedCount}${
          discovery.expectedCount ? `/${discovery.expectedCount}` : ""
        } at scroll step ${step + 1} (results_dom=${discovery.rows.length})`,
      );
      previousCount = combinedCount;
      stagnantSteps = 0;
      if (
        discovery.expectedCount !== null &&
        combinedCount >= discovery.expectedCount
      ) {
        break;
      }
      continue;
    }

    stagnantSteps += 1;
    if (
      discovery.expectedCount !== null &&
      combinedCount >= discovery.expectedCount
    ) {
      break;
    }

    if (stagnantSteps >= 20) {
      break;
    }
  }

  await page.waitForTimeout(1200);
  const finalDom = await readDiscoverySnapshot();

  const merged = new Map<string, string>();
  for (const [href, text] of cumulativeLinks.entries()) {
    merged.set(href, text);
  }
  for (const row of finalDom.rows) {
    merged.set(normalizeDetailUrl(row.href), row.text);
  }

  if (finalDom.expectedCount !== null) {
    reportProgress(
      `discovery final captured=${merged.size}/${finalDom.expectedCount} (results_dom=${finalDom.rows.length})`,
    );
  } else {
    reportProgress(
      `discovery final captured=${merged.size} (results_dom=${finalDom.rows.length})`,
    );
  }

  return Array.from(merged.entries()).map(([link, text]) => ({
    link,
    source_url: anchorUrl,
    anchor_text: text,
  }));
}

async function clickAvailabilitySection(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const nodes = Array.from(
      document.querySelectorAll(
        "a, button, summary, [role='button'], h2, h3, h4, .field-group-format-title",
      ),
    );

    for (const node of nodes) {
      const element = node as HTMLElement;
      const label = [
        element.textContent ?? "",
        element.getAttribute("aria-label") ?? "",
        element.getAttribute("title") ?? "",
      ]
        .join(" ")
        .toLowerCase();

      if (!/availability|calendar/.test(label)) {
        continue;
      }

      if (element.offsetParent === null) {
        continue;
      }

      element.click();
      return true;
    }

    return false;
  });
}

async function clickReadMore(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const nodes = Array.from(
      document.querySelectorAll("button, a, [role='button'], .toggle-desc"),
    );

    for (const node of nodes) {
      const element = node as HTMLElement;
      const label = [
        element.textContent ?? "",
        element.getAttribute("aria-label") ?? "",
        element.getAttribute("title") ?? "",
      ]
        .join(" ")
        .toLowerCase();

      if (!/read more|show more/.test(label)) {
        continue;
      }

      if (element.offsetParent === null) {
        continue;
      }

      element.click();
      return true;
    }

    return false;
  });
}

async function extractAvailabilitySnapshot(page: Page): Promise<{
  hasCalendarWidget: boolean;
  months: string[];
  items: Array<{ date: string; code: BenchmarkDayCode }>;
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

    const items: Array<{ date: string; code: BenchmarkDayCode }> = [];
    const monthHeaders: string[] = [];

    const groups = Array.from(
      document.querySelectorAll(
        ".ui-datepicker-group, .ui-datepicker-calendar, [class*='datepicker-group']",
      ),
    );

    const visited = new Set<Element>();
    for (const group of groups) {
      const container = group.matches(".ui-datepicker-group")
        ? group
        : (group.closest(".ui-datepicker-group") ?? group);

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
        container.querySelectorAll("td.day, td[class*='av-'], .day, td"),
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

        let code: BenchmarkDayCode = "X";
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
        /night available|night unavailable|arrive only|depart only|check-in only|check-out only|available|unavailable/i.test(
          row,
        ),
      );

    return {
      hasCalendarWidget: !!document.querySelector(
        ".ui-datepicker, .ui-datepicker-inline, .ui-datepicker-group, [class*='datepicker']",
      ),
      months: Array.from(new Set(monthHeaders)),
      items,
      bookingRestrictions: Array.from(new Set(keyText)).slice(0, 40),
    };
  });
}

async function extractDescriptionText(page: Page): Promise<string> {
  const readMoreClicked = await clickReadMore(page);
  if (readMoreClicked) {
    await page.waitForTimeout(600);
  }

  return page.evaluate(() => {
    const candidates: string[] = [];
    const selectors = [
      ".field-name-body",
      ".field-item",
      ".property-description",
      "[id*='description']",
      "[class*='description']",
      "main p",
    ];

    for (const selector of selectors) {
      for (const node of Array.from(document.querySelectorAll(selector))) {
        const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
        if (text.length < 80) {
          continue;
        }

        const lowered = text.toLowerCase();
        if (
          lowered.includes("availability") &&
          lowered.includes("calendar") &&
          lowered.length < 220
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
): Promise<BenchmarkDetailRecord | null> {
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
      };
    });

    const expanded = await page.evaluate(() => {
      const cleanText = (value: string | null | undefined): string =>
        (value ?? "").replace(/\s+/g, " ").trim();

      const parseNumber = (value: string): number | null => {
        const match = value.match(/\d+(?:\.\d+)?/);
        if (!match) {
          return null;
        }

        const parsed = Number(match[0]);
        return Number.isFinite(parsed) ? parsed : null;
      };

      const uniq = (values: string[]): string[] => {
        const seen = new Set<string>();
        const output: string[] = [];
        for (const value of values) {
          const normalized = cleanText(value);
          if (!normalized || seen.has(normalized)) {
            continue;
          }
          seen.add(normalized);
          output.push(normalized);
        }
        return output;
      };

      const bedsText = cleanText(
        document.querySelector(".rc-lodging-beds")?.textContent,
      );
      const bathsText = cleanText(
        document.querySelector(".rc-lodging-baths")?.textContent,
      );
      const sleepsText = cleanText(
        document.querySelector(".rc-lodging-occ")?.textContent,
      );

      const area = cleanText(
        document.querySelector(".field-name-rc-core-term-area")?.textContent,
      );
      const typeLabel = cleanText(
        document.querySelector(".field-name-rc-core-term-type")?.textContent,
      );
      const viewLabel = cleanText(
        document.querySelector(".field-name-rc-core-term-view")?.textContent,
      );

      const directionsUrlRaw =
        document
          .querySelector("a.vrweb-driving-directions")
          ?.getAttribute("href") ?? "";
      let directionsUrl = cleanText(directionsUrlRaw);
      let directionsDaddr = "";

      if (directionsUrl) {
        try {
          const parsedDirections = new URL(directionsUrl, window.location.href);
          directionsUrl = parsedDirections.toString();
          directionsDaddr = cleanText(
            parsedDirections.searchParams.get("daddr") ?? "",
          );
        } catch {
          // Keep raw value if URL parsing fails.
        }
      }

      const featuredAmenities = uniq(
        Array.from(
          document.querySelectorAll(
            ".group-vr-amenities-wrapper .item-list li",
          ),
        ).map((node) => cleanText(node.textContent)),
      );

      const categorizedAmenities: Record<string, string[]> = {};
      const amenityLists = Array.from(
        document.querySelectorAll(
          ".group-vr-property-amenities .item-list, .group-vr-amenities-wrapper .item-list",
        ),
      );

      for (const list of amenityLists) {
        const heading =
          cleanText(list.querySelector("h3")?.textContent) || "General";
        const items = uniq(
          Array.from(list.querySelectorAll("li")).map((li) =>
            cleanText(li.textContent),
          ),
        );
        if (items.length === 0) {
          continue;
        }

        const existing = categorizedAmenities[heading] ?? [];
        categorizedAmenities[heading] = uniq([...existing, ...items]);
      }

      if (featuredAmenities.length > 0) {
        const existing = categorizedAmenities.Featured ?? [];
        categorizedAmenities.Featured = uniq([
          ...existing,
          ...featuredAmenities,
        ]);
      }

      const allAmenities = uniq(
        Object.values(categorizedAmenities).flatMap((items) => items),
      );

      const toImageKey = (urlValue: string): string => {
        try {
          const parsed = new URL(urlValue, window.location.href);
          return `${parsed.origin}${parsed.pathname}`;
        } catch {
          return cleanText(urlValue).split(/[?#]/)[0] ?? "";
        }
      };

      const isLikelyPropertyImage = (urlValue: string): boolean => {
        const lower = urlValue.toLowerCase();
        if (!lower.startsWith("http")) {
          return false;
        }

        if (
          lower.includes("lazy-placeholder") ||
          lower.includes("bt_optimize/images") ||
          lower.startsWith("data:image")
        ) {
          return false;
        }

        return true;
      };

      const imageUrlMap = new Map<string, string>();
      const collectImageCandidates = (selector: string): string[] =>
        Array.from(document.querySelectorAll(selector)).flatMap((node) => [
          cleanText(node.getAttribute("data-src")),
          cleanText(node.getAttribute("data-lazy-src")),
          cleanText(node.getAttribute("data-original")),
          cleanText(node.getAttribute("src")),
        ]);

      const candidateImages = [
        ...collectImageCandidates(".bt-masonry-reveal-modal img"),
        ...collectImageCandidates(".group-vr-listing-images img"),
        cleanText(
          document
            .querySelector("meta[property='og:image']")
            ?.getAttribute("content"),
        ),
      ];

      for (const candidate of candidateImages) {
        if (!candidate || !isLikelyPropertyImage(candidate)) {
          continue;
        }

        const key = toImageKey(candidate);
        if (!key || imageUrlMap.has(key)) {
          continue;
        }

        imageUrlMap.set(key, candidate);
      }

      const imageUrls = Array.from(imageUrlMap.values());

      const locationLabel = [area, typeLabel, viewLabel]
        .filter(Boolean)
        .join(" | ");
      const address = directionsDaddr;

      return {
        beds: parseNumber(bedsText),
        baths: parseNumber(bathsText),
        sleeps: parseNumber(sleepsText),
        area,
        typeLabel,
        viewLabel,
        address,
        locationLabel,
        directionsUrl,
        directionsDaddr,
        amenities: {
          categories: categorizedAmenities,
          all: allAmenities,
        },
        mediaGallery: {
          image_count: imageUrls.length,
          image_urls: imageUrls,
        },
      };
    });

    const descriptionText = (await extractDescriptionText(page)).slice(
      0,
      15000,
    );

    const now = new Date();
    const todayIso = now.toISOString().slice(0, 10);
    const horizon = new Date(now);
    horizon.setUTCDate(horizon.getUTCDate() + availabilityHorizonDays);
    const horizonIso = horizon.toISOString().slice(0, 10);

    const html = await page.content();
    const quoteContext = extractBenchmarkQuoteContext(html, detailUrl);
    const embeddedAvailability = extractEmbeddedAvailability(
      html,
      todayIso,
      horizonIso,
    );

    const bookingRestrictions = new Set<string>();

    let normalizedDays: BenchmarkDetailRecord["normalized_availability"]["days"] =
      embeddedAvailability.days;
    const minNightRules: BenchmarkMinNightRule[] =
      embeddedAvailability.minNightRules;

    let calendarClicks = 0;
    let calendarIterations = 0;

    if (normalizedDays.length === 0) {
      const availabilityClicked = await clickAvailabilitySection(page);
      if (availabilityClicked) {
        await page.waitForTimeout(700);
      }

      const dayCodeByDate = new Map<string, BenchmarkDayCode>();
      const codePriority: Record<BenchmarkDayCode, number> = {
        X: 0,
        A: 1,
        U: 1,
        I: 2,
        O: 2,
      };
      const seenMonthSignatures = new Set<string>();
      let stagnantIterations = 0;

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
          if (!previous || codePriority[item.code] > codePriority[previous]) {
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
              "a.ui-datepicker-next, .ui-datepicker-next, button.next, a.next, [class*='datepicker'] [title*='Next' i], [class*='datepicker'] [aria-label*='Next' i], button[title*='Next' i], a[title*='Next' i], button[aria-label*='Next' i], a[aria-label*='Next' i]",
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

      normalizedDays = Array.from(dayCodeByDate.entries())
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([date, code]) => {
          const bookingDayState: "bookable" | "blocked" | "unknown" =
            code === "A" ? "bookable" : code === "U" ? "blocked" : "unknown";

          return {
            date,
            status_code: code,
            is_available: code === "A",
            is_available_for_checkin: code === "A" || code === "I",
            is_available_for_checkout: code === "A" || code === "O",
            booking_day_state: bookingDayState,
            min_nights_required: null,
          };
        });
    }

    const externalListingId = extractExternalListingId(detailUrl);
    const htmlPath = resolve(
      OUTPUT_DETAILS_HTML_DIR,
      `${externalListingId}.html`,
    );
    await writeFile(htmlPath, html, "utf8");

    const cleanTitle = stripHtml(extracted.h1 || extracted.title).slice(0, 240);
    const cleanDescription = stripHtml(
      descriptionText || extracted.metaDescription,
    ).slice(0, 15000);

    const normalizedMatchingProfile = {
      source: "pm_benchmark30a" as const,
      external_listing_id: externalListingId,
      name: cleanTitle,
      description: cleanDescription,
      match_signals: {
        description_normalized: normalizeForMatch(cleanDescription),
        description_sha256: hashSha256(normalizeForMatch(cleanDescription)),
        title_normalized: normalizeForMatch(cleanTitle),
        title_sha256: hashSha256(normalizeForMatch(cleanTitle)),
        listing_composite_key: hashSha256(
          `${externalListingId}|${normalizeForMatch(cleanTitle)}`,
        ),
      },
    };

    const extractionMs = Date.now() - beforeLoad - pageLoadMs;
    const totalMs = Date.now() - startedAt;

    const descriptionExpanded = cleanDescription;
    const propertyProfile: BenchmarkDetailRecord["property_profile"] = {
      unit_id: externalListingId,
      area: expanded.area,
      location: expanded.address || expanded.locationLabel,
      beds: expanded.beds,
      baths: expanded.baths,
      sleeps: expanded.sleeps,
      city: "",
      state: "",
    };

    const coordinates = extractLatLngFromHtml(html);
    const location: BenchmarkDetailRecord["location"] = {
      address: expanded.address,
      location_label: expanded.locationLabel,
      directions_url: expanded.directionsUrl,
      directions_daddr: expanded.directionsDaddr,
      latitude: coordinates.latitude,
      longitude: coordinates.longitude,
    };

    return {
      external_listing_id: externalListingId,
      detail_url: detailUrl,
      ...(quoteContext ? { quote_context: quoteContext } : {}),
      fetched_at: new Date().toISOString(),
      title: stripHtml(extracted.title).slice(0, 240),
      h1: stripHtml(extracted.h1).slice(0, 240),
      canonical_url: extracted.canonical || detailUrl,
      meta_description: stripHtml(extracted.metaDescription).slice(0, 2000),
      description_expanded: descriptionExpanded,
      rooms_guidance: false,
      amenities: expanded.amenities,
      location,
      media_gallery: expanded.mediaGallery,
      property_profile: propertyProfile,
      normalized_matching_profile: normalizedMatchingProfile,
      normalized_availability: {
        source: "pm_benchmark30a",
        external_listing_id: externalListingId,
        captured_at: new Date().toISOString(),
        has_calendar_widget: normalizedDays.length > 0,
        booking_restrictions: Array.from(bookingRestrictions),
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
    console.warn(
      `[benchmark30a] detail pull failed for ${detailUrl}: ${message}`,
    );
    return null;
  } finally {
    await page.close();
  }
}

function isValidDetailUrl(value: string): string | null {
  try {
    const parsed = new URL(value.trim());
    if (
      !parsed.hostname.endsWith("benchmark30a.com") ||
      !isLikelyDetailPath(parsed.pathname)
    ) {
      return null;
    }

    return normalizeDetailUrl(parsed.toString());
  } catch {
    return null;
  }
}

export function createBenchmark30AAdapter(): ScraperAdapter<BenchmarkDetailRecord> {
  return {
    managerKey: "benchmark30a",
    scriptLabel: "benchmark30a",
    defaultAnchorUrl: DEFAULT_ANCHOR_URL,
    detailFetchDelayMs: Math.max(
      0,
      Number(process.env.BENCHMARK30A_DETAIL_FETCH_DELAY_MS ?? "120") || 120,
    ),
    detailFetchConcurrency: Math.max(
      1,
      Number(process.env.BENCHMARK30A_DETAIL_FETCH_CONCURRENCY ?? "4") || 4,
    ),
    availabilityHorizonDays: Math.max(
      1,
      Number(process.env.BENCHMARK30A_AVAILABILITY_HORIZON_DAYS ?? "730") ||
        730,
    ),
    maxCalendarAdvanceMonths: Math.max(
      8,
      Number(process.env.BENCHMARK30A_CALENDAR_MAX_MONTHS ?? "26") || 26,
    ),
    isValidDetailUrl,
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
        "benchmark30a",
        argv,
      );
      await runRuntimeAdapterQuoteCli(
        {
          adapterKey: "benchmark30a",
          executeSingleQuote: executeBenchmark30aSingleQuote,
          defaultQuoteTimeoutMs: 20000,
          defaultQuoteMaxAttempts: 1,
          defaultEndpointPath: "/rcapi/item/avail/search",
          defaultTaxPct: 0.12,
          defaultBaseNightly: 650,
        },
        normalizedArgs,
        progress,
      );
    },
    async runSingleQuoteObservation(input) {
      const result = await executeBenchmark30aSingleQuote({
        listingId: input.listingId,
        checkInIso: input.checkInIso,
        checkOutIso: input.checkOutIso,
        adults: input.adults,
        children: input.children,
        quoteContext: input.quoteContext ?? null,
        options: {
          timeoutMs: Number(process.env.BENCHMARK30A_QUOTE_TIMEOUT_MS ?? 20000),
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
          handoffUrl: input.handoffUrl ?? null,
          reason: result.error.code,
        },
      };
    },
  };
}
