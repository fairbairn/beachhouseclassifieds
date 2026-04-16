import {
  ArrowUp,
  ArrowUpDown,
  CalendarDays,
  Heart,
  LayoutGrid,
  MapPin,
  Maximize2,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { DiscoverListing } from "@/components/discover/discover-data";
import {
  formatBathrooms,
  getListingGeoTarget,
  getLocationPresentation,
} from "@/components/discover/discover-utils";

export function DiscoverListingsPanel({
  listings,
  cardsPerRow,
  singleColumnCardVariant = 3,
  activeListingId,
  scrollToListingRequestToken,
  onActiveListingVisibilityChange,
  favoriteIds,
  onToggleFavorite,
  onFocusMap,
  onOpenDetailOverlay,
  nights,
}: {
  listings: ReadonlyArray<DiscoverListing>;
  cardsPerRow: 1 | 2 | 3 | 4;
  singleColumnCardVariant?: 3 | 4;
  activeListingId?: string;
  scrollToListingRequestToken?: number;
  onActiveListingVisibilityChange?: (isVisible: boolean) => void;
  favoriteIds: ReadonlyArray<string>;
  onToggleFavorite: (listingId: string) => void;
  onOpenDetailOverlay?: (listingId: string) => void;
  onFocusMap: (next: {
    id: string;
    lat: number;
    lng: number;
    label: string;
    zoom?: number;
  }) => void;
  nights: number;
}) {
  const [isReturnToTopPulsing, setIsReturnToTopPulsing] = useState(false);
  const cardsScrollRef = useRef<HTMLDivElement | null>(null);
  const explorePanelRef = useRef<HTMLDivElement | null>(null);

  const scrollToTop = () => {
    cardsScrollRef.current?.scrollTo({
      top: 0,
    });
  };

  useEffect(() => {
    const scrollContainer = cardsScrollRef.current;
    if (!activeListingId || !scrollContainer) {
      return;
    }

    const targetCard = scrollContainer.querySelector<HTMLElement>(
      `[data-listing-id="${activeListingId}"]`,
    );

    if (!targetCard) {
      return;
    }

    const targetCardTop = targetCard.offsetTop;
    const targetCardHeight = targetCard.offsetHeight;
    const nextTop =
      targetCardTop - scrollContainer.clientHeight / 2 + targetCardHeight / 2;
    const clampedTop = Math.max(0, nextTop);
    const currentTop = scrollContainer.scrollTop;
    const distance = Math.abs(clampedTop - currentTop);

    // For long jumps, snap close first, then do a brief smooth refinement.
    if (distance > 520) {
      const jumpOffset = Math.min(scrollContainer.clientHeight * 0.6, 420);
      const nearTop =
        clampedTop > currentTop
          ? Math.max(0, clampedTop - jumpOffset)
          : clampedTop + jumpOffset;

      scrollContainer.scrollTo({
        top: nearTop,
      });

      const rafId = window.requestAnimationFrame(() => {
        scrollContainer.scrollTo({
          top: clampedTop,
          behavior: "smooth",
        });
      });

      return () => {
        window.cancelAnimationFrame(rafId);
      };
    }

    scrollContainer.scrollTo({
      behavior: "smooth",
      top: clampedTop,
    });
  }, [activeListingId, cardsPerRow, scrollToListingRequestToken]);

  useEffect(() => {
    const scrollContainer = cardsScrollRef.current;
    if (!scrollContainer) {
      return;
    }

    if (!activeListingId) {
      onActiveListingVisibilityChange?.(false);
      return;
    }

    const updateVisibility = () => {
      const targetCard = scrollContainer.querySelector<HTMLElement>(
        `[data-listing-id="${activeListingId}"]`,
      );

      if (!targetCard) {
        onActiveListingVisibilityChange?.(false);
        return;
      }

      const top = targetCard.offsetTop;
      const bottom = top + targetCard.offsetHeight;
      const viewportTop = scrollContainer.scrollTop;
      const viewportBottom = viewportTop + scrollContainer.clientHeight;
      const isVisible = bottom > viewportTop && top < viewportBottom;

      onActiveListingVisibilityChange?.(isVisible);
    };

    updateVisibility();
    scrollContainer.addEventListener("scroll", updateVisibility, {
      passive: true,
    });
    window.addEventListener("resize", updateVisibility);

    return () => {
      scrollContainer.removeEventListener("scroll", updateVisibility);
      window.removeEventListener("resize", updateVisibility);
    };
  }, [activeListingId, listings, cardsPerRow, onActiveListingVisibilityChange]);

  useEffect(() => {
    const panel = explorePanelRef.current;
    if (!panel) {
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsReturnToTopPulsing(entry.isIntersecting);
      },
      {
        root: cardsScrollRef.current,
        threshold: 0.25,
      },
    );

    observer.observe(panel);

    return () => {
      observer.disconnect();
      setIsReturnToTopPulsing(false);
    };
  }, [cardsPerRow]);

  const listingGridClass =
    cardsPerRow === 1
      ? "xl:grid-cols-1"
      : cardsPerRow === 2
        ? "xl:grid-cols-2"
        : cardsPerRow === 3
          ? "xl:grid-cols-2 2xl:grid-cols-3"
          : "xl:grid-cols-3 2xl:grid-cols-4";

  const formatApproximateTotal = (allInNightly: number) => {
    const roundedTotal = Math.ceil(allInNightly * nights);
    return `$${roundedTotal.toLocaleString("en-US")}`;
  };

  return (
    <div className="relative z-0 min-h-0 xl:h-full">
      <div className="pointer-events-none absolute -top-4 -right-1 -bottom-1 -left-1 z-0 rounded-2xl border border-white/35 bg-white/18 backdrop-blur-md xl:-top-24 xl:-right-2 xl:-left-2" />
      <div
        ref={cardsScrollRef}
        className="discover-cards-scroll relative z-10 h-full overflow-y-auto px-2 pb-6 xl:-mt-6 xl:h-[calc(100%+1.5rem)] xl:pt-6"
      >
        <div id="discover-cards-top-anchor" aria-hidden="true" />
        {listings.length === 0 ? (
          <div className="rounded-2xl border border-white/35 bg-white/90 p-8 text-center shadow-[0_14px_30px_-26px_rgba(15,23,42,0.75)] backdrop-blur-sm">
            <p className="text-lg font-semibold text-slate-900">
              No matches with current filters
            </p>
            <p className="mt-2 text-sm text-slate-600">
              Try lowering one or two filter thresholds, or toggle off a few
              icon filters to broaden results.
            </p>
          </div>
        ) : (
          <div className="space-y-5 pb-6">
            <div className={`grid gap-4 ${listingGridClass}`}>
              {listings.map((listing) => {
                const isFavorite = favoriteIds.includes(listing.id);
                const isPinned = activeListingId === listing.id;
                const location = getLocationPresentation(listing);
                const listingTarget = getListingGeoTarget(listing);
                const communityHighlight = location.isPlannedCommunity
                  ? location.locationChip
                  : null;
                const isSingleColumnCardLayout = cardsPerRow === 1;
                const isFourUpCardLayout =
                  cardsPerRow === 4 ||
                  (isSingleColumnCardLayout && singleColumnCardVariant === 4);
                const isTwoUpCardLayout = cardsPerRow === 2;
                const previewImages = isFourUpCardLayout
                  ? listing.previewImages.slice(0, 1)
                  : listing.previewImages.slice(0, 2);
                const twoUpPreviewImages = listing.previewImages.slice(0, 4);
                const leftPreviewImage =
                  twoUpPreviewImages[0] ?? listing.previewImages[0];
                const rightQuadPreviewImages = [
                  twoUpPreviewImages[1] ?? leftPreviewImage,
                  twoUpPreviewImages[2] ?? leftPreviewImage,
                  twoUpPreviewImages[3] ??
                    twoUpPreviewImages[1] ??
                    leftPreviewImage,
                  twoUpPreviewImages[2] ??
                    twoUpPreviewImages[1] ??
                    leftPreviewImage,
                ];

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
                    className={`group relative flex h-full cursor-pointer flex-col rounded-2xl bg-white p-4 shadow-[0_12px_30px_-24px_rgba(15,23,42,0.65)] transition duration-200 hover:-translate-y-0.5 hover:shadow-[0_18px_34px_-22px_rgba(15,23,42,0.7)] focus-visible:ring-2 focus-visible:ring-cyan-300 focus-visible:outline-none ${listing.beachfront ? "border-[3px] border-amber-300 shadow-[0_0_24px_7px_rgba(251,191,36,0.5),0_32px_60px_-20px_rgba(180,83,9,0.82)] drop-shadow-[0_0_16px_rgba(251,191,36,0.6)]" : "border border-slate-200"}`}
                  >
                    {isTwoUpCardLayout ? (
                      <div className="relative mb-3 grid grid-cols-2 gap-2">
                        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center opacity-0 transition duration-200 group-hover:opacity-100 group-focus-visible:opacity-100">
                          <span className="inline-flex items-center gap-1.5 rounded-full border border-white/70 bg-white/80 px-3 py-1.5 text-xs font-semibold tracking-[0.02em] text-slate-800 shadow-[0_8px_20px_-12px_rgba(15,23,42,0.7)] backdrop-blur-sm">
                            <Maximize2 className="h-3.5 w-3.5" />
                            Click to View Property
                          </span>
                        </div>
                        <img
                          src={leftPreviewImage}
                          alt={`${listing.name} preview 1`}
                          className="aspect-square w-full rounded-lg object-cover"
                        />
                        <div className="grid aspect-square grid-cols-2 grid-rows-2 gap-2">
                          {rightQuadPreviewImages.map((img, i) => (
                            <img
                              key={`${listing.id}-two-up-${i}`}
                              src={img}
                              alt={`${listing.name} preview ${i + 2}`}
                              className="h-full w-full rounded-lg object-cover"
                            />
                          ))}
                        </div>
                      </div>
                    ) : (
                      <div
                        className={`relative mb-3 ${isFourUpCardLayout ? "grid grid-cols-1" : "grid grid-cols-2 gap-2"}`}
                      >
                        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center opacity-0 transition duration-200 group-hover:opacity-100 group-focus-visible:opacity-100">
                          <span className="inline-flex items-center gap-1.5 rounded-full border border-white/70 bg-white/80 px-3 py-1.5 text-xs font-semibold tracking-[0.02em] text-slate-800 shadow-[0_8px_20px_-12px_rgba(15,23,42,0.7)] backdrop-blur-sm">
                            <Maximize2 className="h-3.5 w-3.5" />
                            Click to View Property
                          </span>
                        </div>
                        {previewImages.map((img, i) => (
                          <img
                            key={`${listing.id}-${i}`}
                            src={img}
                            alt={`${listing.name} preview ${i + 1}`}
                            className={`${isFourUpCardLayout ? "aspect-video w-full" : "aspect-square"} rounded-lg object-cover`}
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
                          className={`inline-flex items-center justify-center rounded-full border p-2 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-sm ${
                            isPinned
                              ? "border-rose-500 bg-white text-rose-700 shadow-[0_0_0_2px_rgba(251,113,133,0.28),0_10px_20px_-12px_rgba(225,29,72,0.72)]"
                              : "border-slate-300 text-slate-500 hover:border-rose-300 hover:bg-rose-50 hover:text-rose-700"
                          } relative`}
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
                          className={`inline-flex items-center justify-center rounded-full border p-2 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-sm ${isFavorite ? "border-rose-300 bg-rose-50 text-rose-600 hover:bg-rose-100" : "border-slate-300 text-slate-500 hover:border-rose-300 hover:text-rose-600"}`}
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
                        {listing.bedrooms} BR •{" "}
                        {formatBathrooms(listing.bathrooms)} BA • Sleeps{" "}
                        {listing.sleeps}
                      </p>
                      {communityHighlight ? (
                        <span className="shrink-0 rounded-full border border-teal-300 bg-teal-100 px-2.5 py-1 text-[11px] font-semibold text-teal-900">
                          {communityHighlight}
                        </span>
                      ) : null}
                    </div>

                    <div className="mt-2 flex flex-wrap gap-1.5">
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
                    </div>

                    <div className="mt-auto flex items-center justify-between border-t border-slate-100 pt-3">
                      <span className="text-[11px] text-slate-500">
                        {`Typical pricing for ${nights} ${nights === 1 ? "night" : "nights"} in ${listing.typicalPricingMonth}`}
                      </span>
                      <strong className="text-xs text-slate-900">
                        {formatApproximateTotal(listing.typicalAllInNightly)}
                      </strong>
                    </div>
                  </article>
                );
              })}
            </div>

            <div
              ref={explorePanelRef}
              className="relative mb-2 overflow-hidden rounded-2xl border border-cyan-100 bg-white p-6 shadow-[0_28px_55px_-34px_rgba(6,182,212,0.55)]"
            >
              <div className="pointer-events-none absolute -top-14 -right-12 h-44 w-44 rounded-full bg-cyan-200/55 blur-2xl" />
              <div className="pointer-events-none absolute -bottom-14 -left-8 h-36 w-36 rounded-full bg-teal-200/55 blur-2xl" />
              <div className="relative">
                <div className="flex items-start justify-between gap-6">
                  <div className="flex items-center gap-3">
                    <div className="inline-flex h-12 w-12 items-center justify-center rounded-xl border border-teal-200 bg-teal-50 text-teal-700 shadow-[0_12px_24px_-16px_rgba(13,148,136,0.8)]">
                      <Sparkles className="h-5 w-5" />
                    </div>
                    <h3
                      className="text-3xl font-semibold tracking-tight text-teal-800"
                      style={{ fontFamily: "'Playfair Display', serif" }}
                    >
                      There&apos;s much more to explore!
                    </h3>
                  </div>
                  <button
                    type="button"
                    onClick={scrollToTop}
                    className="relative inline-flex items-center gap-2 rounded-full border border-cyan-200 bg-cyan-50 px-4 py-1.5 text-sm font-semibold text-cyan-800 transition hover:bg-cyan-100"
                  >
                    {isReturnToTopPulsing ? (
                      <span
                        aria-hidden="true"
                        className="pointer-events-none absolute -inset-0.5 animate-ping rounded-full border border-cyan-300/80"
                      />
                    ) : null}
                    <ArrowUp className="h-4 w-4" />
                    Return to Top
                  </button>
                </div>
                <h4 className="mt-3 text-xl font-semibold text-slate-900">
                  We have many more homes available beyond these suggestions.
                </h4>
                <p className="mt-2 text-base leading-7 text-slate-700">
                  Try one or two of these quick tweaks to uncover better-fit
                  homes fast.
                </p>
                <p className="mt-3 text-[11px] font-bold tracking-[0.14em] text-slate-500 uppercase">
                  Helpful Hints
                </p>
                <ul className="mt-2 space-y-2 text-sm leading-6 text-slate-700">
                  <li className="flex items-start gap-2.5">
                    <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-emerald-200 bg-emerald-50 text-emerald-700">
                      <CalendarDays className="h-3.5 w-3.5" />
                    </span>
                    <span>
                      Use a wider earliest-to-latest date window to surface more
                      consecutive-night availability.
                    </span>
                  </li>
                  <li className="flex items-start gap-2.5">
                    <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-teal-200 bg-teal-50 text-teal-700">
                      <SlidersHorizontal className="h-3.5 w-3.5" />
                    </span>
                    <span>Refine filters to tighten your match quality.</span>
                  </li>
                  <li className="flex items-start gap-2.5">
                    <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-cyan-200 bg-cyan-50 text-cyan-700">
                      <ArrowUpDown className="h-3.5 w-3.5" />
                    </span>
                    <span>
                      Try sorting by price or features to reshuffle priorities.
                    </span>
                  </li>
                  <li className="flex items-start gap-2.5">
                    <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-indigo-200 bg-indigo-50 text-indigo-700">
                      <LayoutGrid className="h-3.5 w-3.5" />
                    </span>
                    <span>
                      Switch card layouts for easier browsing density.
                    </span>
                  </li>
                  <li className="flex items-start gap-2.5">
                    <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-rose-200 bg-rose-50 text-rose-700">
                      <Heart className="h-3.5 w-3.5" />
                    </span>
                    <span>
                      Favorite homes you like so you can compare them later.
                    </span>
                  </li>
                </ul>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
