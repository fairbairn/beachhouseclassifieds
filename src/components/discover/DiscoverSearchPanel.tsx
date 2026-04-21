import {
  CarFront,
  ChevronDown,
  Droplets,
  SlidersHorizontal,
  Waves,
  X,
} from "lucide-react";

import {
  DateRangeField,
  GuestStepper,
  IconOptionBox,
} from "@/components/discover/discover-controls";
import { formatNights } from "@/components/discover/discover-utils";
import {
  DiscoverSortLayoutControls,
  type SortOption,
} from "@/components/discover/DiscoverSortLayoutControls";

export function DiscoverSearchPanel({
  locationQuery,
  onLocationQueryChange,
  onClearLocationQuery,
  earliestDate,
  latestDate,
  nights,
  datePanelOpenRequestToken,
  onDateRangeChange,
  onNightsChange,
  adults,
  onAdultsChange,
  children,
  onChildrenChange,
  showAdvanced,
  onToggleAdvanced,
  filtersSummary,
  onOpenFilters,
  dateSummary,
  onOpenDateRangePanel,
  guestCount,
  sortOption,
  onSortChange,
  cardsPerRow,
  onCardsPerRowChange,
  isCardLayoutLocked,
  resetFilters,
  onCloseAdvanced,
  minSleeps,
  onMinSleepsChange,
  minBedrooms,
  onMinBedroomsChange,
  minBathrooms,
  onMinBathroomsChange,
  filterGulffront,
  onToggleGulffront,
  filterPool,
  onTogglePool,
  filterGolfCart,
  onToggleGolfCart,
}: {
  locationQuery: string;
  onLocationQueryChange: (value: string) => void;
  onClearLocationQuery: () => void;
  earliestDate: string;
  latestDate: string;
  nights: number;
  datePanelOpenRequestToken?: number;
  onDateRangeChange: (next: { startDate: string; endDate: string }) => void;
  onNightsChange: (value: number) => void;
  adults: number;
  onAdultsChange: (value: number) => void;
  children: number;
  onChildrenChange: (value: number) => void;
  showAdvanced: boolean;
  onToggleAdvanced: () => void;
  filtersSummary: string;
  onOpenFilters: () => void;
  dateSummary: string;
  onOpenDateRangePanel: () => void;
  guestCount: number;
  sortOption: SortOption;
  onSortChange: (next: SortOption) => void;
  cardsPerRow: 2 | 3 | 4;
  onCardsPerRowChange: (next: 2 | 3 | 4) => void;
  isCardLayoutLocked: boolean;
  resetFilters: () => void;
  onCloseAdvanced: () => void;
  minSleeps: number;
  onMinSleepsChange: (value: number) => void;
  minBedrooms: number;
  onMinBedroomsChange: (value: number) => void;
  minBathrooms: number;
  onMinBathroomsChange: (value: number) => void;
  filterGulffront: boolean;
  onToggleGulffront: () => void;
  filterPool: boolean;
  onTogglePool: () => void;
  filterGolfCart: boolean;
  onToggleGolfCart: () => void;
}) {
  return (
    <header className="relative z-20 rounded-2xl border border-slate-200 bg-white/95 p-5 shadow-[0_14px_30px_-26px_rgba(15,23,42,0.75)]">
      <div>
        <div className="grid gap-1.5 xl:grid-cols-[minmax(0,3.85fr)_minmax(19rem,2fr)_minmax(8.5rem,0.84fr)_minmax(8.5rem,0.84fr)_minmax(8.5rem,0.84fr)] xl:items-end">
          <div className="relative">
            <input
              type="text"
              value={locationQuery}
              onChange={(event) => onLocationQueryChange(event.target.value)}
              maxLength={120}
              placeholder="Where would you love to stay? Try an area, community, or property name."
              className="h-16 w-full rounded-lg border border-slate-300 bg-white px-4 pr-44 text-lg text-teal-800 placeholder:text-slate-400 focus:outline-none focus-visible:border-teal-300 focus-visible:ring-2 focus-visible:ring-teal-200/70"
            />
            {locationQuery ? (
              <button
                type="button"
                onClick={onClearLocationQuery}
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
            onChange={onDateRangeChange}
          />
          <GuestStepper
            controlLabel="minimum stay"
            pillText={formatNights(nights)}
            value={nights}
            min={1}
            max={21}
            onChange={onNightsChange}
          />
          <GuestStepper
            controlLabel="adults"
            pillText={`${adults} ${adults === 1 ? "Adult" : "Adults"}`}
            value={adults}
            min={1}
            onChange={onAdultsChange}
          />
          <GuestStepper
            controlLabel="children"
            pillText={`${children} ${children === 1 ? "Child" : "Children"}`}
            value={children}
            min={0}
            onChange={onChildrenChange}
          />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 xl:flex-nowrap">
          <button
            type="button"
            onClick={onToggleAdvanced}
            className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-teal-600 bg-linear-to-r from-teal-600 to-cyan-600 px-3 text-xs font-semibold text-white shadow-[0_8px_20px_-12px_rgba(13,148,136,0.75)] transition hover:brightness-105"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            Advanced Filters
            <ChevronDown
              className={`h-3.5 w-3.5 transition-transform ${showAdvanced ? "rotate-180" : ""}`}
            />
          </button>
          <div className="inline-flex items-center gap-1.5">
            <span className="text-xs font-normal text-slate-600">Filters:</span>
            <button
              type="button"
              onClick={onOpenFilters}
              className="rounded-full border border-teal-200 bg-teal-50 px-3 py-1 text-xs font-semibold text-teal-800 transition hover:border-teal-300 hover:bg-teal-100/60"
              aria-label="Open filters panel"
            >
              {filtersSummary}
            </button>
          </div>
          <div className="inline-flex items-center gap-1.5">
            <span className="text-xs font-normal text-slate-600">Dates:</span>
            <button
              type="button"
              onClick={onOpenDateRangePanel}
              className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-800 transition hover:border-emerald-300 hover:bg-emerald-100/60"
              aria-label="Open date range panel"
            >
              {dateSummary}
            </button>
          </div>
          <div className="inline-flex items-center gap-1.5">
            <span className="text-xs font-normal text-slate-600">Guests:</span>
            <span className="rounded-full border border-cyan-200 bg-cyan-50 px-3 py-1 text-xs font-semibold text-cyan-800">
              {guestCount}
            </span>
          </div>
          <DiscoverSortLayoutControls
            sortOption={sortOption}
            onSortChange={onSortChange}
            cardsPerRow={cardsPerRow}
            onCardsPerRowChange={onCardsPerRowChange}
            isCardLayoutLocked={isCardLayoutLocked}
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
                    onClick={onCloseAdvanced}
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
                    onChange={onMinSleepsChange}
                  />
                </div>
                <div className="w-53 shrink-0">
                  <GuestStepper
                    controlLabel="minimum bedrooms"
                    pillText={`${minBedrooms}+ Bedrooms`}
                    value={minBedrooms}
                    min={0}
                    max={10}
                    onChange={onMinBedroomsChange}
                  />
                </div>
                <div className="w-53 shrink-0">
                  <GuestStepper
                    controlLabel="minimum bathrooms"
                    pillText={`${minBathrooms}+ Bathrooms`}
                    value={minBathrooms}
                    min={0}
                    max={10}
                    onChange={onMinBathroomsChange}
                  />
                </div>
                <div className="grid min-w-136 flex-1 grid-cols-3 gap-2">
                  <IconOptionBox
                    label="Gulf Front"
                    selected={filterGulffront}
                    onToggle={onToggleGulffront}
                    icon={<Waves className="h-5 w-5" />}
                  />
                  <IconOptionBox
                    label="Private Pool"
                    selected={filterPool}
                    onToggle={onTogglePool}
                    icon={<Droplets className="h-5 w-5" />}
                  />
                  <IconOptionBox
                    label="Golf Cart"
                    selected={filterGolfCart}
                    onToggle={onToggleGolfCart}
                    icon={<CarFront className="h-5 w-5" />}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
