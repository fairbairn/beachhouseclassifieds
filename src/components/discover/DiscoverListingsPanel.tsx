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
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { DiscoverListing } from "@/components/discover/discover-data";
import {
  formatBathrooms,
  getListingGeoTarget,
  getLocationPresentation,
} from "@/components/discover/discover-utils";

const discoverAnimatedListingIdsCache = new Set<string>();
let discoverBackfillFadeCompleted = false;

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

    // Recover from occasional stalled lazy-load states after rapid scrolling.
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
          // Avoid permanent placeholder even if browser swallowed load/error.
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
        loading="eager"
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

export function DiscoverListingsPanel({
  listings,
  isLoading = false,
  loadingPlaceholderCount = 0,
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
  isLoading?: boolean;
  loadingPlaceholderCount?: number;
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
  const activeListingVisibilityRef = useRef<boolean | null>(null);
  const scrollSnapshotRef = useRef({
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
  });
  const previousCompositionRef = useRef({
    listingsLength: listings.length,
    loadingPlaceholderCount,
  });
  const seenListingIdsRef = useRef<Set<string>>(
    new Set([
      ...discoverAnimatedListingIdsCache,
      ...listings.map((listing) => listing.id),
    ]),
  );
  const fadeTimeoutIdsRef = useRef<number[]>([]);
  const [fadingInListingIds, setFadingInListingIds] = useState<Set<string>>(
    () => new Set(),
  );

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
      if (activeListingVisibilityRef.current !== false) {
        activeListingVisibilityRef.current = false;
        onActiveListingVisibilityChange?.(false);
      }
      return;
    }

    const updateVisibility = () => {
      const targetCard = scrollContainer.querySelector<HTMLElement>(
        `[data-listing-id="${activeListingId}"]`,
      );

      if (!targetCard) {
        if (activeListingVisibilityRef.current !== false) {
          activeListingVisibilityRef.current = false;
          onActiveListingVisibilityChange?.(false);
        }
        return;
      }

      const top = targetCard.offsetTop;
      const bottom = top + targetCard.offsetHeight;
      const viewportTop = scrollContainer.scrollTop;
      const viewportBottom = viewportTop + scrollContainer.clientHeight;
      const isVisible = bottom > viewportTop && top < viewportBottom;

      if (activeListingVisibilityRef.current !== isVisible) {
        activeListingVisibilityRef.current = isVisible;
        onActiveListingVisibilityChange?.(isVisible);
      }
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
        setIsReturnToTopPulsing((current) =>
          current === entry.isIntersecting ? current : entry.isIntersecting,
        );
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

  useEffect(() => {
    return () => {
      fadeTimeoutIdsRef.current.forEach((timeoutId) => {
        window.clearTimeout(timeoutId);
      });
      fadeTimeoutIdsRef.current = [];
    };
  }, []);

  useEffect(() => {
    if (discoverBackfillFadeCompleted) {
      return;
    }

    if (isLoading || listings.length === 0) {
      return;
    }

    const previousComposition = previousCompositionRef.current;
    const isPlaceholderLifecycleActive =
      loadingPlaceholderCount > 0 ||
      previousComposition.loadingPlaceholderCount > 0;
    const listingsAppended =
      previousComposition.listingsLength < listings.length;

    // Only allow fade while skeleton placeholders are being replaced by
    // appended cards. Any later repaint/remount should not re-trigger this.
    if (!isPlaceholderLifecycleActive || !listingsAppended) {
      return;
    }

    const seenIds = seenListingIdsRef.current;
    const addedIds = listings
      .map((listing) => listing.id)
      .filter((listingId) => !seenIds.has(listingId));

    if (addedIds.length === 0) {
      return;
    }

    discoverBackfillFadeCompleted = true;

    addedIds.forEach((listingId) => {
      seenIds.add(listingId);
      discoverAnimatedListingIdsCache.add(listingId);
    });

    setFadingInListingIds((current) => {
      const next = new Set(current);
      addedIds.forEach((listingId) => {
        next.add(listingId);
      });
      return next;
    });

    const timeoutId = window.setTimeout(() => {
      setFadingInListingIds((current) => {
        const next = new Set(current);
        addedIds.forEach((listingId) => {
          next.delete(listingId);
        });
        return next;
      });
      fadeTimeoutIdsRef.current = fadeTimeoutIdsRef.current.filter(
        (id) => id !== timeoutId,
      );
    }, 260);

    fadeTimeoutIdsRef.current.push(timeoutId);
  }, [isLoading, listings, loadingPlaceholderCount]);

  useEffect(() => {
    const scrollContainer = cardsScrollRef.current;
    if (!scrollContainer) {
      return;
    }

    const updateSnapshot = () => {
      scrollSnapshotRef.current = {
        scrollTop: scrollContainer.scrollTop,
        scrollHeight: scrollContainer.scrollHeight,
        clientHeight: scrollContainer.clientHeight,
      };
    };

    updateSnapshot();
    scrollContainer.addEventListener("scroll", updateSnapshot, {
      passive: true,
    });
    window.addEventListener("resize", updateSnapshot);

    return () => {
      scrollContainer.removeEventListener("scroll", updateSnapshot);
      window.removeEventListener("resize", updateSnapshot);
    };
  }, []);

  useLayoutEffect(() => {
    const scrollContainer = cardsScrollRef.current;
    if (!scrollContainer) {
      return;
    }

    const previousComposition = previousCompositionRef.current;
    const placeholdersReplaced =
      previousComposition.loadingPlaceholderCount > loadingPlaceholderCount;
    const listingsAppended =
      previousComposition.listingsLength < listings.length;

    if (placeholdersReplaced && listingsAppended) {
      const previousSnapshot = scrollSnapshotRef.current;
      const nextTop = Math.max(0, previousSnapshot.scrollTop);

      if (Number.isFinite(nextTop)) {
        scrollContainer.scrollTop = nextTop;
      }
    }

    previousCompositionRef.current = {
      listingsLength: listings.length,
      loadingPlaceholderCount,
    };

    scrollSnapshotRef.current = {
      scrollTop: scrollContainer.scrollTop,
      scrollHeight: scrollContainer.scrollHeight,
      clientHeight: scrollContainer.clientHeight,
    };
  }, [listings.length, loadingPlaceholderCount]);

  const listingGridClass =
    cardsPerRow === 1
      ? "xl:grid-cols-1"
      : cardsPerRow === 2
        ? "xl:grid-cols-2"
        : cardsPerRow === 3
          ? "xl:grid-cols-2 2xl:grid-cols-3"
          : "xl:grid-cols-3 2xl:grid-cols-4";

  const formatApproximateTotal = useCallback(
    (allInNightly: number) => {
      const roundedTotal = Math.ceil(allInNightly * nights);
      return `$${roundedTotal.toLocaleString("en-US")}`;
    },
    [nights],
  );

  const isSingleColumnCardLayout = cardsPerRow === 1;
  const isFourUpCardLayout =
    cardsPerRow === 4 ||
    (isSingleColumnCardLayout && singleColumnCardVariant === 4);
  const isThreeUpCardLayout = cardsPerRow === 3;
  const isTwoUpCardLayout = cardsPerRow === 2;
  const threeUpCardMinHeightClass = isThreeUpCardLayout
    ? "2xl:min-h-[23.125rem]"
    : "";

  const favoriteIdSet = useMemo(() => new Set(favoriteIds), [favoriteIds]);

  const listingCards = useMemo(
    () =>
      listings.map((listing) => {
        const isFavorite = favoriteIdSet.has(listing.id);
        const isPinned = activeListingId === listing.id;
        const isFadingIn = fadingInListingIds.has(listing.id);
        const location = getLocationPresentation(listing);
        const listingTarget = getListingGeoTarget(listing);
        const communityHighlight = location.isPlannedCommunity
          ? location.locationChip
          : null;
        const previewImages = isFourUpCardLayout
          ? listing.previewImages.slice(0, 1)
          : listing.previewImages.slice(0, 2);
        const twoUpPreviewImages = listing.previewImages.slice(0, 5);
        const leftPreviewImage =
          twoUpPreviewImages[0] ?? listing.previewImages[0];
        const rightQuadPreviewImages = [
          twoUpPreviewImages[1],
          twoUpPreviewImages[2],
          twoUpPreviewImages[3],
          twoUpPreviewImages[4],
        ].map((imageUrl) => imageUrl ?? leftPreviewImage);

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
            className={`discover-listing-card group relative flex h-full cursor-pointer flex-col rounded-2xl border bg-white p-4 shadow-[0_12px_30px_-24px_rgba(15,23,42,0.65)] transition-[transform,box-shadow,border-color] duration-200 hover:-translate-y-0.5 hover:shadow-[0_18px_34px_-22px_rgba(15,23,42,0.7)] focus-visible:ring-2 focus-visible:ring-cyan-300 focus-visible:outline-none ${isFadingIn ? "discover-card-fade-in" : ""} ${threeUpCardMinHeightClass} ${listing.beachfront ? "border-amber-300 shadow-[0_0_24px_7px_rgba(251,191,36,0.5),0_32px_60px_-20px_rgba(180,83,9,0.82)] ring-2 ring-amber-300/65 drop-shadow-[0_0_16px_rgba(251,191,36,0.6)]" : "border-slate-200"}`}
          >
            {isTwoUpCardLayout ? (
              <div className="relative mb-3 grid grid-cols-2 gap-2">
                <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center opacity-0 transition duration-200 group-hover:opacity-100 group-focus-visible:opacity-100">
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-white/70 bg-white/80 px-3 py-1.5 text-xs font-semibold tracking-[0.02em] text-slate-800 shadow-[0_8px_20px_-12px_rgba(15,23,42,0.7)] backdrop-blur-sm">
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
                <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center opacity-0 transition duration-200 group-hover:opacity-100 group-focus-visible:opacity-100">
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-white/70 bg-white/80 px-3 py-1.5 text-xs font-semibold tracking-[0.02em] text-slate-800 shadow-[0_8px_20px_-12px_rgba(15,23,42,0.7)] backdrop-blur-sm">
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
                {listing.bedrooms} BR • {formatBathrooms(listing.bathrooms)} BA
                • Sleeps {listing.sleeps}
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
              {!listing.beachfront &&
              !listing.privatePool &&
              !listing.golfCart ? (
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
              <strong className="text-xs text-slate-900">
                {formatApproximateTotal(listing.typicalAllInNightly)}
              </strong>
            </div>
          </article>
        );
      }),
    [
      listings,
      favoriteIdSet,
      activeListingId,
      fadingInListingIds,
      onOpenDetailOverlay,
      onFocusMap,
      onToggleFavorite,
      formatApproximateTotal,
      isFourUpCardLayout,
      isTwoUpCardLayout,
      threeUpCardMinHeightClass,
      nights,
    ],
  );

  const loadingPlaceholders = useMemo(() => {
    if (loadingPlaceholderCount <= 0) {
      return null;
    }

    return Array.from({ length: loadingPlaceholderCount }).map((_, index) => (
      <div
        key={`discover-background-loading-card-${index}`}
        aria-hidden="true"
        className={`relative flex h-full flex-col rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_12px_30px_-24px_rgba(15,23,42,0.65)] ${threeUpCardMinHeightClass}`}
      >
        {isTwoUpCardLayout ? (
          <div className="relative mb-3 grid grid-cols-2 gap-2">
            <div className="aspect-square animate-pulse rounded-lg bg-slate-200/70" />
            <div className="grid aspect-square grid-cols-2 grid-rows-2 gap-2">
              <div className="animate-pulse rounded-lg bg-slate-200/65" />
              <div className="animate-pulse rounded-lg bg-slate-200/65" />
              <div className="animate-pulse rounded-lg bg-slate-200/60" />
              <div className="animate-pulse rounded-lg bg-slate-200/60" />
            </div>
          </div>
        ) : (
          <div
            className={`relative mb-3 ${isFourUpCardLayout ? "grid grid-cols-1" : "grid grid-cols-2 gap-2"}`}
          >
            {isFourUpCardLayout ? (
              <div className="aspect-video w-full animate-pulse rounded-lg bg-slate-200/70" />
            ) : (
              <>
                <div className="aspect-square animate-pulse rounded-lg bg-slate-200/70" />
                <div className="aspect-square animate-pulse rounded-lg bg-slate-200/62" />
              </>
            )}
          </div>
        )}

        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="h-5 w-4/5 animate-pulse rounded-full bg-slate-200/78" />
            <div className="mt-2 h-3 w-2/5 animate-pulse rounded-full bg-slate-200/62" />
          </div>
          <div className="flex items-center gap-1.5">
            <div className="h-8 w-8 animate-pulse rounded-full border border-slate-200 bg-slate-100" />
            <div className="h-8 w-8 animate-pulse rounded-full border border-slate-200 bg-slate-100" />
          </div>
        </div>

        <div className="mt-2 h-4 w-5/6 animate-pulse rounded-full bg-slate-200/70" />

        <div className="mt-2 flex h-6 flex-nowrap gap-1.5 overflow-hidden">
          <div className="h-5 w-20 animate-pulse rounded-full bg-slate-200/64" />
          <div className="h-5 w-22 animate-pulse rounded-full bg-slate-200/58" />
        </div>

        <div className="mt-auto flex items-center justify-between border-t border-slate-100 pt-3">
          <div className="h-3 w-3/5 animate-pulse rounded-full bg-slate-200/64" />
          <div className="h-4 w-16 animate-pulse rounded-full bg-slate-200/74" />
        </div>
      </div>
    ));
  }, [
    loadingPlaceholderCount,
    isFourUpCardLayout,
    isTwoUpCardLayout,
    threeUpCardMinHeightClass,
  ]);

  return (
    <div className="relative z-0 min-h-0 xl:h-full">
      <div className="pointer-events-none absolute -top-4 -right-1 -bottom-1 -left-1 z-0 rounded-2xl border border-white/35 bg-white/18 xl:-top-24 xl:-right-2 xl:-left-2" />
      <div
        ref={cardsScrollRef}
        className="discover-cards-scroll relative z-10 h-full overflow-y-auto px-2 pb-6 xl:-mt-6 xl:h-[calc(100%+1.5rem)] xl:pt-6"
      >
        <div id="discover-cards-top-anchor" aria-hidden="true" />
        <div className="space-y-5 pb-6">
          {isLoading ? (
            <div className="grid gap-4 xl:grid-cols-2 2xl:grid-cols-3">
              {Array.from({ length: 6 }).map((_, index) => (
                <div
                  key={`discover-loading-card-${index}`}
                  className={`h-78 animate-pulse rounded-2xl border border-slate-200 bg-white/90 shadow-[0_12px_30px_-24px_rgba(15,23,42,0.65)] ${threeUpCardMinHeightClass}`}
                />
              ))}
            </div>
          ) : listings.length === 0 ? (
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
            <div className={`grid gap-4 ${listingGridClass}`}>
              {listingCards}
              {loadingPlaceholders}
            </div>
          )}

          <div
            ref={explorePanelRef}
            className="relative mb-2 overflow-hidden rounded-2xl border border-cyan-100 bg-white p-6 shadow-[0_28px_55px_-34px_rgba(6,182,212,0.55)]"
          >
            <div className="pointer-events-none absolute -top-14 -right-12 h-44 w-44 rounded-full bg-cyan-200/55 blur-2xl" />
            <div className="pointer-events-none absolute -bottom-14 -left-8 h-36 w-36 rounded-full bg-teal-200/55 blur-2xl" />
            <div className="relative">
              {isLoading ? (
                <div aria-hidden="true">
                  <div className="flex items-start justify-between gap-6">
                    <div className="flex items-center gap-3">
                      <div className="h-12 w-12 animate-pulse rounded-xl border border-teal-200 bg-teal-50" />
                      <div className="h-9 w-80 max-w-[60vw] animate-pulse rounded-full bg-slate-200/70" />
                    </div>
                    <div className="h-8 w-30 animate-pulse rounded-full border border-cyan-200 bg-cyan-50" />
                  </div>
                  <div className="mt-4 h-7 w-4/5 animate-pulse rounded-full bg-slate-200/75" />
                  <div className="mt-3 h-4 w-3/4 animate-pulse rounded-full bg-slate-200/65" />
                  <div className="mt-2 h-4 w-2/3 animate-pulse rounded-full bg-slate-200/60" />
                  <div className="mt-4 h-3 w-28 animate-pulse rounded-full bg-slate-200/62" />
                  <div className="mt-3 space-y-2">
                    <div className="h-5 w-4/5 animate-pulse rounded-full bg-slate-200/68" />
                    <div className="h-5 w-3/4 animate-pulse rounded-full bg-slate-200/64" />
                    <div className="h-5 w-5/6 animate-pulse rounded-full bg-slate-200/66" />
                    <div className="h-5 w-3/5 animate-pulse rounded-full bg-slate-200/60" />
                  </div>
                </div>
              ) : (
                <>
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
                        Use a wider earliest-to-latest date window to surface
                        more consecutive-night availability.
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
                        Try sorting by price or features to reshuffle
                        priorities.
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
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
