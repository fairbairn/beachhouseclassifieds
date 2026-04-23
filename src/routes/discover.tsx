import {
  Outlet,
  createFileRoute,
  useRouterState,
} from "@tanstack/react-router";

import { DiscoverPage } from "@/components/discover/DiscoverPage";
import { fetchDiscoverListingsPage } from "@/lib/discover/discover-listings-query";
import { hasDiscoverModalIntentForPath } from "@/lib/discover/discover-modal-intent";

const DISCOVER_SSR_SEED_COUNT = 12;

export const Route = createFileRoute("/discover")({
  staleTime: 5 * 60 * 1000,
  shouldReload: false,
  loader: async () => {
    const ssrSeedRequest = {
      limit: DISCOVER_SSR_SEED_COUNT,
      includeMapListings: true,
    };

    if (typeof window === "undefined") {
      console.info("[discover:ssr] seed request", ssrSeedRequest);
    }

    const seedPage = await fetchDiscoverListingsPage(ssrSeedRequest);

    if (typeof window === "undefined") {
      console.info("[discover:ssr] seed response", {
        source: seedPage.source,
        stats: seedPage._stats,
        serverDurationMs: seedPage._meta?.serverDurationMs,
        effectiveRequest: seedPage._meta?.request,
        listingsCount: seedPage.listings.length,
        mapListingsCount: seedPage.metadata?.mapListings?.length ?? 0,
      });
    }

    return {
      initialListingsPage: seedPage,
    };
  },
  component: DiscoverRoutePage,
});

function DiscoverRoutePage() {
  const { initialListingsPage } = Route.useLoaderData();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const isNestedDetailRoute = /^\/discover\/listing\/.+/.test(pathname);
  const isModalIntentDetailRoute =
    isNestedDetailRoute && hasDiscoverModalIntentForPath(pathname);

  if (isNestedDetailRoute && !isModalIntentDetailRoute) {
    return <Outlet />;
  }

  return (
    <>
      <div hidden data-route-marker="discover-parent-route">
        discover-parent-route
      </div>
      <DiscoverPage
        overlayListingId={undefined}
        initialListingsPage={initialListingsPage}
        disableOverlayFromPath={!isModalIntentDetailRoute}
      />
      <Outlet />
    </>
  );
}
