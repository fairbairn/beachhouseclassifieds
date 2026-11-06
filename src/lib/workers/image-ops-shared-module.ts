import type { MetricWindowStats } from "./image-ops-metric-history";
import {
  buildSinceCursorMap,
  mergeTrendRowsByMetric,
  type TrendCursorByMetric,
} from "./image-ops-refresh-engine";
import {
  createOpsMetricState,
  ingestTrendRows,
  metricGraphDataFromState,
  metricGraphSeriesFromState,
  metricLatestFromState,
  metricPointCountFromState,
  metricWindowStatsFromState,
  metricWindowValuesFromState,
  resetOpsMetricState,
  type MetricGraphData,
  type MetricGraphMode,
  type OpsMetricState,
  type TrendRowsByMetric,
} from "./image-ops-shared-state";

export type OpsSharedModule = {
  ingestRefreshRows: (rowsByMetric: TrendRowsByMetric) => {
    changed: boolean;
    globalLastAtMs: number;
    appendedRows: number;
    touchedMetrics: number;
  };
  getSinceCursorMap: () => TrendCursorByMetric;
  getRowsByMetric: () => TrendRowsByMetric;
  getMetricLatest: (metricId: string) => { atMs: number; value: number } | null;
  getMetricPointCount: (metricId: string) => number;
  getMetricGraphSeries: (input: {
    metricId: string;
    nowMs: number;
    windowMs: number;
    targetPoints: number;
  }) => number[];
  getMetricGraphData: (input: {
    metricId: string;
    nowMs: number;
    windowMs: number;
    targetPoints: number;
    maxPoints?: number;
    mode?: MetricGraphMode;
  }) => MetricGraphData;
  getMetricWindowValues: (input: {
    metricId: string;
    nowMs: number;
    windowMs: number;
  }) => number[];
  getMetricWindowStats: (input: {
    metricId: string;
    nowMs: number;
    windowMs: number;
  }) => MetricWindowStats;
  getMetricSlices: (input: {
    metricId: string;
    nowMs: number;
    windows: Array<{ id: string; windowMs: number }>;
  }) => Array<{
    id: string;
    windowMs: number;
    stats: MetricWindowStats;
  }>;
  getMetricState: () => OpsMetricState;
  reset: () => void;
};

export function createOpsSharedModule(input: {
  metricNames: string[];
  maxPoints?: number;
}): OpsSharedModule {
  const metricNames = [...input.metricNames];
  let rowsByMetric: TrendRowsByMetric = {};
  let lastAtMsByMetric: TrendCursorByMetric = {};
  const metricState = createOpsMetricState({
    maxPoints: Math.max(1, Math.floor(input.maxPoints ?? 30_000)),
  });

  const ingestRefreshRows: OpsSharedModule["ingestRefreshRows"] = (
    incoming,
  ) => {
    const merged = mergeTrendRowsByMetric({
      existing: rowsByMetric,
      incoming,
      lastAtMsByMetric,
      maxPoints: metricState.maxPoints,
    });

    rowsByMetric = merged.rowsByMetric;
    lastAtMsByMetric = merged.lastAtMsByMetric;

    const ingested = ingestTrendRows({
      state: metricState,
      trendRowsByMetric: merged.rowsByMetric,
    });

    return {
      changed: merged.changed,
      globalLastAtMs: merged.globalLastAtMs,
      appendedRows: ingested.appendedRows,
      touchedMetrics: ingested.touchedMetrics,
    };
  };

  return {
    ingestRefreshRows,
    getSinceCursorMap: () =>
      buildSinceCursorMap({
        metricNames,
        lastAtMsByMetric,
      }),
    getRowsByMetric: () => rowsByMetric,
    getMetricLatest: (metricId) =>
      metricLatestFromState({ state: metricState, metricId }),
    getMetricPointCount: (metricId) =>
      metricPointCountFromState({ state: metricState, metricId }),
    getMetricGraphSeries: (graphInput) =>
      metricGraphSeriesFromState({
        state: metricState,
        metricId: graphInput.metricId,
        nowMs: graphInput.nowMs,
        windowMs: graphInput.windowMs,
        targetPoints: graphInput.targetPoints,
      }),
    getMetricGraphData: (graphInput) =>
      metricGraphDataFromState({
        state: metricState,
        metricId: graphInput.metricId,
        nowMs: graphInput.nowMs,
        windowMs: graphInput.windowMs,
        targetPoints: graphInput.targetPoints,
        maxPoints: graphInput.maxPoints,
        mode: graphInput.mode,
      }),
    getMetricWindowValues: (windowInput) =>
      metricWindowValuesFromState({
        state: metricState,
        metricId: windowInput.metricId,
        nowMs: windowInput.nowMs,
        windowMs: windowInput.windowMs,
      }),
    getMetricWindowStats: (windowInput) =>
      metricWindowStatsFromState({
        state: metricState,
        metricId: windowInput.metricId,
        nowMs: windowInput.nowMs,
        windowMs: windowInput.windowMs,
      }),
    getMetricSlices: (sliceInput) =>
      sliceInput.windows.map((window) => ({
        id: window.id,
        windowMs: window.windowMs,
        stats: metricWindowStatsFromState({
          state: metricState,
          metricId: sliceInput.metricId,
          nowMs: sliceInput.nowMs,
          windowMs: window.windowMs,
        }),
      })),
    getMetricState: () => metricState,
    reset: () => {
      rowsByMetric = {};
      lastAtMsByMetric = {};
      resetOpsMetricState(metricState);
    },
  };
}
