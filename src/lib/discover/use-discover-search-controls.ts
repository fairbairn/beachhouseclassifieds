import { differenceInCalendarDays, format, isValid, parseISO } from "date-fns";
import { useCallback, useMemo, useState } from "react";

import { formatNights } from "@/components/discover/discover-utils";

const DEFAULT_MIN_SLEEPS = 0;
const DEFAULT_MIN_BEDROOMS = 0;
const DEFAULT_MIN_BATHROOMS = 0;
const DEFAULT_MIN_KING_BEDS = 0;
const DEFAULT_MIN_QUEEN_BEDS = 0;
const DEFAULT_MIN_BUNK_BEDS = 0;

function formatSummaryDate(value: string, fallback: string): string {
  if (!value) {
    return fallback;
  }
  const parsed = parseISO(value);
  if (!isValid(parsed)) {
    return fallback;
  }
  return format(parsed, "MMM d, yyyy");
}

function parseSummaryDate(value: string): Date | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = parseISO(value);
  return isValid(parsed) ? parsed : undefined;
}

export function useDiscoverSearchControls() {
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
  const [minSleeps, setMinSleeps] = useState(DEFAULT_MIN_SLEEPS);
  const [minBedrooms, setMinBedrooms] = useState(DEFAULT_MIN_BEDROOMS);
  const [minBathrooms, setMinBathrooms] = useState(DEFAULT_MIN_BATHROOMS);
  const [minKingBeds, setMinKingBeds] = useState(DEFAULT_MIN_KING_BEDS);
  const [minQueenBeds, setMinQueenBeds] = useState(DEFAULT_MIN_QUEEN_BEDS);
  const [minBunkBeds, setMinBunkBeds] = useState(DEFAULT_MIN_BUNK_BEDS);
  const [filterPool, setFilterPool] = useState(false);
  const [filterGulffront, setFilterGulffront] = useState(false);
  const [filterGolfCart, setFilterGolfCart] = useState(false);

  const guestCount = adults + children;

  const hasClientSideNarrowing =
    locationQuery.trim().length > 0 ||
    minSleeps > 0 ||
    minBedrooms > 0 ||
    minBathrooms > 0 ||
    minKingBeds > 0 ||
    minQueenBeds > 0 ||
    minBunkBeds > 0 ||
    filterPool ||
    filterGulffront ||
    filterGolfCart;

  const dateSummary = useMemo(() => {
    const earliestParsed = parseSummaryDate(earliestDate);
    const latestParsed = parseSummaryDate(latestDate);

    let summary = `Choose earliest and latest dates • ${formatNights(nights)}`;

    if (earliestParsed && latestParsed) {
      const spanDays = differenceInCalendarDays(latestParsed, earliestParsed);

      if (spanDays < nights) {
        const shortByDays = nights - spanDays;
        summary = `Window too short • Add ${shortByDays} more ${shortByDays === 1 ? "day" : "days"} for ${formatNights(nights)}`;
      } else if (spanDays === nights) {
        summary = `Exact Dates ${formatSummaryDate(earliestDate, "Earliest?")} - ${formatSummaryDate(latestDate, "Latest?")} • ${formatNights(nights)}`;
      } else {
        summary = `Flexible ${formatSummaryDate(earliestDate, "Earliest?")} - ${formatSummaryDate(latestDate, "Latest?")} • ${formatNights(nights)}`;
      }
    } else if (earliestParsed) {
      summary = `Start ${formatSummaryDate(earliestDate, "Earliest?")} • ${formatNights(nights)}`;
    } else if (latestParsed) {
      summary = `Set earliest date • ${formatNights(nights)}`;
    }

    return summary;
  }, [earliestDate, latestDate, nights]);

  const resetFilters = useCallback(() => {
    setMinSleeps(DEFAULT_MIN_SLEEPS);
    setMinBedrooms(DEFAULT_MIN_BEDROOMS);
    setMinBathrooms(DEFAULT_MIN_BATHROOMS);
    setMinKingBeds(DEFAULT_MIN_KING_BEDS);
    setMinQueenBeds(DEFAULT_MIN_QUEEN_BEDS);
    setMinBunkBeds(DEFAULT_MIN_BUNK_BEDS);
    setFilterPool(false);
    setFilterGulffront(false);
    setFilterGolfCart(false);
  }, []);

  const filtersSummary = useMemo(() => {
    const activeFilterParts = [
      minSleeps > 0 ? `Sleeps ${minSleeps}+` : null,
      minBedrooms > 0 ? `${minBedrooms}BR+` : null,
      minBathrooms > 0 ? `${minBathrooms}BA+` : null,
      minKingBeds > 0 ? `${minKingBeds}+ Kings` : null,
      minQueenBeds > 0 ? `${minQueenBeds}+ Queens` : null,
      minBunkBeds > 0 ? `${minBunkBeds}+ Bunks` : null,
      filterGulffront ? "Gulf Front" : null,
      filterPool ? "Private Pool" : null,
      filterGolfCart ? "Golf Cart" : null,
    ].filter((part): part is string => Boolean(part));

    return activeFilterParts.length > 0
      ? activeFilterParts.join(" • ")
      : "None";
  }, [
    filterGulffront,
    filterGolfCart,
    filterPool,
    minBunkBeds,
    minBathrooms,
    minBedrooms,
    minKingBeds,
    minQueenBeds,
    minSleeps,
  ]);

  return {
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
    filterPool,
    setFilterPool,
    filterGulffront,
    setFilterGulffront,
    filterGolfCart,
    setFilterGolfCart,
    guestCount,
    hasClientSideNarrowing,
    dateSummary,
    filtersSummary,
    resetFilters,
  };
}
