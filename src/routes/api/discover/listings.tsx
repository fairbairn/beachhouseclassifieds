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

export const Route = createFileRoute("/api/discover/listings")({
  component: NullRouteComponent,
  server: {
    handlers: {
      GET: async () => {
        const locationAlignedListings = sampleListings.map((listing) => {
          const beachZone = getBeachZoneFromListing(listing);
          if (!beachZone) {
            return verifyGulfFrontClaim(listing);
          }

          return verifyGulfFrontClaim({
            ...listing,
            area: beachZone,
          });
        });

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
