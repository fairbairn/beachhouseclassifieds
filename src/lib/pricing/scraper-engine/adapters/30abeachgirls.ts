import { execute30ABeachGirlsSingleQuote } from "@/lib/pricing/quote-runtime/adapters/30abeachgirls";
import { runRuntimeAdapterQuoteCli } from "@/lib/pricing/quotes/shared/runtime-adapter-quote-runner";
import { canonicalizeExternalListingId } from "@/lib/pricing/shared/external-listing-id";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  createDiscoveryLogger,
  resolveAdapterRuntime,
} from "../adapter-foundation";
import { normalizeAdapterQuoteScopeArgs } from "../quote-scope";
import type { DetailRecordBase, ScrapedLink, ScraperAdapter } from "../types";

type BeachGirlsDayCode = "Y" | "N";
type BeachGirlsStatusCode = "A" | "U" | "I" | "O" | "X";

type BeachGirlsDetailRecord = DetailRecordBase & {
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
  quote_context: {
    source: "next_data";
    listing_id: string;
    home_id: string;
    hash: string;
    detail_url: string;
  };
  normalized_matching_profile: {
    source: "pm_30abeachgirls";
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
    source: "pm_30abeachgirls";
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
      day_code: BeachGirlsDayCode;
      is_available: boolean;
      status_code: BeachGirlsStatusCode;
      changeover_code: "C" | "I" | "O" | "X";
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
    source: "graphql.home.calendar";
    from: string;
    until: string;
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
};

type HomeCalendarDay = {
  date?: unknown;
  status?: unknown;
  minStay?: unknown;
  restrictions?: {
    checkInAllowed?: unknown;
    checkOutAllowed?: unknown;
  };
};

const DEFAULT_ANCHOR_URL = "https://www.30a-beachgirls.com/vacation-rentals";
const OUTPUT_ROOT = resolve(
  process.cwd(),
  "src",
  "lib",
  "data",
  "external-sources",
  "30abeachgirls",
);
const OUTPUT_DETAILS_HTML_DIR = resolve(OUTPUT_ROOT, "details", "html");
const GRAPHQL_ENDPOINT = "https://arriere.prod.avantstay.com/public/graphql";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function normalizeLink(url: string): string {
  return url.split("#")[0]?.replace(/\/$/, "") ?? url;
}

function stripHtml(value: string): string {
  return value
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#039;/gi, "'")
    .replace(/&rsquo;/gi, "'")
    .replace(/&ldquo;|&rdquo;/gi, '"')
    .replace(/&ndash;|&mdash;/gi, "-")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
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

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
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

function toIsoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function addDays(value: Date, days: number): Date {
  const out = new Date(value.getTime());
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

function extractMetaContent(html: string, name: string): string {
  const safeName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `<meta[^>]+(?:name|property)=["']${safeName}["'][^>]+content=["']([^"']*)["'][^>]*>`,
    "i",
  );
  const match = html.match(pattern);
  return match?.[1]?.trim() ?? "";
}

function extractCanonicalUrl(html: string): string {
  const match = html.match(
    /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["'][^>]*>/i,
  );
  return match?.[1]?.trim() ?? "";
}

function extractNextDataJson(html: string): Record<string, unknown> | null {
  const match = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/i,
  );
  if (!match) {
    return null;
  }

  try {
    return JSON.parse(match[1]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function buildDetailUrl(hash: string): string {
  return `https://www.30a-beachgirls.com/vacation-rental/${encodeURIComponent(hash)}?adults=1&guests=0`;
}

function isValidDetailPath(pathname: string): boolean {
  return /^\/vacation-rental\/[^/]+$/i.test(pathname.replace(/\/+$/, ""));
}

function normalizeDayStatus(status: string): BeachGirlsStatusCode {
  switch (status) {
    case "VACANT":
      return "A";
    case "CHECK_IN":
      return "I";
    case "CHECK_OUT":
      return "O";
    case "CHECK_OUT_AND_CHECK_IN":
      return "A";
    case "OCCUPIED":
      return "U";
    default:
      return "X";
  }
}

function normalizeChangeoverCode(
  statusCode: BeachGirlsStatusCode,
): "C" | "I" | "O" | "X" {
  if (statusCode === "I") {
    return "I";
  }
  if (statusCode === "O") {
    return "O";
  }
  if (statusCode === "A") {
    return "C";
  }
  return "X";
}

type NormalizedAvailabilityDay =
  BeachGirlsDetailRecord["normalized_availability"]["days"][number];

function applyBoundaryTurnDayStatuses(
  days: NormalizedAvailabilityDay[],
): NormalizedAvailabilityDay[] {
  const nextDays = days.map((day) => ({ ...day }));

  // Mark trailing edge of availability runs as checkout-only.
  for (let index = 1; index < nextDays.length; index += 1) {
    const previous = nextDays[index - 1];
    const current = nextDays[index];
    if (previous.status_code === "A" && current.status_code === "U") {
      previous.status_code = "O";
      previous.day_code = "Y";
      previous.is_available = true;
      previous.changeover_code = "O";
    }
  }

  // Mark leading edge of availability runs as checkin-only.
  for (let index = 1; index < nextDays.length; index += 1) {
    const previous = nextDays[index - 1];
    const current = nextDays[index];
    if (previous.status_code === "U" && current.status_code === "A") {
      current.status_code = "I";
      current.day_code = "N";
      current.is_available = false;
      current.changeover_code = "I";
    }
  }

  return nextDays;
}

function normalizeMediaUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return trimmed;
  }

  if (parsed.hostname.toLowerCase() === "imglite.avantstay.com") {
    const encoded = parsed.pathname.replace(/^\//, "");
    try {
      const decoded = decodeURIComponent(encoded);
      const nested = new URL(decoded);
      nested.search = "";
      nested.hash = "";
      return nested.toString();
    } catch {
      return trimmed;
    }
  }

  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function extractImagePatternKey(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return value;
  }

  const parts = parsed.pathname.split("/").filter((part) => part.length > 0);

  if (parts.length >= 3) {
    return `${parsed.hostname.toLowerCase()}/${parts[0]}/${parts[1]}/${parts[2]}`;
  }

  return `${parsed.hostname.toLowerCase()}/${parts.join("/")}`;
}

function keepDominantImagePattern(urls: string[]): string[] {
  if (urls.length <= 1) {
    return urls;
  }

  const counts = new Map<string, number>();
  const firstSeen = new Map<string, number>();

  for (let index = 0; index < urls.length; index += 1) {
    const key = extractImagePatternKey(urls[index]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (!firstSeen.has(key)) {
      firstSeen.set(key, index);
    }
  }

  let dominantKey = "";
  let dominantCount = -1;
  let dominantFirstIndex = Number.POSITIVE_INFINITY;

  for (const [key, count] of counts) {
    const seenAt = firstSeen.get(key) ?? Number.POSITIVE_INFINITY;
    if (
      count > dominantCount ||
      (count === dominantCount && seenAt < dominantFirstIndex)
    ) {
      dominantKey = key;
      dominantCount = count;
      dominantFirstIndex = seenAt;
    }
  }

  if (!dominantKey) {
    return urls;
  }

  return urls.filter((url) => extractImagePatternKey(url) === dominantKey);
}

function keepHomeScopedImages(urls: string[], homeId: string): string[] {
  const normalizedHomeId = homeId.trim();
  if (!normalizedHomeId) {
    return urls;
  }

  const normalizedHomeIdLower = normalizedHomeId.toLowerCase();

  const extractHomeScopedId = (url: string): string | null => {
    try {
      const parsed = new URL(url);
      const lower = parsed.pathname.toLowerCase();
      const homeMatch = lower.match(/\/homes\/([^/]+)\//);
      if (homeMatch?.[1]) {
        return homeMatch[1];
      }
      const assetsMatch = lower.match(/\/assets\/home\/([^/]+)\//);
      if (assetsMatch?.[1]) {
        return assetsMatch[1];
      }
      return null;
    } catch {
      return null;
    }
  };

  const allHomeScoped = urls.filter((url) => extractHomeScopedId(url) !== null);

  const scoped = urls.filter((url) => {
    const scopedId = extractHomeScopedId(url);
    return scopedId === normalizedHomeIdLower;
  });

  if (allHomeScoped.length > 0) {
    const scopedIds = new Set(
      allHomeScoped
        .map((url) => extractHomeScopedId(url))
        .filter((value): value is string => value !== null),
    );

    const primaryCoverageThreshold = Math.max(
      10,
      Math.floor(allHomeScoped.length * 0.5),
    );

    // Combined listings can carry images for multiple home IDs in one gallery.
    if (scopedIds.size > 1 && scoped.length < primaryCoverageThreshold) {
      return allHomeScoped;
    }
  }

  return scoped.length > 0 ? scoped : urls;
}

async function fetchHomeCalendar(input: {
  homeId: string;
  horizonDays: number;
}): Promise<{ from: string; until: string; days: HomeCalendarDay[] }> {
  const fromDate = toIsoDate(new Date());
  const untilDate = toIsoDate(addDays(new Date(), input.horizonDays));

  const query =
    "query($id: UUID!, $from: LocalDate!, $to: LocalDate!){ home(homeId:$id){ calendar(from:$from,to:$to){ date status minStay restrictions { checkInAllowed checkOutAllowed } } } }";

  const response = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": USER_AGENT,
    },
    body: JSON.stringify({
      query,
      variables: { id: input.homeId, from: fromDate, to: untilDate },
    }),
  });

  if (!response.ok) {
    return { from: fromDate, until: untilDate, days: [] };
  }

  const payload = (await response.json()) as {
    data?: { home?: { calendar?: HomeCalendarDay[] } };
  };

  return {
    from: fromDate,
    until: untilDate,
    days: Array.isArray(payload.data?.home?.calendar)
      ? payload.data?.home?.calendar
      : [],
  };
}

export function create30ABeachGirlsAdapter(): ScraperAdapter<BeachGirlsDetailRecord> {
  const runtime = resolveAdapterRuntime({
    managerKey: "30abeachgirls",
    defaults: {
      detailFetchDelayMs: 250,
      detailFetchConcurrency: 5,
      availabilityHorizonDays: 365,
      maxCalendarAdvanceMonths: 12,
    },
  });

  return {
    managerKey: "30abeachgirls",
    scriptLabel: "30abeachgirls",
    defaultAnchorUrl: DEFAULT_ANCHOR_URL,
    detailFetchDelayMs: runtime.detailFetchDelayMs,
    detailFetchConcurrency: runtime.detailFetchConcurrency,
    availabilityHorizonDays: runtime.availabilityHorizonDays,
    maxCalendarAdvanceMonths: runtime.maxCalendarAdvanceMonths,

    isValidDetailUrl(value: string): string | null {
      try {
        const parsed = new URL(value.trim());
        const host = parsed.hostname.toLowerCase();
        if (
          host !== "www.30a-beachgirls.com" &&
          host !== "30a-beachgirls.com"
        ) {
          return null;
        }

        const pathname = parsed.pathname.replace(/\/+$/, "");
        if (!isValidDetailPath(pathname)) {
          return null;
        }

        const hash = pathname.split("/").pop() ?? "";
        if (!hash) {
          return null;
        }

        return normalizeLink(buildDetailUrl(hash));
      } catch {
        return null;
      }
    },

    async discoverListings(context) {
      const logger = createDiscoveryLogger(context.reportProgress);
      const discovered = new Map<string, ScrapedLink>();
      const maxStagnantRounds = 6;
      const settleChecksPerRound = 3;
      let stagnantRounds = 0;

      const collectAnchorCandidates = async () =>
        context.page.evaluate(() => {
          const anchors = Array.from(document.querySelectorAll("a[href]"));
          return anchors.map((anchor) => {
            const href = anchor.getAttribute("href") ?? "";
            const text = anchor.textContent?.replace(/\s+/g, " ").trim() ?? "";
            return { href, text };
          });
        });

      const ingestCandidates = (
        candidates: Array<{ href: string; text: string }>,
      ): boolean => {
        let grew = false;
        for (const candidate of candidates) {
          const rawHref = candidate.href?.trim();
          if (!rawHref) {
            continue;
          }

          let absolute: string;
          try {
            absolute = new URL(rawHref, context.anchorUrl).toString();
          } catch {
            continue;
          }

          const valid = this.isValidDetailUrl(absolute);
          if (!valid || discovered.has(valid)) {
            continue;
          }

          discovered.set(valid, {
            link: valid,
            source_url: context.anchorUrl,
            anchor_text: candidate.text || "View property",
          });
          grew = true;
        }

        return grew;
      };

      await context.page.goto(context.anchorUrl, {
        waitUntil: "domcontentloaded",
      });

      for (
        let step = 0;
        step < Math.max(1, context.maxScrollSteps);
        step += 1
      ) {
        const links = await collectAnchorCandidates();
        let grew = ingestCandidates(links);

        if (!grew) {
          for (
            let settleRound = 0;
            settleRound < settleChecksPerRound;
            settleRound += 1
          ) {
            await context.page.waitForTimeout(
              Math.max(120, Math.floor(context.scrollPauseMs * 0.45)),
            );
            const settleLinks = await collectAnchorCandidates();
            grew = ingestCandidates(settleLinks);
            if (grew) {
              break;
            }
          }
        }

        logger.progress({
          stage: "scroll",
          step: step + 1,
          maxSteps: Math.max(1, context.maxScrollSteps),
          discovered: discovered.size,
          noGrowthRounds: stagnantRounds,
        });

        if (!grew) {
          stagnantRounds += 1;
          if (stagnantRounds >= maxStagnantRounds) {
            logger.earlyStop({
              reason: "stagnant-discovery-count",
              discovered: discovered.size,
              step: step + 1,
              maxSteps: Math.max(1, context.maxScrollSteps),
            });
            break;
          }
        } else {
          stagnantRounds = 0;
        }

        await context.page.evaluate(() => {
          const delta = Math.max(window.innerHeight * 0.95, 900);
          window.scrollBy(0, delta);
          window.scrollTo(0, document.body.scrollHeight);

          const candidates = Array.from(
            document.querySelectorAll("*"),
          ) as HTMLElement[];
          let best: HTMLElement | null = null;
          let bestOverflow = 0;

          for (const node of candidates) {
            const overflow = node.scrollHeight - node.clientHeight;
            if (overflow <= 0 || overflow <= bestOverflow) {
              continue;
            }
            best = node;
            bestOverflow = overflow;
          }

          if (best) {
            best.scrollTop = Math.min(
              best.scrollTop + delta,
              best.scrollHeight,
            );
          }
        });

        const delayMs = !grew
          ? Math.max(120, Math.floor(context.scrollPauseMs * 0.5))
          : Math.max(50, context.scrollPauseMs);
        await context.page.waitForTimeout(delayMs);
      }

      const selected = Array.from(discovered.values());
      logger.summary({
        selected: selected.length,
        bySource: { dom: selected.length },
      });
      return selected;
    },

    async fetchDetail(context) {
      void context.browser;
      const detailUrl = context.detailUrl;

      let response: Response;
      try {
        response = await fetch(detailUrl, {
          headers: {
            "user-agent": USER_AGENT,
            accept: "text/html,application/xhtml+xml",
          },
        });
      } catch {
        return null;
      }

      if (!response.ok) {
        return null;
      }

      const html = await response.text();
      const nextData = extractNextDataJson(html);
      const pageProps =
        nextData &&
        typeof nextData.props === "object" &&
        nextData.props &&
        typeof (nextData.props as Record<string, unknown>).pageProps ===
          "object"
          ? ((nextData.props as Record<string, unknown>).pageProps as Record<
              string,
              unknown
            >)
          : null;

      const homeDetails =
        pageProps && typeof pageProps.homeDetails === "object"
          ? (pageProps.homeDetails as Record<string, unknown>)
          : null;

      if (!homeDetails) {
        return null;
      }

      const homeId = asString(homeDetails.id);
      const hash = asString(homeDetails.hash);
      const title = asString(homeDetails.title);
      if (!homeId || !hash || !title) {
        return null;
      }

      const canonicalUrl = extractCanonicalUrl(html) || detailUrl;
      const externalListingId = canonicalizeExternalListingId(hash);
      const description = stripHtml(asString(homeDetails.description));
      const normalizedDescription = normalizeForMatch(description);
      const normalizedTitle = normalizeForMatch(title);

      const amenitiesList = Array.isArray(pageProps?.amenities)
        ? (pageProps.amenities as Array<Record<string, unknown>>)
        : [];
      const amenityGroups = Array.isArray(pageProps?.amenityGroups)
        ? (pageProps.amenityGroups as Array<Record<string, unknown>>)
        : [];

      const categories: Record<string, string[]> = {};
      for (const group of amenityGroups) {
        const groupName = asOptionalString(group.name) ?? "Other";
        const items = Array.isArray(group.amenities)
          ? (group.amenities as Array<Record<string, unknown>>)
          : [];
        categories[groupName] = dedupePreserveOrder(
          items
            .map((item) => asOptionalString(item.name) ?? "")
            .filter((item) => item.length > 0),
        );
      }

      const amenitiesAll = dedupePreserveOrder(
        amenitiesList
          .map((item) => asOptionalString(item.name) ?? "")
          .filter((item) => item.length > 0),
      );

      const rooms = Array.isArray(homeDetails.rooms)
        ? (homeDetails.rooms as Array<Record<string, unknown>>)
        : [];
      const roomsGuidance = dedupePreserveOrder(
        rooms
          .map((room) => {
            const roomName = asOptionalString(room.name);
            const sleepingPlaces = Array.isArray(room.sleepingPlaces)
              ? (room.sleepingPlaces as Array<Record<string, unknown>>)
              : [];

            const parts = sleepingPlaces
              .map((place) => {
                const bedName = asOptionalString(place.name);
                const quantity = parseNumberLike(place.quantity);
                if (!bedName) {
                  return null;
                }
                if (quantity && quantity > 1) {
                  return `${quantity}x ${bedName}`;
                }
                return bedName;
              })
              .filter((value): value is string => value !== null);

            if (!roomName) {
              return parts.join(", ");
            }

            if (!parts.length) {
              return roomName;
            }

            return `${roomName}: ${parts.join(", ")}`;
          })
          .filter((value) => value.length > 0),
      );

      const imageUrls = keepHomeScopedImages(
        dedupePreserveOrder(
          (Array.isArray(homeDetails.images)
            ? (homeDetails.images as Array<Record<string, unknown>>)
            : []
          )
            .map((img) => asOptionalString(img.url) ?? "")
            .map((url) => normalizeMediaUrl(url))
            .filter((url) => url.length > 0),
        ),
        homeId,
      );

      const latitude = parseNumberLike(homeDetails.latitude);
      const longitude = parseNumberLike(homeDetails.longitude);
      const city = asString(homeDetails.city);
      const stateObj =
        homeDetails.state && typeof homeDetails.state === "object"
          ? (homeDetails.state as Record<string, unknown>)
          : null;
      const stateCode = asOptionalString(stateObj?.code) ?? "";
      const stateName = asOptionalString(stateObj?.name) ?? "";
      const state = stateCode || stateName;
      const locationLabel = [city, state].filter((v) => v).join(", ");

      const fetchedAt = new Date().toISOString();
      const htmlPath = resolve(
        OUTPUT_DETAILS_HTML_DIR,
        `${externalListingId}.html`,
      );
      await writeFile(htmlPath, html, "utf8");

      const calendar = await fetchHomeCalendar({
        homeId,
        horizonDays: context.availabilityHorizonDays,
      });

      const rawNormalizedDays: BeachGirlsDetailRecord["normalized_availability"]["days"] =
        calendar.days.map((day) => {
          const date = asString(day.date);
          const rawStatus = asString(day.status).toUpperCase();
          const statusCode = normalizeDayStatus(rawStatus);
          const dayCode: BeachGirlsDayCode =
            statusCode === "A" || statusCode === "O" ? "Y" : "N";
          const checkInAllowed =
            day.restrictions?.checkInAllowed === true && statusCode !== "U";
          const checkOutAllowed =
            day.restrictions?.checkOutAllowed === true && statusCode !== "U";
          const minStay = parseNumberLike(day.minStay);

          return {
            date,
            day_code: dayCode,
            is_available: statusCode === "A" || statusCode === "O",
            status_code: statusCode,
            changeover_code: normalizeChangeoverCode(statusCode),
            is_available_for_checkin: checkInAllowed,
            is_available_for_checkout: checkOutAllowed,
            booking_day_state: checkInAllowed
              ? "bookable"
              : statusCode === "X"
                ? "unknown"
                : "blocked",
            min_nights_required:
              minStay !== null && Number.isFinite(minStay) ? minStay : null,
          };
        });

      const normalizedDays = applyBoundaryTurnDayStatuses(rawNormalizedDays);

      const counts = normalizedDays.reduce(
        (acc, day) => {
          if (day.status_code === "A") {
            acc.available += 1;
          } else if (day.status_code === "U") {
            acc.unavailable += 1;
          } else if (day.status_code === "I") {
            acc.checkin_only += 1;
          } else if (day.status_code === "O") {
            acc.checkout_only += 1;
          } else {
            acc.other += 1;
          }

          if (day.booking_day_state === "bookable") {
            acc.booking_available += 1;
          } else if (day.booking_day_state === "blocked") {
            acc.booking_unavailable += 1;
          } else {
            acc.booking_unknown += 1;
          }

          return acc;
        },
        {
          available: 0,
          unavailable: 0,
          checkin_only: 0,
          checkout_only: 0,
          other: 0,
          booking_available: 0,
          booking_unavailable: 0,
          booking_unknown: 0,
        },
      );

      const dayCodes = normalizedDays.map((day) => day.day_code).join("");

      return {
        external_listing_id: externalListingId,
        detail_url: buildDetailUrl(hash),
        fetched_at: fetchedAt,
        html_path: htmlPath,
        title,
        h1: title,
        canonical_url: canonicalUrl,
        meta_description: extractMetaContent(html, "description"),
        description_expanded: description,
        rooms_guidance: roomsGuidance,
        amenities: {
          categories,
          all: amenitiesAll,
        },
        location: {
          address: "",
          location_label: locationLabel,
          directions_url:
            latitude !== null && longitude !== null
              ? `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`
              : "",
          directions_daddr:
            latitude !== null && longitude !== null
              ? `${latitude},${longitude}`
              : "",
          latitude,
          longitude,
        },
        media_gallery: {
          image_count: imageUrls.length,
          image_urls: imageUrls,
        },
        quote_context: {
          source: "next_data",
          listing_id: hash,
          home_id: homeId,
          hash,
          detail_url: buildDetailUrl(hash),
        },
        normalized_matching_profile: {
          source: "pm_30abeachgirls",
          external_listing_id: externalListingId,
          name: title,
          description,
          match_signals: {
            description_normalized: normalizedDescription,
            description_sha256: hashSha256(normalizedDescription),
            title_normalized: normalizedTitle,
            title_sha256: hashSha256(normalizedTitle),
            listing_composite_key: hashSha256(
              `${externalListingId}::${normalizeForMatch(locationLabel)}`,
            ),
          },
        },
        normalized_availability: {
          source: "pm_30abeachgirls",
          external_listing_id: externalListingId,
          captured_at: fetchedAt,
          window_start: normalizedDays[0]?.date ?? calendar.from,
          window_end:
            normalizedDays[normalizedDays.length - 1]?.date ?? calendar.until,
          code_legend: {
            A: "available",
            U: "unavailable",
            I: "checkin_only",
            O: "checkout_only",
            X: "other",
          },
          day_codes: dayCodes,
          days: normalizedDays,
          counts,
        },
        availability_raw: {
          source: "graphql.home.calendar",
          from: calendar.from,
          until: calendar.until,
        },
        property_profile: {
          unit_id: hash,
          area: asOptionalString(homeDetails.area)?.toString() ?? "",
          location: locationLabel,
          beds: parseNumberLike(homeDetails.bedsCount),
          baths:
            parseNumberLike(homeDetails.bathroomsCount) ??
            parseNumberLike(homeDetails.halfBathroomsCount),
          sleeps: parseNumberLike(homeDetails.maxOccupancy),
          city,
          state,
        },
      };
    },

    async runQuoteCapture(argv, progress) {
      const normalizedArgs = await normalizeAdapterQuoteScopeArgs(
        "30abeachgirls",
        argv,
      );
      await runRuntimeAdapterQuoteCli(
        {
          adapterKey: "30abeachgirls",
          executeSingleQuote: execute30ABeachGirlsSingleQuote,
          defaultQuoteTimeoutMs: 20000,
          defaultQuoteMaxAttempts: 2,
          defaultEndpointPath: "/public/graphql",
          defaultTaxPct: 0.12,
          defaultBaseNightly: 550,
        },
        normalizedArgs,
        progress,
      );
    },

    async runSingleQuoteObservation(input) {
      const result = await execute30ABeachGirlsSingleQuote({
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
