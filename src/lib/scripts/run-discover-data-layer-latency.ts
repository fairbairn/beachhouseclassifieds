import "@/core/tooling/env/load-env-profile";

import { pgDb } from "@/core/server/db";
import { listing } from "@/lib/db/schema-postgres";
import {
  getDiscoverCorpusMetadata,
  getDiscoverListings,
} from "@/lib/discover/discover-listings-data-layer.server";
import {
  sortDiscoverListings,
  type DiscoverSortValue,
} from "@/lib/discover/discover-page-derived";
import chalk from "chalk";
import { and, inArray, isNotNull } from "drizzle-orm";
import { performance } from "node:perf_hooks";

type CliOptions = {
  ssrLimit: number;
  fetchLimit: number;
  sortLimit: number;
  sortNights: number;
  repeats: number;
  json: boolean;
  progress: boolean;
};

type SortBenchmarkMode = {
  value: DiscoverSortValue;
  label: string;
};

type SortBenchmarkRow = {
  mode: DiscoverSortValue;
  label: string;
  ms: number;
  count: number;
};

type RunMetrics = {
  metadataMs: number;
  ssrMs: number;
  fetchMs: number;
  sortFetch96Ms: number;
  sortBenchmarks: SortBenchmarkRow[];
  visibilityAuditMs: number;
  totalMs: number;
  totalCount: number;
  ssrCount: number;
  fetchCount: number;
  nonVisibleReturnedCount: number;
};

function parseArgs(argv: string[]): CliOptions {
  let ssrLimit = 12;
  let fetchLimit = 84;
  let sortLimit = 96;
  let sortNights = 3;
  let repeats = 1;
  let json = false;
  let progress = true;

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        [
          "discover_data_layer_latency",
          "  --ssr-limit <n>      default: 12",
          "  --fetch-limit <n>    default: 84",
          "  --sort-limit <n>     default: 96",
          "  --sort-nights <n>    default: 3",
          "  --repeats <n>        default: 1",
          "  --json               output json payload",
          "  --no-progress        disable per-run progress lines",
        ].join("\n") + "\n",
      );
      process.exit(0);
    }
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--ssr-limit" && next) {
      const value = Number(next);
      if (Number.isFinite(value) && value > 0) {
        ssrLimit = Math.floor(value);
      }
      i += 1;
      continue;
    }

    if (arg === "--fetch-limit" && next) {
      const value = Number(next);
      if (Number.isFinite(value) && value > 0) {
        fetchLimit = Math.floor(value);
      }
      i += 1;
      continue;
    }

    if (arg === "--repeats" && next) {
      const value = Number(next);
      if (Number.isFinite(value) && value > 0) {
        repeats = Math.floor(value);
      }
      i += 1;
      continue;
    }

    if (arg === "--sort-limit" && next) {
      const value = Number(next);
      if (Number.isFinite(value) && value > 0) {
        sortLimit = Math.floor(value);
      }
      i += 1;
      continue;
    }

    if (arg === "--sort-nights" && next) {
      const value = Number(next);
      if (Number.isFinite(value) && value > 0) {
        sortNights = Math.floor(value);
      }
      i += 1;
      continue;
    }

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--no-progress") {
      progress = false;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return {
    ssrLimit,
    fetchLimit,
    sortLimit,
    sortNights,
    repeats,
    json,
    progress,
  };
}

async function timeStage<T>(
  fn: () => Promise<T>,
): Promise<{ ms: number; value: T }> {
  const start = performance.now();
  const value = await fn();
  return { ms: performance.now() - start, value };
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatMs(value: number): string {
  return `${value.toFixed(1)}ms`;
}

function stripAnsi(value: string): string {
  let out = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 27 && value[index + 1] === "[") {
      index += 2;
      while (index < value.length && value[index] !== "m") {
        index += 1;
      }
      continue;
    }
    out += value[index];
  }
  return out;
}

function colorizeDuration(
  value: number,
  warnMs: number,
  failMs: number,
): string {
  const formatted = formatMs(value);
  if (value >= failMs) {
    return chalk.red(formatted);
  }
  if (value >= warnMs) {
    return chalk.yellow(formatted);
  }
  return chalk.green(formatted);
}

function buildTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) => {
    const headerWidth = stripAnsi(header).length;
    const cellWidths = rows.map((row) => stripAnsi(row[index] ?? "").length);
    return Math.max(headerWidth, ...cellWidths);
  });

  const divider =
    "+" + widths.map((width) => "-".repeat(width + 2)).join("+") + "+";

  const renderRow = (cells: string[]) =>
    "|" +
    cells
      .map((cell, index) => {
        const rawCell = cell ?? "";
        const visible = stripAnsi(rawCell).length;
        const width = widths[index] ?? 0;
        const padding = Math.max(0, width - visible);
        return ` ${rawCell}${" ".repeat(padding)} `;
      })
      .join("|") +
    "|";

  const output = [divider, renderRow(headers), divider];
  for (const row of rows) {
    output.push(renderRow(row));
  }
  output.push(divider);
  return output.join("\n");
}

async function countReturnedNonVisible(slugs: string[]): Promise<number> {
  if (!pgDb || slugs.length === 0) {
    return 0;
  }

  const uniqueSlugs = Array.from(new Set(slugs));
  const rows = await pgDb
    .select({ slug: listing.slug })
    .from(listing)
    .where(
      and(
        inArray(listing.slug, uniqueSlugs),
        isNotNull(listing.visibility_disabled_reason),
      ),
    );

  return rows.length;
}

async function runOne(input: {
  ssrLimit: number;
  fetchLimit: number;
  sortLimit: number;
  sortNights: number;
}): Promise<RunMetrics> {
  const startedAt = performance.now();

  const sortModes: SortBenchmarkMode[] = [
    { value: "price-low", label: "Price Low->High" },
    { value: "price-high", label: "Price High->Low" },
    { value: "sleeps-high", label: "Sleeps High->Low" },
    { value: "beach-pool-first", label: "Beachfront+Pool" },
  ];

  const metadataStage = await timeStage(async () =>
    getDiscoverCorpusMetadata(),
  );
  const ssrStage = await timeStage(async () =>
    getDiscoverListings({ maxListings: input.ssrLimit }),
  );

  const fetchStage = await timeStage(async () => {
    if (ssrStage.value.length === 0) {
      return [];
    }

    return getDiscoverListings({
      maxListings: input.fetchLimit,
      offset: input.ssrLimit,
    });
  });

  const sortFetchStage = await timeStage(async () =>
    getDiscoverListings({ maxListings: input.sortLimit }),
  );

  const sortBenchmarks: SortBenchmarkRow[] = sortModes.map((mode) => {
    const started = performance.now();
    const sorted = sortDiscoverListings({
      listings: sortFetchStage.value,
      sortOption: mode.value,
      nights: input.sortNights,
    });
    return {
      mode: mode.value,
      label: mode.label,
      ms: performance.now() - started,
      count: sorted.length,
    };
  });

  const returnedSlugs = [
    ...ssrStage.value.map((row) => row.id),
    ...fetchStage.value.map((row) => row.id),
  ];

  const visibilityAuditStage = await timeStage(async () =>
    countReturnedNonVisible(returnedSlugs),
  );

  return {
    metadataMs: metadataStage.ms,
    ssrMs: ssrStage.ms,
    fetchMs: fetchStage.ms,
    sortFetch96Ms: sortFetchStage.ms,
    sortBenchmarks,
    visibilityAuditMs: visibilityAuditStage.ms,
    totalMs: performance.now() - startedAt,
    totalCount: metadataStage.value?.totalCount ?? 0,
    ssrCount: ssrStage.value.length,
    fetchCount: fetchStage.value.length,
    nonVisibleReturnedCount: visibilityAuditStage.value,
  };
}

async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const options = parseArgs(argv);

  if (!options.json) {
    process.stdout.write(
      chalk.cyan(
        [
          "discover_data_layer_latency",
          `ssr_limit=${options.ssrLimit}`,
          `fetch_limit=${options.fetchLimit}`,
          `sort_limit=${options.sortLimit}`,
          `sort_nights=${options.sortNights}`,
          `repeats=${options.repeats}`,
        ].join(" "),
      ) + "\n",
    );
  }

  const runs: RunMetrics[] = [];
  for (let runIndex = 0; runIndex < options.repeats; runIndex += 1) {
    const runNumber = runIndex + 1;
    if (!options.json && options.progress) {
      process.stdout.write(
        chalk.dim(`running iteration ${runNumber}/${options.repeats}...`) +
          "\n",
      );
    }

    const run = await runOne({
      ssrLimit: options.ssrLimit,
      fetchLimit: options.fetchLimit,
      sortLimit: options.sortLimit,
      sortNights: options.sortNights,
    });
    runs.push(run);
  }

  const sortModes: SortBenchmarkMode[] = [
    { value: "price-low", label: "Price Low->High" },
    { value: "price-high", label: "Price High->Low" },
    { value: "sleeps-high", label: "Sleeps High->Low" },
    { value: "beach-pool-first", label: "Beachfront+Pool" },
  ];

  const sortSummary = sortModes.map((mode) => {
    const durations = runs
      .map((run) =>
        run.sortBenchmarks.find((entry) => entry.mode === mode.value),
      )
      .filter((entry): entry is SortBenchmarkRow => Boolean(entry))
      .map((entry) => entry.ms);

    return {
      mode: mode.value,
      label: mode.label,
      avgMs: average(durations),
      minMs: durations.length > 0 ? Math.min(...durations) : 0,
      maxMs: durations.length > 0 ? Math.max(...durations) : 0,
      count:
        runs[runs.length - 1]?.sortBenchmarks.find(
          (entry) => entry.mode === mode.value,
        )?.count ?? 0,
    };
  });

  const summary = {
    repeats: options.repeats,
    ssrLimit: options.ssrLimit,
    fetchLimit: options.fetchLimit,
    sortLimit: options.sortLimit,
    sortNights: options.sortNights,
    avgMetadataMs: average(runs.map((run) => run.metadataMs)),
    avgSsrMs: average(runs.map((run) => run.ssrMs)),
    avgFetchMs: average(runs.map((run) => run.fetchMs)),
    avgSortFetch96Ms: average(runs.map((run) => run.sortFetch96Ms)),
    avgVisibilityAuditMs: average(runs.map((run) => run.visibilityAuditMs)),
    avgTotalMs: average(runs.map((run) => run.totalMs)),
    lastTotalCount: runs[runs.length - 1]?.totalCount ?? 0,
    lastSsrCount: runs[runs.length - 1]?.ssrCount ?? 0,
    lastFetchCount: runs[runs.length - 1]?.fetchCount ?? 0,
    maxNonVisibleReturned: Math.max(
      0,
      ...runs.map((run) => run.nonVisibleReturnedCount),
    ),
  };

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({ runs, summary, sortSummary }, null, 2)}\n`,
    );
  } else {
    const status =
      summary.maxNonVisibleReturned > 0
        ? chalk.red("FAIL")
        : chalk.green("PASS");

    const runHeaders = [
      "Run",
      "Status",
      "Metadata",
      "SSR",
      "Fetch",
      "Sort Fetch 96",
      "Audit",
      "Total",
      "SSR Count",
      "Fetch Count",
      "Total Count",
      "Non-Visible",
    ];
    const runRows = runs.map((run, index) => [
      String(index + 1),
      run.nonVisibleReturnedCount === 0 ? "PASS" : "FAIL",
      colorizeDuration(run.metadataMs, 50, 100),
      colorizeDuration(run.ssrMs, 50, 100),
      colorizeDuration(run.fetchMs, 100, 250),
      colorizeDuration(run.sortFetch96Ms, 100, 250),
      colorizeDuration(run.visibilityAuditMs, 20, 50),
      colorizeDuration(run.totalMs, 250, 600),
      String(run.ssrCount),
      String(run.fetchCount),
      String(run.totalCount),
      String(run.nonVisibleReturnedCount),
    ]);

    const summaryHeaders = ["Metric", "Value"];
    const summaryRows = [
      ["Overall Status", summary.maxNonVisibleReturned > 0 ? "FAIL" : "PASS"],
      ["Repeats", String(summary.repeats)],
      ["SSR Limit", String(summary.ssrLimit)],
      ["Fetch Limit", String(summary.fetchLimit)],
      ["Sort Limit", String(summary.sortLimit)],
      ["Sort Nights", String(summary.sortNights)],
      ["Average Metadata", colorizeDuration(summary.avgMetadataMs, 50, 100)],
      ["Average SSR", colorizeDuration(summary.avgSsrMs, 50, 100)],
      ["Average Fetch", colorizeDuration(summary.avgFetchMs, 100, 250)],
      [
        "Average Sort Fetch 96",
        colorizeDuration(summary.avgSortFetch96Ms, 100, 250),
      ],
      ["Average Audit", colorizeDuration(summary.avgVisibilityAuditMs, 20, 50)],
      ["Average Total", colorizeDuration(summary.avgTotalMs, 250, 600)],
      ["Last Total Count", String(summary.lastTotalCount)],
      ["Last SSR Count", String(summary.lastSsrCount)],
      ["Last Fetch Count", String(summary.lastFetchCount)],
      ["Max Non-Visible Returned", String(summary.maxNonVisibleReturned)],
    ];

    const sortHeaders = ["Sort Mode", "Avg", "Min", "Max", "Rows"];
    const sortRows = sortSummary.map((row) => [
      row.label,
      colorizeDuration(row.avgMs, 2, 8),
      colorizeDuration(row.minMs, 2, 8),
      colorizeDuration(row.maxMs, 2, 8),
      String(row.count),
    ]);

    process.stdout.write("\n" + chalk.bold("run_metrics") + "\n");
    process.stdout.write(`${buildTable(runHeaders, runRows)}\n`);
    process.stdout.write("\n" + chalk.bold("sort_benchmark_full_96") + "\n");
    process.stdout.write(`${buildTable(sortHeaders, sortRows)}\n`);
    process.stdout.write("\n" + chalk.bold("summary") + "\n");
    process.stdout.write(`${buildTable(summaryHeaders, summaryRows)}\n`);
    process.stdout.write(`${status} discover_data_layer_latency\n`);
  }

  const invalidLimit = runs.some(
    (run) =>
      run.ssrCount > options.ssrLimit || run.fetchCount > options.fetchLimit,
  );
  const hasVisibilityViolation = summary.maxNonVisibleReturned > 0;

  if (invalidLimit || hasVisibilityViolation) {
    return 1;
  }

  return 0;
}

let exiting = false;
process.on("SIGINT", () => {
  if (exiting) {
    process.exit(130);
  }
  exiting = true;
  process.stderr.write("Operation cancelled by user.\n");
  process.exit(130);
});

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`discover data-layer latency failed: ${message}\n`);
    process.exit(1);
  });
