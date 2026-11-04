export const IMAGE_METRICS_PREFIX = "image:ops:metrics";
export const IMAGE_TREND_PREFIX = `${IMAGE_METRICS_PREFIX}:trend`;
export const IMAGE_SLICE_PREFIX = `${IMAGE_METRICS_PREFIX}:slice`;
export const IMAGE_SLICE_METRIC_PREFIX = `${IMAGE_SLICE_PREFIX}:metric`;

export const IMAGE_RAW_JOB_TREND_PREFIX = `${IMAGE_TREND_PREFIX}:raw:jobs`;
export const IMAGE_RAW_JOB_TREND_CURSOR_KEY = `${IMAGE_RAW_JOB_TREND_PREFIX}:cursor:completed_at_ms`;

export const IMAGE_PERF_ROLLUPS_HASH_KEY = `${IMAGE_SLICE_PREFIX}:window:performance:rollups`;

export type ImageSliceWindowId = "15s" | "1m" | "15m" | "24h" | "deep";

export const IMAGE_SLICE_WINDOW_MS: Record<ImageSliceWindowId, number> = {
  "15s": 15 * 1000,
  "1m": 60 * 1000,
  "15m": 15 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  deep: 10 * 365 * 24 * 60 * 60 * 1000,
};

export const IMAGE_SLICE_WINDOWS: Array<{
  id: ImageSliceWindowId;
  ms: number;
}> = [
  { id: "15s", ms: IMAGE_SLICE_WINDOW_MS["15s"] },
  { id: "1m", ms: IMAGE_SLICE_WINDOW_MS["1m"] },
  { id: "15m", ms: IMAGE_SLICE_WINDOW_MS["15m"] },
  { id: "24h", ms: IMAGE_SLICE_WINDOW_MS["24h"] },
  { id: "deep", ms: IMAGE_SLICE_WINDOW_MS.deep },
];

export const IMAGE_SLICE_UPDATED_AT_FIELD = "updated_at";

export type ImageTrendScope = "runtime" | "snapshot";

const METRIC_SLUG_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

export function assertMetricSlug(metricSlug: string): void {
  if (!METRIC_SLUG_PATTERN.test(metricSlug)) {
    throw new Error(
      `Invalid metric slug: ${metricSlug}. Expected snake_case lowercase tokens.`,
    );
  }
}

export function imageTrendSeriesKey(
  scope: ImageTrendScope,
  metricSlug: string,
): string {
  assertMetricSlug(metricSlug);
  return `${IMAGE_TREND_PREFIX}:${scope}:${metricSlug}`;
}

export function imageRawJobTrendMetricIdsKey(metricSlug: string): string {
  assertMetricSlug(metricSlug);
  return `${IMAGE_RAW_JOB_TREND_PREFIX}:${metricSlug}:ids`;
}

export function imageRawJobTrendMetricValuesKey(metricSlug: string): string {
  assertMetricSlug(metricSlug);
  return `${IMAGE_RAW_JOB_TREND_PREFIX}:${metricSlug}:values`;
}

export function imageRawJobTrendMetricLatestKey(metricSlug: string): string {
  assertMetricSlug(metricSlug);
  return `${IMAGE_RAW_JOB_TREND_PREFIX}:${metricSlug}:latest`;
}

export function imageMetricSliceHashKey(metricSlug: string): string {
  assertMetricSlug(metricSlug);
  return `${IMAGE_SLICE_METRIC_PREFIX}:${metricSlug}`;
}

export function imageMetricSliceWindowField(
  windowId: ImageSliceWindowId,
): string {
  return `w_${windowId}`;
}
