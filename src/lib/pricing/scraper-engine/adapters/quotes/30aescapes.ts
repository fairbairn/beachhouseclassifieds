import type { QuoteProgress } from "@/lib/pricing/quotes/types";

import { runLegacyAdapterQuoteViaEngine } from "@/lib/pricing/quotes/shared/legacy-adapter-quote-runner";

function hasFlag(argv: string[], flag: string): boolean {
  return (
    argv.includes(flag) || argv.some((item) => item.startsWith(`${flag}=`))
  );
}

export async function runThirtyAEscapesQuoteCli(
  argv: string[],
  progress?: QuoteProgress,
): Promise<void> {
  const normalizedArgv = [...argv];
  if (!hasFlag(normalizedArgv, "--detail-fetch-concurrency")) {
    const concurrency = Math.max(
      1,
      Number(process.env.ESCAPES30A_QUOTE_DETAIL_FETCH_CONCURRENCY ?? "8") || 8,
    );
    normalizedArgv.push("--detail-fetch-concurrency", String(concurrency));
  }
  if (!hasFlag(normalizedArgv, "--detail-fetch-delay-ms")) {
    const delayMs = Math.max(
      0,
      Number(process.env.ESCAPES30A_QUOTE_DETAIL_FETCH_DELAY_MS ?? "40") || 40,
    );
    normalizedArgv.push("--detail-fetch-delay-ms", String(delayMs));
  }

  await runLegacyAdapterQuoteViaEngine({
    adapterKey: "30aescapes",
    engineScriptRaw: "managers:scrape:30aescapes:engine:raw",
    argv: normalizedArgv,
    progress,
    windowDaysEnvVar: "ESCAPES30A_RATES_WINDOW_DAYS",
    nightsEnvVar: "ESCAPES30A_RATES_QUOTE_NIGHTS",
    maxQueriesEnvVar: "ESCAPES30A_RATES_MAX_QUERIES",
    minWeeks: 24,
  });
}
