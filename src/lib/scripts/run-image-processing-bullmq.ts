import "@/core/tooling/env/load-env-profile";

import { Job } from "bullmq";
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
  IMAGE_QUEUE_NAME,
  createRedisConnection,
  type ImageProcessingQueueJob,
} from "../../workers/image-queue";
import {
  applyFailureRows,
  applySuccessRows,
  claimPendingImageRows,
  createOpsDbPool,
  createOpsQueueRuntime,
  enqueueOpsImageJobsForOperation,
  readOpsControlSnapshot,
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

type RunnerOptions = {
  targetCount: number;
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
    "  npm run workers:image:desktop -- [--target-count 1] [--dry-run-cloud true]",
    "",
    "Options:",
    "  --target-count <n>            Number of rows to claim from postgres (default 1)",
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

  return {
    targetCount: parsePositiveInt(values.get("target-count"), 1),
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
  const controlConnection = createRedisConnection();
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

  const controlSnapshot = await readOpsControlSnapshot(controlConnection);
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
    await writeOpsRunnerStatus(
      {
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
        updatedAt: new Date().toISOString(),
      },
      controlConnection,
    );
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
  }> => {
    const [queueSnapshot, pausedState, freshControlSnapshot] =
      await Promise.all([
        readQueueSnapshot(),
        readOpsQueuePausedState(),
        readOpsControlSnapshot(controlConnection),
      ]);

    controlSettings = freshControlSnapshot.settings;
    const freshWorkers = Number(freshControlSnapshot.infra?.workersRunning);
    workersRunning =
      Number.isFinite(freshWorkers) && freshWorkers > 0 ? freshWorkers : 0;

    const liveGate = evaluateLiveGate({
      settings: controlSettings,
      workersRunning,
      queueBacklog: queueSnapshot.backlog,
    });

    let gateReason =
      liveGate === "live=gate_open"
        ? "gate=open"
        : liveGate.replace(/^live=/, "");
    if (pausedState) {
      gateReason = "queue_globally_paused";
    }
    if (controlSettings.desiredMode !== "run") {
      gateReason = `desired_mode=${controlSettings.desiredMode} not run`;
    }

    return {
      queueSnapshot,
      queueGloballyPaused: pausedState,
      gateReason,
    };
  };

  let {
    queueSnapshot: initialQueueSnapshot,
    queueGloballyPaused,
    gateReason,
  } = await computeGateState();

  progress.info(
    `startup_stats queue_waiting=${initialQueueSnapshot.waiting} queue_active=${initialQueueSnapshot.active} queue_delayed=${initialQueueSnapshot.delayed} queue_paused=${initialQueueSnapshot.paused} queue_backlog=${initialQueueSnapshot.backlog} workers_running=${workersRunning} desired_mode=${controlSettings.desiredMode} queue_globally_paused=${queueGloballyPaused}`,
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
    await publishRunnerStatus({ mode: "idle", gateReason });
  }

  progress.done(
    `runner gate opened queue_backlog=${initialQueueSnapshot.backlog} workers_running=${workersRunning}`,
  );

  const heartbeat = setInterval(
    () => {
      const finalized = report.completed_jobs + report.failed_jobs;
      const total = Math.max(report.queued_count, report.claimed_count);
      const line = formatModeProgressLine({
        mode: "desktop-bullmq",
        completed: finalized,
        total,
        startedAtMs,
        text:
          `operation_images_processed=${report.processed_items}/${report.claimed_count} ` +
          `jobs_completed=${report.completed_jobs} jobs_failed=${report.failed_jobs} ` +
          `items_failed=${report.failed_items}`,
      });
      void readQueueSnapshot()
        .then((snapshot) => {
          progress.progress(
            `heartbeat ${line} queue_pending=${snapshot.backlog}`,
          );
        })
        .catch(() => {
          progress.progress(`heartbeat ${line}`);
        });
    },
    Math.max(5, options.heartbeatSeconds) * 1000,
  );

  try {
    const requestedTargetCount = Math.max(1, options.targetCount);
    const liveQueueBacklog = initialQueueSnapshot.backlog;
    const shouldRefill = liveQueueBacklog < controlSettings.refillLowWatermark;
    const refillGap = shouldRefill
      ? Math.max(0, controlSettings.refillTargetBacklog - liveQueueBacklog)
      : 0;
    const policyClaimCap = Math.max(1, controlSettings.maxClaimPerCycle);
    const effectiveTargetCount = Math.max(
      0,
      Math.min(requestedTargetCount, policyClaimCap, refillGap),
    );

    progress.info(
      `queue_preflight waiting=${initialQueueSnapshot.waiting} active=${initialQueueSnapshot.active} delayed=${initialQueueSnapshot.delayed} paused=${initialQueueSnapshot.paused} backlog=${liveQueueBacklog}`,
    );
    progress.info(
      `claim_policy requested_target=${requestedTargetCount} refill_low=${controlSettings.refillLowWatermark} refill_target=${controlSettings.refillTargetBacklog} should_refill=${shouldRefill} max_claim_cycle=${policyClaimCap} effective_target=${effectiveTargetCount}`,
    );

    if (effectiveTargetCount <= 0) {
      progress.done("queue is above refill threshold; no new claims this run");
      return;
    }

    progress.phase("claiming rows from postgres");
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
    report.claimed_count = claimedItems.length;

    if (claimedItems.length === 0) {
      progress.done("no rows claimed; exiting");
      return;
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
    report.queued_count = queuedJobs.length;
    const postEnqueueSnapshot = await readQueueSnapshot();
    progress.info(
      `queued_jobs=${queuedJobs.length} queue=${IMAGE_QUEUE_NAME} operation_target_images=${report.claimed_count} queue_pending_after_enqueue=${postEnqueueSnapshot.backlog} retention=${jobRetentionCount}`,
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

    async function flushPendingWrites(reason: string): Promise<void> {
      if (pendingSuccessItems.length === 0 && pendingErrors.length === 0) {
        return;
      }

      const successBatch = pendingSuccessItems.splice(
        0,
        pendingSuccessItems.length,
      );
      const errorBatch = pendingErrors.splice(0, pendingErrors.length);
      const writeStats = await updateSuccessRows(pool, successBatch);
      await updateFailureRows(pool, errorBatch, "bullmq_dispatch");

      allSuccessItems.push(...successBatch);
      allErrors.push(...errorBatch);

      flushedProcessedItems += writeStats.uploadedCount;
      flushedFailedItems += errorBatch.length + writeStats.notUploadedCount;
      report.processed_items = flushedProcessedItems;
      report.failed_items = flushedFailedItems;
      flushBatchCount += 1;
      lastFlushAt = new Date().toISOString();

      progress.info(
        `writeback_flush reason=${reason} batch=${flushBatchCount} success_items=${successBatch.length} errors=${errorBatch.length} uploaded=${writeStats.uploadedCount} withheld=${writeStats.notUploadedCount} totals_processed=${flushedProcessedItems} totals_failed=${flushedFailedItems}`,
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

        const reloaded = await Job.fromId(queue, jobId);
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

        const modes = [...new Set(items.map((row) => row.source_network_mode))]
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
        void enqueueHarvestCycle("periodic", false).catch((error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          progress.warn(`periodic_flush_failed message=${message}`);
        });
      }, periodicFlushIntervalMs);

      progress.phase("waiting for worker completion");
      await publishRunnerStatus({
        mode: "running",
        gateReason: "gate=open",
        pendingSuccessBuffer: pendingSuccessItems.length,
        pendingErrorBuffer: pendingErrors.length,
      });
      const completion = await waitForOpsRunCompletion({
        queueEvents,
        queueName: IMAGE_QUEUE_NAME,
        expectedJobs: queuedJobs.length,
        timeoutMs: Math.max(1, options.waitTimeoutSeconds) * 1000,
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
          const line = formatModeProgressLine({
            mode: "desktop-bullmq",
            completed: finalized,
            total: expected,
            startedAtMs,
            text:
              `jobs_completed=${completed} jobs_failed=${failed} ` +
              `operation_images_processed=${report.processed_items}/${report.claimed_count} ` +
              `items_failed=${report.failed_items}`,
          });
          progress.progress(`queue ${line}`);
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

      progress.phase("collecting results and applying writeback");

      for (const jobId of completion.completedJobIds) {
        seenCompletedJobIds.add(jobId);
      }
      for (const jobId of completion.failedJobIds) {
        seenFailedJobIds.add(jobId);
      }

      await enqueueHarvestCycle("finalize", false);
      await enqueueHarvestCycle("final-pass", true);

      report.processed_items = flushedProcessedItems;
      report.failed_items = flushedFailedItems;
      await publishRunnerStatus({
        mode: "done",
        gateReason: "gate=open",
        pendingSuccessBuffer: pendingSuccessItems.length,
        pendingErrorBuffer: pendingErrors.length,
      });
    } finally {
      if (periodicFlushTimer) {
        clearInterval(periodicFlushTimer);
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
    await closeWithTimeout("control_connection_quit", controlConnection.quit());
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
