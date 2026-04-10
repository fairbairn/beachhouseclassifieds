import { createFileRoute } from "@tanstack/react-router";

import { sampleListings } from "@/components/discover/discover-data";
import {
  NullRouteComponent,
  createNoStoreHeaders,
  methodNotAllowedResponse,
  optionsResponse,
} from "@/core/http/api-http";

export const Route = createFileRoute("/api/discover/listings")({
  component: NullRouteComponent,
  server: {
    handlers: {
      GET: async () => {
        const listings = [...sampleListings].sort((a, b) => {
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
