import { getRequest } from "@tanstack/react-start/server";

import { auth } from "@/core/server/auth";
import { getEffectiveUserTimeZoneByUserId } from "@/core/server/user-time-zone";

// Server-only helper: resolve session from the active request context.
export async function getSessionFromCurrentRequest() {
  const request = getRequest();

  // Some execution paths may not have an active request object.
  if (!request) {
    return null;
  }

  // Better Auth resolves user/session from request cookies and headers.
  const session = await auth.api.getSession({
    headers: request.headers,
  });

  if (!session?.user) {
    return session ?? null;
  }

  const userId =
    typeof session.user.id === "string" ? session.user.id.trim() : "";

  if (!userId) {
    return session;
  }

  const timeZone = await getEffectiveUserTimeZoneByUserId(userId);

  return {
    ...session,
    user: {
      ...session.user,
      timeZone,
    },
  };
}
