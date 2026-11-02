import "@/core/tooling/env/load-env-profile";

import {
  createScrapeProgress,
  formatModeProgressLine,
} from "@/core/tooling/terminal/scrape-progress";
import { runs, tasks } from "@trigger.dev/sdk";
import { config as loadDotenv } from "dotenv";

loadDotenv({ path: ".env.local" });
loadDotenv();

type CliOptions = {
  taskId: string;
  runCount: number;
  steps: number;
  sleepSeconds: number;
  labelPrefix: string;
};

type RunState = {
  status: string;
  current: number;
  total: number;
  percentage: number;
};

type TriggerHandle = {
  id: string;
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    taskId: "progress-probe-task",
    runCount: 20,
    steps: 8,
    sleepSeconds: 2,
    labelPrefix: "probe",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--task-id" && next) {
      options.taskId = next.trim();
      index += 1;
      continue;
    }

    if (arg === "--run-count" && next) {
      options.runCount = Math.max(1, Number.parseInt(next, 10) || options.runCount);
      index += 1;
      continue;
    }

    if (arg === "--steps" && next) {
      options.steps = Math.max(1, Number.parseInt(next, 10) || options.steps);
      index += 1;
      continue;
    }

    if (arg === "--sleep-seconds" && next) {
      options.sleepSeconds = Math.max(
        1,
        Number.parseInt(next, 10) || options.sleepSeconds,
      );
      index += 1;
      continue;
    }

    if (arg === "--label-prefix" && next) {
      options.labelPrefix = next.trim() || options.labelPrefix;
      index += 1;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      console.log("Trigger Progress Probe Runner");
      console.log("Usage:");
      console.log(
        "  tsx src/lib/scripts/run-trigger-progress-probe.ts [--task-id progress-probe-task] [--run-count 20] [--steps 8] [--sleep-seconds 2] [--label-prefix probe]",
      );
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function summarizeRuns(stateByRunId: Map<string, RunState>): {
  activeRuns: number;
  completedRuns: number;
  failedRuns: number;
  canceledRuns: number;
  totalCurrent: number;
  totalExpected: number;
  percentage: number;
} {
  let activeRuns = 0;
  let completedRuns = 0;
  let failedRuns = 0;
  let canceledRuns = 0;
  let totalCurrent = 0;
  let totalExpected = 0;

  for (const state of stateByRunId.values()) {
    const status = state.status.toUpperCase();

    totalCurrent += Math.max(0, state.current);
    totalExpected += Math.max(0, state.total);

    if (status === "COMPLETED") {
      completedRuns += 1;
      continue;
    }

    if (status === "FAILED") {
      failedRuns += 1;
      continue;
    }

    if (status === "CANCELED") {
      canceledRuns += 1;
      continue;
    }

    activeRuns += 1;
  }

  const percentage = totalExpected > 0 ? (totalCurrent / totalExpected) * 100 : 0;

  return {
    activeRuns,
    completedRuns,
    failedRuns,
    canceledRuns,
    totalCurrent,
    totalExpected,
    percentage,
  };
}

function readProgressMetadata(run: unknown): {
  current: number;
  total: number;
  percentage: number;
} {
  if (!run || typeof run !== "object" || !("metadata" in run)) {
    return { current: 0, total: 0, percentage: 0 };
  }

  const metadataValue = (run as { metadata?: unknown }).metadata;
  if (!metadataValue || typeof metadataValue !== "object") {
    return { current: 0, total: 0, percentage: 0 };
  }

  const progressValue = (metadataValue as { progress?: unknown }).progress;
  if (!progressValue || typeof progressValue !== "object") {
    return { current: 0, total: 0, percentage: 0 };
  }

  const progress = progressValue as {
    current?: unknown;
    total?: unknown;
    percentage?: unknown;
  };

  const current =
    typeof progress.current === "number" && Number.isFinite(progress.current)
      ? Math.max(0, Math.floor(progress.current))
      : 0;

  const total =
    typeof progress.total === "number" && Number.isFinite(progress.total)
      ? Math.max(0, Math.floor(progress.total))
      : 0;

  const percentage =
    typeof progress.percentage === "number" && Number.isFinite(progress.percentage)
      ? Math.max(0, Math.min(100, progress.percentage))
      : total > 0
        ? (current / total) * 100
        : 0;

  return { current, total, percentage };
}

export async function runTriggerProgressProbeCli(
  argv: string[] = process.argv.slice(2),
): Promise<number> {
  const options = parseArgs(argv);
  const progress = createScrapeProgress({ script: "trigger-progress-probe" });
  const startedAtMs = Date.now();

  progress.phase("triggering probe runs via Trigger API");
  progress.info(
    `task_id=${options.taskId} run_count=${options.runCount} steps=${options.steps} sleep_seconds=${options.sleepSeconds}`,
  );

  const triggerPromises = Array.from({ length: options.runCount }, (_, runIndex) => {
    return tasks.trigger(options.taskId, {
      steps: options.steps,
      sleepSeconds: options.sleepSeconds,
      label: `${options.labelPrefix}-${String(runIndex + 1).padStart(3, "0")}`,
    });
  });

  const handles = (await Promise.all(triggerPromises)) as TriggerHandle[];
  const runIds = handles.map((handle) => handle.id);

  progress.info(`triggered_runs=${runIds.length}`);

  const stateByRunId = new Map<string, RunState>();
  let lastSummaryLine = "";
  for (const runId of runIds) {
    stateByRunId.set(runId, {
      status: "QUEUED",
      current: 0,
      total: options.steps,
      percentage: 0,
    });
  }

  const watcherPromises = runIds.map(async (runId) => {
    for await (const run of runs.subscribeToRun(runId)) {
      const status = String((run as { status?: string }).status ?? "UNKNOWN").toUpperCase();
      const p = readProgressMetadata(run);

      stateByRunId.set(runId, {
        status,
        current: p.current,
        total: p.total || options.steps,
        percentage: p.percentage,
      });

      const summary = summarizeRuns(stateByRunId);
      const nextSummaryLine = formatModeProgressLine({
        mode: "trigger_runs",
        completed: summary.totalCurrent,
        total: summary.totalExpected,
        startedAtMs,
        text:
          `runs active=${summary.activeRuns} completed=${summary.completedRuns} failed=${summary.failedRuns} canceled=${summary.canceledRuns} ` +
          `worker_progress=${summary.totalCurrent}/${summary.totalExpected}`,
      });

      if (nextSummaryLine !== lastSummaryLine) {
        lastSummaryLine = nextSummaryLine;
        progress.progress(nextSummaryLine);
      }
    }
  });

  await Promise.all(watcherPromises);

  const finalSummary = summarizeRuns(stateByRunId);
  progress.success(
    `probe_complete completed=${finalSummary.completedRuns} failed=${finalSummary.failedRuns} canceled=${finalSummary.canceledRuns} progress=${finalSummary.totalCurrent}/${finalSummary.totalExpected}`,
  );

  return finalSummary.failedRuns > 0 ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTriggerProgressProbeCli()
    .then((exitCode) => {
      process.exit(exitCode);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`run-trigger-progress-probe failed: ${message}`);
      process.exit(1);
    });
}
