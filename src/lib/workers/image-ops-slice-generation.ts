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
  | "w5s"
  | "w15s"
  | "w1m"
  | "w15m"
  | "w60m"
  | "w24h"
  | "wDeep";

export type OpsMetricSliceValueType =
  | "low"
  | "high"
  | "avg"
  | "latest"
  | "sum"
  | "delta";

export type OpsMetricSlice = {
  low: number;
  high: number;
  avg: number;
  latest: number;
  sum: number;
  delta: number;
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

  const startIndex = rows.findIndex((row) => row.atMs >= input.windowStartMs);
  if (startIndex < 0) {
    return 0;
  }

  const windowMs = Math.max(1, input.nowMs - input.windowStartMs);
  // Carry a boundary baseline when the prior sample is no older than one full
  // window from the first in-window sample.
  const baselineGapMaxMs = windowMs;
  const firstInWindow = rows[startIndex];

  let previousValue = toFiniteNonNegative(firstInWindow?.value ?? 0);
  let cursor = startIndex + 1;

  // If a recent sample exists just before the window, use it as baseline so
  // low-frequency collectors (e.g. ~5s cadence) still produce a meaningful
  // 5s window delta without requiring 2 strict in-window points.
  if (startIndex > 0) {
    const beforeWindow = rows[startIndex - 1];
    const baselineGapMs = Math.max(
      0,
      Number(firstInWindow?.atMs ?? 0) - Number(beforeWindow?.atMs ?? 0),
    );
    if (baselineGapMs <= baselineGapMaxMs) {
      previousValue = toFiniteNonNegative(beforeWindow?.value ?? 0);
      cursor = startIndex;
    }
  }

  let delta = 0;
  let transitions = 0;

  for (let index = cursor; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row || row.atMs < input.windowStartMs) {
      continue;
    }

    const currentValue = toFiniteNonNegative(row.value);
    if (currentValue >= previousValue) {
      delta += currentValue - previousValue;
    } else {
      // Counter moved backward; ignore negative movement in window deltas.
      delta += 0;
    }
    previousValue = currentValue;
    transitions += 1;
  }

  if (transitions <= 0) {
    return 0;
  }

  return Math.max(0, Math.round(delta));
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
  const ips = Math.max(0, ipsFromWindow);

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
    return 0;
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
  counterSumAsDelta?: boolean;
}): OpsMetricSlice {
  const rows = sortedRows(input.rows, input.nowMs);
  const latestRow = rows[rows.length - 1];
  const safeWindowMs = Math.max(1000, Math.floor(input.windowMs));
  const startMs = input.nowMs - safeWindowMs;
  const latestMaxAgeMs = Number.isFinite(input.latestMaxAgeMs)
    ? Math.max(1, Math.floor(Number(input.latestMaxAgeMs)))
    : null;
  const latestInWindow = latestRow ? latestRow.atMs >= startMs : false;
  const latestIsFresh = latestRow
    ? latestMaxAgeMs === null || input.nowMs - latestRow.atMs <= latestMaxAgeMs
    : false;

  if (input.singleSampleOnly) {
    const liveValue =
      latestInWindow && latestIsFresh
        ? toFiniteNonNegative(latestRow?.value ?? 0)
        : 0;
    return {
      low: liveValue,
      high: liveValue,
      avg: liveValue,
      latest: liveValue,
      sum: liveValue,
      delta: 0,
      sampledAtMs: input.nowMs,
    };
  }

  const inWindow = rows.filter((row) => row.atMs >= startMs);

  if (inWindow.length <= 0) {
    return {
      low: 0,
      high: 0,
      avg: 0,
      latest: 0,
      sum: 0,
      delta: 0,
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

  const windowDelta = input.counterSumAsDelta
    ? computeCounterDeltaFromRows({
        rows: input.rows,
        windowStartMs: startMs,
        nowMs: input.nowMs,
      })
    : sum;
  const pointDelta = Math.max(0, high - low);

  return {
    low,
    high,
    avg: sum / inWindow.length,
    latest,
    sum: windowDelta,
    delta: pointDelta,
    sampledAtMs: input.nowMs,
  };
}

export function buildMetricSliceCacheFromTrendRows(input: {
  trendRowsByMetric: OpsTrendRowsByMetric;
  metricNames: readonly string[];
  nowMs: number;
  windowMsById: OpsMetricSliceWindowMsById;
  isLiveMetric?: (metricName: string) => boolean;
  liveSliceIds?: OpsMetricSliceId[];
  liveMetricMaxAgeMs?: number;
  resolveLiveMetricMaxAgeMs?: (metricName: string) => number | undefined;
  isCounterMetric?: (metricName: string) => boolean;
}): OpsMetricSliceCache {
  const isLiveMetric =
    input.isLiveMetric ?? ((metricName: string) => metricName.endsWith("Live"));
  const liveSliceIds = new Set<OpsMetricSliceId>(
    input.liveSliceIds ?? ["w5s", "w15s"],
  );
  const liveMetricMaxAgeMs = Number.isFinite(input.liveMetricMaxAgeMs)
    ? Math.max(1, Math.floor(Number(input.liveMetricMaxAgeMs)))
    : OPS_LIVE_METRIC_MAX_AGE_MS;
  const isCounterMetric = input.isCounterMetric ?? (() => false);
  const cache: OpsMetricSliceCache = {};

  const buildSliceForMetric = (
    metricName: string,
    sliceId: OpsMetricSliceId,
    windowMs: number,
    metricMaxAgeMs: number,
  ): OpsMetricSlice => {
    const singleSampleOnly =
      isLiveMetric(metricName) && liveSliceIds.has(sliceId);
    return computeMetricSliceFromRows({
      rows: input.trendRowsByMetric[metricName],
      nowMs: input.nowMs,
      windowMs,
      singleSampleOnly,
      latestMaxAgeMs: singleSampleOnly ? metricMaxAgeMs : undefined,
      counterSumAsDelta: isCounterMetric(metricName),
    });
  };

  for (const metricName of input.metricNames) {
    const resolvedMetricMaxAgeMs = isLiveMetric(metricName)
      ? input.resolveLiveMetricMaxAgeMs?.(metricName)
      : undefined;
    const metricMaxAgeMs = Number.isFinite(resolvedMetricMaxAgeMs)
      ? Math.max(1, Math.floor(Number(resolvedMetricMaxAgeMs)))
      : liveMetricMaxAgeMs;
    cache[metricName] = {
      w5s: buildSliceForMetric(
        metricName,
        "w5s",
        input.windowMsById.w5s,
        metricMaxAgeMs,
      ),
      w15s: buildSliceForMetric(
        metricName,
        "w15s",
        input.windowMsById.w15s,
        metricMaxAgeMs,
      ),
      w1m: buildSliceForMetric(
        metricName,
        "w1m",
        input.windowMsById.w1m,
        metricMaxAgeMs,
      ),
      w15m: buildSliceForMetric(
        metricName,
        "w15m",
        input.windowMsById.w15m,
        metricMaxAgeMs,
      ),
      w60m: buildSliceForMetric(
        metricName,
        "w60m",
        input.windowMsById.w60m,
        metricMaxAgeMs,
      ),
      w24h: buildSliceForMetric(
        metricName,
        "w24h",
        input.windowMsById.w24h,
        metricMaxAgeMs,
      ),
      wDeep: buildSliceForMetric(
        metricName,
        "wDeep",
        input.windowMsById.wDeep,
        metricMaxAgeMs,
      ),
    };
  }

  return cache;
}
