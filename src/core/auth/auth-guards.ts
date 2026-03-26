import { redirect } from "@tanstack/react-router";

import {
  readSessionFromContext,
  getOptionalSession as resolveOptionalSession,
} from "@/core/auth/session-access";
import { getServerSession } from "@/core/auth/session-adapter";
import { getSessionWithProxy } from "@/core/client/auth/auth-proxy";
import { CORE_ROUTE_PATHS } from "@/core/paths/core-paths";

export type AuthGuardPaths = {
  home: string;
  login: string;
};

function resolveAuthGuardPaths(
  paths?: Partial<AuthGuardPaths>,
): AuthGuardPaths {
  return {
    home: paths?.home ?? CORE_ROUTE_PATHS.home,
    login: paths?.login ?? CORE_ROUTE_PATHS.login,
  };
}

export function createAuthGuards(options?: {
  paths?: Partial<AuthGuardPaths>;
  isServer?: () => boolean;
  getServerSession?: () => Promise<unknown>;
  getClientSession?: () => Promise<{
    ok: boolean;
    session: unknown;
  }>;
}) {
  const paths = resolveAuthGuardPaths(options?.paths);
  const isServer = options?.isServer ?? (() => import.meta.env.SSR);
  const resolveServerSession = options?.getServerSession ?? getServerSession;
  const resolveClientSession = options?.getClientSession ?? getSessionWithProxy;

  async function getOptionalSession() {
    return resolveOptionalSession({
      isServer: isServer(),
      getServerSession: resolveServerSession,
      getClientSession: resolveClientSession,
    });
  }

  async function requireSession(value?: unknown) {
    const contextSession = readSessionFromContext(value);
    const session = contextSession ?? (await getOptionalSession());

    if (!session?.user) {
      throw redirect({ to: paths.login });
    }

    return session;
  }

  async function redirectIfSessionExists(value?: unknown) {
    const contextSession = readSessionFromContext(value);
    const session = contextSession ?? (await getOptionalSession());

    if (session?.user) {
      throw redirect({ to: paths.home });
    }
  }

  return {
    getOptionalSession,
    requireSession,
    redirectIfSessionExists,
  };
}

const defaultAuthGuards = createAuthGuards();

export const getOptionalSession = defaultAuthGuards.getOptionalSession;
export const requireSession = defaultAuthGuards.requireSession;
export const redirectIfSessionExists =
  defaultAuthGuards.redirectIfSessionExists;
