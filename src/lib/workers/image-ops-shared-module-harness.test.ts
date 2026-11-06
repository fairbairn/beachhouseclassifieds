import { describe, expect, it } from "vitest";

import {
  buildSinceCursorMap,
  mergeTrendRowsByMetric,
} from "./image-ops-refresh-engine";
import {
  createOpsMetricState,
  ingestTrendRows,
  metricGraphSeriesFromState,
} from "./image-ops-shared-state";

describe("image ops shared module harness", () => {
  it("supports init preload + incremental append + graph extraction", () => {
    const metricState = createOpsMetricState({ maxPoints: 30_000 });

    const initRows = {
      queueBacklogLive: Array.from({ length: 8 }).map((_, index) => ({
        atMs: 1_000_000 + index * 60_000,
        value: index + 1,
      })),
      queueWaitingLive: Array.from({ length: 8 }).map((_, index) => ({
        atMs: 1_000_000 + index * 60_000,
        value: index,
      })),
    };

    const mergedInit = mergeTrendRowsByMetric({
      existing: {},
      incoming: initRows,
      lastAtMsByMetric: {},
      maxPoints: 30_000,
    });
    ingestTrendRows({
      state: metricState,
      trendRowsByMetric: mergedInit.rowsByMetric,
    });

    const cursors = buildSinceCursorMap({
      metricNames: ["queueBacklogLive", "queueWaitingLive"],
      lastAtMsByMetric: mergedInit.lastAtMsByMetric,
    });
    expect(cursors.queueBacklogLive).toBe(1_420_000);
    expect(cursors.queueWaitingLive).toBe(1_420_000);

    const deltaRows = {
      queueBacklogLive: [{ atMs: 1_480_000, value: 20 }],
      queueWaitingLive: [{ atMs: 1_480_000, value: 10 }],
    };
    const mergedDelta = mergeTrendRowsByMetric({
      existing: mergedInit.rowsByMetric,
      incoming: deltaRows,
      lastAtMsByMetric: mergedInit.lastAtMsByMetric,
      maxPoints: 30_000,
    });
    ingestTrendRows({
      state: metricState,
      trendRowsByMetric: mergedDelta.rowsByMetric,
    });

    const queue24hSeries = metricGraphSeriesFromState({
      state: metricState,
      metricId: "snapshot.queueBacklogLive",
      nowMs: 1_500_000,
      windowMs: 24 * 60 * 60 * 1000,
      targetPoints: 240,
    });

    expect(queue24hSeries.length).toBe(240);
    expect(Math.max(...queue24hSeries)).toBeGreaterThan(10);
  });

  it("preserves monotonic metric progression across multiple refresh waves", () => {
    const metricState = createOpsMetricState({ maxPoints: 30_000 });

    const wave1 = mergeTrendRowsByMetric({
      existing: {},
      incoming: {
        queueBacklogLive: [{ atMs: 10_000, value: 1 }],
        queueWaitingLive: [{ atMs: 10_000, value: 5 }],
      },
      lastAtMsByMetric: {},
      maxPoints: 30_000,
    });
    ingestTrendRows({
      state: metricState,
      trendRowsByMetric: wave1.rowsByMetric,
    });

    const wave2 = mergeTrendRowsByMetric({
      existing: wave1.rowsByMetric,
      incoming: {
        queueBacklogLive: [{ atMs: 11_000, value: 2 }],
        queueWaitingLive: [{ atMs: 10_500, value: 6 }],
      },
      lastAtMsByMetric: wave1.lastAtMsByMetric,
      maxPoints: 30_000,
    });
    ingestTrendRows({
      state: metricState,
      trendRowsByMetric: wave2.rowsByMetric,
    });

    const wave3 = mergeTrendRowsByMetric({
      existing: wave2.rowsByMetric,
      incoming: {
        queueBacklogLive: [{ atMs: 11_000, value: 999 }],
        queueWaitingLive: [{ atMs: 11_500, value: 7 }],
      },
      lastAtMsByMetric: wave2.lastAtMsByMetric,
      maxPoints: 30_000,
    });
    ingestTrendRows({
      state: metricState,
      trendRowsByMetric: wave3.rowsByMetric,
    });

    const cursors = buildSinceCursorMap({
      metricNames: ["queueBacklogLive", "queueWaitingLive"],
      lastAtMsByMetric: wave3.lastAtMsByMetric,
    });

    expect(cursors.queueBacklogLive).toBe(11_000);
    expect(cursors.queueWaitingLive).toBe(11_500);

    const backlogSeries = metricGraphSeriesFromState({
      state: metricState,
      metricId: "snapshot.queueBacklogLive",
      nowMs: 12_000,
      windowMs: 60_000,
      targetPoints: 32,
    });
    const waitingSeries = metricGraphSeriesFromState({
      state: metricState,
      metricId: "snapshot.queueWaitingLive",
      nowMs: 12_000,
      windowMs: 60_000,
      targetPoints: 32,
    });

    expect(backlogSeries.length).toBe(32);
    expect(waitingSeries.length).toBe(32);
    expect(Math.max(...backlogSeries)).toBeGreaterThanOrEqual(2);
    expect(Math.max(...waitingSeries)).toBeGreaterThanOrEqual(7);
  });
});
