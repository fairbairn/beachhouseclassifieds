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
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DayPicker, type DateRange } from "react-day-picker";

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

export function DateRangeField({
  startDate,
  endDate,
  onChange,
  openRequestToken,
}: {
  startDate: string;
  endDate: string;
  onChange: (next: { startDate: string; endDate: string }) => void;
  openRequestToken?: number;
}) {
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

  const clampVisibleMonth = (candidate: Date) => {
    const monthStart = startOfMonth(candidate);
    if (monthStart.getTime() < calendarStartMonth.getTime()) {
      return calendarStartMonth;
    }
    if (monthStart.getTime() > maxVisibleMonth.getTime()) {
      return maxVisibleMonth;
    }
    return monthStart;
  };

  const [isOpen, setIsOpen] = useState(false);
  const [pickerResetToken, setPickerResetToken] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const lastClickedDateRef = useRef<Date | undefined>(undefined);

  const selectedRange = useMemo<DateRange | undefined>(() => {
    const from = parseIsoDate(startDate);
    const to = parseIsoDate(endDate);
    if (!from && !to) {
      return undefined;
    }
    return {
      from,
      to,
    };
  }, [startDate, endDate]);

  const selectedStartDate = useMemo(() => parseIsoDate(startDate), [startDate]);
  const maxRangeBandStart = useMemo(
    () =>
      selectedStartDate
        ? startOfDay(addMonths(selectedStartDate, -3))
        : undefined,
    [selectedStartDate],
  );
  const maxRangeBandEnd = useMemo(
    () =>
      selectedStartDate
        ? startOfDay(addMonths(selectedStartDate, 3))
        : undefined,
    [selectedStartDate],
  );

  const isSpanDisabled = (day: Date) => {
    if (!maxRangeBandStart || !maxRangeBandEnd) {
      return false;
    }

    const normalizedDay = startOfDay(day);
    return (
      isBefore(normalizedDay, maxRangeBandStart) ||
      isAfter(normalizedDay, maxRangeBandEnd)
    );
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

  const handleMonthChange = (month: Date) => {
    const clamped = clampVisibleMonth(month);
    setVisibleMonth(clamped);
  };

  useEffect(() => {
    const from = parseIsoDate(startDate);
    const to = parseIsoDate(endDate);
    lastClickedDateRef.current = to ?? from;
  }, [startDate, endDate]);

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
    if (openRequestToken === undefined) {
      return;
    }

    setIsOpen(true);
    const selectedStart = parseIsoDate(startDate);
    setVisibleMonth(clampVisibleMonth(selectedStart ?? new Date()));
  }, [openRequestToken]);

  const handleDayClick = (day: Date) => {
    const clicked = startOfDay(day);
    const previous = lastClickedDateRef.current
      ? startOfDay(lastClickedDateRef.current)
      : undefined;

    if (!previous || previous.getTime() === clicked.getTime()) {
      lastClickedDateRef.current = clicked;
      onChange({
        startDate: toIsoDate(clicked),
        endDate: "",
      });
      return;
    }

    const [from, to] =
      previous.getTime() < clicked.getTime()
        ? [previous, clicked]
        : [clicked, previous];

    lastClickedDateRef.current = clicked;
    onChange({
      startDate: toIsoDate(from),
      endDate: toIsoDate(to),
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
        : "Find availability within a date window.";

  const hasSelectedDates = Boolean(startDate || endDate);
  const temporarySingleEndDateLabel =
    startDate && !endDate
      ? format(addDays(parseISO(startDate), 30), "MMM d, yyyy")
      : "";

  const clearSelection = () => {
    lastClickedDateRef.current = undefined;
    setPickerResetToken((current) => current + 1);
    onChange({
      startDate: "",
      endDate: "",
    });
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={toggleCalendarOpen}
        className="flex h-16 w-full items-center rounded-lg border border-slate-300 bg-white pr-18 pl-3 text-left"
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        aria-label="Choose date range"
      >
        {hasSelectedDates ? (
          <span className="inline-flex h-8 max-w-full items-center rounded-full border border-teal-300 bg-teal-50 px-3 text-xs font-bold whitespace-nowrap text-teal-800 sm:text-sm">
            {startDate && !endDate ? (
              <>
                <span className="font-semibold">
                  {format(parseISO(startDate), "MMM d, yyyy")}
                </span>
                <span className="ml-1 font-normal text-teal-700">
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
                Date Window
              </p>
              <p className="text-sm font-semibold text-slate-700">
                Pick your earliest and latest acceptable dates.
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
                onClick={() => navigateMonth(-1)}
                className={`inline-flex h-8 w-8 items-center justify-center rounded-md border transition ${canGoPreviousMonth ? "border-slate-300 bg-white text-slate-700 hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-700" : "cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400"}`}
                aria-label="Show previous month"
                disabled={!canGoPreviousMonth}
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => navigateMonth(1)}
                className={`inline-flex h-8 w-8 items-center justify-center rounded-md border transition ${canGoNextMonth ? "border-slate-300 bg-white text-slate-700 hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-700" : "cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400"}`}
                aria-label="Show next month"
                disabled={!canGoNextMonth}
              >
                <ChevronRight className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className={`inline-flex h-8 items-center gap-1.5 rounded-md border bg-white px-2.5 text-[11px] font-bold tracking-[0.04em] uppercase transition ${hasSelectedDates ? "border-emerald-300 text-emerald-700 hover:border-emerald-400 hover:bg-emerald-50 hover:text-emerald-900" : "border-slate-300 text-slate-700 hover:border-slate-400 hover:bg-slate-50 hover:text-slate-900"}`}
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
                <span>{hasSelectedDates ? "Apply" : "Close"}</span>
                {hasSelectedDates ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <X className="h-4 w-4" />
                )}
              </button>
            </div>
          </div>

          <DayPicker
            key={pickerResetToken}
            mode="range"
            month={visibleMonth}
            onMonthChange={handleMonthChange}
            selected={selectedRange}
            onDayClick={handleDayClick}
            disabled={isSpanDisabled}
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
              caption: "mb-4 flex items-center justify-center text-center",
              month_caption:
                "mb-4 flex items-center justify-center text-center",
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
                "discover-range-selected [&>button]:border [&>button]:border-teal-600 [&>button]:bg-teal-600",
              range_start:
                "discover-range-endpoint [&>button]:border [&>button]:border-teal-600 [&>button]:bg-teal-600 [&>button]:!text-white [&>button]:hover:!border-teal-700 [&>button]:hover:!bg-teal-700 [&>button]:hover:!text-white",
              range_end:
                "discover-range-endpoint [&>button]:border [&>button]:border-teal-600 [&>button]:bg-teal-600 [&>button]:!text-white [&>button]:hover:!border-teal-700 [&>button]:hover:!bg-teal-700 [&>button]:hover:!text-white",
              range_middle:
                "discover-range-middle !text-slate-900 [&>button]:mx-auto [&>button]:h-8 [&>button]:w-8 [&>button]:rounded-full [&>button]:!border-emerald-300 [&>button]:!bg-emerald-50 [&>button]:!font-normal",
              outside: "text-slate-400",
              disabled: "text-slate-300",
            }}
          />
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
  children,
}: {
  title: string;
  isOpen: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="mt-4 border-t border-slate-100 pt-4">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between text-left"
        aria-expanded={isOpen}
      >
        <p className="text-xs font-bold text-slate-500 uppercase">{title}</p>
        <ChevronDown
          className={`h-4 w-4 text-slate-500 transition-transform ${isOpen ? "rotate-0" : "-rotate-90"}`}
        />
      </button>
      {isOpen ? children : null}
    </div>
  );
}
