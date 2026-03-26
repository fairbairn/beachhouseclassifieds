import { createFileRoute } from "@tanstack/react-router";

import { createAppErrorResponse } from "@/core/errors/app-errors";
import { USER_FACING_MESSAGES } from "@/core/errors/user-facing-messages";
import {
  NullRouteComponent,
  copySetCookieHeader,
  createNoStoreHeaders,
  extractMessage,
  methodNotAllowedResponse,
  optionsResponse,
  parseJsonSafely,
} from "@/core/http/api-http";
import { auth } from "@/core/server/auth";
import {
  getHttpStatusForAppErrorCode,
  normalizeToAppErrorPayload,
} from "@/core/server/guard/server-guard-normalization";

export const Route = createFileRoute("/api/logout")({
  component: NullRouteComponent,
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const signOutResponse = await auth.api.signOut({
            headers: request.headers,
            asResponse: true,
          });

          const signOutPayload = await parseJsonSafely(signOutResponse);
          const responseHeaders = createNoStoreHeaders();
          copySetCookieHeader(responseHeaders, signOutResponse.headers);

          if (!signOutResponse.ok) {
            return createAppErrorResponse(
              {
                code:
                  signOutResponse.status === 401
                    ? "AUTH_UNAUTHORIZED"
                    : "UNKNOWN_ERROR",
                message: extractMessage(
                  signOutPayload,
                  USER_FACING_MESSAGES.auth.signOutUnavailable,
                ),
              },
              signOutResponse.status,
              responseHeaders,
            );
          }

          return Response.json(
            {
              ok: true,
            },
            {
              headers: responseHeaders,
            },
          );
        } catch (error) {
          const appError = normalizeToAppErrorPayload(error, {
            fallbackCode: "SERVICE_UNAVAILABLE",
          });

          return createAppErrorResponse(
            {
              ...appError,
              message:
                appError.code === "AUTH_UNAUTHORIZED"
                  ? USER_FACING_MESSAGES.auth.sessionExpired
                  : appError.message,
            },
            getHttpStatusForAppErrorCode(appError.code),
          );
        }
      },
      OPTIONS: async () => optionsResponse("POST, OPTIONS"),
      GET: async () => methodNotAllowedResponse(),
    },
  },
});
