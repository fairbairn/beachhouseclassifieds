import "@/core/tooling/env/load-env-profile";

import {
  readOpsRunnerTrendLatest,
  readOpsSnapshotTrendLatest,
  readOpsSnapshotTrendSeries,
  runOpsOneShotPipeline,
} from "../workers/image-ops-control-module";

type CliArgs = {
  appName: string;
  seriesLimit: number;
};

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseArgs(argv: string[]): CliArgs {
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] || "";
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      options.set(key, "true");
      continue;
    }
    options.set(key, next);
    index += 1;
  }

  return {
    appName: options.get("app")?.trim() || "beachhouseclassifieds-image-worker",
    seriesLimit: parsePositiveInt(options.get("series-limit"), 20),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  process.env.IMAGE_OPS_REDIS_PIPELINE_TRACE = "1";

  process.stdout.write(
    `[trace] start app=${args.appName} series_limit=${args.seriesLimit}\n`,
  );

  const startedAtMs = Date.now();
  const oneShot = await runOpsOneShotPipeline({
    appName: args.appName,
    timeoutMs: 10_000,
    includeFly: false,
    includeTrendProjection: true,
    includeRecentJobs15m: true,
    includeRecentJobs24h: false,
    includePerformanceRollups: false,
    reconcileBullmqStatus: false,
  });
  process.stdout.write(
    `[trace] one-shot elapsed_ms=${Date.now() - startedAtMs} backlog=${oneShot.snapshot.queue?.backlog ?? 0}\n`,
  );

  const latestStartedAtMs = Date.now();
  const snapshotLatest = await readOpsSnapshotTrendLatest();
  const runnerLatest = await readOpsRunnerTrendLatest();
  process.stdout.write(
    `[trace] latest elapsed_ms=${Date.now() - latestStartedAtMs} snapshot_metrics=${Object.keys(snapshotLatest).length} runner_metrics=${Object.keys(runnerLatest).length}\n`,
  );

  const seriesStartedAtMs = Date.now();
  const series = await readOpsSnapshotTrendSeries({
    limit: args.seriesLimit,
    sampleMode: "raw",
  });
  process.stdout.write(
    `[trace] series elapsed_ms=${Date.now() - seriesStartedAtMs} metric_series=${Object.keys(series).length}\n`,
  );

  process.stdout.write("[trace] done\n");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[trace] failed: ${message}\n`);
  process.exit(1);
});
