import type { ReactNode } from "react";

import { DiscoverListingCardSkeleton } from "@/components/discover/DiscoverListingCardSkeleton";
import { cn } from "@/core/ui/cn";
import type { DiscoverListing } from "@/lib/discover/discover-types";

export function DiscoverListingsCollection({
  listings,
  isLoading,
  loadingPlaceholderCount,
  listingGridClass,
  isFourUpCardLayout,
  isTwoUpCardLayout,
  threeUpCardMinHeightClass,
  renderListingCard,
  emptyState,
}: {
  listings: ReadonlyArray<DiscoverListing>;
  isLoading: boolean;
  loadingPlaceholderCount: number;
  listingGridClass: string;
  isFourUpCardLayout: boolean;
  isTwoUpCardLayout: boolean;
  threeUpCardMinHeightClass: string;
  renderListingCard: (listing: DiscoverListing) => ReactNode;
  emptyState: ReactNode;
}) {
  if (isLoading) {
    return (
      <div className="grid gap-4 xl:grid-cols-2 2xl:grid-cols-3">
        {Array.from({ length: 6 }).map((_, index) => (
          <div
            key={`discover-loading-card-${index}`}
            className={cn(
              "discover-listing-loading-card",
              threeUpCardMinHeightClass,
            )}
          />
        ))}
      </div>
    );
  }

  if (listings.length === 0) {
    return emptyState;
  }

  return (
    <div className={`grid gap-4 ${listingGridClass}`}>
      {listings.map((listing) => renderListingCard(listing))}
      {Array.from({ length: loadingPlaceholderCount }).map((_, index) => (
        <DiscoverListingCardSkeleton
          key={`discover-background-loading-card-${index}`}
          isFourUpCardLayout={isFourUpCardLayout}
          isTwoUpCardLayout={isTwoUpCardLayout}
          threeUpCardMinHeightClass={threeUpCardMinHeightClass}
        />
      ))}
    </div>
  );
}
