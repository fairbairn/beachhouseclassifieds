import { describe, expect, it } from "vitest";

import {
  appendMetricHistory,
  metricWindowInterpolated,
  metricWindowStats,
  metricWindowValues,
  type MetricHistoryTable,
} from "./image-ops-metric-history";

describe("image ops metric history architecture", () => {
  it("keeps timestamp-sorted history and overwrites duplicate timestamps", () => {
    const table: MetricHistoryTable = {};

    appendMetricHistory({
      table,
      metricId: "snapshot.queueBacklogLive",
      atMs: 300,
      value: 3,
      maxPoints: 100,
    });
    appendMetricHistory({
      table,
      metricId: "snapshot.queueBacklogLive",
      atMs: 100,
      value: 1,
      maxPoints: 100,
    });
    appendMetricHistory({
      table,
      metricId: "snapshot.queueBacklogLive",
      atMs: 200,
      value: 2,
      maxPoints: 100,
    });
    appendMetricHistory({
      table,
      metricId: "snapshot.queueBacklogLive",
      atMs: 200,
      value: 22,
      maxPoints: 100,
    });

    const points = table["snapshot.queueBacklogLive"]?.points ?? [];
    expect(points.map((row) => row.atMs)).toEqual([100, 200, 300]);
    expect(points.map((row) => row.value)).toEqual([1, 22, 3]);
  });

  it("trims to max points while preserving order and index integrity", () => {
    const table: MetricHistoryTable = {};
    for (let i = 1; i <= 5; i += 1) {
      appendMetricHistory({
        table,
        metricId: "snapshot.queueBacklogLive",
        atMs: i * 1000,
        value: i,
        maxPoints: 3,
      });
    }

    const series = table["snapshot.queueBacklogLive"];
    expect(series?.points.map((row) => row.atMs)).toEqual([3000, 4000, 5000]);
    expect(series?.points.map((row) => row.value)).toEqual([3, 4, 5]);

    const byAtMs = series?.byAtMs || {};
    expect(byAtMs[3000]).toBe(0);
    expect(byAtMs[4000]).toBe(1);
    expect(byAtMs[5000]).toBe(2);
  });

  it("returns raw window values and computes low/high/avg/latest from state history", () => {
    const table: MetricHistoryTable = {};
    const nowMs = 1_000_000;

    const valuesInOrder = [0, 5, 10, 0, 20, 15];
    for (let index = 0; index < valuesInOrder.length; index += 1) {
      const atMs = nowMs - (valuesInOrder.length - 1 - index) * 60_000;
      appendMetricHistory({
        table,
        metricId: "snapshot.queueBacklogLive",
        atMs,
        value: valuesInOrder[index] || 0,
        maxPoints: 10_000,
      });
    }

    const values = metricWindowValues({
      table,
      metricId: "snapshot.queueBacklogLive",
      nowMs,
      windowMs: 24 * 60 * 60 * 1000,
    });
    expect(values).toEqual(valuesInOrder);

    const stats = metricWindowStats({
      table,
      metricId: "snapshot.queueBacklogLive",
      nowMs,
      windowMs: 24 * 60 * 60 * 1000,
    });
    expect(stats.count).toBe(valuesInOrder.length);
    expect(stats.low).toBe(0);
    expect(stats.high).toBe(20);
    expect(stats.latest).toBe(15);
    expect(stats.avg).toBeCloseTo(50 / 6, 6);
  });

  it("interpolates chart-ready sets from in-memory history for arbitrary window requests", () => {
    const table: MetricHistoryTable = {};
    const nowMs = 2_000_000;

    const rawValues = [0, 10, 20, 10, 0];
    for (let index = 0; index < rawValues.length; index += 1) {
      const atMs = nowMs - (rawValues.length - 1 - index) * 5_000;
      appendMetricHistory({
        table,
        metricId: "snapshot.queueBacklogLive",
        atMs,
        value: rawValues[index] || 0,
        maxPoints: 10_000,
      });
    }

    const interpolated = metricWindowInterpolated({
      table,
      metricId: "snapshot.queueBacklogLive",
      nowMs,
      windowMs: 60_000,
      targetPoints: 11,
    });

    expect(interpolated.length).toBe(11);
    expect(interpolated[0]).toBe(0);
    expect(interpolated[interpolated.length - 1]).toBe(0);
    expect(Math.max(...interpolated)).toBeGreaterThan(15);
  });
});
