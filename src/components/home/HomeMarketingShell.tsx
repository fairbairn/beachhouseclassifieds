import type { ReactNode } from "react";
import { useEffect, useState } from "react";

import { HomeLandingFooter } from "@/components/home/HomeLandingFooter";
import { HomeLandingNav } from "@/components/home/HomeLandingNav";

type HomeMarketingShellProps = {
  children: ReactNode;
  contentClassName?: string;
  preferDarkTopNavText?: boolean;
  showTopNav?: boolean;
  showFooter?: boolean;
  disableNavScrollEffect?: boolean;
};

export function HomeMarketingShell({
  children,
  contentClassName,
  preferDarkTopNavText = false,
  showTopNav = true,
  showFooter = true,
  disableNavScrollEffect = false,
}: HomeMarketingShellProps) {
  const [isScrolled, setIsScrolled] = useState(false);

  useEffect(() => {
    if (disableNavScrollEffect) {
      setIsScrolled(false);
      return;
    }

    const handleScroll = () => {
      setIsScrolled(window.scrollY > 50);
    };

    handleScroll();
    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, [disableNavScrollEffect]);

  return (
    <div
      className="min-h-screen bg-white text-[#1A1A1A]"
      style={{ fontFamily: "'Manrope', sans-serif" }}
    >
      {showTopNav ? (
        <HomeLandingNav
          isScrolled={isScrolled}
          preferDarkTopText={preferDarkTopNavText}
        />
      ) : null}
      <div className={contentClassName}>{children}</div>
      {showFooter ? <HomeLandingFooter /> : null}
    </div>
  );
}
