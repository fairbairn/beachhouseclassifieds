import { createFileRoute } from "@tanstack/react-router";
import {
  Accessibility,
  CalendarDays,
  Check,
  ChevronDown,
  Dog,
  Droplets,
  Heart,
  Minus,
  Plus,
  SlidersHorizontal,
  CarFront,
  Waves,
  ArrowUpDown,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import beachEntryTexture from "@/assets/images/beach-entry.png";
import beachHomesTexture from "@/assets/images/beach-homes.jpg";
import beachPathTexture from "@/assets/images/beach-path.jpg";
import { HomeMarketingShell } from "@/components/home/HomeMarketingShell";

const sampleListings = [
  {
    id: "casa-del-sol",
    name: "Casa del Sol",
    area: "Santa Rosa Beach",
    community: "WaterColor",
    bedrooms: 5,
    bathrooms: 4,
    sleeps: 12,
    kingBeds: 3,
    queenBeds: 2,
    privatePool: true,
    beachfront: false,
    golfCart: true,
    petsAllowed: true,
    accessible: false,
    elevator: true,
    previewImages: [beachHomesTexture, beachPathTexture, beachEntryTexture],
    typicalPrice: "$8.2k - $11.4k",
  },
  {
    id: "dune-horizon",
    name: "Dune Horizon",
    area: "Santa Rosa Beach",
    community: "Blue Mountain",
    bedrooms: 4,
    bathrooms: 3,
    sleeps: 10,
    kingBeds: 2,
    queenBeds: 1,
    privatePool: false,
    beachfront: true,
    golfCart: false,
    petsAllowed: false,
    accessible: true,
    elevator: false,
    previewImages: [beachPathTexture, beachHomesTexture, beachEntryTexture],
    typicalPrice: "$6.9k - $9.7k",
  },
  {
    id: "rose-court-retreat",
    name: "Rose Court Retreat",
    area: "Inlet Beach",
    community: "Rosemary Beach",
    bedrooms: 4,
    bathrooms: 3,
    sleeps: 11,
    kingBeds: 3,
    queenBeds: 1,
    privatePool: false,
    beachfront: false,
    golfCart: true,
    petsAllowed: true,
    accessible: false,
    elevator: false,
    previewImages: [beachEntryTexture, beachHomesTexture, beachPathTexture],
    typicalPrice: "$7.4k - $10.2k",
  },
  {
    id: "seaside-azure",
    name: "Seaside Azure",
    area: "Seaside",
    community: "Seaside",
    bedrooms: 4,
    bathrooms: 4,
    sleeps: 10,
    kingBeds: 2,
    queenBeds: 2,
    privatePool: false,
    beachfront: false,
    golfCart: true,
    petsAllowed: true,
    accessible: false,
    elevator: false,
    previewImages: [beachHomesTexture, beachEntryTexture, beachPathTexture],
    typicalPrice: "$7.8k - $11.1k",
  },
  {
    id: "watercolor-pines",
    name: "WaterColor Pines",
    area: "Santa Rosa Beach",
    community: "WaterColor",
    bedrooms: 5,
    bathrooms: 5,
    sleeps: 12,
    kingBeds: 3,
    queenBeds: 1,
    privatePool: true,
    beachfront: false,
    golfCart: true,
    petsAllowed: false,
    accessible: false,
    elevator: true,
    previewImages: [beachPathTexture, beachHomesTexture, beachEntryTexture],
    typicalPrice: "$10.5k - $14.2k",
  },
  {
    id: "prominence-dunes",
    name: "Prominence Dunes",
    area: "WaterSound",
    community: "Prominence",
    bedrooms: 3,
    bathrooms: 3,
    sleeps: 8,
    kingBeds: 1,
    queenBeds: 2,
    privatePool: false,
    beachfront: false,
    golfCart: true,
    petsAllowed: true,
    accessible: false,
    elevator: false,
    previewImages: [beachEntryTexture, beachPathTexture, beachHomesTexture],
    typicalPrice: "$5.8k - $8.6k",
  },
  {
    id: "watersound-surf",
    name: "WaterSound Surf",
    area: "WaterSound",
    community: "WaterSound Beach",
    bedrooms: 4,
    bathrooms: 4,
    sleeps: 10,
    kingBeds: 2,
    queenBeds: 1,
    privatePool: true,
    beachfront: true,
    golfCart: false,
    petsAllowed: false,
    accessible: true,
    elevator: true,
    previewImages: [beachHomesTexture, beachPathTexture, beachEntryTexture],
    typicalPrice: "$11.9k - $16.4k",
  },
  {
    id: "alys-courtyard",
    name: "Alys Courtyard",
    area: "Alys Beach",
    community: "Alys Beach",
    bedrooms: 4,
    bathrooms: 4,
    sleeps: 9,
    kingBeds: 2,
    queenBeds: 1,
    privatePool: true,
    beachfront: false,
    golfCart: false,
    petsAllowed: false,
    accessible: false,
    elevator: true,
    previewImages: [beachPathTexture, beachEntryTexture, beachHomesTexture],
    typicalPrice: "$12.1k - $17.8k",
  },
  {
    id: "seacrest-boardwalk",
    name: "Seacrest Boardwalk",
    area: "Seacrest Beach",
    community: "Seacrest Beach",
    bedrooms: 4,
    bathrooms: 3,
    sleeps: 10,
    kingBeds: 2,
    queenBeds: 2,
    privatePool: false,
    beachfront: false,
    golfCart: true,
    petsAllowed: true,
    accessible: false,
    elevator: false,
    previewImages: [beachHomesTexture, beachEntryTexture, beachPathTexture],
    typicalPrice: "$7.2k - $9.9k",
  },
  {
    id: "rosemary-terrace",
    name: "Rosemary Terrace",
    area: "Rosemary Beach",
    community: "Rosemary Beach",
    bedrooms: 5,
    bathrooms: 4,
    sleeps: 12,
    kingBeds: 3,
    queenBeds: 1,
    privatePool: true,
    beachfront: false,
    golfCart: false,
    petsAllowed: false,
    accessible: false,
    elevator: true,
    previewImages: [beachEntryTexture, beachHomesTexture, beachPathTexture],
    typicalPrice: "$9.4k - $13.3k",
  },
  {
    id: "grayton-bungalow",
    name: "Grayton Bungalow",
    area: "Grayton Beach",
    community: "Seaside",
    bedrooms: 3,
    bathrooms: 2,
    sleeps: 8,
    kingBeds: 1,
    queenBeds: 1,
    privatePool: false,
    beachfront: false,
    golfCart: false,
    petsAllowed: true,
    accessible: false,
    elevator: false,
    previewImages: [beachPathTexture, beachEntryTexture, beachHomesTexture],
    typicalPrice: "$4.8k - $6.7k",
  },
  {
    id: "blue-mountain-overlook",
    name: "Blue Mountain Overlook",
    area: "Blue Mountain Beach",
    community: "Prominence",
    bedrooms: 4,
    bathrooms: 3,
    sleeps: 9,
    kingBeds: 2,
    queenBeds: 1,
    privatePool: true,
    beachfront: false,
    golfCart: true,
    petsAllowed: true,
    accessible: true,
    elevator: false,
    previewImages: [beachHomesTexture, beachPathTexture, beachEntryTexture],
    typicalPrice: "$6.6k - $9.1k",
  },
  {
    id: "seagrove-sands",
    name: "Seagrove Sands",
    area: "Seagrove Beach",
    community: "Seaside",
    bedrooms: 4,
    bathrooms: 3,
    sleeps: 10,
    kingBeds: 2,
    queenBeds: 1,
    privatePool: false,
    beachfront: false,
    golfCart: true,
    petsAllowed: true,
    accessible: false,
    elevator: false,
    previewImages: [beachPathTexture, beachHomesTexture, beachEntryTexture],
    typicalPrice: "$7.1k - $9.8k",
  },
  {
    id: "inlet-lighthouse",
    name: "Inlet Lighthouse",
    area: "Inlet Beach",
    community: "Rosemary Beach",
    bedrooms: 5,
    bathrooms: 4,
    sleeps: 11,
    kingBeds: 3,
    queenBeds: 1,
    privatePool: true,
    beachfront: true,
    golfCart: false,
    petsAllowed: false,
    accessible: true,
    elevator: true,
    previewImages: [beachEntryTexture, beachHomesTexture, beachPathTexture],
    typicalPrice: "$10.9k - $15.3k",
  },
  {
    id: "watersound-west-bluff",
    name: "WaterSound West Bluff",
    area: "WaterSound",
    community: "WaterSound West Beach",
    bedrooms: 4,
    bathrooms: 3,
    sleeps: 9,
    kingBeds: 2,
    queenBeds: 1,
    privatePool: true,
    beachfront: false,
    golfCart: true,
    petsAllowed: true,
    accessible: false,
    elevator: false,
    previewImages: [beachHomesTexture, beachEntryTexture, beachPathTexture],
    typicalPrice: "$8.6k - $12.4k",
  },
];

const known30AAreas = ["West 30A", "Central 30A", "East 30A"];

const known30ACommunities = [
  "WaterColor",
  "Seaside",
  "Prominence",
  "WaterSound West Beach",
  "WaterSound Beach",
  "Seacrest Beach",
  "Alys Beach",
  "Rosemary Beach",
];

const homeHeroBackgroundImage = "https://30a.com/wp-content/uploads/2025/08/Alys-Beach-1.jpg";

function GuestStepper({
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

function DateField({
  placeholder,
  value,
  onChange,
}: {
  placeholder: string;
  value: string;
  onChange: (next: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  const openPicker = () => {
    const pickerInput = inputRef.current;
    if (!pickerInput) {
      return;
    }
    (
      pickerInput as HTMLInputElement & { showPicker?: () => void }
    ).showPicker?.();
    pickerInput.focus();
    pickerInput.click();
  };

  return (
    <div className="relative flex h-16 items-center rounded-lg border border-slate-300 bg-white px-3">
      <span
        className={`pointer-events-none text-sm font-semibold ${value ? "text-slate-800" : "text-slate-500"}`}
      >
        {value || placeholder}
      </span>
      <CalendarDays className="ml-auto h-4 w-4 text-slate-400" />
      <div className="absolute inset-0 overflow-hidden rounded-lg">
        <input
          ref={inputRef}
          type="date"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onClick={openPicker}
          className="h-full w-full cursor-pointer opacity-0"
          aria-label={placeholder}
        />
      </div>
    </div>
  );
}

function IconOptionBox({
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
      className={`relative flex h-16 w-28 shrink-0 flex-col items-center justify-center rounded-xl border transition ${selected ? "border-teal-300 bg-teal-100 text-teal-800" : "border-slate-300 bg-white text-slate-600 hover:border-teal-300 hover:text-teal-700"}`}
      aria-pressed={selected}
    >
      {selected ? (
        <span className="absolute top-1.5 right-1.5 inline-flex h-4.5 w-4.5 items-center justify-center rounded-full bg-teal-600 text-white">
          <Check className="h-3 w-3" />
        </span>
      ) : null}
      <span className="mb-1 text-teal-600">{icon}</span>
      <span className="text-[11px] font-bold tracking-wide uppercase">{label}</span>
    </button>
  );
}

function formatNights(nights: number) {
  return `${nights} ${nights === 1 ? "Night" : "Nights"}`;
}

function getAreaFromListing(listing: (typeof sampleListings)[number]) {
  const areaName = `${listing.area} ${listing.community}`.toLowerCase();

  const east30AKeywords = ["rosemary", "seacrest", "alys", "inlet"];
  const west30AKeywords = ["blue mountain", "grayton", "santa rosa"];
  const central30AKeywords = [
    "seagrove",
    "seaside",
    "watercolor",
    "watersound",
    "prominence",
  ];

  if (east30AKeywords.some((keyword) => areaName.includes(keyword))) {
    return "East 30A";
  }
  if (west30AKeywords.some((keyword) => areaName.includes(keyword))) {
    return "West 30A";
  }
  if (central30AKeywords.some((keyword) => areaName.includes(keyword))) {
    return "Central 30A";
  }

  return "Central 30A";
}

function FacetSection({
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

export const Route = createFileRoute("/discover")({
  component: DiscoverPage,
});

function DiscoverPage() {
  useEffect(() => {
    const previousHtmlOverflow = document.documentElement.style.overflow;
    const previousBodyOverflow = document.body.style.overflow;
    const previousHtmlOverscroll = document.documentElement.style.overscrollBehavior;
    const previousBodyOverscroll = document.body.style.overscrollBehavior;

    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
    document.documentElement.style.overscrollBehavior = "none";
    document.body.style.overscrollBehavior = "none";

    return () => {
      document.documentElement.style.overflow = previousHtmlOverflow;
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overscrollBehavior = previousHtmlOverscroll;
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
  const [minSleeps, setMinSleeps] = useState(8);
  const [minBedrooms, setMinBedrooms] = useState(3);
  const [minBathrooms, setMinBathrooms] = useState(2);
  const [minKingBeds, setMinKingBeds] = useState(1);
  const [minQueenBeds, setMinQueenBeds] = useState(0);
  const [filterPool, setFilterPool] = useState(false);
  const [filterBeachfront, setFilterBeachfront] = useState(false);
  const [filterGolfCart, setFilterGolfCart] = useState(false);
  const [filterPets, setFilterPets] = useState(false);
  const [filterAccessible, setFilterAccessible] = useState(false);
  const [filterElevator, setFilterElevator] = useState(false);
  const [favoriteIds, setFavoriteIds] = useState<string[]>([]);
  const [isAreasOpen, setIsAreasOpen] = useState(true);
  const [isCommunitiesOpen, setIsCommunitiesOpen] = useState(true);
  const [isFeaturesOpen, setIsFeaturesOpen] = useState(true);

  const guestCount = adults + children;

  const filtered = useMemo(() => {
    const normalized = locationQuery.trim().toLowerCase();

    return sampleListings
      .filter((listing) => {
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
      })
      .sort((a, b) => a.name.localeCompare(b.name));
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
  ]);

  const displayListings = useMemo(
    () => [...sampleListings].sort((a, b) => a.name.localeCompare(b.name)),
    [],
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
      { label: "Private Pool", count: privatePoolCount },
      { label: "Beach Front", count: beachfrontCount },
      { label: "Golf Cart", count: golfCartCount },
    ];
  }, [filtered]);

  const dateSummary = `${earliestDate || "Earliest?"} to ${latestDate || "Latest?"} • ${formatNights(nights)}`;

  return (
    <HomeMarketingShell
      preferDarkTopNavText={false}
      showFooter={false}
      disableNavScrollEffect={true}
      contentClassName="relative overflow-hidden px-4 pb-12 pt-28 md:px-10 md:pt-32 2xl:px-16"
    >
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage: `url(${homeHeroBackgroundImage})`,
          backgroundSize: "cover",
          backgroundPosition: "center",
        }}
      />
      <div className="pointer-events-none absolute inset-0 bg-slate-950/28" />

      <section className="relative z-10 mx-auto w-full max-w-475 space-y-6 xl:flex xl:h-[calc(100dvh-7rem)] xl:flex-col xl:gap-6 xl:space-y-0">
        <header className="rounded-2xl border border-slate-200 bg-white/95 p-5 shadow-[0_14px_30px_-26px_rgba(15,23,42,0.75)]">
          <div>
            <div className="grid gap-1.5 xl:grid-cols-[minmax(0,3.85fr)_minmax(9.5rem,1fr)_minmax(9.5rem,1fr)_minmax(8.5rem,0.84fr)_minmax(8.5rem,0.84fr)_minmax(8.5rem,0.84fr)] xl:items-end">
              <div className="relative">
                <input
                  type="text"
                  value={locationQuery}
                  onChange={(event) => setLocationQuery(event.target.value)}
                  placeholder="Search by area, community, or property"
                  className="h-16 w-full rounded-lg border border-slate-300 bg-white px-4 pr-30 text-base text-slate-800 placeholder:text-slate-400"
                />
                <button
                  type="button"
                  className="absolute top-1/2 right-2 h-12 -translate-y-1/2 rounded-md border border-teal-500 bg-teal-500 px-4 text-sm font-bold whitespace-nowrap text-white"
                >
                  Search
                </button>
              </div>
              <DateField
                placeholder="Earliest Date"
                value={earliestDate}
                onChange={setEarliestDate}
              />
              <DateField
                placeholder="Latest Date"
                value={latestDate}
                onChange={setLatestDate}
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

            <div className="mt-3 flex flex-wrap items-center gap-2">
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
              <span className="rounded-full border border-teal-200 bg-teal-50 px-3 py-1 text-sm font-semibold text-teal-800">
                Filters: {minSleeps}+ sleeps • {minBedrooms}+ bd • {minBathrooms}+ ba • {minKingBeds}+ king • {minQueenBeds}+ queen
                {filterPool ? " • pool" : ""}
                {filterBeachfront ? " • beachfront" : ""}
                {filterGolfCart ? " • LSV" : ""}
                {filterPets ? " • pets" : ""}
                {filterAccessible ? " • accessible" : ""}
                {filterElevator ? " • elevator" : ""}
              </span>
              <span className="rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1 text-sm font-semibold text-indigo-800">
                Dates: {dateSummary}
              </span>
            </div>

            <div
              className={`overflow-hidden transition-all duration-300 ${showAdvanced ? "mt-3 max-h-[72vh] opacity-100" : "max-h-0 opacity-0"}`}
            >
              <div className="max-h-[68vh] overflow-y-auto rounded-xl border border-slate-200 bg-white p-4">
                <div className="rounded-lg border border-teal-200 bg-teal-50/70 p-3">
                  <p className="text-[11px] font-bold tracking-widest text-teal-800 uppercase">
                    Filters
                  </p>
                  <div className="mt-2 flex items-stretch gap-2 overflow-x-auto pb-1">
                    <div className="w-53 shrink-0">
                      <GuestStepper
                        controlLabel="minimum sleeps"
                        pillText={`${minSleeps}+ Sleeps`}
                        value={minSleeps}
                        min={1}
                        max={20}
                        onChange={setMinSleeps}
                      />
                    </div>
                    <div className="w-53 shrink-0">
                      <GuestStepper
                        controlLabel="minimum bedrooms"
                        pillText={`${minBedrooms}+ Bedrooms`}
                        value={minBedrooms}
                        min={1}
                        max={10}
                        onChange={setMinBedrooms}
                      />
                    </div>
                    <div className="w-53 shrink-0">
                      <GuestStepper
                        controlLabel="minimum bathrooms"
                        pillText={`${minBathrooms}+ Bathrooms`}
                        value={minBathrooms}
                        min={1}
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
                    <IconOptionBox
                      label="Pool"
                      selected={filterPool}
                      onToggle={() => setFilterPool((v) => !v)}
                      icon={<Droplets className="h-5 w-5" />}
                    />
                    <IconOptionBox
                      label="Beach Front"
                      selected={filterBeachfront}
                      onToggle={() => setFilterBeachfront((v) => !v)}
                      icon={<Waves className="h-5 w-5" />}
                    />
                    <IconOptionBox
                      label="LSV"
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
                      label="Accessible"
                      selected={filterAccessible}
                      onToggle={() => setFilterAccessible((v) => !v)}
                      icon={<Accessibility className="h-5 w-5" />}
                    />
                    <IconOptionBox
                      label="Elevator"
                      selected={filterElevator}
                      onToggle={() => setFilterElevator((v) => !v)}
                      icon={<ArrowUpDown className="h-5 w-5" />}
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </header>

        <div className="grid gap-5 xl:min-h-0 xl:flex-1 xl:grid-cols-[240px_minmax(0,1.45fr)_400px] 2xl:grid-cols-[220px_minmax(0,1.85fr)_340px]">
          <aside className="self-start rounded-2xl border border-slate-200 bg-white/95 p-4 shadow-[0_14px_30px_-26px_rgba(15,23,42,0.75)] xl:sticky xl:top-28">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-bold tracking-wide text-slate-700 uppercase">
                Properties
              </p>
              <span className="text-xl font-bold text-slate-900">
                {displayListings.length}
              </span>
            </div>
            <FacetSection
              title="Areas"
              isOpen={isAreasOpen}
              onToggle={() => setIsAreasOpen((current) => !current)}
            >
              <ul className="mt-2 space-y-1.5">
                {areaCounts.map(([name, count]) => (
                  <li
                    key={name}
                    className="flex items-center justify-between rounded-md bg-slate-50 px-2 py-1.5 text-xs text-slate-700"
                  >
                    <span>{name}</span>
                    <span className="font-semibold text-slate-500">
                      {count}
                    </span>
                  </li>
                ))}
              </ul>
            </FacetSection>
            <FacetSection
              title="Planned Communities"
              isOpen={isCommunitiesOpen}
              onToggle={() => setIsCommunitiesOpen((current) => !current)}
            >
              <ul className="mt-2 space-y-1.5">
                {communityCounts.map(([name, count]) => (
                  <li
                    key={name}
                    className="flex items-center justify-between rounded-md bg-slate-50 px-2 py-1.5 text-xs text-slate-700"
                  >
                    <span>{name}</span>
                    <span className="font-semibold text-slate-500">
                      {count}
                    </span>
                  </li>
                ))}
              </ul>
            </FacetSection>
            <FacetSection
              title="Property Features"
              isOpen={isFeaturesOpen}
              onToggle={() => setIsFeaturesOpen((current) => !current)}
            >
              <ul className="mt-2 space-y-1.5">
                {featureCounts.map((feature) => (
                  <li
                    key={feature.label}
                    className="flex items-center justify-between rounded-md bg-slate-50 px-2 py-1.5 text-xs text-slate-700"
                  >
                    <span>{feature.label}</span>
                    <span className="font-semibold text-slate-500">
                      {feature.count}
                    </span>
                  </li>
                ))}
              </ul>
            </FacetSection>
          </aside>

          <div className="min-h-0 self-start xl:h-full">
            <div className="h-full overflow-y-auto pr-2 pb-6">
              {displayListings.length === 0 ? (
                <div className="rounded-2xl border border-white/35 bg-white/90 p-8 text-center shadow-[0_14px_30px_-26px_rgba(15,23,42,0.75)] backdrop-blur-sm">
                  <p className="text-lg font-semibold text-slate-900">No matches with current filters</p>
                  <p className="mt-2 text-sm text-slate-600">Try lowering one or two filter thresholds, or toggle off a few icon filters to broaden results.</p>
                </div>
              ) : (
                <div className="grid gap-4 xl:grid-cols-2 2xl:grid-cols-3">
                  {displayListings.map((listing) => {
                    const isFavorite = favoriteIds.includes(listing.id);
                    return (
                      <article
                        key={listing.id}
                        className="rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_12px_30px_-24px_rgba(15,23,42,0.65)]"
                      >
                      <div className="mb-4 grid grid-cols-2 gap-2">
                        {listing.previewImages.slice(0, 2).map((img, i) => (
                          <img
                            key={`${listing.id}-${i}`}
                            src={img}
                            alt={`${listing.name} preview ${i + 1}`}
                            className="aspect-square rounded-lg object-cover"
                          />
                        ))}
                      </div>
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <h2 className="text-xl font-semibold text-slate-900">
                            {listing.name}
                          </h2>
                          <p className="text-sm text-slate-500">
                            {listing.area} • {listing.community}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            setFavoriteIds((current) =>
                              current.includes(listing.id)
                                ? current.filter((id) => id !== listing.id)
                                : [...current, listing.id],
                            )
                          }
                          className={`inline-flex items-center justify-center rounded-full border p-2.5 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-sm ${isFavorite ? "border-teal-300 bg-teal-50 text-teal-600 hover:bg-teal-100" : "border-slate-300 text-slate-500 hover:border-teal-300 hover:text-teal-600"}`}
                        >
                          <Heart
                            className="h-4.5 w-4.5"
                            fill={isFavorite ? "currentColor" : "none"}
                          />
                        </button>
                      </div>
                      <div className="mt-4 grid grid-cols-2 gap-2 text-sm text-slate-700">
                        <p>{listing.bedrooms} bedrooms</p>
                        <p>{listing.bathrooms} bathrooms</p>
                        <p>{listing.kingBeds} king beds</p>
                        <p>{listing.queenBeds} queen beds</p>
                        <p>
                          {listing.privatePool
                            ? "Private pool"
                            : "No private pool"}
                        </p>
                        <p>
                          {listing.golfCart
                            ? "Golf cart included"
                            : "No golf cart"}
                        </p>
                      </div>
                      <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-4 text-sm">
                        <span className="text-slate-500">Typical pricing</span>
                        <strong className="text-slate-900">
                          {listing.typicalPrice}
                        </strong>
                      </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <aside className="flex flex-col self-start rounded-2xl border border-slate-200 bg-white/95 p-5 shadow-[0_14px_30px_-26px_rgba(15,23,42,0.75)] xl:sticky xl:top-28">
            <p className="text-[11px] font-bold tracking-[0.16em] text-slate-400 uppercase">
              Map View
            </p>
            <div className="relative mt-3 h-88 overflow-hidden rounded-xl border border-slate-200 bg-slate-100 sm:h-104 xl:h-[calc(100dvh-8.5rem)] xl:min-h-136 xl:max-h-232">
              <iframe
                title="30A map"
                src="https://maps.google.com/maps?q=Seaside%20FL%20Post%20Office&t=&z=14&ie=UTF8&iwloc=&output=embed"
                className="absolute inset-0 h-full w-full"
                loading="lazy"
                referrerPolicy="no-referrer-when-downgrade"
              />
            </div>
          </aside>
        </div>
      </section>
    </HomeMarketingShell>
  );
}
