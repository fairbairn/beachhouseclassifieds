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

export const IMAGE_PERFORMANCE_SLICE_METRIC_SLUGS = [
  "completed_jobs",
  "failed_jobs",
  "processed_items",
  "failed_items",
  "sampled_completed_jobs",
  "fetch_latency_ms_low",
  "fetch_latency_ms_high",
  "fetch_latency_ms_avg",
  "processing_latency_ms_low",
  "processing_latency_ms_high",
  "processing_latency_ms_avg",
  "storage_latency_ms_low",
  "storage_latency_ms_high",
  "storage_latency_ms_avg",
  "job_elapsed_ms_low",
  "job_elapsed_ms_high",
  "job_elapsed_ms_avg",
  "source_bytes_low",
  "source_bytes_high",
  "source_bytes_avg",
  "transformed_bytes_low",
  "transformed_bytes_high",
  "transformed_bytes_avg",
  "avg_fetch_ms",
  "avg_transform_ms",
  "avg_upload_ms",
  "avg_end_to_end_ms",
  "ips",
  "ipm",
  "sec_per_image",
] as const;

export type ImagePerformanceSliceMetricSlug =
  (typeof IMAGE_PERFORMANCE_SLICE_METRIC_SLUGS)[number];

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
