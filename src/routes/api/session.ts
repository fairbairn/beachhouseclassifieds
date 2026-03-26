import { createFileRoute } from "@tanstack/react-router";

import { getOptionalSession } from "@/core/auth/auth-guards";
import { createAppErrorResponse } from "@/core/errors/app-errors";
import {
  NullRouteComponent,
  createNoStoreHeaders,
  methodNotAllowedResponse,
  optionsResponse,
} from "@/core/http/api-http";
import {
  getHttpStatusForAppErrorCode,
  normalizeToAppErrorPayload,
} from "@/core/server/guard/server-guard-normalization";

export const Route = createFileRoute("/api/session")({
  component: NullRouteComponent,
  server: {
    handlers: {
      GET: async () => {
        try {
          const session = await getOptionalSession();

          return Response.json(
            {
              session,
            },
            {
              headers: createNoStoreHeaders(),
            },
          );
        } catch (error) {
          const appError = normalizeToAppErrorPayload(error, {
            fallbackCode: "SERVICE_UNAVAILABLE",
          });

          return createAppErrorResponse(
            appError,
            getHttpStatusForAppErrorCode(appError.code),
            createNoStoreHeaders(),
          );
        }
      },
      OPTIONS: async () => optionsResponse("GET, OPTIONS"),
      POST: async () => methodNotAllowedResponse(),
    },
  },
});
