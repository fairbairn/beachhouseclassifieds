import { createFileRoute } from "@tanstack/react-router";

import {
  NullRouteComponent,
  createNoStoreHeaders,
  optionsResponse,
} from "@/core/http/api-http";
import { buildDiscoverListingDetailPayload } from "@/lib/discover/discover-listings-api.server";
import { runDiscoverQuoteBySlug } from "@/lib/discover/discover-quote.server";

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
      OPTIONS: async () => optionsResponse("GET, POST, OPTIONS"),
      POST: async ({ params, request }) => {
        const slug = typeof params.slug === "string" ? params.slug.trim() : "";
        const body = (await request.json().catch(() => null)) as {
          in?: unknown;
          out?: unknown;
          adults?: unknown;
          kids?: unknown;
        } | null;

        const payload = await runDiscoverQuoteBySlug({
          slug,
          in: typeof body?.in === "string" ? body.in.trim() : "",
          out: typeof body?.out === "string" ? body.out.trim() : "",
          adults: body?.adults,
          kids: body?.kids,
        });

        return Response.json(payload, {
          status: payload.ok ? 200 : 400,
          headers: createNoStoreHeaders(),
        });
      },
    },
  },
});
