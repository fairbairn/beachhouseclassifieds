import { Queue } from "bullmq";
import IORedis from "ioredis";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  imageJobMetricTrendKeys,
  readImageJobMetricRollupWindows,
  syncImageJobMetricTrends,
  type ImageJobMetricName,
} from "@/lib/workers/image-job-metric-trends";
import {
  IMAGE_GROUP_JOBS,
  IMAGE_PERF_ROLLUPS_HASH_KEY,
  IMAGE_RAW_JOB_TREND_CURSOR_KEY,
  IMAGE_RAW_JOB_TREND_PREFIX,
  IMAGE_SLICE_METRIC_PREFIX,
  IMAGE_SLICE_WINDOWS,
  IMAGE_TREND_PREFIX,
  imageMetricSliceHashKey,
  imageRawJobTrendMetricKey,
} from "@/lib/workers/image-metrics-redis-keys";
import {
  IMAGE_JOB_SLICE_METRIC_SLUGS,
  IMAGE_PERFORMANCE_SLICE_METRIC_SLUGS,
} from "@/lib/workers/image-metrics-registry";
import {
  OPS_SNAPSHOT_TREND_METRIC_REGISTRY,
  OPS_TREND_METRIC_REGISTRY,
  readOpsRunnerTrendLatest,
  readOpsSnapshotTrendLatest,
  runOpsOneShotPerformanceRefresh,
  runOpsOneShotPipeline,
  writeOpsControlSettings,
  writeOpsInfraSnapshot,
  writeOpsRunnerStatus,
} from "@/lib/workers/image-ops-control-module";
import {
  IMAGE_RUNNER_INFRA_KEY,
  IMAGE_RUNNER_SETTINGS_KEY,
  IMAGE_RUNNER_STATUS_KEY,
} from "@/lib/workers/image-runner-control";
import { createImageQueue, createRedisConnection } from "@/workers/image-queue";

const RUN_REDIS_TESTS = process.env.IMAGE_OPS_REDIS_INTEGRATION === "1";
const describeRedis = RUN_REDIS_TESTS ? describe : describe.skip;

function resolveWorkerRedisUrl(rawUrl: string): string {
  const poolId = Number.parseInt(process.env.VITEST_POOL_ID || "0", 10);
  if (!Number.isFinite(poolId) || poolId <= 0) {
    return rawUrl;
  }

  try {
    const parsed = new URL(rawUrl);
    const dbPath = parsed.pathname.replace(/^\/+/, "");
    if (!/^\d+$/.test(dbPath)) {
      return rawUrl;
    }
    const dbIndex = Number.parseInt(dbPath, 10);
    if (!Number.isFinite(dbIndex) || dbIndex < 0) {
      return rawUrl;
    }
    parsed.pathname = `/${dbIndex + poolId}`;
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

const redisUrl = resolveWorkerRedisUrl(
  process.env.IMAGE_OPS_TEST_REDIS_URL?.trim() ||
    process.env.REDIS_URL?.trim() ||
    "redis://127.0.0.1:6379/1",
);

const PERF_ROLLUP_HASH_KEY = IMAGE_PERF_ROLLUPS_HASH_KEY;
const FLUSHDB_ON_RESET = process.env.IMAGE_OPS_TEST_FLUSHDB !== "0";
const ALLOW_DB0 = process.env.IMAGE_OPS_TEST_ALLOW_DB0 === "1";
const LOG_REDIS_KEYS = process.env.IMAGE_OPS_KEY_INVENTORY_LOG === "1";
const USE_EXISTING_BULLMQ_FIXTURE =
  process.env.IMAGE_OPS_USE_EXISTING_BULLMQ_FIXTURE === "1";
const DEFAULT_BULLMQ_FIXTURE_FILE_PATH =
  "src/lib/workers/fixtures/bullmq-job-snapshots.json";
const BULLMQ_FIXTURE_FILE_PATH =
  process.env.IMAGE_OPS_BULLMQ_FIXTURE_FILE?.trim() ||
  DEFAULT_BULLMQ_FIXTURE_FILE_PATH;
const BULLMQ_FIXTURE_LIMIT = Number.parseInt(
  process.env.IMAGE_OPS_BULLMQ_FIXTURE_LIMIT || "10",
  10,
);
const EXISTING_BULLMQ_FIXTURE_LIMIT = Number.parseInt(
  process.env.IMAGE_OPS_EXISTING_BULLMQ_FIXTURE_LIMIT || "120",
  10,
);
const EXISTING_BULLMQ_FIXTURE_MIN = Number.parseInt(
  process.env.IMAGE_OPS_EXISTING_BULLMQ_FIXTURE_MIN || "100",
  10,
);
const EXISTING_BULLMQ_FIXTURE_MIN_MULTI_ITEM = Number.parseInt(
  process.env.IMAGE_OPS_EXISTING_BULLMQ_FIXTURE_MIN_MULTI_ITEM || "1",
  10,
);

const EXPECTED_RAW_METRIC_NAMES = [
  "completed_jobs",
  "fetch_ms",
  "transform_ms",
  "upload_ms",
  "end_to_end_ms",
  "elapsed_ms",
  "source_bytes",
  "transformed_bytes",
  "processed_items",
  "failed_items",
] as const;

const EXPECTED_RUNNER_METRIC_NAMES = [
  "workersRunning",
  "claimedCount",
  "queuedCount",
  "completedJobs",
  "failedJobs",
  "processedItems",
  "failedItems",
  "queueWaiting",
  "queueActive",
  "queueCompleted",
  "queueFailed",
  "queueDelayed",
  "queuePaused",
  "queueBacklog",
  "flushBatchCount",
  "pendingSuccessBuffer",
  "pendingErrorBuffer",
  "throughputImagesPerMinute",
  "avgFetchMs",
  "avgTransformMs",
  "avgUploadMs",
  "avgEndToEndMs",
] as const;

const EXPECTED_UI_METRIC_NAMES = [
  "errorsCount",
  "machinesTotal",
  "workersRunningLive",
  "queueWaitingLive",
  "queueActiveLive",
  "queueDelayedLive",
  "queuePausedLive",
  "queueCompletedLive",
  "queueFailedLive",
  "queueBacklogLive",
  "statusProcessedItems",
  "statusFailedItems",
  "statusCompletedJobs",
  "statusFailedJobs",
  "statusPendingSuccessBuffer",
  "statusPendingErrorBuffer",
  "statusFlushBatchCount",
  "settingsFlushIntervalMs",
  "settingsMaxQueueBacklog",
  "settingsRefillLowWatermark",
  "settingsRefillTargetBacklog",
  "settingsMaxClaimPerCycle",
  "dbProcessed",
  "dbPending",
  "dbTotal",
  "dbProgressPct",
  "redisWireKbpsAggregate",
  "redisIngressKbpsAggregate",
  "redisEgressKbpsAggregate",
  "redisIngressReadsAggregate",
  "redisEgressWritesAggregate",
  "rxLatencyAggregate",
  "txLatencyAggregate",
] as const;

type SeededMetricRow = {
  id: string;
  finishedAtMs: number;
  itemsCount?: number;
  includeItemTimestamps?: boolean;
  elapsedMs?: number;
  processedCount: number;
  failedCount: number;
  fetchMs: number;
  transformMs: number;
  uploadMs: number;
  sourceBytes: number;
  transformedBytes: number;
};

type WindowExpectation = {
  completedJobs: number;
  failedJobs: number;
  processedItems: number;
  failedItems: number;
  sampledCompletedJobs: number;
  avgFetchMs: number;
  avgTransformMs: number;
  avgUploadMs: number;
  avgEndToEndMs: number;
};

function makeStatus() {
  return {
    operationId: "op-metrics-contract",
    mode: "running" as const,
    desiredMode: "run" as const,
    gateReason: "gate=open",
    workersRunning: 3,
    claimedCount: 14,
    queuedCount: 12,
    completedJobs: 9,
    failedJobs: 2,
    processedItems: 41,
    failedItems: 5,
    queueWaiting: 6,
    queueActive: 2,
    queueCompleted: 9,
    queueFailed: 2,
    queueDelayed: 1,
    queuePaused: 0,
    queueBacklog: 9,
    lastFlushAt: new Date().toISOString(),
    flushBatchCount: 4,
    pendingSuccessBuffer: 1,
    pendingErrorBuffer: 1,
    throughputImagesPerMinute: 123,
    avgFetchMs: 210,
    avgTransformMs: 95,
    avgUploadMs: 65,
    avgEndToEndMs: 370,
    updatedAt: new Date().toISOString(),
  };
}

function expectedStatusHashFrom(
  status: ReturnType<typeof makeStatus>,
): Record<string, string> {
  return {
    operation_id: String(status.operationId),
    mode: String(status.mode),
    desired_mode: String(status.desiredMode),
    gate_reason: String(status.gateReason),
    workers_running: String(status.workersRunning),
    claimed_count: String(status.claimedCount),
    queued_count: String(status.queuedCount),
    completed_jobs: String(status.completedJobs),
    failed_jobs: String(status.failedJobs),
    processed_items: String(status.processedItems),
    failed_items: String(status.failedItems),
    queue_waiting: String(status.queueWaiting),
    queue_active: String(status.queueActive),
    queue_completed: String(status.queueCompleted),
    queue_failed: String(status.queueFailed),
    queue_delayed: String(status.queueDelayed),
    queue_paused: String(status.queuePaused),
    queue_backlog: String(status.queueBacklog),
    last_flush_at: String(status.lastFlushAt),
    flush_batch_count: String(status.flushBatchCount),
    pending_success_buffer: String(status.pendingSuccessBuffer),
    pending_error_buffer: String(status.pendingErrorBuffer),
    throughput_images_per_minute: String(status.throughputImagesPerMinute),
    avg_fetch_ms: String(status.avgFetchMs),
    avg_transform_ms: String(status.avgTransformMs),
    avg_upload_ms: String(status.avgUploadMs),
    avg_end_to_end_ms: String(status.avgEndToEndMs),
    updated_at: String(status.updatedAt),
  };
}

function expectedInfraHashFrom(input: {
  workersRunning: number;
  source: string;
  updatedAt: string;
}): Record<string, string> {
  return {
    workers_running: String(input.workersRunning),
    source: String(input.source),
    updated_at: String(input.updatedAt),
  };
}

function assertLoopbackRedisUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(
      `Invalid redis URL for integration tests: ${rawUrl}. Set IMAGE_OPS_TEST_REDIS_URL to redis://127.0.0.1:<port>.`,
    );
  }

  const host = parsed.hostname.trim().toLowerCase();
  const isLoopback =
    host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (!isLoopback) {
    throw new Error(
      `Redis integration tests must run against local loopback/container mapping (127.0.0.1/localhost). Got host=${host} url=${rawUrl}`,
    );
  }

  const dbPath = parsed.pathname?.trim() || "";
  const dbIndexRaw = dbPath.startsWith("/") ? dbPath.slice(1) : dbPath;
  const dbIndex = dbIndexRaw ? Number(dbIndexRaw) : 0;
  const validDbIndex = Number.isFinite(dbIndex) && dbIndex >= 0;
  if (!validDbIndex) {
    throw new Error(
      `Redis integration tests require a valid DB index in URL path. Got url=${rawUrl}`,
    );
  }
  if (dbIndex === 0 && !ALLOW_DB0) {
    throw new Error(
      `Refusing to run metrics integration tests against Redis DB 0. Use redis://127.0.0.1:6379/1 (or another non-zero DB), or set IMAGE_OPS_TEST_ALLOW_DB0=1 to override intentionally.`,
    );
  }
}

function buildExpectedWindow(
  rows: SeededMetricRow[],
  failedTimestampsMs: number[],
  windowStartMs: number,
): WindowExpectation {
  const included = rows.filter((row) => row.finishedAtMs >= windowStartMs);
  const perItemCount = (row: SeededMetricRow): number => {
    const itemCount =
      row.itemsCount ?? Math.max(0, Math.floor(row.processedCount));
    return itemCount > 0 ? itemCount : 1;
  };

  const weightedAverageRounded = (
    values: Array<{ value: number; weight: number }>,
  ): number => {
    const totalWeight = values.reduce((acc, entry) => acc + entry.weight, 0);
    if (totalWeight <= 0) {
      return 0;
    }
    const weightedSum = values.reduce(
      (acc, entry) => acc + entry.value * entry.weight,
      0,
    );
    return Math.round(weightedSum / totalWeight);
  };

  const weightedFetches = included.map((row) => ({
    value: row.fetchMs,
    weight: perItemCount(row),
  }));
  const weightedTransforms = included.map((row) => ({
    value: row.transformMs,
    weight: perItemCount(row),
  }));
  const weightedUploads = included.map((row) => ({
    value: row.uploadMs,
    weight: perItemCount(row),
  }));
  const weightedEndToEnd = included.map((row) => ({
    value: row.fetchMs + row.transformMs + row.uploadMs,
    weight: perItemCount(row),
  }));
  const itemPointCount = included.reduce(
    (acc, row) => acc + perItemCount(row),
    0,
  );

  return {
    completedJobs: itemPointCount,
    failedJobs: failedTimestampsMs.filter((atMs) => atMs >= windowStartMs)
      .length,
    processedItems: included.reduce(
      (acc, row) => acc + Math.max(0, row.processedCount),
      0,
    ),
    failedItems: included.reduce(
      (acc, row) => acc + Math.max(0, row.failedCount),
      0,
    ),
    sampledCompletedJobs: itemPointCount,
    avgFetchMs: weightedAverageRounded(weightedFetches),
    avgTransformMs: weightedAverageRounded(weightedTransforms),
    avgUploadMs: weightedAverageRounded(weightedUploads),
    avgEndToEndMs: weightedAverageRounded(weightedEndToEnd),
  };
}

function expectRollupMatches(
  actual: {
    completedJobs: number;
    failedJobs: number;
    processedItems: number;
    failedItems: number;
    sampledCompletedJobs: number;
    avgFetchMs: number;
    avgTransformMs: number;
    avgUploadMs: number;
    avgEndToEndMs: number;
  },
  expected: WindowExpectation,
): void {
  expect(actual.completedJobs).toBe(expected.completedJobs);
  expect(actual.failedJobs).toBe(expected.failedJobs);
  expect(actual.processedItems).toBe(expected.processedItems);
  expect(actual.failedItems).toBe(expected.failedItems);
  expect(actual.sampledCompletedJobs).toBe(expected.sampledCompletedJobs);
  expect(actual.avgFetchMs).toBe(expected.avgFetchMs);
  expect(actual.avgTransformMs).toBe(expected.avgTransformMs);
  expect(actual.avgUploadMs).toBe(expected.avgUploadMs);
  expect(actual.avgEndToEndMs).toBe(expected.avgEndToEndMs);
}

async function scanDeleteByPrefix(
  redis: IORedis,
  prefix: string,
): Promise<number> {
  let cursor = "0";
  let deleted = 0;
  do {
    const [nextCursor, keys] = await redis.scan(
      cursor,
      "MATCH",
      `${prefix}*`,
      "COUNT",
      "200",
    );
    cursor = nextCursor;
    if (Array.isArray(keys) && keys.length > 0) {
      deleted += await redis.del(...keys);
    }
  } while (cursor !== "0");
  return deleted;
}

async function scanKeys(redis: IORedis, pattern = "*"): Promise<string[]> {
  let cursor = "0";
  const keys: string[] = [];
  do {
    const [nextCursor, batch] = await redis.scan(
      cursor,
      "MATCH",
      pattern,
      "COUNT",
      "500",
    );
    cursor = nextCursor;
    if (Array.isArray(batch) && batch.length > 0) {
      keys.push(...batch);
    }
  } while (cursor !== "0");
  return keys.sort();
}

async function resetState(redis: IORedis): Promise<void> {
  if (FLUSHDB_ON_RESET) {
    await redis.flushdb();
    return;
  }

  await redis.del(
    IMAGE_RUNNER_SETTINGS_KEY,
    IMAGE_RUNNER_STATUS_KEY,
    IMAGE_RUNNER_INFRA_KEY,
    PERF_ROLLUP_HASH_KEY,
  );

  const queueConnection = createRedisConnection();
  const queue = createImageQueue(queueConnection);
  try {
    await queue.obliterate({ force: true });
  } finally {
    await queue.close().catch(() => undefined);
    await queueConnection.quit().catch(() => undefined);
  }

  for (const keySet of imageJobMetricTrendKeys()) {
    await redis.del(keySet.trendKey);
  }
  for (const metricSlug of IMAGE_PERFORMANCE_SLICE_METRIC_SLUGS) {
    await redis.del(imageMetricSliceHashKey(metricSlug));
  }
  for (const metricSlug of IMAGE_JOB_SLICE_METRIC_SLUGS) {
    await redis.del(imageMetricSliceHashKey(metricSlug, IMAGE_GROUP_JOBS));
  }
  await scanDeleteByPrefix(redis, `${IMAGE_RAW_JOB_TREND_PREFIX}:`);
  await scanDeleteByPrefix(redis, `${IMAGE_SLICE_METRIC_PREFIX}:`);
  await scanDeleteByPrefix(redis, `${IMAGE_TREND_PREFIX}:${IMAGE_GROUP_JOBS}:`);
}

async function seedCompletedJobMetrics(input: {
  redis: IORedis;
  queue: Queue;
  rows: SeededMetricRow[];
  failedAtMs: number[];
}): Promise<void> {
  const completedKey = input.queue.toKey("completed");
  const failedKey = input.queue.toKey("failed");
  const pipeline = input.redis.pipeline();

  for (const row of input.rows) {
    const itemCount = Math.max(1, Math.floor(row.processedCount));
    const includeItemTimestamps = row.includeItemTimestamps !== false;
    const perItemElapsedMs = Math.max(
      1,
      row.fetchMs + row.transformMs + row.uploadMs,
    );
    const jobCompletedAtMs = row.finishedAtMs;
    const jobStartedAtMs =
      jobCompletedAtMs - Math.max(1, perItemElapsedMs * itemCount);
    const items = Array.from({ length: itemCount }, (_, itemIndex) => {
      const itemCompletedAtMs =
        jobStartedAtMs + perItemElapsedMs * (itemIndex + 1);
      return {
        s3_verified: true,
        source_mode: "url",
        ...(includeItemTimestamps
          ? { processed_at: new Date(itemCompletedAtMs).toISOString() }
          : {}),
        source_width: 1200,
        target_width: 1920,
        source_height: 801,
        target_height: 1080,
        ...(includeItemTimestamps
          ? { s3_verified_at: new Date(itemCompletedAtMs).toISOString() }
          : {}),
        below_target_hd: true,
        fetch_elapsed_ms: row.fetchMs,
        source_fetch_mode: "url",
        transformed_bytes: row.transformedBytes,
        transformed_width: 1200,
        upload_elapsed_ms: row.uploadMs,
        source_http_status: 200,
        transformed_height: 675,
        source_content_hash: `${row.id}-src-${itemIndex + 1}`,
        stored_status_on_s3: "uploaded",
        transform_elapsed_ms: row.transformMs,
        upload_skipped_existing: false,
        transformed_content_hash: `${row.id}-dst-${itemIndex + 1}`,
        source_bytes: row.sourceBytes,
      };
    });

    const payload = {
      operation_id: `op-${row.id}`,
      batch_id: `batch-${row.id}`,
      batch_index: 1,
      batch_count: 1,
      item_count: itemCount,
      processed_count: row.processedCount,
      failed_count: row.failedCount,
      worker_concurrency: 1,
      sleep_seconds_per_item: 0,
      dry_run: false,
      upload_prefix: "v1",
      elapsed_ms: row.fetchMs + row.transformMs + row.uploadMs,
      items,
      errors: [],
      started_at: new Date(jobStartedAtMs).toISOString(),
      completed_at: new Date(jobCompletedAtMs).toISOString(),
    };

    pipeline.zadd(completedKey, row.finishedAtMs, row.id);
    pipeline.hset(
      input.queue.toKey(row.id),
      "returnvalue",
      JSON.stringify(payload),
    );
  }

  for (let index = 0; index < input.failedAtMs.length; index += 1) {
    pipeline.zadd(failedKey, input.failedAtMs[index], `failed-${index + 1}`);
  }

  await pipeline.exec();
}

type RunnerUiMetricFixture = {
  runner: Record<
    string,
    {
      expectedValue: number;
      actualValue: number | null;
      keyType: string;
      depth: number;
    }
  >;
  ui: Record<
    string,
    {
      expectedValue: number;
      actualValue: number | null;
      keyType: string;
      depth: number;
    }
  >;
};

type RawMetricFixture = Record<
  string,
  {
    expectedTrendDepth: number;
    expectedStateValue: number;
    stateValue: number | null;
    trendType: string;
    trendDepth: number;
    trendLatestValue: number | null;
  }
>;

type RawFixtureMeta = {
  rowIds: string[];
  queueCompletedKey: string;
  queueFailedKey: string;
};

type RawFixtureBundle = {
  metrics: RawMetricFixture;
  meta: RawFixtureMeta;
};

type BullmqFixtureFileEntry = {
  jobId: string;
  finishedAtMs: number;
  returnvalue: string;
};

type BullmqFixtureFile = {
  queueName?: string;
  exportedAt?: string;
  entries: BullmqFixtureFileEntry[];
};

const RAW_FIXTURE_ROW_COUNT = 120;

function buildTimedRawRows(nowMs: number): SeededMetricRow[] {
  const offsetsMs: number[] = [];

  for (let i = 0; i < 10; i += 1) {
    offsetsMs.push(1000 + i * 1000);
  }
  for (let i = 0; i < 20; i += 1) {
    offsetsMs.push(20_000 + i * 2000);
  }
  for (let i = 0; i < 40; i += 1) {
    offsetsMs.push(2 * 60_000 + i * 15_000);
  }
  for (let i = 0; i < 30; i += 1) {
    offsetsMs.push(60 * 60_000 + i * 30 * 60_000);
  }
  for (let i = 0; i < 20; i += 1) {
    offsetsMs.push(26 * 60 * 60_000 + i * 60 * 60_000);
  }

  return offsetsMs.map((offsetMs, index) => {
    const sequence = index + 1;
    const itemsCount = (sequence % 5) + 1;
    return {
      id: `raw-contract-job-${sequence}`,
      finishedAtMs: nowMs - offsetMs,
      itemsCount,
      elapsedMs:
        80 + (sequence % 17) + (40 + (sequence % 13)) + (25 + (sequence % 11)),
      processedCount: itemsCount,
      failedCount: sequence % 3 === 0 ? 1 : 0,
      fetchMs: 80 + (sequence % 17),
      transformMs: 40 + (sequence % 13),
      uploadMs: 25 + (sequence % 11),
      sourceBytes: 90_000 + sequence * 250,
      transformedBytes: 60_000 + sequence * 180,
    };
  });
}

function parseSeededMetricRowFromPayload(input: {
  jobId: string;
  finishedAtMs: number;
  payloadRaw: string;
}): SeededMetricRow | null {
  try {
    const payload = JSON.parse(input.payloadRaw) as {
      processed_count?: unknown;
      failed_count?: unknown;
      elapsed_ms?: unknown;
      items?: unknown;
    };
    const items = Array.isArray(payload.items)
      ? (payload.items as Array<{
          fetch_elapsed_ms?: unknown;
          transform_elapsed_ms?: unknown;
          upload_elapsed_ms?: unknown;
          source_bytes?: unknown;
          transformed_bytes?: unknown;
        }>)
      : [];

    const toNonNegative = (value: unknown): number => {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0) {
        return 0;
      }
      return parsed;
    };

    const mean = (values: number[]): number => {
      if (values.length === 0) {
        return 0;
      }
      const sum = values.reduce((acc, value) => acc + value, 0);
      return sum / values.length;
    };

    const fetchMs = mean(
      items.map((item) => toNonNegative(item.fetch_elapsed_ms)),
    );
    const transformMs = mean(
      items.map((item) => toNonNegative(item.transform_elapsed_ms)),
    );
    const uploadMs = mean(
      items.map((item) => toNonNegative(item.upload_elapsed_ms)),
    );
    const sourceBytes = mean(
      items.map((item) => toNonNegative(item.source_bytes)),
    );
    const transformedBytes = mean(
      items.map((item) => toNonNegative(item.transformed_bytes)),
    );

    const processedCountRaw = Math.floor(
      toNonNegative(payload.processed_count),
    );
    const failedCountRaw = Math.floor(toNonNegative(payload.failed_count));
    const itemsCount = Math.max(0, items.length);
    const processedCount =
      itemsCount > 0
        ? itemsCount
        : processedCountRaw > 0
          ? processedCountRaw
          : 0;

    return {
      id: input.jobId,
      finishedAtMs: input.finishedAtMs,
      itemsCount,
      elapsedMs: toNonNegative(payload.elapsed_ms),
      processedCount,
      failedCount: failedCountRaw,
      fetchMs,
      transformMs,
      uploadMs,
      sourceBytes,
      transformedBytes,
    };
  } catch {
    return null;
  }
}

async function readExistingBullmqRows(input: {
  redis: IORedis;
  queue: Queue;
  limit: number;
}): Promise<SeededMetricRow[]> {
  const completedKey = input.queue.toKey("completed");
  const raw = await input.redis.zrevrangebyscore(
    completedKey,
    "+inf",
    "-inf",
    "WITHSCORES",
    "LIMIT",
    "0",
    String(Math.max(1, input.limit)),
  );

  const pairs: Array<{ jobId: string; finishedAtMs: number }> = [];
  for (let index = 0; index + 1 < raw.length; index += 2) {
    const jobId = String(raw[index] || "");
    const finishedAtMs = Number(raw[index + 1]);
    if (!jobId || !Number.isFinite(finishedAtMs)) {
      continue;
    }
    pairs.push({ jobId, finishedAtMs });
  }
  pairs.reverse();

  const pipe = input.redis.pipeline();
  for (const pair of pairs) {
    pipe.hget(input.queue.toKey(pair.jobId), "returnvalue");
  }
  const payloads = await pipe.exec();

  const rows: SeededMetricRow[] = [];
  for (let index = 0; index < pairs.length; index += 1) {
    const payloadResult = payloads?.[index];
    const payloadRaw =
      payloadResult && payloadResult[0] === null
        ? (payloadResult[1] as string | null)
        : null;
    if (!payloadRaw || !payloadRaw.trim()) {
      continue;
    }
    const row = parseSeededMetricRowFromPayload({
      jobId: pairs[index].jobId,
      finishedAtMs: pairs[index].finishedAtMs,
      payloadRaw,
    });
    if (!row) {
      continue;
    }
    rows.push(row);
  }

  return rows;
}

async function readBullmqFixtureFileRows(input: {
  filePath: string;
  limit: number;
}): Promise<BullmqFixtureFileEntry[]> {
  const raw = await readFile(input.filePath, "utf8");
  let parsed: BullmqFixtureFile;
  try {
    parsed = JSON.parse(raw) as BullmqFixtureFile;
  } catch (error) {
    throw new Error(
      `Failed parsing IMAGE_OPS_BULLMQ_FIXTURE_FILE JSON at ${input.filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const sourceEntries = Array.isArray(parsed.entries) ? parsed.entries : [];
  const entries: BullmqFixtureFileEntry[] = [];
  for (const entryRaw of sourceEntries) {
    const entry = entryRaw as Partial<BullmqFixtureFileEntry>;
    const jobId = String(entry.jobId || "").trim();
    const finishedAtMs = Number(entry.finishedAtMs);
    const returnvalue = String(entry.returnvalue || "");
    if (!jobId || !Number.isFinite(finishedAtMs) || !returnvalue.trim()) {
      continue;
    }
    entries.push({
      jobId,
      finishedAtMs,
      returnvalue,
    });
    if (entries.length >= Math.max(1, input.limit)) {
      break;
    }
  }

  if (entries.length === 0) {
    throw new Error(
      `IMAGE_OPS_BULLMQ_FIXTURE_FILE contained no usable entries: ${input.filePath}`,
    );
  }

  entries.sort((left, right) => left.finishedAtMs - right.finishedAtMs);
  return entries;
}

async function seedCompletedJobsFromFixture(input: {
  redis: IORedis;
  queue: Queue;
  entries: BullmqFixtureFileEntry[];
}): Promise<void> {
  const completedKey = input.queue.toKey("completed");
  const pipeline = input.redis.pipeline();

  for (const entry of input.entries) {
    pipeline.zadd(completedKey, entry.finishedAtMs, entry.jobId);
    pipeline.hset(
      input.queue.toKey(entry.jobId),
      "returnvalue",
      entry.returnvalue,
    );
  }

  await pipeline.exec();
}

function expectedAnalyticsKeys(meta: RawFixtureMeta): string[] {
  const keys = new Set<string>();

  keys.add(IMAGE_RUNNER_SETTINGS_KEY);
  keys.add(IMAGE_RUNNER_STATUS_KEY);
  keys.add(IMAGE_RUNNER_INFRA_KEY);
  keys.add(PERF_ROLLUP_HASH_KEY);

  for (const entry of imageJobMetricTrendKeys()) {
    keys.add(entry.trendKey);
  }
  keys.add(IMAGE_RAW_JOB_TREND_CURSOR_KEY);

  for (const metric of OPS_TREND_METRIC_REGISTRY) {
    keys.add(metric.key);
  }

  for (const metric of OPS_SNAPSHOT_TREND_METRIC_REGISTRY) {
    keys.add(metric.key);
  }

  for (const metricSlug of IMAGE_PERFORMANCE_SLICE_METRIC_SLUGS) {
    keys.add(imageMetricSliceHashKey(metricSlug));
  }
  for (const metricSlug of IMAGE_JOB_SLICE_METRIC_SLUGS) {
    keys.add(imageMetricSliceHashKey(metricSlug, IMAGE_GROUP_JOBS));
  }

  keys.add(meta.queueCompletedKey);
  keys.add(meta.queueFailedKey);
  if (meta.queueCompletedKey.endsWith(":completed")) {
    keys.add(meta.queueCompletedKey.replace(/:completed$/, ":meta"));
  }
  for (const rowId of meta.rowIds) {
    keys.add(`bull:image-processing:${rowId}`);
  }

  return [...keys].sort();
}

async function buildRunnerUiMetricFixture(
  redis: IORedis,
): Promise<RunnerUiMetricFixture> {
  await writeOpsControlSettings(
    {
      desiredMode: "run",
      enqueueEnabled: true,
      requireWorkersForEnqueue: true,
      minWorkersToEnqueue: 1,
      maxQueueBacklog: 240,
      refillLowWatermark: 120,
      refillTargetBacklog: 180,
      maxClaimPerCycle: 40,
      flushIntervalMs: 15000,
      harvestEnabled: true,
    },
    redis,
  );

  await writeOpsInfraSnapshot(
    {
      workersRunning: 3,
      source: "metrics-contract-test",
      updatedAt: new Date().toISOString(),
    },
    redis,
  );

  const status = makeStatus();
  await writeOpsRunnerStatus(status, redis);

  const oneShot = await runOpsOneShotPipeline({
    appName: "metrics-contract-test",
    timeoutMs: 1200,
    includeFly: false,
    includeTrendProjection: true,
    includeRecentJobs15m: true,
    includeRecentJobs24h: true,
    includePerformanceRollups: true,
    reconcileBullmqStatus: false,
  });
  const snapshot = oneShot.snapshot;

  const [runnerLatest, uiLatest] = await Promise.all([
    readOpsRunnerTrendLatest(undefined),
    readOpsSnapshotTrendLatest(undefined),
  ]);

  const runner: RunnerUiMetricFixture["runner"] = {};
  for (const metric of OPS_TREND_METRIC_REGISTRY) {
    const [keyType, depth] = await Promise.all([
      redis.type(metric.key),
      redis.zcard(metric.key),
    ]);
    runner[metric.name] = {
      expectedValue: metric.getValue(status),
      actualValue: runnerLatest[metric.name]?.value ?? null,
      keyType,
      depth,
    };
  }

  const ui: RunnerUiMetricFixture["ui"] = {};
  for (const metric of OPS_SNAPSHOT_TREND_METRIC_REGISTRY) {
    const [keyType, depth] = await Promise.all([
      redis.type(metric.key),
      redis.zcard(metric.key),
    ]);
    ui[metric.name] = {
      expectedValue: metric.getValue(snapshot),
      actualValue: uiLatest[metric.name]?.value ?? null,
      keyType,
      depth,
    };
  }

  return { runner, ui };
}

async function buildRawMetricFixture(
  redis: IORedis,
): Promise<RawFixtureBundle> {
  const queue = createImageQueue(redis);
  try {
    await writeOpsControlSettings(
      {
        desiredMode: "run",
        enqueueEnabled: true,
        requireWorkersForEnqueue: true,
        minWorkersToEnqueue: 1,
        maxQueueBacklog: 240,
        refillLowWatermark: 120,
        refillTargetBacklog: 180,
        maxClaimPerCycle: 40,
        flushIntervalMs: 15000,
        harvestEnabled: true,
      },
      redis,
    );

    await writeOpsInfraSnapshot(
      {
        workersRunning: 3,
        source: "metrics-contract-test",
        updatedAt: new Date().toISOString(),
      },
      redis,
    );

    await writeOpsRunnerStatus(makeStatus(), redis);

    const pointsForRow = (row: SeededMetricRow): number => {
      const itemCount =
        row.itemsCount ?? Math.max(0, Math.floor(row.processedCount));
      return itemCount > 0 ? itemCount : 1;
    };

    let rows: SeededMetricRow[];
    if (BULLMQ_FIXTURE_FILE_PATH) {
      const entries = await readBullmqFixtureFileRows({
        filePath: BULLMQ_FIXTURE_FILE_PATH,
        limit: Math.max(1, BULLMQ_FIXTURE_LIMIT),
      });

      await seedCompletedJobsFromFixture({
        redis,
        queue,
        entries,
      });

      rows = entries
        .map((entry) =>
          parseSeededMetricRowFromPayload({
            jobId: entry.jobId,
            finishedAtMs: entry.finishedAtMs,
            payloadRaw: entry.returnvalue,
          }),
        )
        .filter((row): row is SeededMetricRow => row !== null);
      expect(rows.length).toBeGreaterThan(0);
    } else if (USE_EXISTING_BULLMQ_FIXTURE) {
      const existingRows = await readExistingBullmqRows({
        redis,
        queue,
        limit: Math.max(
          1,
          EXISTING_BULLMQ_FIXTURE_LIMIT *
            Math.max(1, EXISTING_BULLMQ_FIXTURE_MIN_MULTI_ITEM),
        ),
      });
      const multiItemRows = existingRows.filter((row) => pointsForRow(row) > 1);
      expect(multiItemRows.length).toBeGreaterThanOrEqual(
        Math.max(0, EXISTING_BULLMQ_FIXTURE_MIN_MULTI_ITEM),
      );
      rows = [
        ...multiItemRows,
        ...existingRows.filter((row) => pointsForRow(row) <= 1),
      ].slice(0, Math.max(1, EXISTING_BULLMQ_FIXTURE_LIMIT));
      expect(rows.length).toBeGreaterThanOrEqual(
        Math.max(1, EXISTING_BULLMQ_FIXTURE_MIN),
      );
    } else {
      const nowMs = Date.now();
      rows = buildTimedRawRows(nowMs);
      expect(rows.length).toBe(RAW_FIXTURE_ROW_COUNT);
      await seedCompletedJobMetrics({ redis, queue, rows, failedAtMs: [] });
    }

    await syncImageJobMetricTrends({
      sampleLimit: 1000,
      depthLimit: 1000,
    });

    await runOpsOneShotPerformanceRefresh();
    const oneShot = await runOpsOneShotPipeline({
      appName: "metrics-contract-test",
      timeoutMs: 1200,
      includeFly: false,
      includeTrendProjection: false,
      includeRecentJobs15m: true,
      includeRecentJobs24h: true,
      includePerformanceRollups: true,
      reconcileBullmqStatus: true,
    });
    const deepRollup = oneShot.snapshot.performanceRollups?.rollupDeep;

    const deepExpected = buildExpectedWindow(rows, [], -1);

    const latest = [...rows].sort((a, b) => b.finishedAtMs - a.finishedAtMs)[0];
    const itemPointDepth = rows.reduce(
      (acc, row) => acc + pointsForRow(row),
      0,
    );

    const weightedMeanRounded = (
      values: Array<{ value: number; weight: number }>,
    ): number => {
      const totalWeight = values.reduce((acc, entry) => acc + entry.weight, 0);
      if (totalWeight <= 0) {
        return 0;
      }
      const weightedSum = values.reduce(
        (acc, entry) => acc + entry.value * entry.weight,
        0,
      );
      return Math.round(weightedSum / totalWeight);
    };

    const expectedLatestValues: Record<string, number> = {
      completed_jobs: 1,
      fetch_ms: latest.fetchMs,
      transform_ms: latest.transformMs,
      upload_ms: latest.uploadMs,
      end_to_end_ms: latest.fetchMs + latest.transformMs + latest.uploadMs,
      elapsed_ms:
        latest.elapsedMs ??
        latest.fetchMs + latest.transformMs + latest.uploadMs,
      source_bytes: latest.sourceBytes,
      transformed_bytes: latest.transformedBytes,
      processed_items: pointsForRow(latest) > 1 ? 1 : latest.processedCount,
      failed_items: latest.failedCount,
    };

    const weightedElapsedMs = weightedMeanRounded(
      rows.map((row) => ({
        value: row.elapsedMs ?? row.fetchMs + row.transformMs + row.uploadMs,
        weight: pointsForRow(row),
      })),
    );

    const expectedStateValues: Record<string, number> = {
      completed_jobs: deepExpected.completedJobs,
      fetch_ms: deepExpected.avgFetchMs,
      transform_ms: deepExpected.avgTransformMs,
      upload_ms: deepExpected.avgUploadMs,
      end_to_end_ms: deepExpected.avgEndToEndMs,
      elapsed_ms: weightedElapsedMs,
      source_bytes: weightedMeanRounded(
        rows.map((row) => ({
          value: row.sourceBytes,
          weight: pointsForRow(row),
        })),
      ),
      transformed_bytes: weightedMeanRounded(
        rows.map((row) => ({
          value: row.transformedBytes,
          weight: pointsForRow(row),
        })),
      ),
      processed_items: deepExpected.processedItems,
      failed_items: deepExpected.failedItems,
    };

    const expectedMetricDepths: Record<string, number> = {
      completed_jobs: itemPointDepth,
      fetch_ms: itemPointDepth,
      transform_ms: itemPointDepth,
      upload_ms: itemPointDepth,
      end_to_end_ms: itemPointDepth,
      elapsed_ms: itemPointDepth,
      source_bytes: itemPointDepth,
      transformed_bytes: itemPointDepth,
      processed_items: itemPointDepth,
      failed_items: rows.length,
    };

    const stateValues: Record<string, number | null> = {
      completed_jobs: deepRollup?.completedJobs ?? null,
      fetch_ms: deepRollup?.avgFetchMs ?? null,
      transform_ms: deepRollup?.avgTransformMs ?? null,
      upload_ms: deepRollup?.avgUploadMs ?? null,
      end_to_end_ms: deepRollup?.avgEndToEndMs ?? null,
      elapsed_ms: deepRollup?.metricJobElapsedMsAvg ?? null,
      source_bytes: deepRollup?.metricSourceBytesAvg ?? null,
      transformed_bytes: deepRollup?.metricTransformedBytesAvg ?? null,
      processed_items: deepRollup?.processedItems ?? null,
      failed_items: deepRollup?.failedItems ?? null,
    };

    const fixture: RawMetricFixture = {};
    for (const metric of imageJobMetricTrendKeys()) {
      const [trendType, trendDepth, latestRows] = await Promise.all([
        redis.type(metric.trendKey),
        redis.zcard(metric.trendKey),
        redis.zrevrange(metric.trendKey, 0, 0, "WITHSCORES"),
      ]);

      let latestValue: number | null = null;
      if (latestRows.length >= 2) {
        try {
          const parsedLatest = JSON.parse(String(latestRows[0])) as {
            atMs?: unknown;
            value?: unknown;
          };
          expect(Number.isFinite(Number(parsedLatest.atMs))).toBe(true);
          const parsedValue = Number(parsedLatest.value);
          latestValue = Number.isFinite(parsedValue) ? parsedValue : null;
        } catch {
          latestValue = null;
        }
      }

      fixture[metric.metric] = {
        expectedTrendDepth: expectedMetricDepths[metric.metric],
        trendLatestValue: latestValue,
        expectedStateValue: expectedStateValues[metric.metric],
        stateValue: stateValues[metric.metric],
        trendType,
        trendDepth,
      };

      expect(fixture[metric.metric].trendLatestValue).toBe(
        expectedLatestValues[metric.metric],
      );
    }

    return {
      metrics: fixture,
      meta: {
        rowIds: rows.map((row) => row.id),
        queueCompletedKey: queue.toKey("completed"),
        queueFailedKey: queue.toKey("failed"),
      },
    };
  } finally {
    await queue.close().catch(() => undefined);
  }
}

describeRedis("image ops metrics seeded contract", () => {
  let redis: IORedis;
  let previousRedisUrl: string | undefined;
  let skipAutoReset = false;

  beforeAll(async () => {
    assertLoopbackRedisUrl(redisUrl);
    previousRedisUrl = process.env.REDIS_URL;
    process.env.REDIS_URL = redisUrl;

    redis = new IORedis(redisUrl, {
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
    });
    await redis.ping();
  });

  afterAll(async () => {
    await redis.quit();
    if (previousRedisUrl === undefined) {
      delete process.env.REDIS_URL;
    } else {
      process.env.REDIS_URL = previousRedisUrl;
    }
  });

  beforeEach(async () => {
    if (skipAutoReset) {
      return;
    }
    await resetState(redis);
  });

  it("enforces analytics registry metric coverage contracts", async () => {
    const rawMetricNames = imageJobMetricTrendKeys()
      .map((entry) => entry.metric)
      .sort();
    expect(rawMetricNames).toEqual([...EXPECTED_RAW_METRIC_NAMES].sort());

    const runnerMetricNames = OPS_TREND_METRIC_REGISTRY.map(
      (metric) => metric.name,
    ).sort();
    expect(runnerMetricNames).toEqual([...EXPECTED_RUNNER_METRIC_NAMES].sort());

    const uiMetricNames = OPS_SNAPSHOT_TREND_METRIC_REGISTRY.map(
      (metric) => metric.name,
    ).sort();
    expect(uiMetricNames).toEqual([...EXPECTED_UI_METRIC_NAMES].sort());

    const keyRegex = new RegExp(
      `^${IMAGE_TREND_PREFIX}:(queue|infra|db|jobs|images):[a-z0-9]+(?:_[a-z0-9]+)*:trend$`,
    );
    for (const metric of OPS_TREND_METRIC_REGISTRY) {
      expect(keyRegex.test(metric.key)).toBe(true);
      expect(metric.key.includes(":ui:")).toBe(false);
      expect(metric.key.includes(":runner:")).toBe(false);
    }
    for (const metric of OPS_SNAPSHOT_TREND_METRIC_REGISTRY) {
      expect(keyRegex.test(metric.key)).toBe(true);
      expect(metric.key.includes(":ui:")).toBe(false);
      expect(metric.key.includes(":runner:")).toBe(false);
    }

    const rawTrendRegex = new RegExp(
      `^${IMAGE_RAW_JOB_TREND_PREFIX}:[a-z0-9]+(?:_[a-z0-9]+)*:trend$`,
    );
    for (const entry of imageJobMetricTrendKeys()) {
      expect(rawTrendRegex.test(entry.trendKey)).toBe(true);
    }
  });

  it("supports mixed one-item and multi-item job payloads with item-level trend depth", async () => {
    const queue = createImageQueue(redis);
    try {
      const nowMs = Date.now();
      const rows: SeededMetricRow[] = [
        {
          id: "mixed-single-item-job",
          finishedAtMs: nowMs - 5_000,
          processedCount: 1,
          failedCount: 0,
          fetchMs: 88,
          transformMs: 42,
          uploadMs: 24,
          sourceBytes: 95_000,
          transformedBytes: 70_000,
        },
        {
          id: "mixed-multi-item-job",
          finishedAtMs: nowMs - 3_000,
          processedCount: 4,
          failedCount: 0,
          fetchMs: 101,
          transformMs: 55,
          uploadMs: 31,
          sourceBytes: 110_000,
          transformedBytes: 76_000,
        },
      ];

      await seedCompletedJobMetrics({ redis, queue, rows, failedAtMs: [] });
      const sync = await syncImageJobMetricTrends({
        sampleLimit: 100,
        depthLimit: 100,
      });

      expect(sync.parsedCompletedJobs).toBe(rows.length);

      const completedJobsDepth = await redis.zcard(
        imageRawJobTrendMetricKey("completed_jobs"),
      );
      const processedItemsDepth = await redis.zcard(
        imageRawJobTrendMetricKey("processed_items"),
      );

      // One single-item row + one multi-item row with 4 items => 5 item-level points.
      expect(completedJobsDepth).toBe(5);
      expect(processedItemsDepth).toBe(5);
    } finally {
      await queue.close().catch(() => undefined);
    }
  });

  it("interpolates distinct item timestamp scores from job completed_at when item timestamps are missing", async () => {
    const queue = createImageQueue(redis);
    try {
      const nowMs = Date.now();
      const row: SeededMetricRow = {
        id: "legacy-no-item-ts-job",
        finishedAtMs: nowMs - 4_000,
        processedCount: 3,
        failedCount: 0,
        includeItemTimestamps: false,
        fetchMs: 90,
        transformMs: 45,
        uploadMs: 30,
        sourceBytes: 100_000,
        transformedBytes: 72_000,
      };

      await seedCompletedJobMetrics({
        redis,
        queue,
        rows: [row],
        failedAtMs: [],
      });
      const sync = await syncImageJobMetricTrends({
        sampleLimit: 100,
        depthLimit: 100,
      });

      expect(sync.parsedCompletedJobs).toBe(1);

      const idsWithScores = await redis.zrange(
        imageRawJobTrendMetricKey("completed_jobs"),
        0,
        -1,
        "WITHSCORES",
      );

      const legacyRows: Array<{ memberId: string; atMs: number }> = [];
      for (let index = 0; index + 1 < idsWithScores.length; index += 2) {
        const rawMember = String(idsWithScores[index]);
        const atMs = Number(idsWithScores[index + 1]);
        let memberId = "";
        try {
          const parsed = JSON.parse(rawMember) as { id?: unknown };
          memberId = String(parsed.id || "");
        } catch {
          memberId = rawMember;
        }
        if (!memberId.startsWith(`${row.id}:item:`)) {
          continue;
        }
        legacyRows.push({ memberId, atMs });
      }

      expect(legacyRows).toHaveLength(3);
      const sorted = [...legacyRows].sort((a, b) => a.atMs - b.atMs);
      expect(sorted[0]?.atMs).toBeLessThan(sorted[1]?.atMs ?? 0);
      expect(sorted[1]?.atMs).toBeLessThan(sorted[2]?.atMs ?? 0);
      expect(sorted[sorted.length - 1]?.atMs).toBe(row.finishedAtMs);
    } finally {
      await queue.close().catch(() => undefined);
    }
  });

  it("seeds fixture bull payloads and writes expected per-item timestamped raw metrics", async () => {
    const queue = createImageQueue(redis);
    try {
      const fixturePath =
        BULLMQ_FIXTURE_FILE_PATH || DEFAULT_BULLMQ_FIXTURE_FILE_PATH;
      const entries = await readBullmqFixtureFileRows({
        filePath: fixturePath,
        limit: Math.max(1, BULLMQ_FIXTURE_LIMIT),
      });

      await seedCompletedJobsFromFixture({
        redis,
        queue,
        entries,
      });

      const sync = await syncImageJobMetricTrends({
        sampleLimit: 1000,
        depthLimit: 1000,
      });
      expect(sync.parsedCompletedJobs).toBe(entries.length);

      const metricNames = imageJobMetricTrendKeys().map(
        (entry) => entry.metric,
      );
      const expectedByMetric = Object.fromEntries(
        metricNames.map((metric) => [
          metric,
          new Map<string, { atMs: number; value: number }>(),
        ]),
      ) as Record<
        ImageJobMetricName,
        Map<string, { atMs: number; value: number }>
      >;

      const toNonNegative = (value: unknown): number => {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed < 0) {
          return 0;
        }
        return parsed;
      };

      const toTimestampMs = (value: unknown): number | null => {
        if (typeof value !== "string" || value.trim().length === 0) {
          return null;
        }
        const parsed = Date.parse(value);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          return null;
        }
        return parsed;
      };

      const parseItemTimestampMs = (item: {
        processed_at?: unknown;
        item_completed_at?: unknown;
        completed_at?: unknown;
        s3_verified_at?: unknown;
      }): number | null => {
        return (
          toTimestampMs(item.processed_at) ??
          toTimestampMs(item.item_completed_at) ??
          toTimestampMs(item.completed_at) ??
          toTimestampMs(item.s3_verified_at)
        );
      };

      for (const entry of entries) {
        const payload = JSON.parse(entry.returnvalue) as {
          processed_count?: unknown;
          failed_count?: unknown;
          elapsed_ms?: unknown;
          completed_at?: unknown;
          items?: unknown;
        };
        const items = Array.isArray(payload.items)
          ? (payload.items as Array<{
              fetch_elapsed_ms?: unknown;
              transform_elapsed_ms?: unknown;
              upload_elapsed_ms?: unknown;
              source_bytes?: unknown;
              transformed_bytes?: unknown;
              processed_at?: unknown;
              item_completed_at?: unknown;
              completed_at?: unknown;
              s3_verified_at?: unknown;
            }>)
          : [];

        const failedCount = Math.max(
          0,
          Math.floor(toNonNegative(payload.failed_count)),
        );
        const jobElapsedMs = toNonNegative(payload.elapsed_ms);
        const jobCompletedAtMs =
          toTimestampMs(payload.completed_at) ?? entry.finishedAtMs;

        if (items.length > 0) {
          const durations = items.map((item) => {
            const fetchMs = Math.max(0, toNonNegative(item.fetch_elapsed_ms));
            const transformMs = Math.max(
              0,
              toNonNegative(item.transform_elapsed_ms),
            );
            const uploadMs = Math.max(0, toNonNegative(item.upload_elapsed_ms));
            const duration = fetchMs + transformMs + uploadMs;
            return duration > 0 ? duration : 1;
          });
          const totalDurationMs = durations.reduce(
            (sum, value) => sum + value,
            0,
          );
          const startedAtMs = jobCompletedAtMs - Math.max(1, totalDurationMs);
          const inferredItemAtMs: number[] = [];
          let cursorMs = startedAtMs;
          for (const durationMs of durations) {
            cursorMs += durationMs;
            inferredItemAtMs.push(cursorMs);
          }

          for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
            const item = items[itemIndex];
            const fetchMs = Math.max(0, toNonNegative(item.fetch_elapsed_ms));
            const transformMs = Math.max(
              0,
              toNonNegative(item.transform_elapsed_ms),
            );
            const uploadMs = Math.max(0, toNonNegative(item.upload_elapsed_ms));
            const endToEndMs = fetchMs + transformMs + uploadMs;
            const elapsedMs = jobElapsedMs > 0 ? jobElapsedMs : endToEndMs;
            const atMs =
              parseItemTimestampMs(item) ??
              inferredItemAtMs[itemIndex] ??
              jobCompletedAtMs;
            const memberId = `${entry.jobId}:item:${itemIndex}`;

            expectedByMetric.completed_jobs.set(memberId, { atMs, value: 1 });
            expectedByMetric.processed_items.set(memberId, { atMs, value: 1 });
            expectedByMetric.fetch_ms.set(memberId, { atMs, value: fetchMs });
            expectedByMetric.transform_ms.set(memberId, {
              atMs,
              value: transformMs,
            });
            expectedByMetric.upload_ms.set(memberId, { atMs, value: uploadMs });
            expectedByMetric.end_to_end_ms.set(memberId, {
              atMs,
              value: endToEndMs,
            });
            expectedByMetric.elapsed_ms.set(memberId, {
              atMs,
              value: elapsedMs,
            });
            expectedByMetric.source_bytes.set(memberId, {
              atMs,
              value: Math.max(0, toNonNegative(item.source_bytes)),
            });
            expectedByMetric.transformed_bytes.set(memberId, {
              atMs,
              value: Math.max(0, toNonNegative(item.transformed_bytes)),
            });
          }

          expectedByMetric.failed_items.set(`${entry.jobId}:failed`, {
            atMs: entry.finishedAtMs,
            value: failedCount,
          });
          continue;
        }

        const processedCount = Math.max(
          0,
          Math.floor(toNonNegative(payload.processed_count)),
        );
        const fallbackValues: Record<ImageJobMetricName, number> = {
          completed_jobs: 1,
          fetch_ms: 0,
          transform_ms: 0,
          upload_ms: 0,
          end_to_end_ms: 0,
          elapsed_ms: jobElapsedMs,
          source_bytes: 0,
          transformed_bytes: 0,
          processed_items: processedCount,
          failed_items: failedCount,
        };
        for (const metricName of metricNames) {
          expectedByMetric[metricName].set(entry.jobId, {
            atMs: entry.finishedAtMs,
            value: fallbackValues[metricName],
          });
        }
      }

      for (const metricName of metricNames) {
        const rowsWithScores = await redis.zrange(
          imageRawJobTrendMetricKey(metricName),
          0,
          -1,
          "WITHSCORES",
        );
        const actualByMember = new Map<
          string,
          { atMs: number; value: number }
        >();
        for (let index = 0; index + 1 < rowsWithScores.length; index += 2) {
          const rawMember = String(rowsWithScores[index] || "");
          const atMs = Number(rowsWithScores[index + 1]);
          if (!rawMember || !Number.isFinite(atMs)) {
            continue;
          }

          try {
            const parsed = JSON.parse(rawMember) as {
              id?: unknown;
              value?: unknown;
            };
            const memberId = String(parsed.id || "");
            const value = Number(parsed.value);
            if (!memberId || !Number.isFinite(value)) {
              continue;
            }
            actualByMember.set(memberId, { atMs: Number(atMs), value });
          } catch {
            continue;
          }
        }

        const expected = expectedByMetric[metricName];
        expect(actualByMember.size).toBe(expected.size);

        for (const [memberId, expectedPoint] of expected.entries()) {
          const actualPoint = actualByMember.get(memberId);
          expect(actualPoint).toBeTruthy();
          expect(actualPoint?.atMs).toBe(expectedPoint.atMs);
          expect(actualPoint?.value).toBe(expectedPoint.value);
        }
      }
    } finally {
      await queue.close().catch(() => undefined);
    }
  });

  it("forces rollup slice generation without timer loop and persists rollup keys", async () => {
    const queue = createImageQueue(redis);
    try {
      const fixturePath =
        BULLMQ_FIXTURE_FILE_PATH || DEFAULT_BULLMQ_FIXTURE_FILE_PATH;
      const entries = await readBullmqFixtureFileRows({
        filePath: fixturePath,
        limit: Math.max(1, BULLMQ_FIXTURE_LIMIT),
      });

      await seedCompletedJobsFromFixture({
        redis,
        queue,
        entries,
      });

      await syncImageJobMetricTrends({
        sampleLimit: 1000,
        depthLimit: 1000,
      });

      const forced = await runOpsOneShotPerformanceRefresh();
      expect(forced.rollups).toBeTruthy();

      const [hashType, rollupHash] = await Promise.all([
        redis.type(PERF_ROLLUP_HASH_KEY),
        redis.hgetall(PERF_ROLLUP_HASH_KEY),
      ]);

      expect(hashType).toBe("hash");
      expect(Object.keys(rollupHash).sort()).toEqual(
        [
          "rollup_15m",
          "rollup_15s",
          "rollup_1m",
          "rollup_24h",
          "rollup_60m",
          "rollup_deep",
          "updated_at",
        ].sort(),
      );

      for (const field of [
        "rollup_15s",
        "rollup_1m",
        "rollup_15m",
        "rollup_24h",
        "rollup_60m",
        "rollup_deep",
      ]) {
        const parsed = JSON.parse(String(rollupHash[field])) as {
          completedJobs?: unknown;
          processedItems?: unknown;
          avgFetchMs?: unknown;
          avgEndToEndMs?: unknown;
        };
        expect(Number.isFinite(Number(parsed.completedJobs))).toBe(true);
        expect(Number.isFinite(Number(parsed.processedItems))).toBe(true);
        expect(Number.isFinite(Number(parsed.avgFetchMs))).toBe(true);
        expect(Number.isFinite(Number(parsed.avgEndToEndMs))).toBe(true);
      }

      for (const metricSlug of IMAGE_PERFORMANCE_SLICE_METRIC_SLUGS) {
        const key = imageMetricSliceHashKey(metricSlug);
        const [type, hash] = await Promise.all([
          redis.type(key),
          redis.hgetall(key),
        ]);
        expect(type).toBe("hash");
        const expectedSliceFields = [
          "updated_at",
          ...IMAGE_SLICE_WINDOWS.map((window) => `w_${window.id}`),
        ].sort();
        expect(Object.keys(hash).sort()).toEqual(expectedSliceFields);

        for (const field of IMAGE_SLICE_WINDOWS.map(
          (window) => `w_${window.id}`,
        )) {
          const parsed = JSON.parse(String(hash[field])) as {
            low?: unknown;
            high?: unknown;
            average?: unknown;
            latest?: unknown;
            timestamp?: unknown;
          };
          expect(Number.isFinite(Number(parsed.low))).toBe(true);
          expect(Number.isFinite(Number(parsed.high))).toBe(true);
          expect(Number.isFinite(Number(parsed.average))).toBe(true);
          expect(Number.isFinite(Number(parsed.latest))).toBe(true);
          expect(typeof parsed.timestamp).toBe("string");
        }
      }

      for (const metricSlug of IMAGE_JOB_SLICE_METRIC_SLUGS) {
        const key = imageMetricSliceHashKey(metricSlug, IMAGE_GROUP_JOBS);
        const [type, hash] = await Promise.all([
          redis.type(key),
          redis.hgetall(key),
        ]);
        expect(type).toBe("hash");
        const expectedSliceFields = [
          "updated_at",
          ...IMAGE_SLICE_WINDOWS.map((window) => `w_${window.id}`),
        ].sort();
        expect(Object.keys(hash).sort()).toEqual(expectedSliceFields);

        for (const field of IMAGE_SLICE_WINDOWS.map(
          (window) => `w_${window.id}`,
        )) {
          const parsed = JSON.parse(String(hash[field])) as {
            low?: unknown;
            high?: unknown;
            average?: unknown;
            latest?: unknown;
            timestamp?: unknown;
          };
          expect(Number.isFinite(Number(parsed.low))).toBe(true);
          expect(Number.isFinite(Number(parsed.high))).toBe(true);
          expect(Number.isFinite(Number(parsed.average))).toBe(true);
          expect(Number.isFinite(Number(parsed.latest))).toBe(true);
          expect(typeof parsed.timestamp).toBe("string");
        }
      }
    } finally {
      await queue.close().catch(() => undefined);
    }
  });

  it("seeds deterministic jobs and verifies rollups across redis and state", async () => {
    const queue = createImageQueue(redis);
    try {
      const nowMs = Date.now();
      const rows: SeededMetricRow[] = [
        {
          id: "contract-job-15s",
          finishedAtMs: nowMs - 3_000,
          processedCount: 2,
          failedCount: 0,
          fetchMs: 80,
          transformMs: 40,
          uploadMs: 30,
          sourceBytes: 150_000,
          transformedBytes: 80_000,
        },
        {
          id: "contract-job-1m",
          finishedAtMs: nowMs - 25_000,
          processedCount: 3,
          failedCount: 1,
          fetchMs: 120,
          transformMs: 55,
          uploadMs: 35,
          sourceBytes: 165_000,
          transformedBytes: 82_000,
        },
        {
          id: "contract-job-15m",
          finishedAtMs: nowMs - 5 * 60_000,
          processedCount: 4,
          failedCount: 0,
          fetchMs: 140,
          transformMs: 70,
          uploadMs: 45,
          sourceBytes: 175_000,
          transformedBytes: 90_000,
        },
        {
          id: "contract-job-24h",
          finishedAtMs: nowMs - 2 * 60 * 60_000,
          processedCount: 1,
          failedCount: 0,
          fetchMs: 110,
          transformMs: 65,
          uploadMs: 40,
          sourceBytes: 140_000,
          transformedBytes: 78_000,
        },
        {
          id: "contract-job-deep-only",
          finishedAtMs: nowMs - 30 * 60 * 60_000,
          processedCount: 5,
          failedCount: 2,
          fetchMs: 160,
          transformMs: 90,
          uploadMs: 50,
          sourceBytes: 190_000,
          transformedBytes: 100_000,
        },
      ];

      const failedAtMs = [nowMs - 20_000, nowMs - 3 * 60 * 60_000];
      await seedCompletedJobMetrics({ redis, queue, rows, failedAtMs });

      const sync = await syncImageJobMetricTrends({
        sampleLimit: 1000,
        depthLimit: 1000,
      });
      expect(sync.parsedCompletedJobs).toBe(rows.length);

      const windows = await readImageJobMetricRollupWindows({
        windowsMs: [15_000, 60_000, 15 * 60_000, 24 * 60 * 60_000],
        deepSampleLimit: 1000,
        syncBeforeRead: false,
      });

      const expected15s = buildExpectedWindow(rows, failedAtMs, nowMs - 15_000);
      const expected1m = buildExpectedWindow(rows, failedAtMs, nowMs - 60_000);
      const expected15m = buildExpectedWindow(
        rows,
        failedAtMs,
        nowMs - 15 * 60_000,
      );
      const expected24h = buildExpectedWindow(
        rows,
        failedAtMs,
        nowMs - 24 * 60 * 60_000,
      );
      const expectedDeep = buildExpectedWindow(rows, failedAtMs, -1);

      const window15s = windows.windows[String(15_000)];
      const window1m = windows.windows[String(60_000)];
      const window15m = windows.windows[String(15 * 60_000)];
      const window24h = windows.windows[String(24 * 60 * 60_000)];
      const deep = windows.deepWindow;

      expect(window15s).toBeTruthy();
      expect(window1m).toBeTruthy();
      expect(window15m).toBeTruthy();
      expect(window24h).toBeTruthy();
      expect(deep).toBeTruthy();

      expectRollupMatches(window15s!, expected15s);
      expectRollupMatches(window1m!, expected1m);
      expectRollupMatches(window15m!, expected15m);
      expectRollupMatches(window24h!, expected24h);
      expectRollupMatches(deep!, expectedDeep);

      const postProcess = await runOpsOneShotPerformanceRefresh();
      expectRollupMatches(postProcess.rollups.rollup15s, expected15s);
      expectRollupMatches(postProcess.rollups.rollup1m, expected1m);
      expectRollupMatches(postProcess.rollups.rollup15m, expected15m);
      expectRollupMatches(postProcess.rollups.rollup24h, expected24h);
      expectRollupMatches(postProcess.rollups.rollupDeep, expectedDeep);

      const oneShot = await runOpsOneShotPipeline({
        appName: "metrics-contract-test",
        timeoutMs: 1200,
        includeFly: false,
        includeTrendProjection: false,
        includeRecentJobs15m: true,
        includeRecentJobs24h: true,
        includePerformanceRollups: true,
        reconcileBullmqStatus: true,
      });

      const snapshot = oneShot.snapshot;

      expect(snapshot.performanceRollups).toBeTruthy();
      expectRollupMatches(snapshot.performanceRollups!.rollup15s, expected15s);
      expectRollupMatches(snapshot.performanceRollups!.rollup1m, expected1m);
      expectRollupMatches(snapshot.performanceRollups!.rollup15m, expected15m);
      expectRollupMatches(snapshot.performanceRollups!.rollup24h, expected24h);
      expectRollupMatches(
        snapshot.performanceRollups!.rollupDeep,
        expectedDeep,
      );

      const rollupHashType = await redis.type(PERF_ROLLUP_HASH_KEY);
      expect(rollupHashType).toBe("hash");

      const rollupHash = await redis.hgetall(PERF_ROLLUP_HASH_KEY);
      expect(Object.keys(rollupHash).sort()).toEqual(
        [
          "rollup_15m",
          "rollup_15s",
          "rollup_1m",
          "rollup_24h",
          "rollup_60m",
          "rollup_deep",
          "updated_at",
        ].sort(),
      );

      const pointDepth = rows.reduce(
        (acc, row) => acc + Math.max(1, Math.floor(row.processedCount)),
        0,
      );

      for (const keySet of imageJobMetricTrendKeys()) {
        const [trendType, trendDepth, latestRows] = await Promise.all([
          redis.type(keySet.trendKey),
          redis.zcard(keySet.trendKey),
          redis.zrevrange(keySet.trendKey, 0, 0, "WITHSCORES"),
        ]);

        expect(trendType).toBe("zset");
        const expectedDepth =
          keySet.metric === "failed_items" ? rows.length : pointDepth;
        expect(trendDepth).toBe(expectedDepth);
        expect(latestRows.length).toBeGreaterThanOrEqual(1);
      }
    } finally {
      await queue.close().catch(() => undefined);
    }
  });

  it("handles sparse windows with expected zeroed short-window rollups", async () => {
    const queue = createImageQueue(redis);
    try {
      const nowMs = Date.now();
      const rows: SeededMetricRow[] = [
        {
          id: "sparse-job-1",
          finishedAtMs: nowMs - 10 * 60_000,
          processedCount: 6,
          failedCount: 1,
          fetchMs: 200,
          transformMs: 100,
          uploadMs: 50,
          sourceBytes: 200_000,
          transformedBytes: 120_000,
        },
        {
          id: "sparse-job-2",
          finishedAtMs: nowMs - 45 * 60_000,
          processedCount: 4,
          failedCount: 0,
          fetchMs: 150,
          transformMs: 90,
          uploadMs: 60,
          sourceBytes: 170_000,
          transformedBytes: 110_000,
        },
      ];

      await seedCompletedJobMetrics({ redis, queue, rows, failedAtMs: [] });
      await syncImageJobMetricTrends({
        sampleLimit: 1000,
        depthLimit: 1000,
      });

      const windows = await readImageJobMetricRollupWindows({
        windowsMs: [15_000, 60_000, 15 * 60_000, 24 * 60 * 60_000],
        deepSampleLimit: 1000,
        syncBeforeRead: false,
      });

      const window15s = windows.windows[String(15_000)];
      const window1m = windows.windows[String(60_000)];
      const window15m = windows.windows[String(15 * 60_000)];
      const window24h = windows.windows[String(24 * 60 * 60_000)];

      expect(window15s?.completedJobs ?? -1).toBe(0);
      expect(window1m?.completedJobs ?? -1).toBe(0);
      expect(window15m?.completedJobs ?? -1).toBe(6);
      expect(window24h?.completedJobs ?? -1).toBe(10);
    } finally {
      await queue.close().catch(() => undefined);
    }
  });

  it("covers every trended metric key/type/value for runner and ui registries", async () => {
    await writeOpsControlSettings(
      {
        desiredMode: "run",
        enqueueEnabled: true,
        requireWorkersForEnqueue: true,
        minWorkersToEnqueue: 1,
        maxQueueBacklog: 240,
        refillLowWatermark: 120,
        refillTargetBacklog: 180,
        maxClaimPerCycle: 40,
        flushIntervalMs: 15000,
        harvestEnabled: true,
      },
      redis,
    );

    const infra = {
      workersRunning: 3,
      source: "metrics-contract-test",
      updatedAt: new Date().toISOString(),
    };
    await writeOpsInfraSnapshot(infra, redis);

    const status = makeStatus();
    await writeOpsRunnerStatus(status, redis);

    const statusRaw = await redis.hgetall(IMAGE_RUNNER_STATUS_KEY);
    const expectedStatusHash = expectedStatusHashFrom(status);
    expect(Object.keys(statusRaw).sort()).toEqual(
      Object.keys(expectedStatusHash).sort(),
    );
    for (const [field, expected] of Object.entries(expectedStatusHash)) {
      expect(statusRaw[field]).toBe(expected);
    }

    const infraRaw = await redis.hgetall(IMAGE_RUNNER_INFRA_KEY);
    const expectedInfraHash = expectedInfraHashFrom(infra);
    expect(Object.keys(infraRaw).sort()).toEqual(
      Object.keys(expectedInfraHash).sort(),
    );
    for (const [field, expected] of Object.entries(expectedInfraHash)) {
      expect(infraRaw[field]).toBe(expected);
    }

    const oneShot = await runOpsOneShotPipeline({
      appName: "metrics-contract-test",
      timeoutMs: 1200,
      includeFly: false,
      includeTrendProjection: true,
      includeRecentJobs15m: true,
      includeRecentJobs24h: true,
      includePerformanceRollups: true,
      reconcileBullmqStatus: false,
    });
    const snapshot = oneShot.snapshot;
    expect(snapshot.infra?.workersRunning).toBe(infra.workersRunning);
    expect(snapshot.infra?.source).toBe(infra.source);

    const runnerLatest = await readOpsRunnerTrendLatest(undefined);
    for (const metric of OPS_TREND_METRIC_REGISTRY) {
      const actual = runnerLatest[metric.name];
      expect(actual).toBeTruthy();
      expect(actual?.value).toBe(metric.getValue(status));

      const keyType = await redis.type(metric.key);
      expect(keyType).toBe("zset");
      expect(await redis.zcard(metric.key)).toBeGreaterThanOrEqual(1);
    }

    const uiLatest = await readOpsSnapshotTrendLatest(undefined);
    for (const metric of OPS_SNAPSHOT_TREND_METRIC_REGISTRY) {
      const actual = uiLatest[metric.name];
      expect(actual).toBeTruthy();
      expect(actual?.value).toBe(metric.getValue(snapshot));

      const keyType = await redis.type(metric.key);
      expect(keyType).toBe("zset");
      expect(await redis.zcard(metric.key)).toBeGreaterThanOrEqual(1);
    }
  });

  it("covers every raw trend metric value for latest seeded sample", async () => {
    const queue = createImageQueue(redis);
    try {
      const nowMs = Date.now();
      const rows: SeededMetricRow[] = [
        {
          id: "raw-contract-job-latest",
          finishedAtMs: nowMs - 2_000,
          processedCount: 7,
          failedCount: 2,
          fetchMs: 101,
          transformMs: 67,
          uploadMs: 55,
          sourceBytes: 111_000,
          transformedBytes: 88_000,
        },
        {
          id: "raw-contract-job-older",
          finishedAtMs: nowMs - 20_000,
          processedCount: 2,
          failedCount: 0,
          fetchMs: 80,
          transformMs: 45,
          uploadMs: 33,
          sourceBytes: 90_000,
          transformedBytes: 60_000,
        },
      ];

      await seedCompletedJobMetrics({ redis, queue, rows, failedAtMs: [] });
      await syncImageJobMetricTrends({
        sampleLimit: 1000,
        depthLimit: 1000,
      });

      const latest = rows[0];
      const expectedLatestValues: Record<string, number> = {
        completed_jobs: 1,
        fetch_ms: latest.fetchMs,
        transform_ms: latest.transformMs,
        upload_ms: latest.uploadMs,
        end_to_end_ms: latest.fetchMs + latest.transformMs + latest.uploadMs,
        elapsed_ms:
          latest.elapsedMs ??
          latest.fetchMs + latest.transformMs + latest.uploadMs,
        source_bytes: latest.sourceBytes,
        transformed_bytes: latest.transformedBytes,
        processed_items:
          Math.max(1, Math.floor(latest.processedCount)) > 1
            ? 1
            : latest.processedCount,
        failed_items: latest.failedCount,
      };

      const pointDepth = rows.reduce(
        (acc, row) => acc + Math.max(1, Math.floor(row.processedCount)),
        0,
      );

      for (const metric of imageJobMetricTrendKeys()) {
        const [trendType, trendDepth, latestRows] = await Promise.all([
          redis.type(metric.trendKey),
          redis.zcard(metric.trendKey),
          redis.zrevrange(metric.trendKey, 0, 0, "WITHSCORES"),
        ]);

        expect(trendType).toBe("zset");
        const expectedDepth =
          metric.metric === "failed_items" ? rows.length : pointDepth;
        expect(trendDepth).toBe(expectedDepth);
        expect(latestRows.length).toBeGreaterThanOrEqual(1);

        const parsedLatest = JSON.parse(String(latestRows[0])) as {
          atMs?: unknown;
          id?: unknown;
          value?: unknown;
        };
        expect(Number.isFinite(Number(parsedLatest.atMs))).toBe(true);
        expect(typeof parsedLatest.id).toBe("string");
        const latestValue = Number(parsedLatest.value);
        expect(Number.isFinite(latestValue)).toBe(true);
        expect(latestValue).toBe(expectedLatestValues[metric.metric]);
      }
    } finally {
      await queue.close().catch(() => undefined);
    }
  });

  describe("runner metrics (one test per metric)", () => {
    let fixture: RunnerUiMetricFixture;

    beforeAll(async () => {
      skipAutoReset = true;
      await resetState(redis);
      fixture = await buildRunnerUiMetricFixture(redis);
    });

    afterAll(() => {
      skipAutoReset = false;
    });

    for (const metric of OPS_TREND_METRIC_REGISTRY) {
      it(`runner metric ${metric.name} value and key contract`, async () => {
        const row = fixture.runner[metric.name];
        expect(row).toBeTruthy();
        expect(row.keyType).toBe("zset");
        expect(row.depth).toBeGreaterThanOrEqual(1);
        expect(row.actualValue).toBe(row.expectedValue);
        const latestKeyType = await redis.type(`${metric.key}:latest`);
        expect(latestKeyType).toBe("none");
      });
    }
  });

  describe("ui metrics (one test per metric)", () => {
    let fixture: RunnerUiMetricFixture;

    beforeAll(async () => {
      skipAutoReset = true;
      await resetState(redis);
      fixture = await buildRunnerUiMetricFixture(redis);
    });

    afterAll(() => {
      skipAutoReset = false;
    });

    for (const metric of OPS_SNAPSHOT_TREND_METRIC_REGISTRY) {
      it(`snapshot metric ${metric.name} value and key contract`, async () => {
        const row = fixture.ui[metric.name];
        expect(row).toBeTruthy();
        expect(row.keyType).toBe("zset");
        expect(row.depth).toBeGreaterThanOrEqual(1);
        expect(row.actualValue).toBe(row.expectedValue);
        const latestKeyType = await redis.type(`${metric.key}:latest`);
        expect(latestKeyType).toBe("none");
      });
    }
  });

  describe("raw metrics (one test per metric)", () => {
    let fixture: RawMetricFixture;
    let meta: RawFixtureMeta;

    beforeAll(async () => {
      skipAutoReset = true;
      if (!USE_EXISTING_BULLMQ_FIXTURE) {
        await resetState(redis);
      }
      const bundle = await buildRawMetricFixture(redis);
      fixture = bundle.metrics;
      meta = bundle.meta;
    });

    afterAll(() => {
      skipAutoReset = false;
    });

    for (const metric of imageJobMetricTrendKeys()) {
      it(`raw metric ${metric.metric} value and key contract`, () => {
        const row = fixture[metric.metric];
        expect(row).toBeTruthy();
        expect(row.trendType).toBe("zset");
        expect(row.trendDepth).toBe(row.expectedTrendDepth);
        expect(Number.isFinite(Number(row.trendLatestValue))).toBe(true);
        expect(row.stateValue).toBe(row.expectedStateValue);
      });
    }

    it("redis key inventory is predictable for seeded analytics fixture", async () => {
      const allKeys = await scanKeys(redis);
      const expectedKeys = expectedAnalyticsKeys(meta);

      const allowedEphemeral = new Set([
        "image:runner:control:state_updates:throttle",
        IMAGE_RUNNER_SETTINGS_KEY,
        IMAGE_RUNNER_INFRA_KEY,
        meta.queueFailedKey,
      ]);

      const filteredActual = allKeys.filter(
        (key) => !allowedEphemeral.has(key),
      );
      const filteredExpected = expectedKeys.filter(
        (key) => !allowedEphemeral.has(key),
      );
      const expectedSet = new Set(filteredExpected);
      const actualSet = new Set(filteredActual);

      const missing = filteredExpected.filter((key) => !actualSet.has(key));
      const unexpected = filteredActual.filter((key) => !expectedSet.has(key));

      if (LOG_REDIS_KEYS) {
        process.stdout.write(
          `[redis:key-inventory] expected_count=${expectedKeys.length} actual_count=${filteredActual.length}\n`,
        );
        process.stdout.write(
          `[redis:key-inventory] expected_keys=${JSON.stringify(expectedKeys)}\n`,
        );
        process.stdout.write(
          `[redis:key-inventory] actual_keys=${JSON.stringify(filteredActual)}\n`,
        );
        process.stdout.write(
          `[redis:key-inventory] missing=${JSON.stringify(missing)} unexpected=${JSON.stringify(unexpected)}\n`,
        );
      }

      expect(missing).toEqual([]);
      expect(unexpected).toEqual([]);
      expect(filteredActual.length).toBe(filteredExpected.length);
    });
  });
});
