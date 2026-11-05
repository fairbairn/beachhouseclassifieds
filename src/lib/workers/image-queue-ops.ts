import { Queue } from "bullmq";

import {
  IMAGE_QUEUE_NAME,
  createRedisConnection,
} from "../../workers/image-queue";

export type ImageQueueCounts = {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: number;
  backlog: number;
};

export type ImageQueueRecentJobWindow = {
  windowMs: number;
  windowStartAt: string;
  sampledAt: string;
  latestDataAt?: string | null;
  completedJobs: number;
  failedJobs: number;
  processedItems: number;
  failedItems: number;
  sampledCompletedJobs: number;
  fetchElapsedMsLow: number;
  fetchElapsedMsHigh: number;
  fetchElapsedMsAvg: number;
  transformElapsedMsLow: number;
  transformElapsedMsHigh: number;
  transformElapsedMsAvg: number;
  uploadElapsedMsLow: number;
  uploadElapsedMsHigh: number;
  uploadElapsedMsAvg: number;
  elapsedMsLow: number;
  elapsedMsHigh: number;
  elapsedMsAvg: number;
  sourceBytesLow: number;
  sourceBytesHigh: number;
  sourceBytesAvg: number;
  transformedBytesLow: number;
  transformedBytesHigh: number;
  transformedBytesAvg: number;
  avgFetchMs: number;
  avgTransformMs: number;
  avgUploadMs: number;
  avgEndToEndMs: number;
};

export type ImageQueueRecentJobWindows = Record<
  string,
  ImageQueueRecentJobWindow
>;

const MAX_COMPLETED_JOBS_FOR_LATENCY_SAMPLE = 1000;

function isPerfTraceEnabled(): boolean {
  const value = String(process.env.IMAGE_OPS_PERF_TRACE || "").toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function perfTrace(message: string): void {
  if (!isPerfTraceEnabled()) {
    return;
  }
  process.stdout.write(`[image-queue-ops:perf] ${message}\n`);
}

type CompletedJobLatencySummary = {
  sampledCompletedJobs: number;
  processedItems: number;
  failedItems: number;
  fetchElapsedMsLow: number;
  fetchElapsedMsHigh: number;
  fetchElapsedMsAvg: number;
  transformElapsedMsLow: number;
  transformElapsedMsHigh: number;
  transformElapsedMsAvg: number;
  uploadElapsedMsLow: number;
  uploadElapsedMsHigh: number;
  uploadElapsedMsAvg: number;
  elapsedMsLow: number;
  elapsedMsHigh: number;
  elapsedMsAvg: number;
  sourceBytesLow: number;
  sourceBytesHigh: number;
  sourceBytesAvg: number;
  transformedBytesLow: number;
  transformedBytesHigh: number;
  transformedBytesAvg: number;
  avgFetchMs: number;
  avgTransformMs: number;
  avgUploadMs: number;
  avgEndToEndMs: number;
};

type ParsedJobReturnPayload = {
  processedCount: number;
  failedCount: number;
  fetchElapsedMs: MetricAggregate;
  transformElapsedMs: MetricAggregate;
  uploadElapsedMs: MetricAggregate;
  endToEndMs: MetricAggregate;
  elapsedMs: MetricAggregate;
  sourceBytes: MetricAggregate;
  transformedBytes: MetricAggregate;
};

type CompletedJobSample = {
  finishedAtMs: number;
  parsed: ParsedJobReturnPayload | null;
};

type MetricAggregate = {
  count: number;
  sum: number;
  min: number;
  max: number;
};

function createMetricAggregate(): MetricAggregate {
  return {
    count: 0,
    sum: 0,
    min: Number.POSITIVE_INFINITY,
    max: Number.NEGATIVE_INFINITY,
  };
}

function addMetricSample(aggregate: MetricAggregate, sample: unknown): void {
  const value = toNumber(sample);
  if (!Number.isFinite(value) || value < 0) {
    return;
  }
  aggregate.count += 1;
  aggregate.sum += value;
  aggregate.min = Math.min(aggregate.min, value);
  aggregate.max = Math.max(aggregate.max, value);
}

function mergeMetricAggregate(
  target: MetricAggregate,
  source: MetricAggregate,
): void {
  if (source.count <= 0) {
    return;
  }
  target.count += source.count;
  target.sum += source.sum;
  target.min = Math.min(target.min, source.min);
  target.max = Math.max(target.max, source.max);
}

function metricLow(aggregate: MetricAggregate): number {
  if (aggregate.count <= 0 || !Number.isFinite(aggregate.min)) {
    return 0;
  }
  return Math.round(aggregate.min);
}

function metricHigh(aggregate: MetricAggregate): number {
  if (aggregate.count <= 0 || !Number.isFinite(aggregate.max)) {
    return 0;
  }
  return Math.round(aggregate.max);
}

function metricAvg(aggregate: MetricAggregate): number {
  if (aggregate.count <= 0) {
    return 0;
  }
  return Math.round(aggregate.sum / aggregate.count);
}

function toNumber(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return parsed;
}

function parseJobReturnPayload(
  raw: string | null,
): ParsedJobReturnPayload | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as {
      processed_count?: unknown;
      failed_count?: unknown;
      elapsed_ms?: unknown;
      items?: unknown;
    };
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    const fetchElapsedMs = createMetricAggregate();
    const transformElapsedMs = createMetricAggregate();
    const uploadElapsedMs = createMetricAggregate();
    const endToEndMs = createMetricAggregate();
    const sourceBytes = createMetricAggregate();
    const transformedBytes = createMetricAggregate();

    for (const itemRaw of items) {
      const item = itemRaw as {
        fetch_elapsed_ms?: unknown;
        transform_elapsed_ms?: unknown;
        upload_elapsed_ms?: unknown;
        source_bytes?: unknown;
        transformed_bytes?: unknown;
      };
      const fetchMs = Math.max(0, toNumber(item.fetch_elapsed_ms));
      const transformMs = Math.max(0, toNumber(item.transform_elapsed_ms));
      const uploadMs = Math.max(0, toNumber(item.upload_elapsed_ms));
      addMetricSample(fetchElapsedMs, fetchMs);
      addMetricSample(transformElapsedMs, transformMs);
      addMetricSample(uploadElapsedMs, uploadMs);
      addMetricSample(endToEndMs, fetchMs + transformMs + uploadMs);
      addMetricSample(sourceBytes, item.source_bytes);
      addMetricSample(transformedBytes, item.transformed_bytes);
    }

    const processedCountRaw = Math.max(
      0,
      Math.floor(toNumber(parsed.processed_count)),
    );
    const itemsCount = Math.max(0, items.length);
    const failedCount = Math.max(0, Math.floor(toNumber(parsed.failed_count)));
    const elapsedMs = createMetricAggregate();
    addMetricSample(elapsedMs, parsed.elapsed_ms);

    return {
      processedCount:
        itemsCount > 0
          ? itemsCount
          : processedCountRaw > 0
            ? processedCountRaw
            : fetchElapsedMs.count,
      failedCount,
      fetchElapsedMs,
      transformElapsedMs,
      uploadElapsedMs,
      endToEndMs,
      elapsedMs,
      sourceBytes,
      transformedBytes,
    };
  } catch {
    return null;
  }
}

function emptyCompletedJobLatencySummary(): CompletedJobLatencySummary {
  return {
    sampledCompletedJobs: 0,
    processedItems: 0,
    failedItems: 0,
    fetchElapsedMsLow: 0,
    fetchElapsedMsHigh: 0,
    fetchElapsedMsAvg: 0,
    transformElapsedMsLow: 0,
    transformElapsedMsHigh: 0,
    transformElapsedMsAvg: 0,
    uploadElapsedMsLow: 0,
    uploadElapsedMsHigh: 0,
    uploadElapsedMsAvg: 0,
    elapsedMsLow: 0,
    elapsedMsHigh: 0,
    elapsedMsAvg: 0,
    sourceBytesLow: 0,
    sourceBytesHigh: 0,
    sourceBytesAvg: 0,
    transformedBytesLow: 0,
    transformedBytesHigh: 0,
    transformedBytesAvg: 0,
    avgFetchMs: 0,
    avgTransformMs: 0,
    avgUploadMs: 0,
    avgEndToEndMs: 0,
  };
}

async function readCompletedJobLatencySamples(input: {
  connection: ReturnType<typeof createRedisConnection>;
  queue: Queue;
  minWindowStartMs: number;
}): Promise<CompletedJobSample[]> {
  const completedKey = input.queue.toKey("completed");
  const completedRows = await input.connection.zrevrangebyscore(
    completedKey,
    "+inf",
    String(input.minWindowStartMs),
    "WITHSCORES",
    "LIMIT",
    "0",
    String(MAX_COMPLETED_JOBS_FOR_LATENCY_SAMPLE),
  );

  if (!Array.isArray(completedRows) || completedRows.length === 0) {
    return [];
  }

  const samplesMeta: Array<{ jobId: string; finishedAtMs: number }> = [];
  for (let index = 0; index + 1 < completedRows.length; index += 2) {
    const jobId = String(completedRows[index] || "");
    const finishedAtMs = Number(completedRows[index + 1]);
    if (!jobId || !Number.isFinite(finishedAtMs)) {
      continue;
    }
    samplesMeta.push({ jobId, finishedAtMs });
  }

  if (samplesMeta.length === 0) {
    return [];
  }

  const pipeline = input.connection.pipeline();
  for (const sample of samplesMeta) {
    pipeline.hget(input.queue.toKey(sample.jobId), "returnvalue");
  }
  const payloadRows = await pipeline.exec();

  if (!Array.isArray(payloadRows) || payloadRows.length === 0) {
    return [];
  }

  const samples: CompletedJobSample[] = [];
  for (let index = 0; index < samplesMeta.length; index += 1) {
    const payloadRow = payloadRows[index];
    const payload =
      payloadRow && payloadRow[0] === null
        ? (payloadRow[1] as string | null)
        : null;
    samples.push({
      finishedAtMs: samplesMeta[index].finishedAtMs,
      parsed: parseJobReturnPayload(payload),
    });
  }

  return samples;
}

function summarizeCompletedJobLatencySamples(input: {
  samples: CompletedJobSample[];
  windowStartMs: number;
}): CompletedJobLatencySummary {
  if (input.samples.length === 0) {
    return emptyCompletedJobLatencySummary();
  }

  const windowSamples = input.samples.filter(
    (sample) => sample.finishedAtMs >= input.windowStartMs,
  );
  if (windowSamples.length === 0) {
    return emptyCompletedJobLatencySummary();
  }

  let sampledCompletedJobs = 0;
  let processedItems = 0;
  let failedItems = 0;
  const fetchElapsedMs = createMetricAggregate();
  const transformElapsedMs = createMetricAggregate();
  const uploadElapsedMs = createMetricAggregate();
  const endToEndMs = createMetricAggregate();
  const elapsedMs = createMetricAggregate();
  const sourceBytes = createMetricAggregate();
  const transformedBytes = createMetricAggregate();

  for (const sample of windowSamples) {
    sampledCompletedJobs += 1;
    const parsed = sample.parsed;
    if (!parsed) {
      continue;
    }

    processedItems += parsed.processedCount;
    failedItems += parsed.failedCount;
    mergeMetricAggregate(fetchElapsedMs, parsed.fetchElapsedMs);
    mergeMetricAggregate(transformElapsedMs, parsed.transformElapsedMs);
    mergeMetricAggregate(uploadElapsedMs, parsed.uploadElapsedMs);
    mergeMetricAggregate(endToEndMs, parsed.endToEndMs);
    mergeMetricAggregate(elapsedMs, parsed.elapsedMs);
    mergeMetricAggregate(sourceBytes, parsed.sourceBytes);
    mergeMetricAggregate(transformedBytes, parsed.transformedBytes);
  }

  return {
    sampledCompletedJobs,
    processedItems,
    failedItems,
    fetchElapsedMsLow: metricLow(fetchElapsedMs),
    fetchElapsedMsHigh: metricHigh(fetchElapsedMs),
    fetchElapsedMsAvg: metricAvg(fetchElapsedMs),
    transformElapsedMsLow: metricLow(transformElapsedMs),
    transformElapsedMsHigh: metricHigh(transformElapsedMs),
    transformElapsedMsAvg: metricAvg(transformElapsedMs),
    uploadElapsedMsLow: metricLow(uploadElapsedMs),
    uploadElapsedMsHigh: metricHigh(uploadElapsedMs),
    uploadElapsedMsAvg: metricAvg(uploadElapsedMs),
    elapsedMsLow: metricLow(elapsedMs),
    elapsedMsHigh: metricHigh(elapsedMs),
    elapsedMsAvg: metricAvg(elapsedMs),
    sourceBytesLow: metricLow(sourceBytes),
    sourceBytesHigh: metricHigh(sourceBytes),
    sourceBytesAvg: metricAvg(sourceBytes),
    transformedBytesLow: metricLow(transformedBytes),
    transformedBytesHigh: metricHigh(transformedBytes),
    transformedBytesAvg: metricAvg(transformedBytes),
    avgFetchMs: metricAvg(fetchElapsedMs),
    avgTransformMs: metricAvg(transformElapsedMs),
    avgUploadMs: metricAvg(uploadElapsedMs),
    avgEndToEndMs: metricAvg(endToEndMs),
  };
}

export async function readImageQueueCounts(): Promise<ImageQueueCounts> {
  const connection = createRedisConnection();
  const queue = new Queue(IMAGE_QUEUE_NAME, { connection });
  try {
    const counts = await queue.getJobCounts(
      "waiting",
      "active",
      "completed",
      "failed",
      "delayed",
    );
    const pausedJobs = await queue.getJobs(["paused"], 0, -1);
    const waiting = counts.waiting || 0;
    const active = counts.active || 0;
    const delayed = counts.delayed || 0;
    const paused = pausedJobs.length;

    return {
      waiting,
      active,
      completed: counts.completed || 0,
      failed: counts.failed || 0,
      delayed,
      paused,
      backlog: waiting + active + delayed + paused,
    };
  } finally {
    await queue.close().catch(() => undefined);
    await connection.quit().catch(() => undefined);
  }
}

export async function readImageQueueWorkersRunning(): Promise<number> {
  const connection = createRedisConnection();
  const queue = new Queue(IMAGE_QUEUE_NAME, { connection });
  try {
    const workers = await queue.getWorkers();
    return Array.isArray(workers) ? workers.length : 0;
  } finally {
    await queue.close().catch(() => undefined);
    await connection.quit().catch(() => undefined);
  }
}

export async function readImageQueuePausedState(): Promise<boolean> {
  const connection = createRedisConnection();
  const queue = new Queue(IMAGE_QUEUE_NAME, { connection });
  try {
    return await queue.isPaused();
  } finally {
    await queue.close().catch(() => undefined);
    await connection.quit().catch(() => undefined);
  }
}

export async function setImageQueuePaused(paused: boolean): Promise<boolean> {
  const connection = createRedisConnection();
  const queue = new Queue(IMAGE_QUEUE_NAME, { connection });
  try {
    if (paused) {
      await queue.pause();
    } else {
      await queue.resume();
    }
    return await queue.isPaused();
  } finally {
    await queue.close().catch(() => undefined);
    await connection.quit().catch(() => undefined);
  }
}

export async function purgePendingImageQueueJobs(): Promise<{
  removed: number;
  remainingWaiting: number;
  remainingDelayed: number;
  remainingActive: number;
  remainingPaused: number;
}> {
  const connection = createRedisConnection();
  const queue = new Queue(IMAGE_QUEUE_NAME, { connection });
  try {
    const jobs = await queue.getJobs(["waiting", "delayed", "paused"], 0, -1);
    const seenJobIds = new Set<string>();
    let removed = 0;

    for (const job of jobs) {
      const jobId = String(job.id || "");
      if (!jobId || seenJobIds.has(jobId)) {
        continue;
      }
      seenJobIds.add(jobId);
      try {
        await job.remove();
        removed += 1;
      } catch {
        // Ignore races where workers consume a job while purge is running.
      }
    }

    const counts = await queue.getJobCounts("waiting", "active", "delayed");
    const pausedJobs = await queue.getJobs(["paused"], 0, -1);
    return {
      removed,
      remainingWaiting: counts.waiting || 0,
      remainingDelayed: counts.delayed || 0,
      remainingActive: counts.active || 0,
      remainingPaused: pausedJobs.length,
    };
  } finally {
    await queue.close().catch(() => undefined);
    await connection.quit().catch(() => undefined);
  }
}

export async function readImageQueueRecentJobWindow(
  windowMs = 60 * 60 * 1000,
): Promise<ImageQueueRecentJobWindow> {
  const windows = await readImageQueueRecentJobWindows([windowMs]);
  return windows[String(Math.max(1_000, Math.floor(windowMs)))];
}

export async function readImageQueueRecentJobWindows(
  windowsMs: number[],
): Promise<ImageQueueRecentJobWindows> {
  const totalStartedAtMs = Date.now();
  const connection = createRedisConnection();
  const queue = new Queue(IMAGE_QUEUE_NAME, { connection });
  const nowMs = Date.now();
  const normalizedWindows = [...new Set(windowsMs)]
    .map((value) => Math.max(1_000, Math.floor(value)))
    .sort((left, right) => left - right);
  try {
    if (normalizedWindows.length === 0) {
      return {};
    }

    perfTrace(
      `readImageQueueRecentJobWindows start windows=${normalizedWindows.join(",")}`,
    );

    const completedKey = queue.toKey("completed");
    const failedKey = queue.toKey("failed");
    const widestWindowMs = normalizedWindows[normalizedWindows.length - 1];
    const minWindowStartMs = nowMs - widestWindowMs;
    const sampleStartedAtMs = Date.now();
    const completedSamples = await readCompletedJobLatencySamples({
      connection,
      queue,
      minWindowStartMs,
    });
    perfTrace(
      `completed sample scan jobs=${completedSamples.length} duration_ms=${Date.now() - sampleStartedAtMs}`,
    );

    const result: ImageQueueRecentJobWindows = {};
    for (const windowMs of normalizedWindows) {
      const windowStartedAtMs = Date.now();
      const windowStartMs = nowMs - windowMs;
      const [completedJobsRaw, failedJobsRaw] = await Promise.all([
        connection.zcount(completedKey, String(windowStartMs), "+inf"),
        connection.zcount(failedKey, String(windowStartMs), "+inf"),
      ]);
      const completedJobs = Math.max(0, Number(completedJobsRaw) || 0);
      const failedJobs = Math.max(0, Number(failedJobsRaw) || 0);
      const latencySummary = summarizeCompletedJobLatencySamples({
        samples: completedSamples,
        windowStartMs,
      });
      const processedItems =
        latencySummary.processedItems > 0
          ? latencySummary.processedItems
          : completedJobs;
      const failedItems =
        latencySummary.failedItems > 0
          ? latencySummary.failedItems
          : failedJobs;
      result[String(windowMs)] = {
        windowMs,
        windowStartAt: new Date(windowStartMs).toISOString(),
        sampledAt: new Date(nowMs).toISOString(),
        completedJobs,
        failedJobs,
        processedItems,
        failedItems,
        sampledCompletedJobs: latencySummary.sampledCompletedJobs,
        fetchElapsedMsLow: latencySummary.fetchElapsedMsLow,
        fetchElapsedMsHigh: latencySummary.fetchElapsedMsHigh,
        fetchElapsedMsAvg: latencySummary.fetchElapsedMsAvg,
        transformElapsedMsLow: latencySummary.transformElapsedMsLow,
        transformElapsedMsHigh: latencySummary.transformElapsedMsHigh,
        transformElapsedMsAvg: latencySummary.transformElapsedMsAvg,
        uploadElapsedMsLow: latencySummary.uploadElapsedMsLow,
        uploadElapsedMsHigh: latencySummary.uploadElapsedMsHigh,
        uploadElapsedMsAvg: latencySummary.uploadElapsedMsAvg,
        elapsedMsLow: latencySummary.elapsedMsLow,
        elapsedMsHigh: latencySummary.elapsedMsHigh,
        elapsedMsAvg: latencySummary.elapsedMsAvg,
        sourceBytesLow: latencySummary.sourceBytesLow,
        sourceBytesHigh: latencySummary.sourceBytesHigh,
        sourceBytesAvg: latencySummary.sourceBytesAvg,
        transformedBytesLow: latencySummary.transformedBytesLow,
        transformedBytesHigh: latencySummary.transformedBytesHigh,
        transformedBytesAvg: latencySummary.transformedBytesAvg,
        avgFetchMs: latencySummary.avgFetchMs,
        avgTransformMs: latencySummary.avgTransformMs,
        avgUploadMs: latencySummary.avgUploadMs,
        avgEndToEndMs: latencySummary.avgEndToEndMs,
      };
      perfTrace(
        `window=${windowMs}ms completed=${completedJobs} failed=${failedJobs} sampled=${latencySummary.sampledCompletedJobs} duration_ms=${Date.now() - windowStartedAtMs}`,
      );
    }

    perfTrace(
      `readImageQueueRecentJobWindows done duration_ms=${Date.now() - totalStartedAtMs}`,
    );

    return result;
  } finally {
    await queue.close().catch(() => undefined);
    await connection.quit().catch(() => undefined);
  }
}
