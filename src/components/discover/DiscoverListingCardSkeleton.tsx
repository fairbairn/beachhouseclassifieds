import { cn } from "@/core/ui/cn";

import { PLACEHOLDER_CARD_BASE_STYLES } from "@/components/discover/discover-listing-card-styles";

export function DiscoverListingCardSkeleton({
  isFourUpCardLayout,
  isTwoUpCardLayout,
  threeUpCardMinHeightClass,
}: {
  isFourUpCardLayout: boolean;
  isTwoUpCardLayout: boolean;
  threeUpCardMinHeightClass: string;
}) {
  return (
    <div
      aria-hidden="true"
      className={cn(PLACEHOLDER_CARD_BASE_STYLES, threeUpCardMinHeightClass)}
    >
      {isTwoUpCardLayout ? (
        <div className="relative mb-3 grid grid-cols-2 gap-2">
          <div className="dsp aspect-square rounded-lg bg-slate-200/70" />
          <div className="grid aspect-square grid-cols-2 grid-rows-2 gap-2">
            <div className="dsp rounded-lg bg-slate-200/65" />
            <div className="dsp rounded-lg bg-slate-200/65" />
            <div className="dsp rounded-lg bg-slate-200/60" />
            <div className="dsp rounded-lg bg-slate-200/60" />
          </div>
        </div>
      ) : (
        <div
          className={`relative mb-3 ${isFourUpCardLayout ? "grid grid-cols-1" : "grid grid-cols-2 gap-2"}`}
        >
          {isFourUpCardLayout ? (
            <div className="dsp aspect-video w-full rounded-lg bg-slate-200/70" />
          ) : (
            <>
              <div className="dsp aspect-square rounded-lg bg-slate-200/70" />
              <div className="dsp aspect-square rounded-lg bg-slate-200/62" />
            </>
          )}
        </div>
      )}

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="dsp h-5 w-4/5 rounded-full bg-slate-200/78" />
          <div className="dsp mt-2 h-3 w-2/5 rounded-full bg-slate-200/62" />
        </div>
        <div className="flex items-center gap-1.5">
          <div className="dsp h-8 w-8 rounded-full border border-slate-200 bg-slate-100" />
          <div className="dsp h-8 w-8 rounded-full border border-slate-200 bg-slate-100" />
        </div>
      </div>

      <div className="dsp mt-2 h-4 w-5/6 rounded-full bg-slate-200/70" />

      <div className="mt-2 flex h-6 flex-nowrap gap-1.5 overflow-hidden">
        <div className="dsp h-5 w-20 rounded-full bg-slate-200/64" />
        <div className="dsp h-5 w-22 rounded-full bg-slate-200/58" />
      </div>

      <div className="mt-auto flex items-center justify-between border-t border-slate-100 pt-3">
        <div className="dsp h-3 w-3/5 rounded-full bg-slate-200/64" />
        <div className="dsp h-4 w-16 rounded-full bg-slate-200/74" />
      </div>
    </div>
  );
}
