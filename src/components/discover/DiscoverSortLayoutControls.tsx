import {
  ArrowUpDown,
  CalendarDays,
  Check,
  ChevronDown,
  Heart,
  LayoutGrid,
  SlidersHorizontal,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

export type SortOption =
  | "recommended"
  | "price-low"
  | "price-high"
  | "sleeps-high"
  | "beach-pool-first";

const sortOptions: Array<{ value: SortOption; label: string }> = [
  { value: "recommended", label: "Recommended" },
  { value: "price-low", label: "Price: Low to High" },
  { value: "price-high", label: "Price: High to Low" },
  { value: "sleeps-high", label: "Sleeps: High to Low" },
  { value: "beach-pool-first", label: "Beachfront + Pool First" },
];

export function DiscoverSortLayoutControls({
  sortOption,
  onSortChange,
  cardsPerRow,
  onCardsPerRowChange,
}: {
  sortOption: SortOption;
  onSortChange: (value: SortOption) => void;
  cardsPerRow: 2 | 3 | 4;
  onCardsPerRowChange: (value: 2 | 3 | 4) => void;
}) {
  const [isSortMenuOpen, setIsSortMenuOpen] = useState(false);
  const [isHelpMenuOpen, setIsHelpMenuOpen] = useState(false);
  const sortMenuRef = useRef<HTMLDivElement | null>(null);
  const helpMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!sortMenuRef.current?.contains(target)) {
        setIsSortMenuOpen(false);
      }
      if (!helpMenuRef.current?.contains(target)) {
        setIsHelpMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
    };
  }, []);

  const openHelpMenu = () => {
    setIsHelpMenuOpen((current) => !current);
  };

  const shouldPulseHelp = true;

  return (
    <div className="ml-auto flex items-center gap-2">
      <div ref={sortMenuRef} className="relative">
        <button
          type="button"
          onClick={() => setIsSortMenuOpen((current) => !current)}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white pr-1 pl-2 text-xs font-semibold text-slate-700 shadow-[0_6px_18px_-16px_rgba(15,23,42,0.9)] transition hover:border-teal-200 hover:bg-teal-50/40 focus:border-teal-300 focus:ring-2 focus:ring-teal-100 focus:outline-none"
          aria-label="Sort listings"
          aria-haspopup="listbox"
          aria-expanded={isSortMenuOpen}
        >
          <ArrowUpDown className="h-3.5 w-3.5 text-cyan-600" />
          <span>
            {sortOptions.find((option) => option.value === sortOption)?.label}
          </span>
          <ChevronDown
            className={`h-3.5 w-3.5 text-slate-500 transition-transform ${isSortMenuOpen ? "rotate-180" : ""}`}
          />
        </button>
        {isSortMenuOpen ? (
          <div
            role="listbox"
            aria-label="Sort listings"
            className="absolute top-11 right-0 z-40 min-w-52 overflow-hidden rounded-lg border border-slate-200 bg-white p-1 shadow-[0_20px_40px_-20px_rgba(15,23,42,0.65)]"
          >
            {sortOptions.map((option) => {
              const isSelected = sortOption === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => {
                    onSortChange(option.value);
                    setIsSortMenuOpen(false);
                  }}
                  className={`flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-xs font-semibold transition ${isSelected ? "bg-cyan-600 text-white" : "text-slate-700 hover:bg-slate-100"}`}
                >
                  <span>{option.label}</span>
                  {isSelected ? <Check className="h-3.5 w-3.5" /> : null}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
      <div className="inline-flex h-9 items-center gap-1 rounded-lg border border-slate-200 bg-white px-1">
        <span className="inline-flex h-7 w-7 items-center justify-center rounded-md text-indigo-600">
          <LayoutGrid className="h-3.5 w-3.5" />
        </span>
        {[2, 3, 4].map((count) => {
          const isSelected = cardsPerRow === count;
          return (
            <button
              key={count}
              type="button"
              onClick={() => onCardsPerRowChange(count as 2 | 3 | 4)}
              className={`inline-flex h-7 items-center justify-center rounded-md px-2.5 text-xs font-semibold whitespace-nowrap transition ${isSelected ? "border border-indigo-300 bg-indigo-50 text-indigo-700" : "text-slate-600 hover:bg-slate-100"}`}
              aria-pressed={isSelected}
              aria-label={`${count} cards per row`}
              title={`${count} cards per row`}
            >
              {count} cards
            </button>
          );
        })}
      </div>
      <div ref={helpMenuRef} className="relative">
        {shouldPulseHelp ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -inset-1 z-0 animate-ping rounded-xl border border-[#2dd4bf]/80"
          />
        ) : null}
        <button
          type="button"
          onClick={openHelpMenu}
          className={`relative z-10 inline-flex h-9 w-9 items-center justify-center rounded-lg border shadow-[0_8px_20px_-16px_rgba(13,148,136,0.45)] transition focus:ring-2 focus:ring-teal-100 focus:outline-none ${isHelpMenuOpen ? "border-teal-400 bg-teal-200 text-teal-900" : "border-teal-300 bg-teal-100 text-teal-800 hover:border-teal-400 hover:bg-teal-200 hover:text-teal-900"}`}
          aria-label="Search help"
          title="Search help"
          aria-expanded={isHelpMenuOpen}
          aria-haspopup="dialog"
        >
          <span className="text-xl leading-none font-semibold">?</span>
        </button>
        {isHelpMenuOpen ? (
          <div
            role="dialog"
            aria-label="How to search better"
            className="absolute top-11 right-0 z-40 w-104 overflow-hidden rounded-xl border border-teal-100 bg-white/96 p-4 shadow-[0_22px_44px_-24px_rgba(15,23,42,0.45)] backdrop-blur-sm"
          >
            <div className="flex items-center gap-2">
              <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-teal-200 bg-teal-50 text-teal-700">
                <span className="text-base leading-none font-semibold">?</span>
              </span>
              <p
                className="text-2xl font-semibold tracking-tight text-teal-800"
                style={{ fontFamily: "'Playfair Display', serif" }}
              >
                Search Tips
              </p>
            </div>
            <p className="mt-2 text-base leading-7 text-slate-600">
              Small adjustments can unlock better matches quickly.
            </p>
            <ul className="mt-3 space-y-2.5 text-base leading-7 text-slate-700">
              <li className="flex items-start gap-2.5">
                <span className="mt-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-emerald-200 bg-emerald-50 text-emerald-700">
                  <CalendarDays className="h-3.5 w-3.5" />
                </span>
                <span>
                  Use a wider earliest-to-latest date window to reveal more
                  consecutive-night availability.
                </span>
              </li>
              <li className="flex items-start gap-2.5">
                <span className="mt-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-teal-200 bg-teal-50 text-teal-700">
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                </span>
                <span>Refine filters to tighten your match quality.</span>
              </li>
              <li className="flex items-start gap-2.5">
                <span className="mt-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-cyan-200 bg-cyan-50 text-cyan-700">
                  <ArrowUpDown className="h-3.5 w-3.5" />
                </span>
                <span>
                  Sort by price or features first, then tighten filters as you
                  learn what stands out.
                </span>
              </li>
              <li className="flex items-start gap-2.5">
                <span className="mt-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-indigo-200 bg-indigo-50 text-indigo-700">
                  <LayoutGrid className="h-3.5 w-3.5" />
                </span>
                <span>Switch card density to scan faster.</span>
              </li>
              <li className="flex items-start gap-2.5">
                <span className="mt-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-rose-200 bg-rose-50 text-rose-700">
                  <Heart className="h-3.5 w-3.5" />
                </span>
                <span>Favorite top contenders as you go.</span>
              </li>
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}
