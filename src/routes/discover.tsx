import {
  Outlet,
  createFileRoute,
  useRouterState,
} from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

import { DiscoverPage } from "@/components/discover/DiscoverPage";
import { hasDiscoverModalIntentForPath } from "@/lib/discover/discover-modal-intent";

const DISCOVER_SSR_SEED_COUNT = 12;

const loadDiscoverSeedPage = createServerFn({ method: "GET" })
  .inputValidator((input: { limit: number }) => input)
  .handler(async ({ data }) => {
    const { executeDiscoverSearch } =
      await import("@/lib/discover/discover-search-service.server");

    return executeDiscoverSearch({
      limit: data.limit,
    });
  });

export const Route = createFileRoute("/discover")({
  staleTime: 5 * 60 * 1000,
  shouldReload: false,
  loader: async () => {
    const seedPage = await loadDiscoverSeedPage({
      data: { limit: DISCOVER_SSR_SEED_COUNT },
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
