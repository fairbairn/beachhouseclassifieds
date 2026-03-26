import { type AppSession, toAppSession } from "@/core/auth/session-model";

export function readSessionFromContext(
  value: unknown,
): AppSession | null | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  if ("user" in value) {
    return toAppSession(value);
  }

  const context = Reflect.get(value, "context");

  if (!context || typeof context !== "object") {
    return undefined;
  }

  const contextSession = Reflect.get(context, "session");
  return toAppSession(contextSession);
}

export async function getOptionalSession(options: {
  isServer: boolean;
  getServerSession: () => Promise<unknown>;
  getClientSession: () => Promise<{
    ok: boolean;
    session: unknown;
  }>;
}) {
  if (options.isServer) {
    return toAppSession(await options.getServerSession());
  }

  try {
    const response = await options.getClientSession();

    if (!response.ok) {
      return null;
    }

    return toAppSession(response.session ?? null);
  } catch {
    return null;
  }
}
