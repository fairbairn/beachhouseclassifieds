import {
  resampleSeriesForChart,
  rollingSeriesForChart,
} from "./image-ops-graph-series";
import {
  appendMetricHistory,
  metricWindowInterpolated,
  metricWindowStats,
  metricWindowValues,
  type MetricHistoryTable,
  type MetricWindowStats,
} from "./image-ops-metric-history";

export type TrendRow = {
  atMs: number;
  value: number;
};

export type TrendRowsByMetric = Record<string, TrendRow[]>;

export type OpsMetricState = {
  history: MetricHistoryTable;
  lastAtMsByMetric: Record<string, number>;
  maxPoints: number;
};

export type MetricGraphMode = "rolling" | "peak";

export type MetricPlotPoint = {
  atMs: number;
  value: number;
};

export type MetricGraphData = {
  points: number[];
  plotPoints: MetricPlotPoint[];
  low: number;
  high: number;
  startAtMs: number;
  endAtMs: number;
  pointCount: number;
  nonZeroCount: number;
  mode: MetricGraphMode;
};

export function createOpsMetricState(input?: {
  maxPoints?: number;
}): OpsMetricState {
  return {
    history: {},
    lastAtMsByMetric: {},
    maxPoints: Math.max(1, Math.floor(input?.maxPoints ?? 30_000)),
  };
}

export function resetOpsMetricState(state: OpsMetricState): void {
  state.history = {};
  state.lastAtMsByMetric = {};
}

export function ingestTrendRows(input: {
  state: OpsMetricState;
  trendRowsByMetric?: TrendRowsByMetric;
}): { appendedRows: number; touchedMetrics: number } {
  const rowsByMetric = input.trendRowsByMetric;
  if (!rowsByMetric) {
    return { appendedRows: 0, touchedMetrics: 0 };
  }

  let appendedRows = 0;
  let touchedMetrics = 0;

  for (const [metricName, rows] of Object.entries(rowsByMetric)) {
    const metricId = `snapshot.${metricName}`;
    const lastAtMs = input.state.lastAtMsByMetric[metricId] ?? 0;
    let maxAtMs = lastAtMs;
    let metricAppended = 0;

    for (const row of rows || []) {
      if (!Number.isFinite(row.atMs) || row.atMs <= lastAtMs) {
        continue;
      }
      appendMetricHistory({
        table: input.state.history,
        metricId,
        atMs: Number(row.atMs || 0),
        value: Number(row.value || 0),
        maxPoints: input.state.maxPoints,
      });
      metricAppended += 1;
      if (row.atMs > maxAtMs) {
        maxAtMs = row.atMs;
      }
    }

    input.state.lastAtMsByMetric[metricId] = maxAtMs;
    if (metricAppended > 0) {
      appendedRows += metricAppended;
      touchedMetrics += 1;
    }
  }

  return { appendedRows, touchedMetrics };
}

export function metricLatestFromState(input: {
  state: OpsMetricState;
  metricId: string;
}): { atMs: number; value: number } | null {
  const points = input.state.history[input.metricId]?.points ?? [];
  if (points.length <= 0) {
    return null;
  }

  const latest = points[points.length - 1];
  if (!latest) {
    return null;
  }

  return {
    atMs: Number(latest.atMs || 0),
    value: Number(latest.value || 0),
  };
}

export function metricPointCountFromState(input: {
  state: OpsMetricState;
  metricId: string;
}): number {
  return input.state.history[input.metricId]?.points.length ?? 0;
}

function metricTailInterpolated(input: {
  state: OpsMetricState;
  metricId: string;
  targetPoints: number;
}): number[] {
  const points = input.state.history[input.metricId]?.points ?? [];
  if (points.length <= 0) {
    return [];
  }

  const values = points.map((point) =>
    Number.isFinite(point.value) ? Number(point.value) : 0,
  );
  const target = Math.max(1, Math.floor(input.targetPoints));
  if (values.length <= target) {
    return values;
  }

  const output: number[] = [];
  const sourceLastIndex = values.length - 1;
  const targetLastIndex = target - 1;

  for (let index = 0; index < target; index += 1) {
    const ratio = targetLastIndex === 0 ? 0 : index / targetLastIndex;
    const sourceIndex = ratio * sourceLastIndex;
    const leftIndex = Math.floor(sourceIndex);
    const rightIndex = Math.min(sourceLastIndex, Math.ceil(sourceIndex));
    const left = values[leftIndex] ?? 0;
    const right = values[rightIndex] ?? left;
    if (leftIndex === rightIndex) {
      output.push(left);
      continue;
    }
    const blend = sourceIndex - leftIndex;
    output.push(left + (right - left) * blend);
  }

  return output;
}

export function metricGraphSeriesFromState(input: {
  state: OpsMetricState;
  metricId: string;
  nowMs: number;
  windowMs: number;
  targetPoints: number;
}): number[] {
  const windowSeries = metricWindowInterpolated({
    table: input.state.history,
    metricId: input.metricId,
    nowMs: input.nowMs,
    windowMs: input.windowMs,
    targetPoints: input.targetPoints,
  });
  if (windowSeries.length > 0) {
    return windowSeries;
  }

  return metricTailInterpolated({
    state: input.state,
    metricId: input.metricId,
    targetPoints: input.targetPoints,
  });
}

export function metricGraphDataFromState(input: {
  state: OpsMetricState;
  metricId: string;
  nowMs: number;
  windowMs: number;
  targetPoints: number;
  maxPoints?: number;
  mode?: MetricGraphMode;
}): MetricGraphData {
  const startAtMs = Math.max(0, input.nowMs - Math.max(1, input.windowMs));
  const endAtMs = Math.max(startAtMs, input.nowMs);
  const mode = input.mode ?? "rolling";
  const targetPoints = Math.max(1, Math.floor(input.targetPoints));
  const maxPoints =
    input.maxPoints !== undefined
      ? Math.max(1, Math.floor(input.maxPoints))
      : undefined;

  const windowValues = metricWindowValues({
    table: input.state.history,
    metricId: input.metricId,
    nowMs: input.nowMs,
    windowMs: input.windowMs,
  });

  const sourceValues =
    windowValues.length > 0
      ? windowValues
      : metricTailInterpolated({
          state: input.state,
          metricId: input.metricId,
          targetPoints,
        });

  const points =
    mode === "peak"
      ? resampleSeriesForChart({
          values: sourceValues,
          targetPoints,
          maxPoints,
        })
      : rollingSeriesForChart({
          values: sourceValues,
          targetPoints,
          maxPoints,
          fallbackValue: 0,
        });

  if (points.length <= 0) {
    return {
      points: [],
      plotPoints: [],
      low: 0,
      high: 0,
      startAtMs,
      endAtMs,
      pointCount: 0,
      nonZeroCount: 0,
      mode,
    };
  }

  let low = points[0] ?? 0;
  let high = points[0] ?? 0;
  for (const value of points) {
    if (value < low) {
      low = value;
    }
    if (value > high) {
      high = value;
    }
  }

  const intervalMs =
    points.length > 1
      ? Math.max(1, Math.floor((endAtMs - startAtMs) / (points.length - 1)))
      : 0;
  const plotPoints: MetricPlotPoint[] = points.map((value, index) => ({
    atMs: points.length <= 1 ? endAtMs : startAtMs + index * intervalMs,
    value,
  }));

  let nonZeroCount = 0;
  for (const point of points) {
    if (point > 0) {
      nonZeroCount += 1;
    }
  }

  return {
    points,
    plotPoints,
    low,
    high,
    startAtMs,
    endAtMs,
    pointCount: points.length,
    nonZeroCount,
    mode,
  };
}

export function metricWindowValuesFromState(input: {
  state: OpsMetricState;
  metricId: string;
  nowMs: number;
  windowMs: number;
}): number[] {
  return metricWindowValues({
    table: input.state.history,
    metricId: input.metricId,
    nowMs: input.nowMs,
    windowMs: input.windowMs,
  });
}

export function metricWindowStatsFromState(input: {
  state: OpsMetricState;
  metricId: string;
  nowMs: number;
  windowMs: number;
}): MetricWindowStats {
  return metricWindowStats({
    table: input.state.history,
    metricId: input.metricId,
    nowMs: input.nowMs,
    windowMs: input.windowMs,
  });
}
