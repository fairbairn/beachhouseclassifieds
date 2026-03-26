import { createServiceHealthStore } from "@/core/client/guard/service-health-store";
import { USER_FACING_MESSAGES } from "@/core/errors/user-facing-messages";

const serviceHealth = createServiceHealthStore({
  issueMessages: {
    network: USER_FACING_MESSAGES.generic.networkError,
    database: USER_FACING_MESSAGES.generic.databaseError,
    timeout: USER_FACING_MESSAGES.generic.timeoutError,
    service: USER_FACING_MESSAGES.generic.serviceUnavailable,
  },
  recoveredMessage: "Connection restored. You can keep working.",
});

export const serviceHealthStore = serviceHealth.serviceHealthStore;
export const reportServiceIssue = serviceHealth.reportServiceIssue;
export const reportServiceRecovered = serviceHealth.reportServiceRecovered;
export const dismissServiceHealthNotice =
  serviceHealth.dismissServiceHealthNotice;
export const clearServiceHealthState = serviceHealth.clearServiceHealthState;
