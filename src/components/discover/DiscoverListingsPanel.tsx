import {
  ArrowUp,
  ArrowUpDown,
  CalendarDays,
  Heart,
  LayoutGrid,
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

import { DiscoverListingCard } from "@/components/discover/DiscoverListingCard";
import { DiscoverListingsCollection } from "@/components/discover/DiscoverListingsCollection";
import type { DiscoverListing } from "@/lib/discover/discover-types";

const discoverAnimatedListingIdsCache = new Set<string>();
let discoverBackfillFadeCompleted = false;

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

  const renderListingCard = useCallback(
    (listing: DiscoverListing) => (
      <DiscoverListingCard
        key={listing.id}
        listing={listing}
        isFavorite={favoriteIdSet.has(listing.id)}
        isPinned={activeListingId === listing.id}
        isFadingIn={fadingInListingIds.has(listing.id)}
        isFourUpCardLayout={isFourUpCardLayout}
        isTwoUpCardLayout={isTwoUpCardLayout}
        threeUpCardMinHeightClass={threeUpCardMinHeightClass}
        nights={nights}
        onToggleFavorite={onToggleFavorite}
        onOpenDetailOverlay={onOpenDetailOverlay}
        onFocusMap={onFocusMap}
      />
    ),
    [
      favoriteIdSet,
      activeListingId,
      fadingInListingIds,
      isFourUpCardLayout,
      isTwoUpCardLayout,
      threeUpCardMinHeightClass,
      nights,
      onToggleFavorite,
      onOpenDetailOverlay,
      onFocusMap,
    ],
  );

  return (
    <div className="relative z-0 min-h-0 xl:h-full">
      <div className="pointer-events-none absolute -top-4 -right-1 -bottom-1 -left-1 z-0 rounded-2xl border border-white/35 bg-white/18 xl:-top-24 xl:-right-2 xl:-left-2" />
      <div
        ref={cardsScrollRef}
        className="discover-cards-scroll relative z-10 h-full overflow-y-auto px-2 pb-6 xl:-mt-6 xl:h-[calc(100%+1.5rem)] xl:pt-6"
      >
        <div id="discover-cards-top-anchor" aria-hidden="true" />
        <div className="space-y-5 pb-6">
          <DiscoverListingsCollection
            listings={listings}
            isLoading={isLoading}
            loadingPlaceholderCount={loadingPlaceholderCount}
            listingGridClass={listingGridClass}
            isFourUpCardLayout={isFourUpCardLayout}
            isTwoUpCardLayout={isTwoUpCardLayout}
            threeUpCardMinHeightClass={threeUpCardMinHeightClass}
            renderListingCard={renderListingCard}
            emptyState={
              <div className="rounded-2xl border border-white/35 bg-white/90 p-8 text-center shadow-[0_14px_30px_-26px_rgba(15,23,42,0.75)] backdrop-blur-sm">
                <p className="text-lg font-semibold text-slate-900">
                  No matches with current filters
                </p>
                <p className="mt-2 text-sm text-slate-600">
                  Try lowering one or two filter thresholds, or toggle off a few
                  icon filters to broaden results.
                </p>
              </div>
            }
          />

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
                      <div className="dsp h-12 w-12 rounded-xl border border-teal-200 bg-teal-50" />
                      <div className="dsp h-9 w-80 max-w-[60vw] rounded-full bg-slate-200/70" />
                    </div>
                    <div className="dsp h-8 w-30 rounded-full border border-cyan-200 bg-cyan-50" />
                  </div>
                  <div className="dsp mt-4 h-7 w-4/5 rounded-full bg-slate-200/75" />
                  <div className="dsp mt-3 h-4 w-3/4 rounded-full bg-slate-200/65" />
                  <div className="dsp mt-2 h-4 w-2/3 rounded-full bg-slate-200/60" />
                  <div className="dsp mt-4 h-3 w-28 rounded-full bg-slate-200/62" />
                  <div className="mt-3 space-y-2">
                    <div className="dsp h-5 w-4/5 rounded-full bg-slate-200/68" />
                    <div className="dsp h-5 w-3/4 rounded-full bg-slate-200/64" />
                    <div className="dsp h-5 w-5/6 rounded-full bg-slate-200/66" />
                    <div className="dsp h-5 w-3/5 rounded-full bg-slate-200/60" />
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
