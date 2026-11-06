import { describe, expect, it } from "vitest";

import { createOpsSharedModule } from "./image-ops-shared-module";

describe("image ops shared module", () => {
  it("builds since-cursor map and ingests init rows", () => {
    const module = createOpsSharedModule({
      metricNames: ["queueBacklogLive", "queueWaitingLive"],
      maxPoints: 100,
    });

    expect(module.getSinceCursorMap()).toEqual({
      queueBacklogLive: 0,
      queueWaitingLive: 0,
    });

    const result = module.ingestRefreshRows({
      queueBacklogLive: [
        { atMs: 1000, value: 1 },
        { atMs: 2000, value: 2 },
      ],
      queueWaitingLive: [{ atMs: 1000, value: 5 }],
    });

    expect(result.changed).toBe(true);
    expect(result.appendedRows).toBe(3);
    expect(result.touchedMetrics).toBe(2);
    expect(result.globalLastAtMs).toBe(2000);
    expect(module.getSinceCursorMap()).toEqual({
      queueBacklogLive: 2000,
      queueWaitingLive: 1000,
    });
  });

  it("does not re-append duplicate timestamps", () => {
    const module = createOpsSharedModule({
      metricNames: ["queueBacklogLive"],
      maxPoints: 100,
    });

    module.ingestRefreshRows({
      queueBacklogLive: [{ atMs: 1000, value: 1 }],
    });
    const second = module.ingestRefreshRows({
      queueBacklogLive: [
        { atMs: 1000, value: 999 },
        { atMs: 1500, value: 2 },
      ],
    });

    expect(second.appendedRows).toBe(1);
    expect(module.getMetricPointCount("snapshot.queueBacklogLive")).toBe(2);
    expect(module.getMetricLatest("snapshot.queueBacklogLive")?.value).toBe(2);
  });

  it("keeps lagging metrics moving independently", () => {
    const module = createOpsSharedModule({
      metricNames: ["queueBacklogLive", "queueWaitingLive"],
      maxPoints: 100,
    });

    module.ingestRefreshRows({
      queueBacklogLive: [{ atMs: 5000, value: 20 }],
      queueWaitingLive: [{ atMs: 1000, value: 5 }],
    });
    module.ingestRefreshRows({
      queueBacklogLive: [{ atMs: 6000, value: 21 }],
      queueWaitingLive: [{ atMs: 2000, value: 6 }],
    });

    expect(module.getMetricLatest("snapshot.queueBacklogLive")?.atMs).toBe(
      6000,
    );
    expect(module.getMetricLatest("snapshot.queueWaitingLive")?.atMs).toBe(
      2000,
    );
  });

  it("provides graph series from state", () => {
    const module = createOpsSharedModule({
      metricNames: ["queueBacklogLive"],
      maxPoints: 1000,
    });
    const nowMs = 1_000_000;

    module.ingestRefreshRows({
      queueBacklogLive: [
        { atMs: nowMs - 30_000, value: 0 },
        { atMs: nowMs - 20_000, value: 10 },
        { atMs: nowMs - 10_000, value: 20 },
      ],
    });

    const series = module.getMetricGraphSeries({
      metricId: "snapshot.queueBacklogLive",
      nowMs,
      windowMs: 60_000,
      targetPoints: 24,
    });

    expect(series.length).toBe(24);
    expect(Math.max(...series)).toBeGreaterThan(10);

    const values = module.getMetricWindowValues({
      metricId: "snapshot.queueBacklogLive",
      nowMs,
      windowMs: 60_000,
    });
    expect(values.length).toBe(3);

    const stats = module.getMetricWindowStats({
      metricId: "snapshot.queueBacklogLive",
      nowMs,
      windowMs: 60_000,
    });
    expect(stats.count).toBe(3);
    expect(stats.low).toBe(0);
    expect(stats.high).toBe(20);
    expect(stats.latest).toBe(20);

    const graphData = module.getMetricGraphData({
      metricId: "snapshot.queueBacklogLive",
      nowMs,
      windowMs: 60_000,
      targetPoints: 24,
    });
    expect(graphData.points.length).toBe(24);
    expect(graphData.low).toBe(0);
    expect(graphData.high).toBeGreaterThan(10);
  });

  it("supports multiple slice windows for low/high/avg/latest", () => {
    const module = createOpsSharedModule({
      metricNames: ["queueBacklogLive"],
      maxPoints: 1000,
    });

    const baseAtMs = 2_000_000;
    const rows = Array.from({ length: 10 }).map((_, index) => ({
      atMs: baseAtMs + index * 1000,
      value: index + 1,
    }));
    module.ingestRefreshRows({ queueBacklogLive: rows });

    const metricId = "snapshot.queueBacklogLive";
    const nowMs = baseAtMs + 10_000;

    const fullStats = module.getMetricWindowStats({
      metricId,
      nowMs,
      windowMs: 10_000,
    });
    expect(fullStats.count).toBe(10);
    expect(fullStats.low).toBe(1);
    expect(fullStats.high).toBe(10);
    expect(fullStats.avg).toBeCloseTo(5.5, 6);
    expect(fullStats.latest).toBe(10);

    const midStats = module.getMetricWindowStats({
      metricId,
      nowMs,
      windowMs: 5_000,
    });
    expect(midStats.count).toBe(5);
    expect(midStats.low).toBe(6);
    expect(midStats.high).toBe(10);
    expect(midStats.avg).toBeCloseTo(8, 6);
    expect(midStats.latest).toBe(10);

    const narrowStats = module.getMetricWindowStats({
      metricId,
      nowMs,
      windowMs: 2_000,
    });
    expect(narrowStats.count).toBe(2);
    expect(narrowStats.low).toBe(9);
    expect(narrowStats.high).toBe(10);
    expect(narrowStats.avg).toBeCloseTo(9.5, 6);
    expect(narrowStats.latest).toBe(10);
  });

  it("supports graph interpolation combinations by target size", () => {
    const module = createOpsSharedModule({
      metricNames: ["queueBacklogLive"],
      maxPoints: 1000,
    });
    const nowMs = 3_000_000;

    module.ingestRefreshRows({
      queueBacklogLive: [
        { atMs: nowMs - 40_000, value: 0 },
        { atMs: nowMs - 30_000, value: 10 },
        { atMs: nowMs - 20_000, value: 30 },
        { atMs: nowMs - 10_000, value: 5 },
      ],
    });

    const metricId = "snapshot.queueBacklogLive";
    const onePoint = module.getMetricGraphSeries({
      metricId,
      nowMs,
      windowMs: 60_000,
      targetPoints: 1,
    });
    const fivePoints = module.getMetricGraphSeries({
      metricId,
      nowMs,
      windowMs: 60_000,
      targetPoints: 5,
    });
    const widePoints = module.getMetricGraphSeries({
      metricId,
      nowMs,
      windowMs: 60_000,
      targetPoints: 240,
    });

    expect(onePoint.length).toBe(1);
    expect(fivePoints.length).toBe(5);
    expect(widePoints.length).toBe(240);

    const low = 0;
    const high = 30;
    expect(Math.max(...fivePoints)).toBeLessThanOrEqual(high);
    expect(Math.min(...fivePoints)).toBeGreaterThanOrEqual(low);
    expect(Math.max(...widePoints)).toBeLessThanOrEqual(high);
    expect(Math.min(...widePoints)).toBeGreaterThanOrEqual(low);
  });

  it("returns consistent graph contract for any metric with rolling updates", () => {
    const module = createOpsSharedModule({
      metricNames: ["queueBacklogLive", "queueWaitingLive"],
      maxPoints: 1000,
    });

    const baseAtMs = 5_000_000;
    module.ingestRefreshRows({
      queueBacklogLive: Array.from({ length: 30 }).map((_, index) => ({
        atMs: baseAtMs + index * 1000,
        value: index,
      })),
      queueWaitingLive: Array.from({ length: 30 }).map((_, index) => ({
        atMs: baseAtMs + index * 1000,
        value: index % 4,
      })),
    });

    const before = module.getMetricGraphData({
      metricId: "snapshot.queueBacklogLive",
      nowMs: baseAtMs + 29_000,
      windowMs: 60_000,
      targetPoints: 20,
      maxPoints: 20,
      mode: "rolling",
    });
    const waiting = module.getMetricGraphData({
      metricId: "snapshot.queueWaitingLive",
      nowMs: baseAtMs + 29_000,
      windowMs: 60_000,
      targetPoints: 20,
      maxPoints: 20,
      mode: "rolling",
    });
    expect(before.points.length).toBe(20);
    expect(before.plotPoints.length).toBe(20);
    expect(before.pointCount).toBe(20);
    expect(before.endAtMs).toBe(baseAtMs + 29_000);
    expect(waiting.points.length).toBe(20);

    module.ingestRefreshRows({
      queueBacklogLive: [{ atMs: baseAtMs + 30_000, value: 30 }],
    });

    const after = module.getMetricGraphData({
      metricId: "snapshot.queueBacklogLive",
      nowMs: baseAtMs + 30_000,
      windowMs: 60_000,
      targetPoints: 20,
      maxPoints: 20,
      mode: "rolling",
    });
    expect(after.points[19]).toBe(30);
    expect(after.points[0]).toBe(before.points[1]);
  });

  it("resets rows, cursors, and metric state", () => {
    const module = createOpsSharedModule({
      metricNames: ["queueBacklogLive"],
      maxPoints: 100,
    });

    module.ingestRefreshRows({
      queueBacklogLive: [{ atMs: 1000, value: 1 }],
    });
    module.reset();

    expect(module.getSinceCursorMap().queueBacklogLive).toBe(0);
    expect(module.getRowsByMetric().queueBacklogLive).toBeUndefined();
    expect(module.getMetricPointCount("snapshot.queueBacklogLive")).toBe(0);
    expect(module.getMetricLatest("snapshot.queueBacklogLive")).toBeNull();
  });
});
