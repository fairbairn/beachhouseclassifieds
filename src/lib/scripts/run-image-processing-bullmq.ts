import "@/core/tooling/env/load-env-profile";

import { Job, QueueEvents } from "bullmq";
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
  createImageQueue,
  createRedisConnection,
  type ImageProcessingQueueJob,
} from "../../workers/image-queue";

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

function sourceStatusForErrorCode(code: string): string {
  if (code === "source_403") {
    return "failed_source_exception_403";
  }
  if (code === "source_429") {
    return "failed_source_exception_429";
  }
  if (code === "source_404") {
    return "failed_source_retry_later_404";
  }
  if (code === "source_5xx") {
    return "failed_source_retry_later_5xx";
  }
  return "failed_trigger";
}

async function claimPendingRows(
  pool: Pool,
  targetCount: number,
  claimPoolSize: number,
): Promise<ClaimedItem[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const query = `
      with candidate_pool as (
        select
          lsi.id,
          lsi.source_image_url,
          coalesce(
            nullif(substring(lsi.source_image_url from '^https?://([^/]+)'), ''),
            'unknown-host'
          ) as source_host
        from listing_source_image lsi
        join listing_source_link lsl
          on lsl.id = lsi.source_link_id
        where lsi.site_image is null
          and coalesce(lsi.source_image_url, '') <> ''
          and lsl.source_status = 'active'
          and lsl.active_to is null
          and (
            lsi.status in (
              'pending',
              'ready_source',
              'failed_trigger',
              'failed_source_403',
              'failed_source_exception_403',
              'failed_source_exception_429',
              'failed_source_retry_later_404',
              'failed_source_retry_later_5xx',
              'failed_cloakbrowser_recovery'
            )
            or (
              lsi.status in ('processing_worker', 'processing_trigger')
              and lsi.updated_at < (now() - interval '30 minutes')
            )
          )
        order by random(), lsi.id
        limit $2
        for update of lsi skip locked
      ),
      ranked as (
        select
          candidate_pool.id,
          candidate_pool.source_image_url,
          row_number() over (
            partition by candidate_pool.source_host
            order by random(), candidate_pool.id
          ) as host_round,
          random() as tie_breaker
        from candidate_pool
      ),
      picked as (
        select ranked.id, ranked.source_image_url
        from ranked
        order by ranked.host_round asc, ranked.tie_breaker asc
        limit $1
      )
      update listing_source_image lsi
      set
        status = 'processing_worker',
        error_payload = coalesce(lsi.error_payload, '{}'::jsonb) || jsonb_build_object(
          'bullmq_attempt_started_at', now()::text
        ),
        updated_at = now()
      from picked
      where lsi.id = picked.id
      returning lsi.id, lsi.source_image_url
    `;

    const { rows } = await client.query(query, [targetCount, claimPoolSize]);
    await client.query("COMMIT");
    return rows.map((row) => ({
      workId: String(row.id),
      sourceImageUrl: String(row.source_image_url),
    }));
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function updateSuccessRows(
  pool: Pool,
  items: ImageProcessingItemResult[],
): Promise<{ uploadedCount: number; notUploadedCount: number }> {
  let uploadedCount = 0;
  let notUploadedCount = 0;

  for (const item of items) {
    const storedStatus = String(item.stored_status_on_s3 || "unknown");
    const isUploaded = storedStatus === "uploaded";

    const info = {
      source_mode: "url",
      source_content_hash: item.calculated_hash ?? null,
      transformed_content_hash: item.transformed_hash ?? null,
      source_fetch_mode: item.source_fetch_mode ?? null,
      source_http_status: item.source_http_status ?? null,
      transformed_bytes: item.transformed_bytes ?? null,
      source_width: item.source_width ?? null,
      source_height: item.source_height ?? null,
      transformed_width: item.transformed_width ?? null,
      transformed_height: item.transformed_height ?? null,
      fetch_elapsed_ms: item.fetch_elapsed_ms ?? null,
      transform_elapsed_ms: item.transform_elapsed_ms ?? null,
      upload_elapsed_ms: item.upload_elapsed_ms ?? null,
      upload_skipped_existing: item.upload_skipped_existing ?? null,
      target_width: item.target_width ?? null,
      target_height: item.target_height ?? null,
      below_target_hd: item.below_target_hd ?? null,
      stored_status_on_s3: item.stored_status_on_s3 ?? null,
      processed_at: new Date().toISOString(),
      pipeline: "bullmq",
    };

    if (isUploaded) {
      await pool.query(
        `
        update listing_source_image
        set
          status = 'processed_site',
          source_content_hash = $2,
          site_image = $3,
          error_payload = coalesce(error_payload, '{}'::jsonb) || $4::jsonb,
          updated_at = now()
        where id = $1
        `,
        [
          String(item.work_id),
          String(item.calculated_hash || ""),
          String(item.final_name || ""),
          JSON.stringify(info),
        ],
      );
      uploadedCount += 1;
      continue;
    }

    const notUploadedPayload = {
      ...info,
      error_stage: "storage_finalize",
      error_code: "storage_not_uploaded",
      error_message:
        "worker item did not reach definitive uploaded S3 status; completion withheld",
    };

    await pool.query(
      `
      update listing_source_image
      set
        status = 'failed_trigger',
        error_payload = coalesce(error_payload, '{}'::jsonb) || $2::jsonb,
        updated_at = now()
      where id = $1
      `,
      [String(item.work_id), JSON.stringify(notUploadedPayload)],
    );
    notUploadedCount += 1;
  }

  return { uploadedCount, notUploadedCount };
}

async function updateFailureRows(
  pool: Pool,
  errors: ImageProcessingTaskError[],
  marker: string,
): Promise<void> {
  for (const errorRow of errors) {
    const code = String(errorRow.code || "worker_error");
    const status = sourceStatusForErrorCode(code);

    const payload = {
      error_stage: marker,
      error_code: code,
      error_message: String(errorRow.message || "unknown error"),
      failed_at: new Date().toISOString(),
      source_image_url: errorRow.source_image_url || null,
      pipeline: "bullmq",
    };

    await pool.query(
      `
      update listing_source_image
      set
        status = $2,
        error_payload = coalesce(error_payload, '{}'::jsonb) || $3::jsonb,
        updated_at = now()
      where id = $1
      `,
      [String(errorRow.work_id), status, JSON.stringify(payload)],
    );
  }
}

async function waitForRunCompletion(params: {
  queueEvents: QueueEvents;
  queueName: string;
  expectedJobs: number;
  timeoutMs: number;
  onProgress: (state: {
    completed: number;
    failed: number;
    expected: number;
    processedItems: number;
    failedItems: number;
    completedJobIds: string[];
    failedJobIds: string[];
  }) => void;
}): Promise<{ completedJobIds: string[]; failedJobIds: string[] }> {
  const completedSet = new Set<string>();
  const failedSet = new Set<string>();
  const progressByJob = new Map<
    string,
    { succeeded: number; failed: number }
  >();

  const summarizeLiveItems = (): {
    processedItems: number;
    failedItems: number;
  } => {
    let processedItems = 0;
    let failedItems = 0;

    for (const entry of progressByJob.values()) {
      processedItems += Math.max(0, Number(entry.succeeded) || 0);
      failedItems += Math.max(0, Number(entry.failed) || 0);
    }

    // If a job failed before reporting structured progress, treat it as one failed item.
    for (const failedJobId of failedSet) {
      if (!progressByJob.has(failedJobId)) {
        failedItems += 1;
      }
    }

    return { processedItems, failedItems };
  };

  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `timeout waiting for queue completion queue=${params.queueName} completed=${completedSet.size} failed=${failedSet.size} expected=${params.expectedJobs}`,
        ),
      );
    }, params.timeoutMs);

    const maybeDone = (): void => {
      const liveItems = summarizeLiveItems();
      params.onProgress({
        completed: completedSet.size,
        failed: failedSet.size,
        expected: params.expectedJobs,
        processedItems: liveItems.processedItems,
        failedItems: liveItems.failedItems,
        completedJobIds: [...completedSet],
        failedJobIds: [...failedSet],
      });

      if (completedSet.size + failedSet.size >= params.expectedJobs) {
        cleanup();
        resolve({
          completedJobIds: [...completedSet],
          failedJobIds: [...failedSet],
        });
      }
    };

    const onCompleted = (event: { jobId: string }): void => {
      completedSet.add(String(event.jobId));
      maybeDone();
    };

    const onFailed = (event: { jobId: string }): void => {
      failedSet.add(String(event.jobId));
      maybeDone();
    };

    const onProgressEvent = (event: { jobId: string; data: unknown }): void => {
      const jobId = String(event?.jobId || "");
      if (!jobId) {
        return;
      }

      const payload =
        event?.data &&
        typeof event.data === "object" &&
        !Array.isArray(event.data)
          ? (event.data as Record<string, unknown>)
          : null;

      if (!payload) {
        return;
      }

      const succeeded = Number(payload.succeeded);
      const failed = Number(payload.failed);
      if (!Number.isFinite(succeeded) && !Number.isFinite(failed)) {
        return;
      }

      progressByJob.set(jobId, {
        succeeded: Number.isFinite(succeeded) ? Math.max(0, succeeded) : 0,
        failed: Number.isFinite(failed) ? Math.max(0, failed) : 0,
      });
      maybeDone();
    };

    const cleanup = (): void => {
      clearTimeout(timeout);
      params.queueEvents.off("completed", onCompleted);
      params.queueEvents.off("failed", onFailed);
      params.queueEvents.off("progress", onProgressEvent);
    };

    params.queueEvents.on("completed", onCompleted);
    params.queueEvents.on("failed", onFailed);
    params.queueEvents.on("progress", onProgressEvent);
  });
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

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const progress = createProgress("image-processing-bullmq");

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("Missing DATABASE_URL");
  }

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

  const pool = new Pool({ connectionString: databaseUrl, max: 6 });
  const queueConnection = createRedisConnection();
  const queue = createImageQueue(queueConnection);
  const queueEventsConnection = createRedisConnection();
  const queueEvents = new QueueEvents(IMAGE_QUEUE_NAME, {
    connection: queueEventsConnection,
  });

  await queueEvents.waitUntilReady();

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
          `images_processed=${report.processed_items}/${report.claimed_count} ` +
          `jobs_completed=${report.completed_jobs} jobs_failed=${report.failed_jobs} ` +
          `items_failed=${report.failed_items}`,
      });
      progress.progress(`heartbeat ${line}`);
    },
    Math.max(5, options.heartbeatSeconds) * 1000,
  );

  try {
    progress.phase("claiming rows from postgres");
    const claimPoolSize = Math.max(
      options.targetCount,
      Math.min(
        options.claimPoolMax,
        options.targetCount * options.claimPoolMultiplier,
      ),
    );
    const claimedItems = await claimPendingRows(
      pool,
      options.targetCount,
      claimPoolSize,
    );
    report.claimed_count = claimedItems.length;

    if (claimedItems.length === 0) {
      progress.done("no rows claimed; exiting");
      return;
    }

    progress.phase("enqueueing bullmq jobs");
    const jobRetentionCount = Math.max(1000, options.targetCount * 2);
    const queuedJobs = await Promise.all(
      claimedItems.map((item, index) =>
        queue.add(
          "process-image",
          {
            operationId,
            batchId: `${operationId}-job-${String(index + 1).padStart(5, "0")}`,
            batchIndex: index,
            batchCount: claimedItems.length,
            workId: item.workId,
            sourceType: "url",
            sourceImageUrl: item.sourceImageUrl,
            fetchTimeoutMs: options.fetchTimeoutMs,
            fetchRetryCount: options.fetchRetryCount,
            dryRun: options.dryRunCloud,
            uploadPrefix: options.uploadPrefix,
            verboseLogs: false,
            sleepSecondsPerItem: 0,
          } satisfies ImageProcessingQueueJob,
          {
            // Keep enough completed/failed jobs to allow end-of-run result reload.
            removeOnComplete: jobRetentionCount,
            removeOnFail: jobRetentionCount,
          },
        ),
      ),
    );
    report.queued_count = queuedJobs.length;
    progress.info(
      `queued_jobs=${queuedJobs.length} queue=${IMAGE_QUEUE_NAME} target_images=${report.claimed_count} retention=${jobRetentionCount}`,
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
    let flushedBatchCount = 0;

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
      flushedBatchCount += 1;

      progress.info(
        `writeback_flush reason=${reason} batch=${flushedBatchCount} success_items=${successBatch.length} errors=${errorBatch.length} uploaded=${writeStats.uploadedCount} withheld=${writeStats.notUploadedCount} totals_processed=${flushedProcessedItems} totals_failed=${flushedFailedItems}`,
      );
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

    const periodicFlushIntervalMs = 15_000;
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
      periodicFlushTimer = setInterval(() => {
        void enqueueHarvestCycle("periodic", false).catch((error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          progress.warn(`periodic_flush_failed message=${message}`);
        });
      }, periodicFlushIntervalMs);

      progress.phase("waiting for worker completion");
      const completion = await waitForRunCompletion({
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
              `images_processed=${report.processed_items}/${report.claimed_count} ` +
              `items_failed=${report.failed_items}`,
          });
          progress.progress(`queue ${line}`);
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
    await closeWithTimeout("queue_events_close", queueEvents.close());
    await closeWithTimeout("queue_events_quit", queueEventsConnection.quit());
    await closeWithTimeout("queue_close", queue.close());
    await closeWithTimeout("queue_connection_quit", queueConnection.quit());
    await closeWithTimeout("pool_end", pool.end());
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `${chalk.gray(stamp())} ${chalk.bgBlue.white.bold(" image-processing-bullmq ")} ${chalk.bgRed.white.bold(" fail ")} ${chalk.red(message)}\n`,
  );
  process.stderr.write(`run-image-processing-bullmq failed: ${message}\n`);
  process.exit(1);
});
