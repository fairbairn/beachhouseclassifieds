export type OpsSliceWindowId = "15s" | "1m" | "15m" | "60m" | "24h" | "deep";

export type OpsTrendRow = {
  atMs: number;
  value: number;
};

export type OpsTrendRowsByMetric = Record<string, OpsTrendRow[] | undefined>;

export type OpsPerformanceRollupLike = {
  windowId: OpsSliceWindowId;
  windowMs: number;
  completedJobs: number;
  failedJobs: number;
  processedItems: number;
  failedItems: number;
  sampledCompletedJobs: number;
  metricFetchLatencyMsLow: number;
  metricFetchLatencyMsHigh: number;
  metricFetchLatencyMsAvg: number;
  metricProcessingLatencyMsLow: number;
  metricProcessingLatencyMsHigh: number;
  metricProcessingLatencyMsAvg: number;
  metricStorageLatencyMsLow: number;
  metricStorageLatencyMsHigh: number;
  metricStorageLatencyMsAvg: number;
  metricJobElapsedMsLow: number;
  metricJobElapsedMsHigh: number;
  metricJobElapsedMsAvg: number;
  metricSourceBytesLow: number;
  metricSourceBytesHigh: number;
  metricSourceBytesAvg: number;
  metricTransformedBytesLow: number;
  metricTransformedBytesHigh: number;
  metricTransformedBytesAvg: number;
  avgFetchMs: number;
  avgTransformMs: number;
  avgUploadMs: number;
  avgEndToEndMs: number;
  ips: number;
  ipm: number;
  secPerImage: number | null;
  computedAt: string;
};

export type OpsPerformanceRollupSetLike = {
  rollup15s: OpsPerformanceRollupLike;
  rollup1m: OpsPerformanceRollupLike;
  rollup15m: OpsPerformanceRollupLike;
  rollup60m: OpsPerformanceRollupLike;
  rollup24h: OpsPerformanceRollupLike;
  rollupDeep: OpsPerformanceRollupLike;
};

export type OpsQueueWindowSummary = {
  pending: number;
  active: number;
};

export type OpsQueueWindowAverages = {
  w15s: OpsQueueWindowSummary;
  w1m: OpsQueueWindowSummary;
  w15m: OpsQueueWindowSummary;
  w60m: OpsQueueWindowSummary;
  w24h: OpsQueueWindowSummary;
};

export type OpsMetricSliceId =
  | "w15s"
  | "w1m"
  | "w15m"
  | "w60m"
  | "w24h"
  | "wDeep";

export type OpsMetricSliceValueType = "low" | "high" | "avg" | "latest";

export type OpsMetricSlice = {
  low: number;
  high: number;
  avg: number;
  latest: number;
  sampledAtMs: number;
};

export type OpsMetricSliceWindowMap = Record<OpsMetricSliceId, OpsMetricSlice>;

export type OpsMetricSliceCache = Record<string, OpsMetricSliceWindowMap>;

export type OpsMetricSliceWindowMsById = Record<OpsMetricSliceId, number>;

const OPS_LIVE_METRIC_MAX_AGE_MS = 15_000;

type OpsMetricStats = {
  low: number;
  high: number;
  avg: number;
  count: number;
};

function toFiniteNonNegative(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return 0;
  }
  return numeric;
}

function sortedRows(
  rows: OpsTrendRow[] | undefined,
  nowMs: number,
): Array<{ atMs: number; value: number }> {
  return (rows ?? [])
    .map((row) => ({ atMs: Number(row.atMs), value: Number(row.value) }))
    .filter(
      (row) =>
        Number.isFinite(row.atMs) &&
        Number.isFinite(row.value) &&
        row.atMs <= nowMs,
    )
    .sort((left, right) => left.atMs - right.atMs);
}

function computeCounterDeltaFromRows(input: {
  rows: OpsTrendRow[] | undefined;
  windowStartMs: number;
  nowMs: number;
}): number {
  const rows = sortedRows(input.rows, input.nowMs);
  if (rows.length <= 0) {
    return 0;
  }

  const latest = rows[rows.length - 1];
  if (!latest || latest.atMs < input.windowStartMs) {
    return 0;
  }

  let baseline = rows[0]?.value ?? 0;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row.atMs < input.windowStartMs) {
      baseline = row.value;
      break;
    }
    baseline = row.value;
  }

  const delta = toFiniteNonNegative(latest.value - baseline);
  return Math.round(delta);
}

function computeStatsFromRows(input: {
  rows: OpsTrendRow[] | undefined;
  windowStartMs: number;
  nowMs: number;
}): OpsMetricStats {
  const values = sortedRows(input.rows, input.nowMs)
    .filter((row) => row.atMs >= input.windowStartMs)
    .map((row) => toFiniteNonNegative(row.value));

  if (values.length <= 0) {
    return { low: 0, high: 0, avg: 0, count: 0 };
  }

  let low = values[0] ?? 0;
  let high = values[0] ?? 0;
  let sum = 0;
  for (const value of values) {
    low = Math.min(low, value);
    high = Math.max(high, value);
    sum += value;
  }

  return {
    low,
    high,
    avg: sum / values.length,
    count: values.length,
  };
}

export function buildPerformanceRollupFromTrendRows(input: {
  windowId: OpsSliceWindowId;
  windowMs: number;
  nowMs: number;
  computedAtIso: string;
  trendRowsByMetric: OpsTrendRowsByMetric;
}): OpsPerformanceRollupLike {
  const safeWindowMs = Math.max(1000, Math.floor(input.windowMs));
  const windowStartMs = input.nowMs - safeWindowMs;

  const completedJobs = computeCounterDeltaFromRows({
    rows: input.trendRowsByMetric.statusCompletedJobs,
    windowStartMs,
    nowMs: input.nowMs,
  });
  const failedJobs = computeCounterDeltaFromRows({
    rows: input.trendRowsByMetric.statusFailedJobs,
    windowStartMs,
    nowMs: input.nowMs,
  });
  const processedItems = computeCounterDeltaFromRows({
    rows: input.trendRowsByMetric.statusProcessedItems,
    windowStartMs,
    nowMs: input.nowMs,
  });
  const failedItems = computeCounterDeltaFromRows({
    rows: input.trendRowsByMetric.statusFailedItems,
    windowStartMs,
    nowMs: input.nowMs,
  });

  const fetchStats = computeStatsFromRows({
    rows: input.trendRowsByMetric.avgFetchMs,
    windowStartMs,
    nowMs: input.nowMs,
  });
  const transformStats = computeStatsFromRows({
    rows: input.trendRowsByMetric.avgTransformMs,
    windowStartMs,
    nowMs: input.nowMs,
  });
  const uploadStats = computeStatsFromRows({
    rows: input.trendRowsByMetric.avgUploadMs,
    windowStartMs,
    nowMs: input.nowMs,
  });
  const elapsedStats = computeStatsFromRows({
    rows: input.trendRowsByMetric.avgEndToEndMs,
    windowStartMs,
    nowMs: input.nowMs,
  });

  const avgFetchMs = Math.round(fetchStats.avg);
  const avgTransformMs = Math.round(transformStats.avg);
  const avgUploadMs = Math.round(uploadStats.avg);
  const avgEndToEndMs = Math.round(elapsedStats.avg);

  const windowSeconds = Math.max(1, Math.floor(safeWindowMs / 1000));
  const ipsFromWindow = processedItems / windowSeconds;
  const ipsFromLatency = avgEndToEndMs > 0 ? 1000 / avgEndToEndMs : 0;
  const ips = Math.max(0, ipsFromWindow, ipsFromLatency);

  return {
    windowId: input.windowId,
    windowMs: safeWindowMs,
    completedJobs,
    failedJobs,
    processedItems,
    failedItems,
    sampledCompletedJobs: Math.max(completedJobs, fetchStats.count),
    metricFetchLatencyMsLow: Math.round(fetchStats.low),
    metricFetchLatencyMsHigh: Math.round(fetchStats.high),
    metricFetchLatencyMsAvg: avgFetchMs,
    metricProcessingLatencyMsLow: Math.round(transformStats.low),
    metricProcessingLatencyMsHigh: Math.round(transformStats.high),
    metricProcessingLatencyMsAvg: avgTransformMs,
    metricStorageLatencyMsLow: Math.round(uploadStats.low),
    metricStorageLatencyMsHigh: Math.round(uploadStats.high),
    metricStorageLatencyMsAvg: avgUploadMs,
    metricJobElapsedMsLow: Math.round(elapsedStats.low),
    metricJobElapsedMsHigh: Math.round(elapsedStats.high),
    metricJobElapsedMsAvg: avgEndToEndMs,
    metricSourceBytesLow: 0,
    metricSourceBytesHigh: 0,
    metricSourceBytesAvg: 0,
    metricTransformedBytesLow: 0,
    metricTransformedBytesHigh: 0,
    metricTransformedBytesAvg: 0,
    avgFetchMs,
    avgTransformMs,
    avgUploadMs,
    avgEndToEndMs,
    ips,
    ipm: ips * 60,
    secPerImage: ips > 0 ? 1 / ips : null,
    computedAt: input.computedAtIso,
  };
}

export function buildPerformanceRollupSetFromTrendRows(input: {
  nowMs: number;
  computedAtIso: string;
  trendRowsByMetric: OpsTrendRowsByMetric;
  windowMsById: {
    w15s: number;
    w1m: number;
    w15m: number;
    w60m: number;
    w24h: number;
    deep: number;
  };
}): OpsPerformanceRollupSetLike {
  return {
    rollup15s: buildPerformanceRollupFromTrendRows({
      windowId: "15s",
      windowMs: input.windowMsById.w15s,
      nowMs: input.nowMs,
      computedAtIso: input.computedAtIso,
      trendRowsByMetric: input.trendRowsByMetric,
    }),
    rollup1m: buildPerformanceRollupFromTrendRows({
      windowId: "1m",
      windowMs: input.windowMsById.w1m,
      nowMs: input.nowMs,
      computedAtIso: input.computedAtIso,
      trendRowsByMetric: input.trendRowsByMetric,
    }),
    rollup15m: buildPerformanceRollupFromTrendRows({
      windowId: "15m",
      windowMs: input.windowMsById.w15m,
      nowMs: input.nowMs,
      computedAtIso: input.computedAtIso,
      trendRowsByMetric: input.trendRowsByMetric,
    }),
    rollup60m: buildPerformanceRollupFromTrendRows({
      windowId: "60m",
      windowMs: input.windowMsById.w60m,
      nowMs: input.nowMs,
      computedAtIso: input.computedAtIso,
      trendRowsByMetric: input.trendRowsByMetric,
    }),
    rollup24h: buildPerformanceRollupFromTrendRows({
      windowId: "24h",
      windowMs: input.windowMsById.w24h,
      nowMs: input.nowMs,
      computedAtIso: input.computedAtIso,
      trendRowsByMetric: input.trendRowsByMetric,
    }),
    rollupDeep: buildPerformanceRollupFromTrendRows({
      windowId: "deep",
      windowMs: input.windowMsById.deep,
      nowMs: input.nowMs,
      computedAtIso: input.computedAtIso,
      trendRowsByMetric: input.trendRowsByMetric,
    }),
  };
}

function computeGaugeAverageFromRows(input: {
  rows: OpsTrendRow[] | undefined;
  nowMs: number;
  windowMs: number;
}): number {
  const safeWindowMs = Math.max(1000, Math.floor(input.windowMs));
  const startMs = input.nowMs - safeWindowMs;
  const rows = sortedRows(input.rows, input.nowMs);
  const samples = rows.filter((row) => row.atMs >= startMs);

  if (samples.length <= 0) {
    const latest = rows[rows.length - 1];
    return latest ? toFiniteNonNegative(latest.value) : 0;
  }

  let sum = 0;
  for (const sample of samples) {
    sum += toFiniteNonNegative(sample.value);
  }
  return sum / samples.length;
}

export function buildQueueWindowSummaryFromTrendRows(input: {
  trendRowsByMetric: OpsTrendRowsByMetric;
  nowMs: number;
  windowMs: number;
}): OpsQueueWindowSummary {
  const waiting = computeGaugeAverageFromRows({
    rows: input.trendRowsByMetric.queueWaitingLive,
    nowMs: input.nowMs,
    windowMs: input.windowMs,
  });
  const delayed = computeGaugeAverageFromRows({
    rows: input.trendRowsByMetric.queueDelayedLive,
    nowMs: input.nowMs,
    windowMs: input.windowMs,
  });
  const paused = computeGaugeAverageFromRows({
    rows: input.trendRowsByMetric.queuePausedLive,
    nowMs: input.nowMs,
    windowMs: input.windowMs,
  });
  const active = computeGaugeAverageFromRows({
    rows: input.trendRowsByMetric.queueActiveLive,
    nowMs: input.nowMs,
    windowMs: input.windowMs,
  });

  return {
    pending: Math.max(0, Math.round(waiting + delayed + paused)),
    active: Math.max(0, Math.round(active)),
  };
}

export function buildQueueWindowAveragesFromTrendRows(input: {
  trendRowsByMetric: OpsTrendRowsByMetric;
  nowMs: number;
}): OpsQueueWindowAverages {
  return {
    w15s: buildQueueWindowSummaryFromTrendRows({
      trendRowsByMetric: input.trendRowsByMetric,
      nowMs: input.nowMs,
      windowMs: 15 * 1000,
    }),
    w1m: buildQueueWindowSummaryFromTrendRows({
      trendRowsByMetric: input.trendRowsByMetric,
      nowMs: input.nowMs,
      windowMs: 60 * 1000,
    }),
    w15m: buildQueueWindowSummaryFromTrendRows({
      trendRowsByMetric: input.trendRowsByMetric,
      nowMs: input.nowMs,
      windowMs: 15 * 60 * 1000,
    }),
    w60m: buildQueueWindowSummaryFromTrendRows({
      trendRowsByMetric: input.trendRowsByMetric,
      nowMs: input.nowMs,
      windowMs: 60 * 60 * 1000,
    }),
    w24h: buildQueueWindowSummaryFromTrendRows({
      trendRowsByMetric: input.trendRowsByMetric,
      nowMs: input.nowMs,
      windowMs: 24 * 60 * 60 * 1000,
    }),
  };
}

function computeMetricSliceFromRows(input: {
  rows: OpsTrendRow[] | undefined;
  nowMs: number;
  windowMs: number;
  singleSampleOnly?: boolean;
  latestMaxAgeMs?: number;
}): OpsMetricSlice {
  const rows = sortedRows(input.rows, input.nowMs);
  const latestRow = rows[rows.length - 1];
  const latestMaxAgeMs = Number.isFinite(input.latestMaxAgeMs)
    ? Math.max(1, Math.floor(Number(input.latestMaxAgeMs)))
    : null;
  const latestIsFresh = latestRow
    ? latestMaxAgeMs === null || input.nowMs - latestRow.atMs <= latestMaxAgeMs
    : false;

  if (input.singleSampleOnly) {
    const liveValue = latestIsFresh
      ? toFiniteNonNegative(latestRow?.value ?? 0)
      : 0;
    return {
      low: liveValue,
      high: liveValue,
      avg: liveValue,
      latest: liveValue,
      sampledAtMs: input.nowMs,
    };
  }

  const safeWindowMs = Math.max(1000, Math.floor(input.windowMs));
  const startMs = input.nowMs - safeWindowMs;
  const inWindow = rows.filter((row) => row.atMs >= startMs);

  if (inWindow.length <= 0) {
    return {
      low: 0,
      high: 0,
      avg: 0,
      latest: 0,
      sampledAtMs: input.nowMs,
    };
  }

  let low = toFiniteNonNegative(inWindow[0]?.value ?? 0);
  let high = low;
  let sum = 0;
  let latest = low;
  for (const row of inWindow) {
    const value = toFiniteNonNegative(row.value);
    low = Math.min(low, value);
    high = Math.max(high, value);
    sum += value;
    latest = value;
  }

  return {
    low,
    high,
    avg: sum / inWindow.length,
    latest,
    sampledAtMs: input.nowMs,
  };
}

export function buildMetricSliceCacheFromTrendRows(input: {
  trendRowsByMetric: OpsTrendRowsByMetric;
  metricNames: readonly string[];
  nowMs: number;
  windowMsById: OpsMetricSliceWindowMsById;
  isLiveMetric?: (metricName: string) => boolean;
  liveMetricMaxAgeMs?: number;
  resolveLiveMetricMaxAgeMs?: (metricName: string) => number | undefined;
}): OpsMetricSliceCache {
  const isLiveMetric =
    input.isLiveMetric ?? ((metricName: string) => metricName.endsWith("Live"));
  const liveMetricMaxAgeMs = Number.isFinite(input.liveMetricMaxAgeMs)
    ? Math.max(1, Math.floor(Number(input.liveMetricMaxAgeMs)))
    : OPS_LIVE_METRIC_MAX_AGE_MS;
  const cache: OpsMetricSliceCache = {};
  for (const metricName of input.metricNames) {
    const singleSampleOnly = isLiveMetric(metricName);
    const resolvedMetricMaxAgeMs = singleSampleOnly
      ? input.resolveLiveMetricMaxAgeMs?.(metricName)
      : undefined;
    const metricMaxAgeMs = Number.isFinite(resolvedMetricMaxAgeMs)
      ? Math.max(1, Math.floor(Number(resolvedMetricMaxAgeMs)))
      : liveMetricMaxAgeMs;
    cache[metricName] = {
      w15s: computeMetricSliceFromRows({
        rows: input.trendRowsByMetric[metricName],
        nowMs: input.nowMs,
        windowMs: input.windowMsById.w15s,
        singleSampleOnly,
        latestMaxAgeMs: singleSampleOnly ? metricMaxAgeMs : undefined,
      }),
      w1m: computeMetricSliceFromRows({
        rows: input.trendRowsByMetric[metricName],
        nowMs: input.nowMs,
        windowMs: input.windowMsById.w1m,
        singleSampleOnly,
        latestMaxAgeMs: singleSampleOnly ? metricMaxAgeMs : undefined,
      }),
      w15m: computeMetricSliceFromRows({
        rows: input.trendRowsByMetric[metricName],
        nowMs: input.nowMs,
        windowMs: input.windowMsById.w15m,
        singleSampleOnly,
        latestMaxAgeMs: singleSampleOnly ? metricMaxAgeMs : undefined,
      }),
      w60m: computeMetricSliceFromRows({
        rows: input.trendRowsByMetric[metricName],
        nowMs: input.nowMs,
        windowMs: input.windowMsById.w60m,
        singleSampleOnly,
        latestMaxAgeMs: singleSampleOnly ? metricMaxAgeMs : undefined,
      }),
      w24h: computeMetricSliceFromRows({
        rows: input.trendRowsByMetric[metricName],
        nowMs: input.nowMs,
        windowMs: input.windowMsById.w24h,
        singleSampleOnly,
        latestMaxAgeMs: singleSampleOnly ? metricMaxAgeMs : undefined,
      }),
      wDeep: computeMetricSliceFromRows({
        rows: input.trendRowsByMetric[metricName],
        nowMs: input.nowMs,
        windowMs: input.windowMsById.wDeep,
        singleSampleOnly,
        latestMaxAgeMs: singleSampleOnly ? metricMaxAgeMs : undefined,
      }),
    };
  }
  return cache;
}
