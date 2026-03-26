import {
  getAppErrorFromApiBody,
  getUserFacingAppErrorMessage,
} from "@/core/errors/app-errors";

type IssueKind = "network" | "service";

type Reporter = {
  reportServiceIssue: (options: { kind: IssueKind; message?: string }) => void;
  reportServiceRecovered: () => void;
};

type MessageCatalog = {
  auth: {
    signInUnavailable: string;
    signOutUnavailable: string;
  };
  generic: {
    databaseError: string;
    serviceUnavailable: string;
    networkError: string;
  };
};

type EndpointConfig = {
  login: string;
  logout: string;
  session: string;
};

type LoginPayload = {
  email: string;
  password: string;
};

const defaultEndpoints: EndpointConfig = {
  login: "/api/login",
  logout: "/api/logout",
  session: "/api/session",
};

export function createClientAuthProxy(options: {
  reporter: Reporter;
  messages: MessageCatalog;
  endpoints?: Partial<EndpointConfig>;
}) {
  const endpoints = {
    ...defaultEndpoints,
    ...options.endpoints,
  };

  return {
    async loginWithProxy(payload: LoginPayload) {
      try {
        const response = await fetch(endpoints.login, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
          },
          credentials: "same-origin",
          body: JSON.stringify(payload),
        });

        const body = (await response.json().catch(() => null)) as {
          message?: string;
          user?: {
            name?: string | null;
          };
        } | null;

        if (!response.ok) {
          const appError = getAppErrorFromApiBody(body);

          if (response.status >= 500) {
            options.reporter.reportServiceIssue({
              kind: "service",
              message:
                appError?.code === "DATABASE_ERROR"
                  ? options.messages.generic.databaseError
                  : options.messages.generic.serviceUnavailable,
            });
          }

          return {
            ok: false as const,
            status: response.status,
            message: getUserFacingAppErrorMessage(appError, {
              fallback:
                body?.message || options.messages.auth.signInUnavailable,
            }),
          };
        }

        options.reporter.reportServiceRecovered();

        return {
          ok: true as const,
          user: {
            name: body?.user?.name ?? null,
          },
        };
      } catch {
        options.reporter.reportServiceIssue({ kind: "network" });

        return {
          ok: false as const,
          status: 0,
          message: options.messages.generic.networkError,
        };
      }
    },

    async logoutWithProxy() {
      try {
        const response = await fetch(endpoints.logout, {
          method: "POST",
          headers: {
            accept: "application/json",
          },
          credentials: "same-origin",
        });

        const body = (await response.json().catch(() => null)) as {
          message?: string;
        } | null;

        const appError = getAppErrorFromApiBody(body);

        if (!response.ok && response.status >= 500) {
          options.reporter.reportServiceIssue({
            kind: "service",
            message:
              appError?.code === "DATABASE_ERROR"
                ? options.messages.generic.databaseError
                : options.messages.generic.serviceUnavailable,
          });
        }

        if (response.ok) {
          options.reporter.reportServiceRecovered();
        }

        return {
          ok: response.ok,
          status: response.status,
          message: response.ok
            ? null
            : getUserFacingAppErrorMessage(appError, {
                fallback:
                  body?.message || options.messages.auth.signOutUnavailable,
              }),
        };
      } catch {
        options.reporter.reportServiceIssue({ kind: "network" });

        return {
          ok: false,
          status: 0,
          message: options.messages.generic.networkError,
        };
      }
    },

    async getSessionWithProxy() {
      try {
        const response = await fetch(endpoints.session, {
          method: "GET",
          headers: {
            accept: "application/json",
          },
          credentials: "same-origin",
          cache: "no-store",
        });

        if (!response.ok) {
          if (response.status >= 500) {
            options.reporter.reportServiceIssue({ kind: "service" });
          }

          return {
            ok: false as const,
            session: null,
          };
        }

        const payload = (await response.json().catch(() => null)) as {
          session?: unknown;
        } | null;

        options.reporter.reportServiceRecovered();

        return {
          ok: true as const,
          session: payload?.session ?? null,
        };
      } catch {
        options.reporter.reportServiceIssue({ kind: "network" });

        return {
          ok: false as const,
          session: null,
        };
      }
    },
  };
}
