import { createFileRoute } from "@tanstack/react-router";

import {
  NullRouteComponent,
  createNoStoreHeaders,
  methodNotAllowedResponse,
  optionsResponse,
} from "@/core/http/api-http";
import { buildDiscoverListingDetailPayload } from "@/lib/discover/discover-listings-api.server";

export const Route = createFileRoute("/api/discover/listings/$slug")({
  component: NullRouteComponent,
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const slugFromParams =
          typeof params.slug === "string" ? params.slug.trim() : "";
        const slugFromUrl = (() => {
          const pathname = new URL(request.url).pathname;
          const segments = pathname.split("/").filter(Boolean);
          const last = segments[segments.length - 1];
          if (!last) {
            return "";
          }
          try {
            return decodeURIComponent(last).trim();
          } catch {
            return last.trim();
          }
        })();

        const payload = await buildDiscoverListingDetailPayload({
          slug: slugFromParams || slugFromUrl,
        });

        return Response.json(payload, {
          headers: createNoStoreHeaders(),
        });
      },
      OPTIONS: async () => optionsResponse("GET, OPTIONS"),
      POST: async () => methodNotAllowedResponse(),
    },
  },
});
