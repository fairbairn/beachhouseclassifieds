import { HomeFocusSection } from "@/components/home/HomeFocusSection";
import { HomeHeroSection } from "@/components/home/HomeHeroSection";
import { HomeMarketingShell } from "@/components/home/HomeMarketingShell";
import { HomePostSavingsCtaSection } from "@/components/home/HomePostSavingsCtaSection";
import { HomeSavingsSection } from "@/components/home/HomeSavingsSection";

export function HomeLandingPage() {
  return (
    <HomeMarketingShell>
      <HomeHeroSection />
      <HomeFocusSection />
      <HomeSavingsSection />
      <HomePostSavingsCtaSection />
    </HomeMarketingShell>
  );
}
