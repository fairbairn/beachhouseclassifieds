import { Heart, MapPin, Maximize2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  LISTING_ACTION_BUTTON_BASE_STYLES,
  LISTING_CARD_BASE_STYLES,
  LISTING_CARD_BEACHFRONT_STYLES,
  LISTING_CARD_STANDARD_STYLES,
  LISTING_FAVORITE_BUTTON_ACTIVE_STYLES,
  LISTING_FAVORITE_BUTTON_IDLE_STYLES,
  LISTING_IMAGE_OVERLAY_BADGE_STYLES,
  LISTING_IMAGE_OVERLAY_STYLES,
  LISTING_MAP_BUTTON_ACTIVE_STYLES,
  LISTING_MAP_BUTTON_IDLE_STYLES,
} from "@/components/discover/discover-listing-card-styles";
import {
  formatBathrooms,
  getListingGeoTarget,
  getLocationPresentation,
} from "@/components/discover/discover-utils";
import { cn } from "@/core/ui/cn";
import type { DiscoverListing } from "@/lib/discover/discover-types";

function DiscoverImageSlot({
  src,
  alt,
  containerClassName,
}: {
  src?: string;
  alt: string;
  containerClassName: string;
}) {
  const [isLoaded, setIsLoaded] = useState(() => !src);
  const [retryCount, setRetryCount] = useState(0);
  const imageRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    if (!src || isLoaded) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      const image = imageRef.current;
      const loadedFromCache = Boolean(
        image && image.complete && image.naturalWidth > 0,
      );
      if (loadedFromCache) {
        setIsLoaded(true);
        return;
      }

      setRetryCount((current) => {
        if (current >= 2) {
          setIsLoaded(true);
          return current;
        }
        return current + 1;
      });
    }, 2200);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [isLoaded, retryCount, src]);

  return (
    <div
      className={`relative overflow-hidden bg-slate-200/70 ${containerClassName}`}
    >
      <div
        aria-hidden="true"
        className={`pointer-events-none absolute inset-0 bg-linear-to-br from-slate-200/80 via-slate-200/55 to-slate-300/65 transition-opacity duration-200 ${!src || isLoaded ? "opacity-0" : "opacity-100"}`}
      />
      <img
        key={`${src ?? ""}-${retryCount}`}
        ref={imageRef}
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        onLoad={() => setIsLoaded(true)}
        onError={() => {
          setRetryCount((current) => {
            if (current >= 2) {
              setIsLoaded(true);
              return current;
            }
            return current + 1;
          });
        }}
        style={{ display: src ? "block" : "none" }}
        className={`h-full w-full object-cover transition-opacity duration-200 ${!src || isLoaded ? "opacity-100" : "opacity-0"}`}
      />
    </div>
  );
}

export function DiscoverListingCard({
  listing,
  isFavorite,
  isPinned,
  isFadingIn,
  isFourUpCardLayout,
  isTwoUpCardLayout,
  threeUpCardMinHeightClass,
  nights,
  onToggleFavorite,
  onOpenDetailOverlay,
  onFocusMap,
}: {
  listing: DiscoverListing;
  isFavorite: boolean;
  isPinned: boolean;
  isFadingIn: boolean;
  isFourUpCardLayout: boolean;
  isTwoUpCardLayout: boolean;
  threeUpCardMinHeightClass: string;
  nights: number;
  onToggleFavorite: (listingId: string) => void;
  onOpenDetailOverlay?: (listingId: string) => void;
  onFocusMap: (next: {
    id: string;
    lat: number;
    lng: number;
    label: string;
    zoom?: number;
  }) => void;
}) {
  const location = getLocationPresentation(listing);
  const listingTarget = getListingGeoTarget(listing);
  const communityHighlight = location.isPlannedCommunity
    ? location.locationChip
    : null;
  const previewImages = isFourUpCardLayout
    ? listing.previewImages.slice(0, 1)
    : listing.previewImages.slice(0, 2);
  const twoUpPreviewImages = listing.previewImages.slice(0, 5);
  const leftPreviewImage = twoUpPreviewImages[0] ?? listing.previewImages[0];
  const rightQuadPreviewImages = [
    twoUpPreviewImages[1],
    twoUpPreviewImages[2],
    twoUpPreviewImages[3],
    twoUpPreviewImages[4],
  ].map((imageUrl) => imageUrl ?? leftPreviewImage);

  const roundedTotal = Math.ceil(listing.typicalAllInNightly * nights);
  const approximateTotal = `$${roundedTotal.toLocaleString("en-US")}`;

  return (
    <article
      key={listing.id}
      data-listing-id={listing.id}
      role="button"
      tabIndex={0}
      onClick={() => onOpenDetailOverlay?.(listing.id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpenDetailOverlay?.(listing.id);
        }
      }}
      className={cn(
        LISTING_CARD_BASE_STYLES,
        isFadingIn && "discover-card-fade-in",
        threeUpCardMinHeightClass,
        listing.beachfront
          ? LISTING_CARD_BEACHFRONT_STYLES
          : LISTING_CARD_STANDARD_STYLES,
      )}
    >
      {isTwoUpCardLayout ? (
        <div className="relative mb-3 grid grid-cols-2 gap-2">
          <div className={LISTING_IMAGE_OVERLAY_STYLES}>
            <span className={LISTING_IMAGE_OVERLAY_BADGE_STYLES}>
              <Maximize2 className="h-3.5 w-3.5" />
              Click to View Property
            </span>
          </div>
          <DiscoverImageSlot
            src={leftPreviewImage}
            alt={`${listing.name} preview 1`}
            containerClassName="aspect-square w-full rounded-lg"
          />
          <div className="grid aspect-square grid-cols-2 grid-rows-2 gap-2">
            {rightQuadPreviewImages.map((img, i) => (
              <DiscoverImageSlot
                key={`${listing.id}-two-up-${i}-${img ?? "none"}`}
                src={img}
                alt={`${listing.name} preview ${i + 2}`}
                containerClassName="h-full w-full rounded-lg"
              />
            ))}
          </div>
        </div>
      ) : (
        <div
          className={`relative mb-3 ${isFourUpCardLayout ? "grid grid-cols-1" : "grid grid-cols-2 gap-2"}`}
        >
          <div className={LISTING_IMAGE_OVERLAY_STYLES}>
            <span className={LISTING_IMAGE_OVERLAY_BADGE_STYLES}>
              <Maximize2 className="h-3.5 w-3.5" />
              Click to View Property
            </span>
          </div>
          {previewImages.map((img, i) => (
            <DiscoverImageSlot
              key={`${listing.id}-${i}-${img ?? "none"}`}
              src={img}
              alt={`${listing.name} preview ${i + 1}`}
              containerClassName={`${isFourUpCardLayout ? "aspect-video w-full" : "aspect-square"} rounded-lg`}
            />
          ))}
        </div>
      )}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold text-slate-900">
            {listing.name}
          </h2>
          <p className="mt-0.5 text-xs font-medium text-slate-500">
            {location.subline}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onFocusMap({
                id: listing.id,
                lat: listingTarget.lat,
                lng: listingTarget.lng,
                label: listing.name,
                zoom: 19,
              });
            }}
            onMouseDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            className={cn(
              LISTING_ACTION_BUTTON_BASE_STYLES,
              "relative",
              isPinned
                ? LISTING_MAP_BUTTON_ACTIVE_STYLES
                : LISTING_MAP_BUTTON_IDLE_STYLES,
            )}
            aria-label={`Focus map on ${listing.name}`}
            title={`Focus map on ${listing.name}`}
            aria-pressed={isPinned}
          >
            {isPinned ? (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute -inset-1 animate-ping rounded-full border border-rose-400/75"
              />
            ) : null}
            <MapPin
              className={`h-4 w-4 ${isPinned ? "scale-110" : ""}`}
              fill="none"
              strokeWidth={isPinned ? 2.5 : 2}
            />
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onToggleFavorite(listing.id);
            }}
            onMouseDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            className={cn(
              LISTING_ACTION_BUTTON_BASE_STYLES,
              isFavorite
                ? LISTING_FAVORITE_BUTTON_ACTIVE_STYLES
                : LISTING_FAVORITE_BUTTON_IDLE_STYLES,
            )}
          >
            <Heart
              className="h-4 w-4"
              fill={isFavorite ? "currentColor" : "none"}
            />
          </button>
        </div>
      </div>

      <div className="mt-2 flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-slate-700">
          {listing.bedrooms} BR • {formatBathrooms(listing.bathrooms)} BA •
          Sleeps {listing.sleeps}
        </p>
        {communityHighlight ? (
          <span className="shrink-0 rounded-full border border-teal-300 bg-teal-100 px-2.5 py-1 text-[11px] font-semibold text-teal-900">
            {communityHighlight}
          </span>
        ) : null}
      </div>

      <div className="mt-2 flex h-6 flex-nowrap gap-1.5 overflow-hidden">
        {listing.beachfront ? (
          <span className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-800">
            Gulf Front
          </span>
        ) : null}
        {listing.privatePool ? (
          <span className="rounded-full border border-blue-200 bg-blue-50 px-2.5 py-1 text-[11px] font-semibold text-blue-800">
            Private Pool
          </span>
        ) : null}
        {listing.golfCart ? (
          <span className="rounded-full border border-teal-200 bg-teal-50 px-2.5 py-1 text-[11px] font-semibold text-teal-800">
            Golf Cart
          </span>
        ) : null}
        {!listing.beachfront && !listing.privatePool && !listing.golfCart ? (
          <span
            aria-hidden="true"
            className="invisible rounded-full border px-2.5 py-1 text-[11px] font-semibold"
          >
            Feature
          </span>
        ) : null}
      </div>

      <div className="mt-auto flex items-center justify-between border-t border-slate-100 pt-3">
        <span className="text-[11px] text-slate-500">
          {`Typical pricing for ${nights} ${nights === 1 ? "night" : "nights"} in ${listing.typicalPricingMonth}`}
        </span>
        <strong className="text-xs text-slate-900">{approximateTotal}</strong>
      </div>
    </article>
  );
}
