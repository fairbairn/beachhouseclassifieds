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
  continuous: boolean;
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

type HarvestBudget = {
  maxJobs?: number;
  maxMs?: number;
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
  const maxBacklog = Math.max(500, Number(settings.maxQueueBacklog) || 10);

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
    "  --continuous true|false      Keep cycling and refilling as queue depletes (default true)",
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
    targetCount: (() => {
      const parsed = parseOptionalPositiveInt(values.get("target-count"));
      if (parsed === null) {
        return null;
      }
      return Math.max(1, parsed);
    })(),
    continuous: parseBoolean(values.get("continuous"), true),
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
): Promise<{
  uploadedCount: number;
  notUploadedCount: number;
  missingCount: number;
  missingWorkIds: string[];
}> {
  return applySuccessRows(pool, items);
}

async function updateFailureRows(
  pool: Pool,
  errors: ImageProcessingTaskError[],
  marker: string,
): Promise<{ missingCount: number; missingWorkIds: string[] }> {
  return applyFailureRows(pool, errors, marker);
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

  if (options.targetCount !== null && options.targetCount < 500) {
    progress.warn(
      `target_count_cap_active value=${options.targetCount} (this hard cap limits enqueue depth per refill cycle)`,
    );
  }

  const allErrors: ImageProcessingTaskError[] = [];
  const allSuccessItems: ImageProcessingItemResult[] = [];
  const legacyReconciledJobIds = new Set<string>();
  let legacyWritebackBatchCount = 0;
  let flushBatchCount = 0;
  let lastFlushAt: string | null = null;
  let pendingSuccessBufferCount = 0;
  let pendingErrorBufferCount = 0;
  let throughputLastSampleAtMs = startedAtMs;
  let throughputLastProcessedItems = 0;
  let throughputEwmaIpm = 0;

  const summarizeLivePerformance = (): {
    throughputImagesPerMinute: number;
    avgFetchMs: number;
    avgTransformMs: number;
    avgUploadMs: number;
    avgEndToEndMs: number;
  } => {
    const nowMs = Date.now();
    const elapsedSeconds = Math.max(
      0.001,
      (nowMs - throughputLastSampleAtMs) / 1000,
    );
    const processedDelta = Math.max(
      0,
      report.processed_items - throughputLastProcessedItems,
    );
    const instantIpm = (processedDelta / elapsedSeconds) * 60;
    throughputEwmaIpm =
      throughputEwmaIpm <= 0
        ? instantIpm
        : throughputEwmaIpm * 0.65 + instantIpm * 0.35;
    throughputLastSampleAtMs = nowMs;
    throughputLastProcessedItems = report.processed_items;
    const throughputImagesPerMinute =
      Math.round(Math.max(0, throughputEwmaIpm) * 100) / 100;

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

  const reconcileLegacyQueueJobs = async (
    reason: string,
    maxPages: number,
  ): Promise<void> => {
    const pageSize = 200;
    const scanParallelPages = 5;
    const dbBatchSize = 100;
    const successItems: ImageProcessingItemResult[] = [];
    const failedItems: ImageProcessingTaskError[] = [];
    let scannedJobs = 0;
    let reconciledJobs = 0;

    progress.info(
      `writeback_legacy_scan_start reason=${reason} max_pages=${Math.max(1, maxPages)} page_size=${pageSize}`,
    );

    const totalPages = Math.max(1, maxPages);
    let reachedEnd = false;
    for (
      let pageStart = 0;
      pageStart < totalPages && !reachedEnd;
      pageStart += scanParallelPages
    ) {
      const pageIndexes = Array.from(
        { length: Math.min(scanParallelPages, totalPages - pageStart) },
        (_, offset) => pageStart + offset,
      );

      const pagePayloads = await Promise.all(
        pageIndexes.map(async (pageIndex) => {
          const start = pageIndex * pageSize;
          const end = start + pageSize - 1;
          const [completedJobs, failedJobs] = await Promise.all([
            queue.getJobs(["completed"], start, end),
            queue.getJobs(["failed"], start, end),
          ]);
          return { pageIndex, start, end, completedJobs, failedJobs };
        }),
      );

      pagePayloads.sort((left, right) => left.pageIndex - right.pageIndex);

      for (const payload of pagePayloads) {
        const { pageIndex, start, end, completedJobs, failedJobs } = payload;

        progress.info(
          `writeback_legacy_scan_page reason=${reason} page=${pageIndex + 1} range=${start}-${end} completed_rows=${completedJobs.length} failed_rows=${failedJobs.length}`,
        );

        if (completedJobs.length === 0 && failedJobs.length === 0) {
          if (scannedJobs >= 1000) {
            progress.warn(
              `writeback_legacy_scan_retention_cap reason=${reason} scanned_jobs=${scannedJobs} note=redis_history_likely_trimmed_older_completed_jobs_unrecoverable`,
            );
          }
          reachedEnd = true;
          break;
        }

        scannedJobs += completedJobs.length + failedJobs.length;

        for (const job of completedJobs) {
          const jobId = String(job.id || "");
          if (!jobId || legacyReconciledJobIds.has(jobId)) {
            continue;
          }

          const result = (job.returnvalue || {}) as {
            items?: ImageProcessingItemResult[];
            errors?: ImageProcessingTaskError[];
          };
          const items = Array.isArray(result.items) ? result.items : [];
          const errors = Array.isArray(result.errors) ? result.errors : [];
          successItems.push(...items);
          failedItems.push(...errors);
          legacyReconciledJobIds.add(jobId);
          reconciledJobs += 1;
        }

        for (const job of failedJobs) {
          const jobId = String(job.id || "");
          if (!jobId || legacyReconciledJobIds.has(jobId)) {
            continue;
          }

          failedItems.push({
            work_id: String(job.data?.workId || ""),
            source_image_url: String(job.data?.sourceImageUrl || ""),
            code: "worker_error",
            message: String(job.failedReason || "job failed without reason"),
          });
          legacyReconciledJobIds.add(jobId);
          reconciledJobs += 1;
        }
      }
    }

    if (successItems.length === 0 && failedItems.length === 0) {
      progress.info(
        `writeback_legacy_scan reason=${reason} scanned_jobs=${scannedJobs} reconciled_jobs=${reconciledJobs} success_items=0 errors=0 status=noop`,
      );
      return;
    }

    const maxRows = Math.max(successItems.length, failedItems.length);
    for (let index = 0; index < maxRows; index += dbBatchSize) {
      const successBatch = successItems.slice(index, index + dbBatchSize);
      const failedBatch = failedItems.slice(index, index + dbBatchSize);

      let writeStats: {
        uploadedCount: number;
        notUploadedCount: number;
        missingCount: number;
        missingWorkIds: string[];
      } = {
        uploadedCount: 0,
        notUploadedCount: 0,
        missingCount: 0,
        missingWorkIds: [],
      };
      if (!options.dryRunCloud) {
        writeStats = await updateSuccessRows(pool, successBatch);
        const failureStats = await updateFailureRows(
          pool,
          failedBatch,
          "bullmq_legacy_reconcile",
        );
        writeStats.missingCount += failureStats.missingCount;
        writeStats.missingWorkIds.push(...failureStats.missingWorkIds);
      }

      allSuccessItems.push(...successBatch);
      allErrors.push(...failedBatch);
      report.processed_items += successBatch.length;
      report.failed_items += failedBatch.length;
      legacyWritebackBatchCount += 1;
      lastFlushAt = new Date().toISOString();

      progress.info(
        `writeback_legacy_batch reason=${reason} batch=${legacyWritebackBatchCount} chunk_size=${dbBatchSize} success_items=${successBatch.length} errors=${failedBatch.length} uploaded=${writeStats.uploadedCount} withheld=${writeStats.notUploadedCount} missing=${writeStats.missingCount}`,
      );
      if (writeStats.missingCount > 0) {
        const sample = writeStats.missingWorkIds.slice(0, 5).join(",") || "n/a";
        progress.warn(
          `writeback_legacy_missing_ids reason=${reason} batch=${legacyWritebackBatchCount} count=${writeStats.missingCount} sample=${sample}`,
        );
      }
    }

    progress.info(
      `writeback_legacy_scan reason=${reason} scanned_jobs=${scannedJobs} reconciled_jobs=${reconciledJobs} success_items=${successItems.length} errors=${failedItems.length} status=flushed`,
    );
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
        throughputImagesPerMinute: perf.throughputImagesPerMinute,
        avgFetchMs: perf.avgFetchMs,
        avgTransformMs: perf.avgTransformMs,
        avgUploadMs: perf.avgUploadMs,
        avgEndToEndMs: perf.avgEndToEndMs,
        updatedAt: new Date().toISOString(),
      },
      undefined,
      {
        ingestTrendSamples: false,
      },
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
    const workerGateBlocked = liveGate.startsWith("live=workers_running=");
    const allowOptimisticRefillWhenQueueEmpty =
      workerGateBlocked &&
      controlSettings.desiredMode === "run" &&
      controlSettings.enqueueEnabled &&
      !moduleVisiblePaused &&
      queueSnapshot.backlog <= 0;
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
    if (liveGate !== "live=gate_open" && !allowOptimisticRefillWhenQueueEmpty) {
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

  progress.phase("runner telemetry warmup: pre-run db catch-up");
  await reconcileLegacyQueueJobs("pre-run", 200).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    progress.warn(`writeback_legacy_failed reason=pre-run message=${message}`);
  });

  progress.phase("runner startup telemetry warmup");
  let { queueSnapshot: initialQueueSnapshot, gateReason } =
    await computeGateState();

  progress.info(
    `startup backlog=${initialQueueSnapshot.backlog} waiting=${initialQueueSnapshot.waiting} active=${initialQueueSnapshot.active} workers=${workersRunning} mode=${controlSettings.desiredMode}`,
  );
  await publishRunnerStatus({ mode: "idle", gateReason });
  if (gateReason !== "gate=open") {
    progress.warn(
      `enqueue_state state=gated reason=${gateReason} backlog=${initialQueueSnapshot.backlog}`,
    );
  } else {
    progress.done(
      `enqueue_state state=open backlog=${initialQueueSnapshot.backlog}`,
    );
  }
  const openGateReason = options.dryRunCloud
    ? "gate=open:dry-run-cloud:db-writeback-skipped"
    : "gate=open";

  const heartbeat = setInterval(
    () => {
      void Promise.allSettled([readQueueSnapshot()])
        .then((results) => {
          const queueResult = results[0];
          const snapshot =
            queueResult.status === "fulfilled" ? queueResult.value : null;
          const pendingWriteback = pendingWritebackCount();
          if (snapshot) {
            progress.progress(
              `heartbeat backlog=${snapshot.backlog} waiting=${snapshot.waiting} active=${snapshot.active} workers=${workersRunning} processed=${report.processed_items} failed_items=${report.failed_items} pending_writeback=${pendingWriteback}`,
            );
          } else {
            progress.progress(
              `heartbeat backlog=n/a workers=${workersRunning} processed=${report.processed_items} failed_items=${report.failed_items} pending_writeback=${pendingWriteback}`,
            );
          }
          void publishRunnerStatus({
            mode: "running",
            gateReason: openGateReason,
            pendingSuccessBuffer: pendingSuccessBufferCount,
            pendingErrorBuffer: pendingErrorBufferCount,
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

  const continuousMode = options.continuous;
  const idleSleepMs = Math.max(
    750,
    Math.min(3000, options.heartbeatSeconds * 400),
  );

  const pendingCompletedEventJobIds = new Set<string>();
  const pendingFailedEventJobIds = new Set<string>();
  const handledEventJobIds = new Set<string>();
  const eventWritebackIntervalMs = clampInt(
    Number(process.env.IMAGE_WRITEBACK_INTERVAL_MS || 1000),
    250,
    10_000,
  );
  const eventWritebackBackpressureThreshold = clampInt(
    Number(process.env.IMAGE_WRITEBACK_BACKPRESSURE_THRESHOLD || 250),
    25,
    10_000,
  );
  const eventWritebackInspectChunkSize = clampInt(
    Number(process.env.IMAGE_WRITEBACK_INSPECT_CHUNK_SIZE || 50),
    10,
    250,
  );
  let eventWritebackBatchCount = 0;
  const enableEventSweepFallback =
    String(process.env.IMAGE_WRITEBACK_EVENT_SWEEP || "")
      .trim()
      .toLowerCase() === "true";
  let lastEnqueueGateOpen: boolean | null = null;

  const pendingWritebackCount = (): number =>
    pendingCompletedEventJobIds.size + pendingFailedEventJobIds.size;

  const markEventJobHandled = (jobId: string): void => {
    handledEventJobIds.add(jobId);
    pendingCompletedEventJobIds.delete(jobId);
    pendingFailedEventJobIds.delete(jobId);
  };

  const onCompletedEvent = (event: { jobId: string }): void => {
    const jobId = String(event?.jobId || "");
    if (!jobId) {
      return;
    }
    pendingCompletedEventJobIds.add(jobId);
    progress.info(
      `completion_detected state=completed job_id=${jobId} pending_writeback=${pendingWritebackCount()}`,
    );
  };

  const onFailedEvent = (event: { jobId: string }): void => {
    const jobId = String(event?.jobId || "");
    if (!jobId) {
      return;
    }
    pendingFailedEventJobIds.add(jobId);
    progress.info(
      `completion_detected state=failed job_id=${jobId} pending_writeback=${pendingWritebackCount()}`,
    );
  };

  queueEvents.on("completed", onCompletedEvent);
  queueEvents.on("failed", onFailedEvent);

  const sweepRecentFinalizedJobsForWriteback = async (
    reason: string,
  ): Promise<void> => {
    const pageSize = 200;
    const [completedJobs, failedJobs] = await Promise.all([
      queue.getJobs(["completed"], 0, pageSize - 1),
      queue.getJobs(["failed"], 0, pageSize - 1),
    ]);

    let addedCompleted = 0;
    let addedFailed = 0;

    for (const job of completedJobs) {
      const jobId = String(job.id || "");
      if (!jobId || handledEventJobIds.has(jobId)) {
        continue;
      }
      if (!pendingCompletedEventJobIds.has(jobId)) {
        pendingCompletedEventJobIds.add(jobId);
        addedCompleted += 1;
      }
    }

    for (const job of failedJobs) {
      const jobId = String(job.id || "");
      if (!jobId || handledEventJobIds.has(jobId)) {
        continue;
      }
      if (!pendingFailedEventJobIds.has(jobId)) {
        pendingFailedEventJobIds.add(jobId);
        addedFailed += 1;
      }
    }

    if (addedCompleted > 0 || addedFailed > 0) {
      progress.info(
        `writeback_event_sweep reason=${reason} added_completed=${addedCompleted} added_failed=${addedFailed} pending_completed=${pendingCompletedEventJobIds.size} pending_failed=${pendingFailedEventJobIds.size}`,
      );
    }
  };

  const processEventWriteback = async (reason: string): Promise<void> => {
    let candidateIds = [
      ...pendingCompletedEventJobIds,
      ...pendingFailedEventJobIds,
    ];

    if (enableEventSweepFallback && candidateIds.length === 0) {
      await sweepRecentFinalizedJobsForWriteback(reason).catch(
        (error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          progress.warn(
            `writeback_event_sweep_failed reason=${reason} message=${message}`,
          );
        },
      );
      candidateIds = [
        ...pendingCompletedEventJobIds,
        ...pendingFailedEventJobIds,
      ];
    }

    if (candidateIds.length === 0) {
      return;
    }

    const successItems: ImageProcessingItemResult[] = [];
    const failedItems: ImageProcessingTaskError[] = [];

    for (
      let candidateIndex = 0;
      candidateIndex < candidateIds.length;
      candidateIndex += eventWritebackInspectChunkSize
    ) {
      const candidateChunk = candidateIds.slice(
        candidateIndex,
        candidateIndex + eventWritebackInspectChunkSize,
      );

      const chunkRows = await Promise.all(
        candidateChunk.map(async (jobId) => {
          if (handledEventJobIds.has(jobId)) {
            markEventJobHandled(jobId);
            return null;
          }

          const job = await readOpsQueueJobById(queue, jobId);
          if (!job) {
            markEventJobHandled(jobId);
            return null;
          }

          const state = await job.getState();
          return {
            jobId,
            state,
            job,
          };
        }),
      );

      for (const row of chunkRows) {
        if (!row) {
          continue;
        }

        const { jobId, state, job } = row;
        if (state === "completed") {
          const result = (job.returnvalue || {}) as {
            items?: ImageProcessingItemResult[];
            errors?: ImageProcessingTaskError[];
          };
          const items = Array.isArray(result.items) ? result.items : [];
          const errors = Array.isArray(result.errors) ? result.errors : [];
          successItems.push(...items);
          failedItems.push(...errors);
          markEventJobHandled(jobId);
          continue;
        }

        if (state === "failed") {
          failedItems.push({
            work_id: String(job.data?.workId || ""),
            source_image_url: String(job.data?.sourceImageUrl || ""),
            code: "worker_error",
            message: String(job.failedReason || "job failed without reason"),
          });
          markEventJobHandled(jobId);
        }
      }
    }

    const batchSize = 100;
    const maxRows = Math.max(successItems.length, failedItems.length);
    const flushStartBatch = eventWritebackBatchCount;
    let flushUploadedCount = 0;
    let flushWithheldCount = 0;
    let flushMissingCount = 0;
    for (let index = 0; index < maxRows; index += batchSize) {
      const successBatch = successItems.slice(index, index + batchSize);
      const failedBatch = failedItems.slice(index, index + batchSize);

      let writeStats: {
        uploadedCount: number;
        notUploadedCount: number;
        missingCount: number;
        missingWorkIds: string[];
      } = {
        uploadedCount: 0,
        notUploadedCount: 0,
        missingCount: 0,
        missingWorkIds: [],
      };
      if (!options.dryRunCloud) {
        writeStats = await updateSuccessRows(pool, successBatch);
        const failureStats = await updateFailureRows(
          pool,
          failedBatch,
          "bullmq_event_writeback",
        );
        writeStats.missingCount += failureStats.missingCount;
        writeStats.missingWorkIds.push(...failureStats.missingWorkIds);
      }

      allSuccessItems.push(...successBatch);
      allErrors.push(...failedBatch);
      report.processed_items += successBatch.length;
      report.failed_items += failedBatch.length;
      flushUploadedCount += writeStats.uploadedCount;
      flushWithheldCount += writeStats.notUploadedCount;
      flushMissingCount += writeStats.missingCount;
      eventWritebackBatchCount += 1;
      lastFlushAt = new Date().toISOString();

      if (writeStats.missingCount > 0) {
        const sample = writeStats.missingWorkIds.slice(0, 5).join(",") || "n/a";
        progress.warn(
          `writeback_event_missing_ids reason=${reason} batch=${eventWritebackBatchCount} count=${writeStats.missingCount} sample=${sample}`,
        );
      }
    }

    const flushedBatches = eventWritebackBatchCount - flushStartBatch;
    progress.info(
      `writeback_applied reason=${reason} jobs=${candidateIds.length} batches=${flushedBatches} success_items=${successItems.length} errors=${failedItems.length} uploaded=${flushUploadedCount} withheld=${flushWithheldCount} missing=${flushMissingCount}`,
    );
  };

  let eventWritebackDrainInFlight = false;
  const eventWritebackTimer = setInterval(() => {
    if (eventWritebackDrainInFlight) {
      return;
    }
    eventWritebackDrainInFlight = true;
    void processEventWriteback("interval")
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        progress.warn(
          `writeback_event_failed reason=interval message=${message}`,
        );
      })
      .finally(() => {
        eventWritebackDrainInFlight = false;
      });
  }, eventWritebackIntervalMs);

  try {
    while (true) {
      const nextGateState = await computeGateState();
      initialQueueSnapshot = nextGateState.queueSnapshot;
      gateReason = nextGateState.gateReason;
      const enqueueGateOpen = gateReason === "gate=open";
      if (
        lastEnqueueGateOpen === null ||
        lastEnqueueGateOpen !== enqueueGateOpen
      ) {
        progress.info(
          `enqueue_state state=${enqueueGateOpen ? "open" : "gated"} reason=${gateReason} backlog=${initialQueueSnapshot.backlog}`,
        );
        lastEnqueueGateOpen = enqueueGateOpen;
      }
      if (!enqueueGateOpen) {
        await processEventWriteback("enqueue-gated").catch((error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          progress.warn(
            `writeback_event_failed reason=enqueue-gated message=${message}`,
          );
        });
      }

      const requestedTargetCap = options.targetCount;
      const liveQueueBacklog = initialQueueSnapshot.backlog;
      const workerCount = Math.max(1, workersRunning);
      const fixedBatchMode = requestedTargetCap !== null;
      const basePolicy = deriveRefillPolicy(controlSettings);
      const workerTargetBacklog = Math.max(100, workerCount * 20);
      const refillTarget = fixedBatchMode
        ? Math.max(1, requestedTargetCap)
        : clampInt(
            Math.max(basePolicy.refillTarget, workerTargetBacklog),
            1,
            basePolicy.maxBacklog,
          );
      const refillLow = fixedBatchMode
        ? Math.max(1, Math.floor(refillTarget / 2))
        : clampInt(
            Math.max(basePolicy.refillLow, Math.floor(refillTarget * 0.6)),
            1,
            refillTarget - 1,
          );
      const shouldRefill = liveQueueBacklog < refillLow;
      const refillGap = shouldRefill
        ? fixedBatchMode
          ? refillTarget
          : Math.max(0, refillTarget - liveQueueBacklog)
        : 0;
      const safetyMaxClaimCap = Math.max(500, controlSettings.maxClaimPerCycle);
      const policyTargetCount = fixedBatchMode
        ? refillGap
        : Math.min(refillGap, safetyMaxClaimCap);
      const computedEffectiveTargetCount =
        requestedTargetCap === null
          ? policyTargetCount
          : shouldRefill
            ? requestedTargetCap
            : 0;
      const effectiveTargetCount = enqueueGateOpen
        ? computedEffectiveTargetCount
        : 0;

      const pendingBeforeClaim = pendingWritebackCount();
      if (pendingBeforeClaim >= eventWritebackBackpressureThreshold) {
        progress.warn(
          `writeback_backpressure pending_writeback=${pendingBeforeClaim} threshold=${eventWritebackBackpressureThreshold} action=drain_before_claim`,
        );
        await processEventWriteback("backpressure").catch((error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          progress.warn(
            `writeback_event_failed reason=backpressure message=${message}`,
          );
        });
        await sleepMs(250);
        if (!continuousMode) {
          break;
        }
        continue;
      }

      if (effectiveTargetCount <= 0) {
        const skipReason = !enqueueGateOpen
          ? `enqueue_gated:${gateReason}`
          : shouldRefill
            ? "refill_blocked_by_target_cap"
            : "queue_at_or_above_refill_low";
        await processEventWriteback("no-claim").catch((error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          progress.warn(
            `writeback_event_failed reason=no-claim message=${message}`,
          );
        });
        await publishRunnerStatus({ mode: "idle", gateReason: skipReason });
        const refillProbeSleepMs = shouldRefill ? 500 : idleSleepMs;
        await sleepMs(refillProbeSleepMs);
        if (!continuousMode) {
          break;
        }
        continue;
      }

      progress.phase("claiming rows from postgres");
      const cycleStartedAtMs = Date.now();
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

      if (claimedItems.length === 0) {
        await processEventWriteback("no-rows-claimed").catch(
          (error: unknown) => {
            const message =
              error instanceof Error ? error.message : String(error);
            progress.warn(
              `writeback_event_failed reason=no-rows-claimed message=${message}`,
            );
          },
        );
        await publishRunnerStatus({
          mode: "idle",
          gateReason: "no_rows_claimed",
        });
        await sleepMs(idleSleepMs);
        if (!continuousMode) {
          break;
        }
        continue;
      }

      progress.phase("enqueueing bullmq jobs");
      const jobRetentionCount = Math.max(10000, effectiveTargetCount * 20);
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
        `enqueue_performed jobs=${queuedJobs.length} claimed=${claimedItems.length} backlog_after=${postEnqueueSnapshot.backlog}`,
      );

      if (continuousMode) {
        // In continuous mode, avoid blocking on per-cycle exhaustive
        // finalized-job harvesting. Event-driven writeback drains results
        // asynchronously, while this loop keeps queue refill responsive.
        await processEventWriteback("continuous-post-enqueue").catch(
          (error: unknown) => {
            const message =
              error instanceof Error ? error.message : String(error);
            progress.warn(
              `writeback_event_failed reason=continuous-post-enqueue message=${message}`,
            );
          },
        );
        await publishRunnerStatus({
          mode: "running",
          gateReason: openGateReason,
          pendingSuccessBuffer: pendingSuccessBufferCount,
          pendingErrorBuffer: pendingErrorBufferCount,
        }).catch((error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          progress.warn(`status_publish_failed message=${message}`);
        });
        await sleepMs(250);
        continue;
      }

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
      let expectedJobsInCycle = queuedJobs.length;
      let cycleClaimedCount = claimedItems.length;
      let lastTopUpAtMs = 0;
      let completedAtLastTopUp = 0;

      const pendingSuccessItems: ImageProcessingItemResult[] = [];
      const pendingErrors: ImageProcessingTaskError[] = [];
      pendingSuccessBufferCount = 0;
      pendingErrorBufferCount = 0;
      const cycleProcessedStartTotal = report.processed_items;
      const cycleFailedStartTotal = report.failed_items;
      let flushedProcessedItems = 0;
      let flushedFailedItems = 0;
      const cycleCompletedBase = report.completed_jobs;
      const cycleFailedBase = report.failed_jobs;
      let flushedWithheldItems = 0;

      const remainingCycleClaimBudget = (): number => {
        if (requestedTargetCap !== null) {
          return Number.MAX_SAFE_INTEGER;
        }
        return Math.max(0, safetyMaxClaimCap - cycleClaimedCount);
      };

      async function maybeTopUpQueue(reason: string): Promise<void> {
        if (!continuousMode) {
          return;
        }

        const nowMs = Date.now();
        const topUpCheckMs = 5000;
        const refillCooldownMs = 30_000;
        if (nowMs - lastTopUpAtMs < topUpCheckMs) {
          return;
        }

        if (lastTopUpAtMs > 0 && nowMs - lastTopUpAtMs < refillCooldownMs) {
          return;
        }

        const finalizedCount = seenCompletedJobIds.size + seenFailedJobIds.size;
        const outstandingCount = Math.max(
          0,
          expectedJobsInCycle - finalizedCount,
        );

        if (requestedTargetCap !== null) {
          const refillChunk = Math.max(1, requestedTargetCap);
          const completionGate = Math.max(1, Math.floor(refillChunk / 2));
          const completedSinceLastTopUp = Math.max(
            0,
            finalizedCount - completedAtLastTopUp,
          );
          const maxOutstanding = refillChunk * 2;

          if (completedSinceLastTopUp < completionGate) {
            return;
          }

          if (outstandingCount >= maxOutstanding) {
            progress.info(
              `queue_topup_skipped reason=${reason} mode=fixed_batch outstanding=${outstandingCount} max_outstanding=${maxOutstanding} completed_since_last=${completedSinceLastTopUp} required_completed=${completionGate}`,
            );
            return;
          }
        }

        if (
          controlSettings.desiredMode !== "run" ||
          !controlSettings.enqueueEnabled
        ) {
          return;
        }

        if (
          controlSettings.requireWorkersForEnqueue &&
          workersRunning < controlSettings.minWorkersToEnqueue
        ) {
          return;
        }

        const snapshot = await readQueueSnapshot();
        if (snapshot.paused > 0) {
          return;
        }

        if (snapshot.backlog >= refillLow) {
          return;
        }

        const claimBudget = remainingCycleClaimBudget();
        if (claimBudget <= 0) {
          return;
        }

        const refillGap = Math.max(0, refillTarget - snapshot.backlog);
        const targetClaimCount = Math.max(
          0,
          requestedTargetCap !== null
            ? Math.min(requestedTargetCap, refillGap, claimBudget)
            : Math.min(refillGap, claimBudget),
        );
        if (targetClaimCount <= 0) {
          return;
        }

        const claimPoolSize = Math.max(
          targetClaimCount,
          Math.min(
            options.claimPoolMax,
            targetClaimCount * options.claimPoolMultiplier,
          ),
        );

        const topUpClaims = await claimPendingRows(
          pool,
          targetClaimCount,
          claimPoolSize,
        );
        if (topUpClaims.length === 0) {
          lastTopUpAtMs = nowMs;
          return;
        }

        const topUpRetention = Math.max(10000, topUpClaims.length * 20);
        const topUpJobs = await enqueueOpsImageJobsForOperation({
          queue,
          operationId,
          claimedItems: topUpClaims,
          options: {
            fetchTimeoutMs: options.fetchTimeoutMs,
            fetchRetryCount: options.fetchRetryCount,
            dryRunCloud: options.dryRunCloud,
            uploadPrefix: options.uploadPrefix,
            jobRetentionCount: topUpRetention,
          },
        });

        cycleClaimedCount += topUpClaims.length;
        expectedJobsInCycle += topUpJobs.length;
        report.claimed_count += topUpClaims.length;
        report.queued_count += topUpJobs.length;
        completedAtLastTopUp = finalizedCount;

        for (const job of topUpJobs) {
          const jobId = String(job.id || "");
          if (!jobId) {
            continue;
          }
          jobsById.set(jobId, job);
        }

        lastTopUpAtMs = nowMs;
        progress.info(
          `queue_topup reason=${reason} claimed=${topUpClaims.length} queued=${topUpJobs.length} expected_jobs=${expectedJobsInCycle} cycle_claimed=${cycleClaimedCount} finalized=${finalizedCount} outstanding=${Math.max(0, expectedJobsInCycle - (seenCompletedJobIds.size + seenFailedJobIds.size))}`,
        );
      }

      async function flushPendingWrites(reason: string): Promise<void> {
        if (pendingSuccessItems.length === 0 && pendingErrors.length === 0) {
          return;
        }

        const successBatch = pendingSuccessItems.slice();
        const errorBatch = pendingErrors.slice();
        let writeStats: {
          uploadedCount: number;
          notUploadedCount: number;
          missingCount: number;
          missingWorkIds: string[];
        } = {
          uploadedCount: 0,
          notUploadedCount: 0,
          missingCount: 0,
          missingWorkIds: [],
        };
        if (!options.dryRunCloud) {
          try {
            writeStats = await updateSuccessRows(pool, successBatch);
            const failureStats = await updateFailureRows(
              pool,
              errorBatch,
              "bullmq_dispatch",
            );
            writeStats.missingCount += failureStats.missingCount;
            writeStats.missingWorkIds.push(...failureStats.missingWorkIds);
          } catch (error: unknown) {
            const message =
              error instanceof Error ? error.message : String(error);
            progress.fail(
              `writeback_failed reason=${reason} message=${message}`,
            );
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
        }

        pendingSuccessItems.length = 0;
        pendingErrors.length = 0;
        pendingSuccessBufferCount = 0;
        pendingErrorBufferCount = 0;

        allSuccessItems.push(...successBatch);
        allErrors.push(...errorBatch);

        // Track processing progress by items successfully handled by workers,
        // not by cloud-upload outcomes.
        flushedProcessedItems += successBatch.length;
        flushedFailedItems += errorBatch.length;
        flushedWithheldItems += writeStats.notUploadedCount;
        report.processed_items =
          cycleProcessedStartTotal + flushedProcessedItems;
        report.failed_items = cycleFailedStartTotal + flushedFailedItems;
        flushBatchCount += 1;
        lastFlushAt = new Date().toISOString();

        progress.info(
          `writeback_flush reason=${reason} batch=${flushBatchCount} success_items=${successBatch.length} errors=${errorBatch.length} uploaded=${writeStats.uploadedCount} withheld=${writeStats.notUploadedCount} missing=${writeStats.missingCount} totals_processed=${flushedProcessedItems} totals_failed=${flushedFailedItems} totals_withheld=${flushedWithheldItems}`,
        );
        if (writeStats.missingCount > 0) {
          const sample =
            writeStats.missingWorkIds.slice(0, 5).join(",") || "n/a";
          progress.warn(
            `writeback_flush_missing_ids reason=${reason} batch=${flushBatchCount} count=${writeStats.missingCount} sample=${sample}`,
          );
        }
        if (options.dryRunCloud) {
          progress.info(
            `writeback_flush_db_skipped reason=${reason} dry_run_cloud=true`,
          );
        }

        await publishRunnerStatus({
          mode: "running",
          gateReason: openGateReason,
          pendingSuccessBuffer: pendingSuccessItems.length,
          pendingErrorBuffer: pendingErrors.length,
        });
      }

      async function processFinalizedJobs(options: {
        reason: string;
        finalPass: boolean;
        budget?: HarvestBudget;
      }): Promise<void> {
        const maxJobs = Math.max(
          1,
          Math.floor(options.budget?.maxJobs ?? Number.MAX_SAFE_INTEGER),
        );
        const maxMs = Math.max(
          1,
          Math.floor(options.budget?.maxMs ?? Number.MAX_SAFE_INTEGER),
        );
        const startedAtMs = Date.now();
        let processedJobs = 0;

        for (const [jobId, job] of jobsById) {
          if (processedJobs >= maxJobs || Date.now() - startedAtMs >= maxMs) {
            progress.info(
              `job_harvest_budget_hit reason=${options.reason} processed_jobs=${processedJobs} max_jobs=${maxJobs} elapsed_ms=${Date.now() - startedAtMs} max_ms=${maxMs}`,
            );
            break;
          }

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
            pendingErrorBufferCount = pendingErrors.length;
            handledJobIds.add(jobId);
            progress.warn(
              `job_missing_result job_id=${jobId} work_id=${job.data.workId} reload_attempts=${misses}`,
            );
            processedJobs += 1;
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
            pendingErrorBufferCount = pendingErrors.length;
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
            processedJobs += 1;
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
          pendingSuccessBufferCount = pendingSuccessItems.length;
          pendingErrorBufferCount = pendingErrors.length;

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
          processedJobs += 1;
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
        budget?: HarvestBudget,
      ): Promise<void> => {
        harvestChain = harvestChain.then(async () => {
          await processFinalizedJobs({ reason, finalPass, budget });
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
          gateReason: openGateReason,
          pendingSuccessBuffer: pendingSuccessItems.length,
          pendingErrorBuffer: pendingErrors.length,
        });
        const totalWaitMs = Math.max(1, options.waitTimeoutSeconds) * 1000;
        const completion: {
          completedJobIds: string[];
          failedJobIds: string[];
        } = await waitForOpsRunCompletion({
          queueEvents,
          queueName: IMAGE_QUEUE_NAME,
          expectedJobs: expectedJobsInCycle,
          expectedJobsProvider: () => expectedJobsInCycle,
          timeoutMs: totalWaitMs,
          reconcileIntervalMs: 250,
          reconcile: async () => {
            const unresolvedJobIds = [...jobsById.keys()].filter(
              (jobId) =>
                !seenCompletedJobIds.has(jobId) && !seenFailedJobIds.has(jobId),
            );

            await maybeTopUpQueue("reconcile");

            for (const jobId of unresolvedJobIds) {
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

            const snapshot = await readQueueSnapshot().catch(() => null);
            const queueDrained =
              snapshot !== null &&
              snapshot.backlog === 0 &&
              snapshot.waiting === 0 &&
              snapshot.active === 0 &&
              snapshot.delayed === 0 &&
              snapshot.paused === 0;

            const finalizedByState =
              seenCompletedJobIds.size + seenFailedJobIds.size;
            const nearCompleteByState =
              finalizedByState >= Math.max(0, expectedJobsInCycle - 1);
            const done =
              finalizedByState >= expectedJobsInCycle ||
              (queueDrained && nearCompleteByState);

            if (done && finalizedByState < expectedJobsInCycle) {
              progress.warn(
                `completion_wait_reconcile queue_drained=${queueDrained} finalized_by_state=${finalizedByState}/${expectedJobsInCycle} resolving_with_state=true`,
              );
            }

            return {
              completedJobIds: [...seenCompletedJobIds],
              failedJobIds: [...seenFailedJobIds],
              done,
            };
          },
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
            report.processed_items =
              cycleProcessedStartTotal +
              Math.max(flushedProcessedItems, processedItems);
            report.failed_items =
              cycleFailedStartTotal + Math.max(flushedFailedItems, failedItems);

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

            // Trigger top-up checks from live completion events so refill can react
            // while jobs are still flowing, not only on reconcile ticks.
            void maybeTopUpQueue("progress").catch((error: unknown) => {
              const message =
                error instanceof Error ? error.message : String(error);
              progress.warn(
                `queue_topup_failed source=progress message=${message}`,
              );
            });

            void publishRunnerStatus({
              mode: "running",
              gateReason: openGateReason,
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

        if (continuousMode) {
          await enqueueHarvestCycle("finalize", false, {
            maxJobs: 200,
            maxMs: 1500,
          });
        } else {
          await enqueueHarvestCycle("finalize", false);
          await enqueueHarvestCycle("final-pass", true);
        }
        pendingSuccessBufferCount = pendingSuccessItems.length;
        pendingErrorBufferCount = pendingErrors.length;

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

        report.processed_items =
          cycleProcessedStartTotal + flushedProcessedItems;
        report.failed_items = cycleFailedStartTotal + flushedFailedItems;
        const cycleDurationSec = Math.max(
          1,
          (Date.now() - cycleStartedAtMs) / 1000,
        );
        progress.info(
          `cycle_feedback claimed=${claimedItems.length} processed=${Math.max(0, flushedProcessedItems)} failed=${Math.max(0, flushedFailedItems)} duration_sec=${roundToOne(cycleDurationSec)}`,
        );
        await publishRunnerStatus({
          mode: "done",
          gateReason: openGateReason,
          pendingSuccessBuffer: pendingSuccessItems.length,
          pendingErrorBuffer: pendingErrors.length,
        });

        if (continuousMode) {
          progress.done(
            `cycle_complete claimed_total=${report.claimed_count} queued_total=${report.queued_count} processed_total=${report.processed_items} failed_total=${report.failed_items}`,
          );
          await sleepMs(500);
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
    clearInterval(eventWritebackTimer);
    queueEvents.off("completed", onCompletedEvent);
    queueEvents.off("failed", onFailedEvent);
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
