import {
  IMAGE_SLICE_WINDOWS,
  imageMetricSliceHashKey,
  imageMetricSliceWindowField,
  type ImageSliceWindowId,
} from "./image-metrics-redis-keys";

export type ImageMetricSourceKind =
  | "bullmq_raw_job"
  | "runner_status"
  | "snapshot"
  | "event"
  | "sampling";

export type ImageMetricTrendAggregation =
  | "latest"
  | "sum"
  | "avg"
  | "count"
  | "minmaxavg";

export type ImageMetricSliceAggregation =
  | "latest"
  | "sum"
  | "avg"
  | "count"
  | "minmaxavg";

export type ImageMetricDefinition = {
  slug: string;
  sourceKind: ImageMetricSourceKind;
  description: string;
  trendAggregation: ImageMetricTrendAggregation;
  sliceAggregation: ImageMetricSliceAggregation;
  windows: ImageSliceWindowId[];
  trendEnabled: boolean;
  sliceEnabled: boolean;
};

export const IMAGE_METRIC_DEFAULT_WINDOWS = IMAGE_SLICE_WINDOWS.map(
  (window) => window.id,
);

export function normalizeMetricWindows(
  windows: ImageSliceWindowId[] | undefined,
): ImageSliceWindowId[] {
  if (!Array.isArray(windows) || windows.length === 0) {
    return [...IMAGE_METRIC_DEFAULT_WINDOWS];
  }
  const ordered: ImageSliceWindowId[] = [];
  for (const candidate of IMAGE_METRIC_DEFAULT_WINDOWS) {
    if (windows.includes(candidate)) {
      ordered.push(candidate);
    }
  }
  return ordered;
}

export function buildMetricSliceContract(metricSlug: string): {
  key: string;
  windowFields: Record<ImageSliceWindowId, string>;
} {
  return {
    key: imageMetricSliceHashKey(metricSlug),
    windowFields: {
      "15s": imageMetricSliceWindowField("15s"),
      "1m": imageMetricSliceWindowField("1m"),
      "15m": imageMetricSliceWindowField("15m"),
      "24h": imageMetricSliceWindowField("24h"),
      deep: imageMetricSliceWindowField("deep"),
    },
  };
}
