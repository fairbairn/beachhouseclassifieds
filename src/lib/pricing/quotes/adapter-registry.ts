import { runBenchmark30aQuoteCli } from "@/lib/pricing/quotes/quote-benchmark30a";
import { runDunevr30aQuoteCli } from "@/lib/pricing/quotes/quote-dunevr30a";
import { runHomeownerscollection30aQuoteCli } from "@/lib/pricing/quotes/quote-homeownerscollection30a";
import { runRoyaldestinationsQuoteCli } from "@/lib/pricing/quotes/quote-royaldestinations";
import type { QuoteAdapter } from "@/lib/pricing/quotes/types";

const QUOTE_ADAPTERS: QuoteAdapter[] = [
  {
    adapterKey: "royaldestinations",
    async run(argv, progress) {
      await runRoyaldestinationsQuoteCli(argv, progress);
    },
  },
  {
    adapterKey: "benchmark30a",
    async run(argv, progress) {
      await runBenchmark30aQuoteCli(argv, progress);
    },
  },
  {
    adapterKey: "dunevr30a",
    async run(argv, progress) {
      await runDunevr30aQuoteCli(argv, progress);
    },
  },
  {
    adapterKey: "homeownerscollection30a",
    async run(argv, progress) {
      const exitCode = await runHomeownerscollection30aQuoteCli(argv, progress);
      if (exitCode !== 0) {
        throw new Error(
          `homeownerscollection30a quote failed with exit code ${exitCode}`,
        );
      }
    },
  },
];

export function getKnownQuoteAdapterKeys(): string[] {
  return QUOTE_ADAPTERS.map((adapter) => adapter.adapterKey).sort();
}

export function createQuoteAdapterByKey(
  adapterKey: string,
): QuoteAdapter | null {
  const normalized = adapterKey.trim().toLowerCase();
  return (
    QUOTE_ADAPTERS.find((adapter) => adapter.adapterKey === normalized) ?? null
  );
}
