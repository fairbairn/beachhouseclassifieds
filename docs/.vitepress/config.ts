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
        items: [{ text: "Overview", link: "/" }],
      },
    ],
    search: {
      provider: "local",
    },
  },
});
