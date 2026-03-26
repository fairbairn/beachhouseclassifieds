import { type AppErrorPayload } from "@/core/errors/app-errors";

type ServiceIssueKind = "network" | "service" | "database" | "timeout";

type ServiceReporter = {
  reportServiceIssue: (options: {
    kind: ServiceIssueKind;
    message?: string;
  }) => void;
  reportServiceRecovered: () => void;
};

function isNetworkLikeUnknownError(error: unknown) {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error);

  return (
    message.includes("failed to fetch") ||
    message.includes("network") ||
    message.includes("abort")
  );
}

export function createClientGuardErrorReporter(options: {
  parseAppError: (error: unknown) => AppErrorPayload | null;
  reporter: ServiceReporter;
}) {
  function reportClientGuardError(error: unknown) {
    const appError = options.parseAppError(error);

    if (!appError) {
      if (isNetworkLikeUnknownError(error)) {
        options.reporter.reportServiceIssue({ kind: "network" });
      }

      return;
    }

    switch (appError.code) {
      case "DATABASE_ERROR":
        options.reporter.reportServiceIssue({
          kind: "database",
          message: appError.message,
        });
        break;
      case "SERVICE_UNAVAILABLE":
        options.reporter.reportServiceIssue({
          kind: "service",
          message: appError.message,
        });
        break;
      case "NETWORK_ERROR":
        options.reporter.reportServiceIssue({
          kind: "network",
          message: appError.message,
        });
        break;
      case "TIMEOUT_ERROR":
        options.reporter.reportServiceIssue({
          kind: "timeout",
          message: appError.message,
        });
        break;
      default:
        break;
    }
  }

  function reportClientGuardRecovered() {
    options.reporter.reportServiceRecovered();
  }

  return {
    reportClientGuardError,
    reportClientGuardRecovered,
  };
}
