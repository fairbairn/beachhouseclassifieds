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
    "  npm run workers:image:desktop -- --target-count 20 [--dry-run-cloud true]",
    "",
    "Options:",
    "  --target-count <n>            Number of rows to claim from postgres",
    "  --fetch-timeout-ms <n>        Source fetch timeout (default 8000)",
    "  --fetch-retry-count <n>       Source fetch retries (default 2)",
    "  --dry-run-cloud true|false    Skip upload and DB final image writes when true",
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
    targetCount: parsePositiveInt(values.get("target-count"), 20),
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
    dryRunCloud: parseBoolean(values.get("dry-run-cloud"), true),
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
): Promise<void> {
  for (const item of items) {
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
  }
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
  }) => void;
}): Promise<{ completedJobIds: string[]; failedJobIds: string[] }> {
  const completedSet = new Set<string>();
  const failedSet = new Set<string>();

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
      params.onProgress({
        completed: completedSet.size,
        failed: failedSet.size,
        expected: params.expectedJobs,
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

    const cleanup = (): void => {
      clearTimeout(timeout);
      params.queueEvents.off("completed", onCompleted);
      params.queueEvents.off("failed", onFailed);
    };

    params.queueEvents.on("completed", onCompleted);
    params.queueEvents.on("failed", onFailed);
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
    const queuedJobs = await Promise.all(
      claimedItems.map((item, index) =>
        queue.add("process-image", {
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
        } satisfies ImageProcessingQueueJob),
      ),
    );
    report.queued_count = queuedJobs.length;
    progress.info(
      `queued_jobs=${queuedJobs.length} queue=${IMAGE_QUEUE_NAME} target_images=${report.claimed_count}`,
    );

    progress.phase("waiting for worker completion");
    const completion = await waitForRunCompletion({
      queueEvents,
      queueName: IMAGE_QUEUE_NAME,
      expectedJobs: queuedJobs.length,
      timeoutMs: Math.max(1, options.waitTimeoutSeconds) * 1000,
      onProgress: ({ completed, failed, expected }) => {
        report.completed_jobs = completed;
        report.failed_jobs = failed;
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
    const completedJobSet = new Set(completion.completedJobIds);

    for (const job of queuedJobs) {
      const jobId = String(job.id || "");
      if (!jobId) {
        continue;
      }

      const reloaded = await Job.fromId(queue, jobId);
      if (!reloaded) {
        allErrors.push({
          work_id: String(job.data.workId),
          source_image_url: String(job.data.sourceImageUrl || ""),
          code: "missing_job_result",
          message: `bullmq result missing for jobId=${jobId}`,
        });
        continue;
      }

      if (!completedJobSet.has(jobId)) {
        const failedReason = String(
          reloaded.failedReason || "job failed without reason",
        );
        allErrors.push({
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

      await updateSuccessRows(pool, items);
      await updateFailureRows(pool, errors, "bullmq_dispatch");

      allSuccessItems.push(...items);
      report.processed_items += items.length;
      report.failed_items += errors.length;
      allErrors.push(...errors);

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

      progress.info(
        `job_result job_id=${jobId} work_id=${job.data.workId} processed=${items.length} failed=${errors.length} modes=${modes.join(",") || "none"}`,
      );
    }

    if (allErrors.length > 0) {
      await updateFailureRows(pool, allErrors, "bullmq_dispatch_summary");
    }

    report.finished_at = new Date().toISOString();
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
