import type { QuoteProgress } from "@/lib/pricing/quotes/types";

import { runLegacyAdapterQuoteViaEngine } from "./legacy-adapter-quote-runner";

export async function runKeyco30aQuoteCli(
  argv: string[],
  progress?: QuoteProgress,
): Promise<void> {
  await runLegacyAdapterQuoteViaEngine({
    adapterKey: "keyco30a",
    engineScriptRaw: "managers:scrape:keyco30a:engine:raw",
    argv,
    progress,
    windowDaysEnvVar: "KEYCO30A_RATES_WINDOW_DAYS",
    nightsEnvVar: "KEYCO30A_RATES_QUOTE_NIGHTS",
    maxQueriesEnvVar: "KEYCO30A_RATES_MAX_QUERIES",
  });
}
