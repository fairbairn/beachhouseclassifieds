import { differenceInCalendarDays, format, isValid, parseISO } from "date-fns";
import {
  Accessibility,
  ArrowUpDown,
  CarFront,
  ChevronDown,
  Dog,
  Droplets,
  SlidersHorizontal,
  Waves,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

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
  formatNights,
  getAreaFromListing,
  getBeachZoneFromListing,
  getListingGeoTarget,
  getTypicalPriceBounds,
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

export function DiscoverPage() {
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
  }, []);

  const [locationQuery, setLocationQuery] = useState("");
  const [earliestDate, setEarliestDate] = useState("");
  const [latestDate, setLatestDate] = useState("");
  const [nights, setNights] = useState(7);
  const [adults, setAdults] = useState(2);
  const [children, setChildren] = useState(0);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [datePanelOpenRequestToken, setDatePanelOpenRequestToken] = useState<
    number | undefined
  >(undefined);
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
  const [fetchedListings, setFetchedListings] = useState<DiscoverListing[]>([]);
  const [favoriteListingIds, setFavoriteListingIds] = useState<string[]>([]);

  useEffect(() => {
    const chooseVariant = () => {
      setExpandedSingleCardVariant(window.innerWidth >= 1820 ? 4 : 3);
    };

    chooseVariant();
    window.addEventListener("resize", chooseVariant);

    return () => {
      window.removeEventListener("resize", chooseVariant);
    };
  }, []);

  const clearPinnedListing = useCallback(() => {
    setActiveListingId(undefined);
    setMapTarget(() => ({
      ...defaultMapTarget,
      id: undefined,
      zoom: 13,
    }));
  }, []);

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
    let isCancelled = false;

    const loadListings = async () => {
      try {
        const response = await fetch("/api/discover/listings");
        if (!response.ok || isCancelled) {
          return;
        }

        const payload = (await response.json()) as { listings?: unknown };
        if (!Array.isArray(payload.listings)) {
          return;
        }

        setFetchedListings(payload.listings as DiscoverListing[]);
      } catch {
        // Keep local sample data fallback when fetch fails.
      }
    };

    void loadListings();

    return () => {
      isCancelled = true;
    };
  }, []);

  const sourceListings =
    fetchedListings.length > 0 ? fetchedListings : sampleListings;

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

  const baseDisplayListings = useMemo(() => {
    const orderedListings = [...sourceListings];
    const targetMockCount = 96;

    return Array.from({ length: targetMockCount }, (_, index) => {
      const baseListing = orderedListings[index % orderedListings.length];
      const cycle = Math.floor(index / orderedListings.length) + 1;

      if (cycle === 1) {
        return baseListing;
      }

      return {
        ...baseListing,
        id: `${baseListing.id}-sample-${cycle}`,
        name: `${baseListing.name} ${cycle}`,
      };
    });
  }, [sourceListings]);

  const displayListings = useMemo(() => {
    const listings = [...baseDisplayListings];

    if (sortOption === "recommended") {
      return listings;
    }

    if (sortOption === "price-low") {
      return listings.sort((a, b) => {
        const aPrice = getTypicalPriceBounds(a.typicalPrice).low;
        const bPrice = getTypicalPriceBounds(b.typicalPrice).low;
        return aPrice - bPrice;
      });
    }

    if (sortOption === "price-high") {
      return listings.sort((a, b) => {
        const aPrice = getTypicalPriceBounds(a.typicalPrice).high;
        const bPrice = getTypicalPriceBounds(b.typicalPrice).high;
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
  }, [baseDisplayListings, sortOption]);

  const mapListings = useMemo(
    () =>
      displayListings.map((listing) => {
        const geoTarget = getListingGeoTarget(listing);
        return {
          id: listing.id,
          name: listing.name,
          lat: geoTarget.lat,
          lng: geoTarget.lng,
        };
      }),
    [displayListings],
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
              style={{ fontFamily: "'Playfair Display', serif" }}
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

          <div
            aria-hidden="true"
            className="pointer-events-none absolute top-full right-0 left-0 z-30 hidden h-9 bg-linear-to-b from-slate-950/24 via-slate-900/10 to-transparent blur-md xl:block"
          />
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
            cardsPerRow={isMapExpanded ? 1 : cardsPerRow}
            singleColumnCardVariant={expandedSingleCardVariant}
            activeListingId={activeListingId}
            favoriteIds={favoriteListingIds}
            onToggleFavorite={toggleFavoriteListing}
            onFocusMap={handleFocusMap}
          />

          <DiscoverMapPanel
            mapTarget={mapTarget}
            listings={mapListings}
            onClearPin={clearPinnedListing}
            onSelectListing={handleSelectListingFromMap}
            isExpanded={isMapExpanded}
            onToggleExpanded={() => setIsMapExpanded((current) => !current)}
          />
        </div>
      </section>
    </HomeMarketingShell>
  );
}
