import { useNavigate, useRouterState } from "@tanstack/react-router";
import { differenceInCalendarDays, format, isValid, parseISO } from "date-fns";
import {
  Accessibility,
  ArrowUpDown,
  BedDouble,
  CalendarDays,
  CarFront,
  ChevronDown,
  Dog,
  Droplets,
  Heart,
  SlidersHorizontal,
  Waves,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import {
  DateRangeField,
  GuestStepper,
  IconOptionBox,
} from "@/components/discover/discover-controls";
import {
  homeHeroBackgroundImage,
  known30AAreas,
  known30ABeachZones,
  known30ACommunities,
  sampleListings,
  type DiscoverListing,
} from "@/components/discover/discover-data";
import {
  formatBathrooms,
  formatNights,
  getAreaFromListing,
  getBeachZoneFromListing,
  getListingGeoTarget,
  getLocationPresentation,
  verifyGulfFrontClaim,
} from "@/components/discover/discover-utils";
import { DiscoverFacetSidebar } from "@/components/discover/DiscoverFacetSidebar";
import { DiscoverListingsPanel } from "@/components/discover/DiscoverListingsPanel";
import { DiscoverMapPanel } from "@/components/discover/DiscoverMapPanel";
import {
  DiscoverSortLayoutControls,
  type SortOption,
} from "@/components/discover/DiscoverSortLayoutControls";
import { HomeMarketingShell } from "@/components/home/HomeMarketingShell";

const defaultMapTarget = {
  lat: 30.3199786,
  lng: -86.1377563,
  label: "Seaside Amphitheater",
  zoom: undefined as number | undefined,
};

// TODO: Temporary UX toggle. Keep false so Clear Pin does not recenter map.
const RESET_MAP_ON_CLEAR_PIN = false;
const BRAND_DISPLAY_FONT_FAMILY = "'Playfair Display', serif";

export function DiscoverPage({
  overlayListingId,
  initialListings,
}: {
  overlayListingId?: string;
  initialListings?: DiscoverListing[];
}) {
  const navigate = useNavigate();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const overlayListingIdFromPath = (() => {
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
  const initialLoadedListings = initialListings ?? [];
  const hasInitialOverlayListing = Boolean(
    requestedOverlayListingId &&
    initialLoadedListings.some(
      (listing) => listing.id === requestedOverlayListingId,
    ),
  );
  const defaultMinSleeps = 0;
  const defaultMinBedrooms = 0;
  const defaultMinBathrooms = 0;
  const defaultMinKingBeds = 0;
  const defaultMinQueenBeds = 0;

  const formatSummaryDate = (value: string, fallback: string) => {
    if (!value) {
      return fallback;
    }
    const parsed = parseISO(value);
    if (!isValid(parsed)) {
      return fallback;
    }
    return format(parsed, "MMM d, yyyy");
  };

  const parseSummaryDate = (value: string): Date | undefined => {
    if (!value) {
      return undefined;
    }
    const parsed = parseISO(value);
    return isValid(parsed) ? parsed : undefined;
  };

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

  const [locationQuery, setLocationQuery] = useState("");
  const [earliestDate, setEarliestDate] = useState("");
  const [latestDate, setLatestDate] = useState("");
  const [checkInDate, setCheckInDate] = useState("");
  const [checkOutDate, setCheckOutDate] = useState("");
  const [nights, setNights] = useState(7);
  const [adults, setAdults] = useState(2);
  const [children, setChildren] = useState(0);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [datePanelOpenRequestToken, setDatePanelOpenRequestToken] = useState<
    number | undefined
  >(undefined);
  const [checkDatePanelOpenRequestToken, setCheckDatePanelOpenRequestToken] =
    useState<number | undefined>(undefined);
  const [minSleeps, setMinSleeps] = useState(defaultMinSleeps);
  const [minBedrooms, setMinBedrooms] = useState(defaultMinBedrooms);
  const [minBathrooms, setMinBathrooms] = useState(defaultMinBathrooms);
  const [minKingBeds, setMinKingBeds] = useState(defaultMinKingBeds);
  const [minQueenBeds, setMinQueenBeds] = useState(defaultMinQueenBeds);
  const [filterPool, setFilterPool] = useState(false);
  const [filterBeachfront, setFilterBeachfront] = useState(false);
  const [filterGolfCart, setFilterGolfCart] = useState(false);
  const [filterPets, setFilterPets] = useState(false);
  const [filterAccessible, setFilterAccessible] = useState(false);
  const [filterElevator, setFilterElevator] = useState(false);
  const [mapTarget, setMapTarget] = useState(defaultMapTarget);
  const [activeListingId, setActiveListingId] = useState<string | undefined>(
    undefined,
  );
  const [isMapExpanded, setIsMapExpanded] = useState(false);
  const [cardsPerRow, setCardsPerRow] = useState<2 | 3 | 4>(3);
  const [expandedSingleCardVariant, setExpandedSingleCardVariant] = useState<
    3 | 4
  >(3);
  const [sortOption, setSortOption] = useState<SortOption>("recommended");
  const [fetchedListings, setFetchedListings] = useState<DiscoverListing[]>(
    () => initialLoadedListings,
  );
  const fetchedListingsRef = useRef<DiscoverListing[]>([]);
  const [isOverlayDetailLoading, setIsOverlayDetailLoading] = useState(
    isOverlayRoute && !hasInitialOverlayListing,
  );
  const [favoriteListingIds, setFavoriteListingIds] = useState<string[]>([]);
  const [selectedCardSyncRequestToken, setSelectedCardSyncRequestToken] =
    useState(0);
  const [isPinnedCardVisible, setIsPinnedCardVisible] = useState(true);
  const [overlayMapExpandedListingId, setOverlayMapExpandedListingId] =
    useState<string | undefined>(undefined);

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

  const resetMapView = useCallback(() => {
    setActiveListingId(undefined);
    setMapTarget(() => ({
      ...defaultMapTarget,
      id: undefined,
      zoom: 13,
    }));
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
    fetchedListingsRef.current = fetchedListings;
  }, [fetchedListings]);

  useEffect(() => {
    let isCancelled = false;

    const loadListings = async () => {
      const hasRequestedListingAlreadyLoaded = Boolean(
        requestedOverlayListingId &&
        fetchedListingsRef.current.some(
          (listing) => listing.id === requestedOverlayListingId,
        ),
      );
      if (hasRequestedListingAlreadyLoaded) {
        setIsOverlayDetailLoading(false);
        return;
      }

      try {
        setIsOverlayDetailLoading(Boolean(requestedOverlayListingId));
        const endpoint = requestedOverlayListingId
          ? `/api/discover/listings?include=${encodeURIComponent(requestedOverlayListingId)}`
          : "/api/discover/listings";
        const response = await fetch(endpoint);
        if (!response.ok || isCancelled) {
          if (!isCancelled) {
            setIsOverlayDetailLoading(false);
          }
          return;
        }

        const payload = (await response.json()) as { listings?: unknown };
        if (!Array.isArray(payload.listings)) {
          if (!isCancelled) {
            setIsOverlayDetailLoading(false);
          }
          return;
        }

        setFetchedListings(payload.listings as DiscoverListing[]);
        if (!isCancelled) {
          setIsOverlayDetailLoading(false);
        }
      } catch {
        if (!isCancelled) {
          setIsOverlayDetailLoading(false);
        }
        // Keep local sample data fallback when fetch fails.
      }
    };

    void loadListings();

    return () => {
      isCancelled = true;
    };
  }, [requestedOverlayListingId]);

  const sourceListings = useMemo(() => {
    if (fetchedListings.length > 0) {
      return fetchedListings.map(verifyGulfFrontClaim);
    }

    if (isOverlayRoute) {
      return [] as DiscoverListing[];
    }

    return sampleListings.map(verifyGulfFrontClaim);
  }, [fetchedListings, isOverlayRoute]);

  const guestCount = adults + children;

  const filtered = useMemo(() => {
    const normalized = locationQuery.trim().toLowerCase();

    return sourceListings.filter((listing) => {
      const locationBlob =
        `${listing.area} ${listing.community} ${listing.name}`.toLowerCase();
      const passesLocation =
        normalized.length === 0 || locationBlob.includes(normalized);
      const passesGuests = listing.sleeps >= guestCount;
      const passesSleeps = listing.sleeps >= minSleeps;
      const passesBedrooms = listing.bedrooms >= minBedrooms;
      const passesBathrooms = listing.bathrooms >= minBathrooms;
      const passesKingBeds = listing.kingBeds >= minKingBeds;
      const passesQueenBeds = listing.queenBeds >= minQueenBeds;
      const passesPool = !filterPool || listing.privatePool;
      const passesBeachfront = !filterBeachfront || listing.beachfront;
      const passesGolfCart = !filterGolfCart || listing.golfCart;
      const passesPets = !filterPets || listing.petsAllowed;
      const passesAccessible = !filterAccessible || listing.accessible;
      const passesElevator = !filterElevator || listing.elevator;

      return (
        passesLocation &&
        passesGuests &&
        passesSleeps &&
        passesBedrooms &&
        passesBathrooms &&
        passesKingBeds &&
        passesQueenBeds &&
        passesPool &&
        passesBeachfront &&
        passesGolfCart &&
        passesPets &&
        passesAccessible &&
        passesElevator
      );
    });
  }, [
    guestCount,
    locationQuery,
    minSleeps,
    minBathrooms,
    minBedrooms,
    minKingBeds,
    minQueenBeds,
    filterAccessible,
    filterBeachfront,
    filterElevator,
    filterGolfCart,
    filterPets,
    filterPool,
    sourceListings,
  ]);

  const displayListings = useMemo(() => {
    const listings = [...filtered];

    if (sortOption === "recommended") {
      return listings;
    }

    if (sortOption === "price-low") {
      return listings.sort((a, b) => {
        const aPrice = a.typicalAllInNightly * nights;
        const bPrice = b.typicalAllInNightly * nights;
        return aPrice - bPrice;
      });
    }

    if (sortOption === "price-high") {
      return listings.sort((a, b) => {
        const aPrice = a.typicalAllInNightly * nights;
        const bPrice = b.typicalAllInNightly * nights;
        return bPrice - aPrice;
      });
    }

    if (sortOption === "sleeps-high") {
      return listings.sort((a, b) => b.sleeps - a.sleeps);
    }

    return listings.sort((a, b) => {
      if (a.beachfront !== b.beachfront) {
        return Number(b.beachfront) - Number(a.beachfront);
      }
      if (a.privatePool !== b.privatePool) {
        return Number(b.privatePool) - Number(a.privatePool);
      }
      return b.sleeps - a.sleeps;
    });
  }, [filtered, nights, sortOption]);

  const mapListings = useMemo(
    () =>
      displayListings.map((listing) => {
        const geoTarget = getListingGeoTarget(listing);
        const typicalTotal = Math.ceil(listing.typicalAllInNightly * nights);
        return {
          id: listing.id,
          name: listing.name,
          lat: geoTarget.lat,
          lng: geoTarget.lng,
          hoverPriceAmount: `$${typicalTotal.toLocaleString("en-US")}`,
        };
      }),
    [displayListings, nights],
  );

  const areaCounts = useMemo(() => {
    const map = new Map<string, number>();
    filtered.forEach((listing) => {
      const normalizedArea = getAreaFromListing(listing);
      if (!normalizedArea) {
        return;
      }
      map.set(normalizedArea, (map.get(normalizedArea) ?? 0) + 1);
    });
    return known30AAreas.map((name) => [name, map.get(name) ?? 0] as const);
  }, [filtered]);

  const communityCounts = useMemo(() => {
    const map = new Map<string, number>();
    filtered.forEach((listing) => {
      if (!known30ACommunities.includes(listing.community)) {
        return;
      }
      map.set(listing.community, (map.get(listing.community) ?? 0) + 1);
    });
    return known30ACommunities.map(
      (name) => [name, map.get(name) ?? 0] as const,
    );
  }, [filtered]);

  const beachCounts = useMemo(() => {
    const map = new Map<string, number>();
    filtered.forEach((listing) => {
      const beachZone = getBeachZoneFromListing(listing);
      if (!beachZone || !known30ABeachZones.includes(beachZone)) {
        return;
      }
      map.set(beachZone, (map.get(beachZone) ?? 0) + 1);
    });

    return known30ABeachZones.map(
      (name) => [name, map.get(name) ?? 0] as const,
    );
  }, [filtered]);

  const featureCounts = useMemo(() => {
    let privatePoolCount = 0;
    let beachfrontCount = 0;
    let golfCartCount = 0;

    filtered.forEach((listing) => {
      if (listing.privatePool) {
        privatePoolCount += 1;
      }
      if (listing.beachfront) {
        beachfrontCount += 1;
      }
      if (listing.golfCart) {
        golfCartCount += 1;
      }
    });

    return [
      { label: "Gulf Front", count: beachfrontCount },
      { label: "Private Pool", count: privatePoolCount },
      { label: "Golf Cart", count: golfCartCount },
    ];
  }, [filtered]);

  const earliestParsed = parseSummaryDate(earliestDate);
  const latestParsed = parseSummaryDate(latestDate);

  let dateSummary = `Choose earliest and latest dates • ${formatNights(nights)}`;

  if (earliestParsed && latestParsed) {
    const spanDays = differenceInCalendarDays(latestParsed, earliestParsed);

    if (spanDays < nights) {
      const shortByDays = nights - spanDays;
      dateSummary = `Window too short • Add ${shortByDays} more ${shortByDays === 1 ? "day" : "days"} for ${formatNights(nights)}`;
    } else if (spanDays === nights) {
      dateSummary = `Exact Dates ${formatSummaryDate(earliestDate, "Earliest?")} - ${formatSummaryDate(latestDate, "Latest?")} • ${formatNights(nights)}`;
    } else {
      dateSummary = `Flexible ${formatSummaryDate(earliestDate, "Earliest?")} - ${formatSummaryDate(latestDate, "Latest?")} • ${formatNights(nights)}`;
    }
  } else if (earliestParsed) {
    dateSummary = `Start ${formatSummaryDate(earliestDate, "Earliest?")} • ${formatNights(nights)}`;
  } else if (latestParsed) {
    dateSummary = `Set earliest date • ${formatNights(nights)}`;
  }

  const resetFilters = () => {
    setMinSleeps(defaultMinSleeps);
    setMinBedrooms(defaultMinBedrooms);
    setMinBathrooms(defaultMinBathrooms);
    setMinKingBeds(defaultMinKingBeds);
    setMinQueenBeds(defaultMinQueenBeds);
    setFilterPool(false);
    setFilterBeachfront(false);
    setFilterGolfCart(false);
    setFilterPets(false);
    setFilterAccessible(false);
    setFilterElevator(false);
  };

  const activeFilterParts = [
    minSleeps > 0 ? `Sleeps ${minSleeps}+` : null,
    minBedrooms > 0 ? `${minBedrooms}BR+` : null,
    minBathrooms > 0 ? `${minBathrooms}BA+` : null,
    minKingBeds > 0 ? `${minKingBeds}K+` : null,
    minQueenBeds > 0 ? `${minQueenBeds}Q+` : null,
    filterBeachfront ? "Gulf Front" : null,
    filterPool ? "Private Pool" : null,
    filterGolfCart ? "Golf Cart" : null,
    filterPets ? "Pets" : null,
    filterElevator ? "Elevator" : null,
    filterAccessible ? "Accessible" : null,
  ].filter((part): part is string => Boolean(part));

  const filtersSummary =
    activeFilterParts.length > 0 ? activeFilterParts.join(" • ") : "None";

  const toggleFavoriteListing = useCallback((listingId: string) => {
    setFavoriteListingIds((current) =>
      current.includes(listingId)
        ? current.filter((id) => id !== listingId)
        : [...current, listingId],
    );
  }, []);

  const effectiveOverlayListingId = requestedOverlayListingId;
  const isDetailOverlayOpen = Boolean(effectiveOverlayListingId);
  const isOverlayMapExpanded =
    Boolean(effectiveOverlayListingId) &&
    overlayMapExpandedListingId === effectiveOverlayListingId;

  const overlayListing = useMemo(
    () =>
      sourceListings.find(
        (listing) => listing.id === effectiveOverlayListingId,
      ),
    [sourceListings, effectiveOverlayListingId],
  );

  const overlayLocation = useMemo(() => {
    if (!overlayListing) {
      return null;
    }
    return getLocationPresentation(overlayListing);
  }, [overlayListing]);

  const closeDetailOverlay = useCallback(() => {
    setOverlayMapExpandedListingId(undefined);
    void navigate({ to: "/discover" });
  }, [navigate]);

  useEffect(() => {
    if (!isDetailOverlayOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      closeDetailOverlay();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [closeDetailOverlay, isDetailOverlayOpen]);

  const overlayMapTarget = useMemo(() => {
    if (!overlayListing) {
      return {
        ...defaultMapTarget,
        id: undefined,
        zoom: 13,
      };
    }

    const geoTarget = getListingGeoTarget(overlayListing);
    return {
      id: overlayListing.id,
      lat: geoTarget.lat,
      lng: geoTarget.lng,
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

    const geoTarget = getListingGeoTarget(overlayListing);
    const total = Math.ceil(overlayListing.typicalAllInNightly * nights);
    return [
      {
        id: overlayListing.id,
        name: overlayListing.name,
        lat: geoTarget.lat,
        lng: geoTarget.lng,
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
      overlayListing.beachfront ? "Gulf Front" : null,
      overlayListing.privatePool ? "Private Pool" : null,
      overlayListing.golfCart ? "Golf Cart" : null,
    ].filter((value): value is string => Boolean(value));

    return features;
  }, [overlayListing]);

  const overlayCommunityPill = useMemo(() => {
    const value = overlayLocation?.locationChip?.trim();
    return value && value.length > 0 ? value : null;
  }, [overlayLocation?.locationChip]);

  const overlayAvailabilityByMonth = useMemo(() => {
    const availability = overlayListing?.availabilityCalendar;
    if (!availability || Object.keys(availability).length === 0) {
      return [] as Array<{
        key: string;
        label: string;
        count: number;
        min: number;
        max: number;
      }>;
    }

    const grouped = new Map<string, number[]>();
    for (const [iso, nightly] of Object.entries(availability)) {
      const date = parseISO(iso);
      if (!isValid(date)) {
        continue;
      }
      const key = format(date, "yyyy-MM");
      const values = grouped.get(key) ?? [];
      values.push(Math.max(0, Math.round(nightly)));
      grouped.set(key, values);
    }

    return Array.from(grouped.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, 12)
      .map(([key, values]) => {
        const sample = values.length > 0 ? values : [0];
        const monthDate = parseISO(`${key}-01`);
        return {
          key,
          label: isValid(monthDate) ? format(monthDate, "MMM yyyy") : key,
          count: values.length,
          min: Math.min(...sample),
          max: Math.max(...sample),
        };
      });
  }, [overlayListing?.availabilityCalendar]);

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

      <div className="fixed top-4 left-4 z-30 md:top-6 md:left-8">
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

      <section className="relative z-10 mx-auto mt-6 w-full max-w-475 space-y-6 xl:flex xl:h-[calc(100dvh-2rem)] xl:flex-col xl:gap-6 xl:space-y-0">
        <header className="relative z-20 rounded-2xl border border-slate-200 bg-white/95 p-5 shadow-[0_14px_30px_-26px_rgba(15,23,42,0.75)]">
          <div>
            <div className="grid gap-1.5 xl:grid-cols-[minmax(0,3.85fr)_minmax(19rem,2fr)_minmax(8.5rem,0.84fr)_minmax(8.5rem,0.84fr)_minmax(8.5rem,0.84fr)] xl:items-end">
              <div className="relative">
                <input
                  type="text"
                  value={locationQuery}
                  onChange={(event) => setLocationQuery(event.target.value)}
                  maxLength={120}
                  placeholder="Where would you love to stay? Try an area, community, or property name."
                  className="h-16 w-full rounded-lg border border-slate-300 bg-white px-4 pr-44 text-lg text-teal-800 placeholder:text-slate-400 focus:outline-none focus-visible:border-teal-300 focus-visible:ring-2 focus-visible:ring-teal-200/70"
                />
                {locationQuery ? (
                  <button
                    type="button"
                    onClick={() => setLocationQuery("")}
                    className="absolute top-1/2 right-35 z-10 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md border border-slate-300 bg-white text-slate-500 transition hover:border-rose-300 hover:bg-rose-50 hover:text-rose-700"
                    aria-label="Clear search input"
                    title="Clear search input"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                ) : null}
                <button
                  type="button"
                  className="absolute top-1/2 right-2 h-12 w-32 -translate-y-1/2 rounded-md border border-teal-600 bg-linear-to-r from-teal-600 to-cyan-600 px-4 text-sm font-bold whitespace-nowrap text-white shadow-[0_8px_20px_-12px_rgba(13,148,136,0.75)] transition hover:brightness-105"
                >
                  Search
                </button>
              </div>
              <DateRangeField
                startDate={earliestDate}
                endDate={latestDate}
                selectedNights={nights}
                openRequestToken={datePanelOpenRequestToken}
                onChange={({ startDate, endDate }) => {
                  setEarliestDate(startDate);
                  setLatestDate(endDate);
                }}
              />
              <GuestStepper
                controlLabel="minimum stay"
                pillText={formatNights(nights)}
                value={nights}
                min={1}
                max={21}
                onChange={setNights}
              />
              <GuestStepper
                controlLabel="adults"
                pillText={`${adults} ${adults === 1 ? "Adult" : "Adults"}`}
                value={adults}
                min={1}
                onChange={setAdults}
              />
              <GuestStepper
                controlLabel="children"
                pillText={`${children} ${children === 1 ? "Child" : "Children"}`}
                value={children}
                min={0}
                onChange={setChildren}
              />
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2 xl:flex-nowrap">
              <button
                type="button"
                onClick={() => setShowAdvanced((current) => !current)}
                className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-teal-600 bg-linear-to-r from-teal-600 to-cyan-600 px-3 text-xs font-semibold text-white shadow-[0_8px_20px_-12px_rgba(13,148,136,0.75)] transition hover:brightness-105"
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
                Advanced Filters
                <ChevronDown
                  className={`h-3.5 w-3.5 transition-transform ${showAdvanced ? "rotate-180" : ""}`}
                />
              </button>
              <div className="inline-flex items-center gap-1.5">
                <span className="text-xs font-normal text-slate-600">
                  Filters:
                </span>
                <button
                  type="button"
                  onClick={() => setShowAdvanced(true)}
                  className="rounded-full border border-teal-200 bg-teal-50 px-3 py-1 text-xs font-semibold text-teal-800 transition hover:border-teal-300 hover:bg-teal-100/60"
                  aria-label="Open filters panel"
                >
                  {filtersSummary}
                </button>
              </div>
              <div className="inline-flex items-center gap-1.5">
                <span className="text-xs font-normal text-slate-600">
                  Dates:
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setDatePanelOpenRequestToken(
                      (current) => (current ?? 0) + 1,
                    )
                  }
                  className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-800 transition hover:border-emerald-300 hover:bg-emerald-100/60"
                  aria-label="Open date range panel"
                >
                  {dateSummary}
                </button>
              </div>
              <div className="inline-flex items-center gap-1.5">
                <span className="text-xs font-normal text-slate-600">
                  Guests:
                </span>
                <span className="rounded-full border border-cyan-200 bg-cyan-50 px-3 py-1 text-xs font-semibold text-cyan-800">
                  {guestCount}
                </span>
              </div>
              <DiscoverSortLayoutControls
                sortOption={sortOption}
                onSortChange={setSortOption}
                cardsPerRow={cardsPerRow}
                onCardsPerRowChange={setCardsPerRow}
                isCardLayoutLocked={isMapExpanded}
              />
            </div>

            <div
              className={`overflow-hidden transition-all duration-300 ${showAdvanced ? "mt-3 max-h-[72vh] opacity-100" : "max-h-0 opacity-0"}`}
            >
              <div className="max-h-[68vh] overflow-y-auto rounded-xl border border-slate-200 bg-white p-4">
                <div className="rounded-lg border border-teal-200 bg-teal-50/70 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[11px] font-bold tracking-widest text-teal-800 uppercase">
                      Filters
                    </p>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={resetFilters}
                        className="inline-flex h-7 items-center justify-center rounded-md border border-slate-300 bg-white px-2.5 text-[10px] font-bold tracking-[0.08em] text-slate-600 uppercase transition hover:border-teal-300 hover:bg-teal-50 hover:text-teal-700"
                      >
                        Reset Filters
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowAdvanced(false)}
                        className="inline-flex h-7 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 text-[10px] font-bold tracking-[0.08em] text-slate-700 uppercase transition hover:border-slate-400 hover:bg-slate-50 hover:text-slate-900"
                        aria-label="Close filters panel"
                        title="Close filters panel"
                      >
                        <span>Close</span>
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                  <div className="mt-2 flex items-stretch gap-2 overflow-x-auto pb-1">
                    <div className="w-53 shrink-0">
                      <GuestStepper
                        controlLabel="minimum sleeps"
                        pillText={`Sleeps ${minSleeps}+`}
                        value={minSleeps}
                        min={0}
                        max={30}
                        onChange={setMinSleeps}
                      />
                    </div>
                    <div className="w-53 shrink-0">
                      <GuestStepper
                        controlLabel="minimum bedrooms"
                        pillText={`${minBedrooms}+ Bedrooms`}
                        value={minBedrooms}
                        min={0}
                        max={10}
                        onChange={setMinBedrooms}
                      />
                    </div>
                    <div className="w-53 shrink-0">
                      <GuestStepper
                        controlLabel="minimum bathrooms"
                        pillText={`${minBathrooms}+ Bathrooms`}
                        value={minBathrooms}
                        min={0}
                        max={10}
                        onChange={setMinBathrooms}
                      />
                    </div>
                    <div className="w-53 shrink-0">
                      <GuestStepper
                        controlLabel="minimum king beds"
                        pillText={`${minKingBeds}+ King Beds`}
                        value={minKingBeds}
                        min={0}
                        max={10}
                        onChange={setMinKingBeds}
                      />
                    </div>
                    <div className="w-53 shrink-0">
                      <GuestStepper
                        controlLabel="minimum queen beds"
                        pillText={`${minQueenBeds}+ Queen Beds`}
                        value={minQueenBeds}
                        min={0}
                        max={10}
                        onChange={setMinQueenBeds}
                      />
                    </div>
                    <div className="grid min-w-136 flex-1 grid-cols-6 gap-2">
                      <IconOptionBox
                        label="Gulf Front"
                        selected={filterBeachfront}
                        onToggle={() => setFilterBeachfront((v) => !v)}
                        icon={<Waves className="h-5 w-5" />}
                      />
                      <IconOptionBox
                        label="Private Pool"
                        selected={filterPool}
                        onToggle={() => setFilterPool((v) => !v)}
                        icon={<Droplets className="h-5 w-5" />}
                      />
                      <IconOptionBox
                        label="Golf Cart"
                        selected={filterGolfCart}
                        onToggle={() => setFilterGolfCart((v) => !v)}
                        icon={<CarFront className="h-5 w-5" />}
                      />
                      <IconOptionBox
                        label="Pets"
                        selected={filterPets}
                        onToggle={() => setFilterPets((v) => !v)}
                        icon={<Dog className="h-5 w-5" />}
                      />
                      <IconOptionBox
                        label="Elevator"
                        selected={filterElevator}
                        onToggle={() => setFilterElevator((v) => !v)}
                        icon={<ArrowUpDown className="h-5 w-5" />}
                      />
                      <IconOptionBox
                        label="Accessible"
                        selected={filterAccessible}
                        onToggle={() => setFilterAccessible((v) => !v)}
                        icon={<Accessibility className="h-5 w-5" />}
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </header>

        <div
          className={`grid gap-6 xl:min-h-0 xl:flex-1 ${
            isMapExpanded
              ? "xl:grid-cols-[240px_minmax(0,0.9fr)_minmax(0,2.1fr)] 2xl:grid-cols-[220px_minmax(0,0.85fr)_minmax(0,2.25fr)]"
              : "xl:grid-cols-[240px_minmax(0,1.45fr)_400px] 2xl:grid-cols-[220px_minmax(0,1.85fr)_340px]"
          }`}
        >
          <DiscoverFacetSidebar
            listingCount={displayListings.length}
            favoriteCount={favoriteListingIds.length}
            areaCounts={areaCounts}
            beachCounts={beachCounts}
            communityCounts={communityCounts}
            featureCounts={featureCounts}
          />

          <DiscoverListingsPanel
            listings={displayListings}
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

          {!isDetailOverlayOpen ? (
            <DiscoverMapPanel
              mapTarget={mapTarget}
              listings={mapListings}
              onClearPin={clearPinnedListing}
              onResetMapView={resetMapView}
              onSelectListing={handleSelectListingFromMap}
              onSyncSelectedListingCard={requestSelectedCardSync}
              isSyncSelectedListingCardAvailable={canSyncSelectedListingCard}
              isExpanded={isMapExpanded}
              onToggleExpanded={() => setIsMapExpanded((current) => !current)}
            />
          ) : (
            <aside className="hidden xl:block" aria-hidden="true" />
          )}
        </div>

        {effectiveOverlayListingId ? (
          <div className="absolute inset-0 z-40 overflow-hidden rounded-2xl border border-slate-200 bg-slate-100 shadow-[0_32px_80px_-42px_rgba(15,23,42,0.9)]">
            {overlayListing ? (
              <div className="grid h-full min-h-0 gap-x-4 gap-y-3 overflow-x-hidden p-3 md:gap-y-4 md:p-4 xl:grid-cols-[290px_minmax(0,1fr)_290px] xl:grid-rows-[auto_minmax(0,1fr)] 2xl:grid-cols-[340px_minmax(0,1fr)_340px]">
                <section className="relative col-span-full h-[clamp(15rem,34vh,20rem)] overflow-hidden rounded-2xl border border-slate-200 bg-slate-900 shadow-[0_24px_48px_-34px_rgba(15,23,42,0.85)] md:h-[clamp(17rem,40vh,24rem)] xl:h-[clamp(19rem,46vh,28rem)]">
                  <img
                    src={
                      overlayListing.imageGallery?.[0]?.url ??
                      overlayListing.previewImages[0]
                    }
                    alt={`${overlayListing.name} hero image`}
                    className="absolute inset-0 block h-full w-full object-cover"
                  />
                  <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-[44%] bg-gradient-to-b from-slate-950/70 via-slate-900/30 to-transparent" />
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-[30%] bg-gradient-to-t from-slate-950/80 via-slate-900/45 to-transparent" />

                  <div className="absolute top-4 right-4 z-30 flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => {
                        if (effectiveOverlayListingId) {
                          toggleFavoriteListing(effectiveOverlayListingId);
                        }
                      }}
                      className={`inline-flex h-12 w-12 items-center justify-center rounded-full shadow-[0_14px_28px_-18px_rgba(15,23,42,0.75)] backdrop-blur-md transition ${effectiveOverlayListingId && favoriteListingIds.includes(effectiveOverlayListingId) ? "bg-rose-900/65 text-rose-100 hover:bg-rose-100 hover:text-rose-700" : "bg-slate-950/35 text-white hover:bg-white/85 hover:text-slate-900"}`}
                      aria-label="Toggle favorite"
                      title="Toggle favorite"
                    >
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
                      onClick={closeDetailOverlay}
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
                        onResetMapView={() => {}}
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
                        Availability Calendar
                      </p>
                      <p className="mt-2 text-sm text-slate-700">
                        Month-by-month price and night availability.
                      </p>
                      <div className="mt-3 min-h-0 flex-1 overflow-y-auto pr-1">
                        {overlayAvailabilityByMonth.length > 0 ? (
                          <ul className="space-y-2">
                            {overlayAvailabilityByMonth.map((month) => (
                              <li
                                key={month.key}
                                className="rounded-lg border border-slate-200 bg-white px-3 py-2"
                              >
                                <p className="text-xs font-semibold text-slate-900">
                                  {month.label}
                                </p>
                                <p className="text-[11px] text-slate-600">
                                  {month.count} nights • $
                                  {month.min.toLocaleString("en-US")} - $
                                  {month.max.toLocaleString("en-US")}
                                </p>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">
                            Availability data is loading.
                          </div>
                        )}
                      </div>
                    </aside>

                    <section className="min-h-0 overflow-hidden rounded-2xl border border-white/75 bg-white/95 shadow-[0_18px_34px_-28px_rgba(15,23,42,0.7)] xl:flex xl:flex-col">
                      <article className="discover-cards-scroll min-h-0 overflow-y-auto px-8 pt-6 pb-5 md:px-11 md:pt-7 xl:h-full xl:flex-1 xl:px-12">
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
                              <div className="prose prose-slate prose-strong:font-semibold prose-em:italic max-w-none text-slate-800">
                                <ReactMarkdown
                                  remarkPlugins={[remarkGfm]}
                                  components={{
                                    p: ({ children }) => (
                                      <p className="mb-4 max-w-[70ch] font-sans text-[1.1rem] leading-8 font-normal text-slate-600 last:mb-0">
                                        {children}
                                      </p>
                                    ),
                                    li: ({ children }) => (
                                      <li className="font-sans text-[1rem] leading-7 text-slate-700">
                                        {children}
                                      </li>
                                    ),
                                  }}
                                >
                                  {overlayListing.descriptionMarkdown ??
                                    overlayListing.description ??
                                    `A bright, coastal-forward stay in ${overlayListing.area} with room for ${overlayListing.sleeps} guests.`}
                                </ReactMarkdown>
                              </div>

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
                                          overlayListing.beachfront
                                            ? "Gulf Front"
                                            : null,
                                          overlayListing.privatePool
                                            ? "Private Pool"
                                            : null,
                                          overlayListing.golfCart
                                            ? "Golf Cart"
                                            : null,
                                          overlayListing.elevator
                                            ? "Elevator"
                                            : null,
                                          overlayListing.accessible
                                            ? "Accessible"
                                            : null,
                                          overlayListing.petsAllowed
                                            ? "Pets Allowed"
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
                    </section>

                    <aside className="min-h-0 min-w-0 overflow-hidden">
                      <DiscoverMapPanel
                        mapTarget={overlayMapTarget}
                        listings={overlayMapListings}
                        onClearPin={() => {}}
                        onResetMapView={() => {}}
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
                  </>
                )}
              </div>
            ) : isOverlayDetailLoading ? (
              <div className="grid h-full min-h-0 gap-x-4 gap-y-3 overflow-x-hidden p-3 md:gap-y-4 md:p-4 xl:grid-cols-[290px_minmax(0,1fr)_290px] xl:grid-rows-[auto_minmax(0,1fr)] 2xl:grid-cols-[340px_minmax(0,1fr)_340px]">
                <div className="col-span-full h-[clamp(15rem,34vh,20rem)] animate-pulse rounded-2xl border border-slate-200 bg-slate-300/55 md:h-[clamp(17rem,40vh,24rem)] xl:h-[clamp(19rem,46vh,28rem)]" />
                <div className="hidden animate-pulse rounded-2xl border border-white/75 bg-white/85 xl:block" />
                <div className="min-h-0 animate-pulse rounded-2xl border border-white/75 bg-white/85" />
                <div className="animate-pulse rounded-2xl border border-white/75 bg-white/85" />
              </div>
            ) : (
              <div className="flex h-full items-center justify-center p-6 text-center text-sm text-slate-700">
                Property details are not available for this listing yet.
              </div>
            )}
          </div>
        ) : null}
      </section>
    </HomeMarketingShell>
  );
}
