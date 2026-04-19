import { createFileRoute } from "@tanstack/react-router";

import { DiscoverPage } from "@/components/discover/DiscoverPage";
import { fetchDiscoverListingDetailPayloadWithCache } from "@/lib/discover/discover-listings-client-cache";
import { hasDiscoverModalIntentForSlug } from "@/lib/discover/discover-modal-intent";

export const Route = createFileRoute("/discover/listing/$slug")({
  staleTime: 5 * 60 * 1000,
  shouldReload: false,
  loader: async ({ params }) => {
    if (
      typeof window !== "undefined" &&
      hasDiscoverModalIntentForSlug(params.slug)
    ) {
      return { initialOverlayDetailPayload: { listing: null } };
    }

    const initialOverlayDetailPayload =
      typeof window === "undefined"
        ? await (async () => {
            const { buildDiscoverListingDetailPayload } =
              await import("@/lib/discover/discover-listings-api.server");
            return await buildDiscoverListingDetailPayload({
              slug: params.slug,
            });
          })()
        : await fetchDiscoverListingDetailPayloadWithCache({
            slug: params.slug,
          });

    return { initialOverlayDetailPayload };
  },
  component: DiscoverListingOverlayRoute,
});

function DiscoverListingOverlayRoute() {
  const { slug } = Route.useParams();
  const { initialOverlayDetailPayload } = Route.useLoaderData();
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
        initialOverlayListing={
          initialOverlayDetailPayload?.listing ?? undefined
        }
        overlayOnlyMode={true}
      />
    </>
  );
}
