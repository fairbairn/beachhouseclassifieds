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

export type ImageMetricGroupCodeword = "images" | "jobs";

export type ImageSliceMetricDefinition = {
  group: ImageMetricGroupCodeword;
  slug: string;
};

export const IMAGE_SLICE_METRIC_REGISTRY: readonly ImageSliceMetricDefinition[] =
  [
    { group: "jobs", slug: "completed_jobs" },
    { group: "jobs", slug: "failed_jobs" },
    { group: "jobs", slug: "sampled_completed_jobs" },
    { group: "images", slug: "processed_items" },
    { group: "images", slug: "failed_items" },
    { group: "images", slug: "fetch_latency_ms_low" },
    { group: "images", slug: "fetch_latency_ms_high" },
    { group: "images", slug: "fetch_latency_ms_avg" },
    { group: "images", slug: "processing_latency_ms_low" },
    { group: "images", slug: "processing_latency_ms_high" },
    { group: "images", slug: "processing_latency_ms_avg" },
    { group: "images", slug: "storage_latency_ms_low" },
    { group: "images", slug: "storage_latency_ms_high" },
    { group: "images", slug: "storage_latency_ms_avg" },
    { group: "images", slug: "job_elapsed_ms_low" },
    { group: "images", slug: "job_elapsed_ms_high" },
    { group: "images", slug: "job_elapsed_ms_avg" },
    { group: "images", slug: "source_bytes_low" },
    { group: "images", slug: "source_bytes_high" },
    { group: "images", slug: "source_bytes_avg" },
    { group: "images", slug: "transformed_bytes_low" },
    { group: "images", slug: "transformed_bytes_high" },
    { group: "images", slug: "transformed_bytes_avg" },
    { group: "images", slug: "avg_fetch_ms" },
    { group: "images", slug: "avg_transform_ms" },
    { group: "images", slug: "avg_upload_ms" },
    { group: "images", slug: "avg_end_to_end_ms" },
    { group: "images", slug: "ips" },
    { group: "images", slug: "ipm" },
    { group: "images", slug: "sec_per_image" },
  ] as const;

export const IMAGE_IMAGE_PERFORMANCE_SLICE_METRIC_SLUGS =
  IMAGE_SLICE_METRIC_REGISTRY.filter((metric) => metric.group === "images").map(
    (metric) => metric.slug,
  );

export const IMAGE_JOB_SLICE_METRIC_SLUGS = IMAGE_SLICE_METRIC_REGISTRY.filter(
  (metric) => metric.group === "jobs",
).map((metric) => metric.slug);

// Back-compat export retained for existing imports. This now intentionally
// includes only image-processing performance metrics.
export const IMAGE_PERFORMANCE_SLICE_METRIC_SLUGS =
  IMAGE_IMAGE_PERFORMANCE_SLICE_METRIC_SLUGS;

type ImageSliceMetricRegistryEntry =
  (typeof IMAGE_SLICE_METRIC_REGISTRY)[number];

export type ImagePerformanceSliceMetricSlug = Extract<
  ImageSliceMetricRegistryEntry,
  { group: "images" }
>["slug"];

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
