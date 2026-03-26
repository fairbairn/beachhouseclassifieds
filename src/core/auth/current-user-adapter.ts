import { createServerOnlyFn } from "@tanstack/react-start";

import { createAppError } from "@/core/errors/app-errors";
import { USER_FACING_MESSAGES } from "@/core/errors/user-facing-messages";
import { getSessionFromCurrentRequest } from "@/core/server/session";

const getCurrentUserId = createServerOnlyFn(async () => {
  const session = await getSessionFromCurrentRequest();
  const userId = session?.user?.id;

  if (!userId) {
    throw createAppError({
      code: "AUTH_UNAUTHORIZED",
      message: USER_FACING_MESSAGES.auth.sessionExpired,
    });
  }

  return userId;
});

export async function requireCurrentUserId() {
  return getCurrentUserId();
}
