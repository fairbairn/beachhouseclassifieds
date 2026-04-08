export function HomeLandingFooter() {
  return (
    <footer className="border-t border-slate-200/70 bg-white px-6 py-8">
      <div className="mx-auto flex max-w-5xl flex-col items-center gap-3 text-center">
        <div className="flex items-center gap-3 text-xs text-slate-500 md:text-sm">
          <a href="#" className="transition-colors hover:text-slate-700">
            Legal &amp; Disclaimers
          </a>
          <span aria-hidden="true" className="text-slate-300">
            |
          </span>
          <a href="#" className="transition-colors hover:text-slate-700">
            Privacy Policy
          </a>
          <span aria-hidden="true" className="text-slate-300">
            |
          </span>
          <a href="#" className="transition-colors hover:text-slate-700">
            Contact
          </a>
        </div>

        <div className="text-xs tracking-[0.06em] text-slate-500 md:text-sm">
          © 2026, 30A Collections.com
        </div>
      </div>
    </footer>
  );
}
