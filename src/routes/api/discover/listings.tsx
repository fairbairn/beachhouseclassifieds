import { createFileRoute } from "@tanstack/react-router";

import { sampleListings } from "@/components/discover/discover-data";
import {
  getBeachZoneFromListing,
  verifyGulfFrontClaim,
} from "@/components/discover/discover-utils";
import {
  NullRouteComponent,
  createNoStoreHeaders,
  methodNotAllowedResponse,
  optionsResponse,
} from "@/core/http/api-http";
import { normalizeDiscoverListings } from "@/lib/discover/community-normalization";
import { getDiscoverListings } from "@/lib/discover/discover-listings.server";

export const Route = createFileRoute("/api/discover/listings")({
  component: NullRouteComponent,
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const includeSlug =
          url.searchParams.get("include")?.trim() || undefined;
        const sourceListings = await getDiscoverListings({
          includeSlug,
          onlySlug: Boolean(includeSlug),
          disableFallback: true,
        }).catch(() => []);

        const resolvedSourceListings = includeSlug
          ? sourceListings
          : sourceListings.length > 0
            ? sourceListings
            : sampleListings;

        const locationAlignedListings = resolvedSourceListings.map(
          (listing) => {
            const beachZone = getBeachZoneFromListing(listing);
            if (!beachZone) {
              return verifyGulfFrontClaim(listing);
            }

            return verifyGulfFrontClaim({
              ...listing,
              area: beachZone,
            });
          },
        );

        const normalizedListings = normalizeDiscoverListings(
          locationAlignedListings,
        );

        const listings = [...normalizedListings].sort((a, b) => {
          if (a.demoOrder !== b.demoOrder) {
            return a.demoOrder - b.demoOrder;
          }
          return a.id.localeCompare(b.id);
        });

        return Response.json(
          { listings },
          {
            headers: createNoStoreHeaders(),
          },
        );
      },
      OPTIONS: async () => optionsResponse("GET, OPTIONS"),
      POST: async () => methodNotAllowedResponse(),
    },
  },
});
