import { createFileRoute } from "@tanstack/react-router";

import { HomeLandingPage } from "@/components/home/HomeLandingPage";

export const Route = createFileRoute("/")({
  staleTime: 0,
  component: HomePage,
});

function HomePage() {
  return <HomeLandingPage />;
}
