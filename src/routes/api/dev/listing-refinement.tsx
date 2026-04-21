import { createFileRoute } from "@tanstack/react-router";

import {
  NullRouteComponent,
  createNoStoreHeaders,
  methodNotAllowedResponse,
  optionsResponse,
} from "@/core/http/api-http";

function notAvailableResponse() {
  return Response.json(
    {
      error:
        "Listing refinement is CLI-only. Use npm scripts under src/lib/scripts instead of web routes.",
    },
    { status: 410, headers: createNoStoreHeaders() },
  );
}

export const Route = createFileRoute("/api/dev/listing-refinement")({
  component: NullRouteComponent,
  server: {
    handlers: {
      GET: async () => notAvailableResponse(),
      POST: async () => notAvailableResponse(),
      OPTIONS: async () => optionsResponse("GET, POST, OPTIONS"),
      DELETE: async () => methodNotAllowedResponse(),
      PUT: async () => methodNotAllowedResponse(),
      PATCH: async () => methodNotAllowedResponse(),
    },
  },
});
