import { createFileRoute } from "@tanstack/react-router";

import { createAppErrorResponse } from "@/core/errors/app-errors";
import {
  NullRouteComponent,
  createNoStoreHeaders,
  optionsResponse,
} from "@/core/http/api-http";
import { executeDiscoverSearch } from "@/lib/discover/discover-search-service.server";

const DISCOVER_API_MAX_LIMIT = 96;

function toOptionalNumber(value: unknown): number | undefined {
  const candidate =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;

  return Number.isFinite(candidate) ? candidate : undefined;
}

function stripUndefined<T extends Record<string, unknown>>(
  input: T,
): Partial<T> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

async function parseSearchRequestFromBody(request: Request) {
  const payload = (await request.json().catch(() => null)) as {
    includeSlug?: unknown;
    sortOption?: unknown;
    limit?: unknown;
    offset?: unknown;
    includeMetadata?: unknown;
    includeMapListings?: unknown;
    locationQuery?: unknown;
    minSleeps?: unknown;
    minBedrooms?: unknown;
    minBathrooms?: unknown;
    selectedAreas?: unknown;
    selectedBeaches?: unknown;
    selectedCommunities?: unknown;
    selectedFeatures?: unknown;
    minKingBeds?: unknown;
    minQueenBeds?: unknown;
    minBunkBeds?: unknown;
  } | null;

  const asStringArray = (value: unknown): string[] | undefined => {
    if (!Array.isArray(value)) {
      return undefined;
    }

    const out = value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => entry.length > 0);

    return out.length > 0 ? out : undefined;
  };

  return {
    includeSlug:
      typeof payload?.includeSlug === "string"
        ? payload.includeSlug.trim() || undefined
        : undefined,
    sortOption:
      typeof payload?.sortOption === "string"
        ? payload.sortOption.trim() || undefined
        : undefined,
    limit: toOptionalNumber(payload?.limit),
    offset: toOptionalNumber(payload?.offset),
    includeMetadata:
      typeof payload?.includeMetadata === "boolean"
        ? payload.includeMetadata
        : true,
    includeMapListings:
      typeof payload?.includeMapListings === "boolean"
        ? payload.includeMapListings
        : false,
    locationQuery:
      typeof payload?.locationQuery === "string"
        ? payload.locationQuery.trim() || undefined
        : undefined,
    minSleeps: toOptionalNumber(payload?.minSleeps),
    minBedrooms: toOptionalNumber(payload?.minBedrooms),
    minBathrooms: toOptionalNumber(payload?.minBathrooms),
    selectedAreas: asStringArray(payload?.selectedAreas),
    selectedBeaches: asStringArray(payload?.selectedBeaches),
    selectedCommunities: asStringArray(payload?.selectedCommunities),
    selectedFeatures: asStringArray(payload?.selectedFeatures),
    minKingBeds: toOptionalNumber(payload?.minKingBeds),
    minQueenBeds: toOptionalNumber(payload?.minQueenBeds),
    minBunkBeds: toOptionalNumber(payload?.minBunkBeds),
  };
}

function validateDiscoverSearchBounds(input: {
  limit?: number;
  offset?: number;
}) {
  const fieldErrors: Record<string, string[]> = {};
  const normalizedLimit = Number.isFinite(input.limit)
    ? Math.floor(input.limit as number)
    : DISCOVER_API_MAX_LIMIT;
  const normalizedOffset = Number.isFinite(input.offset)
    ? Math.floor(input.offset as number)
    : 0;

  if (Number.isFinite(input.limit)) {
    if (normalizedLimit < 1 || normalizedLimit > DISCOVER_API_MAX_LIMIT) {
      fieldErrors.limit = [
        `limit must be between 1 and ${DISCOVER_API_MAX_LIMIT}`,
      ];
    }
  }

  if (Number.isFinite(input.offset)) {
    if (normalizedOffset < 0) {
      fieldErrors.offset = ["offset must be greater than or equal to 0"];
    }
  }

  if (normalizedLimit + normalizedOffset > DISCOVER_API_MAX_LIMIT) {
    fieldErrors.pagination = [
      `limit + offset must be less than or equal to ${DISCOVER_API_MAX_LIMIT}`,
    ];
  }

  return Object.keys(fieldErrors).length > 0 ? fieldErrors : null;
}

export const Route = createFileRoute("/api/discover/listings")({
  component: NullRouteComponent,
  server: {
    handlers: {
      OPTIONS: async () => optionsResponse("POST, OPTIONS"),
      POST: async ({ request }) => {
        const parsedRequest = await parseSearchRequestFromBody(request);
        const boundsErrors = validateDiscoverSearchBounds({
          limit: parsedRequest.limit,
          offset: parsedRequest.offset,
        });

        if (boundsErrors) {
          return createAppErrorResponse(
            {
              code: "VALIDATION_FAILED",
              message: "Discover listings request bounds are invalid.",
              fieldErrors: boundsErrors,
            },
            400,
            createNoStoreHeaders(),
          );
        }

        const requestWithDefaults = stripUndefined({
          ...parsedRequest,
          includeMetadata: parsedRequest.includeMetadata ?? true,
          includeMapListings: parsedRequest.includeMapListings ?? false,
        });

        console.info("[discover:api] listings request", {
          request: requestWithDefaults,
        });

        const startedAtMs = Date.now();
        const payload = await executeDiscoverSearch(requestWithDefaults);
        const responseWithMeta =
          payload._meta && typeof payload._meta === "object"
            ? payload
            : {
                ...payload,
                _meta: {
                  generatedAt: new Date().toISOString(),
                  serverDurationMs: Math.max(0, Date.now() - startedAtMs),
                  request: requestWithDefaults,
                },
              };

        console.info("[discover:api] listings response", {
          source: responseWithMeta.source,
          stats: responseWithMeta._stats,
          serverDurationMs: responseWithMeta._meta?.serverDurationMs,
          effectiveRequest: responseWithMeta._meta?.request,
          listingsCount: responseWithMeta.listings.length,
          mapListingsCount: responseWithMeta.metadata?.mapListings?.length ?? 0,
        });

        return Response.json(responseWithMeta, {
          headers: createNoStoreHeaders(),
        });
      },
    },
  },
});
