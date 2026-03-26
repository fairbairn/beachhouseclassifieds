import { createAppErrorResponse } from "@/core/errors/app-errors";
import { USER_FACING_MESSAGES } from "@/core/errors/user-facing-messages";

export function NullRouteComponent() {
  return null;
}

export function createNoStoreHeaders() {
  return new Headers({
    "cache-control": "no-store",
  });
}

export function copySetCookieHeader(target: Headers, source: Headers) {
  const setCookie = source.get("set-cookie");
  if (setCookie) {
    target.set("set-cookie", setCookie);
  }
}

export async function parseJsonSafely(response: Response) {
  try {
    return await response.clone().json();
  } catch {
    return null;
  }
}

export function extractMessage(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object") {
    return fallback;
  }

  const message = Reflect.get(payload, "message");
  return typeof message === "string" && message.length > 0 ? message : fallback;
}

export function optionsResponse(allow: string) {
  return new Response(null, {
    status: 204,
    headers: {
      allow,
      "cache-control": "no-store",
    },
  });
}

export function methodNotAllowedResponse() {
  return createAppErrorResponse(
    {
      code: "UNKNOWN_ERROR",
      message: USER_FACING_MESSAGES.generic.methodNotAllowed,
    },
    405,
  );
}
