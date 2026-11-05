import { Queue } from "bullmq";

import {
  IMAGE_QUEUE_NAME,
  createRedisConnection,
} from "../../workers/image-queue";
import {
  IMAGE_RAW_JOB_TREND_CURSOR_KEY,
  encodeImageTrendPoint,
  imageRawJobTrendMetricKey,
  parseImageTrendPoint,
} from "./image-metrics-redis-keys";
import type { ImageQueueRecentJobWindow } from "./image-queue-ops";

export type ImageJobMetricName =
  | "completed_jobs"
  | "fetch_ms"
  | "transform_ms"
  | "upload_ms"
  | "end_to_end_ms"
  | "elapsed_ms"
  | "source_bytes"
  | "transformed_bytes"
  | "processed_items"
  | "failed_items";

export type ImageJobMetricTrendSyncResult = {
  mode: "bootstrap" | "incremental";
  scannedCompletedJobs: number;
  parsedCompletedJobs: number;
  countMismatchedItemCounts: number;
  insertedMetricPoints: number;
  durationMs: number;
  cursorBeforeMs: number;
  cursorAfterMs: number;
};

export type ImageJobMetricRollupReadResult = {
  windows: Record<string, ImageQueueRecentJobWindow>;
  deepWindow: ImageQueueRecentJobWindow | null;
  sync: ImageJobMetricTrendSyncResult;
  durationMs: number;
};

type MetricAggregate = {
  count: number;
  sum: number;
  min: number;
  max: number;
};

type ParsedJobPayload = {
  processedCount: number;
  failedCount: number;
  countMismatch: boolean;
  completedAtMs: number | null;
  itemSamples: Array<{
    fetchMs: number;
    transformMs: number;
    uploadMs: number;
    endToEndMs: number;
    elapsedMs: number;
    sourceBytes: number;
    transformedBytes: number;
    completedAtMs: number | null;
  }>;
  fetchMsAvg: number;
  transformMsAvg: number;
  uploadMsAvg: number;
  endToEndMsAvg: number;
  elapsedMsAvg: number;
  sourceBytesAvg: number;
  transformedBytesAvg: number;
};

type CompletedRow = {
  jobId: string;
  finishedAtMs: number;
};

type MetricStats = {
  count: number;
  sum: number;
  low: number;
  high: number;
  avg: number;
};

const DEFAULT_DEEP_SAMPLE_LIMIT = 1000;

const METRIC_NAMES: ImageJobMetricName[] = [
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
];

function metricTrendKey(metric: ImageJobMetricName): string {
  return imageRawJobTrendMetricKey(metric);
}

function parseNumber(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return parsed;
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const parsedMs = Date.parse(value);
  if (!Number.isFinite(parsedMs) || parsedMs <= 0) {
    return null;
  }
  return parsedMs;
}

function parseItemCompletedAtMs(item: {
  processed_at?: unknown;
  item_completed_at?: unknown;
  completed_at?: unknown;
  s3_verified_at?: unknown;
}): number | null {
  return (
    parseTimestampMs(item.processed_at) ??
    parseTimestampMs(item.item_completed_at) ??
    parseTimestampMs(item.completed_at) ??
    parseTimestampMs(item.s3_verified_at)
  );
}

function inferItemCompletedAtTimeline(input: {
  jobCompletedAtMs: number;
  itemSamples: ParsedJobPayload["itemSamples"];
}): number[] {
  if (
    !Number.isFinite(input.jobCompletedAtMs) ||
    input.itemSamples.length === 0
  ) {
    return [];
  }

  const durations = input.itemSamples.map((sample) => {
    const duration = Math.round(Number(sample.endToEndMs));
    return Number.isFinite(duration) && duration > 0 ? duration : 1;
  });
  const totalDurationMs = durations.reduce((sum, value) => sum + value, 0);
  const startAtMs = input.jobCompletedAtMs - Math.max(1, totalDurationMs);

  const completedAtTimeline: number[] = [];
  let cursorMs = startAtMs;
  for (const durationMs of durations) {
    cursorMs += durationMs;
    completedAtTimeline.push(cursorMs);
  }
  return completedAtTimeline;
}

function createMetricAggregate(): MetricAggregate {
  return {
    count: 0,
    sum: 0,
    min: Number.POSITIVE_INFINITY,
    max: Number.NEGATIVE_INFINITY,
  };
}

function addSample(aggregate: MetricAggregate, raw: unknown): void {
  const value = parseNumber(raw);
  if (!Number.isFinite(value) || value < 0) {
    return;
  }
  aggregate.count += 1;
  aggregate.sum += value;
  aggregate.min = Math.min(aggregate.min, value);
  aggregate.max = Math.max(aggregate.max, value);
}

function aggregateAvg(aggregate: MetricAggregate): number {
  if (aggregate.count <= 0) {
    return 0;
  }
  return aggregate.sum / aggregate.count;
}

function parseJobReturnPayload(raw: string | null): ParsedJobPayload | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as {
      processed_count?: unknown;
      failed_count?: unknown;
      elapsed_ms?: unknown;
      completed_at?: unknown;
      items?: unknown;
    };

    const items = Array.isArray(parsed.items) ? parsed.items : [];
    const jobElapsedMs = Math.max(0, parseNumber(parsed.elapsed_ms));
    const fetch = createMetricAggregate();
    const transform = createMetricAggregate();
    const upload = createMetricAggregate();
    const endToEnd = createMetricAggregate();
    const sourceBytes = createMetricAggregate();
    const transformedBytes = createMetricAggregate();
    const itemSamples: ParsedJobPayload["itemSamples"] = [];

    for (const itemRaw of items) {
      const item = itemRaw as {
        fetch_elapsed_ms?: unknown;
        transform_elapsed_ms?: unknown;
        upload_elapsed_ms?: unknown;
        source_bytes?: unknown;
        transformed_bytes?: unknown;
        processed_at?: unknown;
        item_completed_at?: unknown;
        completed_at?: unknown;
        s3_verified_at?: unknown;
      };
      const fetchMs = Math.max(0, parseNumber(item.fetch_elapsed_ms));
      const transformMs = Math.max(0, parseNumber(item.transform_elapsed_ms));
      const uploadMs = Math.max(0, parseNumber(item.upload_elapsed_ms));
      addSample(fetch, fetchMs);
      addSample(transform, transformMs);
      addSample(upload, uploadMs);
      addSample(endToEnd, fetchMs + transformMs + uploadMs);
      addSample(sourceBytes, item.source_bytes);
      addSample(transformedBytes, item.transformed_bytes);
      itemSamples.push({
        fetchMs,
        transformMs,
        uploadMs,
        endToEndMs: fetchMs + transformMs + uploadMs,
        // Legacy payloads expose elapsed at job scope only; mirror it to each item point.
        elapsedMs:
          jobElapsedMs > 0 ? jobElapsedMs : fetchMs + transformMs + uploadMs,
        sourceBytes: Math.max(0, parseNumber(item.source_bytes)),
        transformedBytes: Math.max(0, parseNumber(item.transformed_bytes)),
        completedAtMs: parseItemCompletedAtMs(item),
      });
    }

    const elapsed = createMetricAggregate();
    addSample(elapsed, parsed.elapsed_ms);

    const processedCountRaw = Math.max(
      0,
      Math.floor(parseNumber(parsed.processed_count)),
    );
    const itemsCount = Math.max(0, items.length);
    const countMismatch =
      processedCountRaw > 0 &&
      itemsCount > 0 &&
      processedCountRaw !== itemsCount;

    // Treat item cardinality as source of truth when item rows are present.
    const processedCount =
      itemsCount > 0
        ? itemsCount
        : processedCountRaw > 0
          ? processedCountRaw
          : fetch.count;

    const failedCount = Math.max(
      0,
      Math.floor(parseNumber(parsed.failed_count)),
    );

    return {
      processedCount,
      failedCount,
      countMismatch,
      completedAtMs: parseTimestampMs(parsed.completed_at),
      itemSamples,
      fetchMsAvg: aggregateAvg(fetch),
      transformMsAvg: aggregateAvg(transform),
      uploadMsAvg: aggregateAvg(upload),
      endToEndMsAvg: aggregateAvg(endToEnd),
      elapsedMsAvg: aggregateAvg(elapsed),
      sourceBytesAvg: aggregateAvg(sourceBytes),
      transformedBytesAvg: aggregateAvg(transformedBytes),
    };
  } catch {
    return null;
  }
}

function buildMetricValueMap(
  payload: ParsedJobPayload,
): Record<ImageJobMetricName, number> {
  return {
    completed_jobs: 1,
    fetch_ms: payload.fetchMsAvg,
    transform_ms: payload.transformMsAvg,
    upload_ms: payload.uploadMsAvg,
    end_to_end_ms: payload.endToEndMsAvg,
    elapsed_ms: payload.elapsedMsAvg,
    source_bytes: payload.sourceBytesAvg,
    transformed_bytes: payload.transformedBytesAvg,
    processed_items: payload.processedCount,
    failed_items: payload.failedCount,
  };
}

function toCompletedRows(
  rawRows: unknown[],
  descending: boolean,
): CompletedRow[] {
  const rows: CompletedRow[] = [];
  for (let index = 0; index + 1 < rawRows.length; index += 2) {
    const jobId = String(rawRows[index] || "");
    const finishedAtMs = Number(rawRows[index + 1]);
    if (!jobId || !Number.isFinite(finishedAtMs)) {
      continue;
    }
    rows.push({ jobId, finishedAtMs });
  }
  if (descending) {
    rows.reverse();
  }
  return rows;
}

async function readCompletedRowsForSync(input: {
  connection: ReturnType<typeof createRedisConnection>;
  queue: Queue;
  cursorMs: number;
  sampleLimit: number;
}): Promise<{ mode: "bootstrap" | "incremental"; rows: CompletedRow[] }> {
  const completedKey = input.queue.toKey("completed");

  if (input.cursorMs > 0) {
    const rawRows = await input.connection.zrangebyscore(
      completedKey,
      `(${input.cursorMs}`,
      "+inf",
      "WITHSCORES",
    );
    return {
      mode: "incremental",
      rows: toCompletedRows(Array.isArray(rawRows) ? rawRows : [], false),
    };
  }

  const rawRows = await input.connection.zrevrangebyscore(
    completedKey,
    "+inf",
    "-inf",
    "WITHSCORES",
    "LIMIT",
    "0",
    String(input.sampleLimit),
  );
  return {
    mode: "bootstrap",
    rows: toCompletedRows(Array.isArray(rawRows) ? rawRows : [], true),
  };
}

async function trimMetricDepth(input: {
  connection: ReturnType<typeof createRedisConnection>;
  metric: ImageJobMetricName;
  depthLimit: number;
}): Promise<void> {
  const trimEnd = -(input.depthLimit + 1);
  await input.connection.zremrangebyrank(
    metricTrendKey(input.metric),
    0,
    trimEnd,
  );
}

function parseValues(rawValues: string[]): number[] {
  const values: number[] = [];
  for (const rawValue of rawValues) {
    if (!rawValue) {
      continue;
    }
    let parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) {
      const decoded = parseImageTrendPoint(rawValue);
      parsed = Number(decoded?.value);
    }
    if (!Number.isFinite(parsed) || parsed < 0) {
      continue;
    }
    values.push(parsed);
  }
  return values;
}

function summarizeValues(values: number[]): MetricStats {
  if (values.length === 0) {
    return {
      count: 0,
      sum: 0,
      low: 0,
      high: 0,
      avg: 0,
    };
  }

  let sum = 0;
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    sum += value;
    low = Math.min(low, value);
    high = Math.max(high, value);
  }

  return {
    count: values.length,
    sum,
    low,
    high,
    avg: sum / values.length,
  };
}

async function readMetricStatsForWindow(input: {
  connection: ReturnType<typeof createRedisConnection>;
  metric: ImageJobMetricName;
  windowStartMs: number;
}): Promise<MetricStats> {
  const rows = await input.connection.zrangebyscore(
    metricTrendKey(input.metric),
    String(input.windowStartMs),
    "+inf",
  );
  if (!Array.isArray(rows) || rows.length === 0) {
    return summarizeValues([]);
  }
  return summarizeValues(parseValues(rows));
}

async function readMetricStatsForDeep(input: {
  connection: ReturnType<typeof createRedisConnection>;
  metric: ImageJobMetricName;
  sampleLimit: number;
}): Promise<MetricStats> {
  const rows = await input.connection.zrevrange(
    metricTrendKey(input.metric),
    0,
    Math.max(0, input.sampleLimit - 1),
  );
  if (!Array.isArray(rows) || rows.length === 0) {
    return summarizeValues([]);
  }
  return summarizeValues(parseValues(rows));
}

function buildWindowFromMetricStats(input: {
  nowMs: number;
  windowMs: number;
  windowStartMs: number;
  completedJobs: number;
  failedJobs: number;
  fetch: MetricStats;
  transform: MetricStats;
  upload: MetricStats;
  endToEnd: MetricStats;
  elapsed: MetricStats;
  sourceBytes: MetricStats;
  transformedBytes: MetricStats;
  processedItems: MetricStats;
  failedItems: MetricStats;
}): ImageQueueRecentJobWindow {
  return {
    windowMs: input.windowMs,
    windowStartAt: new Date(input.windowStartMs).toISOString(),
    sampledAt: new Date(input.nowMs).toISOString(),
    completedJobs: input.completedJobs,
    failedJobs: input.failedJobs,
    processedItems: Math.max(0, Math.round(input.processedItems.sum)),
    failedItems: Math.max(0, Math.round(input.failedItems.sum)),
    sampledCompletedJobs: input.fetch.count,
    fetchElapsedMsLow: Math.round(input.fetch.low),
    fetchElapsedMsHigh: Math.round(input.fetch.high),
    fetchElapsedMsAvg: Math.round(input.fetch.avg),
    transformElapsedMsLow: Math.round(input.transform.low),
    transformElapsedMsHigh: Math.round(input.transform.high),
    transformElapsedMsAvg: Math.round(input.transform.avg),
    uploadElapsedMsLow: Math.round(input.upload.low),
    uploadElapsedMsHigh: Math.round(input.upload.high),
    uploadElapsedMsAvg: Math.round(input.upload.avg),
    elapsedMsLow: Math.round(input.elapsed.low),
    elapsedMsHigh: Math.round(input.elapsed.high),
    elapsedMsAvg: Math.round(input.elapsed.avg),
    sourceBytesLow: Math.round(input.sourceBytes.low),
    sourceBytesHigh: Math.round(input.sourceBytes.high),
    sourceBytesAvg: Math.round(input.sourceBytes.avg),
    transformedBytesLow: Math.round(input.transformedBytes.low),
    transformedBytesHigh: Math.round(input.transformedBytes.high),
    transformedBytesAvg: Math.round(input.transformedBytes.avg),
    avgFetchMs: Math.round(input.fetch.avg),
    avgTransformMs: Math.round(input.transform.avg),
    avgUploadMs: Math.round(input.upload.avg),
    avgEndToEndMs: Math.round(input.endToEnd.avg),
  };
}

export async function syncImageJobMetricTrends(input?: {
  sampleLimit?: number;
  depthLimit?: number;
}): Promise<ImageJobMetricTrendSyncResult> {
  const startedAtMs = Date.now();
  const sampleLimit = Math.max(
    1,
    Math.floor(input?.sampleLimit ?? DEFAULT_DEEP_SAMPLE_LIMIT),
  );
  const depthLimit = Math.max(
    1,
    Math.floor(input?.depthLimit ?? DEFAULT_DEEP_SAMPLE_LIMIT),
  );

  const connection = createRedisConnection();
  const queue = new Queue(IMAGE_QUEUE_NAME, { connection });

  try {
    const cursorBeforeMs =
      Number(await connection.get(IMAGE_RAW_JOB_TREND_CURSOR_KEY)) || 0;
    const completedJobsDepth = await connection.zcard(
      metricTrendKey("completed_jobs"),
    );
    const shouldBootstrapMissingMetric = completedJobsDepth <= 0;
    const completedRowsForSync = await readCompletedRowsForSync({
      connection,
      queue,
      cursorMs: shouldBootstrapMissingMetric ? 0 : cursorBeforeMs,
      sampleLimit,
    });

    const completedRows = completedRowsForSync.rows;
    if (completedRows.length === 0) {
      return {
        mode: completedRowsForSync.mode,
        scannedCompletedJobs: 0,
        parsedCompletedJobs: 0,
        countMismatchedItemCounts: 0,
        insertedMetricPoints: 0,
        durationMs: Date.now() - startedAtMs,
        cursorBeforeMs,
        cursorAfterMs: cursorBeforeMs,
      };
    }

    const payloadPipeline = connection.pipeline();
    for (const row of completedRows) {
      payloadPipeline.hget(queue.toKey(row.jobId), "returnvalue");
    }
    const payloadRows = await payloadPipeline.exec();

    const writePipeline = connection.pipeline();
    let parsedCompletedJobs = 0;
    let countMismatchedItemCounts = 0;
    let insertedMetricPoints = 0;
    const commandKinds: Array<"zadd"> = [];
    const writeMetricPoint = (input: {
      metric: ImageJobMetricName;
      memberId: string;
      atMs: number;
      value: number;
    }): void => {
      if (!Number.isFinite(input.value) || input.value < 0) {
        return;
      }

      writePipeline.zadd(
        metricTrendKey(input.metric),
        "NX",
        input.atMs,
        encodeImageTrendPoint({
          atMs: input.atMs,
          id: input.memberId,
          value: input.value,
        }),
      );
      commandKinds.push("zadd");
    };

    for (let index = 0; index < completedRows.length; index += 1) {
      const completedRow = completedRows[index];
      const payloadRow = payloadRows?.[index];
      const payload =
        payloadRow && payloadRow[0] === null
          ? (payloadRow[1] as string | null)
          : null;
      const parsed = parseJobReturnPayload(payload);
      if (!parsed) {
        continue;
      }

      parsedCompletedJobs += 1;
      if (parsed.countMismatch) {
        countMismatchedItemCounts += 1;
      }

      if (parsed.itemSamples.length > 0) {
        const jobCompletedAtMs =
          parsed.completedAtMs ?? completedRow.finishedAtMs;
        const inferredItemTimeline = inferItemCompletedAtTimeline({
          jobCompletedAtMs,
          itemSamples: parsed.itemSamples,
        });

        for (
          let itemIndex = 0;
          itemIndex < parsed.itemSamples.length;
          itemIndex += 1
        ) {
          const sample = parsed.itemSamples[itemIndex];
          const memberId = `${completedRow.jobId}:item:${itemIndex}`;
          const atMs =
            sample.completedAtMs ??
            inferredItemTimeline[itemIndex] ??
            jobCompletedAtMs ??
            completedRow.finishedAtMs;

          writeMetricPoint({
            metric: "completed_jobs",
            memberId,
            atMs,
            value: 1,
          });
          writeMetricPoint({
            metric: "processed_items",
            memberId,
            atMs,
            value: 1,
          });
          writeMetricPoint({
            metric: "fetch_ms",
            memberId,
            atMs,
            value: sample.fetchMs,
          });
          writeMetricPoint({
            metric: "transform_ms",
            memberId,
            atMs,
            value: sample.transformMs,
          });
          writeMetricPoint({
            metric: "upload_ms",
            memberId,
            atMs,
            value: sample.uploadMs,
          });
          writeMetricPoint({
            metric: "end_to_end_ms",
            memberId,
            atMs,
            value: sample.endToEndMs,
          });
          writeMetricPoint({
            metric: "elapsed_ms",
            memberId,
            atMs,
            value: sample.elapsedMs,
          });
          writeMetricPoint({
            metric: "source_bytes",
            memberId,
            atMs,
            value: sample.sourceBytes,
          });
          writeMetricPoint({
            metric: "transformed_bytes",
            memberId,
            atMs,
            value: sample.transformedBytes,
          });
        }

        writeMetricPoint({
          metric: "failed_items",
          memberId: `${completedRow.jobId}:failed`,
          atMs: completedRow.finishedAtMs,
          value: parsed.failedCount,
        });
        continue;
      }

      const metricValues = buildMetricValueMap(parsed);
      for (const metric of METRIC_NAMES) {
        writeMetricPoint({
          metric,
          memberId: completedRow.jobId,
          atMs: completedRow.finishedAtMs,
          value: metricValues[metric],
        });
      }
    }

    const writeRows = await writePipeline.exec();
    if (
      Array.isArray(writeRows) &&
      writeRows.length > 0 &&
      commandKinds.length === writeRows.length
    ) {
      for (let index = 0; index < writeRows.length; index += 1) {
        if (commandKinds[index] !== "zadd") {
          continue;
        }
        const value = Number(writeRows[index]?.[1]);
        if (Number.isFinite(value) && value > 0) {
          insertedMetricPoints += value;
        }
      }
    }

    for (const metric of METRIC_NAMES) {
      await trimMetricDepth({
        connection,
        metric,
        depthLimit,
      });
    }

    const cursorAfterMs =
      completedRows[completedRows.length - 1]?.finishedAtMs || cursorBeforeMs;
    await connection.set(IMAGE_RAW_JOB_TREND_CURSOR_KEY, String(cursorAfterMs));

    return {
      mode: completedRowsForSync.mode,
      scannedCompletedJobs: completedRows.length,
      parsedCompletedJobs,
      countMismatchedItemCounts,
      insertedMetricPoints,
      durationMs: Date.now() - startedAtMs,
      cursorBeforeMs,
      cursorAfterMs,
    };
  } finally {
    await queue.close().catch(() => undefined);
    await connection.quit().catch(() => undefined);
  }
}

export async function readImageJobMetricRollupWindows(input: {
  windowsMs: number[];
  deepSampleLimit?: number;
  syncBeforeRead?: boolean;
}): Promise<ImageJobMetricRollupReadResult> {
  const startedAtMs = Date.now();
  const normalizedWindows = [...new Set(input.windowsMs)]
    .map((windowMs) => Math.max(1_000, Math.floor(windowMs)))
    .sort((left, right) => left - right);
  const deepSampleLimit = Math.max(
    1,
    Math.floor(input.deepSampleLimit ?? DEFAULT_DEEP_SAMPLE_LIMIT),
  );
  const syncBeforeRead = input.syncBeforeRead !== false;

  const sync = syncBeforeRead
    ? await syncImageJobMetricTrends({
        sampleLimit: deepSampleLimit,
        depthLimit: deepSampleLimit,
      })
    : {
        mode: "incremental" as const,
        scannedCompletedJobs: 0,
        parsedCompletedJobs: 0,
        countMismatchedItemCounts: 0,
        insertedMetricPoints: 0,
        durationMs: 0,
        cursorBeforeMs: 0,
        cursorAfterMs: 0,
      };

  const connection = createRedisConnection();
  const queue = new Queue(IMAGE_QUEUE_NAME, { connection });

  try {
    const nowMs = Date.now();
    const completedKey = queue.toKey("completed");
    const failedKey = queue.toKey("failed");

    const windows: Record<string, ImageQueueRecentJobWindow> = {};
    for (const windowMs of normalizedWindows) {
      const windowStartMs = nowMs - windowMs;
      const [
        completedJobsMetric,
        failedRaw,
        fetch,
        transform,
        upload,
        endToEnd,
        elapsed,
        sourceBytes,
        transformedBytes,
        processedItems,
        failedItems,
      ] = await Promise.all([
        readMetricStatsForWindow({
          connection,
          metric: "completed_jobs",
          windowStartMs,
        }),
        connection.zcount(failedKey, String(windowStartMs), "+inf"),
        readMetricStatsForWindow({
          connection,
          metric: "fetch_ms",
          windowStartMs,
        }),
        readMetricStatsForWindow({
          connection,
          metric: "transform_ms",
          windowStartMs,
        }),
        readMetricStatsForWindow({
          connection,
          metric: "upload_ms",
          windowStartMs,
        }),
        readMetricStatsForWindow({
          connection,
          metric: "end_to_end_ms",
          windowStartMs,
        }),
        readMetricStatsForWindow({
          connection,
          metric: "elapsed_ms",
          windowStartMs,
        }),
        readMetricStatsForWindow({
          connection,
          metric: "source_bytes",
          windowStartMs,
        }),
        readMetricStatsForWindow({
          connection,
          metric: "transformed_bytes",
          windowStartMs,
        }),
        readMetricStatsForWindow({
          connection,
          metric: "processed_items",
          windowStartMs,
        }),
        readMetricStatsForWindow({
          connection,
          metric: "failed_items",
          windowStartMs,
        }),
      ]);

      windows[String(windowMs)] = buildWindowFromMetricStats({
        nowMs,
        windowMs,
        windowStartMs,
        completedJobs: Math.max(0, Math.round(completedJobsMetric.sum)),
        failedJobs: Math.max(0, Number(failedRaw) || 0),
        fetch,
        transform,
        upload,
        endToEnd,
        elapsed,
        sourceBytes,
        transformedBytes,
        processedItems,
        failedItems,
      });
    }

    const deepRows = await connection.zrevrangebyscore(
      completedKey,
      "+inf",
      "-inf",
      "WITHSCORES",
      "LIMIT",
      "0",
      String(deepSampleLimit),
    );
    const deepCompletedRows = toCompletedRows(
      Array.isArray(deepRows) ? deepRows : [],
      true,
    );

    let deepWindow: ImageQueueRecentJobWindow | null = null;
    if (deepCompletedRows.length > 0) {
      const deepOldestAtMs = deepCompletedRows[0].finishedAtMs;
      const [
        deepFailedRaw,
        completedJobsMetric,
        fetch,
        transform,
        upload,
        endToEnd,
        elapsed,
        sourceBytes,
        transformedBytes,
        processedItems,
        failedItems,
      ] = await Promise.all([
        connection.zcount(failedKey, String(deepOldestAtMs), "+inf"),
        readMetricStatsForDeep({
          connection,
          metric: "completed_jobs",
          sampleLimit: deepSampleLimit,
        }),
        readMetricStatsForDeep({
          connection,
          metric: "fetch_ms",
          sampleLimit: deepSampleLimit,
        }),
        readMetricStatsForDeep({
          connection,
          metric: "transform_ms",
          sampleLimit: deepSampleLimit,
        }),
        readMetricStatsForDeep({
          connection,
          metric: "upload_ms",
          sampleLimit: deepSampleLimit,
        }),
        readMetricStatsForDeep({
          connection,
          metric: "end_to_end_ms",
          sampleLimit: deepSampleLimit,
        }),
        readMetricStatsForDeep({
          connection,
          metric: "elapsed_ms",
          sampleLimit: deepSampleLimit,
        }),
        readMetricStatsForDeep({
          connection,
          metric: "source_bytes",
          sampleLimit: deepSampleLimit,
        }),
        readMetricStatsForDeep({
          connection,
          metric: "transformed_bytes",
          sampleLimit: deepSampleLimit,
        }),
        readMetricStatsForDeep({
          connection,
          metric: "processed_items",
          sampleLimit: deepSampleLimit,
        }),
        readMetricStatsForDeep({
          connection,
          metric: "failed_items",
          sampleLimit: deepSampleLimit,
        }),
      ]);

      deepWindow = buildWindowFromMetricStats({
        nowMs,
        windowMs: Math.max(1_000, nowMs - deepOldestAtMs),
        windowStartMs: deepOldestAtMs,
        completedJobs: Math.max(0, Math.round(completedJobsMetric.sum)),
        failedJobs: Math.max(0, Number(deepFailedRaw) || 0),
        fetch,
        transform,
        upload,
        endToEnd,
        elapsed,
        sourceBytes,
        transformedBytes,
        processedItems,
        failedItems,
      });
    }

    return {
      windows,
      deepWindow,
      sync,
      durationMs: Date.now() - startedAtMs,
    };
  } finally {
    await queue.close().catch(() => undefined);
    await connection.quit().catch(() => undefined);
  }
}

export function imageJobMetricTrendKeys(): Array<{
  metric: ImageJobMetricName;
  trendKey: string;
}> {
  return METRIC_NAMES.map((metric) => ({
    metric,
    trendKey: metricTrendKey(metric),
  }));
}
