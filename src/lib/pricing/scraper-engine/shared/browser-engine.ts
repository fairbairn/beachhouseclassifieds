type BrowserEngine = "cloakbrowser" | "playwright";

type LaunchInput = {
  adapterKey: string;
  envPrefix: string;
  headless?: boolean;
};

type PageGotoResponseLike = {
  status(): number;
};

export type ScraperBrowserPageLike = {
  goto(
    url: string,
    options?: { waitUntil?: "commit" | "domcontentloaded"; timeout?: number },
  ): Promise<PageGotoResponseLike | null>;
  content(): Promise<string>;
  url(): string;
  close(): Promise<void>;
};

export type ScraperBrowserLike = {
  newPage(): Promise<ScraperBrowserPageLike>;
  close(): Promise<void>;
};

const CLOAK_BROWSER_DEFAULT_ADAPTERS = new Set<string>([
  "rosemary30a",
  "coastproperties30a",
  "dunevr30a",
  "stayon30a",
  "30abeach",
]);

function normalizeEngineValue(value: string | undefined): BrowserEngine | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "cloakbrowser" || normalized === "cloak") {
    return "cloakbrowser";
  }
  if (normalized === "playwright" || normalized === "pw") {
    return "playwright";
  }
  return null;
}

function resolveEngine(input: {
  adapterKey: string;
  envPrefix: string;
}): BrowserEngine {
  const adapterScraperScoped = normalizeEngineValue(
    process.env[`${input.envPrefix}_SCRAPER_BROWSER_ENGINE`],
  );
  if (adapterScraperScoped) {
    return adapterScraperScoped;
  }

  const adapterGlobalScoped = normalizeEngineValue(
    process.env[`${input.envPrefix}_BROWSER_ENGINE`],
  );
  if (adapterGlobalScoped) {
    return adapterGlobalScoped;
  }

  const scraperScoped = normalizeEngineValue(
    process.env.SCRAPER_BROWSER_ENGINE,
  );
  if (scraperScoped) {
    return scraperScoped;
  }

  const globalScoped = normalizeEngineValue(
    process.env.STREAMLINE_BROWSER_ENGINE,
  );
  if (globalScoped) {
    return globalScoped;
  }

  if (CLOAK_BROWSER_DEFAULT_ADAPTERS.has(input.adapterKey)) {
    return "cloakbrowser";
  }

  return "playwright";
}

export async function launchScraperBrowser(
  input: LaunchInput,
): Promise<ScraperBrowserLike> {
  const engine = resolveEngine({
    adapterKey: input.adapterKey,
    envPrefix: input.envPrefix,
  });

  if (engine === "cloakbrowser") {
    const cloakBrowserModule = (await import("cloakbrowser")) as {
      launch: (
        options?: Record<string, unknown>,
      ) => Promise<ScraperBrowserLike>;
    };
    return cloakBrowserModule.launch({
      headless: input.headless ?? true,
    });
  }

  const playwrightModule = (await import("playwright")) as {
    chromium: {
      launch: (
        options?: Record<string, unknown>,
      ) => Promise<ScraperBrowserLike>;
    };
  };

  return playwrightModule.chromium.launch({
    headless: input.headless ?? true,
  });
}
