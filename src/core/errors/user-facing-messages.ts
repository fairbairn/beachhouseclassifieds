export const USER_FACING_MESSAGES = {
  auth: {
    sessionExpired: "Your session expired. Please sign in again.",
    invalidCredentials: "Invalid email or password.",
    signInUnavailable: "Unable to sign in.",
    signOutUnavailable: "Unable to sign out.",
  },
  resource: {
    conflict: "A record with this value already exists.",
    notFound: "The selected record is no longer available.",
    createFailed: "Unable to create this record right now. Please try again.",
    deleteFailed: "Unable to delete this record right now. Please try again.",
  },
  validation: {
    invalidInput: "Please correct the highlighted fields.",
  },
  generic: {
    databaseError: "Unable to save changes right now. Please try again.",
    serviceUnavailable:
      "The service is temporarily unavailable. Please try again shortly.",
    networkError:
      "We can’t reach the server right now. Check your connection and try again.",
    timeoutError: "The request timed out. Please try again.",
    unknownError: "Something went wrong. Please try again.",
    methodNotAllowed: "Method not allowed.",
  },
} as const;
