import { createHash } from "node:crypto";

import { eq } from "drizzle-orm";

import { pgDb } from "@/core/server/db";
import { listing_geocode_cache } from "@/lib/db/schema-postgres";

type GeocodeInput = {
  listingId: string;
  canonicalName: string;
  lat: number | null;
  lng: number | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  area: string | null;
};

type GeocodeResolvedFields = {
  city: string | null;
  state: string | null;
  postalCode: string | null;
  countryCode: string | null;
};

type GoogleAddressComponent = {
  long_name?: string;
  short_name?: string;
  types?: string[];
};

type GoogleGeocodeResult = {
  place_id?: string;
  formatted_address?: string;
  geometry?: {
    location_type?: string;
  };
  address_components?: GoogleAddressComponent[];
};

function hashHex(value: string, length: number): string {
  return createHash("sha1").update(value).digest("hex").slice(0, length);
}

function normalizeText(value: string | null): string {
  return (value ?? "").trim();
}

function buildSourceFingerprint(input: GeocodeInput): string {
  const payload = JSON.stringify({
    lat: input.lat,
    lng: input.lng,
    area: normalizeText(input.area),
    canonical_name: normalizeText(input.canonicalName),
  });

  return hashHex(payload, 20);
}

function getAddressComponent(
  components: GoogleAddressComponent[] | undefined,
  type: string,
): string | null {
  if (!components) {
    return null;
  }

  const found = components.find(
    (component) =>
      Array.isArray(component.types) && component.types.includes(type),
  );

  if (!found) {
    return null;
  }

  return (found.long_name ?? found.short_name ?? "").trim() || null;
}

function getStreetAddress(
  components: GoogleAddressComponent[] | undefined,
): string | null {
  const streetNumber = getAddressComponent(components, "street_number");
  const route = getAddressComponent(components, "route");

  if (streetNumber && route) {
    return `${streetNumber} ${route}`;
  }

  return route || streetNumber;
}

function confidenceForLocationType(locationType: string | null): string {
  if (!locationType) {
    return "0.5000";
  }

  if (locationType === "ROOFTOP") return "1.0000";
  if (locationType === "RANGE_INTERPOLATED") return "0.8500";
  if (locationType === "GEOMETRIC_CENTER") return "0.7000";
  return "0.5000";
}

function buildForwardQuery(input: GeocodeInput): string | null {
  const parts = [
    input.canonicalName,
    input.area,
    input.city,
    input.state,
    input.postalCode,
    "Florida",
    "USA",
  ]
    .map((value) => normalizeText(value ?? null))
    .filter((value) => value.length > 0);

  if (parts.length === 0) {
    return null;
  }

  return parts.join(", ");
}

async function fetchGoogleGeocode(input: {
  apiKey: string;
  lat: number | null;
  lng: number | null;
  queryText: string | null;
}): Promise<{
  geocodeMode: "reverse" | "forward";
  queryText: string | null;
  result: GoogleGeocodeResult | null;
  rawResponse: unknown;
}> {
  const tryRequest = async (
    url: URL,
  ): Promise<{ result: GoogleGeocodeResult | null; rawResponse: unknown }> => {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `google geocode request failed status=${response.status}`,
      );
    }

    const json = (await response.json()) as {
      status?: string;
      results?: GoogleGeocodeResult[];
      error_message?: string;
    };

    if (json.status !== "OK" || !Array.isArray(json.results)) {
      return { result: null, rawResponse: json };
    }

    return {
      result: json.results[0] ?? null,
      rawResponse: json,
    };
  };

  if (input.lat !== null && input.lng !== null) {
    const reverse = new URL(
      "https://maps.googleapis.com/maps/api/geocode/json",
    );
    reverse.searchParams.set("latlng", `${input.lat},${input.lng}`);
    reverse.searchParams.set("key", input.apiKey);
    reverse.searchParams.set(
      "result_type",
      "street_address|premise|route|locality|postal_code",
    );

    const reverseResult = await tryRequest(reverse);
    if (reverseResult.result) {
      return {
        geocodeMode: "reverse",
        queryText: `${input.lat},${input.lng}`,
        result: reverseResult.result,
        rawResponse: reverseResult.rawResponse,
      };
    }

    if (!input.queryText) {
      return {
        geocodeMode: "reverse",
        queryText: `${input.lat},${input.lng}`,
        result: null,
        rawResponse: reverseResult.rawResponse,
      };
    }
  }

  if (!input.queryText) {
    return {
      geocodeMode: "forward",
      queryText: null,
      result: null,
      rawResponse: { status: "SKIPPED", reason: "missing_query" },
    };
  }

  const forward = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  forward.searchParams.set("address", input.queryText);
  forward.searchParams.set("key", input.apiKey);

  const forwardResult = await tryRequest(forward);

  return {
    geocodeMode: "forward",
    queryText: input.queryText,
    result: forwardResult.result,
    rawResponse: forwardResult.rawResponse,
  };
}

export async function resolveListingGeocode(
  input: GeocodeInput,
): Promise<GeocodeResolvedFields> {
  if (!pgDb) {
    return {
      city: input.city,
      state: input.state,
      postalCode: input.postalCode,
      countryCode: "US",
    };
  }

  const hasMissingAddress =
    !normalizeText(input.city) ||
    !normalizeText(input.state) ||
    !normalizeText(input.postalCode);

  if (!hasMissingAddress) {
    return {
      city: input.city,
      state: input.state,
      postalCode: input.postalCode,
      countryCode: "US",
    };
  }

  const sourceFingerprint = buildSourceFingerprint(input);
  const existing = await pgDb
    .select({
      city: listing_geocode_cache.city,
      state: listing_geocode_cache.state,
      postalCode: listing_geocode_cache.postal_code,
      countryCode: listing_geocode_cache.country_code,
      status: listing_geocode_cache.geocode_status,
    })
    .from(listing_geocode_cache)
    .where(eq(listing_geocode_cache.listing_id, input.listingId))
    .limit(1);

  if (existing.length > 0 && existing[0].status === "resolved") {
    return {
      city: existing[0].city ?? input.city,
      state: existing[0].state ?? input.state,
      postalCode: existing[0].postalCode ?? input.postalCode,
      countryCode: existing[0].countryCode ?? "US",
    };
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY?.trim();
  if (!apiKey) {
    return {
      city: input.city,
      state: input.state,
      postalCode: input.postalCode,
      countryCode: "US",
    };
  }

  const queryText = buildForwardQuery(input);
  const geocode = await fetchGoogleGeocode({
    apiKey,
    lat: input.lat,
    lng: input.lng,
    queryText,
  });

  const components = geocode.result?.address_components;
  const city =
    getAddressComponent(components, "locality") ||
    getAddressComponent(components, "postal_town") ||
    getAddressComponent(components, "administrative_area_level_2") ||
    input.city;
  const state =
    getAddressComponent(components, "administrative_area_level_1") ||
    input.state;
  const postalCode =
    getAddressComponent(components, "postal_code") || input.postalCode;
  const countryCode = getAddressComponent(components, "country") || "US";

  const now = new Date().toISOString();
  const cacheId = `lgc_${hashHex(`${input.listingId}:google`, 20)}`;
  const locationType = geocode.result?.geometry?.location_type ?? null;

  await pgDb
    .insert(listing_geocode_cache)
    .values({
      id: cacheId,
      listing_id: input.listingId,
      provider: "google",
      source_fingerprint: sourceFingerprint,
      source_input: {
        lat: input.lat,
        lng: input.lng,
        city: input.city,
        state: input.state,
        postal_code: input.postalCode,
        area: input.area,
        canonical_name: input.canonicalName,
      },
      geocode_mode: geocode.geocodeMode,
      query_text: geocode.queryText,
      lat: input.lat,
      lng: input.lng,
      formatted_address: geocode.result?.formatted_address ?? null,
      street_address: getStreetAddress(components),
      city: city ?? null,
      state: state ?? null,
      postal_code: postalCode ?? null,
      country_code: countryCode ?? null,
      place_id: geocode.result?.place_id ?? null,
      location_type: locationType,
      confidence_score: confidenceForLocationType(locationType),
      geocode_status: geocode.result ? "resolved" : "failed",
      raw_response:
        (geocode.rawResponse as Record<string, unknown> | null) ?? {},
      resolved_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: [listing_geocode_cache.listing_id],
      set: {
        source_input: {
          lat: input.lat,
          lng: input.lng,
          city: input.city,
          state: input.state,
          postal_code: input.postalCode,
          area: input.area,
          canonical_name: input.canonicalName,
        },
        geocode_mode: geocode.geocodeMode,
        query_text: geocode.queryText,
        lat: input.lat,
        lng: input.lng,
        formatted_address: geocode.result?.formatted_address ?? null,
        street_address: getStreetAddress(components),
        city: city ?? null,
        state: state ?? null,
        postal_code: postalCode ?? null,
        country_code: countryCode ?? null,
        place_id: geocode.result?.place_id ?? null,
        location_type: locationType,
        confidence_score: confidenceForLocationType(locationType),
        geocode_status: geocode.result ? "resolved" : "failed",
        raw_response:
          (geocode.rawResponse as Record<string, unknown> | null) ?? {},
        resolved_at: now,
        updated_at: now,
      },
    });

  return {
    city: city ?? input.city,
    state: state ?? input.state,
    postalCode: postalCode ?? input.postalCode,
    countryCode,
  };
}
