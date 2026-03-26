import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { ClassifiedsStarterHome } from "@/components/home/ClassifiedsStarterHome";
import { CommunityStarterHome } from "@/components/home/CommunityStarterHome";
import { HomeSkeletonSwitcher } from "@/components/home/HomeSkeletonSwitcher";
import { MarketingStarterHome } from "@/components/home/MarketingStarterHome";
import { SaasStarterHome } from "@/components/home/SaasStarterHome";
import { ServicesStarterHome } from "@/components/home/ServicesStarterHome";
import { requireSession } from "@/core/auth/auth-guards";

const appName = import.meta.env.VITE_APP_NAME ?? "BeachHouseClassifieds";
const homeVariantStorageKey = "starter-home-variant";
const variantSwitcherEnabled =
  import.meta.env.DEV ||
  import.meta.env.VITE_ENABLE_HOME_SKELETON_SWITCHER === "true";

type HomeStarterVariant =
  | "services"
  | "classifieds"
  | "saas"
  | "community"
  | "marketing";

const defaultVariant = normalizeVariant(
  import.meta.env.VITE_STARTER_HOME_VARIANT ?? "services",
);

function normalizeVariant(rawValue: string): HomeStarterVariant {
  if (rawValue === "classifieds") {
    return "classifieds";
  }

  if (rawValue === "saas") {
    return "saas";
  }

  if (rawValue === "community") {
    return "community";
  }

  if (rawValue === "marketing") {
    return "marketing";
  }

  return "services";
}

export const Route = createFileRoute("/home")({
  staleTime: 0,
  beforeLoad: async (ctx) => ({
    session: await requireSession(ctx),
  }),
  component: HomePage,
});

function HomePage() {
  const [activeVariant, setActiveVariant] = useState<HomeStarterVariant>(() => {
    if (!variantSwitcherEnabled || typeof window === "undefined") {
      return defaultVariant;
    }

    const savedVariant = window.localStorage.getItem(homeVariantStorageKey);
    return savedVariant ? normalizeVariant(savedVariant) : defaultVariant;
  });

  useEffect(() => {
    if (!variantSwitcherEnabled || typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(homeVariantStorageKey, activeVariant);
  }, [activeVariant]);

  const content =
    activeVariant === "classifieds" ? (
      <ClassifiedsStarterHome appName={appName} />
    ) : activeVariant === "saas" ? (
      <SaasStarterHome appName={appName} />
    ) : activeVariant === "community" ? (
      <CommunityStarterHome appName={appName} />
    ) : activeVariant === "marketing" ? (
      <MarketingStarterHome appName={appName} />
    ) : (
      <ServicesStarterHome appName={appName} />
    );

  return (
    <>
      {content}
      {variantSwitcherEnabled ? (
        <HomeSkeletonSwitcher
          value={activeVariant}
          onChange={setActiveVariant}
          onReset={() => setActiveVariant(defaultVariant)}
        />
      ) : null}
    </>
  );
}
