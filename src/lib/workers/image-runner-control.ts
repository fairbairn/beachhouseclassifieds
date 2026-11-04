import type IORedis from "ioredis";

export const IMAGE_RUNNER_CONTROL_PREFIX = "image:runner:control";
export const IMAGE_RUNNER_SETTINGS_KEY = `${IMAGE_RUNNER_CONTROL_PREFIX}:settings`;
export const IMAGE_RUNNER_STATUS_KEY = `${IMAGE_RUNNER_CONTROL_PREFIX}:status`;
export const IMAGE_RUNNER_INFRA_KEY = `${IMAGE_RUNNER_CONTROL_PREFIX}:infra`;

export type RunnerDesiredMode = "run" | "idle" | "drain" | "stop";

export type RunnerControlSettings = {
  desiredMode: RunnerDesiredMode;
  enqueueEnabled: boolean;
  requireWorkersForEnqueue: boolean;
  minWorkersToEnqueue: number;
  maxQueueBacklog: number;
  refillLowWatermark: number;
  refillTargetBacklog: number;
  maxClaimPerCycle: number;
  flushIntervalMs: number;
  harvestEnabled: boolean;
};

export type RunnerInfraSnapshot = {
  workersRunning: number;
  source: string;
  updatedAt: string;
};

export type RunnerStatusSnapshot = {
  operationId: string;
  mode: "running" | "idle" | "stopping" | "done" | "failed";
  desiredMode: RunnerDesiredMode;
  gateReason: string;
  workersRunning: number;
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
  throughputImagesPerMinute: number;
  avgFetchMs: number;
  avgTransformMs: number;
  avgUploadMs: number;
  avgEndToEndMs: number;
  updatedAt: string;
};

const DEFAULT_SETTINGS: RunnerControlSettings = {
  desiredMode: "run",
  enqueueEnabled: true,
  requireWorkersForEnqueue: true,
  minWorkersToEnqueue: 1,
  maxQueueBacklog: 240,
  refillLowWatermark: 120,
  refillTargetBacklog: 180,
  maxClaimPerCycle: 40,
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

function parseNonNegativeNumber(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = Number.parseFloat(String(value || "").trim());
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function parseRunnerDesiredMode(
  value: string | undefined,
  fallback: RunnerDesiredMode,
): RunnerDesiredMode {
  if (!value) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "run" ||
    normalized === "idle" ||
    normalized === "drain" ||
    normalized === "stop"
  ) {
    return normalized;
  }
  return fallback;
}

export function defaultRunnerControlSettings(): RunnerControlSettings {
  return { ...DEFAULT_SETTINGS };
}

export async function readRunnerControlSettings(
  redis: IORedis,
): Promise<RunnerControlSettings> {
  const values = await redis.hgetall(IMAGE_RUNNER_SETTINGS_KEY);
  return {
    desiredMode: parseRunnerDesiredMode(
      values.desired_mode,
      DEFAULT_SETTINGS.desiredMode,
    ),
    enqueueEnabled: parseBool(
      values.enqueue_enabled,
      DEFAULT_SETTINGS.enqueueEnabled,
    ),
    requireWorkersForEnqueue: parseBool(
      values.require_workers_for_enqueue,
      DEFAULT_SETTINGS.requireWorkersForEnqueue,
    ),
    minWorkersToEnqueue: Math.max(
      0,
      Math.min(
        200,
        parseNonNegativeInt(
          values.min_workers_to_enqueue,
          DEFAULT_SETTINGS.minWorkersToEnqueue,
        ),
      ),
    ),
    maxQueueBacklog: Math.max(
      10,
      Math.min(
        100_000,
        parseNonNegativeInt(
          values.max_queue_backlog,
          DEFAULT_SETTINGS.maxQueueBacklog,
        ),
      ),
    ),
    refillLowWatermark: Math.max(
      1,
      Math.min(
        100_000,
        parseNonNegativeInt(
          values.refill_low_watermark,
          DEFAULT_SETTINGS.refillLowWatermark,
        ),
      ),
    ),
    refillTargetBacklog: Math.max(
      1,
      Math.min(
        100_000,
        parseNonNegativeInt(
          values.refill_target_backlog,
          DEFAULT_SETTINGS.refillTargetBacklog,
        ),
      ),
    ),
    maxClaimPerCycle: Math.max(
      1,
      Math.min(
        10_000,
        parseNonNegativeInt(
          values.max_claim_per_cycle,
          DEFAULT_SETTINGS.maxClaimPerCycle,
        ),
      ),
    ),
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
    desired_mode: settings.desiredMode,
    enqueue_enabled: settings.enqueueEnabled ? "true" : "false",
    require_workers_for_enqueue: settings.requireWorkersForEnqueue
      ? "true"
      : "false",
    min_workers_to_enqueue: String(settings.minWorkersToEnqueue),
    max_queue_backlog: String(settings.maxQueueBacklog),
    refill_low_watermark: String(settings.refillLowWatermark),
    refill_target_backlog: String(settings.refillTargetBacklog),
    max_claim_per_cycle: String(settings.maxClaimPerCycle),
    flush_interval_ms: String(settings.flushIntervalMs),
    harvest_enabled: settings.harvestEnabled ? "true" : "false",
    updated_at: new Date().toISOString(),
  });
}

export async function writeRunnerInfraSnapshot(
  redis: IORedis,
  snapshot: RunnerInfraSnapshot,
): Promise<void> {
  await redis.hset(IMAGE_RUNNER_INFRA_KEY, {
    workers_running: String(snapshot.workersRunning),
    source: snapshot.source,
    updated_at: snapshot.updatedAt,
  });
}

export async function readRunnerInfraSnapshot(
  redis: IORedis,
): Promise<RunnerInfraSnapshot | null> {
  const values = await redis.hgetall(IMAGE_RUNNER_INFRA_KEY);
  if (!values.updated_at) {
    return null;
  }

  return {
    workersRunning: Math.max(0, parseNonNegativeInt(values.workers_running, 0)),
    source: values.source || "unknown",
    updatedAt: values.updated_at,
  };
}

export async function writeRunnerStatus(
  redis: IORedis,
  status: RunnerStatusSnapshot,
): Promise<void> {
  await redis.hset(IMAGE_RUNNER_STATUS_KEY, {
    operation_id: status.operationId,
    mode: status.mode,
    desired_mode: status.desiredMode,
    gate_reason: status.gateReason,
    workers_running: String(status.workersRunning),
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
    throughput_images_per_minute: String(status.throughputImagesPerMinute),
    avg_fetch_ms: String(status.avgFetchMs),
    avg_transform_ms: String(status.avgTransformMs),
    avg_upload_ms: String(status.avgUploadMs),
    avg_end_to_end_ms: String(status.avgEndToEndMs),
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

  const queueWaiting = parseNonNegativeInt(values.queue_waiting, 0);
  const queueActive = parseNonNegativeInt(values.queue_active, 0);
  const queueDelayed = parseNonNegativeInt(values.queue_delayed, 0);
  const queuePaused = parseNonNegativeInt(values.queue_paused, 0);
  const queueBacklogRaw = parseNonNegativeInt(values.queue_backlog, 0);
  const queueBacklogFormula =
    queueWaiting + queueActive + queueDelayed + queuePaused;

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
    desiredMode: parseRunnerDesiredMode(values.desired_mode, "run"),
    gateReason: values.gate_reason || "",
    workersRunning: parseNonNegativeInt(values.workers_running, 0),
    claimedCount: parseNonNegativeInt(values.claimed_count, 0),
    queuedCount: parseNonNegativeInt(values.queued_count, 0),
    completedJobs: parseNonNegativeInt(values.completed_jobs, 0),
    failedJobs: parseNonNegativeInt(values.failed_jobs, 0),
    processedItems: parseNonNegativeInt(values.processed_items, 0),
    failedItems: parseNonNegativeInt(values.failed_items, 0),
    queueWaiting,
    queueActive,
    queueCompleted: parseNonNegativeInt(values.queue_completed, 0),
    queueFailed: parseNonNegativeInt(values.queue_failed, 0),
    queueDelayed,
    queuePaused,
    queueBacklog:
      queueBacklogRaw === queueBacklogFormula
        ? queueBacklogRaw
        : queueBacklogFormula,
    lastFlushAt: values.last_flush_at || null,
    flushBatchCount: parseNonNegativeInt(values.flush_batch_count, 0),
    pendingSuccessBuffer: parseNonNegativeInt(values.pending_success_buffer, 0),
    pendingErrorBuffer: parseNonNegativeInt(values.pending_error_buffer, 0),
    throughputImagesPerMinute: parseNonNegativeNumber(
      values.throughput_images_per_minute,
      0,
    ),
    avgFetchMs: parseNonNegativeInt(values.avg_fetch_ms, 0),
    avgTransformMs: parseNonNegativeInt(values.avg_transform_ms, 0),
    avgUploadMs: parseNonNegativeInt(values.avg_upload_ms, 0),
    avgEndToEndMs: parseNonNegativeInt(values.avg_end_to_end_ms, 0),
    updatedAt: values.updated_at || new Date().toISOString(),
  };
}
