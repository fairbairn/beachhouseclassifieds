import "@/core/tooling/env/load-env-profile";

import { pgDb } from "@/core/server/db";
import { listing } from "@/lib/db/schema-postgres";
import {
  getDiscoverCorpusMetadata,
  getDiscoverListings,
} from "@/lib/discover/discover-listings-data-layer.server";
import chalk from "chalk";
import { and, inArray, isNotNull } from "drizzle-orm";
import { performance } from "node:perf_hooks";

type CliOptions = {
  ssrLimit: number;
  fetchLimit: number;
  repeats: number;
  json: boolean;
  progress: boolean;
};

type RunMetrics = {
  metadataMs: number;
  ssrMs: number;
  fetchMs: number;
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

  return { ssrLimit, fetchLimit, repeats, json, progress };
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

function buildTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) => {
    const cellWidths = rows.map((row) => (row[index] ?? "").length);
    return Math.max(header.length, ...cellWidths);
  });

  const divider =
    "+" + widths.map((width) => "-".repeat(width + 2)).join("+") + "+";

  const renderRow = (cells: string[]) =>
    "|" +
    cells
      .map((cell, index) => ` ${(cell ?? "").padEnd(widths[index] ?? 0)} `)
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
}): Promise<RunMetrics> {
  const startedAt = performance.now();

  const metadataStage = await timeStage(async () =>
    getDiscoverCorpusMetadata(),
  );
  const ssrStage = await timeStage(async () =>
    getDiscoverListings({ maxListings: input.ssrLimit }),
  );

  const lastSsr = ssrStage.value[ssrStage.value.length - 1];
  const fetchStage = await timeStage(async () => {
    if (!lastSsr) {
      return [];
    }
    return getDiscoverListings({
      maxListings: input.fetchLimit,
      afterCursor: {
        demoOrder: lastSsr.demoOrder,
        id: lastSsr.id,
      },
    });
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
    });
    runs.push(run);
  }

  const summary = {
    repeats: options.repeats,
    ssrLimit: options.ssrLimit,
    fetchLimit: options.fetchLimit,
    avgMetadataMs: average(runs.map((run) => run.metadataMs)),
    avgSsrMs: average(runs.map((run) => run.ssrMs)),
    avgFetchMs: average(runs.map((run) => run.fetchMs)),
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
    process.stdout.write(`${JSON.stringify({ runs, summary }, null, 2)}\n`);
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
      formatMs(run.metadataMs),
      formatMs(run.ssrMs),
      formatMs(run.fetchMs),
      formatMs(run.visibilityAuditMs),
      formatMs(run.totalMs),
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
      ["Average Metadata", formatMs(summary.avgMetadataMs)],
      ["Average SSR", formatMs(summary.avgSsrMs)],
      ["Average Fetch", formatMs(summary.avgFetchMs)],
      ["Average Audit", formatMs(summary.avgVisibilityAuditMs)],
      ["Average Total", formatMs(summary.avgTotalMs)],
      ["Last Total Count", String(summary.lastTotalCount)],
      ["Last SSR Count", String(summary.lastSsrCount)],
      ["Last Fetch Count", String(summary.lastFetchCount)],
      ["Max Non-Visible Returned", String(summary.maxNonVisibleReturned)],
    ];

    process.stdout.write("\n" + chalk.bold("run_metrics") + "\n");
    process.stdout.write(`${buildTable(runHeaders, runRows)}\n`);
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
