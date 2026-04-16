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

const appName = import.meta.env.VITE_APP_NAME ?? "30A Collections";
const siteUrl = (
  import.meta.env.VITE_SITE_URL ?? "https://30acollections.com"
).replace(/\/$/, "");
const siteTitle = "30A Collections | Discover 30A Vacation Rentals";
const siteDescription =
  "30A Collections helps families discover the right 30A vacation rental with clearer stay-total pricing, curated inventory, and direct host booking handoff.";
const siteKeywords =
  "30A vacation rentals, Santa Rosa Beach rentals, Rosemary Beach rentals, Seaside Florida rentals, family beach vacation homes, Emerald Coast vacation homes, direct booking vacation rentals";

export const Route = createRootRoute({
  beforeLoad: async () => ({
    session: await getOptionalSession(),
  }),
  head: () => ({
    meta: [
      { title: siteTitle },
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { name: "description", content: siteDescription },
      { name: "keywords", content: siteKeywords },
      { name: "author", content: appName },
      { name: "robots", content: "index, follow" },
      { property: "og:site_name", content: appName },
      { property: "og:type", content: "website" },
      { property: "og:title", content: siteTitle },
      { property: "og:description", content: siteDescription },
      { property: "og:url", content: `${siteUrl}/` },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: siteTitle },
      { name: "twitter:description", content: siteDescription },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;1,400&family=Manrope:wght@400;500;700;800&display=swap",
      },
      { rel: "canonical", href: `${siteUrl}/` },
      { rel: "icon", href: "/favicon.ico", sizes: "any" },
      {
        rel: "icon",
        type: "image/png",
        sizes: "32x32",
        href: "/favicon-32x32.png",
      },
      {
        rel: "icon",
        type: "image/png",
        sizes: "16x16",
        href: "/favicon-16x16.png",
      },
      {
        rel: "apple-touch-icon",
        sizes: "180x180",
        href: "/apple-touch-icon.png",
      },
      { rel: "manifest", href: "/manifest.json" },
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
  const isDevRefinementPage = pathname === "/dev/listing-refinement";
  const isChromeFreePage =
    isDevRefinementPage ||
    pathname === "/" ||
    pathname === "/home" ||
    pathname === "/discover" ||
    pathname.startsWith("/discover/") ||
    pathname === "/plan" ||
    pathname === "/logo-capture";
  const header = isLoginPage ? (
    <LoginHeader appName={appName} />
  ) : isChromeFreePage ? null : (
    <AppHeader appName={appName} userName={session?.user?.name} />
  );

  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {header}
        <main
          className={
            isLoginPage
              ? "app-main app-main-login"
              : isChromeFreePage
                ? "app-main app-main-home"
                : "app-main"
          }
        >
          {children}
        </main>
        <Scripts />
      </body>
    </html>
  );
}
