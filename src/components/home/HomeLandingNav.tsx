import areaLogo from "@/assets/images/30a-area-logo.png";
import {
  HOME_ACTION_BUTTON_BASE,
  HOME_ACTION_BUTTON_LIGHT,
  HOME_ACTION_BUTTON_STANDARD_SIZE,
  HOME_ACTION_BUTTON_TEAL,
} from "@/components/home/homeButtonStyles";

type HomeLandingNavProps = {
  isScrolled: boolean;
  preferDarkTopText?: boolean;
};

export function HomeLandingNav({
  isScrolled,
  preferDarkTopText = false,
}: HomeLandingNavProps) {
  return (
    <nav
      className={`fixed top-0 z-50 grid w-full grid-cols-3 items-center px-6 transition-all duration-500 md:px-12 ${
        isScrolled
          ? "border-b border-slate-100 bg-white/95 py-2 shadow-sm backdrop-blur-md"
          : "bg-transparent py-4"
      }`}
    >
      <div className="flex justify-start">
        <img
          src={areaLogo}
          alt="30A area emblem"
          className={`w-auto rounded-full border border-white/30 object-contain transition-all duration-500 ${
            isScrolled
              ? "h-16 border-slate-200/80 shadow-sm"
              : "h-15 border-white/40 shadow-[0_8px_30px_-14px_rgba(15,23,42,0.6)]"
          }`}
        />
      </div>

      <div className="flex justify-center">
        <div className="flex flex-col items-center">
          <span
            className={`text-5xl leading-none tracking-[0.06em] transition-colors duration-500 md:text-6xl ${
              isScrolled || preferDarkTopText ? "text-[#1f242b]" : "text-white"
            }`}
            style={{ fontFamily: "'Playfair Display', serif" }}
          >
            30<span className="text-[#2DD4BF]">A</span>
          </span>
          <span
            className={`mt-1 text-[11px] font-bold tracking-[0.46em] uppercase transition-colors duration-500 md:text-xs ${
              isScrolled || preferDarkTopText
                ? "text-slate-500"
                : "text-white/80"
            }`}
          >
            Collections
          </span>
          <div
            className={`my-1 h-px w-30 transition-all duration-500 md:w-36 ${
              isScrolled ? "bg-[#2DD4BF]" : "bg-[#2DD4BF]/90"
            }`}
          />
        </div>
      </div>

      <div className="flex justify-end">
        <a
          href="/discover"
          className={`${HOME_ACTION_BUTTON_BASE} ${HOME_ACTION_BUTTON_STANDARD_SIZE} ${isScrolled ? HOME_ACTION_BUTTON_TEAL : HOME_ACTION_BUTTON_LIGHT}`}
        >
          Book Now
        </a>
      </div>
    </nav>
  );
}
