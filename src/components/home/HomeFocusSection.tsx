import { CircleDollarSign, House, ShieldCheck } from "lucide-react";
import beachPathTexture from "@/assets/images/beach-path.jpg";

export function HomeFocusSection() {
  return (
    <section id="focus-overview" className="relative overflow-hidden bg-white py-24">
      <div
        className="pointer-events-none absolute inset-0 z-0 bg-cover bg-center bg-no-repeat"
        style={{
          backgroundImage: `url(${beachPathTexture})`,
          backgroundPosition: "center bottom",
        }}
      />
      <div
        className="pointer-events-none absolute inset-0 z-1"
        style={{ backgroundColor: "rgba(255,255,255,0.62)" }}
      />

      <div className="relative z-10 mx-auto max-w-6xl px-6 text-center">
        <h2
          className="mb-12 text-5xl leading-[1.05] tracking-tight md:text-7xl"
          style={{ fontFamily: "'Playfair Display', serif" }}
        >
          The direct path to <br />
          <span className="font-light text-[#2DD4BF] italic">
            your perfect{" "}
            <span className="relative inline-block">
              beach
              <svg
                aria-hidden="true"
                viewBox="0 0 160 24"
                className="pointer-events-none absolute -right-1 -bottom-3 h-4 w-[108%]"
              >
                <path
                  d="M4 16 C 42 30, 116 -2, 156 12"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                />
              </svg>
            </span>{" "}
            house.
          </span>
        </h2>

        <p className="mx-auto mb-24 max-w-4xl text-2xl leading-relaxed font-light text-slate-600 md:text-[1.72rem]">
          We&apos;ve indexed the full 30A corridor to provide the largest
          collection of vacation homes in one place. Find the right house, know
          the true cost, and book directly with the host responsible for your
          stay.
        </p>

        <div className="grid gap-8 border-t border-slate-200 pt-16 text-left md:grid-cols-3">
          <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-[0_20px_40px_-30px_rgba(2,132,199,0.55)]">
            <div className="mb-5 text-[#2DD4BF]">
              <CircleDollarSign className="h-8 w-8" strokeWidth={2.1} />
            </div>
            <h4 className="mb-3 text-base font-bold tracking-[0.18em] uppercase">
              Pricing Clarity
            </h4>
            <p className="text-base leading-relaxed text-slate-600 md:text-lg">
              We strip away platform noise and show transparent stay totals before
              you click through.
            </p>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-[0_20px_40px_-30px_rgba(2,132,199,0.55)]">
            <div className="mb-5 text-[#2DD4BF]">
              <House className="h-8 w-8" strokeWidth={2.1} />
            </div>
            <h4 className="mb-3 text-base font-bold tracking-[0.18em] uppercase">
              Curated Inventory
            </h4>
            <p className="text-base leading-relaxed text-slate-600 md:text-lg">
              Focused on full homes across 30A with space, privacy, and
              neighborhood fit.
            </p>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-[0_20px_40px_-30px_rgba(2,132,199,0.55)]">
            <div className="mb-5 text-[#2DD4BF]">
              <ShieldCheck className="h-8 w-8" strokeWidth={2.1} />
            </div>
            <h4 className="mb-3 text-base font-bold tracking-[0.18em] uppercase">
              Direct Checkout
            </h4>
            <p className="text-base leading-relaxed text-slate-600 md:text-lg">
              We guide discovery, then hand off to verified host checkout for
              reliable rates and fulfillment.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
