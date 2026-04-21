import { createFileRoute } from "@tanstack/react-router";

import {
  NullRouteComponent,
  createNoStoreHeaders,
  optionsResponse,
} from "@/core/http/api-http";
import { executeDiscoverFacets } from "@/lib/discover/discover-search-service.server";
import type { DiscoverFacetsRequest } from "@/lib/discover/discover-types";

async function parseFacetsRequestFromBody(
  request: Request,
): Promise<DiscoverFacetsRequest> {
  const payload = (await request
    .json()
    .catch(() => null)) as DiscoverFacetsRequest | null;

  if (!payload || typeof payload !== "object") {
    return {};
  }

  return payload;
}

export const Route = createFileRoute("/api/discover/facets")({
  component: NullRouteComponent,
  server: {
    handlers: {
      POST: async ({ request }) => {
        const payload = await executeDiscoverFacets(
          await parseFacetsRequestFromBody(request),
        );

        return Response.json(payload, {
          headers: createNoStoreHeaders(),
        });
      },
      OPTIONS: async () => optionsResponse("POST, OPTIONS"),
    },
  },
});
