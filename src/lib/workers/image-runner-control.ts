import type IORedis from "ioredis";

export const IMAGE_RUNNER_CONTROL_PREFIX = "image:runner:control";
export const IMAGE_RUNNER_SETTINGS_KEY = `${IMAGE_RUNNER_CONTROL_PREFIX}:settings`;
export const IMAGE_RUNNER_STATUS_KEY = `${IMAGE_RUNNER_CONTROL_PREFIX}:status`;

export type RunnerControlSettings = {
  flushIntervalMs: number;
  harvestEnabled: boolean;
};

export type RunnerStatusSnapshot = {
  operationId: string;
  mode: "running" | "idle" | "stopping" | "done" | "failed";
  claimedCount: number;
  queuedCount: number;
  completedJobs: number;
  failedJobs: number;
  processedItems: number;
  failedItems: number;
  queueWaiting: number;
  queueActive: number;
  queueCompleted: number;
  queueFailed: number;
  queueDelayed: number;
  queuePaused: number;
  queueBacklog: number;
  lastFlushAt: string | null;
  flushBatchCount: number;
  pendingSuccessBuffer: number;
  pendingErrorBuffer: number;
  updatedAt: string;
};

const DEFAULT_SETTINGS: RunnerControlSettings = {
  flushIntervalMs: 15_000,
  harvestEnabled: true,
};

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parseNonNegativeInt(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = Number.parseInt(String(value || "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value || "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

export function defaultRunnerControlSettings(): RunnerControlSettings {
  return { ...DEFAULT_SETTINGS };
}

export async function readRunnerControlSettings(
  redis: IORedis,
): Promise<RunnerControlSettings> {
  const values = await redis.hgetall(IMAGE_RUNNER_SETTINGS_KEY);
  return {
    flushIntervalMs: Math.max(
      1_000,
      Math.min(
        60_000,
        parsePositiveInt(
          values.flush_interval_ms,
          DEFAULT_SETTINGS.flushIntervalMs,
        ),
      ),
    ),
    harvestEnabled: parseBool(
      values.harvest_enabled,
      DEFAULT_SETTINGS.harvestEnabled,
    ),
  };
}

export async function writeRunnerControlSettings(
  redis: IORedis,
  settings: RunnerControlSettings,
): Promise<void> {
  await redis.hset(IMAGE_RUNNER_SETTINGS_KEY, {
    flush_interval_ms: String(settings.flushIntervalMs),
    harvest_enabled: settings.harvestEnabled ? "true" : "false",
    updated_at: new Date().toISOString(),
  });
}

export async function writeRunnerStatus(
  redis: IORedis,
  status: RunnerStatusSnapshot,
): Promise<void> {
  await redis.hset(IMAGE_RUNNER_STATUS_KEY, {
    operation_id: status.operationId,
    mode: status.mode,
    claimed_count: String(status.claimedCount),
    queued_count: String(status.queuedCount),
    completed_jobs: String(status.completedJobs),
    failed_jobs: String(status.failedJobs),
    processed_items: String(status.processedItems),
    failed_items: String(status.failedItems),
    queue_waiting: String(status.queueWaiting),
    queue_active: String(status.queueActive),
    queue_completed: String(status.queueCompleted),
    queue_failed: String(status.queueFailed),
    queue_delayed: String(status.queueDelayed),
    queue_paused: String(status.queuePaused),
    queue_backlog: String(status.queueBacklog),
    last_flush_at: status.lastFlushAt || "",
    flush_batch_count: String(status.flushBatchCount),
    pending_success_buffer: String(status.pendingSuccessBuffer),
    pending_error_buffer: String(status.pendingErrorBuffer),
    updated_at: status.updatedAt,
  });
}

export async function readRunnerStatus(
  redis: IORedis,
): Promise<RunnerStatusSnapshot | null> {
  const values = await redis.hgetall(IMAGE_RUNNER_STATUS_KEY);
  if (!values.operation_id) {
    return null;
  }

  return {
    operationId: values.operation_id,
    mode:
      values.mode === "running" ||
      values.mode === "idle" ||
      values.mode === "stopping" ||
      values.mode === "done" ||
      values.mode === "failed"
        ? values.mode
        : "idle",
    claimedCount: parseNonNegativeInt(values.claimed_count, 0),
    queuedCount: parseNonNegativeInt(values.queued_count, 0),
    completedJobs: parseNonNegativeInt(values.completed_jobs, 0),
    failedJobs: parseNonNegativeInt(values.failed_jobs, 0),
    processedItems: parseNonNegativeInt(values.processed_items, 0),
    failedItems: parseNonNegativeInt(values.failed_items, 0),
    queueWaiting: parseNonNegativeInt(values.queue_waiting, 0),
    queueActive: parseNonNegativeInt(values.queue_active, 0),
    queueCompleted: parseNonNegativeInt(values.queue_completed, 0),
    queueFailed: parseNonNegativeInt(values.queue_failed, 0),
    queueDelayed: parseNonNegativeInt(values.queue_delayed, 0),
    queuePaused: parseNonNegativeInt(values.queue_paused, 0),
    queueBacklog: parseNonNegativeInt(values.queue_backlog, 0),
    lastFlushAt: values.last_flush_at || null,
    flushBatchCount: parseNonNegativeInt(values.flush_batch_count, 0),
    pendingSuccessBuffer: parseNonNegativeInt(values.pending_success_buffer, 0),
    pendingErrorBuffer: parseNonNegativeInt(values.pending_error_buffer, 0),
    updatedAt: values.updated_at || new Date().toISOString(),
  };
}
