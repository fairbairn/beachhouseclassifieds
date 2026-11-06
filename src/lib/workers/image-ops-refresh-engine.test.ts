import { describe, expect, it } from "vitest";

import {
  buildSinceCursorMap,
  mergeTrendRowsByMetric,
} from "./image-ops-refresh-engine";

describe("image ops refresh engine", () => {
  it("builds deterministic since-cursor maps", () => {
    const cursors = buildSinceCursorMap({
      metricNames: ["queueBacklogLive", "queueWaitingLive", "unknown"],
      lastAtMsByMetric: {
        queueBacklogLive: 100,
        queueWaitingLive: 200,
      },
    });

    expect(cursors).toEqual({
      queueBacklogLive: 100,
      queueWaitingLive: 200,
      unknown: 0,
    });
  });

  it("merges per metric without starving lagging series", () => {
    const result = mergeTrendRowsByMetric({
      existing: {
        queueBacklogLive: [{ atMs: 5000, value: 20 }],
        queueWaitingLive: [{ atMs: 1000, value: 5 }],
      },
      incoming: {
        queueBacklogLive: [
          { atMs: 5000, value: 999 },
          { atMs: 6000, value: 21 },
        ],
        queueWaitingLive: [{ atMs: 2000, value: 6 }],
      },
      lastAtMsByMetric: {
        queueBacklogLive: 5000,
        queueWaitingLive: 1000,
      },
      maxPoints: 100,
    });

    expect(result.changed).toBe(true);
    expect(
      result.rowsByMetric.queueBacklogLive?.map((row) => row.atMs),
    ).toEqual([5000, 6000]);
    expect(
      result.rowsByMetric.queueWaitingLive?.map((row) => row.atMs),
    ).toEqual([1000, 2000]);
    expect(result.lastAtMsByMetric.queueBacklogLive).toBe(6000);
    expect(result.lastAtMsByMetric.queueWaitingLive).toBe(2000);
  });

  it("bounds memory per metric", () => {
    const result = mergeTrendRowsByMetric({
      existing: {
        queueBacklogLive: [
          { atMs: 1000, value: 1 },
          { atMs: 2000, value: 2 },
        ],
      },
      incoming: {
        queueBacklogLive: [
          { atMs: 3000, value: 3 },
          { atMs: 4000, value: 4 },
        ],
      },
      lastAtMsByMetric: {
        queueBacklogLive: 2000,
      },
      maxPoints: 3,
    });

    expect(
      result.rowsByMetric.queueBacklogLive?.map((row) => row.atMs),
    ).toEqual([2000, 3000, 4000]);
  });
});
