import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  ArrowRight,
  BedDouble,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Heart,
  House,
  Mouse,
  Search,
  X,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type SetStateAction,
} from "react";

import beachEntryTexture from "@/assets/images/beach-entry.png";
import { DateRangeField } from "@/components/discover/discover-controls";
import {
  homeHeroBackgroundImage,
  known30AAreas,
  known30ABeachZones,
  known30ACommunities,
} from "@/components/discover/discover-data";
import {
  formatBathrooms,
  getLocationPresentation,
} from "@/components/discover/discover-utils";
import { DiscoverFacetSidebar } from "@/components/discover/DiscoverFacetSidebar";
import { DiscoverListingsPanel } from "@/components/discover/DiscoverListingsPanel";
import { DiscoverMapPanel } from "@/components/discover/DiscoverMapPanel";
import { DiscoverSearchPanel } from "@/components/discover/DiscoverSearchPanel";
import { type SortOption } from "@/components/discover/DiscoverSortLayoutControls";
import {
  HOME_ACTION_BUTTON_BASE,
  HOME_ACTION_BUTTON_LARGE_SIZE,
  HOME_ACTION_BUTTON_TEAL,
} from "@/components/home/homeButtonStyles";
import { HomeMarketingShell } from "@/components/home/HomeMarketingShell";
import {
  AVAILABILITY_QUERY_MAX_STAY_NIGHTS,
  dayIntFromIsoDateString,
} from "@/lib/discover/availability-window-index";
import {
  fetchDiscoverListingDetailPayloadWithCache,
  primeDiscoverListingDetailCache,
  primeDiscoverListingsCache,
} from "@/lib/discover/discover-listings-client-cache";
import {
  fetchDiscoverListingsPage,
  type DiscoverListingsPageResponse,
} from "@/lib/discover/discover-listings-query";
import { markDiscoverModalIntent } from "@/lib/discover/discover-modal-intent";
import { buildDiscoverMapListings } from "@/lib/discover/discover-page-derived";
import {
  buildDiscoverInputsSignature,
  createDiscoverInputsStore,
  createDiscoverResultsStore,
  mergeDiscoverListings,
  normalizeDiscoverInputsState,
  resolveDiscoverTotalCount,
  type DiscoverInputsState,
} from "@/lib/discover/discover-state";
import type { DiscoverListing } from "@/lib/discover/discover-types";
import { useDiscoverSearchControls } from "@/lib/discover/use-discover-search-controls";

const defaultMapTarget = {
  lat: 30.3199786,
  lng: -86.1377563,
  label: "Seaside Amphitheater",
  zoom: undefined as number | undefined,
};

// TODO: Temporary UX toggle. Keep false so Clear Pin does not recenter map.
const RESET_MAP_ON_CLEAR_PIN = false;
const BRAND_DISPLAY_FONT_FAMILY = "'Playfair Display', serif";
const DISCOVER_RESULT_SET_TARGET_COUNT = 96;
const DISCOVER_SSR_PLACEHOLDER_TARGET_COUNT = 48;
const ENABLE_DISCOVER_CLIENT_REFETCH = true;
const STANDALONE_CLOSE_FADE_MS = 3000;
const XL_BREAKPOINT_PX = 1280;
const ORIGINAL_DESIGN_PANEL_MAX_HEIGHT_PX = 928;
const DISCOVER_SECTION_GAP_PX = 24;

function normalizeFeatureCode(
  value: string,
):
  | "gulf_front"
  | "private_pool"
  | "golf_cart"
  | "pet_friendly"
  | "elevator"
  | "accessible"
  | null {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (normalized === "gulf_front" || normalized === "gulffront") {
    return "gulf_front";
  }
  if (normalized === "private_pool" || normalized === "privatepool") {
    return "private_pool";
  }
  if (normalized === "golf_cart" || normalized === "golfcart") {
    return "golf_cart";
  }
  if (normalized === "pet_friendly" || normalized === "petfriendly") {
    return "pet_friendly";
  }
  if (normalized === "elevator" || normalized === "lift") {
    return "elevator";
  }
  if (normalized === "accessible" || normalized === "accessibility") {
    return "accessible";
  }

  return null;
}

let discoverListingsSnapshotCache: DiscoverListing[] | null = null;

const DiscoverListingMarkdown = lazy(() =>
  import("@/components/discover/DiscoverListingMarkdown").then((module) => ({
    default: module.DiscoverListingMarkdown,
  })),
);

export function DiscoverPage({
  overlayListingId,
  initialListings,
  initialListingsPage,
  initialOverlayListing,
  initialOverlayLookupResolved,
  overlayOnlyMode,
  disableOverlayFromPath,
}: {
  overlayListingId?: string;
  initialListings?: DiscoverListing[];
  initialListingsPage?: DiscoverListingsPageResponse;
  initialOverlayListing?: DiscoverListing;
  initialOverlayLookupResolved?: boolean;
  overlayOnlyMode?: boolean;
  disableOverlayFromPath?: boolean;
}) {
  const navigate = useNavigate();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const overlayListingIdFromPath = (() => {
    if (disableOverlayFromPath) {
      return undefined;
    }

    const match = pathname.match(/^\/discover\/listing\/(.+)$/);
    if (!match) {
      return undefined;
    }
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  })();
  const requestedOverlayListingId =
    overlayListingId ?? overlayListingIdFromPath;
  const isOverlayRoute = Boolean(requestedOverlayListingId);
  const initialLoadedListings = useMemo(
    () => initialListings ?? initialListingsPage?.listings ?? [],
    [initialListings, initialListingsPage],
  );
  const hasInitialOverlayListing = Boolean(
    requestedOverlayListingId &&
    (initialOverlayListing?.id ?? "") === requestedOverlayListingId,
  );

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });

    const previousHtmlOverflow = document.documentElement.style.overflow;
    const previousBodyOverflow = document.body.style.overflow;
    const previousHtmlOverscroll =
      document.documentElement.style.overscrollBehavior;
    const previousBodyOverscroll = document.body.style.overscrollBehavior;

    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
    document.documentElement.style.overscrollBehavior = "none";
    document.body.style.overscrollBehavior = "none";

    return () => {
      document.documentElement.style.overflow = previousHtmlOverflow;
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overscrollBehavior =
        previousHtmlOverscroll;
      document.body.style.overscrollBehavior = previousBodyOverscroll;
    };
  }, [requestedOverlayListingId]);

  useEffect(() => {
    if (!overlayOnlyMode || typeof document === "undefined") {
      return;
    }

    const existing = document.querySelector<HTMLLinkElement>(
      'link[data-discover-ssr-prefetch="true"]',
    );
    if (existing) {
      return;
    }

    const prefetchLink = document.createElement("link");
    prefetchLink.rel = "prefetch";
    prefetchLink.as = "document";
    prefetchLink.href = "/discover";
    prefetchLink.dataset.discoverSsrPrefetch = "true";
    document.head.appendChild(prefetchLink);

    return () => {
      if (prefetchLink.parentNode) {
        prefetchLink.parentNode.removeChild(prefetchLink);
      }
    };
  }, [overlayOnlyMode]);

  const {
    locationQuery,
    setLocationQuery,
    earliestDate,
    setEarliestDate,
    latestDate,
    setLatestDate,
    checkInDate,
    setCheckInDate,
    checkOutDate,
    setCheckOutDate,
    nights,
    setNights,
    adults,
    setAdults,
    children,
    setChildren,
    showAdvanced,
    setShowAdvanced,
    datePanelOpenRequestToken,
    setDatePanelOpenRequestToken,
    checkDatePanelOpenRequestToken,
    setCheckDatePanelOpenRequestToken,
    minSleeps,
    setMinSleeps,
    minBedrooms,
    setMinBedrooms,
    minBathrooms,
    setMinBathrooms,
    minKingBeds,
    setMinKingBeds,
    minQueenBeds,
    setMinQueenBeds,
    minBunkBeds,
    setMinBunkBeds,
    guestCount,
    dateSummary,
    filtersSummary,
    resetFilters,
  } = useDiscoverSearchControls();

  const [mapTarget, setMapTarget] = useState(defaultMapTarget);
  const [activeListingId, setActiveListingId] = useState<string | undefined>(
    undefined,
  );
  const [isMapExpanded, setIsMapExpanded] = useState(false);
  const [hasMountedPrimaryMapPanel, setHasMountedPrimaryMapPanel] = useState(
    () =>
      overlayOnlyMode || isOverlayRoute || initialLoadedListings.length === 0,
  );
  const [cardsPerRow, setCardsPerRow] = useState<2 | 3 | 4>(3);
  const [expandedSingleCardVariant, setExpandedSingleCardVariant] = useState<
    3 | 4
  >(3);
  const [sortOption, setSortOption] = useState<SortOption>("recommended");
  const [selectedAreas, setSelectedAreas] = useState<string[]>([]);
  const [selectedBeaches, setSelectedBeaches] = useState<string[]>([]);
  const [selectedCommunities, setSelectedCommunities] = useState<string[]>([]);
  const [selectedFeatures, setSelectedFeatures] = useState<string[]>([]);
  const compositeDiscoverInputs = useMemo<DiscoverInputsState>(() => {
    const availabilityWindowStartDayInt = dayIntFromIsoDateString(earliestDate);
    const availabilityWindowEndDayInt = dayIntFromIsoDateString(latestDate);
    const hasCompleteAvailabilityWindow =
      availabilityWindowStartDayInt !== null &&
      availabilityWindowEndDayInt !== null;

    return normalizeDiscoverInputsState({
      locationQuery,
      minSleeps,
      minBedrooms,
      minBathrooms,
      selectedAreas,
      selectedBeaches,
      selectedCommunities,
      selectedFeatures,
      minKingBeds,
      minQueenBeds,
      minBunkBeds,
      availabilityWindowStartDayInt: hasCompleteAvailabilityWindow
        ? availabilityWindowStartDayInt
        : undefined,
      availabilityWindowEndDayInt: hasCompleteAvailabilityWindow
        ? availabilityWindowEndDayInt
        : undefined,
      availabilityStayNights: hasCompleteAvailabilityWindow
        ? Math.min(
            AVAILABILITY_QUERY_MAX_STAY_NIGHTS,
            Math.max(1, Math.floor(nights)),
          )
        : undefined,
    });
  }, [
    locationQuery,
    earliestDate,
    latestDate,
    nights,
    minSleeps,
    minBedrooms,
    minBathrooms,
    selectedAreas,
    selectedBeaches,
    selectedCommunities,
    selectedFeatures,
    minKingBeds,
    minQueenBeds,
    minBunkBeds,
  ]);
  const compositeDiscoverInputsSignature = useMemo(
    () => buildDiscoverInputsSignature(compositeDiscoverInputs),
    [compositeDiscoverInputs],
  );

  const [isViewportTightForSidePanels, setIsViewportTightForSidePanels] =
    useState(false);
  const discoverShellRef = useRef<HTMLElement | null>(null);
  const discoverSearchRegionRef = useRef<HTMLDivElement | null>(null);
  const initialDiscoverListingsSeed =
    !requestedOverlayListingId &&
    Array.isArray(discoverListingsSnapshotCache) &&
    discoverListingsSnapshotCache.length > 0
      ? discoverListingsSnapshotCache
      : initialLoadedListings;
  const [discoverResultsStore] = useState(() =>
    createDiscoverResultsStore({
      initialListings: initialDiscoverListingsSeed,
      initialMetadata: initialListingsPage?.metadata,
      initialTotalCount: resolveDiscoverTotalCount({
        payload: initialListingsPage,
        fallbackListingsLength: initialLoadedListings.length,
      }),
    }),
  );
  const [discoverInputsStore] = useState(() =>
    createDiscoverInputsStore(compositeDiscoverInputs),
  );
  const discoverInputsState = useSyncExternalStore(
    discoverInputsStore.subscribe,
    () => discoverInputsStore.state,
    () => discoverInputsStore.state,
  );
  const discoverInputsSignature = useMemo(
    () => buildDiscoverInputsSignature(discoverInputsState),
    [discoverInputsState],
  );
  const discoverResultsState = useSyncExternalStore(
    discoverResultsStore.subscribe,
    () => discoverResultsStore.state,
    () => discoverResultsStore.state,
  );
  const fetchedListings = discoverResultsState.listings;
  const latestMetadata = discoverResultsState.metadata;
  const [overlayDetailListing, setOverlayDetailListing] = useState<
    DiscoverListing | undefined
  >(() => initialOverlayListing);
  const [isOverlayDetailLoading, setIsOverlayDetailLoading] = useState(
    isOverlayRoute && !hasInitialOverlayListing,
  );
  const [favoriteListingIds, setFavoriteListingIds] = useState<string[]>([]);
  const [selectedCardSyncRequestToken, setSelectedCardSyncRequestToken] =
    useState(0);
  const [isPinnedCardVisible, setIsPinnedCardVisible] = useState(true);
  const overlayContainerRef = useRef<HTMLDivElement | null>(null);
  const overlayDetailScrollRef = useRef<HTMLElement | null>(null);
  const overlayLightboxThumbRailRef = useRef<HTMLDivElement | null>(null);
  const deferredCloseTimeoutRef = useRef<number | null>(null);
  const closeNavigateFrameRef = useRef<number | null>(null);
  const closeTriggeredByPointerRef = useRef(false);
  const [overlayMapExpandedListingId, setOverlayMapExpandedListingId] =
    useState<string | undefined>(undefined);
  const [showOverlayScrollIndicator, setShowOverlayScrollIndicator] =
    useState(false);
  const [showOverlayScrollFade, setShowOverlayScrollFade] = useState(false);
  const [isOverlayImageLightboxOpen, setIsOverlayImageLightboxOpen] =
    useState(false);
  const [overlayLightboxImageIndex, setOverlayLightboxImageIndex] = useState(0);
  const [loadedLightboxThumbUrls, setLoadedLightboxThumbUrls] = useState<
    Set<string>
  >(() => new Set());
  const [lightboxThumbRetryCounts, setLightboxThumbRetryCounts] = useState<
    Record<string, number>
  >({});
  const latestDiscoverFetchRequestIdRef = useRef(0);
  const discoverInFlightRequestKeyRef = useRef<string | undefined>(undefined);
  const discoverClientRequestSequenceRef = useRef(0);
  const discoverSeedRequestKeyRef = useRef("discover-seed");
  const wasOverlayRouteRef = useRef(isOverlayRoute);

  useEffect(() => {
    wasOverlayRouteRef.current = isOverlayRoute;
  }, [isOverlayRoute]);

  const recomputeViewportPanelConstraint = useCallback(() => {
    if (typeof window === "undefined") {
      return;
    }

    if (window.innerWidth < XL_BREAKPOINT_PX) {
      setIsViewportTightForSidePanels(false);
      return;
    }

    const shell = discoverShellRef.current;
    const searchRegion = discoverSearchRegionRef.current;

    if (!shell || !searchRegion) {
      return;
    }

    const shellHeight = shell.getBoundingClientRect().height;
    const searchHeight = searchRegion.getBoundingClientRect().height;
    const availableRowHeight =
      shellHeight - searchHeight - DISCOVER_SECTION_GAP_PX;

    setIsViewportTightForSidePanels(
      availableRowHeight < ORIGINAL_DESIGN_PANEL_MAX_HEIGHT_PX,
    );
  }, []);

  useEffect(() => {
    const chooseVariant = () => {
      setExpandedSingleCardVariant(window.innerWidth >= 1820 ? 4 : 3);
    };

    chooseVariant();
    window.addEventListener("resize", chooseVariant);

    return () => {
      window.removeEventListener("resize", chooseVariant);
    };
  }, [requestedOverlayListingId]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    let frame: number | null = null;
    const scheduleRecompute = () => {
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }

      frame = window.requestAnimationFrame(() => {
        frame = null;
        recomputeViewportPanelConstraint();
      });
    };

    const handleResize = () => {
      scheduleRecompute();
    };

    const shell = discoverShellRef.current;
    const searchRegion = discoverSearchRegionRef.current;
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            scheduleRecompute();
          });

    if (observer && shell) {
      observer.observe(shell);
    }

    if (observer && searchRegion) {
      observer.observe(searchRegion);
    }

    window.addEventListener("resize", handleResize);
    window.visualViewport?.addEventListener("resize", handleResize);
    scheduleRecompute();

    return () => {
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
      observer?.disconnect();
      window.removeEventListener("resize", handleResize);
      window.visualViewport?.removeEventListener("resize", handleResize);
    };
  }, [recomputeViewportPanelConstraint]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      recomputeViewportPanelConstraint();
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [showAdvanced, recomputeViewportPanelConstraint]);

  const shouldConstrainSidePanels =
    showAdvanced || isViewportTightForSidePanels;

  const clearPinnedListing = useCallback(() => {
    setActiveListingId(undefined);
    setMapTarget((current) => {
      if (RESET_MAP_ON_CLEAR_PIN) {
        return {
          ...defaultMapTarget,
          id: undefined,
          zoom: 13,
        };
      }

      return {
        ...current,
        id: undefined,
      };
    });
  }, []);

  const requestSelectedCardSync = useCallback(() => {
    if (!activeListingId) {
      return;
    }

    setSelectedCardSyncRequestToken((current) => current + 1);
  }, [activeListingId]);

  const canSyncSelectedListingCard =
    Boolean(activeListingId) && !isPinnedCardVisible;

  const handleFocusMap = useCallback(
    (next: {
      id: string;
      lat: number;
      lng: number;
      label: string;
      zoom?: number;
    }) => {
      if (activeListingId === next.id) {
        clearPinnedListing();
        return;
      }

      setMapTarget({
        ...next,
        zoom: next.zoom,
      });
      setActiveListingId(next.id);
    },
    [activeListingId, clearPinnedListing],
  );

  const handleSelectListingFromMap = useCallback(
    (next: {
      id: string;
      lat: number;
      lng: number;
      label: string;
      zoom?: number;
    }) => {
      if (activeListingId === next.id) {
        clearPinnedListing();
        return;
      }

      setMapTarget({
        ...next,
        zoom: next.zoom,
      });
      setActiveListingId(next.id);
    },
    [activeListingId, clearPinnedListing],
  );

  useEffect(() => {
    if (requestedOverlayListingId || fetchedListings.length === 0) {
      return;
    }

    discoverListingsSnapshotCache = fetchedListings;
  }, [fetchedListings, requestedOverlayListingId]);

  useEffect(() => {
    if (initialLoadedListings.length === 0) {
      return;
    }

    primeDiscoverListingsCache({
      includeSlug: requestedOverlayListingId,
      listings: initialLoadedListings,
    });

    discoverResultsStore.setState((current) => {
      if (current.listings.length > 0) {
        return current;
      }

      return {
        ...current,
        listings: initialLoadedListings,
      };
    });
  }, [discoverResultsStore, initialLoadedListings, requestedOverlayListingId]);

  useEffect(() => {
    if (!initialOverlayListing) {
      return;
    }

    const initialOverlayListingId =
      typeof (initialOverlayListing as { id?: unknown }).id === "string"
        ? (initialOverlayListing as { id: string }).id.trim()
        : "";
    if (!initialOverlayListingId) {
      return;
    }

    primeDiscoverListingDetailCache({
      slug: initialOverlayListingId,
      listing: initialOverlayListing,
    });

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOverlayDetailListing((current) =>
      current?.id === initialOverlayListingId ? current : initialOverlayListing,
    );
  }, [initialOverlayListing]);

  useEffect(() => {
    if (!requestedOverlayListingId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOverlayDetailListing(undefined);
      return;
    }

    if (overlayDetailListing?.id === requestedOverlayListingId) {
      return;
    }

    setOverlayDetailListing(undefined);
  }, [overlayDetailListing?.id, requestedOverlayListingId]);

  useLayoutEffect(() => {
    if (!requestedOverlayListingId) {
      return;
    }

    const hasResolvedOverlayListing =
      overlayDetailListing?.id === requestedOverlayListingId ||
      initialOverlayListing?.id === requestedOverlayListingId;

    if (!hasResolvedOverlayListing) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIsOverlayDetailLoading(true);
    }
  }, [
    initialOverlayListing?.id,
    overlayDetailListing?.id,
    requestedOverlayListingId,
  ]);

  useEffect(() => {
    if (!requestedOverlayListingId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIsOverlayDetailLoading(false);
      return;
    }

    if (
      initialOverlayListing &&
      initialOverlayListing.id === requestedOverlayListingId
    ) {
      setOverlayDetailListing((current) =>
        current?.id === requestedOverlayListingId
          ? current
          : initialOverlayListing,
      );
      setIsOverlayDetailLoading(false);
      return;
    }

    const hasRequestedListingAlreadyLoaded = Boolean(
      requestedOverlayListingId &&
      ((overlayDetailListing?.id ?? "") === requestedOverlayListingId ||
        hasInitialOverlayListing),
    );

    if (!hasRequestedListingAlreadyLoaded && !overlayOnlyMode) {
      let isCancelled = false;
      setIsOverlayDetailLoading(true);

      void fetchDiscoverListingDetailPayloadWithCache({
        slug: requestedOverlayListingId,
      })
        .then((payload) => {
          if (isCancelled) {
            return;
          }

          const listing = payload.listing;
          if (listing) {
            setOverlayDetailListing(listing);
          }
          setIsOverlayDetailLoading(false);
        })
        .catch(() => {
          if (isCancelled) {
            return;
          }
          setIsOverlayDetailLoading(false);
        });

      return () => {
        isCancelled = true;
      };
    }

    // Overlay-only detail routes are loader-driven. If the loader completed
    // and no listing matched, render the dedicated unavailable state.
    if (overlayOnlyMode && initialOverlayLookupResolved) {
      setIsOverlayDetailLoading(false);
      return;
    }

    // Route detail rendering is SSR/loader-driven only.
    // Do not trigger a client-side detail fetch for this route.
    setIsOverlayDetailLoading(!hasRequestedListingAlreadyLoaded);
  }, [
    overlayOnlyMode,
    overlayDetailListing?.id,
    initialOverlayListing,
    initialOverlayLookupResolved,
    hasInitialOverlayListing,
    requestedOverlayListingId,
  ]);

  const sourceListings = useMemo(() => {
    if (fetchedListings.length > 0) {
      return fetchedListings;
    }

    return [] as DiscoverListing[];
  }, [fetchedListings]);
  const isDiscoverListingsInitialLoading =
    !isOverlayRoute && fetchedListings.length === 0;
  const loadingPlaceholderCount = useMemo(() => {
    if (isOverlayRoute) {
      return 0;
    }

    const targetCount = Math.min(
      DISCOVER_SSR_PLACEHOLDER_TARGET_COUNT,
      Math.max(discoverResultsState.totalCount, fetchedListings.length),
    );

    return Math.max(0, targetCount - fetchedListings.length);
  }, [discoverResultsState.totalCount, fetchedListings.length, isOverlayRoute]);

  const toggleFacetValue = useCallback(
    (value: string, setSelected: Dispatch<SetStateAction<string[]>>) => {
      setSelected((current) =>
        current.includes(value)
          ? current.filter((entry) => entry !== value)
          : [...current, value],
      );
    },
    [],
  );

  const toggleFeatureValue = useCallback((value: string) => {
    const nextCode = normalizeFeatureCode(value);
    if (!nextCode) {
      return;
    }

    setSelectedFeatures((current) => {
      const normalizedCurrent = Array.from(
        new Set(
          current
            .map((entry) => normalizeFeatureCode(entry))
            .filter((entry): entry is NonNullable<typeof entry> =>
              Boolean(entry),
            ),
        ),
      );

      return normalizedCurrent.includes(nextCode)
        ? normalizedCurrent.filter((entry) => entry !== nextCode)
        : [...normalizedCurrent, nextCode];
    });
  }, []);

  useEffect(() => {
    const currentSignature = buildDiscoverInputsSignature(
      discoverInputsStore.state,
    );
    if (currentSignature === compositeDiscoverInputsSignature) {
      return;
    }

    discoverInputsStore.setState(compositeDiscoverInputs);
  }, [
    compositeDiscoverInputs,
    compositeDiscoverInputsSignature,
    discoverInputsStore,
  ]);

  useEffect(() => {
    if (!ENABLE_DISCOVER_CLIENT_REFETCH || overlayOnlyMode || isOverlayRoute) {
      return;
    }

    const returningFromOverlayRoute =
      wasOverlayRouteRef.current && !isOverlayRoute;
    if (
      returningFromOverlayRoute &&
      discoverResultsStore.state.listings.length > 0
    ) {
      return;
    }

    const requestSequence = discoverClientRequestSequenceRef.current;
    const requestKey =
      requestSequence === 0
        ? discoverSeedRequestKeyRef.current
        : `discover-client-${requestSequence}`;
    const shouldAppendSeedWindow =
      requestSequence === 0 &&
      initialLoadedListings.length > 0 &&
      initialLoadedListings.length < DISCOVER_RESULT_SET_TARGET_COUNT;
    const requestOffset = shouldAppendSeedWindow
      ? initialLoadedListings.length
      : 0;
    const requestedBackfillCount = shouldAppendSeedWindow
      ? Math.max(
          1,
          DISCOVER_RESULT_SET_TARGET_COUNT - initialLoadedListings.length,
        )
      : DISCOVER_RESULT_SET_TARGET_COUNT;
    const requestLimit = requestedBackfillCount;

    const requestInputs = discoverInputsStore.state;
    const clientRequest = {
      sortOption,
      limit: requestLimit,
      offset: requestOffset,
      bypassCache: true,
      locationQuery: requestInputs.locationQuery,
      minSleeps: requestInputs.minSleeps,
      minBedrooms: requestInputs.minBedrooms,
      minBathrooms: requestInputs.minBathrooms,
      selectedAreas: requestInputs.selectedAreas,
      selectedBeaches: requestInputs.selectedBeaches,
      selectedCommunities: requestInputs.selectedCommunities,
      selectedFeatures: requestInputs.selectedFeatures,
      minKingBeds: requestInputs.minKingBeds,
      minQueenBeds: requestInputs.minQueenBeds,
      minBunkBeds: requestInputs.minBunkBeds,
      availabilityWindowStartDayInt:
        requestInputs.availabilityWindowStartDayInt,
      availabilityWindowEndDayInt: requestInputs.availabilityWindowEndDayInt,
      availabilityStayNights: requestInputs.availabilityStayNights,
    };

    const requestFingerprint = JSON.stringify(clientRequest);
    if (discoverInFlightRequestKeyRef.current === requestFingerprint) {
      return;
    }
    discoverInFlightRequestKeyRef.current = requestFingerprint;
    latestDiscoverFetchRequestIdRef.current += 1;
    const requestId = latestDiscoverFetchRequestIdRef.current;

    void fetchDiscoverListingsPage(clientRequest)
      .then((payload) => {
        if (requestId !== latestDiscoverFetchRequestIdRef.current) {
          return;
        }

        discoverClientRequestSequenceRef.current += 1;

        discoverResultsStore.setState((current) => ({
          ...current,
          listings: mergeDiscoverListings({
            current: current.listings,
            next: payload.listings,
            mode: shouldAppendSeedWindow ? "append" : "replace",
          }),
          metadata: payload.metadata,
          totalCount: Math.max(
            0,
            payload._stats?.totalCount ?? payload.listings.length,
          ),
        }));

        setHasMountedPrimaryMapPanel(true);

        if (typeof window === "undefined") {
          console.info("[discover:client-seq] applied", {
            requestKey,
            mode: shouldAppendSeedWindow ? "append" : "replace",
            request: {
              limit: requestLimit,
              offset: requestOffset,
            },
          });
        }
      })
      .catch(() => {
        if (requestId !== latestDiscoverFetchRequestIdRef.current) {
          return;
        }

        setHasMountedPrimaryMapPanel(true);
      })
      .finally(() => {
        if (discoverInFlightRequestKeyRef.current === requestFingerprint) {
          discoverInFlightRequestKeyRef.current = undefined;
        }
      });

    return () => {};
  }, [
    discoverInputsSignature,
    sortOption,
    discoverInputsStore,
    isOverlayRoute,
    overlayOnlyMode,
    discoverResultsStore,
    initialLoadedListings.length,
  ]);

  const displayListings = sourceListings;

  const mapListings = useMemo(() => {
    return buildDiscoverMapListings({
      displayListings,
      hasClientSideNarrowing: false,
      mapSeedListings: latestMetadata?.mapListings,
      nights,
      getListingGeo: (listing) => ({
        lat:
          typeof listing.lat === "number" && Number.isFinite(listing.lat)
            ? listing.lat
            : defaultMapTarget.lat,
        lng:
          typeof listing.lng === "number" && Number.isFinite(listing.lng)
            ? listing.lng
            : defaultMapTarget.lng,
      }),
    });
  }, [displayListings, latestMetadata?.mapListings, nights]);
  const deferredMapListings = useDeferredValue(mapListings);

  const {
    effectiveAreaCounts,
    effectiveBeachCounts,
    effectiveCommunityCounts,
    effectiveFeatureCounts,
  } = useMemo(() => {
    const metadata = latestMetadata;

    const byLabel = (
      bucket?: Record<string, { label?: string; count: number }>,
    ) =>
      new Map(
        Object.values(bucket ?? {}).map((entry) => [
          (entry.label ?? "").trim(),
          entry.count,
        ]),
      );

    const areaByLabel = byLabel(metadata?.facets.areas);
    const beachByLabel = byLabel(metadata?.facets.beaches);
    const communityByLabel = byLabel(metadata?.facets.communities);

    return {
      effectiveAreaCounts: known30AAreas.map(
        (name) => [name, areaByLabel.get(name) ?? 0] as const,
      ),
      effectiveBeachCounts: known30ABeachZones.map(
        (name) => [name, beachByLabel.get(name) ?? 0] as const,
      ),
      effectiveCommunityCounts: known30ACommunities.map(
        (name) => [name, communityByLabel.get(name) ?? 0] as const,
      ),
      effectiveFeatureCounts: [
        {
          code: "gulf_front" as const,
          label: "Gulf Front",
          count: metadata?.facets.features.gulf_front?.count ?? 0,
        },
        {
          code: "private_pool" as const,
          label: "Private Pool",
          count: metadata?.facets.features.private_pool?.count ?? 0,
        },
        {
          code: "golf_cart" as const,
          label: "Golf Cart",
          count: metadata?.facets.features.golf_cart?.count ?? 0,
        },
      ],
    };
  }, [latestMetadata]);

  const propertiesListingCount = discoverResultsState.totalCount;

  const toggleFavoriteListing = useCallback((listingId: string) => {
    setFavoriteListingIds((current) =>
      current.includes(listingId)
        ? current.filter((id) => id !== listingId)
        : [...current, listingId],
    );
  }, []);

  const effectiveOverlayListingId = requestedOverlayListingId;
  const shouldRenderOverlay = Boolean(effectiveOverlayListingId);
  const isDetailOverlayOpen = Boolean(effectiveOverlayListingId);
  const isOverlayMapExpanded =
    Boolean(effectiveOverlayListingId) &&
    overlayMapExpandedListingId === effectiveOverlayListingId;

  const overlayListing = useMemo(() => {
    if (
      overlayDetailListing &&
      overlayDetailListing.id === effectiveOverlayListingId
    ) {
      return overlayDetailListing;
    }

    if (
      initialOverlayListing &&
      initialOverlayListing.id === effectiveOverlayListingId
    ) {
      return initialOverlayListing;
    }

    // Avoid painting summary-card data in the detail overlay while
    // the full detail payload is still loading.
    return undefined;
  }, [overlayDetailListing, initialOverlayListing, effectiveOverlayListingId]);

  const overlayLocation = useMemo(() => {
    if (!overlayListing) {
      return null;
    }
    return getLocationPresentation(overlayListing);
  }, [overlayListing]);

  const closeDetailOverlay = useCallback(() => {
    if (closeNavigateFrameRef.current !== null) {
      window.cancelAnimationFrame(closeNavigateFrameRef.current);
      closeNavigateFrameRef.current = null;
    }

    if (deferredCloseTimeoutRef.current !== null) {
      window.clearTimeout(deferredCloseTimeoutRef.current);
      deferredCloseTimeoutRef.current = null;
    }

    if (overlayOnlyMode) {
      if (overlayContainerRef.current) {
        overlayContainerRef.current.style.transition = `opacity ${STANDALONE_CLOSE_FADE_MS}ms ease`;
        overlayContainerRef.current.style.opacity = "0";
        overlayContainerRef.current.style.pointerEvents = "none";
      }

      closeNavigateFrameRef.current = window.requestAnimationFrame(() => {
        closeNavigateFrameRef.current = null;
        window.location.assign("/discover");
      });

      return;
    }

    setOverlayMapExpandedListingId(undefined);

    if (overlayContainerRef.current) {
      overlayContainerRef.current.style.display = "none";
      overlayContainerRef.current.style.opacity = "0";
      overlayContainerRef.current.style.pointerEvents = "none";
    }

    closeNavigateFrameRef.current = window.requestAnimationFrame(() => {
      closeNavigateFrameRef.current = null;
      deferredCloseTimeoutRef.current = window.setTimeout(() => {
        deferredCloseTimeoutRef.current = null;
        void navigate({ to: "/discover" }).catch(() => {
          if (overlayContainerRef.current) {
            overlayContainerRef.current.style.display = "";
            overlayContainerRef.current.style.opacity = "";
            overlayContainerRef.current.style.pointerEvents = "";
            overlayContainerRef.current.style.transition = "";
          }
        });
      }, 0);
    });
  }, [navigate, overlayOnlyMode]);

  const handleCloseDetailOverlayPointerDown = useCallback(() => {
    closeTriggeredByPointerRef.current = true;
    closeDetailOverlay();
  }, [closeDetailOverlay]);

  const handleCloseDetailOverlayClick = useCallback(() => {
    if (closeTriggeredByPointerRef.current) {
      closeTriggeredByPointerRef.current = false;
      return;
    }

    closeDetailOverlay();
  }, [closeDetailOverlay]);

  useEffect(() => {
    if (overlayContainerRef.current) {
      overlayContainerRef.current.style.display = "";
      overlayContainerRef.current.style.opacity = "";
      overlayContainerRef.current.style.pointerEvents = "";
      overlayContainerRef.current.style.transition = "";
    }
  }, [requestedOverlayListingId]);

  useEffect(() => {
    return () => {
      if (closeNavigateFrameRef.current !== null) {
        window.cancelAnimationFrame(closeNavigateFrameRef.current);
        closeNavigateFrameRef.current = null;
      }

      if (deferredCloseTimeoutRef.current !== null) {
        window.clearTimeout(deferredCloseTimeoutRef.current);
        deferredCloseTimeoutRef.current = null;
      }
    };
  }, []);

  const updateOverlayScrollIndicator = useCallback(() => {
    const node = overlayDetailScrollRef.current;
    if (!node) {
      setShowOverlayScrollIndicator(false);
      setShowOverlayScrollFade(false);
      return;
    }

    const remainingScroll =
      node.scrollHeight - node.clientHeight - node.scrollTop;
    const hasOverflow = node.scrollHeight - node.clientHeight > 24;
    const hasMoreBelow = remainingScroll > 24;
    const isNearTop = node.scrollTop <= 16;
    setShowOverlayScrollFade(hasOverflow && hasMoreBelow);
    setShowOverlayScrollIndicator(hasOverflow && hasMoreBelow && isNearTop);
  }, []);

  const handleOverlayScrollIndicatorClick = useCallback(() => {
    const node = overlayDetailScrollRef.current;
    if (!node) {
      return;
    }

    node.scrollTo({
      top: Math.max(node.scrollHeight, 0),
      behavior: "smooth",
    });
  }, []);

  useEffect(() => {
    if (!isDetailOverlayOpen || !overlayListing) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setShowOverlayScrollIndicator(false);
      setShowOverlayScrollFade(false);
      return;
    }

    const node = overlayDetailScrollRef.current;
    if (!node) {
      setShowOverlayScrollIndicator(false);
      setShowOverlayScrollFade(false);
      return;
    }

    updateOverlayScrollIndicator();

    const handleScroll = () => {
      updateOverlayScrollIndicator();
    };

    node.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("resize", updateOverlayScrollIndicator);

    return () => {
      node.removeEventListener("scroll", handleScroll);
      window.removeEventListener("resize", updateOverlayScrollIndicator);
    };
  }, [isDetailOverlayOpen, overlayListing, updateOverlayScrollIndicator]);

  const overlayMapTarget = useMemo(() => {
    if (!overlayListing) {
      return {
        ...defaultMapTarget,
        id: undefined,
        zoom: 13,
      };
    }

    return {
      id: overlayListing.id,
      lat:
        typeof overlayListing.lat === "number" &&
        Number.isFinite(overlayListing.lat)
          ? overlayListing.lat
          : defaultMapTarget.lat,
      lng:
        typeof overlayListing.lng === "number" &&
        Number.isFinite(overlayListing.lng)
          ? overlayListing.lng
          : defaultMapTarget.lng,
      label: overlayListing.name,
      zoom: 19,
    };
  }, [overlayListing]);

  const overlayMapListings = useMemo(() => {
    if (!overlayListing) {
      return [] as Array<{
        id: string;
        name: string;
        lat: number;
        lng: number;
        hoverPriceAmount: string;
      }>;
    }

    const total = Math.ceil(overlayListing.typicalAllInNightly * nights);
    return [
      {
        id: overlayListing.id,
        name: overlayListing.name,
        lat:
          typeof overlayListing.lat === "number" &&
          Number.isFinite(overlayListing.lat)
            ? overlayListing.lat
            : defaultMapTarget.lat,
        lng:
          typeof overlayListing.lng === "number" &&
          Number.isFinite(overlayListing.lng)
            ? overlayListing.lng
            : defaultMapTarget.lng,
        hoverPriceAmount: `$${total.toLocaleString("en-US")}`,
      },
    ];
  }, [nights, overlayListing]);

  const overlayTypicalAllInTotal = useMemo(() => {
    if (!overlayListing) {
      return null;
    }
    return Math.ceil(overlayListing.typicalAllInNightly * nights);
  }, [nights, overlayListing]);

  const overlayUpcomingMonthlyTotals = useMemo(() => {
    if (!overlayListing?.upcomingTypicalPricingMonths?.length) {
      return [] as Array<{
        monthLabel: string;
        total: number;
      }>;
    }

    return overlayListing.upcomingTypicalPricingMonths
      .slice(0, 3)
      .map((item) => ({
        monthLabel: item.monthLabel,
        total: Math.ceil(item.typicalAllInNightly * nights),
      }));
  }, [nights, overlayListing]);

  const overlayEmotionalHeadline = useMemo(() => {
    if (!overlayListing) {
      return null;
    }

    const candidate = (overlayListing.descriptionHeadline ?? "")
      .replace(/[^a-zA-Z0-9\s'’-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const wordCount = candidate.length > 0 ? candidate.split(/\s+/).length : 0;
    if (wordCount >= 2 && wordCount <= 8) {
      return candidate;
    }
    return null;
  }, [overlayListing]);

  const overlayFeaturePills = useMemo(() => {
    if (!overlayListing) {
      return [] as string[];
    }

    const features = [
      overlayListing.gulffront ? "Gulf Front" : null,
      overlayListing.privatePool ? "Private Pool" : null,
      overlayListing.golfCart ? "Golf Cart" : null,
    ].filter((value): value is string => Boolean(value));

    return features;
  }, [overlayListing]);

  const overlayCommunityPill = useMemo(() => {
    const value = overlayLocation?.locationChip?.trim();
    return value && value.length > 0 ? value : null;
  }, [overlayLocation?.locationChip]);

  const overlayImageCards = useMemo(() => {
    if (!overlayListing) {
      return {
        images: [] as Array<{ key: string; url: string; label: string }>,
        totalImageCount: 0,
      };
    }

    const combined: Array<{ url: string; label: string }> = [];
    const pushImage = (
      urlRaw: unknown,
      labelRaw: unknown,
      fallback: string,
    ) => {
      const url = typeof urlRaw === "string" ? urlRaw.trim() : "";
      if (!url) {
        return;
      }

      const label = typeof labelRaw === "string" ? labelRaw.trim() : "";
      combined.push({
        url,
        label: label || fallback,
      });
    };

    for (const image of overlayListing.images ?? []) {
      pushImage(image.url, image.name, `${overlayListing.name} photo`);
    }

    for (const image of overlayListing.imageGallery ?? []) {
      pushImage(image.url, image.name, `${overlayListing.name} photo`);
    }

    for (const previewImage of overlayListing.previewImages) {
      pushImage(previewImage, "", `${overlayListing.name} preview`);
    }

    const deduped: Array<{ key: string; url: string; label: string }> = [];
    const seen = new Set<string>();
    for (const image of combined) {
      const key = image.url.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      deduped.push({
        key,
        url: image.url,
        label: image.label,
      });
    }

    return {
      images: deduped,
      totalImageCount: Math.max(overlayListing.imageCount ?? 0, seen.size),
    };
  }, [overlayListing]);

  const openOverlayImageLightbox = useCallback(
    (index: number) => {
      const imageCount = overlayImageCards.images.length;
      if (imageCount === 0) {
        return;
      }

      const clampedIndex = Math.max(0, Math.min(index, imageCount - 1));
      setLoadedLightboxThumbUrls(new Set());
      setLightboxThumbRetryCounts({});
      setOverlayLightboxImageIndex(clampedIndex);
      setIsOverlayImageLightboxOpen(true);
    },
    [overlayImageCards.images.length],
  );

  const closeOverlayImageLightbox = useCallback(() => {
    setIsOverlayImageLightboxOpen(false);
    setLoadedLightboxThumbUrls(new Set());
    setLightboxThumbRetryCounts({});
  }, []);

  const showPreviousOverlayLightboxImage = useCallback(() => {
    setOverlayLightboxImageIndex((current) => Math.max(0, current - 1));
  }, []);

  const showNextOverlayLightboxImage = useCallback(() => {
    const imageCount = overlayImageCards.images.length;
    if (imageCount <= 1) {
      return;
    }

    setOverlayLightboxImageIndex((current) =>
      Math.min(imageCount - 1, current + 1),
    );
  }, [overlayImageCards.images.length]);

  const overlayLightboxImageCount = overlayImageCards.images.length;
  const overlayLightboxImageIndexClamped = Math.max(
    0,
    Math.min(
      overlayLightboxImageIndex,
      Math.max(0, overlayLightboxImageCount - 1),
    ),
  );
  const isOverlayImageLightboxVisible =
    isOverlayImageLightboxOpen &&
    isDetailOverlayOpen &&
    overlayLightboxImageCount > 0;

  const isOverlayLightboxAtFirstImage = overlayLightboxImageIndexClamped <= 0;
  const isOverlayLightboxAtLastImage =
    overlayLightboxImageIndexClamped >= overlayLightboxImageCount - 1;

  const goToFirstOverlayLightboxImage = useCallback(() => {
    setOverlayLightboxImageIndex(0);
  }, []);

  const goToLastOverlayLightboxImage = useCallback(() => {
    const imageCount = overlayImageCards.images.length;
    if (imageCount <= 0) {
      return;
    }
    setOverlayLightboxImageIndex(imageCount - 1);
  }, [overlayImageCards.images.length]);

  useEffect(() => {
    if (!isOverlayImageLightboxVisible) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeOverlayImageLightbox();
        return;
      }

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        showPreviousOverlayLightboxImage();
        return;
      }

      if (event.key === "ArrowRight") {
        event.preventDefault();
        showNextOverlayLightboxImage();
        return;
      }

      if (event.key === "Home") {
        event.preventDefault();
        goToFirstOverlayLightboxImage();
        return;
      }

      if (event.key === "End") {
        event.preventDefault();
        goToLastOverlayLightboxImage();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [
    closeOverlayImageLightbox,
    goToFirstOverlayLightboxImage,
    goToLastOverlayLightboxImage,
    isOverlayImageLightboxVisible,
    showNextOverlayLightboxImage,
    showPreviousOverlayLightboxImage,
  ]);

  useEffect(() => {
    if (!isOverlayImageLightboxVisible) {
      return;
    }

    const imageCount = overlayImageCards.images.length;
    if (imageCount === 0) {
      return;
    }

    const preloadIndexes = new Set<number>();
    for (let index = 0; index < imageCount; index += 1) {
      preloadIndexes.add(index);
    }

    for (const index of preloadIndexes) {
      const url = overlayImageCards.images[index]?.url;
      if (!url) {
        continue;
      }

      if (loadedLightboxThumbUrls.has(url)) {
        continue;
      }

      const img = new Image();
      img.decoding = "async";
      img.src = url;
      img.onload = () => {
        setLoadedLightboxThumbUrls((current) => {
          if (current.has(url)) {
            return current;
          }
          const next = new Set(current);
          next.add(url);
          return next;
        });
      };
      img.onerror = () => {
        const retryCount = lightboxThumbRetryCounts[url] ?? 0;
        if (retryCount >= 3) {
          return;
        }

        const retryDelayMs = 220 * (retryCount + 1);
        window.setTimeout(() => {
          setLightboxThumbRetryCounts((current) => {
            const currentCount = current[url] ?? 0;
            if (currentCount > retryCount) {
              return current;
            }

            return {
              ...current,
              [url]: currentCount + 1,
            };
          });
        }, retryDelayMs);
      };
    }
  }, [
    isOverlayImageLightboxVisible,
    lightboxThumbRetryCounts,
    loadedLightboxThumbUrls,
    overlayImageCards.images,
    overlayLightboxImageIndexClamped,
  ]);

  useEffect(() => {
    if (!isOverlayImageLightboxVisible) {
      return;
    }

    const thumbRail = overlayLightboxThumbRailRef.current;
    if (!thumbRail) {
      return;
    }

    const activeThumb = thumbRail.querySelector<HTMLButtonElement>(
      `[data-lightbox-thumb-index="${overlayLightboxImageIndexClamped}"]`,
    );

    if (!activeThumb) {
      return;
    }

    const railRect = thumbRail.getBoundingClientRect();
    const thumbRect = activeThumb.getBoundingClientRect();
    const edgeBuffer = 24;
    const isOutsideVisibleRail =
      thumbRect.left < railRect.left + edgeBuffer ||
      thumbRect.right > railRect.right - edgeBuffer;

    if (!isOutsideVisibleRail) {
      return;
    }

    const targetScrollLeft =
      activeThumb.offsetLeft -
      thumbRail.clientWidth / 2 +
      activeThumb.clientWidth / 2;

    const clampedTargetScrollLeft = Math.max(0, targetScrollLeft);
    const distance = Math.abs(clampedTargetScrollLeft - thumbRail.scrollLeft);

    // For long jumps (for example Home/End), avoid animating across the
    // entire strip: snap near target, then do a short smooth settle.
    if (distance > thumbRail.clientWidth * 1.25) {
      const jumpOffset = Math.max(thumbRail.clientWidth * 0.28, 120);
      const nearTarget =
        clampedTargetScrollLeft > thumbRail.scrollLeft
          ? clampedTargetScrollLeft - jumpOffset
          : clampedTargetScrollLeft + jumpOffset;

      thumbRail.scrollTo({
        left: Math.max(0, nearTarget),
        behavior: "auto",
      });

      window.requestAnimationFrame(() => {
        thumbRail.scrollTo({
          left: clampedTargetScrollLeft,
          behavior: "smooth",
        });
      });

      return;
    }

    thumbRail.scrollTo({
      left: clampedTargetScrollLeft,
      behavior: "smooth",
    });
  }, [
    isOverlayImageLightboxVisible,
    overlayLightboxImageCount,
    overlayLightboxImageIndexClamped,
  ]);

  const overlayBedStats = useMemo(() => {
    if (!overlayListing) {
      return [] as Array<{ key: string; label: string; count: number }>;
    }

    const bedCounts = overlayListing.sleepingSummary?.bed_counts;
    const count = (value: unknown, fallback = 0) => {
      if (typeof value === "number" && Number.isFinite(value)) {
        return Math.max(0, Math.round(value));
      }
      return Math.max(0, Math.round(fallback));
    };

    return [
      { key: "king", label: "King Bed", count: count(bedCounts?.king, 0) },
      {
        key: "queen",
        label: "Queen Bed",
        count: count(bedCounts?.queen, 0),
      },
      { key: "full", label: "Full Bed", count: count(bedCounts?.full, 0) },
      {
        key: "twin",
        label: "Twin Bed",
        count: count(bedCounts?.twin_standalone, 0),
      },
      {
        key: "bunk",
        label: "Bunk Bed",
        count: count(bedCounts?.bunk_beds, 0),
      },
    ].filter((entry) => entry.count > 0);
  }, [overlayListing]);

  const openDetailOverlay = useCallback(
    (listingId: string) => {
      markDiscoverModalIntent(listingId);
      setOverlayMapExpandedListingId(undefined);
      void navigate({
        to: "/discover/listing/$slug",
        params: { slug: listingId },
      });
    },
    [navigate],
  );

  return (
    <HomeMarketingShell
      preferDarkTopNavText={false}
      showTopNav={false}
      showFooter={false}
      disableNavScrollEffect={true}
      contentClassName="relative overflow-hidden px-4 pb-12 pt-0 md:px-10 md:pt-0 2xl:px-16"
    >
      <div
        className="pointer-events-none fixed inset-0 z-0"
        style={{
          backgroundImage: `url(${homeHeroBackgroundImage})`,
          backgroundSize: "cover",
          backgroundPosition: "center",
        }}
      />
      <div className="pointer-events-none fixed inset-0 z-0 bg-slate-950/28" />

      <div hidden data-page-marker="discover-page" />
      <div hidden data-overlay-only-mode={overlayOnlyMode ? "true" : "false"} />
      <div hidden data-overlay-listing-id={effectiveOverlayListingId ?? ""} />

      <div className="pointer-events-none fixed top-4 left-4 z-5 md:top-6 md:left-8">
        <div className="px-2 py-1">
          <div className="flex min-w-32 flex-col items-center">
            <span
              className="text-4xl leading-none tracking-[0.06em] text-white"
              style={{ fontFamily: BRAND_DISPLAY_FONT_FAMILY }}
            >
              30<span className="text-[#2DD4BF]">A</span>
            </span>
            <span className="mt-1 text-[10px] font-bold tracking-[0.42em] text-white uppercase">
              Collections
            </span>
            <div className="mt-1 h-px w-28 bg-[#2DD4BF]" />
          </div>
        </div>
      </div>

      <section
        ref={discoverShellRef}
        className={`relative z-10 mx-auto w-full max-w-475 space-y-6 xl:flex xl:h-[calc(100dvh-2rem)] xl:flex-col xl:gap-6 xl:space-y-0 ${overlayOnlyMode ? "mt-4 md:mt-6" : "mt-6"}`}
      >
        {!overlayOnlyMode ? (
          <>
            <div ref={discoverSearchRegionRef}>
              <DiscoverSearchPanel
                locationQuery={locationQuery}
                onLocationQueryChange={setLocationQuery}
                onClearLocationQuery={() => setLocationQuery("")}
                earliestDate={earliestDate}
                latestDate={latestDate}
                nights={nights}
                datePanelOpenRequestToken={datePanelOpenRequestToken}
                onDateRangeChange={({ startDate, endDate }) => {
                  setEarliestDate(startDate);
                  setLatestDate(endDate);
                }}
                onNightsChange={setNights}
                adults={adults}
                onAdultsChange={setAdults}
                children={children}
                onChildrenChange={setChildren}
                showAdvanced={showAdvanced}
                onToggleAdvanced={() => setShowAdvanced((current) => !current)}
                filtersSummary={filtersSummary}
                onOpenFilters={() => setShowAdvanced(true)}
                dateSummary={dateSummary}
                onOpenDateRangePanel={() =>
                  setDatePanelOpenRequestToken((current) => (current ?? 0) + 1)
                }
                guestCount={guestCount}
                sortOption={sortOption}
                onSortChange={setSortOption}
                cardsPerRow={cardsPerRow}
                onCardsPerRowChange={setCardsPerRow}
                isCardLayoutLocked={isMapExpanded}
                resetFilters={resetFilters}
                onCloseAdvanced={() => setShowAdvanced(false)}
                minSleeps={minSleeps}
                onMinSleepsChange={setMinSleeps}
                minBedrooms={minBedrooms}
                onMinBedroomsChange={setMinBedrooms}
                minBathrooms={minBathrooms}
                onMinBathroomsChange={setMinBathrooms}
                minKingBeds={minKingBeds}
                onMinKingBedsChange={setMinKingBeds}
                minQueenBeds={minQueenBeds}
                onMinQueenBedsChange={setMinQueenBeds}
                minBunkBeds={minBunkBeds}
                onMinBunkBedsChange={setMinBunkBeds}
                selectedFeatures={selectedFeatures}
                onToggleFeature={toggleFeatureValue}
              />
            </div>

            <div
              className={`grid gap-6 xl:min-h-0 xl:flex-1 ${shouldConstrainSidePanels ? "xl:overflow-hidden" : ""} ${
                isMapExpanded
                  ? "xl:grid-cols-[240px_minmax(0,0.9fr)_minmax(0,2.1fr)] 2xl:grid-cols-[220px_minmax(0,0.85fr)_minmax(0,2.25fr)]"
                  : "xl:grid-cols-[240px_minmax(0,1.45fr)_400px] 2xl:grid-cols-[220px_minmax(0,1.85fr)_340px]"
              }`}
            >
              <div className="h-full min-h-0">
                <DiscoverFacetSidebar
                  listingCount={propertiesListingCount}
                  favoriteCount={favoriteListingIds.length}
                  areaCounts={effectiveAreaCounts}
                  beachCounts={effectiveBeachCounts}
                  communityCounts={effectiveCommunityCounts}
                  featureCounts={effectiveFeatureCounts}
                  selectedAreas={selectedAreas}
                  selectedBeaches={selectedBeaches}
                  selectedCommunities={selectedCommunities}
                  selectedFeatures={selectedFeatures}
                  onToggleArea={(value) =>
                    toggleFacetValue(value, setSelectedAreas)
                  }
                  onToggleBeach={(value) =>
                    toggleFacetValue(value, setSelectedBeaches)
                  }
                  onToggleCommunity={(value) =>
                    toggleFacetValue(value, setSelectedCommunities)
                  }
                  onToggleFeature={toggleFeatureValue}
                  onClearAreas={() => setSelectedAreas([])}
                  onClearBeaches={() => setSelectedBeaches([])}
                  onClearCommunities={() => setSelectedCommunities([])}
                  onClearFeatures={() => setSelectedFeatures([])}
                  containerClassName={
                    shouldConstrainSidePanels
                      ? "xl:flex xl:h-full xl:min-h-0 xl:max-h-232 xl:flex-col xl:overflow-hidden"
                      : undefined
                  }
                  scrollSectionsOnly={shouldConstrainSidePanels}
                />
              </div>

              <DiscoverListingsPanel
                listings={displayListings}
                isLoading={isDiscoverListingsInitialLoading}
                loadingPlaceholderCount={loadingPlaceholderCount}
                nights={nights}
                cardsPerRow={isMapExpanded ? 1 : cardsPerRow}
                singleColumnCardVariant={expandedSingleCardVariant}
                activeListingId={activeListingId}
                scrollToListingRequestToken={selectedCardSyncRequestToken}
                onActiveListingVisibilityChange={setIsPinnedCardVisible}
                favoriteIds={favoriteListingIds}
                onToggleFavorite={toggleFavoriteListing}
                onFocusMap={handleFocusMap}
                onOpenDetailOverlay={openDetailOverlay}
              />

              <div
                className={
                  isDetailOverlayOpen ? "pointer-events-none invisible" : ""
                }
                aria-hidden={isDetailOverlayOpen}
              >
                {hasMountedPrimaryMapPanel ? (
                  <DiscoverMapPanel
                    mapTarget={mapTarget}
                    listings={deferredMapListings}
                    onClearPin={clearPinnedListing}
                    onSelectListing={handleSelectListingFromMap}
                    onSyncSelectedListingCard={requestSelectedCardSync}
                    isSyncSelectedListingCardAvailable={
                      canSyncSelectedListingCard
                    }
                    isExpanded={isMapExpanded}
                    onToggleExpanded={() =>
                      setIsMapExpanded((current) => !current)
                    }
                    panelClassName={
                      shouldConstrainSidePanels
                        ? "xl:flex xl:h-full xl:min-h-0 xl:max-h-232 xl:flex-col xl:overflow-hidden"
                        : undefined
                    }
                    mapViewportClassName={
                      shouldConstrainSidePanels
                        ? "relative mt-3 h-88 overflow-hidden rounded-xl border border-slate-200 bg-slate-100 sm:h-104 xl:h-auto xl:min-h-0 xl:flex-1"
                        : undefined
                    }
                  />
                ) : (
                  <div className="mt-3 h-88 rounded-xl border border-slate-200 bg-slate-100 sm:h-104 xl:h-232" />
                )}
              </div>
            </div>
          </>
        ) : null}

        {shouldRenderOverlay ? (
          <div
            ref={overlayContainerRef}
            className={`${overlayOnlyMode ? "relative h-[calc(100dvh-6rem)] md:h-[calc(100dvh-5.5rem)] xl:h-[calc(100dvh-2rem)]" : "absolute inset-0"} z-40 overflow-hidden rounded-2xl border border-slate-200 bg-slate-100 shadow-[0_32px_80px_-42px_rgba(15,23,42,0.9)] transition-opacity duration-75 ${isDetailOverlayOpen ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"}`}
          >
            {!isDetailOverlayOpen ? null : overlayListing ? (
              <div className="relative grid h-full min-h-0 gap-x-4 gap-y-3 overflow-x-hidden p-3 md:gap-y-4 md:p-4 xl:grid-cols-[290px_minmax(0,1fr)_290px] xl:grid-rows-[auto_minmax(0,1fr)] 2xl:grid-cols-[340px_minmax(0,1fr)_340px]">
                <section className="relative col-span-full h-[clamp(15rem,34vh,20rem)] overflow-hidden rounded-2xl border border-slate-200 bg-slate-900 shadow-[0_24px_48px_-34px_rgba(15,23,42,0.85)] md:h-[clamp(17rem,40vh,24rem)] xl:h-[clamp(19rem,46vh,28rem)]">
                  <img
                    src={
                      overlayListing.imageGallery?.[0]?.url ??
                      overlayListing.previewImages[0]
                    }
                    alt={`${overlayListing.name} hero image`}
                    className="absolute inset-0 block h-full w-full object-cover"
                  />
                  <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-[44%] bg-linear-to-b from-slate-950/70 via-slate-900/30 to-transparent" />
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-[30%] bg-linear-to-t from-slate-950/80 via-slate-900/45 to-transparent" />

                  <div className="absolute top-4 right-4 z-30 flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => {
                        if (effectiveOverlayListingId) {
                          toggleFavoriteListing(effectiveOverlayListingId);
                        }
                      }}
                      className={`relative inline-flex h-12 w-12 items-center justify-center rounded-full bg-slate-950/35 shadow-[0_14px_28px_-18px_rgba(15,23,42,0.75)] backdrop-blur-md transition hover:bg-white/85 ${effectiveOverlayListingId && favoriteListingIds.includes(effectiveOverlayListingId) ? "text-rose-400 hover:text-rose-600" : "text-white hover:text-slate-900"}`}
                      aria-label="Toggle favorite"
                      title="Toggle favorite"
                    >
                      {effectiveOverlayListingId &&
                      favoriteListingIds.includes(effectiveOverlayListingId) ? (
                        <span
                          aria-hidden="true"
                          className="pointer-events-none absolute -inset-1 animate-ping rounded-full border border-rose-300/80"
                        />
                      ) : null}
                      <Heart
                        className="h-6 w-6"
                        fill={
                          effectiveOverlayListingId &&
                          favoriteListingIds.includes(effectiveOverlayListingId)
                            ? "currentColor"
                            : "none"
                        }
                        stroke="currentColor"
                      />
                    </button>
                    <button
                      type="button"
                      onPointerDown={handleCloseDetailOverlayPointerDown}
                      onClick={handleCloseDetailOverlayClick}
                      className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-slate-950/35 text-white shadow-[0_14px_28px_-18px_rgba(15,23,42,0.75)] backdrop-blur-md transition hover:bg-white/85 hover:text-slate-900"
                      aria-label="Close details box"
                      title="Close details box"
                    >
                      <X className="h-6 w-6" />
                    </button>
                  </div>

                  <div className="absolute top-4 left-4 z-20 max-w-4xl md:top-6 md:left-6">
                    <p className="text-[10px] font-bold tracking-[0.2em] text-cyan-200 uppercase">
                      {overlayLocation?.subline ??
                        `${overlayListing.community} • ${overlayListing.area}`}
                    </p>
                    <h2
                      className="mt-2 max-w-4xl text-6xl leading-[0.95] text-white md:text-7xl xl:text-8xl"
                      style={{
                        fontFamily: BRAND_DISPLAY_FONT_FAMILY,
                        textShadow: "0 10px 24px rgba(15,23,42,0.72)",
                      }}
                    >
                      {overlayListing.name}
                    </h2>
                  </div>

                  <div className="absolute bottom-4 left-4 z-30 max-w-[72vw] md:bottom-6 md:left-6 md:max-w-[62vw]">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-left text-sm font-semibold tracking-[0.03em] text-slate-100 md:text-base">
                        {overlayListing.bedrooms} BR,{" "}
                        {formatBathrooms(overlayListing.bathrooms)} BA, Sleeps{" "}
                        {overlayListing.sleeps}
                      </p>
                    </div>
                  </div>

                  <div className="absolute right-4 bottom-4 z-30 max-w-[72vw] md:right-6 md:bottom-6 md:max-w-[62vw]">
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      {overlayFeaturePills.map((pill, index) => (
                        <span
                          key={`${pill}-${index}`}
                          className={`rounded-full border px-3 py-1 text-xs font-semibold backdrop-blur-sm ${pill === "Gulf Front" ? "border-amber-200 bg-amber-50 text-amber-800" : pill === "Private Pool" ? "border-blue-200 bg-blue-50 text-blue-800" : pill === "Golf Cart" ? "border-teal-200 bg-teal-50 text-teal-800" : "border-teal-300 bg-teal-100 text-teal-900"}`}
                        >
                          {pill}
                        </span>
                      ))}
                      {overlayCommunityPill ? (
                        <span className="rounded-full border border-teal-300 bg-teal-100 px-3 py-1 text-xs font-semibold text-teal-900">
                          {overlayCommunityPill}
                        </span>
                      ) : null}
                    </div>
                  </div>
                </section>

                {isOverlayMapExpanded ? (
                  <section className="col-span-full min-h-0 rounded-2xl border border-white/75 bg-white/95 p-4 shadow-[0_18px_34px_-28px_rgba(15,23,42,0.7)]">
                    <div className="h-full min-h-80">
                      <DiscoverMapPanel
                        mapTarget={overlayMapTarget}
                        listings={overlayMapListings}
                        onClearPin={() => {}}
                        onSelectListing={() => {}}
                        onSyncSelectedListingCard={() => {}}
                        isSyncSelectedListingCardAvailable={false}
                        isExpanded={true}
                        onToggleExpanded={() =>
                          setOverlayMapExpandedListingId(undefined)
                        }
                        showExpandControl={true}
                        showSyncControl={false}
                        showClearPinControl={false}
                        resetToInitialTargetView={true}
                        stickyOnDesktop={false}
                        panelClassName="h-full border-0 bg-transparent p-0 shadow-none"
                        mapViewportClassName="relative mt-2 h-[calc(100%-2.5rem)] min-h-80 overflow-hidden rounded-xl border border-slate-200 bg-slate-100"
                      />
                    </div>
                  </section>
                ) : (
                  <>
                    <aside className="hidden min-h-0 rounded-2xl border border-white/75 bg-white/92 p-4 shadow-[0_18px_34px_-28px_rgba(15,23,42,0.7)] xl:flex xl:flex-col">
                      <p className="text-[10px] font-bold tracking-[0.16em] text-slate-500 uppercase">
                        Scroll to Browse Gallery
                      </p>
                      <div className="discover-cards-scroll mt-3 min-h-0 flex-1 overflow-y-auto pr-1">
                        {overlayImageCards.images.length > 0 ? (
                          <ul className="space-y-2">
                            {overlayImageCards.images.map((image, index) => (
                              <li
                                key={`${image.key}-${index}`}
                                className="group relative overflow-hidden rounded-xl border border-slate-200 bg-slate-100"
                              >
                                <button
                                  type="button"
                                  onClick={() =>
                                    openOverlayImageLightbox(index)
                                  }
                                  className="relative block w-full cursor-zoom-in text-left"
                                  aria-label={`Open image ${index + 1} in lightbox`}
                                  title="Open image"
                                >
                                  <img
                                    src={image.url}
                                    alt={image.label}
                                    loading="lazy"
                                    decoding="async"
                                    style={{ aspectRatio: "16 / 9" }}
                                    className="block w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
                                  />
                                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                                    <span className="inline-flex h-11 w-11 items-center justify-center rounded-full border border-white/70 bg-slate-900/45 text-white opacity-0 shadow-[0_12px_24px_-18px_rgba(15,23,42,0.9)] backdrop-blur-sm transition duration-200 group-focus-within:opacity-100 group-hover:opacity-100">
                                      <Search className="h-5 w-5" />
                                    </span>
                                  </div>
                                </button>
                                <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-linear-to-t from-slate-950/65 via-slate-900/20 to-transparent px-2 py-1.5">
                                  <p className="text-[11px] font-semibold text-white">
                                    {index + 1}
                                  </p>
                                </div>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">
                            Photo cards will appear here once the gallery is
                            available.
                          </div>
                        )}
                      </div>
                    </aside>

                    <section className="relative min-h-0 overflow-hidden rounded-2xl border border-white/75 bg-white/95 shadow-[0_18px_34px_-28px_rgba(15,23,42,0.7)] xl:flex xl:flex-col">
                      <article
                        ref={overlayDetailScrollRef}
                        className="discover-cards-scroll min-h-0 overflow-y-auto px-8 pt-6 pb-20 md:px-11 md:pt-7 xl:h-full xl:flex-1 xl:px-12"
                      >
                        <div className="min-h-0 space-y-6">
                          {overlayEmotionalHeadline ? (
                            <h3
                              className="mb-7 text-[2.3rem] leading-[1.16] text-slate-800 italic md:mb-9 md:text-[2.75rem]"
                              style={{ fontFamily: BRAND_DISPLAY_FONT_FAMILY }}
                            >
                              {overlayEmotionalHeadline.replace(/[.!?]+$/, "") +
                                "."}
                            </h3>
                          ) : null}

                          <div className="grid min-h-0 gap-y-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] xl:items-start xl:gap-x-14 2xl:gap-x-18">
                            <section className="min-h-0 space-y-6 xl:pr-2 2xl:pr-3">
                              <Suspense
                                fallback={
                                  <p className="mb-4 max-w-[70ch] font-sans text-[1.1rem] leading-8 font-normal text-slate-600 last:mb-0">
                                    {overlayListing.description ??
                                      `A bright, coastal-forward stay in ${overlayListing.area} with room for ${overlayListing.sleeps} guests.`}
                                  </p>
                                }
                              >
                                <DiscoverListingMarkdown
                                  markdown={overlayListing.descriptionMarkdown}
                                  fallback={
                                    overlayListing.description ??
                                    `A bright, coastal-forward stay in ${overlayListing.area} with room for ${overlayListing.sleeps} guests.`
                                  }
                                />
                              </Suspense>

                              <aside className="min-h-0 border-t border-slate-200/80 pt-5">
                                {overlayBedStats.length > 0 ? (
                                  <div className="mb-4 flex flex-wrap items-center gap-1.5">
                                    {overlayBedStats.map((entry) => (
                                      <span
                                        key={entry.key}
                                        className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-sm font-medium text-slate-700"
                                      >
                                        <BedDouble className="h-3.5 w-3.5 text-slate-500" />
                                        {entry.count} {entry.label}
                                        {entry.count === 1 ? "" : "s"}
                                      </span>
                                    ))}
                                  </div>
                                ) : null}
                                <section className="rounded-2xl border border-slate-200 bg-slate-50/75 p-4 md:p-5">
                                  <h3 className="font-sans text-[0.95rem] font-bold tracking-[0.2em] text-slate-900 uppercase">
                                    Special Features
                                  </h3>
                                  <ul className="mt-3 list-outside list-disc space-y-2 pl-5 font-sans text-[1rem] leading-7 text-slate-700 marker:text-slate-400">
                                    {(overlayListing.highlightsList?.length
                                      ? overlayListing.highlightsList.slice(
                                          0,
                                          10,
                                        )
                                      : [
                                          overlayListing.gulffront
                                            ? "Gulf Front"
                                            : null,
                                          overlayListing.privatePool
                                            ? "Private Pool"
                                            : null,
                                          overlayListing.golfCart
                                            ? "Golf Cart"
                                            : null,
                                        ].filter((chip): chip is string =>
                                          Boolean(chip),
                                        )
                                    ).map((line) => (
                                      <li key={line} className="font-medium">
                                        {line}
                                      </li>
                                    ))}
                                  </ul>
                                </section>
                              </aside>
                            </section>

                            <div className="space-y-6 xl:pl-2 2xl:space-y-7 2xl:pl-3">
                              <section className="rounded-2xl border border-slate-200 bg-white/95 p-4 shadow-[0_14px_30px_-26px_rgba(15,23,42,0.75)] md:p-5">
                                <div className="flex items-center gap-2 text-slate-700">
                                  <CalendarDays className="h-4 w-4" />
                                  <p className="text-[10px] font-bold tracking-[0.14em] uppercase">
                                    Define Your {nights} Night Stay
                                  </p>
                                </div>
                                <div className="mt-2">
                                  <DateRangeField
                                    startDate={checkInDate}
                                    endDate={checkOutDate}
                                    selectedNights={nights}
                                    emptyLabel="Check-In / Check-out"
                                    openRequestToken={
                                      checkDatePanelOpenRequestToken
                                    }
                                    onChange={({ startDate, endDate }) => {
                                      setCheckInDate(startDate);
                                      setCheckOutDate(endDate);
                                    }}
                                  />
                                </div>
                                <div className="mt-2">
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setCheckDatePanelOpenRequestToken(
                                        (current) => (current ?? 0) + 1,
                                      )
                                    }
                                    className="inline-flex h-10 w-full items-center justify-center rounded-md border border-teal-600 bg-linear-to-r from-teal-600 to-cyan-600 px-3 text-sm font-semibold whitespace-nowrap text-white shadow-[0_8px_18px_-12px_rgba(13,148,136,0.75)] transition hover:brightness-105"
                                  >
                                    Check Availability
                                  </button>
                                </div>
                              </section>

                              <section className="rounded-2xl border border-cyan-200 bg-cyan-50/70 p-4 shadow-[0_14px_30px_-26px_rgba(15,23,42,0.75)] md:p-5">
                                <h3 className="font-sans text-[0.9rem] font-bold tracking-[0.2em] text-cyan-900 uppercase">
                                  Typical Pricing
                                </h3>
                                <p className="mt-3 text-sm leading-6 text-slate-700">
                                  Typical all-in price for {nights}{" "}
                                  {nights === 1 ? "night" : "nights"}:{" "}
                                  <span className="font-semibold text-slate-900">
                                    {overlayTypicalAllInTotal !== null
                                      ? `$${overlayTypicalAllInTotal.toLocaleString("en-US")}`
                                      : "Loading..."}
                                  </span>
                                  .
                                </p>
                                <p className="mt-2 text-xs leading-5 text-slate-600">
                                  This is a planning estimate. Once you check
                                  availability and dates are confirmed, we will
                                  provide an accurate live quote for this stay.
                                </p>
                                {overlayUpcomingMonthlyTotals.length > 0 ? (
                                  <div className="mt-3 rounded-xl border border-cyan-200/70 bg-white/70 p-3">
                                    <p className="text-[11px] font-semibold tracking-[0.04em] text-cyan-900 uppercase">
                                      Next 3 Months
                                    </p>
                                    <ul className="mt-2 space-y-1.5 text-sm text-slate-700">
                                      {overlayUpcomingMonthlyTotals.map(
                                        (item) => (
                                          <li
                                            key={item.monthLabel}
                                            className="flex items-center justify-between gap-3"
                                          >
                                            <span>{item.monthLabel}</span>
                                            <span className="font-semibold text-slate-900">
                                              $
                                              {item.total.toLocaleString(
                                                "en-US",
                                              )}
                                            </span>
                                          </li>
                                        ),
                                      )}
                                    </ul>
                                  </div>
                                ) : null}
                              </section>

                              <section className="rounded-2xl border border-slate-200 bg-slate-50/75 p-4 md:p-5">
                                <h3 className="font-sans text-[0.9rem] font-bold tracking-[0.2em] text-slate-900 uppercase">
                                  Helpful Hints
                                </h3>
                                <ul className="mt-3 list-outside list-disc space-y-2 pl-5 font-sans text-[0.95rem] leading-6 text-slate-600 marker:text-slate-400">
                                  {(overlayListing.helpfulHints?.length
                                    ? overlayListing.helpfulHints.slice(0, 6)
                                    : [
                                        `Check-in: ${overlayListing.checkInTime ?? "4:00 PM"}.`,
                                        `Check-out: ${overlayListing.checkOutTime ?? "10:00 AM"}.`,
                                      ]
                                  ).map((line) => (
                                    <li key={line} className="font-medium">
                                      {line}
                                    </li>
                                  ))}
                                </ul>
                              </section>
                            </div>
                          </div>
                        </div>
                      </article>
                      {showOverlayScrollFade ? (
                        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-8 h-20 bg-linear-to-t from-white/95 via-white/70 to-transparent backdrop-blur-[1.5px]" />
                      ) : null}
                      {showOverlayScrollIndicator ? (
                        <div className="absolute right-4 bottom-4 z-10">
                          <button
                            type="button"
                            onClick={handleOverlayScrollIndicatorClick}
                            className="relative inline-flex flex-col items-center justify-center gap-1 rounded-2xl border border-teal-200 bg-teal-50 px-2.5 py-2 text-teal-800 shadow-[0_16px_30px_-18px_rgba(13,148,136,0.75)] transition hover:border-teal-300 hover:bg-teal-100/60"
                            aria-label="Scroll detail content down"
                            title="Scroll down"
                          >
                            <span
                              aria-hidden="true"
                              className="pointer-events-none absolute -inset-1 animate-ping rounded-2xl border border-teal-300/80"
                            />
                            <Mouse className="h-4 w-4" />
                            <ChevronDown className="h-4 w-4" />
                          </button>
                        </div>
                      ) : null}
                    </section>

                    <aside className="min-h-0 min-w-0 overflow-hidden">
                      <DiscoverMapPanel
                        mapTarget={overlayMapTarget}
                        listings={overlayMapListings}
                        onClearPin={() => {}}
                        onSelectListing={() => {}}
                        onSyncSelectedListingCard={() => {}}
                        isSyncSelectedListingCardAvailable={false}
                        isExpanded={false}
                        onToggleExpanded={() =>
                          setOverlayMapExpandedListingId(
                            effectiveOverlayListingId,
                          )
                        }
                        showExpandControl={true}
                        showSyncControl={false}
                        showClearPinControl={false}
                        resetToInitialTargetView={true}
                        stickyOnDesktop={false}
                        panelClassName="min-h-0 min-w-0 self-stretch h-full"
                        mapViewportClassName="relative mt-3 min-h-0 flex-1 overflow-hidden rounded-xl border border-slate-200 bg-slate-100"
                      />
                    </aside>

                    {isOverlayImageLightboxOpen &&
                    overlayImageCards.images.length > 0 ? (
                      <div className="absolute inset-0 z-60 bg-slate-950/95">
                        <button
                          type="button"
                          onClick={closeOverlayImageLightbox}
                          className="absolute top-4 right-4 z-30 inline-flex h-12 w-12 items-center justify-center rounded-full bg-slate-950/35 text-white shadow-[0_14px_28px_-18px_rgba(15,23,42,0.75)] backdrop-blur-md transition hover:bg-white/85 hover:text-slate-900"
                          aria-label="Close image lightbox"
                          title="Close lightbox"
                        >
                          <X className="h-6 w-6" />
                        </button>

                        <div className="flex h-full min-h-0 flex-col">
                          <div className="relative min-h-0 flex-1 px-14 py-5 md:px-18 md:py-7">
                            <button
                              type="button"
                              onClick={showPreviousOverlayLightboxImage}
                              disabled={isOverlayLightboxAtFirstImage}
                              className={`group absolute top-1/2 left-4 z-20 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border text-white backdrop-blur-sm transition duration-150 ease-out ${
                                isOverlayLightboxAtFirstImage
                                  ? "cursor-not-allowed border-white/25 bg-slate-900/20 text-white/35"
                                  : "border-white/65 bg-slate-900/45 shadow-[0_10px_20px_-14px_rgba(15,23,42,0.9)] hover:-translate-y-[52%] hover:scale-105 hover:border-white/85 hover:bg-white/15 hover:shadow-[0_18px_30px_-16px_rgba(15,23,42,0.95)] active:scale-95"
                              }`}
                              aria-label="Previous image"
                              title="Previous image"
                            >
                              <ChevronLeft
                                className={`h-6 w-6 transition-transform duration-150 ease-out ${
                                  isOverlayLightboxAtFirstImage
                                    ? ""
                                    : "group-hover:-translate-x-0.5"
                                }`}
                              />
                            </button>

                            <div className="flex h-full items-center justify-center">
                              <img
                                src={
                                  overlayImageCards.images[
                                    overlayLightboxImageIndexClamped
                                  ]?.url
                                }
                                alt={
                                  overlayImageCards.images[
                                    overlayLightboxImageIndexClamped
                                  ]?.label ?? "Listing image"
                                }
                                className="h-full max-h-full w-auto max-w-full rounded-2xl object-contain shadow-[0_24px_60px_-36px_rgba(15,23,42,0.95)]"
                              />
                            </div>

                            <button
                              type="button"
                              onClick={showNextOverlayLightboxImage}
                              disabled={isOverlayLightboxAtLastImage}
                              className={`group absolute top-1/2 right-4 z-20 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border text-white backdrop-blur-sm transition duration-150 ease-out ${
                                isOverlayLightboxAtLastImage
                                  ? "cursor-not-allowed border-white/25 bg-slate-900/20 text-white/35"
                                  : "border-white/65 bg-slate-900/45 shadow-[0_10px_20px_-14px_rgba(15,23,42,0.9)] hover:-translate-y-[52%] hover:scale-105 hover:border-white/85 hover:bg-white/15 hover:shadow-[0_18px_30px_-16px_rgba(15,23,42,0.95)] active:scale-95"
                              }`}
                              aria-label="Next image"
                              title="Next image"
                            >
                              <ChevronRight
                                className={`h-6 w-6 transition-transform duration-150 ease-out ${
                                  isOverlayLightboxAtLastImage
                                    ? ""
                                    : "group-hover:translate-x-0.5"
                                }`}
                              />
                            </button>
                          </div>

                          <div className="border-t border-white/20 bg-slate-950/70 px-3 py-3 backdrop-blur-sm">
                            <div
                              ref={overlayLightboxThumbRailRef}
                              className="discover-cards-scroll mx-auto flex max-w-[92%] items-center gap-2 overflow-x-auto pb-1"
                            >
                              <button
                                type="button"
                                onClick={goToFirstOverlayLightboxImage}
                                disabled={isOverlayLightboxAtFirstImage}
                                className={`inline-flex h-16 w-12 shrink-0 items-center justify-center rounded-lg border transition ${
                                  isOverlayLightboxAtFirstImage
                                    ? "cursor-not-allowed border-white/25 bg-slate-900/20 text-white/35"
                                    : "border-white/45 bg-slate-900/45 text-white hover:border-white/80 hover:bg-slate-900/65"
                                }`}
                                aria-label="Go to first image"
                                title="First image (Home)"
                              >
                                <House className="h-5 w-5" />
                              </button>

                              {overlayImageCards.images.map((image, index) => {
                                const isActive =
                                  index === overlayLightboxImageIndexClamped;
                                const isThumbLoaded =
                                  loadedLightboxThumbUrls.has(image.url);
                                const retryCount =
                                  lightboxThumbRetryCounts[image.url] ?? 0;
                                return (
                                  <button
                                    key={`${image.key}-thumb-${index}`}
                                    type="button"
                                    onClick={() =>
                                      setOverlayLightboxImageIndex(index)
                                    }
                                    data-lightbox-thumb-index={index}
                                    className={`relative shrink-0 overflow-hidden rounded-lg border transition ${
                                      isActive
                                        ? "border-cyan-300 ring-2 ring-cyan-300/70"
                                        : "border-white/35 hover:border-cyan-300/80"
                                    } focus:outline-none`}
                                    aria-label={`View image ${index + 1}`}
                                    title={`Image ${index + 1}`}
                                  >
                                    <div
                                      aria-hidden="true"
                                      className={`pointer-events-none absolute inset-0 bg-linear-to-br from-slate-700/55 to-slate-800/65 transition-opacity duration-150 ${isThumbLoaded ? "opacity-0" : "opacity-100"}`}
                                    />
                                    <img
                                      key={`${image.url}-retry-${retryCount}`}
                                      src={image.url}
                                      alt={image.label}
                                      loading="lazy"
                                      decoding="async"
                                      onLoad={() => {
                                        setLoadedLightboxThumbUrls(
                                          (current) => {
                                            if (current.has(image.url)) {
                                              return current;
                                            }
                                            const next = new Set(current);
                                            next.add(image.url);
                                            return next;
                                          },
                                        );
                                      }}
                                      onError={() => {
                                        setLightboxThumbRetryCounts(
                                          (current) => {
                                            const currentCount =
                                              current[image.url] ?? 0;
                                            if (currentCount >= 3) {
                                              return current;
                                            }

                                            return {
                                              ...current,
                                              [image.url]: currentCount + 1,
                                            };
                                          },
                                        );
                                      }}
                                      style={{ aspectRatio: "16 / 9" }}
                                      className={`block h-16 w-28 object-cover transition-opacity duration-150 ${isThumbLoaded ? "opacity-100" : "opacity-0"}`}
                                    />
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        </div>
                      </div>
                    ) : null}
                  </>
                )}
              </div>
            ) : isOverlayDetailLoading ? (
              <div className="grid h-full min-h-0 gap-x-4 gap-y-3 overflow-x-hidden p-3 md:gap-y-4 md:p-4 xl:grid-cols-[290px_minmax(0,1fr)_290px] xl:grid-rows-[auto_minmax(0,1fr)] 2xl:grid-cols-[340px_minmax(0,1fr)_340px]">
                <section className="relative col-span-full h-[clamp(15rem,34vh,20rem)] overflow-hidden rounded-2xl border border-slate-200 bg-slate-300/55 shadow-[0_24px_48px_-34px_rgba(15,23,42,0.85)] md:h-[clamp(17rem,40vh,24rem)] xl:h-[clamp(19rem,46vh,28rem)]">
                  <div className="absolute inset-0 animate-pulse bg-slate-300/70" />
                  <div className="absolute top-4 right-4 z-30 flex items-center gap-3">
                    <div className="h-12 w-12 animate-pulse rounded-full bg-white/55" />
                    <div className="h-12 w-12 animate-pulse rounded-full bg-white/55" />
                  </div>
                  <div className="absolute top-4 left-4 z-20 max-w-4xl space-y-2 md:top-6 md:left-6">
                    <div className="h-3 w-40 animate-pulse rounded-full bg-white/60" />
                    <div className="h-12 w-96 max-w-[80vw] animate-pulse rounded-lg bg-white/65 md:h-14" />
                  </div>
                  <div className="absolute right-4 bottom-4 z-30 flex gap-2 md:right-6 md:bottom-6">
                    <div className="h-6 w-22 animate-pulse rounded-full bg-white/60" />
                    <div className="h-6 w-20 animate-pulse rounded-full bg-white/60" />
                  </div>
                </section>

                <aside className="hidden min-h-0 rounded-2xl border border-white/75 bg-white/92 p-4 shadow-[0_18px_34px_-28px_rgba(15,23,42,0.7)] xl:block">
                  <div className="h-3 w-28 animate-pulse rounded-full bg-slate-200/75" />
                  <div className="mt-2 h-4 w-44 animate-pulse rounded-full bg-slate-200/65" />
                  <div className="mt-4 space-y-2">
                    <div className="h-28 animate-pulse rounded-xl bg-slate-200/60" />
                    <div className="h-28 animate-pulse rounded-xl bg-slate-200/60" />
                    <div className="h-28 animate-pulse rounded-xl bg-slate-200/60" />
                  </div>
                </aside>

                <section className="min-h-0 overflow-hidden rounded-2xl border border-white/75 bg-white/95 shadow-[0_18px_34px_-28px_rgba(15,23,42,0.7)] xl:flex xl:flex-col">
                  <div className="discover-cards-scroll min-h-0 overflow-y-auto px-8 pt-6 pb-5 md:px-11 md:pt-7 xl:h-full xl:flex-1 xl:px-12">
                    <div className="space-y-6">
                      <div className="h-10 w-3/4 animate-pulse rounded-lg bg-slate-200/70 md:h-12" />
                      <div className="grid gap-y-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] xl:items-start xl:gap-x-14 2xl:gap-x-18">
                        <div className="space-y-3 xl:pr-2 2xl:pr-3">
                          <div className="h-4 w-full animate-pulse rounded-full bg-slate-200/60" />
                          <div className="h-4 w-[92%] animate-pulse rounded-full bg-slate-200/60" />
                          <div className="h-4 w-[88%] animate-pulse rounded-full bg-slate-200/60" />
                          <div className="h-4 w-[85%] animate-pulse rounded-full bg-slate-200/60" />
                          <div className="mt-4 h-36 animate-pulse rounded-2xl bg-slate-200/65" />
                        </div>
                        <div className="space-y-5 xl:pl-2 2xl:pl-3">
                          <div className="h-40 animate-pulse rounded-2xl bg-slate-200/65" />
                          <div className="h-30 animate-pulse rounded-2xl bg-slate-200/60" />
                          <div className="h-32 animate-pulse rounded-2xl bg-slate-200/55" />
                        </div>
                      </div>
                    </div>
                  </div>
                </section>

                <aside className="min-h-0 rounded-2xl border border-white/75 bg-white/92 p-4 shadow-[0_18px_34px_-28px_rgba(15,23,42,0.7)]">
                  <div className="h-3 w-24 animate-pulse rounded-full bg-slate-200/75" />
                  <div className="mt-3 h-[calc(100%-1.25rem)] min-h-55 animate-pulse rounded-xl bg-slate-200/60" />
                </aside>
              </div>
            ) : (
              <div className="grid h-full min-h-0 gap-x-4 gap-y-3 overflow-x-hidden p-3 md:gap-y-4 md:p-4 xl:grid-cols-[290px_minmax(0,1fr)_290px] xl:grid-rows-[auto_minmax(0,1fr)] 2xl:grid-cols-[340px_minmax(0,1fr)_340px]">
                <section className="relative col-span-full h-[clamp(15rem,34vh,20rem)] overflow-hidden rounded-2xl border border-slate-200 bg-slate-900 shadow-[0_24px_48px_-34px_rgba(15,23,42,0.85)] md:h-[clamp(17rem,40vh,24rem)] xl:h-[clamp(19rem,46vh,28rem)]">
                  <img
                    src={beachEntryTexture}
                    alt="30A shoreline path"
                    className="absolute inset-0 block h-full w-full object-cover"
                  />
                  <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-[44%] bg-linear-to-b from-slate-950/70 via-slate-900/30 to-transparent" />
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-[30%] bg-linear-to-t from-slate-950/80 via-slate-900/45 to-transparent" />

                  <div className="absolute top-4 right-4 z-30 flex items-center gap-3">
                    <button
                      type="button"
                      onPointerDown={handleCloseDetailOverlayPointerDown}
                      onClick={handleCloseDetailOverlayClick}
                      className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-slate-950/35 text-white shadow-[0_14px_28px_-18px_rgba(15,23,42,0.75)] backdrop-blur-md transition hover:bg-white/85 hover:text-slate-900"
                      aria-label="Close details box"
                      title="Close details box"
                    >
                      <X className="h-6 w-6" />
                    </button>
                  </div>

                  <div className="absolute top-4 left-4 z-20 max-w-4xl md:top-6 md:left-6">
                    <h2
                      className="mt-2 max-w-4xl text-6xl leading-[0.95] text-white md:text-7xl xl:text-8xl"
                      style={{
                        fontFamily: BRAND_DISPLAY_FONT_FAMILY,
                        textShadow: "0 10px 24px rgba(15,23,42,0.72)",
                      }}
                    >
                      Sorry, it wasn't meant to be.
                    </h2>
                  </div>

                  <div className="absolute right-4 bottom-4 z-30 md:right-6 md:bottom-6">
                    <div className="inline-flex w-fit items-center rounded-full border border-cyan-200/85 bg-white/92 px-3 py-1 text-[0.66rem] font-black tracking-[0.18em] text-cyan-900 uppercase shadow-[0_10px_22px_-14px_rgba(8,145,178,0.85)] backdrop-blur-sm">
                      Listing Unavailable
                    </div>
                  </div>
                </section>

                <aside className="hidden min-h-0 rounded-2xl border border-white/75 bg-white/85 p-4 xl:block">
                  <div className="h-7 w-32 rounded-full bg-slate-200/80" />
                  <div className="mt-3 h-5 w-44 rounded-full bg-slate-200/65" />
                  <div className="mt-2 h-5 w-36 rounded-full bg-slate-200/55" />
                  <div className="mt-5 h-24 rounded-xl bg-slate-200/60" />
                  <div className="mt-3 h-24 rounded-xl bg-slate-200/50" />
                </aside>

                <section className="relative min-h-0 overflow-hidden rounded-2xl border border-white/75 bg-white/90 shadow-[0_18px_38px_-30px_rgba(15,23,42,0.9)]">
                  <div className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-linear-to-b from-[#d2f6f1]/80 via-[#ebfaf7]/55 to-transparent" />
                  <div className="relative flex h-full flex-col items-center justify-start p-5 pt-10 text-center md:p-6 md:pt-12">
                    <h2
                      className="text-[clamp(1.75rem,2.7vw,2.35rem)] leading-[1.08] tracking-tight text-slate-900"
                      style={{ fontFamily: BRAND_DISPLAY_FONT_FAMILY }}
                    >
                      Find the <span className="text-[#14B8A6]">30A</span> home
                      that fits your trip right now.
                    </h2>

                    <p className="mt-5 max-w-2xl text-base leading-7 text-slate-700 md:text-[1.1rem] md:leading-8">
                      This listing is no longer available in the active
                      collection. Browse current options with live availability
                      and pricing details across 30A Collections.
                    </p>

                    <div className="mt-8">
                      <button
                        type="button"
                        onPointerDown={handleCloseDetailOverlayPointerDown}
                        onClick={handleCloseDetailOverlayClick}
                        className={`inline-flex items-center justify-center gap-2 ${HOME_ACTION_BUTTON_BASE} ${HOME_ACTION_BUTTON_LARGE_SIZE} ${HOME_ACTION_BUTTON_TEAL}`}
                      >
                        <span>EXPLORE THE COLLECTION</span>
                        <ArrowRight
                          className="h-4 w-4"
                          strokeWidth={2.25}
                          aria-hidden="true"
                        />
                      </button>
                    </div>
                  </div>
                </section>

                <aside className="min-h-0 rounded-2xl border border-white/75 bg-white/85 p-4">
                  <div className="h-6 w-28 rounded-full bg-slate-200/75" />
                  <div className="mt-4 h-28 rounded-xl bg-slate-200/60" />
                  <div className="mt-3 h-24 rounded-xl bg-slate-200/50" />
                  <div className="mt-3 h-24 rounded-xl bg-slate-200/45" />
                </aside>
              </div>
            )}
          </div>
        ) : null}
      </section>
    </HomeMarketingShell>
  );
}
