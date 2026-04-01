import type { QuoteProgress } from "@/lib/pricing/quotes/types";

import { runLegacyAdapterQuoteViaEngine } from "@/lib/pricing/quotes/shared/legacy-adapter-quote-runner";

export async function run360BlueQuoteCli(
  argv: string[],
  progress?: QuoteProgress,
): Promise<void> {
  await runLegacyAdapterQuoteViaEngine({
    adapterKey: "360blue",
    engineScriptRaw: "managers:scrape:360blue:engine:raw",
    argv,
    progress,
    windowDaysEnvVar: "BLUE360_RATE_QUOTE_MAX_DAYS",
    nightsEnvVar: "BLUE360_RATES_QUOTE_NIGHTS",
  });
}
