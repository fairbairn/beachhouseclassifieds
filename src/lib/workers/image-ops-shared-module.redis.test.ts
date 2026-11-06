import IORedis from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  OPS_SNAPSHOT_TREND_METRIC_REGISTRY,
  ingestOpsMetricSamples,
  readOpsSnapshotTrendRowsSince,
} from "@/lib/workers/image-ops-control-module";
import { createOpsSharedModule } from "@/lib/workers/image-ops-shared-module";
import { DEFAULT_LOCAL_REDIS_URL } from "@/workers/image-queue";

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

function assertLoopbackRedisUrl(rawUrl: string): void {
  const parsed = new URL(rawUrl);
  const host = parsed.hostname.trim().toLowerCase();
  const isLoopback =
    host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (!isLoopback) {
    throw new Error(
      `Redis integration tests must run against loopback. host=${host} url=${rawUrl}`,
    );
  }
}

function makeSeededRng(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x100000000;
  };
}

const redisUrl = resolveWorkerRedisUrl(
  process.env.IMAGE_OPS_TEST_REDIS_URL?.trim() ||
    process.env.REDIS_URL?.trim() ||
    DEFAULT_LOCAL_REDIS_URL,
);

describeRedis("image ops shared module redis simulation", () => {
  let redis: IORedis;
  let previousRedisUrl: string | undefined;

  const metric = OPS_SNAPSHOT_TREND_METRIC_REGISTRY.find(
    (entry) => entry.name === "queueBacklogLive",
  );
  if (!metric) {
    throw new Error("missing snapshot metric descriptor: queueBacklogLive");
  }
  const trendKey = metric.key;
  const trendLatestKey = `${trendKey}:latest`;

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
    await redis.del(trendKey, trendLatestKey);
  });

  it("writes 500 samples via module, reads via pipeline path, and verifies state outputs", async () => {
    const rng = makeSeededRng(1337);
    const sampleCount = 500;
    const baseAtMs = 1_800_000_000_000;

    const samples = Array.from({ length: sampleCount }).map((_, index) => ({
      key: trendKey,
      atMs: baseAtMs + index * 1000,
      value: Math.floor(rng() * 10_000),
    }));

    await ingestOpsMetricSamples({
      redis,
      samples,
      flushNow: true,
    });

    const storedCount = await redis.zcard(trendKey);
    expect(storedCount).toBe(sampleCount);

    const rowsByMetric = await readOpsSnapshotTrendRowsSince({
      redis,
      metricNames: ["queueBacklogLive"],
      sinceAtMsExclusive: 0,
      limitPerMetric: sampleCount + 5,
    });
    const rows = rowsByMetric.queueBacklogLive ?? [];
    expect(rows.length).toBe(sampleCount);

    const sharedModule = createOpsSharedModule({
      metricNames: ["queueBacklogLive"],
      maxPoints: 10_000,
    });

    const ingestResult = sharedModule.ingestRefreshRows(rowsByMetric);
    expect(ingestResult.appendedRows).toBe(sampleCount);
    expect(ingestResult.touchedMetrics).toBe(1);

    const metricId = "snapshot.queueBacklogLive";
    const latest = sharedModule.getMetricLatest(metricId);
    expect(latest?.atMs).toBe(baseAtMs + (sampleCount - 1) * 1000);
    expect(latest?.value).toBe(samples[sampleCount - 1]?.value);

    const nowMs = baseAtMs + sampleCount * 1000;
    const values = sharedModule.getMetricWindowValues({
      metricId,
      nowMs,
      windowMs: sampleCount * 1000 + 5000,
    });
    expect(values.length).toBe(sampleCount);

    const expectedLow = Math.min(...samples.map((sample) => sample.value));
    const expectedHigh = Math.max(...samples.map((sample) => sample.value));
    const expectedAvg =
      samples.reduce((sum, sample) => sum + sample.value, 0) / sampleCount;

    const stats = sharedModule.getMetricWindowStats({
      metricId,
      nowMs,
      windowMs: sampleCount * 1000 + 5000,
    });
    expect(stats.count).toBe(sampleCount);
    expect(stats.low).toBe(expectedLow);
    expect(stats.high).toBe(expectedHigh);
    expect(stats.avg).toBeCloseTo(expectedAvg, 6);
    expect(stats.latest).toBe(samples[sampleCount - 1]?.value);

    const last60Stats = sharedModule.getMetricWindowStats({
      metricId,
      nowMs,
      windowMs: 60_000,
    });
    const tail60 = samples.slice(-60).map((sample) => sample.value);
    const tail60Avg =
      tail60.reduce((sum, value) => sum + value, 0) / tail60.length;
    expect(last60Stats.count).toBe(60);
    expect(last60Stats.low).toBe(Math.min(...tail60));
    expect(last60Stats.high).toBe(Math.max(...tail60));
    expect(last60Stats.avg).toBeCloseTo(tail60Avg, 6);
    expect(last60Stats.latest).toBe(samples[sampleCount - 1]?.value);

    const last10Stats = sharedModule.getMetricWindowStats({
      metricId,
      nowMs,
      windowMs: 10_000,
    });
    const tail10 = samples.slice(-10).map((sample) => sample.value);
    const tail10Avg =
      tail10.reduce((sum, value) => sum + value, 0) / tail10.length;
    expect(last10Stats.count).toBe(10);
    expect(last10Stats.low).toBe(Math.min(...tail10));
    expect(last10Stats.high).toBe(Math.max(...tail10));
    expect(last10Stats.avg).toBeCloseTo(tail10Avg, 6);
    expect(last10Stats.latest).toBe(samples[sampleCount - 1]?.value);

    const graph = sharedModule.getMetricGraphSeries({
      metricId,
      nowMs,
      windowMs: sampleCount * 1000 + 5000,
      targetPoints: 240,
    });
    expect(graph.length).toBe(240);
    expect(Math.max(...graph)).toBeLessThanOrEqual(expectedHigh);
    expect(Math.max(...graph)).toBeGreaterThanOrEqual(expectedLow);
    expect(Math.min(...graph)).toBeGreaterThanOrEqual(expectedLow);
    expect(Math.min(...graph)).toBeLessThanOrEqual(expectedHigh);

    const graph60 = sharedModule.getMetricGraphSeries({
      metricId,
      nowMs,
      windowMs: 60_000,
      targetPoints: 60,
    });
    expect(graph60.length).toBe(60);

    const graphLast = sharedModule.getMetricGraphSeries({
      metricId,
      nowMs,
      windowMs: 60_000,
      targetPoints: 1,
    });
    expect(graphLast.length).toBe(1);
  });

  it("injects synthetic samples and validates generated metric slices from module state", async () => {
    const baseAtMs = 1_900_000_000_000;
    const values = Array.from({ length: 120 }).map(
      (_, index) => (index % 12) * 5 + 10,
    );

    const samples = values.map((value, index) => ({
      key: trendKey,
      atMs: baseAtMs + index * 1000,
      value,
    }));

    await ingestOpsMetricSamples({
      redis,
      samples,
      flushNow: true,
    });

    const rowsByMetric = await readOpsSnapshotTrendRowsSince({
      redis,
      metricNames: ["queueBacklogLive"],
      sinceAtMsExclusive: 0,
      limitPerMetric: 200,
    });

    const sharedModule = createOpsSharedModule({
      metricNames: ["queueBacklogLive"],
      maxPoints: 5000,
    });

    sharedModule.ingestRefreshRows(rowsByMetric);

    const metricId = "snapshot.queueBacklogLive";
    const nowMs = baseAtMs + values.length * 1000;
    const windows = [
      { id: "15s", windowMs: 15_000 },
      { id: "1m", windowMs: 60_000 },
      { id: "2m", windowMs: 120_000 },
    ] as const;

    const slices = sharedModule.getMetricSlices({
      metricId,
      nowMs,
      windows: [...windows],
    });
    expect(slices).toHaveLength(3);

    const tail15 = values.slice(-15);
    const tail60 = values.slice(-60);
    const tail120 = values.slice(-120);

    const avg = (input: number[]): number =>
      input.reduce((sum, value) => sum + value, 0) / input.length;

    const byId = Object.fromEntries(
      slices.map((slice) => [slice.id, slice.stats]),
    ) as Record<
      string,
      { count: number; low: number; high: number; avg: number; latest: number }
    >;

    expect(byId["15s"].count).toBe(15);
    expect(byId["15s"].low).toBe(Math.min(...tail15));
    expect(byId["15s"].high).toBe(Math.max(...tail15));
    expect(byId["15s"].avg).toBeCloseTo(avg(tail15), 6);
    expect(byId["15s"].latest).toBe(values[values.length - 1]);

    expect(byId["1m"].count).toBe(60);
    expect(byId["1m"].low).toBe(Math.min(...tail60));
    expect(byId["1m"].high).toBe(Math.max(...tail60));
    expect(byId["1m"].avg).toBeCloseTo(avg(tail60), 6);
    expect(byId["1m"].latest).toBe(values[values.length - 1]);

    expect(byId["2m"].count).toBe(120);
    expect(byId["2m"].low).toBe(Math.min(...tail120));
    expect(byId["2m"].high).toBe(Math.max(...tail120));
    expect(byId["2m"].avg).toBeCloseTo(avg(tail120), 6);
    expect(byId["2m"].latest).toBe(values[values.length - 1]);
  });
});
