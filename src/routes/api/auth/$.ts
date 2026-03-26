import { createFileRoute } from "@tanstack/react-router";

import { NullRouteComponent } from "@/core/http/api-http";
import { auth } from "@/core/server/auth";

export const Route = createFileRoute("/api/auth/$")({
  component: NullRouteComponent,
  server: {
    handlers: {
      GET: async ({ request }) => auth.handler(request),
      POST: async ({ request }) => auth.handler(request),
    },
  },
});
