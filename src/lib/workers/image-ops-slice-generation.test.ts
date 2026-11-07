import { describe, expect, it } from "vitest";

import {
  buildMetricSliceCacheFromTrendRows,
  buildPerformanceRollupFromTrendRows,
  buildPerformanceRollupSetFromTrendRows,
  buildQueueWindowAveragesFromTrendRows,
} from "./image-ops-slice-generation";

describe("image ops slice generation", () => {
  it("computes counter deltas for completed/failed/processed/failedItems", () => {
    const nowMs = 1_200_000;
    const rollup = buildPerformanceRollupFromTrendRows({
      windowId: "1m",
      windowMs: 60_000,
      nowMs,
      computedAtIso: "2026-01-01T00:00:00.000Z",
      trendRowsByMetric: {
        statusCompletedJobs: [
          { atMs: nowMs - 80_000, value: 1000 },
          { atMs: nowMs - 30_000, value: 1040 },
        ],
        statusFailedJobs: [
          { atMs: nowMs - 80_000, value: 10 },
          { atMs: nowMs - 30_000, value: 13 },
        ],
        statusProcessedItems: [
          { atMs: nowMs - 80_000, value: 5000 },
          { atMs: nowMs - 30_000, value: 5120 },
        ],
        statusFailedItems: [
          { atMs: nowMs - 80_000, value: 90 },
          { atMs: nowMs - 30_000, value: 93 },
        ],
        avgFetchMs: [{ atMs: nowMs - 15_000, value: 120 }],
        avgTransformMs: [{ atMs: nowMs - 15_000, value: 80 }],
        avgUploadMs: [{ atMs: nowMs - 15_000, value: 60 }],
        avgEndToEndMs: [{ atMs: nowMs - 15_000, value: 260 }],
      },
    });

    expect(rollup.completedJobs).toBe(40);
    expect(rollup.failedJobs).toBe(3);
    expect(rollup.processedItems).toBe(120);
    expect(rollup.failedItems).toBe(3);
  });

  it("clamps negative counter movement to zero", () => {
    const nowMs = 500_000;
    const rollup = buildPerformanceRollupFromTrendRows({
      windowId: "15s",
      windowMs: 15_000,
      nowMs,
      computedAtIso: "2026-01-01T00:00:00.000Z",
      trendRowsByMetric: {
        statusCompletedJobs: [
          { atMs: nowMs - 20_000, value: 200 },
          { atMs: nowMs - 5_000, value: 180 },
        ],
        statusFailedJobs: [],
        statusProcessedItems: [],
        statusFailedItems: [],
      },
    });

    expect(rollup.completedJobs).toBe(0);
  });

  it("derives ips from max(window throughput, latency implied throughput)", () => {
    const nowMs = 900_000;
    const rollup = buildPerformanceRollupFromTrendRows({
      windowId: "1m",
      windowMs: 60_000,
      nowMs,
      computedAtIso: "2026-01-01T00:00:00.000Z",
      trendRowsByMetric: {
        statusCompletedJobs: [],
        statusFailedJobs: [],
        statusProcessedItems: [
          { atMs: nowMs - 61_000, value: 1000 },
          { atMs: nowMs - 1_000, value: 1060 },
        ],
        statusFailedItems: [],
        avgFetchMs: [{ atMs: nowMs - 1_000, value: 50 }],
        avgTransformMs: [{ atMs: nowMs - 1_000, value: 60 }],
        avgUploadMs: [{ atMs: nowMs - 1_000, value: 70 }],
        avgEndToEndMs: [{ atMs: nowMs - 1_000, value: 1000 }],
      },
    });

    // throughput from window: 60/60s = 1 ips, from latency: 1000/1000ms = 1 ips
    expect(rollup.ips).toBeCloseTo(1, 6);
    expect(rollup.ipm).toBeCloseTo(60, 6);
  });

  it("builds full rollup set with independent windows", () => {
    const nowMs = 2_000_000;
    const set = buildPerformanceRollupSetFromTrendRows({
      nowMs,
      computedAtIso: "2026-01-01T00:00:00.000Z",
      trendRowsByMetric: {
        statusCompletedJobs: [
          { atMs: nowMs - 3_700_000, value: 100 },
          { atMs: nowMs - 10_000, value: 160 },
        ],
        statusFailedJobs: [
          { atMs: nowMs - 3_700_000, value: 10 },
          { atMs: nowMs - 10_000, value: 12 },
        ],
        statusProcessedItems: [
          { atMs: nowMs - 3_700_000, value: 1000 },
          { atMs: nowMs - 10_000, value: 1300 },
        ],
        statusFailedItems: [
          { atMs: nowMs - 3_700_000, value: 20 },
          { atMs: nowMs - 10_000, value: 21 },
        ],
      },
      windowMsById: {
        w5s: 5_000,
        w15s: 15_000,
        w1m: 60_000,
        w15m: 900_000,
        w60m: 3_600_000,
        w24h: 86_400_000,
        deep: 315_360_000_000,
      },
    });

    expect(set.rollup15s.windowId).toBe("15s");
    expect(set.rollup1m.windowId).toBe("1m");
    expect(set.rollup15m.windowId).toBe("15m");
    expect(set.rollup60m.windowId).toBe("60m");
    expect(set.rollup24h.windowId).toBe("24h");
    expect(set.rollupDeep.windowId).toBe("deep");
  });

  it("builds queue window pending/active from central trend rows", () => {
    const nowMs = 1_000_000;
    const queue = buildQueueWindowAveragesFromTrendRows({
      nowMs,
      trendRowsByMetric: {
        queueWaitingLive: [
          { atMs: nowMs - 5_000, value: 80 },
          { atMs: nowMs - 1_000, value: 100 },
        ],
        queueDelayedLive: [
          { atMs: nowMs - 5_000, value: 10 },
          { atMs: nowMs - 1_000, value: 14 },
        ],
        queuePausedLive: [
          { atMs: nowMs - 5_000, value: 4 },
          { atMs: nowMs - 1_000, value: 6 },
        ],
        queueActiveLive: [
          { atMs: nowMs - 5_000, value: 12 },
          { atMs: nowMs - 1_000, value: 16 },
        ],
      },
    });

    expect(queue.w15s.pending).toBe(107);
    expect(queue.w15s.active).toBe(14);
  });

  it("returns zero for gauge windows with no in-range samples", () => {
    const nowMs = 1_000_000;
    const queue = buildQueueWindowAveragesFromTrendRows({
      nowMs,
      trendRowsByMetric: {
        queueWaitingLive: [{ atMs: nowMs - 5_000_000, value: 21 }],
        queueDelayedLive: [{ atMs: nowMs - 5_000_000, value: 2 }],
        queuePausedLive: [{ atMs: nowMs - 5_000_000, value: 1 }],
        queueActiveLive: [{ atMs: nowMs - 5_000_000, value: 7 }],
      },
    });

    expect(queue.w15s.pending).toBe(0);
    expect(queue.w15s.active).toBe(0);
  });

  it("builds universal metric slices for all metrics and windows", () => {
    const nowMs = 1_000_000;
    const cache = buildMetricSliceCacheFromTrendRows({
      nowMs,
      metricNames: ["queueActiveLive", "statusThroughputImagesPerMinute"],
      trendRowsByMetric: {
        queueActiveLive: [
          { atMs: nowMs - 12_000, value: 4 },
          { atMs: nowMs - 6_000, value: 8 },
          { atMs: nowMs - 1_000, value: 10 },
        ],
        statusThroughputImagesPerMinute: [
          { atMs: nowMs - 50_000, value: 120 },
          { atMs: nowMs - 20_000, value: 180 },
          { atMs: nowMs - 2_000, value: 240 },
        ],
      },
      windowMsById: {
        w5s: 5_000,
        w15s: 15_000,
        w1m: 60_000,
        w15m: 900_000,
        w60m: 3_600_000,
        w24h: 86_400_000,
        wDeep: 315_360_000_000,
      },
    });

    expect(cache.queueActiveLive.w15s.low).toBe(10);
    expect(cache.queueActiveLive.w15s.high).toBe(10);
    expect(cache.queueActiveLive.w15s.avg).toBe(10);
    expect(cache.queueActiveLive.w15s.latest).toBe(10);

    expect(cache.statusThroughputImagesPerMinute.w1m.low).toBe(120);
    expect(cache.statusThroughputImagesPerMinute.w1m.high).toBe(240);
    expect(cache.statusThroughputImagesPerMinute.w1m.latest).toBe(240);
  });

  it("returns zero for stale live metrics", () => {
    const nowMs = 5_000_000;
    const cache = buildMetricSliceCacheFromTrendRows({
      nowMs,
      metricNames: ["queuePausedLive"],
      trendRowsByMetric: {
        queuePausedLive: [{ atMs: nowMs - 10_000_000, value: 3 }],
      },
      windowMsById: {
        w5s: 5_000,
        w15s: 15_000,
        w1m: 60_000,
        w15m: 900_000,
        w60m: 3_600_000,
        w24h: 86_400_000,
        wDeep: 315_360_000_000,
      },
    });

    expect(cache.queuePausedLive.w15s.low).toBe(0);
    expect(cache.queuePausedLive.w15s.high).toBe(0);
    expect(cache.queuePausedLive.w15s.avg).toBe(0);
    expect(cache.queuePausedLive.w15s.latest).toBe(0);
    expect(cache.queuePausedLive.w15m.low).toBe(0);
    expect(cache.queuePausedLive.w15m.high).toBe(0);
    expect(cache.queuePausedLive.w15m.avg).toBe(0);
    expect(cache.queuePausedLive.w15m.latest).toBe(0);
  });

  it("returns zero for non-live metric when window has no in-range samples", () => {
    const nowMs = 5_000_000;
    const cache = buildMetricSliceCacheFromTrendRows({
      nowMs,
      metricNames: ["statusThroughputImagesPerMinute"],
      trendRowsByMetric: {
        statusThroughputImagesPerMinute: [
          { atMs: nowMs - 10_000_000, value: 3 },
        ],
      },
      windowMsById: {
        w5s: 5_000,
        w15s: 15_000,
        w1m: 60_000,
        w15m: 900_000,
        w60m: 3_600_000,
        w24h: 86_400_000,
        wDeep: 315_360_000_000,
      },
    });

    expect(cache.statusThroughputImagesPerMinute.w15s.low).toBe(0);
    expect(cache.statusThroughputImagesPerMinute.w15s.high).toBe(0);
    expect(cache.statusThroughputImagesPerMinute.w15s.avg).toBe(0);
    expect(cache.statusThroughputImagesPerMinute.w15s.latest).toBe(0);
  });
});
