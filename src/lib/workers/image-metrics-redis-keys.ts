export const IMAGE_METRICS_PREFIX = "image:ops:metrics";
export const IMAGE_TREND_STORAGE = "trend";
export const IMAGE_SLICE_STORAGE = "slice";

export const IMAGE_GROUP_JOBS = "jobs";
export const IMAGE_GROUP_INFRA = "infra";
export const IMAGE_GROUP_IMAGES = "images";
export const IMAGE_GROUP_QUEUE = "queue";
export const IMAGE_GROUP_DB = "db";

// Back-compat aliases for existing callsites and imports.
export const IMAGE_GROUP_RUNTIME = IMAGE_GROUP_QUEUE;
export const IMAGE_GROUP_SNAPSHOT = IMAGE_GROUP_DB;
export const IMAGE_GROUP_PERFORMANCE = IMAGE_GROUP_IMAGES;
export const IMAGE_GROUP_RAW_JOBS = IMAGE_GROUP_JOBS;

// Legacy aliases retained for existing imports.
export const IMAGE_TREND_PREFIX = IMAGE_METRICS_PREFIX;
export const IMAGE_SLICE_PREFIX = IMAGE_METRICS_PREFIX;
export const IMAGE_SLICE_METRIC_PREFIX = `${IMAGE_METRICS_PREFIX}:${IMAGE_GROUP_PERFORMANCE}`;

export const IMAGE_RAW_JOB_TREND_PREFIX = `${IMAGE_METRICS_PREFIX}:${IMAGE_GROUP_RAW_JOBS}`;
export const IMAGE_RAW_JOB_TREND_CURSOR_KEY = `${IMAGE_RAW_JOB_TREND_PREFIX}:cursor:completed_at_ms`;

export const IMAGE_PERF_ROLLUPS_HASH_KEY = `${IMAGE_METRICS_PREFIX}:${IMAGE_GROUP_PERFORMANCE}:rollups:${IMAGE_SLICE_STORAGE}`;

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

export type ImageTrendPointPayload = {
  atMs: number;
  value: number;
  id?: string;
};

export type ImageSliceWindowPayload = {
  timestamp: string;
  low: number;
  high: number;
  average: number;
  latest: number;
};

export type ImageTrendScope = "runtime" | "snapshot";

const METRIC_SLUG_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
const GROUP_CODEWORD_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

export function assertMetricSlug(metricSlug: string): void {
  if (!METRIC_SLUG_PATTERN.test(metricSlug)) {
    throw new Error(
      `Invalid metric slug: ${metricSlug}. Expected snake_case lowercase tokens.`,
    );
  }
}

export function assertGroupCodeword(groupCodeword: string): void {
  if (!GROUP_CODEWORD_PATTERN.test(groupCodeword)) {
    throw new Error(
      `Invalid group codeword: ${groupCodeword}. Expected snake_case lowercase tokens.`,
    );
  }
}

export function imageMetricTrendKey(
  groupCodeword: string,
  metricSlug: string,
): string {
  assertGroupCodeword(groupCodeword);
  assertMetricSlug(metricSlug);
  return `${IMAGE_METRICS_PREFIX}:${groupCodeword}:${metricSlug}:${IMAGE_TREND_STORAGE}`;
}

export function imageTrendSeriesKey(
  scope: ImageTrendScope,
  metricSlug: string,
): string {
  const groupCodeword =
    scope === "runtime" ? IMAGE_GROUP_RUNTIME : IMAGE_GROUP_SNAPSHOT;
  return imageMetricTrendKey(groupCodeword, metricSlug);
}

export function imageRawJobTrendMetricKey(metricSlug: string): string {
  return imageMetricTrendKey(IMAGE_GROUP_RAW_JOBS, metricSlug);
}

export function imageMetricSliceHashKey(
  metricSlug: string,
  groupCodeword = IMAGE_GROUP_PERFORMANCE,
): string {
  assertGroupCodeword(groupCodeword);
  assertMetricSlug(metricSlug);
  return `${IMAGE_METRICS_PREFIX}:${groupCodeword}:${metricSlug}:${IMAGE_SLICE_STORAGE}`;
}

export function imageMetricSliceWindowField(
  windowId: ImageSliceWindowId,
): string {
  return `w_${windowId}`;
}

export function encodeImageTrendPoint(payload: ImageTrendPointPayload): string {
  return JSON.stringify({
    atMs: Number.isFinite(payload.atMs) ? Math.floor(payload.atMs) : 0,
    value: Number.isFinite(payload.value) ? payload.value : 0,
    ...(payload.id ? { id: payload.id } : {}),
  });
}

export function parseImageTrendPoint(
  member: string,
): ImageTrendPointPayload | null {
  try {
    const parsed = JSON.parse(member) as {
      atMs?: unknown;
      value?: unknown;
      id?: unknown;
    };
    const atMs = Number(parsed.atMs);
    const value = Number(parsed.value);
    if (!Number.isFinite(value)) {
      return null;
    }
    return {
      atMs: Number.isFinite(atMs) ? Math.floor(atMs) : 0,
      value,
      id: typeof parsed.id === "string" ? parsed.id : undefined,
    };
  } catch {
    const numeric = Number(member);
    if (!Number.isFinite(numeric)) {
      return null;
    }
    return {
      atMs: 0,
      value: numeric,
    };
  }
}

export function encodeImageSliceWindowPayload(
  payload: ImageSliceWindowPayload,
): string {
  return JSON.stringify({
    timestamp: payload.timestamp,
    low: Number.isFinite(payload.low) ? payload.low : 0,
    high: Number.isFinite(payload.high) ? payload.high : 0,
    average: Number.isFinite(payload.average) ? payload.average : 0,
    latest: Number.isFinite(payload.latest) ? payload.latest : 0,
  });
}
