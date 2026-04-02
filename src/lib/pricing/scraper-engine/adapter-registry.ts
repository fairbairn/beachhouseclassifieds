import { createScrapeProgress } from "@/core/tooling/terminal/scrape-progress";
import { SHARED_LISTING_CACHE_ADAPTER_DEFINITIONS } from "@/lib/pricing/cache/listing-pricing-cache-adapter-definitions";
import { runSharedListingPricingCacheCli } from "@/lib/pricing/cache/run-shared-listing-pricing-cache-cli";
import type { QuoteProgress } from "@/lib/pricing/quotes/types";
import { runValidateAdapterQuoteSidecarsCli } from "@/lib/pricing/validation/validate-adapter-quote-sidecars";
import { create30ABeachAdapter } from "./adapters/30abeach";
import { create30AEscapesAdapter } from "./adapters/30aescapes";
import { create30ALuxuryAdapter } from "./adapters/30aluxury";
import { createThirtyAVacayAdapter } from "./adapters/30avacay";
import { create360BlueAdapter } from "./adapters/360blue";
import { createBenchmark30AAdapter } from "./adapters/benchmark30a";
import { createCoastProperties30AAdapter } from "./adapters/coastproperties30a";
import { createDuneVR30AAdapter } from "./adapters/dunevr30a";
import { createExclusive30AAdapter } from "./adapters/exclusive30a";
import { createFiveStar30AAdapter } from "./adapters/fivestar30a";
import { createFunVacay30AAdapter } from "./adapters/funvacay30a";
import { createGrayt30AAdapter } from "./adapters/grayt30a";
import { createHomeownersCollection30AAdapter } from "./adapters/homeownerscollection30a";
import { createKeyco30AAdapter } from "./adapters/keyco30a";
import { createLocalVR30AAdapter } from "./adapters/localvr30a";
import { createOceanReef30AAdapter } from "./adapters/oceanreef30a";
import { createOversee30AAdapter } from "./adapters/oversee30a";
import { createPanhandle30AAdapter } from "./adapters/panhandle30a";
import { createRealJoy30AAdapter } from "./adapters/realjoy30a";
import { createRoyalDestinationsAdapter } from "./adapters/royaldestinations";
import { createSandersBeach30AAdapter } from "./adapters/sandersbeach30a";
import { createSandpiper30AAdapter } from "./adapters/sandpiper30a";
import { createScenicStays30AAdapter } from "./adapters/scenicstays30a";
import { createStayAt30AAdapter } from "./adapters/stayat30a";
import { createStayOn30AAdapter } from "./adapters/stayon30a";
import { runScraperEngine } from "./runner";
import { runFallbackSingleQuoteObservation } from "./single-quote-observation-fallback";
import type {
  DetailRecordBase,
  ScraperAdapter,
  SingleQuoteObservationInput,
  SingleQuoteObservationResult,
} from "./types";

type AdapterFactory = () => ScraperAdapter<DetailRecordBase>;

const ADAPTER_FACTORIES: Record<string, AdapterFactory> = {
  "30abeach": create30ABeachAdapter,
  "30aescapes": create30AEscapesAdapter,
  "30aluxury": create30ALuxuryAdapter,
  "30avacay": createThirtyAVacayAdapter,
  "360blue": create360BlueAdapter,
  benchmark30a: createBenchmark30AAdapter,
  coastproperties30a: createCoastProperties30AAdapter,
  dunevr30a: createDuneVR30AAdapter,
  exclusive30a: createExclusive30AAdapter,
  fivestar30a: createFiveStar30AAdapter,
  funvacay30a: createFunVacay30AAdapter,
  grayt30a: createGrayt30AAdapter,
  homeownerscollection30a: createHomeownersCollection30AAdapter,
  keyco30a: createKeyco30AAdapter,
  localvr30a: createLocalVR30AAdapter,
  oceanreef30a: createOceanReef30AAdapter,
  oversee30a: createOversee30AAdapter,
  panhandle30a: createPanhandle30AAdapter,
  realjoy30a: createRealJoy30AAdapter,
  royaldestinations: createRoyalDestinationsAdapter,
  sandersbeach30a: createSandersBeach30AAdapter,
  sandpiper30a: createSandpiper30AAdapter,
  scenicstays30a: createScenicStays30AAdapter,
  stayat30a: createStayAt30AAdapter,
  stayon30a: createStayOn30AAdapter,
};

const CACHE_CAPABLE = new Set(
  Object.keys(SHARED_LISTING_CACHE_ADAPTER_DEFINITIONS),
);

export type AdapterOperationProxy = {
  adapterKey: string;
  capabilities: {
    quoteCapture: boolean;
    singleQuoteObservation: boolean;
    quoteValidation: boolean;
    pricingCache: boolean;
  };
  runScrape(argv: string[]): Promise<void>;
  runQuoteCapture(argv: string[], progress?: QuoteProgress): Promise<void>;
  runSingleQuoteObservation(
    input: SingleQuoteObservationInput,
    progress?: QuoteProgress,
  ): Promise<SingleQuoteObservationResult>;
  runQuoteValidation(argv?: string[]): Promise<void>;
  runPricingCache(argv: string[]): Promise<void>;
};

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isAsyncMethod(
  value: unknown,
): value is (...args: unknown[]) => Promise<void> {
  return typeof value === "function";
}

export function validateAdapterOperationProxy(
  proxy: AdapterOperationProxy,
): void {
  if (!proxy.adapterKey || proxy.adapterKey.trim().length === 0) {
    throw new Error("Invalid adapter proxy: adapterKey is required.");
  }

  if (!isBoolean(proxy.capabilities.quoteCapture)) {
    throw new Error(
      `Invalid adapter proxy '${proxy.adapterKey}': capabilities.quoteCapture must be boolean.`,
    );
  }

  if (!isBoolean(proxy.capabilities.singleQuoteObservation)) {
    throw new Error(
      `Invalid adapter proxy '${proxy.adapterKey}': capabilities.singleQuoteObservation must be boolean.`,
    );
  }

  if (!isBoolean(proxy.capabilities.quoteValidation)) {
    throw new Error(
      `Invalid adapter proxy '${proxy.adapterKey}': capabilities.quoteValidation must be boolean.`,
    );
  }

  if (!isBoolean(proxy.capabilities.pricingCache)) {
    throw new Error(
      `Invalid adapter proxy '${proxy.adapterKey}': capabilities.pricingCache must be boolean.`,
    );
  }

  if (!isAsyncMethod(proxy.runScrape)) {
    throw new Error(
      `Invalid adapter proxy '${proxy.adapterKey}': runScrape must be a function.`,
    );
  }

  if (!isAsyncMethod(proxy.runQuoteCapture)) {
    throw new Error(
      `Invalid adapter proxy '${proxy.adapterKey}': runQuoteCapture must be a function.`,
    );
  }

  if (!isAsyncMethod(proxy.runQuoteValidation)) {
    throw new Error(
      `Invalid adapter proxy '${proxy.adapterKey}': runQuoteValidation must be a function.`,
    );
  }

  if (!isAsyncMethod(proxy.runPricingCache)) {
    throw new Error(
      `Invalid adapter proxy '${proxy.adapterKey}': runPricingCache must be a function.`,
    );
  }

  const normalized = proxy.adapterKey.trim().toLowerCase();
  if (proxy.capabilities.pricingCache !== CACHE_CAPABLE.has(normalized)) {
    throw new Error(
      `Invalid adapter proxy '${proxy.adapterKey}': pricingCache capability mismatch.`,
    );
  }
}

export function getKnownAdapterKeys(): string[] {
  return Object.keys(ADAPTER_FACTORIES).sort();
}

export function createAdapterByKey(
  adapterKey: string,
): ScraperAdapter<DetailRecordBase> | null {
  const key = adapterKey.trim().toLowerCase();
  const factory = ADAPTER_FACTORIES[key];
  if (!factory) {
    return null;
  }
  return factory();
}

export function createAdapterOperationProxyByKey(
  adapterKey: string,
): AdapterOperationProxy | null {
  const normalized = adapterKey.trim().toLowerCase();
  const adapter = createAdapterByKey(normalized);
  if (!adapter) {
    return null;
  }

  const quoteCapture = typeof adapter.runQuoteCapture === "function";
  const singleQuoteObservation = quoteCapture;
  const quoteValidation = quoteCapture;
  const pricingCache = CACHE_CAPABLE.has(normalized);

  const proxy: AdapterOperationProxy = {
    adapterKey: normalized,
    capabilities: {
      quoteCapture,
      singleQuoteObservation,
      quoteValidation,
      pricingCache,
    },
    async runScrape(argv: string[]): Promise<void> {
      await runScraperEngine(adapter, ["node", "run-scrape-engine", ...argv]);
    },
    async runQuoteCapture(
      argv: string[],
      progress?: QuoteProgress,
    ): Promise<void> {
      if (!quoteCapture) {
        throw new Error("adapter is not quote-capable");
      }

      if (!adapter.runQuoteCapture) {
        throw new Error(
          `Adapter '${normalized}' does not implement runQuoteCapture.`,
        );
      }

      const quoteProgress =
        progress ?? createScrapeProgress({ script: normalized });
      await adapter.runQuoteCapture(argv, quoteProgress);
    },
    async runSingleQuoteObservation(
      input: SingleQuoteObservationInput,
      progress?: QuoteProgress,
    ): Promise<SingleQuoteObservationResult> {
      if (!singleQuoteObservation) {
        throw new Error("adapter does not implement single quote observation");
      }

      if (adapter.runSingleQuoteObservation) {
        const quoteProgress =
          progress ?? createScrapeProgress({ script: normalized });
        return adapter.runSingleQuoteObservation(input, quoteProgress);
      }

      return runFallbackSingleQuoteObservation(input);
    },
    async runQuoteValidation(argv: string[] = []): Promise<void> {
      if (!quoteValidation) {
        throw new Error("adapter is not quote-capable");
      }

      const code = await runValidateAdapterQuoteSidecarsCli([
        "--adapter-key",
        normalized,
        ...argv,
      ]);
      if (code !== 0) {
        throw new Error(`quote validation failed with exit code ${code}`);
      }
    },
    async runPricingCache(argv: string[]): Promise<void> {
      if (!pricingCache) {
        throw new Error("adapter has no shared cache definition");
      }

      await runSharedListingPricingCacheCli(normalized, argv);
    },
  };

  validateAdapterOperationProxy(proxy);
  return proxy;
}

export function createValidatedAdapterOperationProxyByKey(
  adapterKey: string,
): AdapterOperationProxy | null {
  const proxy = createAdapterOperationProxyByKey(adapterKey);
  if (!proxy) {
    return null;
  }

  validateAdapterOperationProxy(proxy);
  return proxy;
}
