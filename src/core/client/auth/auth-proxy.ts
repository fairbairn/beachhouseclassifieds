import { createClientAuthProxy } from "@/core/client/auth/auth-proxy-factory";
import {
  reportServiceIssue,
  reportServiceRecovered,
} from "@/core/client/guard/client-service-health";
import { USER_FACING_MESSAGES } from "@/core/errors/user-facing-messages";

const authProxy = createClientAuthProxy({
  reporter: {
    reportServiceIssue,
    reportServiceRecovered,
  },
  messages: {
    auth: {
      signInUnavailable: USER_FACING_MESSAGES.auth.signInUnavailable,
      signOutUnavailable: USER_FACING_MESSAGES.auth.signOutUnavailable,
    },
    generic: {
      databaseError: USER_FACING_MESSAGES.generic.databaseError,
      serviceUnavailable: USER_FACING_MESSAGES.generic.serviceUnavailable,
      networkError: USER_FACING_MESSAGES.generic.networkError,
    },
  },
});

export const loginWithProxy = authProxy.loginWithProxy;
export const logoutWithProxy = authProxy.logoutWithProxy;
export const getSessionWithProxy = authProxy.getSessionWithProxy;
