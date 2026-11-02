import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { launch as launchCloakBrowser } from "cloakbrowser";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { runs, tasks } from "@trigger.dev/sdk";
import chalk from "chalk";
import { config as loadDotenv } from "dotenv";
import { Pool } from "pg";

loadDotenv({ path: ".env.local" });
loadDotenv();

const BUNNY_ENDPOINT = "https://ny-s3.storage.bunnycdn.com";
const BUNNY_BUCKET = "beach";
const BUNNY_ACCESS_KEY_ID = "beach";
const BUNNY_REGION = "ny";
const BUNNY_FORCE_PATH_STYLE = true;
const DEFAULT_FETCH_TIMEOUT_MS = 8_000;
const DEFAULT_FETCH_RETRY_COUNT = 2;
const MAX_TASK_CONCURRENCY = 20;
const DEFAULT_WORKER_CONCURRENCY = 1;

function parsePositiveInt(rawValue, fallback) {
  const parsed = Number.parseInt(String(rawValue || "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

const DEFAULTS = {
  targetCount: 1000,
  taskConcurrency: MAX_TASK_CONCURRENCY,
  runConcurrency: MAX_TASK_CONCURRENCY,
  workerConcurrency: DEFAULT_WORKER_CONCURRENCY,
  batchSize: 50,
  fetchTimeoutMs: parsePositiveInt(
    process.env.IMAGE_FETCH_TIMEOUT_MS,
    DEFAULT_FETCH_TIMEOUT_MS,
  ),
  fetchRetryCount: Math.max(
    0,
    Math.min(
      5,
      parsePositiveInt(
        process.env.IMAGE_FETCH_RETRY_COUNT,
        DEFAULT_FETCH_RETRY_COUNT,
      ),
    ),
  ),
  claimPoolMultiplier: 10,
  claimPoolMax: 10000,
  env: "dev",
  uploadPrefix: "v1",
  maxExceptionRounds: 3,
  exceptionFetchConcurrency: 2,
  dryRunCloud: false,
  heartbeatSeconds: 10,
  replayReportPrefix: "",
  disableExceptionRecovery: false,
};

function deriveScheduling(targetCount, requestedTaskConcurrency) {
  const boundedTargetCount = Math.max(1, Number(targetCount) || 1);
  const requestedConcurrency = Math.max(
    1,
    Number(requestedTaskConcurrency) || DEFAULTS.taskConcurrency,
  );
  const taskConcurrency = Math.min(MAX_TASK_CONCURRENCY, requestedConcurrency);
  const batchSize = Math.max(
    1,
    Math.ceil(boundedTargetCount / taskConcurrency),
  );

  return {
    targetCount: boundedTargetCount,
    requestedTaskConcurrency: requestedConcurrency,
    taskConcurrency,
    runConcurrency: taskConcurrency,
    workerConcurrency: DEFAULT_WORKER_CONCURRENCY,
    batchSize,
  };
}

function stamp() {
  return new Date().toISOString().slice(11, 19);
}

function createProgress(script) {
  const scriptLabel = chalk.bgBlue.white.bold(` ${script} `);

  function line(label, message) {
    console.log(`${chalk.gray(stamp())} ${scriptLabel} ${label} ${message}`);
  }

  return {
    phase(message) {
      line(chalk.bgCyan.black.bold(" phase "), chalk.cyan(message));
    },
    info(message) {
      line(chalk.bgWhite.black.bold(" info "), message);
    },
    progress(message) {
      line(chalk.bgBlueBright.white.bold(" prog  "), chalk.blueBright(message));
    },
    warn(message) {
      line(chalk.bgYellow.black.bold(" warn "), chalk.yellow(message));
    },
    done(message) {
      line(chalk.bgGreen.black.bold(" done "), chalk.green(message));
    },
    fail(message) {
      line(chalk.bgRed.white.bold(" fail "), chalk.red(message));
    },
  };
}

function roundToOne(value) {
  return Math.round(value * 10) / 10;
}

function formatPct(completed, total) {
  if (total <= 0) {
    return "n/a%";
  }
  return `${roundToOne((completed / total) * 100)}%`;
}

function formatEtaMinutes(completed, total, elapsedSeconds) {
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

function formatModeProgressLine(input) {
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

function countErrorsByCode(rows) {
  const counts = {};
  for (const row of rows) {
    const code = String(row?.code || "unknown_error");
    counts[code] = (counts[code] || 0) + 1;
  }
  return counts;
}

function categorizeFailure(row) {
  const code = String(row?.code || "unknown_error");
  const message = String(row?.message || "");

  if (/status=403/.test(message) || code === "source_403") {
    return "http_403_blocked";
  }
  if (/status=429/.test(message) || code === "source_429") {
    return "http_429_throttled";
  }
  if (/status=404/.test(message) || code === "source_404") {
    return "http_404_not_found";
  }
  if (/status=5\d\d/.test(message) || code === "source_5xx") {
    return "http_5xx_upstream";
  }
  if (
    /kind=timeout|timed out|timeout/i.test(message) ||
    code === "source_timeout"
  ) {
    return "timeout";
  }
  if (
    /UND_ERR_SOCKET|other side closed|socket hang up|ECONNRESET|EPIPE/i.test(
      message,
    )
  ) {
    return "socket_closed";
  }
  if (/proxy_url_missing|proxy_agent_unavailable/i.test(message)) {
    return "proxy_path_issue";
  }
  if (code === "source_network") {
    return "network_other";
  }
  if (code === "worker_error") {
    return "worker_error";
  }
  return code;
}

function countErrorsByCategory(rows) {
  const counts = {};
  for (const row of rows) {
    const category = categorizeFailure(row);
    counts[category] = (counts[category] || 0) + 1;
  }
  return counts;
}

function countErrorsByHost(rows) {
  const counts = {};
  for (const row of rows) {
    const raw = String(row?.source_image_url || "");
    let host = "unknown_host";
    try {
      host = new URL(raw).host || "unknown_host";
    } catch {
      host = "unknown_host";
    }
    counts[host] = (counts[host] || 0) + 1;
  }
  return counts;
}

function sampleMessagesByCategory(rows) {
  const samples = {};
  for (const row of rows) {
    const category = categorizeFailure(row);
    if (!samples[category]) {
      samples[category] = String(row?.message || "");
    }
  }
  return samples;
}

function sortCountsDesc(counts, limit = 10) {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
}

function createOperationId() {
  const now = new Date().toISOString().replace(/[:.]/g, "-");
  const token = Math.random().toString(36).slice(2, 10);
  return `img-op-${now}-${token}`;
}

function parseArgs(argv) {
  const options = { ...DEFAULTS };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];

    if (token === "--target-count" && next) {
      options.targetCount = Math.max(
        1,
        Number.parseInt(next, 10) || DEFAULTS.targetCount,
      );
      i += 1;
      continue;
    }
    if (
      (token === "--task-concurrency" || token === "--run-concurrency") &&
      next
    ) {
      options.taskConcurrency = Math.max(
        1,
        Number.parseInt(next, 10) || DEFAULTS.taskConcurrency,
      );
      i += 1;
      continue;
    }
    if (token === "--batch-size" && next) {
      throw new Error(
        "--batch-size is not supported. Batch size is derived automatically from --target-count and --task-concurrency.",
      );
    }
    if (token === "--worker-concurrency" && next) {
      throw new Error(
        "--worker-concurrency is not supported. Worker concurrency is fixed to 1 for stability.",
      );
    }
    if (token === "--fetch-timeout-ms" && next) {
      options.fetchTimeoutMs = parsePositiveInt(next, DEFAULTS.fetchTimeoutMs);
      i += 1;
      continue;
    }
    if (token === "--fetch-retry-count" && next) {
      options.fetchRetryCount = Math.max(
        0,
        Math.min(5, Number.parseInt(next, 10) || DEFAULTS.fetchRetryCount),
      );
      i += 1;
      continue;
    }
    if (token === "--claim-pool-multiplier" && next) {
      options.claimPoolMultiplier = Math.max(
        1,
        Number.parseInt(next, 10) || DEFAULTS.claimPoolMultiplier,
      );
      i += 1;
      continue;
    }
    if (token === "--claim-pool-max" && next) {
      options.claimPoolMax = Math.max(
        1,
        Number.parseInt(next, 10) || DEFAULTS.claimPoolMax,
      );
      i += 1;
      continue;
    }
    if (token === "--env" && next) {
      options.env = next;
      i += 1;
      continue;
    }
    if (token === "--upload-prefix" && next) {
      options.uploadPrefix = next;
      i += 1;
      continue;
    }
    if (token === "--max-exception-rounds" && next) {
      options.maxExceptionRounds = Math.max(
        1,
        Number.parseInt(next, 10) || DEFAULTS.maxExceptionRounds,
      );
      i += 1;
      continue;
    }
    if (token === "--exception-fetch-concurrency" && next) {
      options.exceptionFetchConcurrency = Math.max(
        1,
        Number.parseInt(next, 10) || DEFAULTS.exceptionFetchConcurrency,
      );
      i += 1;
      continue;
    }
    if (token === "--dry-run-cloud") {
      options.dryRunCloud = true;
      continue;
    }
    if (token === "--heartbeat-seconds" && next) {
      options.heartbeatSeconds = Math.max(
        2,
        Number.parseInt(next, 10) || DEFAULTS.heartbeatSeconds,
      );
      i += 1;
      continue;
    }
    if (token === "--replay-report-prefix" && next) {
      options.replayReportPrefix = next.trim();
      i += 1;
      continue;
    }
    if (token === "--disable-exception-recovery") {
      options.disableExceptionRecovery = true;
      continue;
    }
    if (token === "--help" || token === "-h") {
      console.log(
        "Usage: node src/lib/scripts/run-trigger-image-processing.mjs [options]",
      );
      console.log(
        "--target-count <n> --task-concurrency <n> (alias: --run-concurrency)",
      );
      console.log(
        `task concurrency is capped at ${MAX_TASK_CONCURRENCY}; worker concurrency is fixed at ${DEFAULT_WORKER_CONCURRENCY}`,
      );
      console.log(
        "batch size is auto-derived as ceil(target-count / effective-task-concurrency)",
      );
      console.log("--fetch-timeout-ms 25000");
      console.log("--fetch-retry-count 3");
      console.log("--claim-pool-multiplier 10 --claim-pool-max 10000");
      console.log(
        "--env dev --upload-prefix v1 --max-exception-rounds 3 --exception-fetch-concurrency 2",
      );
      console.log(
        "--dry-run-cloud --heartbeat-seconds 10 --replay-report-prefix <prefix> --disable-exception-recovery",
      );
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  const scheduling = deriveScheduling(
    options.targetCount,
    options.taskConcurrency,
  );

  options.targetCount = scheduling.targetCount;
  options.requestedTaskConcurrency = scheduling.requestedTaskConcurrency;
  options.taskConcurrency = scheduling.taskConcurrency;
  options.runConcurrency = scheduling.runConcurrency;
  options.workerConcurrency = scheduling.workerConcurrency;
  options.batchSize = scheduling.batchSize;

  return options;
}

function chunkArray(values, size) {
  const out = [];
  for (let i = 0; i < values.length; i += size) {
    out.push(values.slice(i, i + size));
  }
  return out;
}

function shuffleArray(values) {
  const out = [...values];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = out[i];
    out[i] = out[j];
    out[j] = temp;
  }
  return out;
}

function extractSourceHost(value) {
  try {
    return new URL(String(value || "")).host || "unknown-host";
  } catch {
    return "unknown-host";
  }
}

function rebalanceItemsByHost(items) {
  const hostToItems = new Map();
  const hostOrder = [];

  for (const item of items) {
    const host = extractSourceHost(item.sourceImageUrl);
    if (!hostToItems.has(host)) {
      hostToItems.set(host, []);
      hostOrder.push(host);
    }
    hostToItems.get(host).push(item);
  }

  const balanced = [];
  let lastHost = "";
  let madeProgress = true;
  while (madeProgress) {
    madeProgress = false;

    const roundHosts = shuffleArray(hostOrder);
    for (const host of roundHosts) {
      const queue = hostToItems.get(host);
      if (!queue || queue.length === 0) {
        continue;
      }
      if (host === lastHost) {
        const alternateHost = roundHosts.find((candidate) => {
          if (candidate === host) {
            return false;
          }
          const candidateQueue = hostToItems.get(candidate);
          return Boolean(candidateQueue && candidateQueue.length > 0);
        });
        if (alternateHost) {
          const altQueue = hostToItems.get(alternateHost);
          balanced.push(altQueue.shift());
          lastHost = alternateHost;
          madeProgress = true;
          if (!queue.length) {
            continue;
          }
        }
      }
      balanced.push(queue.shift());
      lastHost = host;
      madeProgress = true;
    }
  }

  return {
    items: balanced,
    hostCount: hostOrder.length,
  };
}

async function loadReplayBatchPayloads(reportPrefix) {
  const reportsDir = resolve(process.cwd(), ".tmp/reports");
  const entries = await readdir(reportsDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter(
      (name) =>
        name.startsWith(`${reportPrefix}-batch-`) && name.endsWith(".json"),
    )
    .sort((left, right) => left.localeCompare(right));

  const payloads = [];
  for (const fileName of files) {
    const filePath = resolve(reportsDir, fileName);
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    payloads.push(parsed);
  }

  return payloads;
}

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  const runners = Array.from(
    { length: Math.max(1, Math.min(limit, items.length || 1)) },
    async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) {
          return;
        }
        results[index] = await worker(items[index], index);
      }
    },
  );

  await Promise.all(runners);
  return results;
}

function makeS3Client(secretAccessKey) {
  return new S3Client({
    endpoint: BUNNY_ENDPOINT,
    region: BUNNY_REGION,
    forcePathStyle: BUNNY_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: BUNNY_ACCESS_KEY_ID,
      secretAccessKey,
    },
  });
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function sourceStatusForErrorCode(code) {
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

async function claimPendingRows(pool, targetCount, claimPoolSize) {
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
              lsi.status = 'processing_trigger'
              and lsi.updated_at < (now() - interval '30 minutes')
            )
          )
        order by random(), lsi.id
        limit $2
        for update of lsi skip locked
      ),
      eligible as (
        select
          candidate_pool.id,
          candidate_pool.source_image_url,
          candidate_pool.source_host
        from candidate_pool
      ),
      ranked as (
        select
          eligible.id,
          eligible.source_image_url,
          row_number() over (
            partition by eligible.source_host
            order by random(), eligible.id
          ) as host_round,
          random() as tie_breaker
        from eligible
      ),
      picked as (
        select ranked.id, ranked.source_image_url
        from ranked
        order by ranked.host_round asc, ranked.tie_breaker asc
        limit $1
      )
      update listing_source_image lsi
      set
        status = 'processing_trigger',
        error_payload = coalesce(lsi.error_payload, '{}'::jsonb) || jsonb_build_object(
          'trigger_attempt_started_at', now()::text
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

async function updateSuccessRows(pool, items, sourceMode) {
  for (const item of items) {
    const info = {
      source_mode: sourceMode,
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
      s3_verified: item.s3_verified ?? null,
      s3_verified_at: item.s3_verified_at ?? null,
      processed_at: new Date().toISOString(),
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

async function updateFailureRows(pool, errors, marker) {
  for (const errorRow of errors) {
    const code = String(errorRow.code || "worker_error");
    const status = sourceStatusForErrorCode(code);

    const payload = {
      error_stage: marker,
      error_code: code,
      error_message: String(errorRow.message || "unknown error"),
      failed_at: new Date().toISOString(),
      source_image_url: errorRow.source_image_url || null,
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

function buildBatchPayload(batchItems, options) {
  return {
    operationId: options.operationId,
    batchId: options.batchId,
    batchIndex: options.batchIndex,
    batchCount: options.batchCount,
    workerConcurrency: options.workerConcurrency,
    fetchTimeoutMs: options.fetchTimeoutMs,
    fetchRetryCount: options.fetchRetryCount,
    sleepSecondsPerItem: 0,
    dryRun: options.dryRunCloud,
    uploadPrefix: options.uploadPrefix,
    verboseLogs: false,
    items: batchItems.map((item) => ({
      workId: item.workId,
      sourceImageUrl: item.sourceImageUrl,
    })),
  };
}

async function triggerBatch(payload, options, hooks = {}) {
  const handle = await tasks.trigger("image-processing-task", payload);
  const runId = String(handle.id || "");
  if (!runId) {
    throw new Error("Trigger API returned no run id");
  }

  console.log(
    `${chalk.gray(stamp())} ${chalk.bgBlue.white.bold(" trigger-image-processing ")} ${chalk.bgWhite.black.bold(" info ")} ${chalk.white(`triggered_run_id=${runId}`)}`,
  );

  let latestRun = null;
  let lastStatus = "";
  let reachedTerminalStatus = false;

  function readRunWorkerProgress(run) {
    if (!run || typeof run !== "object") {
      return null;
    }

    const metadataValue = run.metadata;
    if (!metadataValue || typeof metadataValue !== "object") {
      return null;
    }

    const progressValue = metadataValue.progress;
    if (!progressValue || typeof progressValue !== "object") {
      return null;
    }

    const current = Number(progressValue.current ?? 0);
    const total = Number(progressValue.total ?? 0);
    const queued = Number(progressValue.queued ?? 0);
    const active = Number(progressValue.active ?? 0);
    const succeeded = Number(progressValue.succeeded ?? 0);
    const failed = Number(progressValue.failed ?? 0);
    const updatedAtRaw =
      typeof progressValue.updated_at === "string"
        ? progressValue.updated_at
        : null;
    const updatedAtMs = updatedAtRaw ? Date.parse(updatedAtRaw) : Number.NaN;
    const normalizedCurrent = Number.isFinite(current)
      ? Math.max(0, Math.floor(current))
      : 0;
    const normalizedTotal = Number.isFinite(total)
      ? Math.max(0, Math.floor(total))
      : 0;
    const runWorkComplete =
      normalizedTotal > 0 && normalizedCurrent >= normalizedTotal;
    const operationId =
      typeof progressValue.operation_id === "string"
        ? progressValue.operation_id
        : null;
    const batchId =
      typeof progressValue.batch_id === "string"
        ? progressValue.batch_id
        : null;
    const progressEvent =
      typeof progressValue.event === "string" ? progressValue.event : null;
    const lastWorkId =
      typeof progressValue.last_work_id === "string"
        ? progressValue.last_work_id
        : null;
    const lastErrorCode =
      typeof progressValue.last_error_code === "string"
        ? progressValue.last_error_code
        : null;

    return {
      completed: normalizedCurrent,
      total: normalizedTotal,
      queued:
        runWorkComplete || !Number.isFinite(queued)
          ? 0
          : Math.max(0, Math.floor(queued)),
      active:
        runWorkComplete || !Number.isFinite(active)
          ? 0
          : Math.max(0, Math.floor(active)),
      succeeded: Number.isFinite(succeeded)
        ? Math.max(0, Math.floor(succeeded))
        : 0,
      failed: Number.isFinite(failed) ? Math.max(0, Math.floor(failed)) : 0,
      updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : null,
      operationId,
      batchId,
      progressEvent,
      lastWorkId,
      lastErrorCode,
    };
  }

  function formatHeartbeatProgress(run) {
    const p = readRunWorkerProgress(run);
    if (!p) {
      return "worker_progress=unavailable";
    }

    const percentage =
      p.total > 0 ? roundToOne((p.completed / p.total) * 100) : 0;
    return (
      `items queued=${p.queued} in_flight=${p.active} completed=${p.completed}/${p.total} completion=${percentage}% ` +
      `op=${p.operationId || "unknown"} batch=${p.batchId || "unknown"} event=${p.progressEvent || "unknown"} ` +
      `last_work_id=${p.lastWorkId || "n/a"} last_error_code=${p.lastErrorCode || "n/a"}`
    );
  }

  for await (const run of runs.subscribeToRun(runId)) {
    latestRun = run;
    const status = String(run?.status || "UNKNOWN").toUpperCase();
    const progress = readRunWorkerProgress(run);
    if (typeof hooks.onProgress === "function") {
      hooks.onProgress({
        runId,
        status,
        progress,
        observedAtMs: Date.now(),
      });
    }

    if (status !== lastStatus) {
      lastStatus = status;
      if (status === "FAILED" || status === "CANCELED") {
        const progressSnapshot = formatHeartbeatProgress(run);
        console.log(
          `${chalk.gray(stamp())} ${chalk.bgBlue.white.bold(" trigger-image-processing ")} ${chalk.bgWhite.black.bold(" info ")} ${chalk.white(`run_status run=${runId} status=${status} ${progressSnapshot}`)}`,
        );
      }
    }

    if (
      status === "COMPLETED" ||
      status === "FAILED" ||
      status === "CANCELED"
    ) {
      reachedTerminalStatus = true;
      break;
    }
  }

  if (!latestRun) {
    throw new Error(`No run updates received for run_id=${runId}`);
  }

  const finalStatus = String(latestRun.status || "UNKNOWN").toUpperCase();
  if (!reachedTerminalStatus && finalStatus === "UNKNOWN") {
    throw new Error(
      `Trigger run stream ended without terminal status run_id=${runId}`,
    );
  }
  if (finalStatus !== "COMPLETED") {
    const err = latestRun.error;
    const errorMessage =
      err && typeof err === "object"
        ? String(err.message || err.name || "unknown trigger run failure")
        : String(err || "unknown trigger run failure");
    throw new Error(
      `Trigger run did not complete run_id=${runId} status=${finalStatus} error=${errorMessage}`,
    );
  }

  if (!latestRun.output || typeof latestRun.output !== "object") {
    throw new Error(`Trigger run missing output run_id=${runId}`);
  }

  return {
    runId,
    output: latestRun.output,
  };
}

function makeExceptionMap(errors) {
  const map = new Map();
  for (const row of errors) {
    const code = String(row.code || "");
    if (code !== "source_403" && code !== "source_429") {
      continue;
    }
    const key = String(row.work_id || "");
    if (!key) {
      continue;
    }
    map.set(key, {
      workId: key,
      sourceImageUrl: String(row.source_image_url || ""),
      code: String(row.code || "source_403"),
      message: String(row.message || ""),
    });
  }
  return Array.from(map.values());
}

function guessExtension(contentType, sourceUrl) {
  const lower = String(contentType || "").toLowerCase();
  if (lower.includes("png")) return "png";
  if (lower.includes("webp")) return "webp";
  if (lower.includes("avif")) return "avif";
  if (lower.includes("gif")) return "gif";

  try {
    const path = new URL(sourceUrl).pathname;
    const name = path.split("/").pop() || "";
    const dot = name.lastIndexOf(".");
    if (dot > -1) {
      return name.slice(dot + 1).toLowerCase();
    }
  } catch {
    // ignore
  }

  return "jpg";
}

function stripQueryAndHash(rawUrl) {
  const parsed = new URL(rawUrl);
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function contentTypeFromExt(ext) {
  switch (ext) {
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "avif":
      return "image/avif";
    case "gif":
      return "image/gif";
    default:
      return "image/jpeg";
  }
}

function readFirstEnv(keys) {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) {
      return value;
    }
  }
  return null;
}

function resolveProxyUrlFromEnv() {
  return readFirstEnv([
    "CLOAKBROWSER_HTTPS_PROXY",
    "CLOAKBROWSER_HTTP_PROXY",
    "CLOAKBROWSER_PROXY",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "https_proxy",
    "http_proxy",
  ]);
}

function resolveCloakBrowserProxyConfig() {
  const proxyUrl = resolveProxyUrlFromEnv();

  if (!proxyUrl) {
    return null;
  }

  try {
    const parsed = new URL(proxyUrl);
    const server = `${parsed.protocol}//${parsed.host}`;
    const username = parsed.username
      ? decodeURIComponent(parsed.username)
      : undefined;
    const password = parsed.password
      ? decodeURIComponent(parsed.password)
      : undefined;
    return {
      server,
      ...(username ? { username } : {}),
      ...(password ? { password } : {}),
    };
  } catch {
    return { server: proxyUrl };
  }
}

async function fetchViaProxyHttp(sourceUrl, proxyUrl) {
  if (!proxyUrl) {
    throw new Error("proxy url not configured");
  }

  let ProxyAgentClass = null;
  try {
    const undiciModule = await import("undici");
    if (typeof undiciModule?.ProxyAgent === "function") {
      ProxyAgentClass = undiciModule.ProxyAgent;
    }
  } catch {
    // Continue with explicit error below.
  }

  if (!ProxyAgentClass) {
    throw new Error("undici ProxyAgent unavailable for proxy fetch");
  }

  const dispatcher = new ProxyAgentClass(proxyUrl);

  try {
    const sourceHost = new URL(sourceUrl).host;
    const sourceOrigin = `https://${sourceHost}`;

    const response = await fetch(sourceUrl, {
      method: "GET",
      redirect: "follow",
      headers: {
        accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        referer: `${sourceOrigin}/`,
        origin: sourceOrigin,
      },
      dispatcher,
    });

    if (!response.ok) {
      throw new Error(`proxy_http_fetch_failed status=${response.status}`);
    }

    return {
      bytes: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get("content-type") || "",
    };
  } finally {
    if (typeof dispatcher?.close === "function") {
      await dispatcher.close();
    }
  }
}

async function fetchViaCloakBrowserWithMode(sourceUrl, mode, proxyConfig) {
  const browser = await launchCloakBrowser({ headless: true });
  let context = null;
  try {
    const contextOptions = {
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
      ignoreHTTPSErrors: false,
      ...(mode === "proxy" && proxyConfig ? { proxy: proxyConfig } : {}),
    };

    context = await browser.newContext(contextOptions);

    const sourceHost = new URL(sourceUrl).host;
    const sourceOrigin = `https://${sourceHost}`;

    if (context.request && typeof context.request.get === "function") {
      const response = await context.request.get(sourceUrl, {
        timeout: 60000,
        headers: {
          accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
          referer: `${sourceOrigin}/`,
          origin: sourceOrigin,
        },
      });
      if (response.ok()) {
        const headers =
          typeof response.headers === "function" ? response.headers() : {};
        const contentType =
          headers["content-type"] || headers["Content-Type"] || "";
        const bytes = Buffer.from(await response.body());
        return { bytes, contentType };
      }
    }

    const page = await context.newPage();
    try {
      try {
        await page.goto(`${sourceOrigin}/`, {
          waitUntil: "domcontentloaded",
          timeout: 45000,
        });
      } catch {
        // Continue.
      }

      const result = await page.evaluate(async (url) => {
        const res = await fetch(url, {
          method: "GET",
          credentials: "include",
          mode: "cors",
          redirect: "follow",
        });
        if (!res.ok) {
          return { ok: false, status: res.status, contentType: "", base64: "" };
        }
        const contentType = res.headers.get("content-type") || "";
        const arr = new Uint8Array(await res.arrayBuffer());
        let binary = "";
        for (let i = 0; i < arr.length; i += 1) {
          binary += String.fromCharCode(arr[i]);
        }
        return {
          ok: true,
          status: res.status,
          contentType,
          base64: btoa(binary),
        };
      }, sourceUrl);

      if (!result.ok) {
        throw new Error(
          `cloakbrowser page fetch failed status=${result.status}`,
        );
      }

      return {
        bytes: Buffer.from(result.base64, "base64"),
        contentType: result.contentType || "",
      };
    } finally {
      await page.close();
    }
  } finally {
    if (context) {
      await context.close();
    }
    await browser.close();
  }
}

async function recover403WithCloakBrowserAndUpload(options, s3, exceptions) {
  const proxyConfig = resolveCloakBrowserProxyConfig();
  const proxyUrl = resolveProxyUrlFromEnv();
  const recoveries = await runWithConcurrency(
    exceptions,
    options.exceptionFetchConcurrency,
    async (row) => {
      const workId = String(row.workId);
      const sourceUrl = String(row.sourceImageUrl);

      let proxyFetchError = null;
      let directError = null;
      let proxyError = null;
      try {
        let fetched = null;
        let recoveryMode = "proxy_http_fetch";

        try {
          fetched = await fetchViaProxyHttp(sourceUrl, proxyUrl);
        } catch (error) {
          proxyFetchError =
            error instanceof Error ? error.message : String(error);
        }

        if (!fetched) {
          recoveryMode = "cloakbrowser_direct";
          try {
            fetched = await fetchViaCloakBrowserWithMode(
              sourceUrl,
              "direct",
              null,
            );
          } catch (error) {
            directError =
              error instanceof Error ? error.message : String(error);
          }
        }

        if (!fetched) {
          recoveryMode = "cloakbrowser_proxy";
          if (!proxyConfig) {
            throw new Error(
              `proxy_http_failed_then_direct_failed_no_proxy_config proxy_http_error=${proxyFetchError ?? "unknown"} direct_error=${directError ?? "unknown"}`,
            );
          }

          try {
            fetched = await fetchViaCloakBrowserWithMode(
              sourceUrl,
              "proxy",
              proxyConfig,
            );
          } catch (error) {
            proxyError = error instanceof Error ? error.message : String(error);
            throw new Error(
              `proxy_http_failed_then_direct_failed_then_proxy_failed proxy_http_error=${proxyFetchError ?? "unknown"} direct_error=${directError ?? "unknown"} proxy_error=${proxyError}`,
            );
          }
        }

        const canonical = stripQueryAndHash(sourceUrl);
        const sourceHash = createHash("sha1").update(canonical).digest("hex");
        const host = new URL(sourceUrl).host.replace(/[^a-zA-Z0-9.-]+/g, "-");
        const ext = guessExtension(fetched.contentType, sourceUrl);
        const key = `${options.uploadPrefix}/original-cache/${host}/${sourceHash.slice(0, 2)}/${sourceHash}.${ext}`;

        await s3.send(
          new PutObjectCommand({
            Bucket: BUNNY_BUCKET,
            Key: key,
            Body: fetched.bytes,
            ContentType: fetched.contentType || contentTypeFromExt(ext),
          }),
        );

        await s3.send(
          new HeadObjectCommand({
            Bucket: BUNNY_BUCKET,
            Key: key,
          }),
        );

        const object = await s3.send(
          new GetObjectCommand({
            Bucket: BUNNY_BUCKET,
            Key: key,
          }),
        );

        if (!object.Body) {
          throw new Error("verification getObject body missing");
        }

        const stored = await streamToBuffer(object.Body);
        const sourceMd5 = createHash("md5").update(fetched.bytes).digest("hex");
        const storedMd5 = createHash("md5").update(stored).digest("hex");
        if (sourceMd5 !== storedMd5) {
          throw new Error("uploaded original MD5 mismatch");
        }

        return {
          ok: true,
          workId,
          sourceImageUrl: sourceUrl,
          recoveryMode,
          sourceS3Key: key,
          sourceMd5,
          byteLength: fetched.bytes.byteLength,
        };
      } catch (error) {
        return {
          ok: false,
          workId,
          sourceImageUrl: sourceUrl,
          recoveryMode: "failed",
          proxyFetchError,
          directError,
          proxyError,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  const recovered = recoveries.filter((row) => row.ok);
  const failed = recoveries.filter((row) => !row.ok);

  return { recovered, failed };
}

function buildS3RetryPayload(items, options) {
  return {
    operationId: options.operationId,
    batchId: options.batchId,
    batchIndex: options.batchIndex,
    batchCount: options.batchCount,
    workerConcurrency: Math.min(5, options.workerConcurrency),
    fetchTimeoutMs: options.fetchTimeoutMs,
    fetchRetryCount: options.fetchRetryCount,
    sleepSecondsPerItem: 0,
    dryRun: options.dryRunCloud,
    uploadPrefix: options.uploadPrefix,
    verboseLogs: false,
    items: items.map((item) => ({
      workId: item.workId,
      sourceType: "s3",
      sourceS3Bucket: BUNNY_BUCKET,
      sourceS3Key: item.sourceS3Key,
      sourceImageUrl: item.sourceImageUrl,
    })),
  };
}

async function verifyRunUploadsOnS3(s3, successfulItems) {
  const verification = await runWithConcurrency(
    successfulItems,
    20,
    async (item) => {
      const workId = String(item.work_id || "");
      const sourceImageUrl = String(item.source_image_url || "");
      const key = String(item.final_name || "");

      if (!workId || !key) {
        return {
          ok: false,
          error: {
            work_id: workId || "missing_work_id",
            source_image_url: sourceImageUrl,
            code: "s3_verify_invalid_item",
            message: "missing work_id or final_name for s3 verification",
          },
        };
      }

      if (String(item.stored_status_on_s3 || "") !== "uploaded") {
        return {
          ok: false,
          error: {
            work_id: workId,
            source_image_url: sourceImageUrl,
            code: "s3_verify_not_uploaded",
            message: `stored_status_on_s3=${String(item.stored_status_on_s3 || "unknown")}`,
          },
        };
      }

      try {
        await s3.send(
          new HeadObjectCommand({
            Bucket: BUNNY_BUCKET,
            Key: key,
          }),
        );

        return {
          ok: true,
          item: {
            ...item,
            s3_verified: true,
            s3_verified_at: new Date().toISOString(),
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          error: {
            work_id: workId,
            source_image_url: sourceImageUrl,
            code: "s3_verify_missing",
            message: `head_object_failed key=${key} error=${message}`,
          },
        };
      }
    },
  );

  const verifiedItems = verification
    .filter((row) => row.ok)
    .map((row) => row.item);
  const verificationErrors = verification
    .filter((row) => !row.ok)
    .map((row) => row.error);

  return {
    verifiedItems,
    verificationErrors,
  };
}

async function runCloudBatches(
  batchPayloads,
  options,
  reportPrefix,
  onBatchComplete,
) {
  const startedAtMs = Date.now();
  const totalItems = batchPayloads.reduce((sum, payload) => {
    const count = Array.isArray(payload?.items) ? payload.items.length : 0;
    return sum + count;
  }, 0);

  let completed = 0;
  let completedItems = 0;
  let processedCount = 0;
  let failedCount = 0;
  let startedBatches = 0;
  const liveRunProgress = new Map();
  let noWorkerProgressStreak = 0;
  let lastAggregateCompleted = 0;

  const heartbeatTimer = setInterval(
    () => {
      const nowMs = Date.now();
      const freshnessWindowMs =
        Math.max(10, options.heartbeatSeconds) * 3 * 1000;
      const inFlightBatches = Math.max(0, startedBatches - completed);
      const pendingBatches = Math.max(0, batchPayloads.length - startedBatches);
      let inFlightCompletedItems = 0;
      let queuedItems = 0;
      let inFlightItems = 0;
      let inFlightSucceeded = 0;
      let inFlightFailed = 0;
      const executingRunIds = [];

      for (const state of liveRunProgress.values()) {
        const p = state.progress;
        if (!p) {
          continue;
        }
        inFlightCompletedItems += p.completed;
        inFlightSucceeded += p.succeeded;
        inFlightFailed += p.failed;

        const status = String(state.status || "").toUpperCase();
        const isExecuting = status === "EXECUTING" || status === "RUNNING";
        if (!isExecuting) {
          continue;
        }

        if (typeof state.runId === "string" && state.runId) {
          executingRunIds.push(state.runId);
        }

        const isFresh =
          (p.updatedAtMs !== null &&
            nowMs - p.updatedAtMs <= freshnessWindowMs) ||
          (Number.isFinite(state.observedAtMs) &&
            nowMs - state.observedAtMs <= freshnessWindowMs);
        if (!isFresh) {
          continue;
        }

        queuedItems += p.queued;
        inFlightItems += p.active;
      }

      const rawAggregateCompleted = Math.min(
        totalItems,
        completedItems + inFlightCompletedItems,
      );
      const aggregateCompleted = Math.max(
        lastAggregateCompleted,
        rawAggregateCompleted,
      );
      lastAggregateCompleted = aggregateCompleted;
      const estimatedSucceeded = processedCount + inFlightSucceeded;
      const estimatedFailed = failedCount + inFlightFailed;

      const hasNoLiveWorkerSignals =
        inFlightBatches > 0 && queuedItems === 0 && inFlightItems === 0;
      if (hasNoLiveWorkerSignals) {
        noWorkerProgressStreak += 1;
        if (noWorkerProgressStreak >= 2) {
          const runStatusTokens = [];
          for (const [runId, state] of liveRunProgress.entries()) {
            runStatusTokens.push(
              `${runId}:${String(state.status || "unknown").toUpperCase()}`,
            );
          }
          console.log(
            `${chalk.gray(stamp())} ${chalk.bgBlue.white.bold(" trigger-image-processing ")} ${chalk.bgYellow.black.bold(" warn ")} ${chalk.yellow(`no active item signals while batches remain in_flight=${inFlightBatches} streak=${noWorkerProgressStreak} run_statuses=${runStatusTokens.join(",") || "none"}`)}`,
          );
        }
      } else {
        noWorkerProgressStreak = 0;
      }

      const line = formatModeProgressLine({
        mode: reportPrefix,
        completed: aggregateCompleted,
        total: totalItems,
        startedAtMs,
        text:
          `heartbeat batches_completed=${completed}/${batchPayloads.length} ` +
          `in_flight=${inFlightBatches} pending=${pendingBatches} ` +
          `finalized_completed=${completedItems}/${totalItems} ` +
          `executing_runs=${executingRunIds.length} ` +
          `run_ids=${executingRunIds.join(",") || "none"} ` +
          `finalized_processed=${processedCount} finalized_failed=${failedCount} ` +
          `est_processed=${estimatedSucceeded} est_failed=${estimatedFailed}`,
      });

      console.log(
        `${chalk.gray(stamp())} ${chalk.bgBlue.white.bold(" trigger-image-processing ")} ${chalk.bgMagenta.white.bold(" tick ")} ${chalk.magenta(line)}`,
      );
    },
    Math.max(5, options.heartbeatSeconds) * 1000,
  );

  try {
    return await runWithConcurrency(
      batchPayloads,
      options.runConcurrency,
      async (payload, index) => {
        startedBatches += 1;
        const filePath = resolve(
          process.cwd(),
          `.tmp/reports/${reportPrefix}-batch-${String(index + 1).padStart(3, "0")}.json`,
        );

        await writeFile(
          filePath,
          `${JSON.stringify(payload, null, 2)}\n`,
          "utf8",
        );
        const run = await triggerBatch(payload, options, {
          onProgress: ({ runId, status, progress, observedAtMs }) => {
            liveRunProgress.set(runId, {
              runId,
              status,
              progress,
              observedAtMs,
            });
          },
        });

        const output = run.output || {};
        const batchProcessed = Number(output.processed_count ?? 0);
        const batchFailed = Number(output.failed_count ?? 0);
        const batchCompletedItems = batchProcessed + batchFailed;
        completed += 1;
        completedItems += batchCompletedItems;
        processedCount += batchProcessed;
        failedCount += batchFailed;
        liveRunProgress.delete(run.runId);

        const line = formatModeProgressLine({
          mode: reportPrefix,
          completed: completedItems,
          total: totalItems,
          startedAtMs,
          text:
            `batches=${completed}/${batchPayloads.length} run=${run.runId ?? "unknown"} ` +
            `batch_processed=${batchProcessed} batch_failed=${batchFailed} ` +
            `cumulative_processed=${processedCount} cumulative_failed=${failedCount}`,
        });
        console.log(
          `${chalk.gray(stamp())} ${chalk.bgBlue.white.bold(" trigger-image-processing ")} ${chalk.bgBlueBright.white.bold(" prog  ")} ${line}`,
        );

        if (onBatchComplete) {
          await onBatchComplete({
            reportPrefix,
            batchIndex: index,
            batchCount: batchPayloads.length,
            payload,
            payloadPath: filePath,
            run,
          });
        }

        return {
          payloadPath: filePath,
          run,
        };
      },
    );
  } finally {
    clearInterval(heartbeatTimer);
  }
}

function flattenPayloadItems(payloads) {
  const flattened = [];
  for (const payload of payloads) {
    const items = Array.isArray(payload?.items) ? payload.items : [];
    for (const item of items) {
      flattened.push({
        workId: item.workId,
        sourceImageUrl: item.sourceImageUrl,
      });
    }
  }
  return flattened;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const progress = createProgress("trigger-image-processing");

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("Missing DATABASE_URL");
  }

  const secretAccessKey = process.env.BUNNY_STORAGE_SECRET_ACCESS_KEY?.trim();
  if (!secretAccessKey) {
    throw new Error("Missing BUNNY_STORAGE_SECRET_ACCESS_KEY");
  }

  const startedAt = Date.now();
  const pool = new Pool({ connectionString: databaseUrl, max: 6 });
  const s3 = makeS3Client(secretAccessKey);
  const operationId = createOperationId();

  progress.phase("starting run");
  progress.info(
    `operation_id=${operationId} target_count=${options.targetCount} task_concurrency_requested=${options.requestedTaskConcurrency} task_concurrency_effective=${options.taskConcurrency} task_concurrency_cap=${MAX_TASK_CONCURRENCY} batch_size_derived=${options.batchSize} worker_concurrency_fixed=${options.workerConcurrency} fetch_timeout_ms=${options.fetchTimeoutMs} fetch_retry_count=${options.fetchRetryCount} claim_pool_multiplier=${options.claimPoolMultiplier} claim_pool_max=${options.claimPoolMax} env=${options.env} upload_prefix=${options.uploadPrefix} dry_run_cloud=${options.dryRunCloud} replay_prefix=${options.replayReportPrefix || "none"} disable_exception_recovery=${options.disableExceptionRecovery}`,
  );

  const report = {
    started_at: new Date().toISOString(),
    operation_id: operationId,
    options,
    claimed_count: 0,
    initial_batches: [],
    exception_rounds: [],
    summary: {},
  };

  try {
    let initialPayloads = [];
    if (options.replayReportPrefix) {
      progress.phase("loading replay payloads from reports");
      const replayPayloads = await loadReplayBatchPayloads(
        options.replayReportPrefix,
      );
      if (replayPayloads.length === 0) {
        throw new Error(
          `No replay batch payloads found for prefix=${options.replayReportPrefix}`,
        );
      }
      report.claimed_count = replayPayloads.reduce((sum, payload) => {
        const count = Array.isArray(payload?.items) ? payload.items.length : 0;
        return sum + count;
      }, 0);

      const replayItems = flattenPayloadItems(replayPayloads);
      const balancedReplay = rebalanceItemsByHost(replayItems);
      const replayChunks = chunkArray(balancedReplay.items, options.batchSize);
      initialPayloads = replayChunks.map((chunk, index) => {
        const batchIndex = index;
        const batchCount = replayChunks.length;
        return buildBatchPayload(chunk, {
          ...options,
          operationId,
          batchId: `${operationId}-initial-${String(index + 1).padStart(3, "0")}`,
          batchIndex,
          batchCount,
        });
      });

      progress.info(
        `replay_payloads_loaded=${replayPayloads.length} replay_rebalanced_batches=${initialPayloads.length} replay_item_count=${report.claimed_count} replay_distinct_hosts=${balancedReplay.hostCount}`,
      );
    } else {
      progress.phase("claiming rows from postgres");
      const claimPoolSize = Math.max(
        options.targetCount,
        Math.min(
          options.claimPoolMax,
          options.targetCount * options.claimPoolMultiplier,
        ),
      );
      progress.info(`claim_pool_size=${claimPoolSize}`);
      const claimed = await claimPendingRows(
        pool,
        options.targetCount,
        claimPoolSize,
      );
      report.claimed_count = claimed.length;
      progress.info(`claimed_count=${claimed.length}`);

      if (claimed.length === 0) {
        report.summary = {
          message: "no pending rows claimed",
        };
        const emptyPath = resolve(
          process.cwd(),
          `.tmp/reports/trigger-image-processing-run-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
        );
        await writeFile(
          emptyPath,
          `${JSON.stringify(report, null, 2)}\n`,
          "utf8",
        );
        console.log(`no_work report_path=${emptyPath}`);
        progress.done(`no work claimed report_path=${emptyPath}`);
        return;
      }

      const balancedClaimed = rebalanceItemsByHost(claimed);
      progress.info(
        `claimed_distinct_hosts=${balancedClaimed.hostCount} rebalanced_claimed_items=${balancedClaimed.items.length}`,
      );

      const initialChunks = chunkArray(
        balancedClaimed.items,
        options.batchSize,
      );
      initialPayloads = initialChunks.map((chunk, index) => {
        const batchIndex = index;
        const batchCount = initialChunks.length;
        return buildBatchPayload(chunk, {
          ...options,
          operationId,
          batchId: `${operationId}-initial-${String(index + 1).padStart(3, "0")}`,
          batchIndex,
          batchCount,
        });
      });
    }

    progress.phase("dispatching initial cloud batches");
    progress.info(`initial_batch_count=${initialPayloads.length}`);
    let initialProcessedCount = 0;
    let initialFailedCount = 0;
    const initialErrors = [];
    const retryErrorsAllRounds = [];

    await runCloudBatches(
      initialPayloads,
      options,
      "trigger-image-processing-initial",
      async ({ batchIndex, batchCount, payloadPath, run }) => {
        const output = run.output || {};
        const successItems = Array.isArray(output.items) ? output.items : [];
        const runErrors = Array.isArray(output.errors) ? output.errors : [];

        const verification = await verifyRunUploadsOnS3(s3, successItems);
        const batchErrors = [...runErrors, ...verification.verificationErrors];

        await updateSuccessRows(pool, verification.verifiedItems, "url");
        await updateFailureRows(pool, batchErrors, "initial");

        initialProcessedCount += verification.verifiedItems.length;
        initialFailedCount += batchErrors.length;
        initialErrors.push(...batchErrors);

        report.initial_batches.push({
          run_id: run.runId,
          item_count:
            output.item_count ?? successItems.length + runErrors.length,
          processed_count: verification.verifiedItems.length,
          failed_count: batchErrors.length,
          elapsed_ms: output.elapsed_ms ?? null,
          payload_file: payloadPath,
        });

        if (batchErrors.length > 0) {
          progress.warn(
            `initial batch ${batchIndex + 1}/${batchCount} run=${run.runId ?? "unknown"} exceptions=${batchErrors.length} verified=${verification.verifiedItems.length}`,
          );
        }
      },
    );

    progress.phase("initial phase writeback complete");
    progress.info(
      `initial_processed_items=${initialProcessedCount} initial_error_items=${initialFailedCount}`,
    );

    let currentExceptions = makeExceptionMap(initialErrors);
    progress.info(`initial_exception_candidates=${currentExceptions.length}`);

    if (options.disableExceptionRecovery) {
      progress.warn(
        "exception recovery disabled; skipping local cloakbrowser rounds",
      );
      currentExceptions = [];
    }

    for (let round = 1; round <= options.maxExceptionRounds; round += 1) {
      if (currentExceptions.length === 0) {
        break;
      }

      progress.phase(`exception round ${round}: cloakbrowser recovery`);
      progress.info(`incoming_exceptions=${currentExceptions.length}`);

      const recovered = await recover403WithCloakBrowserAndUpload(
        options,
        s3,
        currentExceptions,
      );

      progress.info(
        `round=${round} recovered=${recovered.recovered.length} recovery_failed=${recovered.failed.length}`,
      );

      const recoveredDirectCount = recovered.recovered.filter(
        (row) => row.recoveryMode === "cloakbrowser_direct",
      ).length;
      const recoveredProxyHttpCount = recovered.recovered.filter(
        (row) => row.recoveryMode === "proxy_http_fetch",
      ).length;
      const recoveredProxyCount = recovered.recovered.filter(
        (row) => row.recoveryMode === "cloakbrowser_proxy",
      ).length;
      progress.info(
        `round=${round} recovery_breakdown proxy_http=${recoveredProxyHttpCount} direct=${recoveredDirectCount} proxy=${recoveredProxyCount}`,
      );

      for (const failed of recovered.failed) {
        await pool.query(
          `
          update listing_source_image
          set
            status = 'failed_cloakbrowser_recovery',
            error_payload = coalesce(error_payload, '{}'::jsonb) || $2::jsonb,
            updated_at = now()
          where id = $1
          `,
          [
            String(failed.workId),
            JSON.stringify({
              cloakbrowser_failed_at: new Date().toISOString(),
              cloakbrowser_recovery_mode: failed.recoveryMode ?? "failed",
              proxy_http_fetch_error: failed.proxyFetchError ?? null,
              cloakbrowser_direct_error: failed.directError ?? null,
              cloakbrowser_proxy_error: failed.proxyError ?? null,
              cloakbrowser_failure_reason: failed.reason,
              source_image_url: failed.sourceImageUrl,
            }),
          ],
        );
      }

      const roundSummary = {
        round,
        incoming_exception_count: currentExceptions.length,
        recovered_count: recovered.recovered.length,
        recovery_failed_count: recovered.failed.length,
        requeue_runs: [],
      };

      if (recovered.recovered.length === 0) {
        report.exception_rounds.push(roundSummary);
        progress.warn(`round=${round} no recoveries; ending exception rounds`);
        currentExceptions = [];
        break;
      }

      progress.phase(
        `exception round ${round}: requeue recovered items to cloud`,
      );
      const retryChunks = chunkArray(recovered.recovered, options.batchSize);
      const retryPayloads = retryChunks.map((chunk, index) => {
        const batchIndex = index;
        const batchCount = retryChunks.length;
        return buildS3RetryPayload(chunk, {
          ...options,
          operationId,
          batchId: `${operationId}-retry-${String(round).padStart(2, "0")}-${String(index + 1).padStart(3, "0")}`,
          batchIndex,
          batchCount,
        });
      });
      progress.info(
        `round=${round} dispatching_s3_retry_items=${recovered.recovered.length}`,
      );
      progress.info(`round=${round} retry_batch_count=${retryPayloads.length}`);
      let retryProcessedCount = 0;
      let retryFailedCount = 0;
      const retryErrors = [];

      await runCloudBatches(
        retryPayloads,
        options,
        `trigger-image-processing-retry-round-${String(round).padStart(2, "0")}`,
        async ({ batchIndex, batchCount, payloadPath, run }) => {
          const output = run.output || {};
          const successItems = Array.isArray(output.items) ? output.items : [];
          const runErrors = Array.isArray(output.errors) ? output.errors : [];

          const verification = await verifyRunUploadsOnS3(s3, successItems);
          const batchErrors = [
            ...runErrors,
            ...verification.verificationErrors,
          ];

          await updateSuccessRows(pool, verification.verifiedItems, "s3");
          await updateFailureRows(pool, batchErrors, `retry_round_${round}`);

          retryProcessedCount += verification.verifiedItems.length;
          retryFailedCount += batchErrors.length;
          retryErrors.push(...batchErrors);

          roundSummary.requeue_runs.push({
            run_id: run.runId,
            item_count:
              output.item_count ?? successItems.length + runErrors.length,
            processed_count: verification.verifiedItems.length,
            failed_count: batchErrors.length,
            elapsed_ms: output.elapsed_ms ?? null,
            payload_file: payloadPath,
          });

          if (batchErrors.length > 0) {
            progress.warn(
              `round=${round} retry batch ${batchIndex + 1}/${batchCount} run=${run.runId ?? "unknown"} exceptions=${batchErrors.length} verified=${verification.verifiedItems.length}`,
            );
          }
        },
      );

      progress.phase(`exception round ${round}: retry writeback complete`);
      progress.info(
        `round=${round} retry_processed_items=${retryProcessedCount} retry_error_items=${retryFailedCount}`,
      );

      report.exception_rounds.push(roundSummary);
      currentExceptions = makeExceptionMap(retryErrors);
      retryErrorsAllRounds.push(...retryErrors);
      progress.info(
        `round=${round} remaining_exception_candidates=${currentExceptions.length}`,
      );
    }

    const finishedAt = Date.now();
    const retryProcessedCount = report.exception_rounds.reduce(
      (roundSum, round) =>
        roundSum +
        (Array.isArray(round.requeue_runs)
          ? round.requeue_runs.reduce(
              (batchSum, row) => batchSum + Number(row.processed_count || 0),
              0,
            )
          : 0),
      0,
    );
    const retryFailedCount = report.exception_rounds.reduce(
      (roundSum, round) =>
        roundSum +
        (Array.isArray(round.requeue_runs)
          ? round.requeue_runs.reduce(
              (batchSum, row) => batchSum + Number(row.failed_count || 0),
              0,
            )
          : 0),
      0,
    );
    const finalProcessedCount = initialProcessedCount + retryProcessedCount;
    const finalFailedCount = initialFailedCount + retryFailedCount;
    const completionPct =
      report.claimed_count > 0
        ? roundToOne((finalProcessedCount / report.claimed_count) * 100)
        : 0;
    const failurePct =
      report.claimed_count > 0
        ? roundToOne((finalFailedCount / report.claimed_count) * 100)
        : 0;
    const elapsedMinutes = Math.max(1 / 60, (finishedAt - startedAt) / 60000);
    const throughputPerMinute = roundToOne(
      finalProcessedCount / elapsedMinutes,
    );
    const allRunErrors = [...initialErrors, ...retryErrorsAllRounds];

    report.summary = {
      elapsed_ms: finishedAt - startedAt,
      claimed_count: report.claimed_count,
      initial_run_count: report.initial_batches.length,
      initial_processed_count: initialProcessedCount,
      initial_failed_count: initialFailedCount,
      retry_round_count: report.exception_rounds.length,
      retry_processed_count: retryProcessedCount,
      retry_failed_count: retryFailedCount,
      final_processed_count: finalProcessedCount,
      final_failed_count: finalFailedCount,
      completion_pct: completionPct,
      failure_pct: failurePct,
      throughput_images_per_minute: throughputPerMinute,
      initial_error_code_counts: countErrorsByCode(initialErrors),
      retry_error_code_counts: countErrorsByCode(retryErrorsAllRounds),
      all_error_code_counts: countErrorsByCode(allRunErrors),
      all_error_category_counts: countErrorsByCategory(allRunErrors),
      top_failure_hosts: sortCountsDesc(countErrorsByHost(allRunErrors), 10),
      category_sample_messages: sampleMessagesByCategory(allRunErrors),
      remaining_exception_count: currentExceptions.length,
    };

    const reportPath = resolve(
      process.cwd(),
      `.tmp/reports/trigger-image-processing-run-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
    );

    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

    console.log("trigger_image_processing_complete");
    console.log(JSON.stringify(report.summary, null, 2));
    console.log(`report_path=${reportPath}`);
    progress.done(
      `completed claimed=${report.summary.claimed_count} final_processed=${report.summary.final_processed_count} final_failed=${report.summary.final_failed_count} completion_pct=${report.summary.completion_pct}% throughput_img_per_min=${report.summary.throughput_images_per_minute} remaining_exceptions=${report.summary.remaining_exception_count}`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    `${chalk.gray(stamp())} ${chalk.bgBlue.white.bold(" trigger-image-processing ")} ${chalk.bgRed.white.bold(" fail ")} ${chalk.red(message)}`,
  );
  console.error(`run-trigger-image-processing failed: ${message}`);
  process.exit(1);
});
