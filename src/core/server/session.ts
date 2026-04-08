import { getRequest } from "@tanstack/react-start/server";

import { isAuthRuntimeEnabled } from "@/core/server/auth-runtime-enabled";

// Server-only helper: resolve session from the active request context.
export async function getSessionFromCurrentRequest() {
  if (!isAuthRuntimeEnabled()) {
    return null;
  }

  const request = getRequest();

  // Some execution paths may not have an active request object.
  if (!request) {
    return null;
  }

  const [{ auth }, { getEffectiveUserTimeZoneByUserId }] = await Promise.all([
    import("@/core/server/auth"),
    import("@/core/server/user-time-zone"),
  ]);

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
