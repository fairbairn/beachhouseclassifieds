import { createFileRoute } from "@tanstack/react-router";

import {
  NullRouteComponent,
  createNoStoreHeaders,
  methodNotAllowedResponse,
  optionsResponse,
} from "@/core/http/api-http";
import {
  buildDiscoverListingsPagePayload,
  buildDiscoverListingsPayload,
} from "@/lib/discover/discover-listings-api.server";

export const Route = createFileRoute("/api/discover/listings")({
  component: NullRouteComponent,
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const includeSlug =
          url.searchParams.get("include")?.trim() || undefined;
        const limit = Number(url.searchParams.get("limit") ?? "");
        const cursor = url.searchParams.get("cursor")?.trim() || undefined;

        if (includeSlug) {
          const listings = await buildDiscoverListingsPayload({ includeSlug });

          return Response.json(
            {
              _stats: {
                nextCursor: null,
                hasMore: false,
                totalCount: listings.length,
                metadata: {
                  totalCount: listings.length,
                  mapListings: listings.map((listing) => ({
                    id: listing.id,
                    name: listing.name,
                    lat: listing.lat,
                    lng: listing.lng,
                    typicalAllInNightly: listing.typicalAllInNightly,
                  })),
                  facets: {
                    areas: {},
                    beaches: {},
                    communities: {},
                    features: {
                      gulfFront: listings.filter(
                        (listing) => listing.beachfront,
                      ).length,
                      privatePool: listings.filter(
                        (listing) => listing.privatePool,
                      ).length,
                      golfCart: listings.filter((listing) => listing.golfCart)
                        .length,
                    },
                  },
                },
              },
              listings,
            },
            {
              headers: createNoStoreHeaders(),
            },
          );
        }

        const payload = await buildDiscoverListingsPagePayload({
          limit,
          cursor,
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
