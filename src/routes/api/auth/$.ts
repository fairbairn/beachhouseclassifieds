import { createFileRoute } from "@tanstack/react-router";

import { NullRouteComponent } from "@/core/http/api-http";
import { isAuthRuntimeEnabled } from "@/core/server/auth-runtime-enabled";

export const Route = createFileRoute("/api/auth/$")({
  component: NullRouteComponent,
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthRuntimeEnabled()) {
          return Response.json(
            {
              code: "SERVICE_UNAVAILABLE",
              message: "Authentication runtime is disabled.",
            },
            { status: 503 },
          );
        }

        const { auth } = await import("@/core/server/auth");
        return auth.handler(request);
      },
      POST: async ({ request }) => {
        if (!isAuthRuntimeEnabled()) {
          return Response.json(
            {
              code: "SERVICE_UNAVAILABLE",
              message: "Authentication runtime is disabled.",
            },
            { status: 503 },
          );
        }

        const { auth } = await import("@/core/server/auth");
        return auth.handler(request);
      },
    },
  },
});
