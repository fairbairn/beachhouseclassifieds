import type { QuoteProgress } from "@/lib/pricing/quotes/types";

import { runLegacyAdapterQuoteViaEngine } from "./legacy-adapter-quote-runner";

export async function runThirtyAEscapesQuoteCli(
  argv: string[],
  progress?: QuoteProgress,
): Promise<void> {
  await runLegacyAdapterQuoteViaEngine({
    adapterKey: "30aescapes",
    engineScriptRaw: "managers:scrape:30aescapes:engine:raw",
    argv,
    progress,
    windowDaysEnvVar: "ESCAPES30A_RATES_WINDOW_DAYS",
    nightsEnvVar: "ESCAPES30A_RATES_QUOTE_NIGHTS",
    maxQueriesEnvVar: "ESCAPES30A_RATES_MAX_QUERIES",
  });
}
