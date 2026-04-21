import { createFileRoute } from "@tanstack/react-router";

import {
  NullRouteComponent,
  createNoStoreHeaders,
  optionsResponse,
} from "@/core/http/api-http";
import { executeDiscoverSearch } from "@/lib/discover/discover-search-service.server";

function parseSearchRequestFromUrl(request: Request) {
  const url = new URL(request.url);
  return {
    includeSlug: url.searchParams.get("include")?.trim() || undefined,
    limit: Number(url.searchParams.get("limit") ?? ""),
    cursor: url.searchParams.get("cursor")?.trim() || undefined,
  };
}

async function parseSearchRequestFromBody(request: Request) {
  const payload = (await request.json().catch(() => null)) as {
    includeSlug?: unknown;
    limit?: unknown;
    cursor?: unknown;
  } | null;

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
    cursor:
      typeof payload?.cursor === "string"
        ? payload.cursor.trim() || undefined
        : undefined,
  };
}

export const Route = createFileRoute("/api/discover/listings")({
  component: NullRouteComponent,
  server: {
    handlers: {
      GET: async ({ request }) => {
        const payload = await executeDiscoverSearch(
          parseSearchRequestFromUrl(request),
        );

        return Response.json(payload, {
          headers: createNoStoreHeaders(),
        });
      },
      OPTIONS: async () => optionsResponse("GET, POST, OPTIONS"),
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
