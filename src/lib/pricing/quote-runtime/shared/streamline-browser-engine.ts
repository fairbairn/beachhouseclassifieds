import type { QuoteExecutionRequest, QuoteExecutionResult } from "../types";
import { executeStreamlineCloakBrowserQuote } from "./streamline-cloakbrowser";
import { executeStreamlinePlaywrightQuote } from "./streamline-playwright";

type BrowserEngine = "cloakbrowser" | "playwright";

type StreamlineQuoteInput = {
  adapterKey: string;
  envPrefix: string;
  request: QuoteExecutionRequest;
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

function resolveConfiguredEngine(input: {
  adapterKey: string;
  envPrefix: string;
}): BrowserEngine {
  const adapterScoped = normalizeEngineValue(
    process.env[`${input.envPrefix}_BROWSER_ENGINE`],
  );
  if (adapterScoped) {
    return adapterScoped;
  }

  const globalDefault = normalizeEngineValue(
    process.env.STREAMLINE_BROWSER_ENGINE,
  );
  if (globalDefault) {
    return globalDefault;
  }

  if (CLOAK_BROWSER_DEFAULT_ADAPTERS.has(input.adapterKey)) {
    return "cloakbrowser";
  }

  return "playwright";
}

export async function executeStreamlineBrowserQuote(
  input: StreamlineQuoteInput,
): Promise<QuoteExecutionResult> {
  const engine = resolveConfiguredEngine({
    adapterKey: input.adapterKey,
    envPrefix: input.envPrefix,
  });

  if (engine === "cloakbrowser") {
    return executeStreamlineCloakBrowserQuote(input);
  }

  return executeStreamlinePlaywrightQuote(input);
}
