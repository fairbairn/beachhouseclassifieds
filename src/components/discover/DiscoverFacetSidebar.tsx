import { Heart } from "lucide-react";
import { useState } from "react";

import { FacetSection } from "@/components/discover/discover-controls";

export function DiscoverFacetSidebar({
  listingCount,
  favoriteCount,
  areaCounts,
  beachCounts,
  communityCounts,
  featureCounts,
}: {
  listingCount: number;
  favoriteCount: number;
  areaCounts: ReadonlyArray<readonly [string, number]>;
  beachCounts: ReadonlyArray<readonly [string, number]>;
  communityCounts: ReadonlyArray<readonly [string, number]>;
  featureCounts: ReadonlyArray<{ label: string; count: number }>;
}) {
  const [isAreasOpen, setIsAreasOpen] = useState(false);
  const [isBeachesOpen, setIsBeachesOpen] = useState(true);
  const [isCommunitiesOpen, setIsCommunitiesOpen] = useState(false);
  const [isFeaturesOpen, setIsFeaturesOpen] = useState(true);

  return (
    <aside className="self-start rounded-2xl border border-slate-200 bg-white/95 p-4 shadow-[0_14px_30px_-26px_rgba(15,23,42,0.75)] xl:sticky xl:top-28">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-bold tracking-wide text-slate-700 uppercase">
          Properties
        </p>
        <span className="text-xl font-bold text-slate-900">{listingCount}</span>
      </div>
      {favoriteCount > 0 ? (
        <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50/80 px-3 py-2">
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
              {favoriteCount}
            </span>
          </div>
        </div>
      ) : null}
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
              <span className="font-semibold text-slate-500">{count}</span>
            </li>
          ))}
        </ul>
      </FacetSection>
      <FacetSection
        title="Beaches"
        isOpen={isBeachesOpen}
        onToggle={() => setIsBeachesOpen((current) => !current)}
      >
        <ul className="mt-2 space-y-1.5">
          {beachCounts.map(([name, count]) => (
            <li
              key={name}
              className="flex items-center justify-between rounded-md bg-slate-50 px-2 py-1.5 text-xs text-slate-700"
            >
              <span>{name}</span>
              <span className="font-semibold text-slate-500">{count}</span>
            </li>
          ))}
        </ul>
      </FacetSection>
      <FacetSection
        title="Communities"
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
              <span className="font-semibold text-slate-500">{count}</span>
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
  );
}
