import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import {
  appErrorDefaultMessages,
  createAppErrorResponse,
} from "@/core/errors/app-errors";
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

const loginPayloadSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

export const Route = createFileRoute("/api/login")({
  component: NullRouteComponent,
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = (await request.json().catch(() => null)) as unknown;
          const parsedPayload = loginPayloadSchema.safeParse(body);

          if (!parsedPayload.success) {
            const fieldErrors = Object.fromEntries(
              Object.entries(parsedPayload.error.flatten().fieldErrors).filter(
                ([, value]) => value !== undefined,
              ),
            ) as Record<string, string[]>;

            return createAppErrorResponse(
              {
                code: "VALIDATION_FAILED",
                message: appErrorDefaultMessages.VALIDATION_FAILED,
                fieldErrors,
              },
              400,
            );
          }

          const signInResponse = await auth.api.signInEmail({
            body: parsedPayload.data,
            headers: request.headers,
            asResponse: true,
          });

          const signInPayload = await parseJsonSafely(signInResponse);
          const responseHeaders = createNoStoreHeaders();
          copySetCookieHeader(responseHeaders, signInResponse.headers);

          if (!signInResponse.ok) {
            const fallbackMessage =
              signInResponse.status === 401
                ? USER_FACING_MESSAGES.auth.invalidCredentials
                : USER_FACING_MESSAGES.auth.signInUnavailable;

            return createAppErrorResponse(
              {
                code:
                  signInResponse.status === 401
                    ? "AUTH_UNAUTHORIZED"
                    : "UNKNOWN_ERROR",
                message: extractMessage(signInPayload, fallbackMessage),
              },
              signInResponse.status,
              responseHeaders,
            );
          }

          const user =
            signInPayload && typeof signInPayload === "object"
              ? Reflect.get(signInPayload, "user")
              : null;
          const name =
            user && typeof user === "object" ? Reflect.get(user, "name") : null;

          return Response.json(
            {
              ok: true,
              user: {
                name: typeof name === "string" ? name : null,
              },
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
                  ? USER_FACING_MESSAGES.auth.invalidCredentials
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
