import { execute30AFivestarSingleQuote } from "@/lib/pricing/quote-runtime/adapters/30afivestar";
import { runRuntimeAdapterQuoteCli } from "@/lib/pricing/quotes/shared/runtime-adapter-quote-runner";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  canonicalizeExternalListingId,
  externalListingIdFromDetailUrl,
} from "@/lib/pricing/shared/external-listing-id";
import { normalizeAdapterQuoteScopeArgs } from "../quote-scope";
import type { DetailRecordBase, ScrapedLink, ScraperAdapter } from "../types";

type FiveStarDayCode = "A" | "U" | "I" | "O" | "X";
type CanonicalDayCode = "Y" | "N";
type CanonicalChangeoverCode = "C" | "I" | "O" | "X";

type ThirtyAFiveStarDetailRecord = DetailRecordBase & {
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
  quote_context: {
    source: "ownerrez_widget";
    property_key: string | null;
    widget_key: string | null;
    detail_url: string;
    property_public_id: string | null;
  };
  normalized_matching_profile: {
    source: "pm_30afivestar";
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
    source: "pm_30afivestar";
    external_listing_id: string;
    captured_at: string;
    availability_source:
      | "listing_calendar"
      | "widget_calendar"
      | "fallback_unavailable";
    has_calendar_widget: boolean;
    calendar_bounds: {
      min_day_key: string | null;
      max_day_key: string | null;
    };
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
      day_code: CanonicalDayCode;
      status_code: FiveStarDayCode;
      changeover_code: CanonicalChangeoverCode;
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
};

const DEFAULT_ANCHOR_URL = "https://www.30afivestarproperties.com/properties";
const HOST = "www.30afivestarproperties.com";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const OUTPUT_ROOT = resolve(
  process.cwd(),
  "src",
  "lib",
  "data",
  "external-sources",
  "30afivestar",
);
const OUTPUT_DETAILS_HTML_DIR = resolve(OUTPUT_ROOT, "details", "html");

const EXCLUDED_MEDIA_URL_LIST = [
  "https://uc.orez.io/i/80d34a51969b4f338f7e4e6424f21f50-Large",
  "https://uc.orez.io/i/eebf52c824e84603a2625442a7cafdbd-Large",
  "https://uc.orez.io/i/472853652dff433fa6fb94a0b1bcd20e-Large",
  "https://uc.orez.io/i/44695a172d5d433e9da9d8388617c762-Large",
  "https://uc.orez.io/i/15b0bd18ed5548fa922cac97d296c63a-Large",
  "https://uc.orez.io/i/79b947323776435baf96157bf94712ec-LargeOriginal",
  "https://uc.orez.io/i/8172969bc4cf4f7d840a77e2e9ff9e34-LargeOriginal",
  "https://uc.orez.io/i/7a679454a0354697905fb7bf028ed31d-Large",
  "https://uc.orez.io/f/351cb9f1a3fd4732b3a689c88d7ae0af",
  "https://uc.orez.io/f/bcfccc689c26406994ca141c42817d41",
  "https://uc.orez.io/f/77c4a2c6c4b14e988c23bfae0260a9d6",
  "https://uc.orez.io/f/f94ef61db30245d69c9e254d8fe3ddc2",
  "https://uc.orez.io/f/18b8f41f04e548ae944549f50a66320d",
] as const;

const EXCLUDED_MEDIA_URLS = new Set(
  EXCLUDED_MEDIA_URL_LIST.map((url) => url.toLowerCase()),
);
const THIRTYAFIVESTAR_OWNERREZ_QUOTE_PATH = "/widgets/quote";

const EXCLUDED_MEDIA_BASE_KEYS = new Set(
  EXCLUDED_MEDIA_URL_LIST.map((url) => normalizeMediaUrl(url))
    .filter((url): url is string => Boolean(url))
    .map((url) => imageBaseKey(url))
    .filter((base): base is string => Boolean(base)),
);

function normalizeLink(url: string): string {
  try {
    const parsed = new URL(url.trim());
    parsed.hash = "";
    if (parsed.pathname.length > 1) {
      parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    }
    return parsed.toString();
  } catch {
    return url.trim();
  }
}

function normalizeDetailUrl(value: string): string | null {
  try {
    const parsed = new URL(value.trim());
    if (parsed.hostname.toLowerCase() !== HOST) {
      return null;
    }

    if (parsed.pathname === "/" || parsed.pathname === "/properties") {
      return null;
    }

    const leaf = parsed.pathname.split("/").filter(Boolean).pop() ?? "";
    if (!/-orp[0-9a-z]+x$/i.test(leaf)) {
      return null;
    }

    parsed.search = "";
    parsed.hash = "";
    return normalizeLink(parsed.toString());
  } catch {
    return null;
  }
}

function stripHtml(value: string): string {
  return value
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&ndash;/g, "-")
    .replace(/&mdash;/g, "-")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function extractFirst(regex: RegExp, value: string): string {
  const match = value.match(regex);
  if (!match?.[1]) {
    return "";
  }
  return decodeEntities(stripHtml(match[1]));
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

function dedupePreserveOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function parseNumberLike(value: string): number | null {
  const numeric = Number(value.trim());
  return Number.isFinite(numeric) ? numeric : null;
}

function parseCoordinateLike(
  value: string | undefined,
  axis: "lat" | "lng",
): number | null {
  if (!value) {
    return null;
  }
  const parsed = parseNumberLike(value);
  if (parsed === null) {
    return null;
  }
  if (axis === "lat") {
    return parsed >= -90 && parsed <= 90 ? parsed : null;
  }
  return parsed >= -180 && parsed <= 180 ? parsed : null;
}

function toDashedUuid(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(normalized)) {
    return null;
  }
  return [
    normalized.slice(0, 8),
    normalized.slice(8, 12),
    normalized.slice(12, 16),
    normalized.slice(16, 20),
    normalized.slice(20),
  ].join("-");
}

function extractJsonLdObjects(html: string): unknown[] {
  const blocks = html.match(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi,
  );
  if (!blocks) {
    return [];
  }

  const out: unknown[] = [];
  for (const block of blocks) {
    const jsonText = block
      .replace(/^[\s\S]*?>/, "")
      .replace(/<\/script>[\s\S]*$/i, "")
      .trim();
    if (!jsonText) {
      continue;
    }

    try {
      const parsed = JSON.parse(jsonText) as unknown;
      if (Array.isArray(parsed)) {
        out.push(...parsed);
      } else {
        out.push(parsed);
      }
    } catch {
      // ignore malformed json-ld blocks
    }
  }

  return out;
}

function flattenJsonLdEntities(
  input: unknown[],
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const stack: unknown[] = [...input];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }

    if (typeof current !== "object") {
      continue;
    }

    const obj = current as Record<string, unknown>;
    out.push(obj);

    if (Array.isArray(obj["@graph"])) {
      stack.push(...(obj["@graph"] as unknown[]));
    }
  }

  return out;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function firstFiniteNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = asFiniteNumber(value);
    if (parsed !== null) {
      return parsed;
    }
  }
  return null;
}

function extractSchemaPropertyProfile(input: unknown[]): {
  name: string;
  description: string;
  additionalType: string;
  beds: number | null;
  baths: number | null;
  sleeps: number | null;
  roomCount: number | null;
  bedDetails: Array<{ numberOfBeds: number | null; typeOfBed: string }>;
} {
  const entities = flattenJsonLdEntities(input);

  let best: Record<string, unknown> | null = null;
  for (const entity of entities) {
    const typeValue = entity["@type"];
    const typeList = Array.isArray(typeValue)
      ? typeValue
      : typeof typeValue === "string"
        ? [typeValue]
        : [];
    const loweredTypes = typeList.map((item) => String(item).toLowerCase());
    if (loweredTypes.includes("vacationrental")) {
      best = entity;
      break;
    }
  }

  if (!best) {
    for (const entity of entities) {
      if (
        typeof entity.name === "string" ||
        typeof entity.description === "string" ||
        entity.containsPlace
      ) {
        best = entity;
        break;
      }
    }
  }

  if (!best) {
    return {
      name: "",
      description: "",
      additionalType: "",
      beds: null,
      baths: null,
      sleeps: null,
      roomCount: null,
      bedDetails: [],
    };
  }

  const containsPlace =
    best.containsPlace && typeof best.containsPlace === "object"
      ? (best.containsPlace as Record<string, unknown>)
      : null;
  const occupancy =
    containsPlace?.occupancy && typeof containsPlace.occupancy === "object"
      ? (containsPlace.occupancy as Record<string, unknown>)
      : best.occupancy && typeof best.occupancy === "object"
        ? (best.occupancy as Record<string, unknown>)
        : null;

  const bedRaw = containsPlace?.bed ?? best.bed ?? ([] as unknown[]);
  const bedArray = Array.isArray(bedRaw) ? bedRaw : [];
  const bedDetails: Array<{ numberOfBeds: number | null; typeOfBed: string }> =
    [];
  for (const item of bedArray) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const detail = item as Record<string, unknown>;
    const numberOfBeds = firstFiniteNumber(detail.numberOfBeds);
    const typeOfBed =
      typeof detail.typeOfBed === "string" ? detail.typeOfBed.trim() : "";
    if (numberOfBeds !== null || typeOfBed) {
      bedDetails.push({ numberOfBeds, typeOfBed });
    }
  }

  return {
    name: typeof best.name === "string" ? best.name.trim() : "",
    description:
      typeof best.description === "string" ? best.description.trim() : "",
    additionalType:
      typeof best.additionalType === "string" ? best.additionalType.trim() : "",
    beds: firstFiniteNumber(
      containsPlace?.numberOfBedrooms,
      best.numberOfBedrooms,
    ),
    baths: firstFiniteNumber(
      containsPlace?.numberOfBathroomsTotal,
      best.numberOfBathroomsTotal,
    ),
    sleeps: firstFiniteNumber(occupancy?.value),
    roomCount: firstFiniteNumber(
      containsPlace?.numberOfRooms,
      best.numberOfRooms,
    ),
    bedDetails,
  };
}

function extractSchemaImageUrls(input: unknown[]): string[] {
  const entities = flattenJsonLdEntities(input);

  let imageRaw: unknown = null;
  for (const entity of entities) {
    const typeValue = entity["@type"];
    const typeList = Array.isArray(typeValue)
      ? typeValue
      : typeof typeValue === "string"
        ? [typeValue]
        : [];
    const loweredTypes = typeList.map((item) => String(item).toLowerCase());
    if (loweredTypes.includes("vacationrental") && entity.image) {
      imageRaw = entity.image;
      break;
    }
  }

  if (!imageRaw) {
    const withImage = entities.find((entity) => entity.image);
    imageRaw = withImage?.image ?? null;
  }

  const imageCandidates = Array.isArray(imageRaw)
    ? imageRaw
    : typeof imageRaw === "string"
      ? [imageRaw]
      : [];

  const normalized = imageCandidates
    .map((value) =>
      typeof value === "string" ? normalizeMediaUrl(value) : null,
    )
    .filter((value): value is string => Boolean(value));

  const filtered = normalized.filter((url) => {
    const base = imageBaseKey(url);
    if (!base) {
      return false;
    }
    if (EXCLUDED_MEDIA_URLS.has(url.toLowerCase())) {
      return false;
    }
    if (EXCLUDED_MEDIA_BASE_KEYS.has(base)) {
      return false;
    }
    return true;
  });

  return dedupePreserveOrder(filtered);
}

function buildRoomsGuidanceFromSchema(input: {
  beds: number | null;
  sleeps: number | null;
  bedDetails: Array<{ numberOfBeds: number | null; typeOfBed: string }>;
  additionalType: string;
}): string[] {
  const lines: string[] = [];

  if (input.beds !== null || input.sleeps !== null) {
    const bedroomLabel =
      input.beds === 1
        ? "1 Bedroom"
        : input.beds !== null
          ? `${input.beds} Bedrooms`
          : "Bedrooms";
    const sleepsLabel = input.sleeps !== null ? `, sleeps ${input.sleeps}` : "";
    lines.push(`${bedroomLabel}${sleepsLabel}`);
  }

  for (const bed of input.bedDetails) {
    const bedCount = bed.numberOfBeds ?? 0;
    const bedType = bed.typeOfBed || "Bed";
    if (bedCount > 0) {
      const typeLabel = bedCount === 1 ? bedType : `${bedType}s`;
      lines.push(`${bedCount} ${typeLabel}`);
    } else if (bedType) {
      lines.push(bedType);
    }
  }

  if (input.additionalType) {
    lines.push(`Unit Type - ${input.additionalType}`);
  }

  return dedupePreserveOrder(lines);
}

function extractSchemaLocation(input: unknown[]): {
  latitude: number | null;
  longitude: number | null;
  locality: string;
  region: string;
  fullAddress: string;
} {
  let bestFallback: {
    latitude: number | null;
    longitude: number | null;
    locality: string;
    region: string;
    fullAddress: string;
  } | null = null;

  for (const item of input) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const obj = item as Record<string, unknown>;
    const geo =
      obj.geo && typeof obj.geo === "object"
        ? (obj.geo as Record<string, unknown>)
        : null;
    const address =
      obj.address && typeof obj.address === "object"
        ? (obj.address as Record<string, unknown>)
        : null;

    const latitude = parseCoordinateLike(String(geo?.latitude ?? ""), "lat");
    const longitude = parseCoordinateLike(String(geo?.longitude ?? ""), "lng");

    const locality =
      typeof address?.addressLocality === "string"
        ? address.addressLocality.trim()
        : "";
    const region =
      typeof address?.addressRegion === "string"
        ? address.addressRegion.trim()
        : "";
    const country =
      typeof address?.addressCountry === "string"
        ? address.addressCountry.trim()
        : "";

    const fullAddress = [locality, region, country].filter(Boolean).join(", ");

    if (latitude !== null && longitude !== null) {
      return {
        latitude,
        longitude,
        locality,
        region,
        fullAddress,
      };
    }

    if (!bestFallback && (locality || region || fullAddress)) {
      bestFallback = {
        latitude,
        longitude,
        locality,
        region,
        fullAddress,
      };
    }
  }

  if (bestFallback) {
    return bestFallback;
  }

  return {
    latitude: null,
    longitude: null,
    locality: "",
    region: "",
    fullAddress: "",
  };
}

function extractCoordinatesFromGoogleEmbed(html: string): {
  latitude: number;
  longitude: number;
} | null {
  const centerMatch = html.match(
    /google\.com\/maps\/embed(?:\/v1\/view)?\?[^"'\s>]*(?:center=|center%3D)(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/i,
  );
  if (centerMatch?.[1] && centerMatch?.[2]) {
    const latitude = parseCoordinateLike(centerMatch[1], "lat");
    const longitude = parseCoordinateLike(centerMatch[2], "lng");
    if (latitude !== null && longitude !== null) {
      return { latitude, longitude };
    }
  }

  const centerHtmlEncodedMatch = html.match(
    /google\.com\/maps\/embed(?:\/v1\/view)?\?[^"'\s>]*(?:center=|center%3D)(-?\d+(?:\.\d+)?)%2C(-?\d+(?:\.\d+)?)/i,
  );
  if (centerHtmlEncodedMatch?.[1] && centerHtmlEncodedMatch?.[2]) {
    const latitude = parseCoordinateLike(centerHtmlEncodedMatch[1], "lat");
    const longitude = parseCoordinateLike(centerHtmlEncodedMatch[2], "lng");
    if (latitude !== null && longitude !== null) {
      return { latitude, longitude };
    }
  }

  const llMatch = html.match(
    /google\.com\/maps\/embed\?[^"'\s>]*\bll=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/i,
  );
  if (llMatch?.[1] && llMatch?.[2]) {
    const latitude = parseCoordinateLike(llMatch[1], "lat");
    const longitude = parseCoordinateLike(llMatch[2], "lng");
    if (latitude !== null && longitude !== null) {
      return { latitude, longitude };
    }
  }

  const encodedMatch = html.match(
    /google\.com\/maps\/embed\?[^"'\s>]*!2z([A-Za-z0-9+/=]+)/i,
  );
  const encoded = encodedMatch?.[1] ?? "";
  if (!encoded) {
    return null;
  }

  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const coordsMatch = decoded.match(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
    if (!coordsMatch?.[1] || !coordsMatch?.[2]) {
      return null;
    }

    const latitude = parseCoordinateLike(coordsMatch[1], "lat");
    const longitude = parseCoordinateLike(coordsMatch[2], "lng");
    if (latitude === null || longitude === null) {
      return null;
    }

    return { latitude, longitude };
  } catch {
    return null;
  }
}

function extractOwnerRezWidgetKeys(html: string): {
  propertyKey: string | null;
  widgetKey: string | null;
} {
  const widgetMatch = html.match(
    /<div[^>]*class=["'][^"']*ownerrez-widget[^"']*["'][^>]*data-widget-type=["']Booking\/Inquiry["'][^>]*>/i,
  );

  if (!widgetMatch) {
    return {
      propertyKey: null,
      widgetKey: null,
    };
  }

  const tag = widgetMatch[0];
  const propertyIdRaw =
    tag.match(/data-propertyId=["']([0-9a-f]{32})["']/i)?.[1] ?? null;
  const widgetIdRaw =
    tag.match(/data-widgetId=["']([0-9a-f]{32})["']/i)?.[1] ?? null;

  return {
    propertyKey: toDashedUuid(propertyIdRaw),
    widgetKey: toDashedUuid(widgetIdRaw),
  };
}

function extractOwnerRezCalendarWidgetKeys(html: string): {
  propertyKey: string | null;
  calendarWidgetKey: string | null;
} {
  const widgetMatch = html.match(
    /<div[^>]*class=["'][^"']*ownerrez-widget[^"']*["'][^>]*data-widget-type=["']Multiple Month Calendar["'][^>]*>/i,
  );

  if (!widgetMatch) {
    return {
      propertyKey: null,
      calendarWidgetKey: null,
    };
  }

  const tag = widgetMatch[0];
  const propertyIdRaw =
    tag.match(/data-propertyId=["']([0-9a-f]{32})["']/i)?.[1] ?? null;
  const widgetIdRaw =
    tag.match(/data-widgetId=["']([0-9a-f]{32})["']/i)?.[1] ?? null;

  return {
    propertyKey: toDashedUuid(propertyIdRaw),
    calendarWidgetKey: toDashedUuid(widgetIdRaw),
  };
}

function extractPropertyPublicId(detailUrl: string): string | null {
  const externalId = externalListingIdFromDetailUrl(detailUrl);
  const match = externalId.match(/(orp[0-9a-z]+x)$/i);
  return match?.[1] ?? null;
}

function extractRoomsGuidance(html: string): string[] {
  const section = html.match(
    /<th>\s*Sleeping Arrangements\s*<\/th>[\s\S]*?<td>([\s\S]*?)<\/td>/i,
  )?.[1];

  if (!section) {
    return [];
  }

  const lines: string[] = [];

  const summaryMatch = section.match(/(\d+\s+Bedrooms?,\s*sleeps?\s*[^<\n]+)/i);
  if (summaryMatch?.[1]) {
    lines.push(decodeEntities(stripHtml(summaryMatch[1])));
  }

  const liRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let match: RegExpExecArray | null = liRegex.exec(section);
  while (match) {
    const cleaned = decodeEntities(stripHtml(match[1] ?? ""));
    if (cleaned) {
      lines.push(cleaned);
    }
    match = liRegex.exec(section);
  }

  return dedupePreserveOrder(lines);
}

function extractDetailDescriptionFromContentColumn(html: string): string {
  const section = html.match(
    /<div\s+id=["']details["'][^>]*><\/div>([\s\S]*?)<h2\s+id=["']availability["'][^>]*>/i,
  )?.[1];

  if (!section) {
    return "";
  }

  const withoutSummary = section
    .replace(
      /<div[^>]+class=["'][^"']*amenity-summary-size[^"']*["'][^>]*>[\s\S]*?<\/div>/gi,
      " ",
    )
    .replace(
      /<div[^>]+class=["'][^"']*amenity-summary-amenities[^"']*["'][^>]*>[\s\S]*?<\/div>/gi,
      " ",
    );

  const paragraphs = Array.from(
    withoutSummary.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi),
  )
    .map((match) => decodeEntities(stripHtml(match[1] ?? "")))
    .map((value) => value.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  if (paragraphs.length > 0) {
    return paragraphs.join("\n\n");
  }

  return decodeEntities(stripHtml(withoutSummary));
}

function extractAmenities(html: string): {
  categories: Record<string, string[]>;
  all: string[];
} {
  const categories: Record<string, string[]> = {};

  const rowRegex =
    /<tr>[\s\S]*?<th[^>]*>([\s\S]*?)<\/th>[\s\S]*?<td>([\s\S]*?)<\/td>[\s\S]*?<\/tr>/gi;
  let rowMatch: RegExpExecArray | null = rowRegex.exec(html);
  while (rowMatch) {
    const category = decodeEntities(stripHtml(rowMatch[1] ?? ""));
    const content = rowMatch[2] ?? "";

    if (!category) {
      rowMatch = rowRegex.exec(html);
      continue;
    }

    const values: string[] = [];

    const liRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
    let liMatch: RegExpExecArray | null = liRegex.exec(content);
    while (liMatch) {
      const value = decodeEntities(stripHtml(liMatch[1] ?? ""));
      if (value) {
        values.push(value);
      }
      liMatch = liRegex.exec(content);
    }

    if (values.length === 0) {
      const fallback = decodeEntities(stripHtml(content));
      if (fallback) {
        values.push(fallback);
      }
    }

    if (values.length > 0) {
      categories[category] = dedupePreserveOrder(values);
    }

    rowMatch = rowRegex.exec(html);
  }

  const all = dedupePreserveOrder(Object.values(categories).flat());
  return { categories, all };
}

function imageVariantRank(url: string): number {
  const lower = url.toLowerCase();
  if (/\/i\/[0-9a-f]+-largeoriginal$/.test(lower)) {
    return 50;
  }
  if (/\/i\/[0-9a-f]+-mediumoriginal$/.test(lower)) {
    return 40;
  }
  if (/\/i\/[0-9a-f]+-large$/.test(lower)) {
    return 30;
  }
  if (/\/i\/[0-9a-f]+-medium$/.test(lower)) {
    return 20;
  }
  if (/\/f\/[0-9a-f]+$/.test(lower)) {
    return 10;
  }
  return 1;
}

function imageBaseKey(url: string): string | null {
  const lower = url.toLowerCase();
  const iMatch = lower.match(/\/i\/([0-9a-f]+)(?:-[a-z]+(?:original)?)?$/);
  if (iMatch?.[1]) {
    return iMatch[1];
  }
  const fMatch = lower.match(/\/f\/([0-9a-f]+)$/);
  if (fMatch?.[1]) {
    return fMatch[1];
  }
  return null;
}

function normalizeMediaUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.hostname.toLowerCase() !== "uc.orez.io") {
    return null;
  }

  const cleanedPath = parsed.pathname.replace(/\/+$/, "");
  const match = cleanedPath.match(
    /^\/(?:i|f)\/[0-9a-f]+(?:-[a-z]+(?:Original)?)?$/i,
  );
  if (!match) {
    return null;
  }

  return `https://uc.orez.io${cleanedPath}`;
}

function collectMediaUrls(html: string): string[] {
  const urlRegex =
    /https:\/\/uc\.orez\.io\/(?:i|f)\/[0-9a-f]+(?:-[A-Za-z]+(?:Original)?)?/gi;
  const allMatches = html.match(urlRegex) ?? [];

  const bestByBase = new Map<string, { url: string; rank: number }>();

  for (const raw of allMatches) {
    const normalized = normalizeMediaUrl(raw);
    if (!normalized) {
      continue;
    }

    const base = imageBaseKey(normalized);
    if (!base) {
      continue;
    }

    if (
      EXCLUDED_MEDIA_URLS.has(normalized.toLowerCase()) ||
      EXCLUDED_MEDIA_BASE_KEYS.has(base)
    ) {
      continue;
    }

    const rank = imageVariantRank(normalized);
    const existing = bestByBase.get(base);
    if (!existing || rank > existing.rank) {
      bestByBase.set(base, { url: normalized, rank });
    }
  }

  return Array.from(bestByBase.values()).map((entry) => entry.url);
}

function parseCapacityFromRoomsAndBaths(html: string): {
  beds: number | null;
  baths: number | null;
  sleeps: number | null;
} {
  const sleepingSection = html.match(
    /<th>\s*Sleeping Arrangements\s*<\/th>[\s\S]*?<td>([\s\S]*?)<\/td>/i,
  )?.[1];
  const sleepingText = sleepingSection ? stripHtml(sleepingSection) : "";

  const bathsSection = html.match(
    /<th>\s*Bathrooms\s*<\/th>[\s\S]*?<td>([\s\S]*?)<\/td>/i,
  )?.[1];
  const bathsText = bathsSection ? stripHtml(bathsSection) : "";

  const beds = Number(sleepingText.match(/(\d+)\s+Bedrooms?/i)?.[1] ?? "");
  const baths = Number(bathsText.match(/(\d+)\s+Bathrooms?/i)?.[1] ?? "");

  let sleeps: number | null = null;
  const rangeMatch = sleepingText.match(/sleeps?\s+(\d+)\s*-\s*(\d+)/i);
  if (rangeMatch?.[2]) {
    const upper = Number(rangeMatch[2]);
    if (Number.isFinite(upper)) {
      sleeps = upper;
    }
  }
  if (sleeps === null) {
    const singleMatch = sleepingText.match(/sleeps?\s+(\d+)/i);
    if (singleMatch?.[1]) {
      const parsed = Number(singleMatch[1]);
      if (Number.isFinite(parsed)) {
        sleeps = parsed;
      }
    }
  }

  return {
    beds: Number.isFinite(beds) ? beds : null,
    baths: Number.isFinite(baths) ? baths : null,
    sleeps,
  };
}

function parseIsoDate(value: string): Date | null {
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return null;
  }

  const [yearRaw, monthRaw, dayRaw] = trimmed.split("-");
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);

  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  ) {
    return null;
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return date;
}

function formatIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addIsoDays(isoDate: string, days: number): string {
  const parsed = parseIsoDate(isoDate);
  if (!parsed) {
    return isoDate;
  }
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return formatIsoDate(parsed);
}

function extractVarStringValue(html: string, varName: string): string | null {
  const escaped = varName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(
    `var\\s+${escaped}\\s*=\\s*(["'])([\\s\\S]*?)\\1\\s*;`,
    "i",
  );
  const match = html.match(regex);
  if (!match?.[2]) {
    return null;
  }
  return match[2];
}

function decodeJsDoubleQuotedString(value: string): string | null {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return null;
  }
}

function extractJsonParsedVar<T>(html: string, varName: string): T | null {
  const escaped = varName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(
    `var\\s+${escaped}\\s*=\\s*JSON\\.parse\\("([\\s\\S]*?)"\\)\\s*;`,
    "i",
  );
  const match = html.match(regex);
  if (!match?.[1]) {
    return null;
  }

  const decoded = decodeJsDoubleQuotedString(match[1]);
  if (!decoded) {
    return null;
  }

  try {
    return JSON.parse(decoded) as T;
  } catch {
    return null;
  }
}

function toDayCodeFromStatus(statusCode: FiveStarDayCode): CanonicalDayCode {
  return statusCode === "A" || statusCode === "O" ? "Y" : "N";
}

function toChangeoverCodeFromStatus(
  statusCode: FiveStarDayCode,
): CanonicalChangeoverCode {
  if (statusCode === "I") {
    return "I";
  }
  if (statusCode === "O") {
    return "O";
  }
  if (statusCode === "U" || statusCode === "X") {
    return "X";
  }
  return "C";
}

function parseDollarValue(value: string): number | null {
  const numeric = Number(value.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(numeric) ? numeric : null;
}

function buildAvailabilityFromEmbeddedCalendar(
  html: string,
  horizonDays: number,
): {
  days: ThirtyAFiveStarDetailRecord["normalized_availability"]["days"];
  windowStart: string;
  windowEnd: string;
  minDayKey: string | null;
  maxDayKey: string | null;
  dayCodes: string;
  counts: ThirtyAFiveStarDetailRecord["normalized_availability"]["counts"];
} | null {
  const bookingData =
    extractJsonParsedVar<
      Array<{ Arrival?: string; Departure?: string; IsNotAllowed?: boolean }>
    >(html, "bookingData") ?? [];

  const rates =
    extractJsonParsedVar<Record<string, string>>(html, "rates") ?? {};
  const minDayKeyRaw = extractVarStringValue(html, "minDayKey") ?? "";
  const maxDayKeyRaw = extractVarStringValue(html, "maxDayKey") ?? "";
  const minDayKey = /^\d{4}-\d{2}-\d{2}$/.test(minDayKeyRaw)
    ? minDayKeyRaw
    : null;
  const maxDayKey = /^\d{4}-\d{2}-\d{2}$/.test(maxDayKeyRaw)
    ? maxDayKeyRaw
    : null;

  const hasEmbeddedCalendar =
    bookingData.length > 0 ||
    Object.keys(rates).length > 0 ||
    Boolean(minDayKey) ||
    Boolean(maxDayKey);

  if (!hasEmbeddedCalendar) {
    return null;
  }

  const bookingMap = new Map<
    string,
    { isStart?: boolean; isMiddle?: boolean; isEnd?: boolean }
  >();

  for (const booking of bookingData) {
    const arrival = typeof booking.Arrival === "string" ? booking.Arrival : "";
    const departure =
      typeof booking.Departure === "string" ? booking.Departure : "";
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(arrival) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(departure)
    ) {
      continue;
    }

    const startDate = parseIsoDate(arrival);
    const endDate = parseIsoDate(departure);
    if (!startDate || !endDate || endDate < startDate) {
      continue;
    }

    const startExisting = bookingMap.get(arrival) ?? {};
    startExisting.isStart = true;
    bookingMap.set(arrival, startExisting);

    const endExisting = bookingMap.get(departure) ?? {};
    endExisting.isEnd = true;
    bookingMap.set(departure, endExisting);

    let cursorIso = addIsoDays(arrival, 1);
    while (cursorIso < departure) {
      const existing = bookingMap.get(cursorIso) ?? {};
      existing.isMiddle = true;
      bookingMap.set(cursorIso, existing);
      cursorIso = addIsoDays(cursorIso, 1);
    }
  }

  const now = new Date();
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  start.setUTCDate(start.getUTCDate() + 1);

  const days: ThirtyAFiveStarDetailRecord["normalized_availability"]["days"] =
    [];

  for (let offset = 0; offset < Math.max(1, horizonDays); offset += 1) {
    const cursor = new Date(start);
    cursor.setUTCDate(start.getUTCDate() + offset);
    const isoDate = formatIsoDate(cursor);

    let statusCode: FiveStarDayCode = "A";

    if (
      (minDayKey && isoDate < minDayKey) ||
      (maxDayKey && isoDate > maxDayKey)
    ) {
      statusCode = "U";
    } else {
      const booking = bookingMap.get(isoDate);
      if (booking?.isMiddle || (booking?.isStart && booking?.isEnd)) {
        statusCode = "U";
      } else if (booking?.isStart) {
        statusCode = "O";
      } else if (booking?.isEnd) {
        statusCode = "I";
      }

      if (statusCode === "A" && typeof rates[isoDate] === "string") {
        const parsedRate = parseDollarValue(rates[isoDate]);
        if (parsedRate !== null && parsedRate <= 0) {
          statusCode = "U";
        }
      }
    }

    days.push({
      date: isoDate,
      day_code: toDayCodeFromStatus(statusCode),
      status_code: statusCode,
      changeover_code: toChangeoverCodeFromStatus(statusCode),
      is_available: statusCode === "A",
      is_available_for_checkin: statusCode === "A" || statusCode === "I",
      is_available_for_checkout: statusCode === "A" || statusCode === "O",
      booking_day_state:
        statusCode === "A"
          ? "bookable"
          : statusCode === "U"
            ? "blocked"
            : "unknown",
      min_nights_required: null,
    });
  }

  const counts = {
    available: days.filter((day) => day.status_code === "A").length,
    unavailable: days.filter((day) => day.status_code === "U").length,
    checkin_only: days.filter((day) => day.status_code === "I").length,
    checkout_only: days.filter((day) => day.status_code === "O").length,
    other: days.filter((day) => day.status_code === "X").length,
    booking_available: days.filter(
      (day) => day.booking_day_state === "bookable",
    ).length,
    booking_unavailable: days.filter(
      (day) => day.booking_day_state === "blocked",
    ).length,
    booking_unknown: days.filter((day) => day.booking_day_state === "unknown")
      .length,
  };

  return {
    days,
    windowStart: days[0]?.date ?? "",
    windowEnd: days[days.length - 1]?.date ?? "",
    minDayKey,
    maxDayKey,
    dayCodes: days.map((day) => day.status_code).join(""),
    counts,
  };
}

function buildUnavailableAvailability(horizonDays: number): {
  days: ThirtyAFiveStarDetailRecord["normalized_availability"]["days"];
  windowStart: string;
  windowEnd: string;
  minDayKey: string | null;
  maxDayKey: string | null;
  dayCodes: string;
  counts: ThirtyAFiveStarDetailRecord["normalized_availability"]["counts"];
} {
  const days: ThirtyAFiveStarDetailRecord["normalized_availability"]["days"] =
    [];

  const now = new Date();
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  start.setUTCDate(start.getUTCDate() + 1);

  for (let offset = 0; offset < Math.max(1, horizonDays); offset += 1) {
    const cursor = new Date(start);
    cursor.setUTCDate(start.getUTCDate() + offset);
    const iso = cursor.toISOString().slice(0, 10);
    days.push({
      date: iso,
      day_code: "N",
      status_code: "U",
      changeover_code: "X",
      is_available: false,
      is_available_for_checkin: false,
      is_available_for_checkout: false,
      booking_day_state: "blocked",
      min_nights_required: null,
    });
  }

  const counts = {
    available: 0,
    unavailable: days.length,
    checkin_only: 0,
    checkout_only: 0,
    other: 0,
    booking_available: 0,
    booking_unavailable: days.length,
    booking_unknown: 0,
  };

  return {
    days,
    windowStart: days[0]?.date ?? "",
    windowEnd: days[days.length - 1]?.date ?? "",
    minDayKey: null,
    maxDayKey: null,
    dayCodes: days.map((d) => d.status_code).join(""),
    counts,
  };
}

async function discoverListings(
  page: Parameters<
    ScraperAdapter<ThirtyAFiveStarDetailRecord>["discoverListings"]
  >[0]["page"],
  anchorUrl: string,
  maxScrollSteps: number,
  scrollPauseMs: number,
  reportProgress: (message: string) => void,
): Promise<ScrapedLink[]> {
  const baseUrl = anchorUrl.includes(HOST) ? anchorUrl : DEFAULT_ANCHOR_URL;
  const discovered = new Set<string>();
  const sourceByLink = new Map<string, string>();

  const maxPagesFromEnv = Number(process.env.THIRTYAFIVESTAR_MAX_PAGES ?? "");
  const fallbackMax = Math.max(8, Math.max(1, maxScrollSteps));
  const maxPages =
    Number.isFinite(maxPagesFromEnv) && maxPagesFromEnv > 0
      ? Math.floor(maxPagesFromEnv)
      : fallbackMax;

  let inferredLastPage = 1;
  let stalePages = 0;

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
    const targetUrl = new URL(baseUrl);
    if (pageNumber > 1) {
      targetUrl.searchParams.set("page", String(pageNumber));
    } else {
      targetUrl.searchParams.delete("page");
    }

    await page.goto(targetUrl.toString(), {
      waitUntil: "domcontentloaded",
      timeout: 120000,
    });
    await page.waitForTimeout(Math.max(800, scrollPauseMs));

    const html = await page.content();

    const pageHints = Array.from(html.matchAll(/[?&]page=(\d+)/gi))
      .map((match) => Number(match[1]))
      .filter((value) => Number.isFinite(value) && value > 0);
    if (pageHints.length > 0) {
      inferredLastPage = Math.max(inferredLastPage, ...pageHints);
    }

    const linkMatches = Array.from(html.matchAll(/href=["']([^"'#\s]+)["']/gi))
      .map((match) => match[1] ?? "")
      .filter(Boolean);

    const before = discovered.size;
    for (const link of linkMatches) {
      let resolved: string;
      try {
        resolved = new URL(link, targetUrl).toString();
      } catch {
        continue;
      }
      const normalized = normalizeDetailUrl(resolved);
      if (!normalized) {
        continue;
      }
      discovered.add(normalized);
      sourceByLink.set(normalized, targetUrl.toString());
    }

    const growth = discovered.size - before;
    reportProgress(
      `30afivestar discovery page=${pageNumber}, captured=${discovered.size}, added=${growth}, expected~32`,
    );

    if (growth <= 0) {
      stalePages += 1;
    } else {
      stalePages = 0;
    }

    if (pageNumber >= inferredLastPage && inferredLastPage > 1) {
      break;
    }

    if (stalePages >= 2) {
      break;
    }
  }

  return Array.from(discovered)
    .sort((left, right) => left.localeCompare(right))
    .map((link) => ({
      link,
      source_url: sourceByLink.get(link) ?? baseUrl,
      anchor_text: "detail-link",
    }));
}

async function fetchDetail(
  _browser: Parameters<
    ScraperAdapter<ThirtyAFiveStarDetailRecord>["fetchDetail"]
  >[0]["browser"],
  detailUrl: string,
  availabilityHorizonDays: number,
): Promise<ThirtyAFiveStarDetailRecord | null> {
  const normalizedDetailUrl = normalizeDetailUrl(detailUrl);
  if (!normalizedDetailUrl) {
    return null;
  }

  const response = await fetch(normalizedDetailUrl, {
    method: "GET",
    headers: {
      "user-agent": USER_AGENT,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      referer: DEFAULT_ANCHOR_URL,
    },
  });

  const contentType = (
    response.headers.get("content-type") ?? ""
  ).toLowerCase();
  if (!response.ok || !contentType.includes("text/html")) {
    return null;
  }

  const html = await response.text();
  const externalId =
    canonicalizeExternalListingId(
      externalListingIdFromDetailUrl(normalizedDetailUrl),
    ) || canonicalizeExternalListingId(normalizedDetailUrl);
  if (!externalId) {
    return null;
  }

  const htmlPath = resolve(OUTPUT_DETAILS_HTML_DIR, `${externalId}.html`);
  await writeFile(htmlPath, `${html}\n`, "utf8");

  const jsonLdObjects = extractJsonLdObjects(html);
  const schemaProfile = extractSchemaPropertyProfile(jsonLdObjects);
  const schemaImageUrls = extractSchemaImageUrls(jsonLdObjects);

  const title = extractFirst(/<title[^>]*>([\s\S]*?)<\/title>/i, html).slice(
    0,
    240,
  );
  const rawH1 = extractFirst(/<h1[^>]*>([\s\S]*?)<\/h1>/i, html).slice(0, 240);
  const ogTitle =
    extractFirst(
      /<meta[^>]+property=["']og:title["'][^>]+content=["']([\s\S]*?)["'][^>]*>/i,
      html,
    ).slice(0, 240) ||
    extractFirst(
      /<meta[^>]+content=["']([\s\S]*?)["'][^>]+property=["']og:title["'][^>]*>/i,
      html,
    ).slice(0, 240);
  const titleWithoutBrandSuffix = title
    .replace(/\s*-\s*30a five star properties\s*$/i, "")
    .trim();
  const h1 = (
    schemaProfile.name ||
    ogTitle ||
    titleWithoutBrandSuffix ||
    rawH1
  ).slice(0, 240);
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
  const ogDescription =
    extractFirst(
      /<meta[^>]+property=["']og:description["'][^>]+content=["']([\s\S]*?)["'][^>]*>/i,
      html,
    ).slice(0, 2000) ||
    extractFirst(
      /<meta[^>]+content=["']([\s\S]*?)["'][^>]+property=["']og:description["'][^>]*>/i,
      html,
    ).slice(0, 2000);

  const detailedContentDescription =
    extractDetailDescriptionFromContentColumn(html);

  const descriptionExpanded =
    detailedContentDescription ||
    schemaProfile.description ||
    extractFirst(
      /<div[^>]+id=["']description["'][^>]*>([\s\S]*?)<\/div>/i,
      html,
    ) ||
    ogDescription ||
    metaDescription;

  const schemaRoomsGuidance = buildRoomsGuidanceFromSchema({
    beds: schemaProfile.beds,
    sleeps: schemaProfile.sleeps,
    bedDetails: schemaProfile.bedDetails,
    additionalType: schemaProfile.additionalType,
  });
  const roomsGuidance =
    schemaRoomsGuidance.length > 0
      ? schemaRoomsGuidance
      : extractRoomsGuidance(html);
  const amenities = extractAmenities(html);
  const imageUrls =
    schemaImageUrls.length > 0 ? schemaImageUrls : collectMediaUrls(html);

  const schema = extractSchemaLocation(jsonLdObjects);
  const mapCoordinates = extractCoordinatesFromGoogleEmbed(html);
  const resolvedLatitude = schema.latitude ?? mapCoordinates?.latitude ?? null;
  const resolvedLongitude =
    schema.longitude ?? mapCoordinates?.longitude ?? null;
  const locationLabel = [schema.locality, schema.region]
    .filter(Boolean)
    .join(", ");
  const address = schema.fullAddress || locationLabel;

  const parsedCapacity = parseCapacityFromRoomsAndBaths(html);
  const beds =
    schemaProfile.beds !== null ? schemaProfile.beds : parsedCapacity.beds;
  const baths =
    schemaProfile.baths !== null ? schemaProfile.baths : parsedCapacity.baths;
  const sleeps =
    schemaProfile.sleeps !== null
      ? schemaProfile.sleeps
      : parsedCapacity.sleeps;

  const widgetKeys = extractOwnerRezWidgetKeys(html);
  const calendarWidgetKeys = extractOwnerRezCalendarWidgetKeys(html);
  const propertyPublicId = extractPropertyPublicId(normalizedDetailUrl);

  const availabilityHorizon = Math.max(180, availabilityHorizonDays);
  let availabilitySource:
    | "listing_calendar"
    | "widget_calendar"
    | "fallback_unavailable" = "fallback_unavailable";
  let availability = buildAvailabilityFromEmbeddedCalendar(
    html,
    availabilityHorizon,
  );
  if (availability) {
    availabilitySource = "listing_calendar";
  }

  const widgetPropertyKey =
    calendarWidgetKeys.propertyKey ?? widgetKeys.propertyKey;
  if (calendarWidgetKeys.calendarWidgetKey && widgetPropertyKey) {
    const widgetUrl =
      `https://app.ownerrez.com/widgets/${calendarWidgetKeys.calendarWidgetKey}` +
      `?propertyKey=${encodeURIComponent(widgetPropertyKey)}`;

    try {
      const widgetResponse = await fetch(widgetUrl, {
        headers: {
          "user-agent": USER_AGENT,
          accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          referer: normalizedDetailUrl,
        },
      });

      if (widgetResponse.ok) {
        const widgetHtml = await widgetResponse.text();
        const widgetAvailability = buildAvailabilityFromEmbeddedCalendar(
          widgetHtml,
          availabilityHorizon,
        );
        if (widgetAvailability) {
          availability = widgetAvailability;
          availabilitySource = "widget_calendar";
        }
      }
    } catch {
      // Keep listing-page availability if widget fetch fails.
    }
  }

  if (!availability) {
    availability = buildUnavailableAvailability(availabilityHorizon);
    availabilitySource = "fallback_unavailable";
  }

  const nameForMatch = (h1 || title || externalId).trim();
  const descriptionForMatch = (
    descriptionExpanded ||
    metaDescription ||
    ""
  ).trim();
  const titleNormalized = normalizeForMatch(nameForMatch);
  const descriptionNormalized = normalizeForMatch(descriptionForMatch);

  return {
    external_listing_id: externalId,
    detail_url: normalizedDetailUrl,
    fetched_at: new Date().toISOString(),
    html_path: htmlPath,
    title,
    h1,
    canonical_url: canonicalUrl,
    meta_description: metaDescription,
    description_expanded: descriptionExpanded,
    rooms_guidance: roomsGuidance,
    amenities,
    location: {
      address,
      location_label: locationLabel,
      directions_url:
        resolvedLatitude !== null && resolvedLongitude !== null
          ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${resolvedLatitude},${resolvedLongitude}`)}`
          : address
            ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`
            : "",
      directions_daddr: address,
      latitude: resolvedLatitude,
      longitude: resolvedLongitude,
    },
    media_gallery: {
      image_count: imageUrls.length,
      image_urls: imageUrls,
    },
    property_profile: {
      unit_id: propertyPublicId ?? externalId,
      area: "30A",
      location: locationLabel,
      beds,
      baths,
      sleeps,
      city: schema.locality,
      state: schema.region,
    },
    quote_context: {
      source: "ownerrez_widget",
      property_key: widgetKeys.propertyKey,
      widget_key: widgetKeys.widgetKey,
      detail_url: normalizedDetailUrl,
      property_public_id: propertyPublicId,
    },
    normalized_matching_profile: {
      source: "pm_30afivestar",
      external_listing_id: externalId,
      name: nameForMatch,
      description: descriptionForMatch,
      match_signals: {
        description_normalized: descriptionNormalized,
        description_sha256: hashSha256(descriptionNormalized),
        title_normalized: titleNormalized,
        title_sha256: hashSha256(titleNormalized),
        listing_composite_key: [
          "pm_30afivestar",
          externalId,
          hashSha256(descriptionNormalized),
          hashSha256(titleNormalized),
        ].join("::"),
      },
    },
    normalized_availability: {
      source: "pm_30afivestar",
      external_listing_id: externalId,
      captured_at: new Date().toISOString(),
      availability_source: availabilitySource,
      has_calendar_widget:
        /data-widget-type=["']Multiple Month Calendar["']/i.test(html),
      calendar_bounds: {
        min_day_key: availability.minDayKey ?? null,
        max_day_key: availability.maxDayKey ?? null,
      },
      booking_restrictions: [],
      min_night_rules: [],
      window_start: availability.windowStart,
      window_end: availability.windowEnd,
      code_legend: {
        A: "available",
        U: "unavailable",
        I: "checkin_only",
        O: "checkout_only",
        X: "other",
      },
      day_codes: availability.dayCodes,
      days: availability.days,
      counts: availability.counts,
    },
  };
}

export function create30AFiveStarAdapter(): ScraperAdapter<ThirtyAFiveStarDetailRecord> {
  return {
    managerKey: "30afivestar",
    scriptLabel: "30afivestar",
    defaultAnchorUrl: DEFAULT_ANCHOR_URL,
    detailFetchDelayMs: Math.max(
      0,
      Number(process.env.THIRTYAFIVESTAR_DETAIL_FETCH_DELAY_MS ?? "300") || 300,
    ),
    detailFetchConcurrency: Math.max(
      1,
      Number(process.env.THIRTYAFIVESTAR_FETCH_CONCURRENCY ?? "4") || 4,
    ),
    availabilityHorizonDays: Math.max(
      1,
      Number(process.env.THIRTYAFIVESTAR_AVAILABILITY_HORIZON_DAYS ?? "365") ||
        365,
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
      return fetchDetail(
        context.browser,
        context.detailUrl,
        context.availabilityHorizonDays,
      );
    },
    async runQuoteCapture(argv, progress) {
      const normalizedArgs = await normalizeAdapterQuoteScopeArgs(
        "30afivestar",
        argv,
      );
      await runRuntimeAdapterQuoteCli(
        {
          adapterKey: "30afivestar",
          executeSingleQuote: execute30AFivestarSingleQuote,
          defaultQuoteTimeoutMs: 20000,
          defaultQuoteMaxAttempts: 2,
          defaultEndpointPath: THIRTYAFIVESTAR_OWNERREZ_QUOTE_PATH,
          defaultTaxPct: 0.12,
          defaultBaseNightly: 400,
        },
        normalizedArgs,
        progress,
      );
    },
  };
}
