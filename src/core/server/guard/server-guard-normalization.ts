import {
  appErrorDefaultMessages,
  createAppError,
  parseAppError,
  type AppErrorCode,
  type AppErrorPayload,
} from "@/core/errors/app-errors";

function getUnknownErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function inferInfrastructureErrorCode(error: unknown): AppErrorCode {
  const message = getUnknownErrorMessage(error).toLowerCase();

  if (
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("aborterror")
  ) {
    return "TIMEOUT_ERROR";
  }

  if (
    message.includes("sqlite") ||
    message.includes("database") ||
    message.includes("no such table") ||
    message.includes("unable to open database file") ||
    message.includes("database is locked")
  ) {
    return "DATABASE_ERROR";
  }

  if (
    message.includes("failed to fetch") ||
    message.includes("network") ||
    message.includes("econnrefused") ||
    message.includes("ehostunreach") ||
    message.includes("enotfound") ||
    message.includes("socket hang up")
  ) {
    return "NETWORK_ERROR";
  }

  if (
    message.includes("service unavailable") ||
    message.includes("bad gateway") ||
    message.includes("gateway timeout")
  ) {
    return "SERVICE_UNAVAILABLE";
  }

  return "UNKNOWN_ERROR";
}

export function normalizeToAppErrorPayload(
  error: unknown,
  options?: {
    fallbackCode?: AppErrorCode;
  },
): AppErrorPayload {
  const existing = parseAppError(error);

  if (existing) {
    return existing;
  }

  const inferredCode = inferInfrastructureErrorCode(error);
  const code =
    inferredCode === "UNKNOWN_ERROR"
      ? (options?.fallbackCode ?? "UNKNOWN_ERROR")
      : inferredCode;

  return {
    code,
    message: appErrorDefaultMessages[code],
  };
}

export function normalizeToAppError(
  error: unknown,
  options?: {
    fallbackCode?: AppErrorCode;
  },
) {
  const existing = parseAppError(error);

  if (existing && error instanceof Error) {
    return error;
  }

  const payload = normalizeToAppErrorPayload(error, options);
  return createAppError(payload);
}

export function getHttpStatusForAppErrorCode(code: AppErrorCode) {
  switch (code) {
    case "AUTH_UNAUTHORIZED":
      return 401;
    case "VALIDATION_FAILED":
      return 400;
    case "RESOURCE_NOT_FOUND":
      return 404;
    case "DATABASE_ERROR":
    case "SERVICE_UNAVAILABLE":
    case "NETWORK_ERROR":
    case "TIMEOUT_ERROR":
      return 503;
    default:
      return 500;
  }
}
