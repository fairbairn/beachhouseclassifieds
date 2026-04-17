import { createFileRoute } from "@tanstack/react-router";

import { DiscoverPage } from "@/components/discover/DiscoverPage";
import { fetchDiscoverListingDetailWithCache } from "@/lib/discover/discover-listings-client-cache";
import { hasDiscoverModalIntentForSlug } from "@/lib/discover/discover-modal-intent";

export const Route = createFileRoute("/discover/listing/$slug")({
  staleTime: 5 * 60 * 1000,
  shouldReload: false,
  loader: async ({ params }) => {
    if (
      typeof window !== "undefined" &&
      hasDiscoverModalIntentForSlug(params.slug)
    ) {
      return { initialOverlayListing: null };
    }

    const initialOverlayListing =
      typeof window === "undefined"
        ? await (async () => {
            const { buildDiscoverListingDetailPayload } =
              await import("@/lib/discover/discover-listings-api.server");
            const payload = await buildDiscoverListingDetailPayload({
              slug: params.slug,
            });
            return payload.listing;
          })()
        : await fetchDiscoverListingDetailWithCache({
            slug: params.slug,
          });

    return { initialOverlayListing };
  },
  component: DiscoverListingOverlayRoute,
});

function DiscoverListingOverlayRoute() {
  const { slug } = Route.useParams();
  const { initialOverlayListing } = Route.useLoaderData();
  const isModalIntentRoute = hasDiscoverModalIntentForSlug(slug);

  if (isModalIntentRoute) {
    return (
      <>
        <div hidden data-route-marker="discover-detail-child-route-modal" />
        <div hidden data-route-detail-slug={slug}>
          {slug}
        </div>
      </>
    );
  }

  return (
    <>
      <div hidden data-route-marker="discover-detail-child-route">
        discover-detail-child-route
      </div>
      <div hidden data-route-detail-slug={slug}>
        {slug}
      </div>
      <DiscoverPage
        overlayListingId={slug}
        initialOverlayListing={initialOverlayListing ?? undefined}
        overlayOnlyMode={true}
      />
    </>
  );
}
