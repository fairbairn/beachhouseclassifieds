import { createFileRoute } from "@tanstack/react-router";

import { DiscoverPage } from "@/components/discover/DiscoverPage";

export const Route = createFileRoute("/discover/listing/$slug")({
  loader: async ({ params }) => {
    const response = await fetch(
      `/api/discover/listings?include=${encodeURIComponent(params.slug)}`,
    ).catch(() => null);

    const payload = response
      ? ((await response.json().catch(() => null)) as {
          listings?: unknown;
        } | null)
      : null;
    const initialListings = Array.isArray(payload?.listings)
      ? payload.listings
      : [];

    return { initialListings };
  },
  component: DiscoverListingOverlayRoute,
});

function DiscoverListingOverlayRoute() {
  const { slug } = Route.useParams();
  const { initialListings } = Route.useLoaderData();
  return (
    <DiscoverPage overlayListingId={slug} initialListings={initialListings} />
  );
}
