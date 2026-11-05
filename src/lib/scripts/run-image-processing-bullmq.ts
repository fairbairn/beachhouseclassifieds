import "@/core/tooling/env/load-env-profile";

import chalk from "chalk";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";

import type {
  ImageProcessingItemResult,
  ImageProcessingTaskError,
} from "../../workers/image-processing-task";
import {
  configureRedisTarget,
  IMAGE_QUEUE_NAME,
  type ImageProcessingQueueJob,
  type RedisTarget,
} from "../../workers/image-queue";
import {
  applyFailureRows,
  applySuccessRows,
  claimPendingImageRows,
  createOpsDbPool,
  createOpsQueueRuntime,
  enqueueOpsImageJobsForOperation,
  readOpsControlSnapshot,
  readOpsLiveWorkersRunning,
  readOpsQueueJobById,
  readOpsQueuePausedState,
  readOpsQueueSnapshot,
  waitForOpsRunCompletion,
  writeOpsRunnerStatus,
} from "../workers/image-ops-control-module";
import { evaluateLiveGate } from "../workers/image-ops-telemetry";
import {
  type RunnerControlSettings,
  type RunnerStatusSnapshot,
} from "../workers/image-runner-control";

const DEFAULT_FETCH_TIMEOUT_MS = 8_000;
const DEFAULT_FETCH_RETRY_COUNT = 2;
const DEFAULT_FLY_WORKER_APP = "beachhouseclassifieds-image-worker";

type RunnerOptions = {
  redisTarget: RedisTarget;
  appName: string;
  targetCount: number | null;
  fetchTimeoutMs: number;
  fetchRetryCount: number;
  dryRunCloud: boolean;
  uploadPrefix: string;
  heartbeatSeconds: number;
  waitTimeoutSeconds: number;
  claimPoolMultiplier: number;
  claimPoolMax: number;
};

type ClaimedItem = {
  workId: string;
  sourceImageUrl: string;
};

type ReportBatchRow = {
  job_id: string;
  work_id: string;
  state: "completed" | "failed";
  processed_count: number;
  failed_count: number;
  elapsed_ms: number | null;
  source_network_modes: string[];
};

type RunnerReport = {
  started_at: string;
  finished_at: string;
  operation_id: string;
  options: RunnerOptions;
  claimed_count: number;
  queued_count: number;
  completed_jobs: number;
  failed_jobs: number;
  processed_items: number;
  failed_items: number;
  summary: Record<string, unknown>;
  jobs: ReportBatchRow[];
};

type CycleFeedback = {
  claimedCount: number;
  processedItems: number;
  failedItems: number;
  durationSec: number;
};

function parsePositiveInt(
  rawValue: string | undefined,
  fallback: number,
): number {
  const parsed = Number.parseInt(String(rawValue || "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseOptionalPositiveInt(rawValue: string | undefined): number | null {
  if (rawValue === undefined) {
    return null;
  }
  const parsed = Number.parseInt(String(rawValue).trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function deriveRefillPolicy(settings: RunnerControlSettings): {
  refillLow: number;
  refillTarget: number;
  maxBacklog: number;
  notes: string[];
} {
  const notes: string[] = [];
  const maxBacklog = Math.max(10, Number(settings.maxQueueBacklog) || 10);

  let refillTarget = Math.max(0, Number(settings.refillTargetBacklog) || 0);
  if (refillTarget <= 0) {
    refillTarget = Math.max(1, Math.floor(maxBacklog * 0.75));
    notes.push("auto_target_from_max_backlog");
  }
  refillTarget = clampInt(refillTarget, 1, maxBacklog);

  let refillLow = Math.max(0, Number(settings.refillLowWatermark) || 0);
  if (refillLow <= 0) {
    refillLow = Math.max(1, Math.floor(refillTarget * 0.67));
    notes.push("auto_low_from_target");
  }
  if (refillLow >= refillTarget) {
    refillLow = Math.max(0, refillTarget - 1);
    notes.push("auto_low_below_target");
  }

  return {
    refillLow,
    refillTarget,
    maxBacklog,
    notes,
  };
}

function deriveAutonomousQueueBand(input: {
  settings: RunnerControlSettings;
  workersRunning: number;
  lastCycleFeedback: CycleFeedback | null;
}): {
  refillLow: number;
  refillTarget: number;
  maxBacklog: number;
  notes: string[];
} {
  const safety = deriveRefillPolicy(input.settings);
  const notes: string[] = [];
  const workers = Math.max(1, Math.floor(input.workersRunning));

  const minTarget = Math.max(8, workers * 3);
  const softMaxTarget = Math.max(minTarget, workers * 10);
  let refillTarget = workers * 6;

  if (input.lastCycleFeedback) {
    const processed = Math.max(0, input.lastCycleFeedback.processedItems);
    const failed = Math.max(0, input.lastCycleFeedback.failedItems);
    const attempted = processed + failed;
    const failureRate = attempted > 0 ? failed / attempted : 0;
    const throughputPerSec =
      input.lastCycleFeedback.durationSec > 0
        ? processed / input.lastCycleFeedback.durationSec
        : 0;
    const throughputPerWorker = throughputPerSec / workers;

    if (failureRate >= 0.15) {
      refillTarget = Math.floor(refillTarget * 0.7);
      notes.push("band_backoff_failure_high");
    } else if (failureRate >= 0.05) {
      refillTarget = Math.floor(refillTarget * 0.85);
      notes.push("band_backoff_failure_moderate");
    }

    if (throughputPerWorker >= 0.8) {
      refillTarget = Math.floor(refillTarget * 1.15);
      notes.push("band_expand_throughput_strong");
    } else if (throughputPerWorker < 0.2) {
      refillTarget = Math.floor(refillTarget * 0.85);
      notes.push("band_contract_throughput_soft");
    }
  }

  refillTarget = clampInt(refillTarget, minTarget, softMaxTarget);
  refillTarget = Math.min(refillTarget, safety.maxBacklog);
  const refillLow = clampInt(
    Math.floor(refillTarget * 0.6),
    1,
    refillTarget - 1,
  );

  notes.push(
    `band_workers=${workers}`,
    `band_min_target=${minTarget}`,
    `band_soft_max_target=${softMaxTarget}`,
  );

  return {
    refillLow,
    refillTarget,
    maxBacklog: safety.maxBacklog,
    notes,
  };
}

function deriveAdaptiveClaimCap(input: {
  workersRunning: number;
  safetyMaxClaimCap: number;
  queueBacklog: number;
  queueActive: number;
  queueWaiting: number;
  queueDelayed: number;
  queuePaused: number;
  refillGap: number;
  startupRampActive: boolean;
  startupRampMultiplier: number;
  previousTarget: number | null;
  lastCycleFeedback: CycleFeedback | null;
}): {
  target: number;
  baseTarget: number;
  adjustedTarget: number;
  safetyCapApplied: boolean;
  reason: string;
} {
  const workerCount = Math.max(1, Math.floor(input.workersRunning));
  const pendingVisible = Math.max(
    0,
    input.queueWaiting + input.queueDelayed + input.queuePaused,
  );
  const activePerWorker = input.queueActive / workerCount;

  const reasons: string[] = [];
  let perWorkerBudget = 5;
  if (activePerWorker === 0 && pendingVisible === 0) {
    perWorkerBudget = 6;
    reasons.push("bootstrap_light_queue");
  } else if (activePerWorker >= 2) {
    perWorkerBudget = 3;
    reasons.push("high_active_pressure");
  } else if (activePerWorker >= 1) {
    perWorkerBudget = 4;
    reasons.push("moderate_active_pressure");
  }

  if (pendingVisible > workerCount * 4) {
    perWorkerBudget = Math.max(2, perWorkerBudget - 2);
    reasons.push("visible_pending_high");
  } else if (pendingVisible > workerCount * 2) {
    perWorkerBudget = Math.max(2, perWorkerBudget - 1);
    reasons.push("visible_pending_moderate");
  }

  const baseTarget = Math.max(1, workerCount * perWorkerBudget);
  let adjustedTarget = baseTarget;

  if (input.lastCycleFeedback) {
    const completed = Math.max(0, input.lastCycleFeedback.processedItems);
    const failed = Math.max(0, input.lastCycleFeedback.failedItems);
    const attempted = completed + failed;
    const failureRate = attempted > 0 ? failed / attempted : 0;
    const throughputPerSec =
      input.lastCycleFeedback.durationSec > 0
        ? completed / input.lastCycleFeedback.durationSec
        : 0;
    const throughputPerWorker = throughputPerSec / workerCount;

    let feedbackMultiplier = 1;
    if (failureRate >= 0.15) {
      feedbackMultiplier *= 0.6;
      reasons.push("failure_rate_high");
    } else if (failureRate >= 0.05) {
      feedbackMultiplier *= 0.8;
      reasons.push("failure_rate_moderate");
    }

    if (
      throughputPerWorker >= 1.2 &&
      activePerWorker < 1 &&
      pendingVisible < workerCount * 2
    ) {
      feedbackMultiplier *= 1.2;
      reasons.push("throughput_strong");
    } else if (throughputPerWorker < 0.2 && pendingVisible > workerCount) {
      feedbackMultiplier *= 0.85;
      reasons.push("throughput_soft");
    }

    adjustedTarget = Math.max(
      1,
      Math.floor(adjustedTarget * feedbackMultiplier),
    );
  }

  if (input.previousTarget !== null) {
    const maxStepUp = Math.max(1, Math.floor(input.previousTarget * 1.35));
    const minStepDown = Math.max(1, Math.ceil(input.previousTarget * 0.65));
    adjustedTarget = Math.min(adjustedTarget, maxStepUp);
    adjustedTarget = Math.max(adjustedTarget, minStepDown);
    reasons.push("step_limited");
  }

  if (input.startupRampActive) {
    adjustedTarget = Math.max(
      1,
      Math.floor(adjustedTarget * input.startupRampMultiplier),
    );
    reasons.push("startup_ramp_applied");
  }

  adjustedTarget = Math.max(1, Math.min(adjustedTarget, input.refillGap));
  const safetyCappedTarget = Math.max(
    1,
    Math.min(adjustedTarget, input.safetyMaxClaimCap),
  );

  return {
    target: safetyCappedTarget,
    baseTarget,
    adjustedTarget,
    safetyCapApplied: safetyCappedTarget !== adjustedTarget,
    reason: reasons.join(",") || "balanced_default",
  };
}

type StartupProbeSample = {
  gateReason: string;
  workersRunning: number;
  queueBacklog: number;
  queueActive: number;
  queueWaiting: number;
};

type StartupRampPlan = {
  rampCycles: number;
  claimCapMultiplier: number;
  reason: string;
};

function deriveStartupRampPlan(input: {
  settings: RunnerControlSettings;
  samples: StartupProbeSample[];
}): StartupRampPlan {
  if (input.samples.length === 0) {
    return {
      rampCycles: 1,
      claimCapMultiplier: 0.5,
      reason: "no_startup_samples",
    };
  }

  const latest = input.samples[input.samples.length - 1];
  if (latest.gateReason !== "gate=open") {
    return {
      rampCycles: 1,
      claimCapMultiplier: 0.35,
      reason: `gate_not_open:${latest.gateReason}`,
    };
  }

  const workersMin = Math.max(1, input.settings.minWorkersToEnqueue);
  const workersRatio = latest.workersRunning / workersMin;
  const workerPressure =
    latest.workersRunning > 0
      ? latest.queueActive / Math.max(1, latest.workersRunning)
      : 0;

  if (latest.workersRunning <= 0) {
    return {
      rampCycles: 2,
      claimCapMultiplier: 0.25,
      reason: "no_workers_visible",
    };
  }

  if (workersRatio < 1 || workerPressure >= 2) {
    return {
      rampCycles: 2,
      claimCapMultiplier: 0.5,
      reason: "workers_below_expected_or_high_active_pressure",
    };
  }

  if (workerPressure >= 1 || latest.queueWaiting > 0) {
    return {
      rampCycles: 1,
      claimCapMultiplier: 0.75,
      reason: "moderate_startup_pressure",
    };
  }

  return {
    rampCycles: 0,
    claimCapMultiplier: 1,
    reason: "steady_start",
  };
}

function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}

function createProgress(script: string) {
  const scriptLabel = chalk.bgBlue.white.bold(` ${script} `);

  function line(label: string, message: string): void {
    process.stdout.write(
      `${chalk.gray(stamp())} ${scriptLabel} ${label} ${message}\n`,
    );
  }

  return {
    phase(message: string) {
      line(chalk.bgCyan.black.bold(" phase "), chalk.cyan(message));
    },
    info(message: string) {
      line(chalk.bgWhite.black.bold(" info "), message);
    },
    progress(message: string) {
      line(chalk.bgBlueBright.white.bold(" prog  "), chalk.blueBright(message));
    },
    warn(message: string) {
      line(chalk.bgYellow.black.bold(" warn "), chalk.yellow(message));
    },
    done(message: string) {
      line(chalk.bgGreen.black.bold(" done "), chalk.green(message));
    },
    fail(message: string) {
      line(chalk.bgRed.white.bold(" fail "), chalk.red(message));
    },
  };
}

function roundToOne(value: number): number {
  return Math.round(value * 10) / 10;
}

function formatPct(completed: number, total: number): string {
  if (total <= 0) {
    return "n/a%";
  }
  return `${roundToOne((completed / total) * 100)}%`;
}

function formatEtaMinutes(
  completed: number,
  total: number,
  elapsedSeconds: number,
): string {
  if (completed <= 0 || total <= completed || elapsedSeconds <= 0) {
    return "n/a min";
  }

  const throughputPerMinute = (completed / elapsedSeconds) * 60;
  if (!Number.isFinite(throughputPerMinute) || throughputPerMinute <= 0) {
    return "n/a min";
  }

  const remaining = Math.max(0, total - completed);
  const remainingMinutes = remaining / throughputPerMinute;
  if (remaining > 0 && remainingMinutes < 0.1) {
    return "<0.1 min";
  }

  return `${roundToOne(remainingMinutes)} min`;
}

function formatModeProgressLine(input: {
  mode: string;
  completed: number;
  total: number;
  startedAtMs: number;
  text: string;
}): string {
  const elapsedSeconds = Math.max(
    1,
    Math.round((Date.now() - input.startedAtMs) / 1000),
  );
  const modeToken = chalk.cyanBright(input.mode);
  const ratioToken = chalk.white(`${input.completed}/${input.total}`);
  const pctToken = chalk.yellowBright(formatPct(input.completed, input.total));
  const etaToken = chalk.greenBright(
    formatEtaMinutes(input.completed, input.total, elapsedSeconds),
  );

  return `${modeToken} ${ratioToken} ${pctToken} ${etaToken} - ${input.text}`;
}

function usage(): string {
  return [
    "Usage:",
    "  npm run workers:image:desktop -- [--redis-target local|cloud] [--app <flyApp>] [--dry-run-cloud true]",
    "",
    "Behavior:",
    "  Runner defaults to intelligent autopilot: it derives claim size from live queue pressure,",
    "  worker availability, and refill policy. Provide flags only for exceptional overrides.",
    "",
    "Optional overrides:",
    "  --redis-target local|cloud  Redis target selector (default local; cloud uses FLY_REDIS)",
    "  --app <flyApp>               Fly worker app name for cloud infra refresh (default beachhouseclassifieds-image-worker)",
    "  --target-count <n>            Optional hard cap on claims for this run",
    "  --fetch-timeout-ms <n>        Source fetch timeout (default 8000)",
    "  --fetch-retry-count <n>       Source fetch retries (default 2)",
    "  --dry-run-cloud true|false    Skip upload and DB final image writes when true (default false)",
    "  --upload-prefix <prefix>      Output path prefix (default v1)",
    "  --heartbeat-seconds <n>       Progress heartbeat cadence (default 10)",
    "  --wait-timeout-seconds <n>    Max wait for queue completion (default 1800)",
    "  --claim-pool-multiplier <n>   Candidate pool multiplier (default 10)",
    "  --claim-pool-max <n>          Candidate pool cap (default 10000)",
  ].join("\n");
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) {
    return fallback;
  }

  const normalized = raw.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no") {
    return false;
  }
  return fallback;
}

function parseArgs(argv: string[]): RunnerOptions {
  const values = new Map<string, string>();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      values.set(key, next);
      i += 1;
      continue;
    }

    if (token === "--help" || token === "-h") {
      throw new Error(usage());
    }
  }

  const redisTargetRaw = values.get("redis-target")?.trim().toLowerCase();
  const redisTarget: RedisTarget =
    redisTargetRaw === undefined || redisTargetRaw === ""
      ? "local"
      : redisTargetRaw === "local" || redisTargetRaw === "cloud"
        ? redisTargetRaw
        : (() => {
            throw new Error(
              `Invalid --redis-target: ${values.get("redis-target")}. Use local or cloud.\n\n${usage()}`,
            );
          })();

  return {
    redisTarget,
    appName: values.get("app")?.trim() || DEFAULT_FLY_WORKER_APP,
    targetCount: parseOptionalPositiveInt(values.get("target-count")),
    fetchTimeoutMs: parsePositiveInt(
      values.get("fetch-timeout-ms"),
      parsePositiveInt(
        process.env.IMAGE_FETCH_TIMEOUT_MS,
        DEFAULT_FETCH_TIMEOUT_MS,
      ),
    ),
    fetchRetryCount: Math.max(
      0,
      Math.min(
        5,
        parsePositiveInt(
          values.get("fetch-retry-count"),
          parsePositiveInt(
            process.env.IMAGE_FETCH_RETRY_COUNT,
            DEFAULT_FETCH_RETRY_COUNT,
          ),
        ),
      ),
    ),
    dryRunCloud: parseBoolean(values.get("dry-run-cloud"), false),
    uploadPrefix: values.get("upload-prefix")?.trim() || "v1",
    heartbeatSeconds: parsePositiveInt(values.get("heartbeat-seconds"), 10),
    waitTimeoutSeconds: parsePositiveInt(
      values.get("wait-timeout-seconds"),
      1800,
    ),
    claimPoolMultiplier: parsePositiveInt(
      values.get("claim-pool-multiplier"),
      10,
    ),
    claimPoolMax: parsePositiveInt(values.get("claim-pool-max"), 10_000),
  };
}

async function claimPendingRows(
  pool: Pool,
  targetCount: number,
  claimPoolSize: number,
): Promise<ClaimedItem[]> {
  return claimPendingImageRows(pool, targetCount, claimPoolSize);
}

async function updateSuccessRows(
  pool: Pool,
  items: ImageProcessingItemResult[],
): Promise<{ uploadedCount: number; notUploadedCount: number }> {
  return applySuccessRows(pool, items);
}

async function updateFailureRows(
  pool: Pool,
  errors: ImageProcessingTaskError[],
  marker: string,
): Promise<void> {
  await applyFailureRows(pool, errors, marker);
}

function countErrorsByCode(
  rows: ImageProcessingTaskError[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const code = String(row?.code || "unknown_error");
    counts[code] = (counts[code] || 0) + 1;
  }
  return counts;
}

function countItemsByNetworkMode(
  rows: ImageProcessingItemResult[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const mode = String(row.source_network_mode || "unknown");
    counts[mode] = (counts[mode] || 0) + 1;
  }
  return counts;
}

function countItemsByStoredStatus(
  rows: ImageProcessingItemResult[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const status = String(row.stored_status_on_s3 || "unknown");
    counts[status] = (counts[status] || 0) + 1;
  }
  return counts;
}

function sumNumberField<T>(rows: T[], pick: (row: T) => unknown): number {
  let total = 0;
  for (const row of rows) {
    const value = Number(pick(row));
    if (Number.isFinite(value) && value > 0) {
      total += value;
    }
  }
  return total;
}

function countWhere<T>(rows: T[], predicate: (row: T) => boolean): number {
  let count = 0;
  for (const row of rows) {
    if (predicate(row)) {
      count += 1;
    }
  }
  return count;
}

function toLatencySummary(values: number[]): {
  count: number;
  avg_ms: number;
  p50_ms: number;
  p95_ms: number;
  max_ms: number;
} {
  const filtered = values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);

  if (filtered.length === 0) {
    return {
      count: 0,
      avg_ms: 0,
      p50_ms: 0,
      p95_ms: 0,
      max_ms: 0,
    };
  }

  const sum = filtered.reduce((acc, value) => acc + value, 0);
  const quantile = (q: number): number => {
    const index = Math.max(
      0,
      Math.min(filtered.length - 1, Math.ceil(filtered.length * q) - 1),
    );
    return filtered[index];
  };

  return {
    count: filtered.length,
    avg_ms: roundToOne(sum / filtered.length),
    p50_ms: roundToOne(quantile(0.5)),
    p95_ms: roundToOne(quantile(0.95)),
    max_ms: roundToOne(filtered[filtered.length - 1]),
  };
}

async function closeWithTimeout(
  label: string,
  operation: Promise<unknown>,
  timeoutMs = 4000,
): Promise<void> {
  await Promise.race([
    operation.then(() => undefined).catch(() => undefined),
    new Promise<void>((resolve) => {
      setTimeout(() => {
        process.stdout.write(
          `${chalk.gray(stamp())} ${chalk.bgBlue.white.bold(" image-processing-bullmq ")} ${chalk.bgYellow.black.bold(" warn ")} ${chalk.yellow(`shutdown timeout label=${label}`)}\n`,
        );
        resolve();
      }, timeoutMs);
    }),
  ]);
}

async function sleepMs(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, Math.max(1, ms));
  });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const progress = createProgress("image-processing-bullmq");
  const redisSelection = configureRedisTarget(options.redisTarget);
  progress.info(
    `redis_target=${redisSelection.target} redis_endpoint=${redisSelection.endpoint}`,
  );

  if (!options.dryRunCloud) {
    const secret = process.env.BUNNY_STORAGE_SECRET_ACCESS_KEY?.trim() || "";
    if (!secret) {
      throw new Error(
        "Missing BUNNY_STORAGE_SECRET_ACCESS_KEY for --dry-run-cloud false. Either set the secret in env profile or run with --dry-run-cloud true.",
      );
    }
  }

  const operationId = `bullmq-op-${new Date().toISOString().replace(/[.:]/g, "-")}-${randomUUID().slice(0, 6)}`;
  const startedAtMs = Date.now();

  const pool = createOpsDbPool(6);
  const queueRuntime = await createOpsQueueRuntime({ withEvents: true });
  const queue = queueRuntime.queue;
  const queueEvents = queueRuntime.queueEvents;
  if (!queueEvents) {
    throw new Error("queue events runtime unavailable");
  }

  const report: RunnerReport = {
    started_at: new Date().toISOString(),
    finished_at: "",
    operation_id: operationId,
    options,
    claimed_count: 0,
    queued_count: 0,
    completed_jobs: 0,
    failed_jobs: 0,
    processed_items: 0,
    failed_items: 0,
    summary: {},
    jobs: [],
  };

  const allErrors: ImageProcessingTaskError[] = [];
  const allSuccessItems: ImageProcessingItemResult[] = [];
  let flushBatchCount = 0;
  let lastFlushAt: string | null = null;

  const summarizeLivePerformance = (): {
    throughputImagesPerMinute: number;
    avgFetchMs: number;
    avgTransformMs: number;
    avgUploadMs: number;
    avgEndToEndMs: number;
  } => {
    const elapsedMinutes = Math.max(1 / 60, (Date.now() - startedAtMs) / 60000);
    const throughputImagesPerMinute =
      Math.round((report.processed_items / elapsedMinutes) * 100) / 100;

    if (allSuccessItems.length === 0) {
      return {
        throughputImagesPerMinute,
        avgFetchMs: 0,
        avgTransformMs: 0,
        avgUploadMs: 0,
        avgEndToEndMs: 0,
      };
    }

    let fetchSum = 0;
    let transformSum = 0;
    let uploadSum = 0;
    let endToEndSum = 0;
    for (const row of allSuccessItems) {
      const fetchMs = Number(row.fetch_elapsed_ms || 0);
      const transformMs = Number(row.transform_elapsed_ms || 0);
      const uploadMs = Number(row.upload_elapsed_ms || 0);
      fetchSum += fetchMs;
      transformSum += transformMs;
      uploadSum += uploadMs;
      endToEndSum += fetchMs + transformMs + uploadMs;
    }

    const count = allSuccessItems.length;
    return {
      throughputImagesPerMinute,
      avgFetchMs: Math.round(fetchSum / count),
      avgTransformMs: Math.round(transformSum / count),
      avgUploadMs: Math.round(uploadSum / count),
      avgEndToEndMs: Math.round(endToEndSum / count),
    };
  };

  const readQueueSnapshot = async (): Promise<{
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
    paused: number;
    backlog: number;
  }> => {
    return readOpsQueueSnapshot();
  };

  const controlSnapshot = await readOpsControlSnapshot();
  let controlSettings: RunnerControlSettings = controlSnapshot.settings;
  const inferredWorkersRunning = Number(controlSnapshot.infra?.workersRunning);
  let workersRunning =
    Number.isFinite(inferredWorkersRunning) && inferredWorkersRunning > 0
      ? inferredWorkersRunning
      : 0;

  const publishRunnerStatus = async (params: {
    mode: RunnerStatusSnapshot["mode"];
    gateReason: string;
    pendingSuccessBuffer?: number;
    pendingErrorBuffer?: number;
  }): Promise<void> => {
    const queueSnapshot = await readQueueSnapshot();
    const perf = summarizeLivePerformance();
    await writeOpsRunnerStatus({
      operationId,
      mode: params.mode,
      desiredMode: controlSettings.desiredMode,
      gateReason: params.gateReason,
      workersRunning,
      claimedCount: report.claimed_count,
      queuedCount: report.queued_count,
      completedJobs: report.completed_jobs,
      failedJobs: report.failed_jobs,
      processedItems: report.processed_items,
      failedItems: report.failed_items,
      queueWaiting: queueSnapshot.waiting,
      queueActive: queueSnapshot.active,
      queueCompleted: queueSnapshot.completed,
      queueFailed: queueSnapshot.failed,
      queueDelayed: queueSnapshot.delayed,
      queuePaused: queueSnapshot.paused,
      queueBacklog: queueSnapshot.backlog,
      lastFlushAt,
      flushBatchCount,
      pendingSuccessBuffer: Math.max(0, params.pendingSuccessBuffer ?? 0),
      pendingErrorBuffer: Math.max(0, params.pendingErrorBuffer ?? 0),
      throughputImagesPerMinute: perf.throughputImagesPerMinute,
      avgFetchMs: perf.avgFetchMs,
      avgTransformMs: perf.avgTransformMs,
      avgUploadMs: perf.avgUploadMs,
      avgEndToEndMs: perf.avgEndToEndMs,
      updatedAt: new Date().toISOString(),
    });
  };

  const computeGateState = async (): Promise<{
    queueSnapshot: {
      waiting: number;
      active: number;
      completed: number;
      failed: number;
      delayed: number;
      paused: number;
      backlog: number;
    };
    queueGloballyPaused: boolean;
    gateReason: string;
    gateInputs: {
      pausedStateLive: boolean;
      snapshotQueuePaused: number;
      desiredMode: string;
      enqueueEnabled: boolean;
      requireWorkersForEnqueue: boolean;
      minWorkersToEnqueue: number;
      workersFromInfraSnapshot: number;
      workersFromQueueActiveInference: number;
      workersFromLiveRead: number;
      workersEffective: number;
      queuePausedCount: number;
      queueBacklog: number;
    };
  }> => {
    const [queueSnapshot, pausedState, freshControlSnapshot, liveWorkers] =
      await Promise.all([
        readQueueSnapshot(),
        readOpsQueuePausedState(),
        readOpsControlSnapshot(),
        readOpsLiveWorkersRunning(),
      ]);

    controlSettings = freshControlSnapshot.settings;
    const freshWorkers = Number(freshControlSnapshot.infra?.workersRunning);
    const snapshotWorkersRunning =
      Number.isFinite(freshWorkers) && freshWorkers > 0 ? freshWorkers : 0;
    const inferredWorkersFromQueue = queueSnapshot.active > 0 ? 1 : 0;
    const workersFromLiveRead = Math.max(0, Math.floor(liveWorkers || 0));
    workersRunning = Math.max(
      snapshotWorkersRunning,
      inferredWorkersFromQueue,
      workersFromLiveRead,
    );

    const liveGate = evaluateLiveGate({
      settings: controlSettings,
      workersRunning,
      queueBacklog: queueSnapshot.backlog,
    });

    const snapshotQueuePaused = Math.max(
      0,
      Number(freshControlSnapshot.status?.queuePaused || 0),
    );

    // Gate decisions should use the live queue paused signal, not stale snapshots.
    const moduleVisiblePaused = pausedState;
    const blockers: string[] = [];
    if (controlSettings.desiredMode !== "run") {
      blockers.push(`desired_mode=${controlSettings.desiredMode} not run`);
    }
    if (!controlSettings.enqueueEnabled) {
      blockers.push("enqueue_disabled");
    }
    if (moduleVisiblePaused) {
      blockers.push("queue_globally_paused");
    }
    if (liveGate !== "live=gate_open") {
      blockers.push(liveGate.replace(/^live=/, ""));
    }

    const gateReason = blockers.length > 0 ? blockers.join("; ") : "gate=open";

    return {
      queueSnapshot,
      queueGloballyPaused: moduleVisiblePaused,
      gateReason,
      gateInputs: {
        pausedStateLive: pausedState,
        snapshotQueuePaused,
        desiredMode: controlSettings.desiredMode,
        enqueueEnabled: controlSettings.enqueueEnabled,
        requireWorkersForEnqueue: controlSettings.requireWorkersForEnqueue,
        minWorkersToEnqueue: controlSettings.minWorkersToEnqueue,
        workersFromInfraSnapshot: snapshotWorkersRunning,
        workersFromQueueActiveInference: inferredWorkersFromQueue,
        workersFromLiveRead,
        workersEffective: workersRunning,
        queuePausedCount: queueSnapshot.paused,
        queueBacklog: queueSnapshot.backlog,
      },
    };
  };

  progress.phase("runner startup telemetry warmup");
  const startupSamples: StartupProbeSample[] = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const startupGateState = await computeGateState();
    startupSamples.push({
      gateReason: startupGateState.gateReason,
      workersRunning,
      queueBacklog: startupGateState.queueSnapshot.backlog,
      queueActive: startupGateState.queueSnapshot.active,
      queueWaiting: startupGateState.queueSnapshot.waiting,
    });
    if (attempt < 2) {
      await sleepMs(1000);
    }
  }

  const startupRampPlan = deriveStartupRampPlan({
    settings: controlSettings,
    samples: startupSamples,
  });
  let rampCyclesRemaining = startupRampPlan.rampCycles;

  let {
    queueSnapshot: initialQueueSnapshot,
    queueGloballyPaused,
    gateReason,
    gateInputs,
  } = await computeGateState();

  progress.info(
    `startup_stats queue_waiting=${initialQueueSnapshot.waiting} queue_active=${initialQueueSnapshot.active} queue_delayed=${initialQueueSnapshot.delayed} queue_paused=${initialQueueSnapshot.paused} queue_backlog=${initialQueueSnapshot.backlog} workers_running=${workersRunning} desired_mode=${controlSettings.desiredMode} queue_globally_paused=${queueGloballyPaused} startup_samples=${startupSamples.length} startup_ramp_cycles=${startupRampPlan.rampCycles} startup_claim_cap_multiplier=${startupRampPlan.claimCapMultiplier} startup_reason=${startupRampPlan.reason}`,
  );
  progress.info(
    `startup_gate_inputs paused_live=${gateInputs.pausedStateLive} snapshot_queue_paused=${gateInputs.snapshotQueuePaused} queue_paused_count=${gateInputs.queuePausedCount} desired_mode=${gateInputs.desiredMode} enqueue_enabled=${gateInputs.enqueueEnabled} require_workers_for_enqueue=${gateInputs.requireWorkersForEnqueue} min_workers_to_enqueue=${gateInputs.minWorkersToEnqueue} workers_infra=${gateInputs.workersFromInfraSnapshot} workers_live=${gateInputs.workersFromLiveRead} workers_effective=${gateInputs.workersEffective} queue_backlog=${gateInputs.queueBacklog}`,
  );
  await publishRunnerStatus({ mode: "idle", gateReason });

  const gatePollMs = Math.max(3000, options.heartbeatSeconds * 1000);
  while (gateReason !== "gate=open") {
    progress.warn(`runner gate blocked: ${gateReason}`);
    progress.info(
      `gate_monitor queue_backlog=${initialQueueSnapshot.backlog} workers_running=${workersRunning} desired_mode=${controlSettings.desiredMode} poll_ms=${gatePollMs}`,
    );
    await sleepMs(gatePollMs);
    const nextGateState = await computeGateState();
    initialQueueSnapshot = nextGateState.queueSnapshot;
    queueGloballyPaused = nextGateState.queueGloballyPaused;
    gateReason = nextGateState.gateReason;
    gateInputs = nextGateState.gateInputs;
    progress.info(
      `gate_inputs paused_live=${gateInputs.pausedStateLive} snapshot_queue_paused=${gateInputs.snapshotQueuePaused} queue_paused_count=${gateInputs.queuePausedCount} desired_mode=${gateInputs.desiredMode} enqueue_enabled=${gateInputs.enqueueEnabled} require_workers_for_enqueue=${gateInputs.requireWorkersForEnqueue} min_workers_to_enqueue=${gateInputs.minWorkersToEnqueue} workers_infra=${gateInputs.workersFromInfraSnapshot} workers_live=${gateInputs.workersFromLiveRead} workers_effective=${gateInputs.workersEffective} queue_backlog=${gateInputs.queueBacklog}`,
    );
    await publishRunnerStatus({ mode: "idle", gateReason });
  }

  progress.done(
    `runner gate opened queue_backlog=${initialQueueSnapshot.backlog} workers_running=${workersRunning}`,
  );

  const heartbeat = setInterval(
    () => {
      const finalized = report.completed_jobs + report.failed_jobs;
      const total = Math.max(report.queued_count, report.claimed_count);
      void Promise.allSettled([readQueueSnapshot()])
        .then((results) => {
          const queueResult = results[0];
          const snapshot =
            queueResult.status === "fulfilled" ? queueResult.value : null;
          const line = formatModeProgressLine({
            mode: "desktop-bullmq",
            completed: finalized,
            total,
            startedAtMs,
            text:
              `op_images_processed=${report.processed_items}/${report.claimed_count} ` +
              `system_images_processed=n/a ` +
              `jobs_completed=${report.completed_jobs} jobs_failed=${report.failed_jobs} ` +
              `items_failed=${report.failed_items}`,
          });
          if (snapshot) {
            progress.progress(
              `heartbeat ${line} live_queue_backlog=${snapshot.backlog}`,
            );
          } else {
            progress.progress(`heartbeat ${line} live_queue_backlog=n/a`);
          }
          void publishRunnerStatus({
            mode: "running",
            gateReason: "gate=open",
            pendingSuccessBuffer: pendingSuccessItems.length,
            pendingErrorBuffer: pendingErrors.length,
          }).catch((error: unknown) => {
            const message =
              error instanceof Error ? error.message : String(error);
            progress.warn(`status_publish_failed message=${message}`);
          });
        })
        .catch(() => {
          // Promise.allSettled should prevent this path in normal operation.
        });
    },
    Math.max(5, options.heartbeatSeconds) * 1000,
  );

  const continuousMode = options.targetCount === null;
  const idleSleepMs = Math.max(3000, options.heartbeatSeconds * 1000);
  let autonomousTargetPrevious: number | null = null;
  let lastCycleFeedback: CycleFeedback | null = null;

  try {
    while (true) {
      const nextGateState = await computeGateState();
      initialQueueSnapshot = nextGateState.queueSnapshot;
      queueGloballyPaused = nextGateState.queueGloballyPaused;
      gateReason = nextGateState.gateReason;
      gateInputs = nextGateState.gateInputs;

      if (gateReason !== "gate=open") {
        await publishRunnerStatus({ mode: "idle", gateReason });
        progress.info(
          `cycle_idle gate=${gateReason} queue_backlog=${initialQueueSnapshot.backlog} workers_running=${workersRunning} desired_mode=${controlSettings.desiredMode} sleep_ms=${idleSleepMs}`,
        );
        progress.info(
          `cycle_gate_inputs paused_live=${gateInputs.pausedStateLive} snapshot_queue_paused=${gateInputs.snapshotQueuePaused} queue_paused_count=${gateInputs.queuePausedCount} desired_mode=${gateInputs.desiredMode} enqueue_enabled=${gateInputs.enqueueEnabled} require_workers_for_enqueue=${gateInputs.requireWorkersForEnqueue} min_workers_to_enqueue=${gateInputs.minWorkersToEnqueue} workers_infra=${gateInputs.workersFromInfraSnapshot} workers_live=${gateInputs.workersFromLiveRead} workers_effective=${gateInputs.workersEffective} queue_backlog=${gateInputs.queueBacklog}`,
        );
        await sleepMs(idleSleepMs);
        continue;
      }

      const requestedTargetCap = options.targetCount;
      const liveQueueBacklog = initialQueueSnapshot.backlog;
      const refillPolicy = deriveAutonomousQueueBand({
        settings: controlSettings,
        workersRunning,
        lastCycleFeedback,
      });
      const workerCount = Math.max(1, workersRunning);
      const queueCoverageNow = liveQueueBacklog / workerCount;
      const queueCoverageTarget = Math.max(
        1.5,
        Math.min(4, refillPolicy.refillTarget / workerCount),
      );
      const workersSaturated = initialQueueSnapshot.active >= workerCount;
      const shouldRefillByLow = liveQueueBacklog < refillPolicy.refillLow;
      const shouldRefillByCoverage =
        queueCoverageNow < queueCoverageTarget && !workersSaturated;
      const shouldRefill = shouldRefillByLow || shouldRefillByCoverage;
      const refillGap = shouldRefill
        ? Math.max(0, refillPolicy.refillTarget - liveQueueBacklog)
        : 0;
      const safetyMaxClaimCap = Math.max(1, controlSettings.maxClaimPerCycle);
      const startupRampActive = rampCyclesRemaining > 0;
      const autonomousDecision = deriveAdaptiveClaimCap({
        workersRunning,
        safetyMaxClaimCap,
        queueBacklog: liveQueueBacklog,
        queueActive: initialQueueSnapshot.active,
        queueWaiting: initialQueueSnapshot.waiting,
        queueDelayed: initialQueueSnapshot.delayed,
        queuePaused: initialQueueSnapshot.paused,
        refillGap,
        startupRampActive,
        startupRampMultiplier: startupRampPlan.claimCapMultiplier,
        previousTarget: autonomousTargetPrevious,
        lastCycleFeedback,
      });
      const policyTargetCount = Math.min(refillGap, autonomousDecision.target);
      const effectiveTargetCount =
        requestedTargetCap === null
          ? policyTargetCount
          : Math.max(0, Math.min(requestedTargetCap, policyTargetCount));

      progress.info(
        `queue_preflight waiting=${initialQueueSnapshot.waiting} active=${initialQueueSnapshot.active} delayed=${initialQueueSnapshot.delayed} paused=${initialQueueSnapshot.paused} backlog=${liveQueueBacklog}`,
      );
      progress.info(
        `claim_policy target_cap=${requestedTargetCap === null ? "none" : String(requestedTargetCap)} refill_low=${refillPolicy.refillLow} refill_target=${refillPolicy.refillTarget} queue_capacity_max=${refillPolicy.maxBacklog} should_refill=${shouldRefill} should_refill_low=${shouldRefillByLow} should_refill_coverage=${shouldRefillByCoverage} refill_gap=${refillGap} worker_count=${workerCount} workers_saturated=${workersSaturated} queue_coverage_now=${roundToOne(queueCoverageNow)} queue_coverage_target=${roundToOne(queueCoverageTarget)} safety_max_claim_cycle=${safetyMaxClaimCap} startup_ramp_active=${startupRampActive} startup_ramp_cycles_remaining=${rampCyclesRemaining} startup_ramp_multiplier=${startupRampPlan.claimCapMultiplier} autonomous_base_target=${autonomousDecision.baseTarget} autonomous_adjusted_target=${autonomousDecision.adjustedTarget} autonomous_target=${autonomousDecision.target} autonomous_safety_capped=${autonomousDecision.safetyCapApplied} autonomous_reason=${autonomousDecision.reason} workers_running=${workersRunning} previous_target=${autonomousTargetPrevious === null ? "none" : String(autonomousTargetPrevious)} policy_target=${policyTargetCount} effective_target=${effectiveTargetCount} notes=${refillPolicy.notes.join(",") || "none"}`,
      );
      progress.info(
        `feedback_loop queue_waiting=${initialQueueSnapshot.waiting} queue_active=${initialQueueSnapshot.active} queue_delayed=${initialQueueSnapshot.delayed} queue_paused=${initialQueueSnapshot.paused} queue_backlog=${liveQueueBacklog} workers_running=${workersRunning}`,
      );

      if (effectiveTargetCount <= 0) {
        const skipReason = shouldRefill
          ? "refill_blocked_by_target_cap"
          : "queue_at_or_above_refill_low";
        await publishRunnerStatus({ mode: "idle", gateReason: skipReason });
        progress.done(
          `cycle_no_claim reason=${skipReason} backlog=${liveQueueBacklog} refill_low=${refillPolicy.refillLow} refill_target=${refillPolicy.refillTarget}`,
        );
        await sleepMs(idleSleepMs);
        if (!continuousMode) {
          break;
        }
        if (startupRampActive) {
          rampCyclesRemaining = Math.max(0, rampCyclesRemaining - 1);
        }
        continue;
      }

      progress.phase("claiming rows from postgres");
      const cycleStartedAtMs = Date.now();
      const cycleProcessedStart = report.processed_items;
      const cycleFailedStart = report.failed_items;
      const claimPoolSize = Math.max(
        effectiveTargetCount,
        Math.min(
          options.claimPoolMax,
          effectiveTargetCount * options.claimPoolMultiplier,
        ),
      );
      const claimedItems = await claimPendingRows(
        pool,
        effectiveTargetCount,
        claimPoolSize,
      );
      report.claimed_count += claimedItems.length;
      autonomousTargetPrevious = effectiveTargetCount;

      if (claimedItems.length === 0) {
        lastCycleFeedback = {
          claimedCount: 0,
          processedItems: 0,
          failedItems: 0,
          durationSec: Math.max(1, (Date.now() - cycleStartedAtMs) / 1000),
        };
        await publishRunnerStatus({
          mode: "idle",
          gateReason: "no_rows_claimed",
        });
        progress.done("cycle_no_claim reason=no_rows_claimed");
        await sleepMs(idleSleepMs);
        if (!continuousMode) {
          break;
        }
        continue;
      }

      progress.phase("enqueueing bullmq jobs");
      const jobRetentionCount = Math.max(1000, effectiveTargetCount * 2);
      const queuedJobs = await enqueueOpsImageJobsForOperation({
        queue,
        operationId,
        claimedItems,
        options: {
          fetchTimeoutMs: options.fetchTimeoutMs,
          fetchRetryCount: options.fetchRetryCount,
          dryRunCloud: options.dryRunCloud,
          uploadPrefix: options.uploadPrefix,
          jobRetentionCount,
        },
      });
      report.queued_count += queuedJobs.length;
      const postEnqueueSnapshot = await readQueueSnapshot();
      progress.info(
        `queued_jobs=${queuedJobs.length} queue=${IMAGE_QUEUE_NAME} operation_target_images=${claimedItems.length} queue_pending_after_enqueue=${postEnqueueSnapshot.backlog} retention=${jobRetentionCount}`,
      );

      const jobsById = new Map<string, Job<ImageProcessingQueueJob>>();
      for (const job of queuedJobs) {
        const jobId = String(job.id || "");
        if (!jobId) {
          continue;
        }
        jobsById.set(jobId, job);
      }

      const seenCompletedJobIds = new Set<string>();
      const seenFailedJobIds = new Set<string>();
      const handledJobIds = new Set<string>();
      const jobMissingReloadCount = new Map<string, number>();

      const pendingSuccessItems: ImageProcessingItemResult[] = [];
      const pendingErrors: ImageProcessingTaskError[] = [];
      let flushedProcessedItems = 0;
      let flushedFailedItems = 0;
      const cycleCompletedBase = report.completed_jobs;
      const cycleFailedBase = report.failed_jobs;
      let flushedWithheldItems = 0;

      async function flushPendingWrites(reason: string): Promise<void> {
        if (pendingSuccessItems.length === 0 && pendingErrors.length === 0) {
          return;
        }

        const successBatch = pendingSuccessItems.slice();
        const errorBatch = pendingErrors.slice();
        let writeStats: { uploadedCount: number; notUploadedCount: number };
        try {
          writeStats = await updateSuccessRows(pool, successBatch);
          await updateFailureRows(pool, errorBatch, "bullmq_dispatch");
        } catch (error: unknown) {
          const message =
            error instanceof Error ? error.message : String(error);
          progress.fail(`writeback_failed reason=${reason} message=${message}`);
          await queue.pause().catch(() => undefined);
          await publishRunnerStatus({
            mode: "failed",
            gateReason: "db_writeback_failed_queue_paused",
            pendingSuccessBuffer: pendingSuccessItems.length,
            pendingErrorBuffer: pendingErrors.length,
          }).catch(() => undefined);
          throw new Error(
            `db writeback failed; queue paused to avoid status loss: ${message}`,
          );
        }

        pendingSuccessItems.length = 0;
        pendingErrors.length = 0;

        allSuccessItems.push(...successBatch);
        allErrors.push(...errorBatch);

        // Track processing progress by items successfully handled by workers,
        // not by cloud-upload outcomes.
        flushedProcessedItems += successBatch.length;
        flushedFailedItems += errorBatch.length;
        flushedWithheldItems += writeStats.notUploadedCount;
        report.processed_items = flushedProcessedItems;
        report.failed_items = flushedFailedItems;
        flushBatchCount += 1;
        lastFlushAt = new Date().toISOString();

        progress.info(
          `writeback_flush reason=${reason} batch=${flushBatchCount} success_items=${successBatch.length} errors=${errorBatch.length} uploaded=${writeStats.uploadedCount} withheld=${writeStats.notUploadedCount} totals_processed=${flushedProcessedItems} totals_failed=${flushedFailedItems} totals_withheld=${flushedWithheldItems}`,
        );

        await publishRunnerStatus({
          mode: "running",
          gateReason: "gate=open",
          pendingSuccessBuffer: pendingSuccessItems.length,
          pendingErrorBuffer: pendingErrors.length,
        });
      }

      async function processFinalizedJobs(options: {
        reason: string;
        finalPass: boolean;
      }): Promise<void> {
        for (const [jobId, job] of jobsById) {
          if (handledJobIds.has(jobId)) {
            continue;
          }

          const finalized =
            seenCompletedJobIds.has(jobId) || seenFailedJobIds.has(jobId);
          if (!finalized && !options.finalPass) {
            continue;
          }

          const reloaded = await readOpsQueueJobById(queue, jobId);
          if (!reloaded) {
            const misses = (jobMissingReloadCount.get(jobId) || 0) + 1;
            jobMissingReloadCount.set(jobId, misses);
            if (!options.finalPass) {
              continue;
            }

            pendingErrors.push({
              work_id: String(job.data.workId),
              source_image_url: String(job.data.sourceImageUrl || ""),
              code: "missing_job_result",
              message: `bullmq result missing for jobId=${jobId} after ${misses} reload attempts`,
            });
            handledJobIds.add(jobId);
            progress.warn(
              `job_missing_result job_id=${jobId} work_id=${job.data.workId} reload_attempts=${misses}`,
            );
            continue;
          }

          const isCompleted = seenCompletedJobIds.has(jobId);
          if (!isCompleted) {
            const failedReason = String(
              reloaded.failedReason || "job failed without reason",
            );
            pendingErrors.push({
              work_id: String(job.data.workId),
              source_image_url: String(job.data.sourceImageUrl || ""),
              code: "worker_error",
              message: failedReason,
            });
            report.jobs.push({
              job_id: jobId,
              work_id: String(job.data.workId),
              state: "failed",
              processed_count: 0,
              failed_count: 1,
              elapsed_ms: null,
              source_network_modes: [],
            });
            handledJobIds.add(jobId);
            progress.warn(
              `job_failed job_id=${jobId} work_id=${job.data.workId} reason=${failedReason}`,
            );
            continue;
          }

          const result = (reloaded.returnvalue || {}) as {
            items?: ImageProcessingItemResult[];
            errors?: ImageProcessingTaskError[];
            processed_count?: number;
            failed_count?: number;
            elapsed_ms?: number;
          };

          const items = Array.isArray(result.items) ? result.items : [];
          const errors = Array.isArray(result.errors) ? result.errors : [];
          pendingSuccessItems.push(...items);
          pendingErrors.push(...errors);

          const modes = [
            ...new Set(items.map((row) => row.source_network_mode)),
          ]
            .filter(Boolean)
            .map((value) => String(value));

          report.jobs.push({
            job_id: jobId,
            work_id: String(job.data.workId),
            state: errors.length > 0 ? "failed" : "completed",
            processed_count: Number(result.processed_count ?? items.length),
            failed_count: Number(result.failed_count ?? errors.length),
            elapsed_ms: Number.isFinite(result.elapsed_ms)
              ? Number(result.elapsed_ms)
              : null,
            source_network_modes: modes,
          });

          handledJobIds.add(jobId);
          progress.info(
            `job_buffered reason=${options.reason} job_id=${jobId} work_id=${job.data.workId} items=${items.length} errors=${errors.length} modes=${modes.join(",") || "none"}`,
          );
        }
      }

      const periodicFlushIntervalMs = Math.max(
        1_000,
        Math.min(60_000, controlSettings.flushIntervalMs),
      );
      let periodicFlushTimer: NodeJS.Timeout | null = null;
      let harvestChain: Promise<void> = Promise.resolve();

      const enqueueHarvestCycle = (
        reason: string,
        finalPass: boolean,
      ): Promise<void> => {
        harvestChain = harvestChain.then(async () => {
          await processFinalizedJobs({ reason, finalPass });
          await flushPendingWrites(reason);
        });
        return harvestChain;
      };

      try {
        progress.info(`periodic_flush_interval_ms=${periodicFlushIntervalMs}`);
        periodicFlushTimer = setInterval(() => {
          void enqueueHarvestCycle("periodic", false).catch(
            (error: unknown) => {
              const message =
                error instanceof Error ? error.message : String(error);
              progress.warn(`periodic_flush_failed message=${message}`);
            },
          );
        }, periodicFlushIntervalMs);

        progress.phase("waiting for worker completion");
        await publishRunnerStatus({
          mode: "running",
          gateReason: "gate=open",
          pendingSuccessBuffer: pendingSuccessItems.length,
          pendingErrorBuffer: pendingErrors.length,
        });
        let completion: { completedJobIds: string[]; failedJobIds: string[] };
        const totalWaitMs = Math.max(1, options.waitTimeoutSeconds) * 1000;
        const waitDeadlineMs = Date.now() + totalWaitMs;

        while (true) {
          const remainingMs = waitDeadlineMs - Date.now();
          if (remainingMs <= 0) {
            throw new Error(
              `timeout waiting for queue completion queue=${IMAGE_QUEUE_NAME} completed=${seenCompletedJobIds.size} failed=${seenFailedJobIds.size} expected=${queuedJobs.length}`,
            );
          }

          const waitSliceMs = Math.min(15_000, remainingMs);

          try {
            completion = await waitForOpsRunCompletion({
              queueEvents,
              queueName: IMAGE_QUEUE_NAME,
              expectedJobs: queuedJobs.length,
              timeoutMs: waitSliceMs,
              onProgress: ({
                completed,
                failed,
                expected,
                processedItems,
                failedItems,
                completedJobIds,
                failedJobIds,
              }) => {
                report.completed_jobs = completed;
                report.failed_jobs = failed;

                for (const jobId of completedJobIds) {
                  seenCompletedJobIds.add(jobId);
                }
                for (const jobId of failedJobIds) {
                  seenFailedJobIds.add(jobId);
                }

                // Use whichever is higher so live telemetry does not regress between flushes.
                report.processed_items = Math.max(
                  flushedProcessedItems,
                  processedItems,
                );
                report.failed_items = Math.max(flushedFailedItems, failedItems);

                const finalized = completed + failed;
                const completedTotal = cycleCompletedBase + completed;
                const failedTotal = cycleFailedBase + failed;
                const line = formatModeProgressLine({
                  mode: "desktop-bullmq",
                  completed: finalized,
                  total: expected,
                  startedAtMs,
                  text:
                    `jobs_completed=${completed} jobs_failed=${failed} ` +
                    `op_images_processed=${report.processed_items}/${report.claimed_count} ` +
                    `system_images_processed=n/a ` +
                    `items_failed=${report.failed_items}`,
                });
                progress.progress(`queue ${line}`);
                report.completed_jobs = completedTotal;
                report.failed_jobs = failedTotal;
                void publishRunnerStatus({
                  mode: "running",
                  gateReason: "gate=open",
                  pendingSuccessBuffer: pendingSuccessItems.length,
                  pendingErrorBuffer: pendingErrors.length,
                }).catch((error: unknown) => {
                  const message =
                    error instanceof Error ? error.message : String(error);
                  progress.warn(`status_publish_failed message=${message}`);
                });
              },
            });
            break;
          } catch (error: unknown) {
            const message =
              error instanceof Error ? error.message : String(error);
            const isSliceTimeout = message.includes(
              "timeout waiting for queue completion",
            );
            if (!isSliceTimeout) {
              throw error;
            }

            const snapshot = await readQueueSnapshot().catch(() => null);
            const queueDrained =
              snapshot !== null &&
              snapshot.backlog === 0 &&
              snapshot.waiting === 0 &&
              snapshot.active === 0 &&
              snapshot.delayed === 0 &&
              snapshot.paused === 0;

            for (const jobId of jobsById.keys()) {
              const reloaded = await readOpsQueueJobById(queue, jobId);
              if (!reloaded) {
                continue;
              }
              const state = await reloaded.getState();
              if (state === "completed") {
                seenCompletedJobIds.add(jobId);
              } else if (state === "failed") {
                seenFailedJobIds.add(jobId);
              }
            }

            const finalizedByState =
              seenCompletedJobIds.size + seenFailedJobIds.size;
            const nearCompleteByState =
              finalizedByState >= queuedJobs.length - 1;

            if (queueDrained && nearCompleteByState) {
              progress.warn(
                `completion_wait_reconcile queue_drained=true finalized_by_state=${finalizedByState}/${queuedJobs.length} resolving_with_state=true`,
              );
              completion = {
                completedJobIds: [...seenCompletedJobIds],
                failedJobIds: [...seenFailedJobIds],
              };
              break;
            }
          }
        }

        progress.phase("collecting results and applying writeback");

        for (const jobId of completion.completedJobIds) {
          seenCompletedJobIds.add(jobId);
        }
        for (const jobId of completion.failedJobIds) {
          seenFailedJobIds.add(jobId);
        }

        await enqueueHarvestCycle("finalize", false);
        await enqueueHarvestCycle("final-pass", true);

        // Final job counts should come from harvested results so they remain
        // accurate even if queue event progress callbacks were sparse/stale.
        let completedFromHarvest = 0;
        let failedFromHarvest = 0;
        for (const row of report.jobs) {
          if (row.state === "completed") {
            completedFromHarvest += 1;
          } else {
            failedFromHarvest += 1;
          }
        }
        if (completedFromHarvest + failedFromHarvest > 0) {
          report.completed_jobs = completedFromHarvest;
          report.failed_jobs = failedFromHarvest;
        }

        report.processed_items = flushedProcessedItems;
        report.failed_items = flushedFailedItems;
        lastCycleFeedback = {
          claimedCount: claimedItems.length,
          processedItems: Math.max(
            0,
            report.processed_items - cycleProcessedStart,
          ),
          failedItems: Math.max(0, report.failed_items - cycleFailedStart),
          durationSec: Math.max(1, (Date.now() - cycleStartedAtMs) / 1000),
        };
        progress.info(
          `cycle_feedback claimed=${lastCycleFeedback.claimedCount} processed=${lastCycleFeedback.processedItems} failed=${lastCycleFeedback.failedItems} duration_sec=${roundToOne(lastCycleFeedback.durationSec)}`,
        );
        await publishRunnerStatus({
          mode: "done",
          gateReason: "gate=open",
          pendingSuccessBuffer: pendingSuccessItems.length,
          pendingErrorBuffer: pendingErrors.length,
        });

        if (continuousMode) {
          progress.done(
            `cycle_complete claimed_total=${report.claimed_count} queued_total=${report.queued_count} processed_total=${report.processed_items} failed_total=${report.failed_items}`,
          );
          if (startupRampActive) {
            rampCyclesRemaining = Math.max(0, rampCyclesRemaining - 1);
          }
          await sleepMs(idleSleepMs);
          continue;
        }

        break;
      } finally {
        if (periodicFlushTimer) {
          clearInterval(periodicFlushTimer);
        }
      }
    }

    report.finished_at = new Date().toISOString();
    const imagesRead = allSuccessItems.length;
    const imagesProcessed = report.processed_items;
    const imagesStored = countWhere(
      allSuccessItems,
      (row) => row.stored_status_on_s3 === "uploaded",
    );
    const bytesRead = sumNumberField(
      allSuccessItems,
      (row) => row.source_bytes,
    );
    const bytesProcessed = sumNumberField(
      allSuccessItems,
      (row) => row.transformed_bytes,
    );
    const bytesSent = sumNumberField(allSuccessItems, (row) =>
      row.stored_status_on_s3 === "uploaded" ? row.transformed_bytes : 0,
    );

    const fetchLatencies = allSuccessItems.map((row) => row.fetch_elapsed_ms);
    const transformLatencies = allSuccessItems.map(
      (row) => row.transform_elapsed_ms,
    );
    const uploadLatencies = allSuccessItems.map((row) => row.upload_elapsed_ms);
    const itemEndToEndLatencies = allSuccessItems.map(
      (row) =>
        Number(row.fetch_elapsed_ms || 0) +
        Number(row.transform_elapsed_ms || 0) +
        Number(row.upload_elapsed_ms || 0),
    );
    const jobLatencies = report.jobs
      .map((row) => row.elapsed_ms)
      .filter((value): value is number => Number.isFinite(value as number));

    report.summary = {
      elapsed_ms: Date.now() - startedAtMs,
      claimed_count: report.claimed_count,
      queued_count: report.queued_count,
      completed_jobs: report.completed_jobs,
      failed_jobs: report.failed_jobs,
      processed_items: report.processed_items,
      failed_items: report.failed_items,
      completion_pct:
        report.claimed_count > 0
          ? Math.round((report.processed_items / report.claimed_count) * 1000) /
            10
          : 0,
      throughput_images_per_minute:
        Date.now() > startedAtMs
          ? roundToOne(
              report.processed_items /
                Math.max(1 / 60, (Date.now() - startedAtMs) / 60000),
            )
          : 0,
      source_network_mode_counts: countItemsByNetworkMode(allSuccessItems),
      stored_status_counts: countItemsByStoredStatus(allSuccessItems),
      io_stats: {
        images_read: imagesRead,
        bytes_read: bytesRead,
        images_processed: imagesProcessed,
        images_stored: imagesStored,
        bytes_processed: bytesProcessed,
        bytes_sent: bytesSent,
      },
      latency_ms: {
        fetch: toLatencySummary(fetchLatencies),
        transform: toLatencySummary(transformLatencies),
        upload: toLatencySummary(uploadLatencies),
        item_end_to_end: toLatencySummary(itemEndToEndLatencies),
        job_elapsed: toLatencySummary(jobLatencies),
      },
      error_code_counts: countErrorsByCode(allErrors),
    };

    const reportPath = resolve(
      process.cwd(),
      `.tmp/reports/image-processing-bullmq-run-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
    );

    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

    process.stdout.write("image_processing_bullmq_complete\n");
    process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\n`);
    process.stdout.write(`report_path=${reportPath}\n`);
    progress.done(
      `completed claimed=${report.claimed_count} processed=${report.processed_items} failed=${report.failed_items}`,
    );
  } finally {
    clearInterval(heartbeat);
    await closeWithTimeout("queue_runtime_close", queueRuntime.close());
    await closeWithTimeout("pool_end", pool.end());
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : null;
  process.stderr.write(
    `${chalk.gray(stamp())} ${chalk.bgBlue.white.bold(" image-processing-bullmq ")} ${chalk.bgRed.white.bold(" fail ")} ${chalk.red(message)}\n`,
  );
  if (stack) {
    process.stderr.write(`${stack}\n`);
  }
  process.stderr.write(`run-image-processing-bullmq failed: ${message}\n`);
  process.exit(1);
});
