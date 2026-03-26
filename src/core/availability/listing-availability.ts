export type AvailabilitySource = "pm_360blue" | "pm_stayon30a" | "pm_other";

export type BookingDayState = "bookable" | "blocked" | "unknown";

export type ListingAvailabilityRuleType =
  | "min_nights"
  | "closed_to_arrival"
  | "closed_to_departure"
  | "blackout"
  | "custom";

export type ListingAvailabilityRule = {
  rule_type: ListingAvailabilityRuleType;
  start_date: string;
  end_date: string;
  value: string | number | boolean;
  source_raw_text?: string;
};

export type ListingAvailabilityDay = {
  date: string;
  is_available: boolean;
  can_check_in: boolean;
  can_check_out: boolean;
  booking_day_state: BookingDayState;
  min_nights_required: number | null;
  nightly_price_cents: number | null;
  source_status_code: string;
  source_status_label: string;
};

export type ListingAvailabilitySummary = {
  total_days: number;
  bookable_days: number;
  blocked_days: number;
  unknown_days: number;
};

export type ListingAvailabilitySnapshot = {
  version: "v1";
  source: AvailabilitySource;
  external_listing_id: string;
  captured_at: string;
  window_start: string;
  window_end: string;
  days: ListingAvailabilityDay[];
  rules: ListingAvailabilityRule[];
  summary: ListingAvailabilitySummary;
};

export type ListingAvailabilityMapper<TInput> = (
  input: TInput,
) => ListingAvailabilitySnapshot;

export type CalendarDayCell = {
  date: string;
  in_window: boolean;
  data: ListingAvailabilityDay | null;
};

export type CalendarMonthView = {
  year: number;
  month: number;
  first_day_utc: string;
  last_day_utc: string;
  cells: CalendarDayCell[];
};

export function computeListingAvailabilitySummary(
  days: ListingAvailabilityDay[],
): ListingAvailabilitySummary {
  const bookable_days = days.filter(
    (day) => day.booking_day_state === "bookable",
  ).length;
  const blocked_days = days.filter(
    (day) => day.booking_day_state === "blocked",
  ).length;
  const unknown_days = days.length - bookable_days - blocked_days;

  return {
    total_days: days.length,
    bookable_days,
    blocked_days,
    unknown_days,
  };
}

export function indexDaysByDate(
  snapshot: ListingAvailabilitySnapshot,
): Record<string, ListingAvailabilityDay> {
  const index: Record<string, ListingAvailabilityDay> = {};

  for (const day of snapshot.days) {
    index[day.date] = day;
  }

  return index;
}

export function buildCalendarMonthView(
  snapshot: ListingAvailabilitySnapshot,
  year: number,
  month: number,
): CalendarMonthView {
  const dayIndex = indexDaysByDate(snapshot);
  const first = new Date(Date.UTC(year, month, 1));
  const last = new Date(Date.UTC(year, month + 1, 0));

  const cells: CalendarDayCell[] = [];
  for (let dayNumber = 1; dayNumber <= last.getUTCDate(); dayNumber += 1) {
    const iso = new Date(Date.UTC(year, month, dayNumber))
      .toISOString()
      .slice(0, 10);
    const data = dayIndex[iso] ?? null;

    cells.push({
      date: iso,
      in_window: iso >= snapshot.window_start && iso <= snapshot.window_end,
      data,
    });
  }

  return {
    year,
    month,
    first_day_utc: first.toISOString().slice(0, 10),
    last_day_utc: last.toISOString().slice(0, 10),
    cells,
  };
}
