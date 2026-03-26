import { z } from "zod";

import { USER_FACING_MESSAGES } from "@/core/errors/user-facing-messages";

const APP_ERROR_PREFIX = "APP_ERROR:";

export type AppErrorCode =
  | "AUTH_UNAUTHORIZED"
  | "RESOURCE_CONFLICT"
  | "RESOURCE_NOT_FOUND"
  | "VALIDATION_FAILED"
  | "DATABASE_ERROR"
  | "SERVICE_UNAVAILABLE"
  | "NETWORK_ERROR"
  | "TIMEOUT_ERROR"
  | "UNKNOWN_ERROR";

export type AppErrorPayload = {
  code: AppErrorCode;
  message: string;
  fieldErrors?: Record<string, string[]>;
};

const appErrorPayloadSchema: z.ZodType<AppErrorPayload> = z.object({
  code: z.enum([
    "AUTH_UNAUTHORIZED",
    "RESOURCE_CONFLICT",
    "RESOURCE_NOT_FOUND",
    "VALIDATION_FAILED",
    "DATABASE_ERROR",
    "SERVICE_UNAVAILABLE",
    "NETWORK_ERROR",
    "TIMEOUT_ERROR",
    "UNKNOWN_ERROR",
  ]),
  message: z.string(),
  fieldErrors: z.record(z.string(), z.array(z.string())).optional(),
});

export const appErrorDefaultMessages: Record<AppErrorCode, string> = {
  AUTH_UNAUTHORIZED: USER_FACING_MESSAGES.auth.sessionExpired,
  RESOURCE_CONFLICT: USER_FACING_MESSAGES.resource.conflict,
  RESOURCE_NOT_FOUND: USER_FACING_MESSAGES.resource.notFound,
  VALIDATION_FAILED: USER_FACING_MESSAGES.validation.invalidInput,
  DATABASE_ERROR: USER_FACING_MESSAGES.generic.databaseError,
  SERVICE_UNAVAILABLE: USER_FACING_MESSAGES.generic.serviceUnavailable,
  NETWORK_ERROR: USER_FACING_MESSAGES.generic.networkError,
  TIMEOUT_ERROR: USER_FACING_MESSAGES.generic.timeoutError,
  UNKNOWN_ERROR: USER_FACING_MESSAGES.generic.unknownError,
};

export function createAppError(payload: AppErrorPayload) {
  return new Error(`${APP_ERROR_PREFIX}${JSON.stringify(payload)}`);
}

export function parseAppError(error: unknown): AppErrorPayload | null {
  const message = error instanceof Error ? error.message : String(error);

  if (!message.startsWith(APP_ERROR_PREFIX)) {
    return null;
  }

  try {
    const parsed = JSON.parse(message.slice(APP_ERROR_PREFIX.length));
    return parseAppErrorPayload(parsed);
  } catch {
    return null;
  }
}

export function parseAppErrorPayload(value: unknown): AppErrorPayload | null {
  const parsed = appErrorPayloadSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function getAppErrorFromApiBody(body: unknown) {
  if (!body || typeof body !== "object") {
    return null;
  }

  const nested = parseAppErrorPayload(Reflect.get(body, "error"));
  if (nested) {
    return nested;
  }

  return parseAppErrorPayload(body);
}

export function createAppErrorResponse(
  payload: AppErrorPayload,
  status: number,
  headers?: HeadersInit,
) {
  return Response.json(
    {
      error: payload,
      message: payload.message,
    },
    {
      status,
      headers,
    },
  );
}

export function getUserFacingAppErrorMessage(
  payload: AppErrorPayload | null,
  options: {
    fallback: string;
    fieldName?: string;
    codeMessages?: Partial<Record<AppErrorCode, string>>;
  },
) {
  if (!payload) {
    return options.fallback;
  }

  if (options.fieldName) {
    const fieldMessage = payload.fieldErrors?.[options.fieldName]?.[0];
    if (fieldMessage) {
      return fieldMessage;
    }
  }

  const overrideMessage = options.codeMessages?.[payload.code];
  if (overrideMessage) {
    return overrideMessage;
  }

  if (payload.message) {
    return payload.message;
  }

  return appErrorDefaultMessages[payload.code] ?? options.fallback;
}

export function getUserFacingThrownErrorMessage(
  error: unknown,
  options: {
    fallback: string;
    fieldName?: string;
    codeMessages?: Partial<Record<AppErrorCode, string>>;
  },
) {
  const payload = parseAppError(error);
  return getUserFacingAppErrorMessage(payload, options);
}

export function validateOrThrowAppError<T>(
  schema: z.ZodType<T>,
  input: unknown,
): T {
  const parsed = schema.safeParse(input);

  if (parsed.success) {
    return parsed.data;
  }

  const rawFieldErrors = parsed.error.flatten().fieldErrors;
  const fieldErrors = Object.fromEntries(
    Object.entries(rawFieldErrors).filter(([, value]) => value !== undefined),
  ) as Record<string, string[]>;

  throw createAppError({
    code: "VALIDATION_FAILED",
    message: appErrorDefaultMessages.VALIDATION_FAILED,
    fieldErrors,
  });
}
