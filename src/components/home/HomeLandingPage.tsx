import { useEffect, useState } from "react";

import { HomeFocusSection } from "@/components/home/HomeFocusSection";
import { HomeHeroSection } from "@/components/home/HomeHeroSection";
import { HomeLandingFooter } from "@/components/home/HomeLandingFooter";
import { HomeLandingNav } from "@/components/home/HomeLandingNav";
import { HomePostSavingsCtaSection } from "@/components/home/HomePostSavingsCtaSection";
import { HomeSavingsSection } from "@/components/home/HomeSavingsSection";

export function HomeLandingPage() {
  const [isScrolled, setIsScrolled] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 50);
    };

    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  useEffect(() => {
    const link = document.createElement("link");
    link.href =
      "https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;1,400&family=Manrope:wght@400;500;700;800&display=swap";
    link.rel = "stylesheet";
    document.head.appendChild(link);

    return () => {
      document.head.removeChild(link);
    };
  }, []);

  useEffect(() => {
    const previousHtmlOverscrollY =
      document.documentElement.style.overscrollBehaviorY;
    const previousBodyOverscrollY = document.body.style.overscrollBehaviorY;

    document.documentElement.style.overscrollBehaviorY = "none";
    document.body.style.overscrollBehaviorY = "none";

    return () => {
      document.documentElement.style.overscrollBehaviorY =
        previousHtmlOverscrollY;
      document.body.style.overscrollBehaviorY = previousBodyOverscrollY;
    };
  }, []);

  return (
    <div
      className="min-h-screen bg-white text-[#1A1A1A]"
      style={{ fontFamily: "'Manrope', sans-serif" }}
    >
      <HomeLandingNav isScrolled={isScrolled} />
      <HomeHeroSection />
      <HomeFocusSection />
      <HomeSavingsSection />
      <HomePostSavingsCtaSection />
      <HomeLandingFooter />
    </div>
  );
}
