import { describe, expect, it } from "vitest";

import {
  chartMaxFromSeries,
  hasPositiveSignal,
  resampleSeriesForChart,
  rollingSeriesForChart,
  sanitizeNonNegativeSeries,
  selectDisplaySeries,
} from "./image-ops-graph-series";

describe("image ops graph series shaping", () => {
  it("sanitizes non-finite and negative values", () => {
    const values = sanitizeNonNegativeSeries([1, -1, Number.NaN, Infinity, 3]);
    expect(values).toEqual([1, 0, 0, 0, 3]);
  });

  it("preserves sparse peaks when downsampling large windows", () => {
    const source = Array.from({ length: 720 }, () => 0);
    source[73] = 24.4;
    source[511] = 12.2;

    const output = resampleSeriesForChart({
      values: source,
      targetPoints: 720,
      maxPoints: 240,
    });

    expect(output.length).toBe(240);
    expect(Math.max(...output)).toBeCloseTo(24.4, 6);
    expect(hasPositiveSignal(output)).toBe(true);
  });

  it("selects primary then secondary then fallback by positive signal", () => {
    const fallback = selectDisplaySeries({
      primary: [0, 0, 0],
      secondary: [0, 0, 0],
      fallback: [1, 2, 3],
      targetPoints: 6,
      maxPoints: 6,
    });
    expect(hasPositiveSignal(fallback)).toBe(true);

    const secondary = selectDisplaySeries({
      primary: [0, 0, 0],
      secondary: [5, 0, 1],
      fallback: [1, 1, 1],
      targetPoints: 6,
      maxPoints: 6,
    });
    expect(Math.max(...secondary)).toBeGreaterThanOrEqual(5);
  });

  it("keeps continuous chart as a stable rolling tail", () => {
    const source = Array.from({ length: 500 }, (_, index) => index + 1);
    const output = rollingSeriesForChart({
      values: source,
      targetPoints: 240,
      maxPoints: 240,
    });

    expect(output.length).toBe(240);
    expect(output[0]).toBe(261);
    expect(output[239]).toBe(500);
  });

  it("pads rolling series on the left when there are not enough samples", () => {
    const output = rollingSeriesForChart({
      values: [3, 5, 7],
      targetPoints: 6,
      maxPoints: 6,
    });

    expect(output).toEqual([0, 0, 0, 3, 5, 7]);
  });

  it("computes display max from percentile to reduce outlier domination", () => {
    const base = Array.from({ length: 200 }, () => 5);
    const spike = [...base, 1500];
    const maxValue = chartMaxFromSeries({
      seriesList: [spike],
      percentile: 0.98,
      minMax: 1,
    });

    expect(maxValue).toBe(5);
  });
});
