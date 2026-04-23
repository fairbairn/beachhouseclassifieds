import { Heart } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import * as ReactCountUpModule from "react-countup";

import { FacetSection } from "@/components/discover/discover-controls";

const countFormatter = new Intl.NumberFormat("en-US");
const CountUpComponent =
  ("default" in ReactCountUpModule ? ReactCountUpModule.default : undefined) ??
  ("CountUp" in ReactCountUpModule
    ? (ReactCountUpModule.CountUp as unknown)
    : undefined);
const hasCountUpComponent = typeof CountUpComponent === "function";

function formatCount(value: number): string {
  return countFormatter.format(value);
}

export function DiscoverFacetSidebar({
  listingCount,
  favoriteCount,
  areaCounts,
  beachCounts,
  communityCounts,
  featureCounts,
  selectedAreas,
  selectedBeaches,
  selectedCommunities,
  selectedFeatures,
  onToggleArea,
  onToggleBeach,
  onToggleCommunity,
  onToggleFeature,
  onClearAreas,
  onClearBeaches,
  onClearCommunities,
  onClearFeatures,
  containerClassName,
  scrollSectionsOnly,
}: {
  listingCount: number;
  favoriteCount: number;
  areaCounts: ReadonlyArray<readonly [string, number]>;
  beachCounts: ReadonlyArray<readonly [string, number]>;
  communityCounts: ReadonlyArray<readonly [string, number]>;
  featureCounts: ReadonlyArray<{
    code: "gulf_front" | "private_pool" | "golf_cart";
    label: string;
    count: number;
  }>;
  selectedAreas: ReadonlyArray<string>;
  selectedBeaches: ReadonlyArray<string>;
  selectedCommunities: ReadonlyArray<string>;
  selectedFeatures: ReadonlyArray<string>;
  onToggleArea: (value: string) => void;
  onToggleBeach: (value: string) => void;
  onToggleCommunity: (value: string) => void;
  onToggleFeature: (value: string) => void;
  onClearAreas: () => void;
  onClearBeaches: () => void;
  onClearCommunities: () => void;
  onClearFeatures: () => void;
  containerClassName?: string;
  scrollSectionsOnly?: boolean;
}) {
  const [isAreasOpen, setIsAreasOpen] = useState(false);
  const [isBeachesOpen, setIsBeachesOpen] = useState(true);
  const [isCommunitiesOpen, setIsCommunitiesOpen] = useState(true);
  const [isFeaturesOpen, setIsFeaturesOpen] = useState(true);
  const [hasMounted, setHasMounted] = useState(false);

  useEffect(() => {
    setHasMounted(true);
  }, []);

  const sumSelectedTupleCounts = (
    selectedValues: ReadonlyArray<string>,
    counts: ReadonlyArray<readonly [string, number]>,
  ) =>
    selectedValues.reduce(
      (total, value) =>
        total + (counts.find(([name]) => name === value)?.[1] ?? 0),
      0,
    );

  const featureCountByCode = new Map<string, number>(
    featureCounts.map((feature) => [feature.code, feature.count] as const),
  );

  const sumSelectedFeatureCounts = (selectedValues: ReadonlyArray<string>) =>
    selectedValues.reduce(
      (total, value) => total + (featureCountByCode.get(value) ?? 0),
      0,
    );

  const selectedAreaTotal = sumSelectedTupleCounts(selectedAreas, areaCounts);
  const selectedBeachTotal = sumSelectedTupleCounts(
    selectedBeaches,
    beachCounts,
  );
  const selectedCommunityTotal = sumSelectedTupleCounts(
    selectedCommunities,
    communityCounts,
  );
  const selectedFeatureTotal = sumSelectedFeatureCounts(selectedFeatures);
  const safeListingCount = Number.isFinite(listingCount)
    ? Math.max(0, Math.round(listingCount))
    : 0;
  const previousListingCountRef = useRef(safeListingCount);

  useEffect(() => {
    previousListingCountRef.current = safeListingCount;
  }, [safeListingCount]);

  const formatFacetLabel = (label: string) =>
    label.replaceAll("WaterSound", "Watersound");

  const renderFacetRow = (
    label: string,
    count: number,
    isSelected: boolean,
    hasSelectionInSection: boolean,
    onToggle: () => void,
  ) => (
    <li key={label}>
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={isSelected}
        className={`flex h-7 w-full items-center justify-between rounded-lg border px-2 py-1 text-xs ${
          isSelected
            ? "border-teal-300 bg-teal-100 text-teal-900"
            : hasSelectionInSection
              ? "border-transparent bg-slate-50 text-slate-600 opacity-60 hover:bg-teal-50 hover:opacity-80"
              : "border-transparent bg-slate-50 text-slate-700 hover:bg-teal-50"
        }`}
      >
        <span
          className={`truncate text-left ${isSelected ? "font-semibold" : "font-medium text-slate-800"}`}
        >
          {formatFacetLabel(label)}
        </span>
        <span className="ml-2 inline-flex min-w-8 items-center justify-end">
          <span
            className={`text-xs ${
              isSelected
                ? "font-semibold text-teal-800"
                : hasSelectionInSection
                  ? "font-medium text-slate-500"
                  : "font-medium text-slate-600"
            }`}
          >
            {count}
          </span>
        </span>
      </button>
    </li>
  );

  const baseAsideClassName =
    "discover-cards-scroll self-start rounded-2xl border border-slate-200 bg-white/98 p-4 shadow-[0_14px_30px_-26px_rgba(15,23,42,0.75)] xl:sticky xl:top-28 xl:max-h-[calc(100dvh-8.5rem)] xl:overflow-y-auto xl:overscroll-y-contain";
  const resolvedAsideClassName = containerClassName
    ? `${baseAsideClassName} ${containerClassName}`
    : baseAsideClassName;

  return (
    <aside className={resolvedAsideClassName}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-bold tracking-wide text-slate-700 uppercase">
          Properties
        </p>
        <span className="text-xl font-bold text-slate-900 tabular-nums">
          {hasMounted && hasCountUpComponent ? (
            <CountUpComponent
              key={`${previousListingCountRef.current}-${safeListingCount}`}
              start={previousListingCountRef.current}
              end={safeListingCount}
              duration={0.85}
              formattingFn={formatCount}
            />
          ) : (
            formatCount(safeListingCount)
          )}
        </span>
      </div>
      {favoriteCount > 0 ? (
        <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50/80 px-3 py-2 transition-colors hover:border-rose-300 hover:bg-rose-100/80">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-2 text-sm font-bold text-rose-800">
              <span className="relative inline-flex h-5 w-5 items-center justify-center">
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute -inset-1.5 animate-ping rounded-full border border-rose-400/80"
                />
                <Heart className="relative h-4 w-4" />
              </span>
              Favorites
            </span>
            <span className="rounded-full border border-rose-200 bg-white px-3 py-1 text-sm font-bold text-rose-700">
              {formatCount(favoriteCount)}
            </span>
          </div>
        </div>
      ) : null}
      <div
        className={
          scrollSectionsOnly
            ? "discover-cards-scroll mt-3 min-h-0 flex-1 space-y-0 overflow-y-auto overscroll-y-contain pr-1"
            : ""
        }
      >
        <FacetSection
          title="Areas"
          isOpen={isAreasOpen}
          onToggle={() => setIsAreasOpen((current) => !current)}
          selectedCount={selectedAreaTotal}
          hasSelected={selectedAreas.length > 0}
          onClearSelected={onClearAreas}
          clearSelectedLabel="Clear selected Areas facets"
        >
          <ul className="mt-1.5 space-y-1">
            {areaCounts.map(([name, count]) =>
              renderFacetRow(
                name,
                count,
                selectedAreas.includes(name),
                selectedAreas.length > 0,
                () => onToggleArea(name),
              ),
            )}
          </ul>
        </FacetSection>
        <FacetSection
          title="Beaches"
          isOpen={isBeachesOpen}
          onToggle={() => setIsBeachesOpen((current) => !current)}
          selectedCount={selectedBeachTotal}
          hasSelected={selectedBeaches.length > 0}
          onClearSelected={onClearBeaches}
          clearSelectedLabel="Clear selected Beaches facets"
        >
          <ul className="mt-1.5 space-y-1">
            {beachCounts.map(([name, count]) =>
              renderFacetRow(
                name,
                count,
                selectedBeaches.includes(name),
                selectedBeaches.length > 0,
                () => onToggleBeach(name),
              ),
            )}
          </ul>
        </FacetSection>
        <FacetSection
          title="Communities"
          isOpen={isCommunitiesOpen}
          onToggle={() => setIsCommunitiesOpen((current) => !current)}
          selectedCount={selectedCommunityTotal}
          hasSelected={selectedCommunities.length > 0}
          onClearSelected={onClearCommunities}
          clearSelectedLabel="Clear selected Communities facets"
        >
          <ul className="mt-1.5 space-y-1">
            {communityCounts.map(([name, count]) =>
              renderFacetRow(
                name,
                count,
                selectedCommunities.includes(name),
                selectedCommunities.length > 0,
                () => onToggleCommunity(name),
              ),
            )}
          </ul>
        </FacetSection>
        <FacetSection
          title="Features"
          isOpen={isFeaturesOpen}
          onToggle={() => setIsFeaturesOpen((current) => !current)}
          selectedCount={selectedFeatureTotal}
          hasSelected={selectedFeatures.length > 0}
          onClearSelected={onClearFeatures}
          clearSelectedLabel="Clear selected Property Features facets"
        >
          <ul className="mt-1.5 space-y-1">
            {featureCounts.map((feature) =>
              renderFacetRow(
                feature.label,
                feature.count,
                selectedFeatures.includes(feature.code),
                selectedFeatures.length > 0,
                () => onToggleFeature(feature.code),
              ),
            )}
          </ul>
        </FacetSection>
      </div>
    </aside>
  );
}
