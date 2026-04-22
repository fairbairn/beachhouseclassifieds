import "@/core/tooling/env/load-env-profile";

import chalk from "chalk";
import Table from "cli-table3";

import { createScrapeProgress } from "@/core/tooling/terminal/scrape-progress";
import {
  getDiscoverMeilisearchIndex,
  getDiscoverMeilisearchIndexName,
} from "@/lib/discover/meilisearch-client.server";
import type { SearchResponse } from "meilisearch";

type Scenario = "count" | "facets" | "listings";

type FeatureFilter = "gulf_front" | "private_pool" | "golf_cart";

type CliOptions = {
  scenarios: Scenario[];
  iterations: number;
  warmupIterations: number;
  query: string;
  limit: number;
  offset: number;
  sort: string[];
  facets: string[];
  areaCodes: string[];
  beachCodes: string[];
  communityCodes: string[];
  features: FeatureFilter[];
  rawFilters: string[];
  jsonOutput: boolean;
};

type RunSample = {
  elapsedMs: number;
  estimatedTotalHits: number | null;
  returnedHits: number | null;
  facetBuckets: number | null;
};

type RunSummary = {
  scenario: Scenario;
  iterations: number;
  warmups: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
  p50Ms: number;
  p90Ms: number;
  p95Ms: number;
  p99Ms: number;
  lastEstimatedTotalHits: number | null;
  lastReturnedHits: number | null;
  lastFacetBuckets: number | null;
};

const DEFAULT_SCENARIOS: Scenario[] = ["count", "facets", "listings"];
const DEFAULT_FACETS = [
  "area_name",
  "beach_area_name",
  "community_name",
  "gulf_front",
  "private_pool",
  "golf_cart",
];

function printUsage(): void {
  console.log("Benchmark Meilisearch discover index query performance");
  console.log("Usage:");
  console.log(
    "  tsx src/lib/scripts/run-discover-meilisearch-performance.ts [options]",
  );
  console.log("");
  console.log("Core options:");
  console.log(
    "  --scenario <count|facets|listings>   Repeatable. Default: all",
  );
  console.log("  --iterations <n>                      Default: 25");
  console.log("  --warmup <n>                          Default: 5");
  console.log("  --query <text>                        Default: empty");
  console.log("  --limit <n>                           Default: 24");
  console.log("  --offset <n>                          Default: 0");
  console.log("  --sort <field:asc|desc>               Repeatable");
  console.log("  --facet <attribute>                   Repeatable");
  console.log("  --json                                Emit JSON summary");
  console.log("");
  console.log("Filter options:");
  console.log("  --feature <gulf_front|private_pool|golf_cart>   Repeatable");
  console.log("  --area-code <code>                    Repeatable");
  console.log("  --beach-code <code>                   Repeatable");
  console.log("  --community-code <code>               Repeatable");
  console.log("  --filter <raw meilisearch filter>     Repeatable");
  console.log("");
  console.log("Examples:");
  console.log(
    "  npm run discover:search:perf:meilisearch -- --iterations 50 --warmup 10",
  );
  console.log(
    "  npm run discover:search:perf:meilisearch -- --scenario listings --query seaside --feature gulf_front --sort typicalAllInNightly:asc",
  );
}

function normalizeToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];

  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) {
      continue;
    }

    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    output.push(normalized);
  }

  return output;
}

function parseScenario(value: string): Scenario | null {
  const normalized = normalizeToken(value);
  if (normalized === "count") {
    return "count";
  }
  if (normalized === "facets") {
    return "facets";
  }
  if (normalized === "listings" || normalized === "results") {
    return "listings";
  }
  return null;
}

function parseFeature(value: string): FeatureFilter | null {
  const normalized = normalizeToken(value);
  if (normalized === "gulf_front" || normalized === "gulffront") {
    return "gulf_front";
  }
  if (normalized === "private_pool" || normalized === "privatepool") {
    return "private_pool";
  }
  if (normalized === "golf_cart" || normalized === "golfcart") {
    return "golf_cart";
  }
  return null;
}

function parsePositiveInt(value: string, flagName: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
    throw new Error(`${flagName} must be a non-negative integer.`);
  }
  return parsed;
}

function parseArgs(argv: string[]): CliOptions {
  const scenarios: Scenario[] = [];
  const sort: string[] = [];
  const facets: string[] = [];
  const areaCodes: string[] = [];
  const beachCodes: string[] = [];
  const communityCodes: string[] = [];
  const features: FeatureFilter[] = [];
  const rawFilters: string[] = [];

  let iterations = 25;
  let warmupIterations = 5;
  let query = "";
  let limit = 24;
  let offset = 0;
  let jsonOutput = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }

    if ((arg === "--scenario" || arg === "-s") && next) {
      const parsed = parseScenario(next);
      if (!parsed) {
        throw new Error(`Unsupported scenario: ${next}`);
      }
      scenarios.push(parsed);
      index += 1;
      continue;
    }

    if (arg === "--iterations" && next) {
      iterations = parsePositiveInt(next, "--iterations");
      if (iterations < 1) {
        throw new Error("--iterations must be at least 1.");
      }
      index += 1;
      continue;
    }

    if (arg === "--warmup" && next) {
      warmupIterations = parsePositiveInt(next, "--warmup");
      index += 1;
      continue;
    }

    if (arg === "--query" && next) {
      query = next;
      index += 1;
      continue;
    }

    if (arg === "--limit" && next) {
      limit = parsePositiveInt(next, "--limit");
      index += 1;
      continue;
    }

    if (arg === "--offset" && next) {
      offset = parsePositiveInt(next, "--offset");
      index += 1;
      continue;
    }

    if (arg === "--sort" && next) {
      sort.push(next.trim());
      index += 1;
      continue;
    }

    if (arg === "--facet" && next) {
      facets.push(next.trim());
      index += 1;
      continue;
    }

    if (arg === "--area-code" && next) {
      areaCodes.push(next.trim());
      index += 1;
      continue;
    }

    if (arg === "--beach-code" && next) {
      beachCodes.push(next.trim());
      index += 1;
      continue;
    }

    if (arg === "--community-code" && next) {
      communityCodes.push(next.trim());
      index += 1;
      continue;
    }

    if (arg === "--feature" && next) {
      const parsed = parseFeature(next);
      if (!parsed) {
        throw new Error(`Unsupported feature: ${next}`);
      }
      features.push(parsed);
      index += 1;
      continue;
    }

    if (arg === "--filter" && next) {
      rawFilters.push(next.trim());
      index += 1;
      continue;
    }

    if (arg === "--json") {
      jsonOutput = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    scenarios:
      scenarios.length > 0
        ? (unique(scenarios) as Scenario[])
        : DEFAULT_SCENARIOS,
    iterations,
    warmupIterations,
    query,
    limit,
    offset,
    sort: unique(sort),
    facets: unique(facets.length > 0 ? facets : DEFAULT_FACETS),
    areaCodes: unique(areaCodes),
    beachCodes: unique(beachCodes),
    communityCodes: unique(communityCodes),
    features: unique(features) as FeatureFilter[],
    rawFilters: unique(rawFilters),
    jsonOutput,
  };
}

function quoteFilterValue(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function buildFilterClauses(options: CliOptions): string[] {
  const clauses: string[] = [];

  if (options.areaCodes.length > 0) {
    const terms = options.areaCodes.map(
      (value) => `area_name = ${quoteFilterValue(value)}`,
    );
    clauses.push(terms.length === 1 ? terms[0] : `(${terms.join(" OR ")})`);
  }

  if (options.beachCodes.length > 0) {
    const terms = options.beachCodes.map(
      (value) => `beach_area_name = ${quoteFilterValue(value)}`,
    );
    clauses.push(terms.length === 1 ? terms[0] : `(${terms.join(" OR ")})`);
  }

  if (options.communityCodes.length > 0) {
    const terms = options.communityCodes.map(
      (value) => `community_name = ${quoteFilterValue(value)}`,
    );
    clauses.push(terms.length === 1 ? terms[0] : `(${terms.join(" OR ")})`);
  }

  for (const feature of options.features) {
    if (feature === "gulf_front") {
      clauses.push("gulf_front = true");
      continue;
    }
    if (feature === "private_pool") {
      clauses.push("private_pool = true");
      continue;
    }
    clauses.push("golf_cart = true");
  }

  clauses.push(...options.rawFilters);

  return clauses;
}

function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }

  if (sortedValues.length === 1) {
    return sortedValues[0] ?? 0;
  }

  const clamped = Math.min(1, Math.max(0, p));
  const position = (sortedValues.length - 1) * clamped;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);

  if (lower === upper) {
    return sortedValues[lower] ?? 0;
  }

  const lowerValue = sortedValues[lower] ?? 0;
  const upperValue = sortedValues[upper] ?? 0;
  const weight = position - lower;

  return lowerValue + (upperValue - lowerValue) * weight;
}

function toMs(startNs: bigint, endNs: bigint): number {
  return Number(endNs - startNs) / 1_000_000;
}

function sum(values: number[]): number {
  return values.reduce((acc, value) => acc + value, 0);
}

function colorizeLatency(ms: number): string {
  const text = `${ms.toFixed(2)} ms`;
  if (ms < 50) {
    return chalk.green(text);
  }
  if (ms < 150) {
    return chalk.yellow(text);
  }
  return chalk.red(text);
}

function renderSummaryTable(summaries: RunSummary[]): void {
  const table = new Table({
    head: [
      "scenario",
      "iter",
      "min",
      "p50",
      "p90",
      "p95",
      "p99",
      "max",
      "mean",
      "hits",
      "facet_buckets",
    ],
    style: {
      head: ["cyan"],
      border: ["gray"],
    },
  });

  for (const summary of summaries) {
    table.push([
      chalk.cyan(summary.scenario),
      String(summary.iterations),
      colorizeLatency(summary.minMs),
      colorizeLatency(summary.p50Ms),
      colorizeLatency(summary.p90Ms),
      colorizeLatency(summary.p95Ms),
      colorizeLatency(summary.p99Ms),
      colorizeLatency(summary.maxMs),
      colorizeLatency(summary.meanMs),
      summary.lastEstimatedTotalHits === null
        ? "-"
        : String(summary.lastEstimatedTotalHits),
      summary.lastFacetBuckets === null
        ? "-"
        : String(summary.lastFacetBuckets),
    ]);
  }

  console.log(table.toString());
}

function summarizeScenario(
  scenario: Scenario,
  options: CliOptions,
  samples: RunSample[],
): RunSummary {
  const durations = samples
    .map((sample) => sample.elapsedMs)
    .sort((a, b) => a - b);

  return {
    scenario,
    iterations: options.iterations,
    warmups: options.warmupIterations,
    minMs: durations[0] ?? 0,
    maxMs: durations[durations.length - 1] ?? 0,
    meanMs: durations.length > 0 ? sum(durations) / durations.length : 0,
    p50Ms: percentile(durations, 0.5),
    p90Ms: percentile(durations, 0.9),
    p95Ms: percentile(durations, 0.95),
    p99Ms: percentile(durations, 0.99),
    lastEstimatedTotalHits:
      samples.length > 0
        ? (samples[samples.length - 1]?.estimatedTotalHits ?? null)
        : null,
    lastReturnedHits:
      samples.length > 0
        ? (samples[samples.length - 1]?.returnedHits ?? null)
        : null,
    lastFacetBuckets:
      samples.length > 0
        ? (samples[samples.length - 1]?.facetBuckets ?? null)
        : null,
  };
}

function getFacetBucketCount(
  response: SearchResponse<Record<string, unknown>>,
): number {
  const distribution = response.facetDistribution;
  if (!distribution || typeof distribution !== "object") {
    return 0;
  }

  let total = 0;
  for (const value of Object.values(distribution)) {
    if (!value || typeof value !== "object") {
      continue;
    }
    total += Object.keys(value as Record<string, unknown>).length;
  }

  return total;
}

async function runScenario(
  scenario: Scenario,
  options: CliOptions,
  filterClauses: string[],
): Promise<RunSample[]> {
  const index = getDiscoverMeilisearchIndex();
  const totalRuns = options.warmupIterations + options.iterations;
  const samples: RunSample[] = [];

  for (let runIndex = 0; runIndex < totalRuns; runIndex += 1) {
    const startNs = process.hrtime.bigint();

    if (scenario === "count") {
      const response = await index.search<Record<string, unknown>>(
        options.query,
        {
          filter: filterClauses.length > 0 ? filterClauses : undefined,
          offset: 0,
          limit: 0,
        },
      );

      const elapsedMs = toMs(startNs, process.hrtime.bigint());
      if (runIndex >= options.warmupIterations) {
        samples.push({
          elapsedMs,
          estimatedTotalHits: response.estimatedTotalHits ?? null,
          returnedHits: Array.isArray(response.hits)
            ? response.hits.length
            : null,
          facetBuckets: null,
        });
      }
      continue;
    }

    if (scenario === "facets") {
      const response = await index.search<Record<string, unknown>>(
        options.query,
        {
          filter: filterClauses.length > 0 ? filterClauses : undefined,
          offset: 0,
          limit: 0,
          facets: options.facets,
        },
      );

      const elapsedMs = toMs(startNs, process.hrtime.bigint());
      if (runIndex >= options.warmupIterations) {
        samples.push({
          elapsedMs,
          estimatedTotalHits: response.estimatedTotalHits ?? null,
          returnedHits: Array.isArray(response.hits)
            ? response.hits.length
            : null,
          facetBuckets: getFacetBucketCount(response),
        });
      }
      continue;
    }

    const response = await index.search<Record<string, unknown>>(
      options.query,
      {
        filter: filterClauses.length > 0 ? filterClauses : undefined,
        offset: options.offset,
        limit: options.limit,
        sort: options.sort.length > 0 ? options.sort : undefined,
      },
    );

    const elapsedMs = toMs(startNs, process.hrtime.bigint());
    if (runIndex >= options.warmupIterations) {
      samples.push({
        elapsedMs,
        estimatedTotalHits: response.estimatedTotalHits ?? null,
        returnedHits: Array.isArray(response.hits)
          ? response.hits.length
          : null,
        facetBuckets: null,
      });
    }
  }

  return samples;
}

async function run(argv: string[] = process.argv.slice(2)): Promise<number> {
  const options = parseArgs(argv);
  const progress = createScrapeProgress({ script: "discover-meili-perf" });
  const filterClauses = buildFilterClauses(options);

  progress.phase(
    `start index=${getDiscoverMeilisearchIndexName()} scenarios=${options.scenarios.join(",")} iterations=${options.iterations} warmup=${options.warmupIterations}`,
  );
  progress.info(
    `query='${options.query}' limit=${options.limit} offset=${options.offset}`,
  );
  progress.info(
    `filters=${filterClauses.length > 0 ? filterClauses.join(" AND ") : "none"}`,
  );

  const summaries: RunSummary[] = [];

  for (let index = 0; index < options.scenarios.length; index += 1) {
    const scenario = options.scenarios[index] ?? "count";
    progress.phase(
      `scenario=${scenario} (${index + 1}/${options.scenarios.length})`,
    );

    const startedAt = Date.now();
    const samples = await runScenario(scenario, options, filterClauses);
    const elapsedSec = Math.max(0.001, (Date.now() - startedAt) / 1000);

    const summary = summarizeScenario(scenario, options, samples);
    summaries.push(summary);

    progress.success(
      `scenario=${scenario} complete runs=${samples.length} qps=${(samples.length / elapsedSec).toFixed(2)} p95=${summary.p95Ms.toFixed(2)}ms`,
    );
  }

  console.log("");
  console.log(chalk.bold.cyan("Discover Meilisearch Performance Summary"));
  renderSummaryTable(summaries);

  if (options.jsonOutput) {
    console.log("");
    console.log(
      JSON.stringify(
        {
          meilisearchPerformance: {
            index: getDiscoverMeilisearchIndexName(),
            options: {
              scenarios: options.scenarios,
              iterations: options.iterations,
              warmupIterations: options.warmupIterations,
              query: options.query,
              limit: options.limit,
              offset: options.offset,
              sort: options.sort,
              facets: options.facets,
              filters: filterClauses,
            },
            summaries,
          },
        },
        null,
        2,
      ),
    );
  }

  return 0;
}

let shuttingDown = false;
process.on("SIGINT", () => {
  if (shuttingDown) {
    process.exit(130);
  }
  shuttingDown = true;
  process.stderr.write("Operation cancelled by user.\n");
  process.exit(130);
});

run()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `discover meilisearch performance failed: ${message}\n`,
    );
    process.exit(1);
  });
