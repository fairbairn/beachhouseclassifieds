import {
  createValidatedAdapterOperationProxyByKey,
  getKnownAdapterKeys,
} from "@/lib/pricing/scraper-engine/adapter-registry";

type CliOptions = {
  adapters: string[] | "all";
  weeks: number;
  nights: number;
  maxListings: number;
  listingId: string | null;
  quoteConcurrency: number;
  listingConcurrency: number;
  repeats: number;
  continueOnError: boolean;
};

type AdapterBenchmarkResult = {
  adapterKey: string;
  status: "ok" | "skipped" | "failed";
  reason: string | null;
  expectedListings: number;
  expectedObservationsPerListing: number;
  expectedObservationsTotal: number;
  runDurationsMs: number[];
  meanRunMs: number | null;
  avgListingMs: number | null;
  avgObservationMs: number | null;
};

function parseAdapters(raw: string): string[] | "all" {
  const normalized = raw.trim().toLowerCase();
  if (!normalized || normalized === "all") {
    return "all";
  }

  return normalized
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseArgs(argv: string[]): CliOptions {
  let adapters: string[] | "all" = "all";
  let weeks = 24;
  let nights = 7;
  let maxListings = 1;
  let listingId: string | null = null;
  let quoteConcurrency = 2;
  let listingConcurrency = 1;
  let repeats = 1;
  let continueOnError = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    if (arg === "--adapters" && value) {
      adapters = parseAdapters(value);
      index += 1;
      continue;
    }

    if (arg.startsWith("--adapters=")) {
      adapters = parseAdapters(arg.slice("--adapters=".length));
      continue;
    }

    if (arg === "--weeks" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0 && parsed <= 52) {
        weeks = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--nights" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0 && parsed <= 30) {
        nights = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--max-listings" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        maxListings = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--listing-id" && value) {
      listingId = value.trim();
      index += 1;
      continue;
    }

    if (arg === "--quote-concurrency" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        quoteConcurrency = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--listing-concurrency" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        listingConcurrency = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--repeats" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0 && parsed <= 20) {
        repeats = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--continue-on-error") {
      continueOnError = true;
      continue;
    }
  }

  return {
    adapters,
    weeks,
    nights,
    maxListings,
    listingId,
    quoteConcurrency,
    listingConcurrency,
    repeats,
    continueOnError,
  };
}

function formatMs(value: number | null): string {
  if (value === null) {
    return "n/a";
  }
  return value.toFixed(1);
}

function mean(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, item) => sum + item, 0) / values.length;
}

function resolveSelectedAdapters(adapters: string[] | "all"): string[] {
  const known = getKnownAdapterKeys();
  if (adapters === "all") {
    return known;
  }

  const unknown = adapters.filter((adapter) => !known.includes(adapter));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown adapter(s): ${unknown.join(", ")}. Known adapters: ${known.join(", ")}`,
    );
  }

  return adapters;
}

async function runBenchmarkForAdapter(
  adapterKey: string,
  options: CliOptions,
): Promise<AdapterBenchmarkResult> {
  const proxy = createValidatedAdapterOperationProxyByKey(adapterKey);
  if (!proxy) {
    return {
      adapterKey,
      status: "failed",
      reason: "unknown adapter",
      expectedListings: 0,
      expectedObservationsPerListing: 0,
      expectedObservationsTotal: 0,
      runDurationsMs: [],
      meanRunMs: null,
      avgListingMs: null,
      avgObservationMs: null,
    };
  }

  if (!proxy.capabilities.quoteCapture) {
    return {
      adapterKey,
      status: "skipped",
      reason: "adapter is not quote-capable",
      expectedListings: 0,
      expectedObservationsPerListing: 0,
      expectedObservationsTotal: 0,
      runDurationsMs: [],
      meanRunMs: null,
      avgListingMs: null,
      avgObservationMs: null,
    };
  }

  const expectedListings = options.listingId ? 1 : options.maxListings;
  const expectedObservationsPerListing = Math.max(
    1,
    Math.floor((options.weeks * 7) / options.nights),
  );
  const expectedObservationsTotal =
    expectedListings * expectedObservationsPerListing;

  const runArgs: string[] = [
    "--weeks",
    String(options.weeks),
    "--nights",
    String(options.nights),
    "--quote-concurrency",
    String(options.quoteConcurrency),
    "--listing-concurrency",
    String(options.listingConcurrency),
  ];

  if (options.listingId) {
    runArgs.push("--listing-id", options.listingId);
  } else {
    runArgs.push("--max-listings", String(options.maxListings));
  }

  const runDurationsMs: number[] = [];

  try {
    for (let runIndex = 0; runIndex < options.repeats; runIndex += 1) {
      const startedAtMs = Date.now();
      await proxy.runQuoteCapture(runArgs);
      const elapsedMs = Date.now() - startedAtMs;
      runDurationsMs.push(elapsedMs);
    }
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      adapterKey,
      status: "failed",
      reason,
      expectedListings,
      expectedObservationsPerListing,
      expectedObservationsTotal,
      runDurationsMs,
      meanRunMs: mean(runDurationsMs),
      avgListingMs:
        runDurationsMs.length > 0
          ? mean(runDurationsMs)! / Math.max(expectedListings, 1)
          : null,
      avgObservationMs:
        runDurationsMs.length > 0
          ? mean(runDurationsMs)! / Math.max(expectedObservationsTotal, 1)
          : null,
    };
  }

  const meanRunMs = mean(runDurationsMs);

  return {
    adapterKey,
    status: "ok",
    reason: null,
    expectedListings,
    expectedObservationsPerListing,
    expectedObservationsTotal,
    runDurationsMs,
    meanRunMs,
    avgListingMs:
      meanRunMs !== null ? meanRunMs / Math.max(expectedListings, 1) : null,
    avgObservationMs:
      meanRunMs !== null
        ? meanRunMs / Math.max(expectedObservationsTotal, 1)
        : null,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const selectedAdapters = resolveSelectedAdapters(options.adapters);

  const results: AdapterBenchmarkResult[] = [];
  const failures: AdapterBenchmarkResult[] = [];

  console.log(
    [
      "quote latency benchmark starting",
      `adapters=${selectedAdapters.join(",")}`,
      `weeks=${options.weeks}`,
      `nights=${options.nights}`,
      `max_listings=${options.maxListings}`,
      `listing_id=${options.listingId ?? "n/a"}`,
      `quote_concurrency=${options.quoteConcurrency}`,
      `listing_concurrency=${options.listingConcurrency}`,
      `repeats=${options.repeats}`,
    ].join(" "),
  );

  for (const adapterKey of selectedAdapters) {
    const result = await runBenchmarkForAdapter(adapterKey, options);
    results.push(result);

    if (result.status === "failed") {
      failures.push(result);
      console.log(
        `latency adapter=${adapterKey} status=failed reason=${result.reason ?? "unknown"}`,
      );
      if (!options.continueOnError) {
        break;
      }
      continue;
    }

    if (result.status === "skipped") {
      console.log(
        `latency adapter=${adapterKey} status=skipped reason=${result.reason ?? "n/a"}`,
      );
      continue;
    }

    console.log(
      [
        `latency adapter=${adapterKey}`,
        "status=ok",
        `mean_run_ms=${formatMs(result.meanRunMs)}`,
        `avg_listing_ms=${formatMs(result.avgListingMs)}`,
        `avg_quote_ms=${formatMs(result.avgObservationMs)}`,
        `quotes_per_listing=${result.expectedObservationsPerListing}`,
        `listings=${result.expectedListings}`,
        `repeats=${options.repeats}`,
      ].join(" "),
    );
  }

  const okResults = results.filter((result) => result.status === "ok");
  const overallAvgQuoteMs = mean(
    okResults
      .map((result) => result.avgObservationMs)
      .filter((value): value is number => value !== null),
  );

  console.log("quote latency benchmark complete");
  console.log(`- adapters_total: ${results.length}`);
  console.log(`- adapters_ok: ${okResults.length}`);
  console.log(`- adapters_failed: ${failures.length}`);
  console.log(
    `- overall_avg_quote_ms: ${overallAvgQuoteMs === null ? "n/a" : overallAvgQuoteMs.toFixed(1)}`,
  );

  if (failures.length > 0) {
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Quote latency benchmark failed: ${message}`);
  process.exit(1);
});
