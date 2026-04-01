import { defineConfig } from "vitepress";

export default defineConfig({
  title: "BeachHouseClassifieds Docs",
  description: "Project documentation for BeachHouseClassifieds",
  lastUpdated: true,
  cleanUrls: true,
  outDir: "../.docs-dist",
  themeConfig: {
    nav: [{ text: "Home", link: "/" }],
    sidebar: [
      {
        text: "Docs",
        items: [
          { text: "Overview", link: "/" },
          {
            text: "Pricing and Conformance System Reference",
            link: "/pricing-system-reference",
          },
          {
            text: "Adapter Scrape and Extraction",
            link: "/adapter-scrape-and-extraction",
          },
          {
            text: "Quote Modules and Platform Strategy",
            link: "/quote-modules-platform-strategy",
          },
          { text: "Pricing Cache Builder", link: "/pricing-cache-builder" },
          { text: "Quote Validator", link: "/quote-validator" },
          { text: "Handoff Validator", link: "/handoff-validator" },
          {
            text: "Central Runner and Modular Adapters",
            link: "/central-runner-and-modular-adapters",
          },
          {
            text: "Adapter Catalog and Platform Differences",
            link: "/adapter-catalog-and-platform-differences",
          },
          {
            text: "Known Peculiarities and Workarounds",
            link: "/known-peculiarities-and-workarounds",
          },
          { text: "Ready Roadmap", link: "/ready-roadmap" },
        ],
      },
    ],
    search: {
      provider: "local",
    },
  },
});
