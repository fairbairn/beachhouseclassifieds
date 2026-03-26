import { createClientGuardErrorReporter } from "@/core/client/guard/client-guard-errors-factory";
import {
  reportServiceIssue,
  reportServiceRecovered,
} from "@/core/client/guard/client-service-health";
import { parseAppError } from "@/core/errors/app-errors";

const reporter = createClientGuardErrorReporter({
  parseAppError,
  reporter: {
    reportServiceIssue,
    reportServiceRecovered,
  },
});

export const reportClientGuardError = reporter.reportClientGuardError;
export const reportClientGuardRecovered = reporter.reportClientGuardRecovered;
