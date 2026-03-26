import { createServerOnlyFn } from "@tanstack/react-start";

import { toAppSession } from "@/core/auth/session-model";
import { getSessionFromCurrentRequest } from "@/core/server/session";

const getServerSessionFromRuntime = createServerOnlyFn(async () => {
  return toAppSession(await getSessionFromCurrentRequest());
});

export async function getServerSession() {
  return getServerSessionFromRuntime();
}
