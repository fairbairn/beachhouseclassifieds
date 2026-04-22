import { createFileRoute } from "@tanstack/react-router";

import {
  NullRouteComponent,
  createNoStoreHeaders,
  optionsResponse,
} from "@/core/http/api-http";
import { executeDiscoverSearch } from "@/lib/discover/discover-search-service.server";

async function parseSearchRequestFromBody(request: Request) {
  const payload = (await request.json().catch(() => null)) as {
    includeSlug?: unknown;
    limit?: unknown;
    offset?: unknown;
    includeMetadata?: unknown;
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
    limit:
      typeof payload?.limit === "number"
        ? payload.limit
        : typeof payload?.limit === "string"
          ? Number(payload.limit)
          : Number.NaN,
    offset:
      typeof payload?.offset === "number"
        ? payload.offset
        : typeof payload?.offset === "string"
          ? Number(payload.offset)
          : Number.NaN,
    includeMetadata:
      typeof payload?.includeMetadata === "boolean"
        ? payload.includeMetadata
        : true,
    selectedAreas: asStringArray(payload?.selectedAreas),
    selectedBeaches: asStringArray(payload?.selectedBeaches),
    selectedCommunities: asStringArray(payload?.selectedCommunities),
    selectedFeatures: asStringArray(payload?.selectedFeatures),
    minKingBeds:
      typeof payload?.minKingBeds === "number"
        ? payload.minKingBeds
        : typeof payload?.minKingBeds === "string"
          ? Number(payload.minKingBeds)
          : Number.NaN,
    minQueenBeds:
      typeof payload?.minQueenBeds === "number"
        ? payload.minQueenBeds
        : typeof payload?.minQueenBeds === "string"
          ? Number(payload.minQueenBeds)
          : Number.NaN,
    minBunkBeds:
      typeof payload?.minBunkBeds === "number"
        ? payload.minBunkBeds
        : typeof payload?.minBunkBeds === "string"
          ? Number(payload.minBunkBeds)
          : Number.NaN,
  };
}

export const Route = createFileRoute("/api/discover/listings")({
  component: NullRouteComponent,
  server: {
    handlers: {
      OPTIONS: async () => optionsResponse("POST, OPTIONS"),
      POST: async ({ request }) => {
        const payload = await executeDiscoverSearch(
          await parseSearchRequestFromBody(request),
        );

        return Response.json(payload, {
          headers: createNoStoreHeaders(),
        });
      },
    },
  },
});
