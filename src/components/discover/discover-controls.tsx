import { AVAILABILITY_WINDOW_DAYS_LIMIT } from "@/lib/discover/availability-window-index";
import type { DiscoverListing } from "@/lib/discover/discover-types";
import {
  addDays,
  addMonths,
  format,
  isAfter,
  isBefore,
  isValid,
  parseISO,
  startOfDay,
  startOfMonth,
} from "date-fns";
import {
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Minus,
  Plus,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { DayPicker, type DateRange } from "react-day-picker";

const MAX_AVAILABILITY_SPAN_DAYS = AVAILABILITY_WINDOW_DAYS_LIMIT;

const countFormatter = new Intl.NumberFormat("en-US");

function formatCount(value: number): string {
  return countFormatter.format(value);
}

export function GuestStepper({
  controlLabel,
  pillText,
  value,
  min,
  max,
  onChange,
}: {
  controlLabel: string;
  pillText: string;
  value: number;
  min: number;
  max?: number;
  onChange: (next: number) => void;
}) {
  return (
    <div className="flex h-16 items-center justify-between rounded-lg border border-slate-300 bg-white px-3">
      <div className="flex w-full items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => onChange(Math.max(min, value - 1))}
          className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-slate-300 text-slate-700"
          aria-label={`Decrease ${controlLabel}`}
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <span className="inline-flex h-8 shrink-0 items-center justify-center rounded-full border border-teal-300 bg-teal-50 px-3 text-xs font-bold whitespace-nowrap text-teal-800 sm:text-sm">
          {pillText}
        </span>
        <button
          type="button"
          onClick={() =>
            onChange(max === undefined ? value + 1 : Math.min(max, value + 1))
          }
          className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-slate-300 text-slate-700"
          aria-label={`Increase ${controlLabel}`}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function parseIsoDate(value: string): Date | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = parseISO(value);
  if (!isValid(parsed)) {
    return undefined;
  }
  return parsed;
}

function toIsoDate(value: Date | undefined): string {
  if (!value) {
    return "";
  }
  return format(value, "yyyy-MM-dd");
}

type DayType = "available" | "checkin_only" | "checkout_only" | "unavailable";

type DateRangeFieldMode = "window" | "stay";

type AvailabilityCalendarStatus = DiscoverListing["availabilityCalendarStatus"];

function dayKey(day: Date): string {
  return format(startOfDay(day), "yyyy-MM-dd");
}

function resolveDayType(
  day: Date,
  availabilityCalendarStatus?: AvailabilityCalendarStatus,
): DayType | "unknown" {
  if (!availabilityCalendarStatus) {
    return "unknown";
  }

  const status = availabilityCalendarStatus[dayKey(day)];
  if (!status) {
    return "unknown";
  }

  if (
    status.dayType === "available" ||
    status.dayType === "checkin_only" ||
    status.dayType === "checkout_only" ||
    status.dayType === "unavailable"
  ) {
    return status.dayType;
  }

  return "unknown";
}

export function DateRangeField({
  startDate,
  endDate,
  onChange,
  openRequestToken,
  selectedNights,
  emptyLabel,
  mode,
  panelTitle,
  panelDescription,
  availabilityCalendarStatus,
  showAvailabilityLegend,
  maxSpanDays,
}: {
  startDate: string;
  endDate: string;
  onChange: (next: { startDate: string; endDate: string }) => void;
  openRequestToken?: number | null;
  selectedNights?: number;
  emptyLabel?: string;
  mode?: DateRangeFieldMode;
  panelTitle?: string;
  panelDescription?: string;
  availabilityCalendarStatus?: AvailabilityCalendarStatus;
  showAvailabilityLegend?: boolean;
  maxSpanDays?: number;
}) {
  const effectiveMode = mode ?? "window";
  const effectiveMaxSpanDays =
    typeof maxSpanDays === "number" && Number.isFinite(maxSpanDays)
      ? Math.max(1, Math.floor(maxSpanDays))
      : effectiveMode === "stay"
        ? 30
        : MAX_AVAILABILITY_SPAN_DAYS;
  const numberOfMonths = 3;
  const calendarStartMonth = useMemo(() => startOfMonth(new Date()), []);
  const calendarEndMonth = useMemo(
    () => startOfMonth(addMonths(new Date(), 24)),
    [],
  );
  const maxVisibleMonth = useMemo(
    () => startOfMonth(addMonths(calendarEndMonth, -(numberOfMonths - 1))),
    [calendarEndMonth, numberOfMonths],
  );

  const clampVisibleMonth = useCallback(
    (candidate: Date) => {
      const monthStart = startOfMonth(candidate);
      if (monthStart.getTime() < calendarStartMonth.getTime()) {
        return calendarStartMonth;
      }
      if (monthStart.getTime() > maxVisibleMonth.getTime()) {
        return maxVisibleMonth;
      }
      return monthStart;
    },
    [calendarStartMonth, maxVisibleMonth],
  );

  const [isOpen, setIsOpen] = useState(false);
  const [pickerResetToken, setPickerResetToken] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const lastClickedDateRef = useRef<Date | undefined>(undefined);
  const todayStart = useMemo(() => startOfDay(new Date()), []);

  const selectedRange = useMemo<DateRange>(() => {
    const rawFrom = parseIsoDate(startDate);
    const rawTo = parseIsoDate(endDate);
    if (!rawFrom && !rawTo) {
      return {
        from: undefined,
        to: undefined,
      };
    }

    const from = rawFrom
      ? isBefore(startOfDay(rawFrom), todayStart)
        ? todayStart
        : startOfDay(rawFrom)
      : undefined;

    const to = rawTo ? startOfDay(rawTo) : undefined;
    const safeTo =
      from && to && isBefore(to, from)
        ? undefined
        : to && isBefore(to, todayStart)
          ? todayStart
          : to;

    const maxAllowedTo = from ? addDays(from, effectiveMaxSpanDays) : undefined;

    const boundedTo =
      safeTo && maxAllowedTo && isAfter(safeTo, maxAllowedTo)
        ? maxAllowedTo
        : safeTo;

    return {
      from,
      to: boundedTo,
    };
  }, [startDate, endDate, todayStart, effectiveMaxSpanDays]);

  const selectedStartDate = useMemo(() => parseIsoDate(startDate), [startDate]);
  const hasAvailabilityCalendarData = useMemo(() => {
    if (!availabilityCalendarStatus) {
      return false;
    }

    return Object.keys(availabilityCalendarStatus).length > 0;
  }, [availabilityCalendarStatus]);
  const maxRangeBandEnd = useMemo(
    () =>
      selectedStartDate
        ? startOfDay(addDays(selectedStartDate, effectiveMaxSpanDays))
        : undefined,
    [selectedStartDate, effectiveMaxSpanDays],
  );

  const dayTypeFor = useCallback(
    (day: Date): DayType | "unknown" =>
      resolveDayType(day, availabilityCalendarStatus),
    [availabilityCalendarStatus],
  );

  const isCheckInSelectable = useCallback(
    (day: Date): boolean => {
      if (!hasAvailabilityCalendarData) {
        return true;
      }
      const dayType = dayTypeFor(day);
      return dayType === "available" || dayType === "checkin_only";
    },
    [dayTypeFor, hasAvailabilityCalendarData],
  );

  const isCheckOutSelectable = useCallback(
    (day: Date): boolean => {
      if (!hasAvailabilityCalendarData) {
        return true;
      }
      const dayType = dayTypeFor(day);
      return dayType === "available" || dayType === "checkout_only";
    },
    [dayTypeFor, hasAvailabilityCalendarData],
  );

  const isValidStaySpan = useCallback(
    (start: Date, end: Date): boolean => {
      if (!hasAvailabilityCalendarData) {
        return true;
      }

      const normalizedStart = startOfDay(start);
      const normalizedEnd = startOfDay(end);
      if (!isAfter(normalizedEnd, normalizedStart)) {
        return false;
      }

      if (!isCheckInSelectable(normalizedStart)) {
        return false;
      }

      if (!isCheckOutSelectable(normalizedEnd)) {
        return false;
      }

      // Every date between start and end must be A (available).
      let cursor = addDays(normalizedStart, 1);
      while (isBefore(cursor, normalizedEnd)) {
        if (dayTypeFor(cursor) !== "available") {
          return false;
        }
        cursor = addDays(cursor, 1);
      }

      return true;
    },
    [
      dayTypeFor,
      hasAvailabilityCalendarData,
      isCheckInSelectable,
      isCheckOutSelectable,
    ],
  );

  const isSpanDisabled = (day: Date) => {
    const normalizedDay = startOfDay(day);
    if (isBefore(normalizedDay, todayStart)) {
      return true;
    }

    if (effectiveMode === "stay" && hasAvailabilityCalendarData) {
      // In stay mode, validity is enforced in click handling so semantic
      // day styles remain visible across the calendar.
      return false;
    }

    if (!maxRangeBandEnd) {
      return false;
    }

    return isAfter(normalizedDay, maxRangeBandEnd);
  };

  const [visibleMonth, setVisibleMonth] = useState<Date>(() => {
    const selectedStart = parseIsoDate(startDate);
    return clampVisibleMonth(selectedStart ?? new Date());
  });

  const canGoPreviousMonth =
    visibleMonth.getTime() > calendarStartMonth.getTime();
  const canGoNextMonth = visibleMonth.getTime() < maxVisibleMonth.getTime();

  const navigateMonth = (delta: number) => {
    setVisibleMonth((current) => {
      const next = clampVisibleMonth(addMonths(current, delta));
      return next;
    });
  };

  useEffect(() => {
    const from = parseIsoDate(startDate);
    const to = parseIsoDate(endDate);
    const safeFrom = from
      ? isBefore(startOfDay(from), todayStart)
        ? todayStart
        : startOfDay(from)
      : undefined;
    lastClickedDateRef.current = to ?? safeFrom;
  }, [startDate, endDate, todayStart]);

  const toggleCalendarOpen = () => {
    setIsOpen((current) => {
      const next = !current;
      if (next) {
        const selectedStart = parseIsoDate(startDate);
        setVisibleMonth(clampVisibleMonth(selectedStart ?? new Date()));
      }
      return next;
    });
  };

  useEffect(() => {
    if (openRequestToken == null) {
      return;
    }

    const selectedStart = parseIsoDate(startDate);
    const requestedMonth = clampVisibleMonth(selectedStart ?? new Date());

    const frameId = requestAnimationFrame(() => {
      setIsOpen(true);
      setVisibleMonth(requestedMonth);
    });

    return () => {
      cancelAnimationFrame(frameId);
    };
  }, [openRequestToken, startDate, clampVisibleMonth]);

  const handleDayClick = (day: Date) => {
    const clicked = startOfDay(day);
    const safeClicked = isBefore(clicked, todayStart) ? todayStart : clicked;

    if (effectiveMode === "stay" && hasAvailabilityCalendarData) {
      const hasCompleteRange = Boolean(startDate && endDate);
      if (!selectedStartDate || hasCompleteRange) {
        if (!isCheckInSelectable(safeClicked)) {
          return;
        }

        lastClickedDateRef.current = safeClicked;
        onChange({
          startDate: toIsoDate(safeClicked),
          endDate: "",
        });
        return;
      }

      const selectedStart = startOfDay(selectedStartDate);
      if (!isAfter(safeClicked, selectedStart)) {
        if (!isCheckInSelectable(safeClicked)) {
          return;
        }

        lastClickedDateRef.current = safeClicked;
        onChange({
          startDate: toIsoDate(safeClicked),
          endDate: "",
        });
        return;
      }

      const latestAllowedCheckout = addDays(
        selectedStart,
        effectiveMaxSpanDays,
      );
      if (isAfter(safeClicked, latestAllowedCheckout)) {
        return;
      }

      if (!isCheckOutSelectable(safeClicked)) {
        return;
      }

      if (!isValidStaySpan(selectedStart, safeClicked)) {
        return;
      }

      lastClickedDateRef.current = safeClicked;
      onChange({
        startDate: toIsoDate(selectedStart),
        endDate: toIsoDate(safeClicked),
      });
      return;
    }

    const previous = lastClickedDateRef.current
      ? startOfDay(lastClickedDateRef.current)
      : undefined;
    const safePrevious = previous
      ? isBefore(previous, todayStart)
        ? todayStart
        : previous
      : undefined;

    if (!safePrevious || safePrevious.getTime() === safeClicked.getTime()) {
      lastClickedDateRef.current = safeClicked;
      onChange({
        startDate: toIsoDate(safeClicked),
        endDate: "",
      });
      return;
    }

    const [from, to] =
      safePrevious.getTime() < safeClicked.getTime()
        ? [safePrevious, safeClicked]
        : [safeClicked, safePrevious];
    const boundedTo = (() => {
      const latestAllowed = addDays(from, effectiveMaxSpanDays);
      return isAfter(to, latestAllowed) ? latestAllowed : to;
    })();

    lastClickedDateRef.current = safeClicked;
    onChange({
      startDate: toIsoDate(from),
      endDate: toIsoDate(boundedTo),
    });
  };

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!containerRef.current?.contains(target)) {
        setIsOpen(false);
      }
    };

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [isOpen]);

  const buttonLabel =
    startDate && endDate
      ? `${format(parseISO(startDate), "MMM d, yyyy")} to ${format(parseISO(endDate), "MMM d, yyyy")}`
      : startDate
        ? `${format(parseISO(startDate), "MMM d, yyyy")} to Latest?`
        : (emptyLabel ?? "Find availability within a date window.");

  const hasSelectedDates = Boolean(startDate || endDate);
  const hasCompleteSelectedRange = Boolean(startDate && endDate);
  const temporarySingleEndDateLabel =
    startDate && !endDate
      ? format(
          addDays(parseISO(startDate), effectiveMaxSpanDays),
          "MMM d, yyyy",
        )
      : "";

  const resolvedPanelTitle =
    panelTitle ??
    (effectiveMode === "stay" ? "PICK YOUR STAY DATES" : "Date Search Window");

  const resolvedPanelDescription =
    panelDescription ??
    (effectiveMode === "stay"
      ? `Select your check-in and check-out dates for a stay up to ${effectiveMaxSpanDays} days.`
      : `Pick your earliest and latest acceptable dates for us to find ${selectedNights ?? 0} nights.`);

  const showLegend =
    (showAvailabilityLegend ?? false) &&
    effectiveMode === "stay" &&
    hasAvailabilityCalendarData;

  const showStayAvailabilityStyles =
    effectiveMode === "stay" && hasAvailabilityCalendarData;
  const disabledDayClassName =
    "text-slate-300 [&>button]:!opacity-100 [&>button]:!text-slate-300 [&>button]:!border-transparent [&>button]:!bg-transparent";

  const dayModifiers = useMemo(() => {
    if (!showStayAvailabilityStyles) {
      return undefined;
    }

    const selectedFrom = selectedRange?.from
      ? startOfDay(selectedRange.from)
      : undefined;
    const selectedTo = selectedRange?.to
      ? startOfDay(selectedRange.to)
      : undefined;

    const isSelectedRangeDay = (day: Date): boolean => {
      if (!selectedFrom) {
        return false;
      }

      const normalized = startOfDay(day);
      if (!selectedTo) {
        return normalized.getTime() === selectedFrom.getTime();
      }

      return (
        !isBefore(normalized, selectedFrom) && !isAfter(normalized, selectedTo)
      );
    };

    return {
      day_available: (day: Date) =>
        !isBefore(startOfDay(day), todayStart) &&
        !isSelectedRangeDay(day) &&
        dayTypeFor(day) === "available",
      day_checkin_only: (day: Date) =>
        !isBefore(startOfDay(day), todayStart) &&
        !isSelectedRangeDay(day) &&
        dayTypeFor(day) === "checkin_only",
      day_checkout_only: (day: Date) =>
        !isBefore(startOfDay(day), todayStart) &&
        !isSelectedRangeDay(day) &&
        dayTypeFor(day) === "checkout_only",
      day_unavailable: (day: Date) =>
        !isBefore(startOfDay(day), todayStart) &&
        !isSelectedRangeDay(day) &&
        dayTypeFor(day) === "unavailable",
      day_unknown: (day: Date) =>
        !isBefore(startOfDay(day), todayStart) &&
        !isSelectedRangeDay(day) &&
        dayTypeFor(day) === "unknown",
    };
  }, [dayTypeFor, selectedRange, showStayAvailabilityStyles, todayStart]);

  const clearSelection = () => {
    lastClickedDateRef.current = undefined;
    setPickerResetToken((current) => current + 1);
    onChange({
      startDate: "",
      endDate: "",
    });
  };

  return (
    <div ref={containerRef} className="relative w-full min-w-0">
      <button
        type="button"
        onClick={toggleCalendarOpen}
        className="flex h-16 w-full min-w-0 items-center overflow-hidden rounded-lg border border-slate-300 bg-white pr-18 pl-3 text-left"
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        aria-label="Choose date range"
      >
        {hasSelectedDates ? (
          <span className="inline-flex h-8 max-w-full min-w-0 items-center overflow-hidden rounded-full border border-teal-300 bg-teal-50 px-3 text-xs font-bold whitespace-nowrap text-teal-800 sm:text-sm">
            {startDate && !endDate ? (
              <>
                <span className="truncate font-semibold">
                  {format(parseISO(startDate), "MMM d, yyyy")}
                </span>
                <span className="ml-1 truncate font-normal text-teal-700">
                  to {temporarySingleEndDateLabel}
                </span>
              </>
            ) : (
              <span className="truncate">{buttonLabel}</span>
            )}
          </span>
        ) : (
          <span className="truncate text-lg font-normal text-slate-400">
            {buttonLabel}
          </span>
        )}
      </button>

      <button
        type="button"
        onClick={clearSelection}
        disabled={!hasSelectedDates}
        className={`absolute top-1/2 right-9 z-10 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md border bg-white transition ${hasSelectedDates ? "border-slate-300 text-slate-500 hover:border-rose-300 hover:bg-rose-50 hover:text-rose-700" : "cursor-not-allowed border-slate-200 text-slate-300"}`}
        aria-label="Clear selected dates"
        title={hasSelectedDates ? "Clear selected dates" : "No dates selected"}
      >
        <X className="h-3.5 w-3.5" />
      </button>

      <CalendarDays className="pointer-events-none absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 text-emerald-500" />

      {isOpen ? (
        <div
          role="dialog"
          aria-label="Select stay date range"
          className="absolute top-[calc(100%+0.5rem)] right-0 z-50 w-fit max-w-[calc(100vw-2.5rem)] overflow-hidden rounded-2xl border border-slate-200 bg-white p-3 shadow-[0_24px_48px_-26px_rgba(15,23,42,0.55)]"
        >
          <div className="mb-3 flex items-center justify-between gap-2 rounded-xl border border-emerald-100 bg-emerald-50/70 px-3 py-2">
            <div>
              <p className="text-[11px] font-bold tracking-[0.14em] text-emerald-800 uppercase">
                {resolvedPanelTitle}
              </p>
              <p className="text-sm font-semibold text-slate-700">
                {resolvedPanelDescription}
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={clearSelection}
                className="inline-flex h-8 items-center justify-center rounded-md border border-slate-300 bg-white px-2 text-[11px] font-bold tracking-[0.04em] text-slate-600 uppercase transition hover:border-emerald-300 hover:text-emerald-700"
              >
                Clear Date Selection
              </button>
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className={`relative inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[11px] font-bold tracking-[0.04em] uppercase transition ${hasCompleteSelectedRange ? "border-emerald-400 bg-emerald-200 text-emerald-950 hover:border-emerald-500 hover:bg-emerald-300" : "border-slate-300 bg-white text-slate-700 hover:border-slate-400 hover:bg-slate-50 hover:text-slate-900"}`}
                aria-label={
                  hasSelectedDates
                    ? "Apply date selection and close picker"
                    : "Close date range picker"
                }
                title={
                  hasSelectedDates
                    ? "Apply date selection and close"
                    : "Close date range picker"
                }
              >
                {hasCompleteSelectedRange ? (
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute -inset-0.5 animate-ping rounded-md border border-emerald-400/80"
                  />
                ) : null}
                <span>{hasSelectedDates ? "Apply" : "Close"}</span>
                {hasSelectedDates ? (
                  <Check
                    className={`h-4 w-4 ${hasCompleteSelectedRange ? "text-emerald-900" : "text-slate-700"}`}
                  />
                ) : (
                  <X className="h-4 w-4" />
                )}
              </button>
            </div>
          </div>

          <div className="relative">
            <button
              type="button"
              onClick={() => navigateMonth(-1)}
              className={`absolute top-4 left-4 z-10 inline-flex h-8 w-8 items-center justify-center rounded-md border transition ${canGoPreviousMonth ? "border-slate-300 bg-white text-slate-700 hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-700" : "cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400"}`}
              aria-label="Show previous month"
              disabled={!canGoPreviousMonth}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => navigateMonth(1)}
              className={`absolute top-4 right-4 z-10 inline-flex h-8 w-8 items-center justify-center rounded-md border transition ${canGoNextMonth ? "border-slate-300 bg-white text-slate-700 hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-700" : "cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400"}`}
              aria-label="Show next month"
              disabled={!canGoNextMonth}
            >
              <ChevronRight className="h-4 w-4" />
            </button>

            <DayPicker
              key={pickerResetToken}
              mode="range"
              month={visibleMonth}
              selected={selectedRange}
              onSelect={() => {
                // Selection is controlled via onDayClick + external state.
              }}
              onDayClick={handleDayClick}
              disabled={isSpanDisabled}
              modifiers={dayModifiers}
              numberOfMonths={numberOfMonths}
              startMonth={calendarStartMonth}
              endMonth={calendarEndMonth}
              animate={false}
              showOutsideDays={false}
              fixedWeeks={true}
              className="discover-date-picker rounded-xl border border-slate-200 bg-slate-100 p-2"
              formatters={{
                formatWeekdayName: (date) => format(date, "EEEEE"),
              }}
              classNames={{
                months:
                  "grid w-fit grid-flow-col auto-cols-max justify-center gap-2 mx-auto",
                month:
                  "min-w-0 w-fit rounded-xl border border-slate-200 bg-white p-2",
                nav: "hidden",
                caption:
                  "mb-4 flex h-8 items-center justify-center text-center",
                month_caption:
                  "mb-4 flex h-8 items-center justify-center text-center",
                caption_label:
                  "block text-center text-lg font-semibold text-emerald-800 font-['Playfair_Display']",
                weekdays: "mb-1 grid grid-cols-7 gap-1",
                weekday:
                  "text-center text-[11px] font-bold tracking-[0.08em] text-emerald-800 uppercase",
                week: "grid grid-cols-7 gap-1",
                day: "h-9 w-9 p-0.5 mx-auto text-slate-500",
                day_button:
                  "discover-day-button h-8 w-8 rounded-full border border-transparent text-sm font-normal text-inherit transition hover:border-emerald-200 hover:bg-emerald-50 hover:text-emerald-800",
                today:
                  "discover-today text-amber-800 [&>button]:border [&>button]:border-amber-300 [&>button]:bg-amber-50/70 [&>button]:text-amber-900",
                selected:
                  "discover-range-selected [&>button]:border [&>button]:border-teal-600 [&>button]:bg-teal-600 [&>button]:text-white",
                range_start:
                  "discover-range-endpoint [&>button]:border [&>button]:border-teal-600 [&>button]:bg-teal-600 [&>button]:!text-white [&>button]:hover:!border-teal-700 [&>button]:hover:!bg-teal-700 [&>button]:hover:!text-white",
                range_end:
                  "discover-range-endpoint [&>button]:border [&>button]:border-teal-600 [&>button]:bg-teal-600 [&>button]:!text-white [&>button]:hover:!border-teal-700 [&>button]:hover:!bg-teal-700 [&>button]:hover:!text-white",
                range_middle:
                  "discover-range-middle !text-slate-900 [&>button]:mx-auto [&>button]:h-8 [&>button]:w-8 [&>button]:rounded-full [&>button]:!border-emerald-300 [&>button]:!bg-emerald-50 [&>button]:!font-normal",
                outside: "text-slate-400",
                disabled: disabledDayClassName,
              }}
              modifiersClassNames={
                showStayAvailabilityStyles
                  ? {
                      day_available:
                        "[&>button]:border-sky-200 [&>button]:bg-sky-50 [&>button]:text-sky-900 [&>button]:rounded-full",
                      day_checkin_only:
                        "[&>button]:opacity-100 [&>button]:border-sky-200 [&>button]:bg-linear-to-r [&>button]:from-white [&>button]:to-sky-50 [&>button]:font-semibold [&>button]:text-sky-900 [&>button]:rounded-full",
                      day_checkout_only:
                        "[&>button]:opacity-100 [&>button]:border-sky-200 [&>button]:bg-linear-to-r [&>button]:from-sky-50 [&>button]:to-white [&>button]:font-normal [&>button]:text-sky-900 [&>button]:rounded-full",
                      day_unavailable:
                        "[&>button]:border-transparent [&>button]:bg-transparent [&>button]:text-slate-300 [&>button]:font-normal",
                      day_unknown:
                        "[&>button]:border-transparent [&>button]:bg-transparent [&>button]:text-slate-300 [&>button]:font-normal",
                    }
                  : undefined
              }
            />
            {showLegend ? (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-600">
                <span className="inline-flex items-center gap-1 rounded-full border border-sky-200 bg-linear-to-r from-white to-sky-50 px-2 py-0.5 font-semibold text-sky-900">
                  Check-In Only
                </span>
                <span className="inline-flex items-center gap-1 rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 font-normal text-sky-900">
                  Available
                </span>
                <span className="inline-flex items-center gap-1 rounded-full border border-sky-200 bg-linear-to-r from-sky-50 to-white px-2 py-0.5 font-normal text-sky-900">
                  Check-Out Only
                </span>
                <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-transparent px-2 py-0.5 font-normal text-slate-300">
                  Unavailable
                </span>
                <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-transparent px-2 py-0.5 font-normal text-slate-400">
                  Blocked
                </span>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function IconOptionBox({
  label,
  selected,
  onToggle,
  icon,
}: {
  label: string;
  selected: boolean;
  onToggle: () => void;
  icon: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`relative flex h-16 w-full min-w-0 flex-col items-center justify-center rounded-xl border transition ${selected ? "border-teal-300 bg-teal-100 text-teal-800" : "border-slate-300 bg-white text-slate-600 hover:border-teal-300 hover:text-teal-700"}`}
      aria-pressed={selected}
    >
      {selected ? (
        <span className="absolute top-1.5 right-1.5 inline-flex h-4.5 w-4.5 items-center justify-center rounded-full bg-teal-600 text-white">
          <Check className="h-3 w-3" />
        </span>
      ) : null}
      <span className="mb-1 text-teal-600">{icon}</span>
      <span className="text-[11px] font-bold tracking-wide uppercase">
        {label}
      </span>
    </button>
  );
}

export function FacetSection({
  title,
  isOpen,
  onToggle,
  selectedCount,
  hasSelected,
  onClearSelected,
  clearSelectedLabel,
  children,
}: {
  title: ReactNode;
  isOpen: boolean;
  onToggle: () => void;
  selectedCount?: number;
  hasSelected?: boolean;
  onClearSelected?: () => void;
  clearSelectedLabel?: string;
  children: ReactNode;
}) {
  const hasSelectedFacets =
    hasSelected ?? Boolean(selectedCount && selectedCount > 0);

  return (
    <div className="mt-3 border-t border-slate-100 pt-3">
      <div className="flex items-center gap-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <button
            type="button"
            onClick={onToggle}
            className="min-w-0 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-slate-100/70"
            aria-expanded={isOpen}
          >
            <p
              className={`truncate text-xs uppercase ${hasSelectedFacets ? "font-bold text-slate-700" : "font-semibold text-slate-500"}`}
            >
              {title}
            </p>
          </button>
          <span
            className={`inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-teal-50 px-1.5 text-xs leading-none font-semibold text-teal-700 tabular-nums ${hasSelectedFacets ? "opacity-100" : "pointer-events-none opacity-0"}`}
            aria-hidden={!hasSelectedFacets}
          >
            {formatCount(selectedCount ?? 0)}
          </span>
          <button
            type="button"
            onClick={onClearSelected}
            disabled={!hasSelectedFacets || !onClearSelected}
            className={`inline-flex h-3.5 w-3.5 items-center justify-center text-teal-700 ${hasSelectedFacets ? "opacity-100 hover:text-teal-800" : "pointer-events-none opacity-0"}`}
            aria-label={clearSelectedLabel ?? "Clear selected facets"}
            title={clearSelectedLabel ?? "Clear selected facets"}
          >
            <X className="h-3 w-3" />
          </button>
          <span className="min-w-0 flex-1" aria-hidden="true" />
        </div>
        <button
          type="button"
          onClick={onToggle}
          className="inline-flex h-4 w-4 items-center justify-center text-slate-500 transition hover:text-slate-700"
          aria-expanded={isOpen}
          aria-label="Toggle section"
        >
          <ChevronDown
            className={`h-4 w-4 shrink-0 transition-transform ${isOpen ? "rotate-0" : "-rotate-90"}`}
          />
        </button>
      </div>
      {isOpen ? children : null}
    </div>
  );
}
