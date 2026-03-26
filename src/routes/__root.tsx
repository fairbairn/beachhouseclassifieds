import {
  HeadContent,
  Scripts,
  createRootRoute,
  useRouterState,
} from "@tanstack/react-router";
import type { ReactNode } from "react";

import { AppHeader } from "@/components/AppHeader";
import { LoginHeader } from "@/components/LoginHeader";
import { getOptionalSession } from "@/core/auth/auth-guards";
import { APP_CONTAINER_CLASS } from "@/core/ui/layout";
import appCss from "@/styles.css?url";
import tweaksCss from "@/tweaks.css?url";

const appName = import.meta.env.VITE_APP_NAME ?? "BeachHouseClassifieds";

export const Route = createRootRoute({
  beforeLoad: async () => ({
    session: await getOptionalSession(),
  }),
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: appName },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "stylesheet", href: tweaksCss },
    ],
  }),
  shellComponent: RootDocument,
  notFoundComponent: () => (
    <div className={APP_CONTAINER_CLASS} style={{ paddingTop: "2rem" }}>
      Page not found.
    </div>
  ),
});

function RootDocument({ children }: { children: ReactNode }) {
  const { session } = Route.useRouteContext();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const isLoginPage = pathname === "/login";
  const header = isLoginPage ? (
    <LoginHeader appName={appName} />
  ) : (
    <AppHeader appName={appName} userName={session?.user?.name} />
  );

  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {header}
        <main className={isLoginPage ? "app-main app-main-login" : "app-main"}>
          {children}
        </main>
        <Scripts />
      </body>
    </html>
  );
}
