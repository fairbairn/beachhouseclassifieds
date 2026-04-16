import { createFileRoute } from "@tanstack/react-router";

import { DiscoverPage } from "@/components/discover/DiscoverPage";

export const Route = createFileRoute("/discover")({
  component: DiscoverRoutePage,
});

function DiscoverRoutePage() {
  return <DiscoverPage overlayListingId={undefined} />;
}
