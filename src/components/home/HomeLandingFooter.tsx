export function HomeLandingFooter() {
  return (
    <footer
      className="mt-4 border-t border-white/20 bg-slate-950/65 px-4 py-2 backdrop-blur-sm"
      role="contentinfo"
    >
      <div className="mx-auto max-w-6xl overflow-x-auto text-center text-[11px] whitespace-nowrap text-white/85 md:text-xs">
        <div className="inline-flex items-center gap-2">
          <a href="#" className="transition-colors hover:text-white">
            Legal &amp; Disclaimers
          </a>
          <span aria-hidden="true" className="text-white/40">
            |
          </span>
          <a href="#" className="transition-colors hover:text-white">
            Privacy Policy
          </a>
          <span aria-hidden="true" className="text-white/40">
            |
          </span>
          <a href="#" className="transition-colors hover:text-white">
            Contact
          </a>
          <span aria-hidden="true" className="text-white/40">
            |
          </span>
          <span className="tracking-[0.04em]">© 2026 30A Collections.com</span>
        </div>
      </div>
    </footer>
  );
}
