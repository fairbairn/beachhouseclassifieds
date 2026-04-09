import beachEntryTexture from "@/assets/images/beach-entry.png";
import {
  HOME_ACTION_BUTTON_BASE,
  HOME_ACTION_BUTTON_LARGE_SIZE,
  HOME_ACTION_BUTTON_TEAL,
} from "@/components/home/homeButtonStyles";
import { ArrowRight } from "lucide-react";

export function HomePostSavingsCtaSection() {
  return (
    <section className="relative overflow-hidden bg-white px-6 pb-24">
      <div
        className="pointer-events-none absolute inset-0 z-0 bg-cover bg-center bg-no-repeat"
        style={{
          backgroundImage: `url(${beachEntryTexture})`,
          backgroundPosition: "center center",
        }}
      />
      <div
        className="pointer-events-none absolute inset-0 z-1"
        style={{ backgroundColor: "rgba(255,255,255,0.62)" }}
      />

      <div className="relative z-10 mx-auto max-w-5xl border-t border-slate-200 pt-16 text-center md:pt-20">
        <p className="text-xs font-bold tracking-[0.18em] text-slate-400 uppercase md:text-sm">
          Start Now
        </p>
        <h3
          className="mx-auto mt-4 max-w-4xl text-4xl leading-[1.08] tracking-tight text-slate-900 md:text-6xl"
          style={{ fontFamily: "'Playfair Display', serif" }}
        >
          Find the{" "}
          <span className="inline-block">
            30<span className="text-[#2DD4BF]">A</span>
          </span>{" "}
          home your family will remember forever.
        </h3>
        <p className="mx-auto mt-5 max-w-3xl text-lg text-slate-600 md:text-xl">
          Explore available vacation rentals, compare true stay totals, and book
          the right home for your trip with confidence.
        </p>

        <div className="mt-10">
          <a
            href="/discover"
            className={`inline-flex items-center justify-center gap-2 ${HOME_ACTION_BUTTON_BASE} ${HOME_ACTION_BUTTON_LARGE_SIZE} ${HOME_ACTION_BUTTON_TEAL}`}
          >
            <span>EXPLORE THE COLLECTION</span>
            <ArrowRight
              className="h-4 w-4"
              strokeWidth={2.25}
              aria-hidden="true"
            />
          </a>
        </div>
      </div>
    </section>
  );
}
