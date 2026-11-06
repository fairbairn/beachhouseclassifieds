import { describe, expect, it } from "vitest";

import {
  createOpsMetricState,
  ingestTrendRows,
  metricGraphDataFromState,
  metricGraphSeriesFromState,
  metricLatestFromState,
  metricPointCountFromState,
  resetOpsMetricState,
} from "./image-ops-shared-state";

describe("image ops shared metric state", () => {
  it("ingests rows once and advances per-metric cursors", () => {
    const state = createOpsMetricState({ maxPoints: 100 });
    const base = 1_000_000;

    const first = ingestTrendRows({
      state,
      trendRowsByMetric: {
        queueBacklogLive: [
          { atMs: base + 1000, value: 10 },
          { atMs: base + 2000, value: 11 },
        ],
      },
    });
    expect(first.appendedRows).toBe(2);
    expect(first.touchedMetrics).toBe(1);

    const second = ingestTrendRows({
      state,
      trendRowsByMetric: {
        queueBacklogLive: [
          { atMs: base + 2000, value: 999 },
          { atMs: base + 3000, value: 12 },
        ],
      },
    });
    expect(second.appendedRows).toBe(1);
    expect(second.touchedMetrics).toBe(1);

    expect(
      metricPointCountFromState({
        state,
        metricId: "snapshot.queueBacklogLive",
      }),
    ).toBe(3);

    const latest = metricLatestFromState({
      state,
      metricId: "snapshot.queueBacklogLive",
    });
    expect(latest?.atMs).toBe(base + 3000);
    expect(latest?.value).toBe(12);
  });

  it("keeps independent cursors per metric", () => {
    const state = createOpsMetricState({ maxPoints: 100 });
    const base = 2_000_000;

    ingestTrendRows({
      state,
      trendRowsByMetric: {
        queueBacklogLive: [{ atMs: base + 5000, value: 20 }],
        queueWaitingLive: [{ atMs: base + 1000, value: 5 }],
      },
    });

    const next = ingestTrendRows({
      state,
      trendRowsByMetric: {
        queueBacklogLive: [{ atMs: base + 6000, value: 21 }],
        queueWaitingLive: [{ atMs: base + 2000, value: 6 }],
      },
    });

    expect(next.appendedRows).toBe(2);

    expect(
      metricLatestFromState({
        state,
        metricId: "snapshot.queueBacklogLive",
      })?.value,
    ).toBe(21);
    expect(
      metricLatestFromState({
        state,
        metricId: "snapshot.queueWaitingLive",
      })?.value,
    ).toBe(6);
  });

  it("returns graph series from window, or from tail when window is empty", () => {
    const state = createOpsMetricState({ maxPoints: 10_000 });
    const nowMs = 3_000_000;

    ingestTrendRows({
      state,
      trendRowsByMetric: {
        queueBacklogLive: [
          { atMs: nowMs - 20_000, value: 0 },
          { atMs: nowMs - 15_000, value: 5 },
          { atMs: nowMs - 10_000, value: 10 },
          { atMs: nowMs - 5_000, value: 8 },
        ],
      },
    });

    const windowSeries = metricGraphSeriesFromState({
      state,
      metricId: "snapshot.queueBacklogLive",
      nowMs,
      windowMs: 60_000,
      targetPoints: 16,
    });
    expect(windowSeries.length).toBe(16);
    expect(Math.max(...windowSeries)).toBeGreaterThan(8);

    const oldSeries = metricGraphSeriesFromState({
      state,
      metricId: "snapshot.queueBacklogLive",
      nowMs: nowMs + 10 * 24 * 60 * 60 * 1000,
      windowMs: 60_000,
      targetPoints: 8,
    });
    expect(oldSeries.length).toBeGreaterThan(0);

    const graphData = metricGraphDataFromState({
      state,
      metricId: "snapshot.queueBacklogLive",
      nowMs,
      windowMs: 60_000,
      targetPoints: 16,
    });
    expect(graphData.points.length).toBe(16);
    expect(graphData.low).toBeGreaterThanOrEqual(0);
    expect(graphData.high).toBeGreaterThan(graphData.low);
    expect(graphData.plotPoints.length).toBe(16);
    expect(graphData.pointCount).toBe(16);
    expect(graphData.endAtMs).toBe(nowMs);
    expect(graphData.startAtMs).toBe(nowMs - 60_000);
    expect(graphData.mode).toBe("rolling");
  });

  it("uses one graph API consistently across metrics and shifts in rolling mode", () => {
    const state = createOpsMetricState({ maxPoints: 10_000 });
    const baseAtMs = 4_000_000;

    ingestTrendRows({
      state,
      trendRowsByMetric: {
        queueBacklogLive: Array.from({ length: 40 }).map((_, index) => ({
          atMs: baseAtMs + index * 1000,
          value: index,
        })),
        queueWaitingLive: Array.from({ length: 40 }).map((_, index) => ({
          atMs: baseAtMs + index * 1000,
          value: index % 3,
        })),
      },
    });

    const nowMs = baseAtMs + 39_000;
    const backlogBefore = metricGraphDataFromState({
      state,
      metricId: "snapshot.queueBacklogLive",
      nowMs,
      windowMs: 60_000,
      targetPoints: 24,
      maxPoints: 24,
      mode: "rolling",
    });
    const waitingBefore = metricGraphDataFromState({
      state,
      metricId: "snapshot.queueWaitingLive",
      nowMs,
      windowMs: 60_000,
      targetPoints: 24,
      maxPoints: 24,
      mode: "rolling",
    });

    expect(backlogBefore.points.length).toBe(24);
    expect(waitingBefore.points.length).toBe(24);
    expect(backlogBefore.nonZeroCount).toBeGreaterThan(0);

    ingestTrendRows({
      state,
      trendRowsByMetric: {
        queueBacklogLive: [{ atMs: baseAtMs + 40_000, value: 40 }],
      },
    });

    const backlogAfter = metricGraphDataFromState({
      state,
      metricId: "snapshot.queueBacklogLive",
      nowMs: baseAtMs + 40_000,
      windowMs: 60_000,
      targetPoints: 24,
      maxPoints: 24,
      mode: "rolling",
    });
    expect(backlogAfter.points.length).toBe(24);
    expect(backlogAfter.points[23]).toBe(40);
    expect(backlogAfter.points[0]).toBe(backlogBefore.points[1]);
  });

  it("resets state cleanly", () => {
    const state = createOpsMetricState();

    ingestTrendRows({
      state,
      trendRowsByMetric: {
        queueBacklogLive: [{ atMs: 1000, value: 1 }],
      },
    });
    expect(
      metricPointCountFromState({
        state,
        metricId: "snapshot.queueBacklogLive",
      }),
    ).toBe(1);

    resetOpsMetricState(state);
    expect(
      metricPointCountFromState({
        state,
        metricId: "snapshot.queueBacklogLive",
      }),
    ).toBe(0);
  });
});
