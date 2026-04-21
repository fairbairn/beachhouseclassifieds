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
    const seedPage = await fetchDiscoverListingsPage({
      limit: DISCOVER_SSR_SEED_COUNT,
    });

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
