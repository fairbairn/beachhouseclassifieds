function ArrowRightIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4.5 w-4.5">
      <path
        d="M5 12h14M13 5l7 7-7 7"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function HomeHeroSection() {
  const heroBg = "https://30a.com/wp-content/uploads/2025/08/Alys-Beach-1.jpg";

  return (
    <section className="relative flex h-screen min-h-187.5 items-center justify-center overflow-hidden">
      <img
        src={heroBg}
        alt="Alys Beach"
        className="absolute inset-0 h-full w-full object-cover"
      />

      <div className="relative z-10 w-full max-w-5xl px-6">
        <div className="relative rounded-[2.5rem] border border-white/12 bg-[#0a192f]/52 p-10 text-center text-white shadow-2xl backdrop-blur-sm md:p-16">
          <div className="mb-10">
            <span className="inline-block border-b-2 border-[#2DD4BF]/60 pb-2 text-sm font-bold tracking-wide text-white/60 uppercase md:text-lg">
              Over{" "}
              <span
                className="inline-block align-[0.05em] text-[1.32em] leading-[0.9] font-semibold tracking-[0.01em] text-[#2DD4BF] md:text-[1.42em]"
                style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}
              >
                3,000+
              </span>{" "}
              Vacation Homes, Exclusively on 30A.
            </span>
          </div>

          <h1
            className="mb-8 leading-[1.1] tracking-tight md:leading-[0.95]"
            style={{ fontFamily: "'Playfair Display', serif" }}
          >
            <span className="mb-6 inline-block text-6xl md:text-9xl">
              Find the{" "}
              <span className="relative inline-block pb-10 italic">
                One.
                <svg
                  className="pointer-events-none absolute -bottom-1 left-0 h-10 w-full text-[#2DD4BF]"
                  viewBox="0 0 300 40"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path
                    d="M10 15C60 5 200 5 290 18"
                    stroke="currentColor"
                    strokeWidth="6"
                    strokeLinecap="round"
                  />
                  <path
                    d="M20 28C80 18 210 18 280 32"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    opacity="0.6"
                  />
                </svg>
              </span>
            </span>
            <span className="mt-2 block text-4xl font-light italic opacity-95 md:text-7xl">
              Without the Hunt.
            </span>
          </h1>

          <p className="mx-auto mb-12 max-w-2xl text-lg leading-relaxed font-light text-white/95 md:text-xl">
            Every 30A beach house in one place. See exact pricing upfront,
            compare your options, and book directly with the host.
          </p>

          <div className="flex flex-col items-center gap-4">
            <a
              href="/discover"
              className="group flex items-center gap-4 rounded-2xl bg-white px-12 py-6 text-xs font-black tracking-[0.14em] text-black! uppercase no-underline! shadow-[0_18px_40px_-22px_rgba(15,23,42,0.9)] transition-all duration-300 visited:text-black! visited:no-underline! hover:bg-[#f8fffd] hover:text-black! hover:no-underline! hover:shadow-[0_28px_62px_-20px_rgba(45,212,191,0.75)] focus:text-black! focus:no-underline! focus-visible:ring-4 focus-visible:ring-[#2DD4BF]/45 focus-visible:outline-none active:no-underline! md:text-sm"
            >
              Book Your Perfect Vacation Rental
              <span className="transition-transform group-hover:translate-x-1">
                <ArrowRightIcon />
              </span>
            </a>
            <p className="text-[10px] font-bold tracking-[0.2em] text-white/70 uppercase">
              Search across dates. Compare instantly. Decide confidently.
            </p>
          </div>
        </div>
      </div>

      <a
        href="#focus-overview"
        className="absolute bottom-6 left-1/2 z-10 flex -translate-x-1/2 flex-col items-center text-white/85 transition hover:text-white"
        aria-label="Scroll to explore more information"
      >
        <span className="text-[10px] font-bold tracking-[0.26em] uppercase">
          Scroll
        </span>
        <span className="mt-1 text-xl leading-none motion-safe:animate-bounce">
          ↓
        </span>
      </a>
    </section>
  );
}
