import { Job, Queue, QueueEvents } from "bullmq";
import type IORedis from "ioredis";
import { Pool } from "pg";

import type {
  ImageProcessingItemResult,
  ImageProcessingTaskError,
} from "../../workers/image-processing-task";
import {
  IMAGE_QUEUE_NAME,
  createImageQueue,
  createRedisConnection,
  type ImageProcessingQueueJob,
} from "../../workers/image-queue";
import {
  fetchFlyMachines,
  scaleFlyWorkers,
  type FlyMachine,
} from "./image-fly-ops";
import {
  purgePendingImageQueueJobs,
  readImageQueueCounts,
  readImageQueuePausedState,
  setImageQueuePaused,
  type ImageQueueCounts,
} from "./image-queue-ops";
import {
  readRunnerControlSettings,
  readRunnerInfraSnapshot,
  readRunnerStatus,
  writeRunnerControlSettings,
  writeRunnerInfraSnapshot,
  writeRunnerStatus,
  type RunnerControlSettings,
  type RunnerDesiredMode,
  type RunnerInfraSnapshot,
  type RunnerStatusSnapshot,
} from "./image-runner-control";

export type QueuePurgeResult = {
  removed: number;
  remainingWaiting: number;
  remainingDelayed: number;
  remainingActive: number;
  remainingPaused: number;
};

export type DesiredModeActionResult = {
  settings: RunnerControlSettings;
  purged: boolean;
  purge: QueuePurgeResult | null;
};

export type OpsSharedState = {
  queue: ImageQueueCounts;
  db: OpsDbProgress;
  settings: RunnerControlSettings;
  infra: RunnerInfraSnapshot | null;
  status: RunnerStatusSnapshot | null;
};

export type OpsDbProgress = {
  processed: number;
  pending: number;
  total: number;
  pct: number;
} | null;

export type OpsTrendPoint = {
  atMs: number;
  queueBacklog: number;
  processedItems: number;
  failedItems: number;
  workersRunning: number;
};

export type OpsTrendHeadline = {
  ipsNow: number;
  ipsSmoothedNow: number;
  ipsAvg30: number;
  ipmAvg30: number;
  backlogDeltaNow: number;
  backlogDeltaSmoothedNow: number;
  drainPerSecSmoothed: number;
  fillPerSecSmoothed: number;
};

export type OpsTrendProjection = {
  sampleCount: number;
  latestAtMs: number | null;
  queueBacklogTrendRaw: number[];
  queueBacklogTrendSmoothed: number[];
  processedItemsTrend: number[];
  failedItemsTrend: number[];
  ipsRaw: number[];
  ipsSmoothed: number[];
  backlogDeltaRaw: number[];
  backlogDeltaSmoothed: number[];
  headline: OpsTrendHeadline;
};

export type OpsStateUpdatesSubscriber = {
  waitForUpdate: (timeoutMs: number) => Promise<"message" | "timeout">;
  close: () => Promise<void>;
};

export type OpsUiStateWatcher = {
  getSnapshot: () => OpsUiSnapshot | null;
  refreshNow: () => Promise<OpsUiSnapshot>;
  waitForState: (timeoutMs: number) => Promise<"state" | "timeout">;
  getStateVersion: () => number;
  hasStateChangedSince: (version: number) => boolean;
  onStateChange: (listener: () => void) => () => void;
  close: () => Promise<void>;
};

export type OpsReactiveProfile = "cli" | "runner-lite";

export type OpsQueueRuntime = {
  queue: Queue<ImageProcessingQueueJob>;
  queueEvents: QueueEvents | null;
  close: () => Promise<void>;
};

export type OpsClaimedItem = {
  workId: string;
  sourceImageUrl: string;
};

export type OpsEnqueueOptions = {
  fetchTimeoutMs: number;
  fetchRetryCount: number;
  dryRunCloud: boolean;
  uploadPrefix: string;
  jobRetentionCount: number;
};

export type OpsUiSnapshot = {
  at: string;
  machines: FlyMachine[] | null;
  queue: ImageQueueCounts | null;
  db: OpsDbProgress;
  settings: RunnerControlSettings | null;
  infra: RunnerInfraSnapshot | null;
  status: RunnerStatusSnapshot | null;
  projections: OpsTrendProjection;
  errors: {
    fly?: string;
    queue?: string;
    db?: string;
    control?: string;
  };
};

export type OpsUiTrendMetricDescriptor = {
  name: string;
  key: string;
  getValue: (snapshot: OpsUiSnapshot) => number;
};

export type OpsUiTrendSeriesMap = Record<string, number[]>;
export type OpsUiTrendRow = {
  atMs: number;
  value: number;
};
export type OpsUiTrendRowSeriesMap = Record<string, OpsUiTrendRow[]>;
export type OpsTrendSampleMode = "raw" | "interpolated";
export type OpsTrendLatestSeriesMap = Record<string, OpsUiTrendRow | null>;
export type OpsRedisIoStats = {
  redisEgressBytes: number;
  redisIngressBytes: number;
  redisWireBytes: number;
  redisIngressReads: number;
  redisEgressWrites: number;
  windowSeconds: number;
  redisEgressKbps: number;
  redisIngressKbps: number;
  redisWireKbps: number;
  redisIngressKbPerRead: number;
  lastReadAt: string | null;
  lastWriteAt: string | null;
};

export type OpsRedisServerIoStats = {
  sampledAt: string;
  serverNetInputBytes: number;
  serverNetOutputBytes: number;
  serverInputKbps: number;
  serverOutputKbps: number;
  serverTotalCommandsProcessed: number;
  serverConnectedClients: number;
};

export type OpsRedisIoAggregateStats = {
  sampledAt: string;
  activeInstances: number;
  redisEgressBytes: number;
  redisIngressBytes: number;
  redisIngressReads: number;
  redisEgressWrites: number;
  redisEgressKbps: number;
  redisIngressKbps: number;
  redisWireKbps: number;
};

export type OpsRedisIoInstanceStats = {
  instanceId: string;
  pid: number;
  startedAt: string;
  updatedAt: string;
  windowSeconds: number;
  redisEgressBytes: number;
  redisIngressBytes: number;
  redisIngressReads: number;
  redisEgressWrites: number;
  redisEgressKbps: number;
  redisIngressKbps: number;
  redisWireKbps: number;
};

const OPS_TREND_HISTORY_MAX = 100;
const OPS_TREND_PROJECTION_DEFAULT_LIMIT = 50;
let lastTrendTimestampMs = 0;
const OPS_REDIS_IO_INSTANCE_PREFIX = "image:runner:control:redis_io:instance";
const OPS_REDIS_IO_INSTANCE_TTL_SECONDS = 45;
const OPS_REDIS_IO_PUBLISH_MIN_INTERVAL_MS = 5_000;
const opsRedisIoInstanceId = `${process.pid}-${Date.now().toString(36)}`;
let opsRedisIoPublishInFlight = false;
let opsRedisIoLastPublishedAtMs = 0;
const opsRedisIoCounter = {
  egressBytes: 0,
  ingressBytes: 0,
  reads: 0,
  writes: 0,
  startedAtMs: Date.now(),
  lastReadAtMs: 0,
  lastWriteAtMs: 0,
};
type OpsTrendMetricName =
  | "workersRunning"
  | "claimedCount"
  | "queuedCount"
  | "completedJobs"
  | "failedJobs"
  | "processedItems"
  | "failedItems"
  | "queueWaiting"
  | "queueActive"
  | "queueCompleted"
  | "queueFailed"
  | "queueDelayed"
  | "queuePaused"
  | "queueBacklog"
  | "flushBatchCount"
  | "pendingSuccessBuffer"
  | "pendingErrorBuffer";

export type OpsTrendMetricDescriptor = {
  name: OpsTrendMetricName;
  key: string;
  getValue: (status: RunnerStatusSnapshot) => number;
};

export const OPS_TREND_METRIC_REGISTRY: OpsTrendMetricDescriptor[] = [
  {
    name: "workersRunning",
    key: "image:runner:control:trend:workers_running",
    getValue: (status) => status.workersRunning,
  },
  {
    name: "claimedCount",
    key: "image:runner:control:trend:claimed_count",
    getValue: (status) => status.claimedCount,
  },
  {
    name: "queuedCount",
    key: "image:runner:control:trend:queued_count",
    getValue: (status) => status.queuedCount,
  },
  {
    name: "completedJobs",
    key: "image:runner:control:trend:completed_jobs",
    getValue: (status) => status.completedJobs,
  },
  {
    name: "failedJobs",
    key: "image:runner:control:trend:failed_jobs",
    getValue: (status) => status.failedJobs,
  },
  {
    name: "processedItems",
    key: "image:runner:control:trend:processed_items",
    getValue: (status) => status.processedItems,
  },
  {
    name: "failedItems",
    key: "image:runner:control:trend:failed_items",
    getValue: (status) => status.failedItems,
  },
  {
    name: "queueWaiting",
    key: "image:runner:control:trend:queue_waiting",
    getValue: (status) => status.queueWaiting,
  },
  {
    name: "queueActive",
    key: "image:runner:control:trend:queue_active",
    getValue: (status) => status.queueActive,
  },
  {
    name: "queueCompleted",
    key: "image:runner:control:trend:queue_completed",
    getValue: (status) => status.queueCompleted,
  },
  {
    name: "queueFailed",
    key: "image:runner:control:trend:queue_failed",
    getValue: (status) => status.queueFailed,
  },
  {
    name: "queueDelayed",
    key: "image:runner:control:trend:queue_delayed",
    getValue: (status) => status.queueDelayed,
  },
  {
    name: "queuePaused",
    key: "image:runner:control:trend:queue_paused",
    getValue: (status) => status.queuePaused,
  },
  {
    name: "queueBacklog",
    key: "image:runner:control:trend:queue_backlog",
    getValue: (status) => status.queueBacklog,
  },
  {
    name: "flushBatchCount",
    key: "image:runner:control:trend:flush_batch_count",
    getValue: (status) => status.flushBatchCount,
  },
  {
    name: "pendingSuccessBuffer",
    key: "image:runner:control:trend:pending_success_buffer",
    getValue: (status) => status.pendingSuccessBuffer,
  },
  {
    name: "pendingErrorBuffer",
    key: "image:runner:control:trend:pending_error_buffer",
    getValue: (status) => status.pendingErrorBuffer,
  },
];

export const OPS_UI_TREND_METRIC_REGISTRY: OpsUiTrendMetricDescriptor[] = [
  {
    name: "errorsCount",
    key: "image:runner:control:trend:ui:errors_count",
    getValue: (snapshot) => Object.keys(snapshot.errors).length,
  },
  {
    name: "machinesTotal",
    key: "image:runner:control:trend:ui:machines_total",
    getValue: (snapshot) => snapshot.machines?.length ?? 0,
  },
  {
    name: "workersRunningLive",
    key: "image:runner:control:trend:ui:workers_running_live",
    getValue: (snapshot) => snapshot.infra?.workersRunning ?? 0,
  },
  {
    name: "queueWaitingLive",
    key: "image:runner:control:trend:ui:queue_waiting_live",
    getValue: (snapshot) => snapshot.queue?.waiting ?? 0,
  },
  {
    name: "queueActiveLive",
    key: "image:runner:control:trend:ui:queue_active_live",
    getValue: (snapshot) => snapshot.queue?.active ?? 0,
  },
  {
    name: "queueDelayedLive",
    key: "image:runner:control:trend:ui:queue_delayed_live",
    getValue: (snapshot) => snapshot.queue?.delayed ?? 0,
  },
  {
    name: "queuePausedLive",
    key: "image:runner:control:trend:ui:queue_paused_live",
    getValue: (snapshot) => snapshot.queue?.paused ?? 0,
  },
  {
    name: "queueCompletedLive",
    key: "image:runner:control:trend:ui:queue_completed_live",
    getValue: (snapshot) => snapshot.queue?.completed ?? 0,
  },
  {
    name: "queueFailedLive",
    key: "image:runner:control:trend:ui:queue_failed_live",
    getValue: (snapshot) => snapshot.queue?.failed ?? 0,
  },
  {
    name: "queueBacklogLive",
    key: "image:runner:control:trend:ui:queue_backlog_live",
    getValue: (snapshot) => snapshot.queue?.backlog ?? 0,
  },
  {
    name: "statusProcessedItems",
    key: "image:runner:control:trend:ui:status_processed_items",
    getValue: (snapshot) => snapshot.status?.processedItems ?? 0,
  },
  {
    name: "statusFailedItems",
    key: "image:runner:control:trend:ui:status_failed_items",
    getValue: (snapshot) => snapshot.status?.failedItems ?? 0,
  },
  {
    name: "statusCompletedJobs",
    key: "image:runner:control:trend:ui:status_completed_jobs",
    getValue: (snapshot) => snapshot.status?.completedJobs ?? 0,
  },
  {
    name: "statusFailedJobs",
    key: "image:runner:control:trend:ui:status_failed_jobs",
    getValue: (snapshot) => snapshot.status?.failedJobs ?? 0,
  },
  {
    name: "statusPendingSuccessBuffer",
    key: "image:runner:control:trend:ui:status_pending_success_buffer",
    getValue: (snapshot) => snapshot.status?.pendingSuccessBuffer ?? 0,
  },
  {
    name: "statusPendingErrorBuffer",
    key: "image:runner:control:trend:ui:status_pending_error_buffer",
    getValue: (snapshot) => snapshot.status?.pendingErrorBuffer ?? 0,
  },
  {
    name: "statusFlushBatchCount",
    key: "image:runner:control:trend:ui:status_flush_batch_count",
    getValue: (snapshot) => snapshot.status?.flushBatchCount ?? 0,
  },
  {
    name: "settingsFlushIntervalMs",
    key: "image:runner:control:trend:ui:settings_flush_interval_ms",
    getValue: (snapshot) => snapshot.settings?.flushIntervalMs ?? 0,
  },
  {
    name: "settingsMaxQueueBacklog",
    key: "image:runner:control:trend:ui:settings_max_queue_backlog",
    getValue: (snapshot) => snapshot.settings?.maxQueueBacklog ?? 0,
  },
  {
    name: "settingsRefillLowWatermark",
    key: "image:runner:control:trend:ui:settings_refill_low_watermark",
    getValue: (snapshot) => snapshot.settings?.refillLowWatermark ?? 0,
  },
  {
    name: "settingsRefillTargetBacklog",
    key: "image:runner:control:trend:ui:settings_refill_target_backlog",
    getValue: (snapshot) => snapshot.settings?.refillTargetBacklog ?? 0,
  },
  {
    name: "settingsMaxClaimPerCycle",
    key: "image:runner:control:trend:ui:settings_max_claim_per_cycle",
    getValue: (snapshot) => snapshot.settings?.maxClaimPerCycle ?? 0,
  },
  {
    name: "dbProcessed",
    key: "image:runner:control:trend:ui:db_processed",
    getValue: (snapshot) => snapshot.db?.processed ?? 0,
  },
  {
    name: "dbPending",
    key: "image:runner:control:trend:ui:db_pending",
    getValue: (snapshot) => snapshot.db?.pending ?? 0,
  },
  {
    name: "dbTotal",
    key: "image:runner:control:trend:ui:db_total",
    getValue: (snapshot) => snapshot.db?.total ?? 0,
  },
  {
    name: "dbProgressPct",
    key: "image:runner:control:trend:ui:db_progress_pct",
    getValue: (snapshot) => snapshot.db?.pct ?? 0,
  },
  {
    name: "throughputIpsNow",
    key: "image:runner:control:trend:ui:throughput_ips_now",
    getValue: (snapshot) => snapshot.projections.headline.ipsSmoothedNow,
  },
  {
    name: "throughputIpmNow",
    key: "image:runner:control:trend:ui:throughput_ipm_now",
    getValue: (snapshot) => snapshot.projections.headline.ipsSmoothedNow * 60,
  },
  {
    name: "throughputIpsAvg30",
    key: "image:runner:control:trend:ui:throughput_ips_avg30",
    getValue: (snapshot) => snapshot.projections.headline.ipsAvg30,
  },
  {
    name: "throughputIpmAvg30",
    key: "image:runner:control:trend:ui:throughput_ipm_avg30",
    getValue: (snapshot) => snapshot.projections.headline.ipmAvg30,
  },
  {
    name: "throughputDrainQps",
    key: "image:runner:control:trend:ui:throughput_drain_qps",
    getValue: (snapshot) => snapshot.projections.headline.drainPerSecSmoothed,
  },
  {
    name: "throughputFillQps",
    key: "image:runner:control:trend:ui:throughput_fill_qps",
    getValue: (snapshot) => snapshot.projections.headline.fillPerSecSmoothed,
  },
  {
    name: "fillRatioPct",
    key: "image:runner:control:trend:ui:fill_ratio_pct",
    getValue: (snapshot) => {
      const backlog = snapshot.queue?.backlog ?? 0;
      const maxBacklog = Math.max(1, snapshot.settings?.maxQueueBacklog ?? 1);
      return (backlog / maxBacklog) * 100;
    },
  },
];

const OPS_TREND_METRIC_KEYS = {
  queueBacklog: OPS_TREND_METRIC_REGISTRY.find(
    (metric) => metric.name === "queueBacklog",
  )!.key,
  processedItems: OPS_TREND_METRIC_REGISTRY.find(
    (metric) => metric.name === "processedItems",
  )!.key,
  failedItems: OPS_TREND_METRIC_REGISTRY.find(
    (metric) => metric.name === "failedItems",
  )!.key,
  workersRunning: OPS_TREND_METRIC_REGISTRY.find(
    (metric) => metric.name === "workersRunning",
  )!.key,
} as const;
export const OPS_STATE_UPDATES_CHANNEL = "image:runner:control:state_updates";
const OPS_STATE_UPDATES_THROTTLE_KEY =
  "image:runner:control:state_updates:throttle";
const OPS_STATE_UPDATES_MIN_INTERVAL_MS_DEFAULT = 1000;

type OpsStateUpdateEvent = {
  at: string;
  source: string;
  fields: string[];
};

function shortError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function trackRedisIngressBytes(bytes: number): void {
  const normalizedBytes = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  opsRedisIoCounter.ingressBytes += Math.floor(normalizedBytes);
}

function trackRedisEgressBytes(bytes: number): void {
  const normalizedBytes = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  opsRedisIoCounter.egressBytes += Math.floor(normalizedBytes);
}

function trackRedisReadIo(requestBytes: number, responseBytes: number): void {
  trackRedisEgressBytes(requestBytes);
  trackRedisIngressBytes(responseBytes);
  opsRedisIoCounter.reads += 1;
  opsRedisIoCounter.lastReadAtMs = Date.now();
  maybePublishOpsRedisIoInstanceStats();
}

function trackRedisWriteIo(requestBytes: number, responseBytes: number): void {
  trackRedisEgressBytes(requestBytes);
  trackRedisIngressBytes(responseBytes);
  opsRedisIoCounter.writes += 1;
  opsRedisIoCounter.lastWriteAtMs = Date.now();
  maybePublishOpsRedisIoInstanceStats();
}

function byteLen(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function redisCommandPayloadBytes(parts: Array<string | number>): number {
  let bytes = byteLen(`*${parts.length}\r\n`);
  for (const part of parts) {
    const token = String(part);
    bytes += byteLen(`$${byteLen(token)}\r\n`);
    bytes += byteLen(token);
    bytes += 2; // CRLF after bulk payload.
  }
  return bytes;
}

function redisReplyPayloadBytes(payload: unknown): number {
  if (payload === null || payload === undefined) {
    return 0;
  }
  if (typeof payload === "string") {
    return byteLen(payload);
  }
  if (typeof payload === "number" || typeof payload === "bigint") {
    return byteLen(String(payload));
  }
  if (typeof payload === "boolean") {
    return byteLen(payload ? "1" : "0");
  }
  if (Buffer.isBuffer(payload)) {
    return payload.length;
  }
  if (Array.isArray(payload)) {
    return payload.reduce((sum, part) => sum + redisReplyPayloadBytes(part), 0);
  }
  return byteLen(String(payload));
}

function opsRedisIoInstanceKey(instanceId = opsRedisIoInstanceId): string {
  return `${OPS_REDIS_IO_INSTANCE_PREFIX}:${instanceId}`;
}

function parseNumericField(
  record: Record<string, string>,
  key: string,
): number {
  const value = Number(record[key] ?? "0");
  return Number.isFinite(value) ? value : 0;
}

function mapInstanceRecord(
  record: Record<string, string>,
): OpsRedisIoInstanceStats {
  return {
    instanceId: String(record.instance_id ?? "unknown"),
    pid: parseNumericField(record, "pid"),
    startedAt: String(record.started_at ?? ""),
    updatedAt: String(record.updated_at ?? ""),
    windowSeconds: parseNumericField(record, "window_seconds"),
    redisEgressBytes: parseNumericField(record, "redis_egress_bytes"),
    redisIngressBytes: parseNumericField(record, "redis_ingress_bytes"),
    redisIngressReads: parseNumericField(record, "redis_ingress_reads"),
    redisEgressWrites: parseNumericField(record, "redis_egress_writes"),
    redisEgressKbps: parseNumericField(record, "redis_egress_kbps"),
    redisIngressKbps: parseNumericField(record, "redis_ingress_kbps"),
    redisWireKbps: parseNumericField(record, "redis_wire_kbps"),
  };
}

function maybePublishOpsRedisIoInstanceStats(): void {
  const nowMs = Date.now();
  if (opsRedisIoPublishInFlight) {
    return;
  }
  if (
    nowMs - opsRedisIoLastPublishedAtMs <
    OPS_REDIS_IO_PUBLISH_MIN_INTERVAL_MS
  ) {
    return;
  }

  opsRedisIoPublishInFlight = true;
  void (async () => {
    try {
      const local = readOpsRedisIoStats();
      const key = opsRedisIoInstanceKey();
      await withControlRedis(undefined, async (connection) => {
        await connection
          .multi()
          .hset(
            key,
            "instance_id",
            opsRedisIoInstanceId,
            "pid",
            String(process.pid),
            "started_at",
            new Date(opsRedisIoCounter.startedAtMs).toISOString(),
            "updated_at",
            new Date().toISOString(),
            "window_seconds",
            String(local.windowSeconds),
            "redis_egress_bytes",
            String(local.redisEgressBytes),
            "redis_ingress_bytes",
            String(local.redisIngressBytes),
            "redis_ingress_reads",
            String(local.redisIngressReads),
            "redis_egress_writes",
            String(local.redisEgressWrites),
            "redis_egress_kbps",
            String(local.redisEgressKbps),
            "redis_ingress_kbps",
            String(local.redisIngressKbps),
            "redis_wire_kbps",
            String(local.redisWireKbps),
          )
          .expire(key, OPS_REDIS_IO_INSTANCE_TTL_SECONDS)
          .exec();
      });
      opsRedisIoLastPublishedAtMs = Date.now();
    } catch {
      // Best-effort metric publication should not impact control flow.
    } finally {
      opsRedisIoPublishInFlight = false;
    }
  })();
}

export function readOpsRedisIoStats(): OpsRedisIoStats {
  const nowMs = Date.now();
  const elapsedSeconds = Math.max(
    1,
    Math.round((nowMs - opsRedisIoCounter.startedAtMs) / 1000),
  );
  const egressKbps = opsRedisIoCounter.egressBytes / 1024 / elapsedSeconds;
  const ingressKbps = opsRedisIoCounter.ingressBytes / 1024 / elapsedSeconds;
  const wireKbps =
    (opsRedisIoCounter.egressBytes + opsRedisIoCounter.ingressBytes) /
    1024 /
    elapsedSeconds;
  const kbPerRead =
    opsRedisIoCounter.reads > 0
      ? opsRedisIoCounter.ingressBytes / 1024 / opsRedisIoCounter.reads
      : 0;
  return {
    redisEgressBytes: opsRedisIoCounter.egressBytes,
    redisIngressBytes: opsRedisIoCounter.ingressBytes,
    redisWireBytes:
      opsRedisIoCounter.egressBytes + opsRedisIoCounter.ingressBytes,
    redisIngressReads: opsRedisIoCounter.reads,
    redisEgressWrites: opsRedisIoCounter.writes,
    windowSeconds: elapsedSeconds,
    redisEgressKbps: Number(egressKbps.toFixed(3)),
    redisIngressKbps: Number(ingressKbps.toFixed(3)),
    redisWireKbps: Number(wireKbps.toFixed(3)),
    redisIngressKbPerRead: Number(kbPerRead.toFixed(3)),
    lastReadAt:
      opsRedisIoCounter.lastReadAtMs > 0
        ? new Date(opsRedisIoCounter.lastReadAtMs).toISOString()
        : null,
    lastWriteAt:
      opsRedisIoCounter.lastWriteAtMs > 0
        ? new Date(opsRedisIoCounter.lastWriteAtMs).toISOString()
        : null,
  };
}

export function resetOpsRedisIoStats(): void {
  opsRedisIoCounter.egressBytes = 0;
  opsRedisIoCounter.ingressBytes = 0;
  opsRedisIoCounter.reads = 0;
  opsRedisIoCounter.writes = 0;
  opsRedisIoCounter.startedAtMs = Date.now();
  opsRedisIoCounter.lastReadAtMs = 0;
  opsRedisIoCounter.lastWriteAtMs = 0;
  opsRedisIoLastPublishedAtMs = 0;
}

export async function readOpsRedisIoInstanceStats(
  redis?: IORedis,
): Promise<OpsRedisIoInstanceStats[]> {
  return withControlRedis(redis, async (connection) => {
    const keys = await connection.keys(`${OPS_REDIS_IO_INSTANCE_PREFIX}:*`);
    if (keys.length === 0) {
      return [];
    }

    const pipeline = connection.pipeline();
    for (const key of keys) {
      pipeline.hgetall(key);
    }
    const rows = await pipeline.exec();
    if (!rows) {
      return [];
    }

    const instances: OpsRedisIoInstanceStats[] = [];
    for (const row of rows) {
      const payload = row?.[1];
      if (!payload || Array.isArray(payload) || typeof payload !== "object") {
        continue;
      }
      instances.push(mapInstanceRecord(payload as Record<string, string>));
    }

    instances.sort((left, right) => {
      return right.updatedAt.localeCompare(left.updatedAt);
    });
    return instances;
  });
}

export async function readOpsRedisIoAggregateStats(
  redis?: IORedis,
): Promise<OpsRedisIoAggregateStats> {
  const instances = await readOpsRedisIoInstanceStats(redis);
  const aggregate: OpsRedisIoAggregateStats = {
    sampledAt: new Date().toISOString(),
    activeInstances: instances.length,
    redisEgressBytes: 0,
    redisIngressBytes: 0,
    redisIngressReads: 0,
    redisEgressWrites: 0,
    redisEgressKbps: 0,
    redisIngressKbps: 0,
    redisWireKbps: 0,
  };

  for (const instance of instances) {
    aggregate.redisEgressBytes += instance.redisEgressBytes;
    aggregate.redisIngressBytes += instance.redisIngressBytes;
    aggregate.redisIngressReads += instance.redisIngressReads;
    aggregate.redisEgressWrites += instance.redisEgressWrites;
    aggregate.redisEgressKbps += instance.redisEgressKbps;
    aggregate.redisIngressKbps += instance.redisIngressKbps;
    aggregate.redisWireKbps += instance.redisWireKbps;
  }

  aggregate.redisEgressKbps = Number(aggregate.redisEgressKbps.toFixed(3));
  aggregate.redisIngressKbps = Number(aggregate.redisIngressKbps.toFixed(3));
  aggregate.redisWireKbps = Number(aggregate.redisWireKbps.toFixed(3));
  return aggregate;
}

function parseRedisInfoValue(info: string, key: string): string | null {
  const prefix = `${key}:`;
  for (const line of info.split("\n")) {
    if (line.startsWith(prefix)) {
      return line.slice(prefix.length).trim();
    }
  }
  return null;
}

function parseRedisInfoNumber(info: string, key: string): number {
  const value = parseRedisInfoValue(info, key);
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return numeric;
}

export async function readOpsRedisServerIoStats(
  redis?: IORedis,
): Promise<OpsRedisServerIoStats> {
  return withControlRedis(redis, async (connection) => {
    const info = await connection.info();

    return {
      sampledAt: new Date().toISOString(),
      serverNetInputBytes: parseRedisInfoNumber(info, "total_net_input_bytes"),
      serverNetOutputBytes: parseRedisInfoNumber(
        info,
        "total_net_output_bytes",
      ),
      serverInputKbps: parseRedisInfoNumber(info, "instantaneous_input_kbps"),
      serverOutputKbps: parseRedisInfoNumber(info, "instantaneous_output_kbps"),
      serverTotalCommandsProcessed: parseRedisInfoNumber(
        info,
        "total_commands_processed",
      ),
      serverConnectedClients: parseRedisInfoNumber(info, "connected_clients"),
    };
  });
}

function makeSimJob(
  operationId: string,
  index: number,
): ImageProcessingQueueJob {
  return {
    operationId,
    batchId: `${operationId}-batch-${String(index).padStart(6, "0")}`,
    batchIndex: index,
    batchCount: 1,
    workId: `${operationId}-work-${String(index).padStart(6, "0")}`,
    sourceType: "url",
    sourceImageUrl: `https://sim.local/${operationId}/${index}.jpg`,
    dryRun: true,
  };
}

function takeTail(values: number[], max: number): number[] {
  if (values.length <= max) {
    return values;
  }
  return values.slice(values.length - max);
}

function computeEwmaSeries(values: number[], alpha: number): number[] {
  if (values.length === 0) {
    return [];
  }

  const boundedAlpha = Math.max(0.05, Math.min(0.95, alpha));
  const output: number[] = [];
  let previous = values[0] || 0;

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] || 0;
    previous =
      index === 0
        ? value
        : boundedAlpha * value + (1 - boundedAlpha) * previous;
    output.push(previous);
  }

  return output;
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  return total / values.length;
}

function encodeTrendMetricMember(value: number, atMs: number): string {
  return JSON.stringify({
    atMs,
    value,
  });
}

function trendMetricLatestKey(key: string): string {
  return `${key}:latest`;
}

function parseTrendMetricValue(member: string): number | null {
  try {
    const parsed = JSON.parse(member) as { value?: unknown };
    if (Number.isFinite(parsed.value)) {
      return Number(parsed.value);
    }
    return null;
  } catch {
    const numeric = Number(member);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
    return null;
  }
}

async function appendTrendMetric(
  connection: IORedis,
  key: string,
  atMs: number,
  value: number,
): Promise<void> {
  const latestPayload = JSON.stringify({ atMs, value });
  const pipeline = connection.pipeline();
  pipeline.zadd(key, atMs, encodeTrendMetricMember(value, atMs));
  pipeline.zremrangebyrank(key, 0, -(OPS_TREND_HISTORY_MAX + 1));
  pipeline.set(trendMetricLatestKey(key), latestPayload);
  const result = await pipeline.exec();
  const requestBytes =
    redisCommandPayloadBytes([
      "ZADD",
      key,
      String(atMs),
      encodeTrendMetricMember(value, atMs),
    ]) +
    redisCommandPayloadBytes([
      "ZREMRANGEBYRANK",
      key,
      "0",
      String(-(OPS_TREND_HISTORY_MAX + 1)),
    ]) +
    redisCommandPayloadBytes(["SET", trendMetricLatestKey(key), latestPayload]);
  const responseBytes = Array.isArray(result)
    ? result.reduce((sum, row) => sum + redisReplyPayloadBytes(row?.[1]), 0)
    : 0;
  trackRedisWriteIo(requestBytes, responseBytes);
}

function parseTrendMetricLatestPayload(
  raw: string | null,
): TrendMetricRow | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as { atMs?: unknown; value?: unknown };
    const atMs = Number(parsed.atMs);
    const value = Number(parsed.value);
    if (Number.isFinite(atMs) && Number.isFinite(value)) {
      return { atMs, value };
    }
    return null;
  } catch {
    return null;
  }
}

async function readTrendMetricLatestBatch<TName extends string>(
  connection: IORedis,
  descriptors: Array<{ name: TName; key: string }>,
): Promise<Array<{ name: TName; row: TrendMetricRow | null }>> {
  const pipeline = connection.pipeline();
  for (const descriptor of descriptors) {
    pipeline.get(trendMetricLatestKey(descriptor.key));
  }

  const rawResults = await pipeline.exec();
  if (!rawResults) {
    trackRedisReadIo(
      descriptors.reduce(
        (sum, descriptor) =>
          sum +
          redisCommandPayloadBytes([
            "GET",
            trendMetricLatestKey(descriptor.key),
          ]),
        0,
      ),
      0,
    );
    return descriptors.map((descriptor) => ({
      name: descriptor.name,
      row: null,
    }));
  }

  trackRedisReadIo(
    descriptors.reduce(
      (sum, descriptor) =>
        sum +
        redisCommandPayloadBytes(["GET", trendMetricLatestKey(descriptor.key)]),
      0,
    ),
    rawResults.reduce((sum, result) => {
      return sum + redisReplyPayloadBytes(result?.[1]);
    }, 0),
  );

  return descriptors.map((descriptor, index) => {
    const result = rawResults[index];
    const raw = result?.[1];
    const row = parseTrendMetricLatestPayload(
      typeof raw === "string" ? raw : null,
    );
    return {
      name: descriptor.name,
      row,
    };
  });
}

function opsStateUpdatesMinIntervalMs(): number {
  const raw = process.env.IMAGE_OPS_STATE_NOTIFY_MIN_INTERVAL_MS;
  const parsed = Number.parseInt(String(raw || "").trim(), 10);
  if (!Number.isFinite(parsed)) {
    return OPS_STATE_UPDATES_MIN_INTERVAL_MS_DEFAULT;
  }
  return Math.max(0, Math.min(60_000, parsed));
}

function nextTrendTimestampMs(): number {
  const now = Date.now();
  if (now <= lastTrendTimestampMs) {
    lastTrendTimestampMs += 1;
    return lastTrendTimestampMs;
  }
  lastTrendTimestampMs = now;
  return lastTrendTimestampMs;
}

type TrendMetricRow = {
  atMs: number;
  value: number;
};

function parseTrendMetricRowsRaw(raw: unknown): TrendMetricRow[] {
  const tokens = Array.isArray(raw) ? raw : [];
  const rows: TrendMetricRow[] = [];
  for (let index = 0; index < tokens.length; index += 2) {
    const member = tokens[index];
    const score = tokens[index + 1];
    const value = parseTrendMetricValue(member);
    const atMs = Number(score);
    if (value === null || !Number.isFinite(atMs)) {
      continue;
    }
    rows.push({ atMs, value });
  }
  return rows;
}

async function readTrendMetricRowsBatch<TName extends string>(
  connection: IORedis,
  descriptors: Array<{ name: TName; key: string }>,
  limit: number,
): Promise<Array<{ name: TName; rows: TrendMetricRow[] }>> {
  const pipeline = connection.pipeline();
  for (const descriptor of descriptors) {
    pipeline.zrange(descriptor.key, -limit, -1, "WITHSCORES");
  }

  const rawResults = await pipeline.exec();
  if (!rawResults) {
    trackRedisReadIo(
      descriptors.reduce(
        (sum, descriptor) =>
          sum +
          redisCommandPayloadBytes([
            "ZRANGE",
            descriptor.key,
            String(-limit),
            "-1",
            "WITHSCORES",
          ]),
        0,
      ),
      0,
    );
    return descriptors.map((descriptor) => ({
      name: descriptor.name,
      rows: [],
    }));
  }

  let totalBytes = 0;
  for (const result of rawResults) {
    const payload = result?.[1];
    if (!Array.isArray(payload)) {
      continue;
    }
    for (const token of payload) {
      totalBytes += byteLen(String(token));
    }
  }
  trackRedisReadIo(
    descriptors.reduce(
      (sum, descriptor) =>
        sum +
        redisCommandPayloadBytes([
          "ZRANGE",
          descriptor.key,
          String(-limit),
          "-1",
          "WITHSCORES",
        ]),
      0,
    ),
    totalBytes,
  );

  return descriptors.map((descriptor, index) => {
    const payload = rawResults[index]?.[1];
    return {
      name: descriptor.name,
      rows: parseTrendMetricRowsRaw(payload),
    };
  });
}

function sampleTrendRowsInterpolated(
  rows: TrendMetricRow[],
  sampleCount: number,
  maxGapMs?: number,
  input?: {
    anchorAtMs?: number;
    windowMs?: number;
  },
): number[] {
  if (rows.length === 0) {
    return [];
  }

  const count = Math.max(1, sampleCount);
  if (rows.length === 1) {
    return Array.from({ length: count }, () => rows[0].value);
  }

  const sorted = [...rows].sort((a, b) => a.atMs - b.atMs);
  const endAtMsDefault = sorted[sorted.length - 1].atMs;
  const windowMs = input?.windowMs;
  const anchorAtMs = input?.anchorAtMs;
  const useAnchoredWindow =
    Number.isFinite(anchorAtMs) &&
    Number.isFinite(windowMs) &&
    (windowMs || 0) > 0;

  const endAtMs = useAnchoredWindow ? Number(anchorAtMs) : endAtMsDefault;
  const startAtMs = useAnchoredWindow
    ? Number(anchorAtMs) - Number(windowMs)
    : sorted[0].atMs;
  if (
    !Number.isFinite(startAtMs) ||
    !Number.isFinite(endAtMs) ||
    endAtMs <= startAtMs
  ) {
    return Array.from({ length: count }, () => sorted[sorted.length - 1].value);
  }

  const stepMs = count === 1 ? 0 : (endAtMs - startAtMs) / (count - 1);
  const gapLimitMs =
    maxGapMs && Number.isFinite(maxGapMs) && maxGapMs > 0
      ? maxGapMs
      : Math.max(stepMs * 3, 1000);
  const output: number[] = [];
  let rightIndex = 1;

  for (let index = 0; index < count; index += 1) {
    const atMs = startAtMs + stepMs * index;
    while (rightIndex < sorted.length && sorted[rightIndex].atMs < atMs) {
      rightIndex += 1;
    }

    if (atMs < sorted[0].atMs) {
      output.push(0);
      continue;
    }

    if (rightIndex >= sorted.length) {
      const tailGapMs = atMs - sorted[sorted.length - 1].atMs;
      if (tailGapMs > gapLimitMs) {
        output.push(0);
      } else {
        output.push(sorted[sorted.length - 1].value);
      }
      continue;
    }

    const right = sorted[rightIndex];
    const left = sorted[Math.max(0, rightIndex - 1)];

    if (atMs <= left.atMs) {
      output.push(left.value);
      continue;
    }

    if (right.atMs <= left.atMs) {
      output.push(right.value);
      continue;
    }

    const gapMs = right.atMs - left.atMs;
    if (gapMs > gapLimitMs && atMs > left.atMs && atMs < right.atMs) {
      output.push(0);
      continue;
    }

    const ratio = (atMs - left.atMs) / (right.atMs - left.atMs);
    const value = left.value + (right.value - left.value) * ratio;
    output.push(Number.isFinite(value) ? value : right.value);
  }

  return output;
}

function sampleTrendRows(
  rows: TrendMetricRow[],
  mode: OpsTrendSampleMode,
  sampleCount: number,
  maxGapMs?: number,
  input?: {
    anchorAtMs?: number;
    windowMs?: number;
  },
): number[] {
  if (mode === "interpolated") {
    return sampleTrendRowsInterpolated(rows, sampleCount, maxGapMs, input);
  }
  return rows.map((row) => row.value);
}

function filterStaleTrendRows(
  rows: TrendMetricRow[],
  maxAgeMs?: number,
): TrendMetricRow[] {
  if (!maxAgeMs || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
    return rows;
  }
  const minAtMs = Date.now() - maxAgeMs;
  return rows.filter((row) => row.atMs >= minAtMs);
}

export async function writeOpsUiTrendMetrics(
  snapshot: OpsUiSnapshot,
  redis?: IORedis,
): Promise<void> {
  await withControlRedis(redis, async (connection) => {
    const atMs = nextTrendTimestampMs();
    await Promise.all(
      OPS_UI_TREND_METRIC_REGISTRY.map((metric) => {
        const value = metric.getValue(snapshot);
        const normalized = Number.isFinite(value) ? Number(value) : 0;
        return appendTrendMetric(connection, metric.key, atMs, normalized);
      }),
    );
  });
}

export async function readOpsUiTrendSeries(input?: {
  metricNames?: string[];
  limit?: number;
  sampleMode?: OpsTrendSampleMode;
  sampleMaxGapMs?: number;
  sampleMaxAgeMs?: number;
  sampleAnchorAtMs?: number;
  sampleWindowMs?: number;
  redis?: IORedis;
}): Promise<OpsUiTrendSeriesMap> {
  const boundedLimit = Math.max(
    1,
    Math.min(OPS_TREND_HISTORY_MAX, input?.limit ?? OPS_TREND_HISTORY_MAX),
  );
  const selected = input?.metricNames?.length
    ? OPS_UI_TREND_METRIC_REGISTRY.filter((metric) =>
        input.metricNames?.includes(metric.name),
      )
    : OPS_UI_TREND_METRIC_REGISTRY;
  const sampleMode = input?.sampleMode ?? "raw";
  const sampleMaxGapMs = input?.sampleMaxGapMs;
  const sampleMaxAgeMs = input?.sampleMaxAgeMs;
  const sampleAnchorAtMs = input?.sampleAnchorAtMs;
  const sampleWindowMs = input?.sampleWindowMs;

  return withControlRedis(input?.redis, async (connection) => {
    const rowsByMetric = await readTrendMetricRowsBatch(
      connection,
      selected.map((metric) => ({
        name: metric.name,
        key: metric.key,
      })),
      boundedLimit,
    );

    const output: OpsUiTrendSeriesMap = {};
    for (const row of rowsByMetric) {
      const rows = filterStaleTrendRows(row.rows, sampleMaxAgeMs);
      output[row.name] = sampleTrendRows(
        rows,
        sampleMode,
        boundedLimit,
        sampleMaxGapMs,
        {
          anchorAtMs: sampleAnchorAtMs,
          windowMs: sampleWindowMs,
        },
      );
    }
    return output;
  });
}

export async function readOpsUiTrendRows(input?: {
  metricNames?: string[];
  limit?: number;
  maxAgeMs?: number;
  redis?: IORedis;
}): Promise<OpsUiTrendRowSeriesMap> {
  const boundedLimit = Math.max(
    1,
    Math.min(OPS_TREND_HISTORY_MAX, input?.limit ?? OPS_TREND_HISTORY_MAX),
  );
  const selected = input?.metricNames?.length
    ? OPS_UI_TREND_METRIC_REGISTRY.filter((metric) =>
        input.metricNames?.includes(metric.name),
      )
    : OPS_UI_TREND_METRIC_REGISTRY;
  const maxAgeMs = input?.maxAgeMs;

  return withControlRedis(input?.redis, async (connection) => {
    const rowsByMetric = await readTrendMetricRowsBatch(
      connection,
      selected.map((metric) => ({
        name: metric.name,
        key: metric.key,
      })),
      boundedLimit,
    );

    const output: OpsUiTrendRowSeriesMap = {};
    for (const row of rowsByMetric) {
      output[row.name] = filterStaleTrendRows(row.rows, maxAgeMs);
    }
    return output;
  });
}

export async function readOpsUiTrendLatest(input?: {
  metricNames?: string[];
  redis?: IORedis;
}): Promise<OpsTrendLatestSeriesMap> {
  const selected = input?.metricNames?.length
    ? OPS_UI_TREND_METRIC_REGISTRY.filter((metric) =>
        input.metricNames?.includes(metric.name),
      )
    : OPS_UI_TREND_METRIC_REGISTRY;

  return withControlRedis(input?.redis, async (connection) => {
    const latestRows = await readTrendMetricLatestBatch(
      connection,
      selected.map((metric) => ({
        name: metric.name,
        key: metric.key,
      })),
    );

    const output: OpsTrendLatestSeriesMap = {};
    for (const row of latestRows) {
      output[row.name] = row.row;
    }
    return output;
  });
}

export async function readOpsRunnerTrendLatest(input?: {
  metricNames?: OpsTrendMetricName[];
  redis?: IORedis;
}): Promise<Partial<Record<OpsTrendMetricName, OpsUiTrendRow | null>>> {
  const selected = input?.metricNames?.length
    ? OPS_TREND_METRIC_REGISTRY.filter((metric) =>
        input.metricNames?.includes(metric.name),
      )
    : OPS_TREND_METRIC_REGISTRY;

  return withControlRedis(input?.redis, async (connection) => {
    const latestRows = await readTrendMetricLatestBatch(
      connection,
      selected.map((metric) => ({
        name: metric.name,
        key: metric.key,
      })),
    );

    const output: Partial<Record<OpsTrendMetricName, OpsUiTrendRow | null>> =
      {};
    for (const row of latestRows) {
      output[row.name] = row.row;
    }
    return output;
  });
}

function deriveOpsTrendProjection(points: OpsTrendPoint[]): OpsTrendProjection {
  if (points.length === 0) {
    return {
      sampleCount: 0,
      latestAtMs: null,
      queueBacklogTrendRaw: [],
      queueBacklogTrendSmoothed: [],
      processedItemsTrend: [],
      failedItemsTrend: [],
      ipsRaw: [],
      ipsSmoothed: [],
      backlogDeltaRaw: [],
      backlogDeltaSmoothed: [],
      headline: {
        ipsNow: 0,
        ipsSmoothedNow: 0,
        ipsAvg30: 0,
        ipmAvg30: 0,
        backlogDeltaNow: 0,
        backlogDeltaSmoothedNow: 0,
        drainPerSecSmoothed: 0,
        fillPerSecSmoothed: 0,
      },
    };
  }

  const queueBacklogTrendRaw = points.map((point) => point.queueBacklog);
  const processedItemsTrend = points.map((point) => point.processedItems);
  const failedItemsTrend = points.map((point) => point.failedItems);

  const ipsRaw: number[] = [];
  const backlogDeltaRaw: number[] = [];
  for (let index = 0; index < points.length; index += 1) {
    if (index === 0) {
      ipsRaw.push(0);
      backlogDeltaRaw.push(0);
      continue;
    }

    const current = points[index];
    const previous = points[index - 1];
    const elapsedSeconds = Math.max(0, (current.atMs - previous.atMs) / 1000);
    if (elapsedSeconds <= 0) {
      ipsRaw.push(0);
      backlogDeltaRaw.push(0);
      continue;
    }

    const ips =
      current.processedItems >= previous.processedItems
        ? (current.processedItems - previous.processedItems) / elapsedSeconds
        : 0;
    const backlogDelta =
      (current.queueBacklog - previous.queueBacklog) / elapsedSeconds;

    ipsRaw.push(ips);
    backlogDeltaRaw.push(backlogDelta);
  }

  const queueBacklogTrendSmoothed = computeEwmaSeries(
    queueBacklogTrendRaw,
    0.28,
  );
  const ipsSmoothed = computeEwmaSeries(ipsRaw, 0.35);
  const backlogDeltaSmoothed = computeEwmaSeries(backlogDeltaRaw, 0.35);

  const ipsNow = ipsRaw[ipsRaw.length - 1] || 0;
  const ipsSmoothedNow = ipsSmoothed[ipsSmoothed.length - 1] || 0;
  const backlogDeltaNow = backlogDeltaRaw[backlogDeltaRaw.length - 1] || 0;
  const backlogDeltaSmoothedNow =
    backlogDeltaSmoothed[backlogDeltaSmoothed.length - 1] || 0;
  const ipsAvg30 = average(takeTail(ipsSmoothed, 30));
  const ipmAvg30 = ipsAvg30 * 60;

  return {
    sampleCount: points.length,
    latestAtMs: points[points.length - 1]?.atMs ?? null,
    queueBacklogTrendRaw,
    queueBacklogTrendSmoothed,
    processedItemsTrend,
    failedItemsTrend,
    ipsRaw,
    ipsSmoothed,
    backlogDeltaRaw,
    backlogDeltaSmoothed,
    headline: {
      ipsNow,
      ipsSmoothedNow,
      ipsAvg30,
      ipmAvg30,
      backlogDeltaNow,
      backlogDeltaSmoothedNow,
      drainPerSecSmoothed: Math.max(0, -backlogDeltaSmoothedNow),
      fillPerSecSmoothed: Math.max(0, backlogDeltaSmoothedNow),
    },
  };
}

async function withTimeout<T>(
  label: string,
  ms: number,
  work: Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${ms}ms`));
        }, ms);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function withControlRedis<T>(
  redis: IORedis | undefined,
  run: (connection: IORedis) => Promise<T>,
): Promise<T> {
  if (redis) {
    return run(redis);
  }

  const connection = createRedisConnection();
  try {
    return await run(connection);
  } finally {
    await connection.quit().catch(() => undefined);
  }
}

async function publishOpsStateUpdate(
  connection: IORedis,
  event: OpsStateUpdateEvent,
  input?: {
    minIntervalMs?: number;
  },
): Promise<void> {
  const minIntervalMs = input?.minIntervalMs ?? 0;
  if (minIntervalMs > 0) {
    const acquired = await connection.set(
      OPS_STATE_UPDATES_THROTTLE_KEY,
      String(Date.now()),
      "PX",
      Math.max(1, Math.floor(minIntervalMs)),
      "NX",
    );
    if (acquired !== "OK") {
      return;
    }
  }

  await connection.publish(OPS_STATE_UPDATES_CHANNEL, JSON.stringify(event));
}

export async function readOpsControlSettings(
  redis?: IORedis,
): Promise<RunnerControlSettings> {
  return withControlRedis(redis, (connection) =>
    readRunnerControlSettings(connection),
  );
}

export async function createOpsStateUpdatesSubscriber(): Promise<OpsStateUpdatesSubscriber> {
  const redis = createRedisConnection();
  await redis.subscribe(OPS_STATE_UPDATES_CHANNEL);

  let pendingSignals = 0;
  let closed = false;
  const waiters = new Set<(value: "message") => void>();

  const onMessage = (channel: string): void => {
    if (closed || channel !== OPS_STATE_UPDATES_CHANNEL) {
      return;
    }

    if (waiters.size > 0) {
      const [first] = waiters;
      if (first) {
        waiters.delete(first);
        first("message");
        return;
      }
    }

    pendingSignals += 1;
  };

  redis.on("message", onMessage);

  return {
    waitForUpdate: async (timeoutMs: number) => {
      if (closed) {
        return "timeout";
      }

      if (pendingSignals > 0) {
        pendingSignals -= 1;
        return "message";
      }

      return new Promise<"message" | "timeout">((resolve) => {
        const timer = setTimeout(
          () => {
            waiters.delete(onSignal);
            resolve("timeout");
          },
          Math.max(1, timeoutMs),
        );

        const onSignal = (): void => {
          clearTimeout(timer);
          waiters.delete(onSignal);
          resolve("message");
        };

        waiters.add(onSignal);
      });
    },
    close: async () => {
      closed = true;
      redis.off("message", onMessage);
      for (const waiter of waiters) {
        waiter("message");
      }
      waiters.clear();
      await redis.unsubscribe(OPS_STATE_UPDATES_CHANNEL).catch(() => undefined);
      await redis.quit().catch(() => undefined);
    },
  };
}

export async function createOpsUiStateWatcher(input: {
  appName: string;
  snapshotTimeoutMs?: number;
  minRefreshIntervalMs?: number;
  fallbackRefreshIntervalMs?: number;
  profile?: OpsReactiveProfile;
  subscribeToSignals?: boolean;
}): Promise<OpsUiStateWatcher> {
  const profile = input.profile ?? "cli";
  const profileDefaults =
    profile === "runner-lite"
      ? {
          minRefreshIntervalMs: 5000,
          fallbackRefreshIntervalMs: 15000,
          subscribeToSignals: false,
        }
      : {
          minRefreshIntervalMs: 1000,
          fallbackRefreshIntervalMs: 5000,
          subscribeToSignals: true,
        };

  const snapshotTimeoutMs = Math.max(1000, input.snapshotTimeoutMs ?? 8000);
  const minRefreshIntervalMs = Math.max(
    0,
    input.minRefreshIntervalMs ?? profileDefaults.minRefreshIntervalMs,
  );
  const fallbackRefreshIntervalMs = Math.max(
    1000,
    input.fallbackRefreshIntervalMs ??
      profileDefaults.fallbackRefreshIntervalMs,
  );
  const subscribeToSignals =
    input.subscribeToSignals ?? profileDefaults.subscribeToSignals;

  const subscriber = subscribeToSignals
    ? await createOpsStateUpdatesSubscriber().catch(() => null)
    : null;
  const queueEventsConnection = subscribeToSignals
    ? createRedisConnection()
    : null;
  const queueEvents = queueEventsConnection
    ? new QueueEvents(IMAGE_QUEUE_NAME, {
        connection: queueEventsConnection,
      })
    : null;
  if (queueEvents) {
    await queueEvents.waitUntilReady().catch(() => undefined);
  }
  const trendRedis = createRedisConnection();
  const signalTrendMetrics: OpsTrendMetricName[] = [
    "queueBacklog",
    "processedItems",
    "failedItems",
    "workersRunning",
    "queueWaiting",
    "queueActive",
    "queueDelayed",
    "queuePaused",
    "queueCompleted",
    "queueFailed",
    "pendingSuccessBuffer",
    "pendingErrorBuffer",
    "flushBatchCount",
  ];
  let snapshot: OpsUiSnapshot | null = null;
  let trendPoints: OpsTrendPoint[] = [];
  let lastRefreshAtMs = 0;
  let refreshInFlight: Promise<OpsUiSnapshot> | null = null;
  let stateVersion = 0;
  let closed = false;
  let loopInFlight: Promise<void> | null = null;
  let queueSignalPending = false;
  const stateWaiters = new Set<() => void>();
  const listeners = new Set<() => void>();

  const onQueueSignal = (): void => {
    queueSignalPending = true;
  };

  if (queueEvents) {
    queueEvents.on("active", onQueueSignal);
    queueEvents.on("completed", onQueueSignal);
    queueEvents.on("failed", onQueueSignal);
    queueEvents.on("waiting", onQueueSignal);
    queueEvents.on("delayed", onQueueSignal);
    queueEvents.on("progress", onQueueSignal);
  }

  const notifyState = (): void => {
    stateVersion += 1;
    for (const listener of listeners) {
      listener();
    }
    for (const waiter of stateWaiters) {
      waiter();
    }
    stateWaiters.clear();
  };

  const refresh = async (force: boolean): Promise<OpsUiSnapshot> => {
    if (closed) {
      throw new Error("state watcher closed");
    }
    const now = Date.now();
    if (!force && snapshot && now - lastRefreshAtMs < minRefreshIntervalMs) {
      return snapshot;
    }
    if (refreshInFlight) {
      return refreshInFlight;
    }

    refreshInFlight = readOpsUiSnapshot(input.appName, snapshotTimeoutMs)
      .then((nextSnapshot) => {
        snapshot = nextSnapshot;
        lastRefreshAtMs = Date.now();
        notifyState();
        return nextSnapshot;
      })
      .finally(() => {
        refreshInFlight = null;
      });
    return refreshInFlight;
  };

  const applySignalTrendRefresh = async (): Promise<boolean> => {
    if (closed || !snapshot) {
      return false;
    }

    const latest = await readOpsRunnerTrendLatest({
      metricNames: signalTrendMetrics,
      redis: trendRedis,
    });

    const queueBacklog = latest.queueBacklog;
    const processedItems = latest.processedItems;
    const failedItems = latest.failedItems;
    const workersRunning = latest.workersRunning;
    const queueWaiting = latest.queueWaiting;
    const queueActive = latest.queueActive;
    const queueDelayed = latest.queueDelayed;
    const queuePaused = latest.queuePaused;
    const queueCompleted = latest.queueCompleted;
    const queueFailed = latest.queueFailed;
    const pendingSuccessBuffer = latest.pendingSuccessBuffer;
    const pendingErrorBuffer = latest.pendingErrorBuffer;
    const flushBatchCount = latest.flushBatchCount;
    if (
      !queueBacklog ||
      !processedItems ||
      !failedItems ||
      !workersRunning ||
      !queueWaiting ||
      !queueActive ||
      !queueDelayed ||
      !queuePaused ||
      !queueCompleted ||
      !queueFailed ||
      !pendingSuccessBuffer ||
      !pendingErrorBuffer ||
      !flushBatchCount
    ) {
      return false;
    }

    const atMs = Math.max(
      queueBacklog.atMs,
      processedItems.atMs,
      failedItems.atMs,
      workersRunning.atMs,
    );
    const lastAtMs = trendPoints[trendPoints.length - 1]?.atMs ?? 0;
    if (atMs <= lastAtMs) {
      return false;
    }

    trendPoints.push({
      atMs,
      queueBacklog: queueBacklog.value,
      processedItems: processedItems.value,
      failedItems: failedItems.value,
      workersRunning: workersRunning.value,
    });
    if (trendPoints.length > OPS_TREND_HISTORY_MAX) {
      trendPoints = trendPoints.slice(
        trendPoints.length - OPS_TREND_HISTORY_MAX,
      );
    }

    const nextUpdatedAt = new Date().toISOString();
    const nextQueue = snapshot.queue
      ? {
          ...snapshot.queue,
          waiting: queueWaiting.value,
          active: queueActive.value,
          delayed: queueDelayed.value,
          paused: queuePaused.value,
          completed: queueCompleted.value,
          failed: queueFailed.value,
          backlog:
            queueWaiting.value +
            queueActive.value +
            queueDelayed.value +
            queuePaused.value,
        }
      : snapshot.queue;

    const nextStatus = snapshot.status
      ? {
          ...snapshot.status,
          workersRunning: workersRunning.value,
          processedItems: processedItems.value,
          failedItems: failedItems.value,
          queueWaiting: queueWaiting.value,
          queueActive: queueActive.value,
          queueCompleted: queueCompleted.value,
          queueFailed: queueFailed.value,
          queueDelayed: queueDelayed.value,
          queuePaused: queuePaused.value,
          queueBacklog: queueBacklog.value,
          pendingSuccessBuffer: pendingSuccessBuffer.value,
          pendingErrorBuffer: pendingErrorBuffer.value,
          flushBatchCount: flushBatchCount.value,
          updatedAt: nextUpdatedAt,
        }
      : snapshot.status;

    const nextInfra = snapshot.infra
      ? {
          ...snapshot.infra,
          workersRunning: workersRunning.value,
          updatedAt: nextUpdatedAt,
        }
      : snapshot.infra;

    snapshot = {
      ...snapshot,
      at: nextUpdatedAt,
      queue: nextQueue,
      status: nextStatus,
      infra: nextInfra,
      projections: deriveOpsTrendProjection(trendPoints),
    };
    lastRefreshAtMs = Date.now();
    notifyState();
    return true;
  };

  const sleep = async (ms: number): Promise<void> => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.max(1, ms));
    });
  };

  const startWatcherLoop = (): void => {
    if (loopInFlight) {
      return;
    }

    loopInFlight = (async () => {
      while (!closed) {
        let touchedState = false;

        if (subscriber) {
          const signal = await subscriber.waitForUpdate(500);
          if (closed) {
            break;
          }

          if (signal === "message") {
            const updated = await applySignalTrendRefresh();
            if (!updated) {
              await refresh(false);
            }
            touchedState = true;
          }
        }

        if (queueSignalPending) {
          queueSignalPending = false;
          await refresh(false);
          touchedState = true;
        }

        const ageMs = Date.now() - lastRefreshAtMs;
        if (ageMs >= fallbackRefreshIntervalMs) {
          await refresh(true);
          touchedState = true;
        }

        if (!subscriber && !touchedState) {
          await sleep(Math.min(500, fallbackRefreshIntervalMs));
        }
      }
    })().finally(() => {
      loopInFlight = null;
    });
  };

  await refresh(true);
  trendPoints = await readOpsTrendHistory(OPS_TREND_HISTORY_MAX, trendRedis)
    .then((rows) => rows.slice(-OPS_TREND_HISTORY_MAX))
    .catch(() => []);
  if (snapshot && trendPoints.length > 0) {
    snapshot = {
      ...snapshot,
      projections: deriveOpsTrendProjection(trendPoints),
    };
  }
  startWatcherLoop();

  return {
    getSnapshot: () => snapshot,
    refreshNow: async () => refresh(true),
    getStateVersion: () => stateVersion,
    hasStateChangedSince: (version: number) => stateVersion !== version,
    onStateChange: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    waitForState: async (timeoutMs: number) => {
      if (closed) {
        return "timeout";
      }

      const beforeVersion = stateVersion;
      return new Promise<"state" | "timeout">((resolve) => {
        const timer = setTimeout(
          () => {
            stateWaiters.delete(onState);
            resolve("timeout");
          },
          Math.max(1, timeoutMs),
        );

        const onState = (): void => {
          clearTimeout(timer);
          stateWaiters.delete(onState);
          resolve("state");
        };

        stateWaiters.add(onState);
        if (stateVersion !== beforeVersion) {
          onState();
        }
      });
    },
    close: async () => {
      closed = true;
      for (const waiter of stateWaiters) {
        waiter();
      }
      stateWaiters.clear();
      listeners.clear();
      if (subscriber) {
        await subscriber.close();
      }
      if (queueEvents) {
        queueEvents.off("active", onQueueSignal);
        queueEvents.off("completed", onQueueSignal);
        queueEvents.off("failed", onQueueSignal);
        queueEvents.off("waiting", onQueueSignal);
        queueEvents.off("delayed", onQueueSignal);
        queueEvents.off("progress", onQueueSignal);
        await queueEvents.close().catch(() => undefined);
      }
      if (queueEventsConnection) {
        await queueEventsConnection.quit().catch(() => undefined);
      }
      await trendRedis.quit().catch(() => undefined);
      if (loopInFlight) {
        await loopInFlight;
      }
    },
  };
}

export async function createOpsQueueRuntime(input?: {
  withEvents?: boolean;
}): Promise<OpsQueueRuntime> {
  const queueConnection = createRedisConnection();
  const queue = createImageQueue(queueConnection);
  const withEvents = Boolean(input?.withEvents);
  let queueEventsConnection: IORedis | null = null;
  let queueEvents: QueueEvents | null = null;

  if (withEvents) {
    queueEventsConnection = createRedisConnection();
    queueEvents = new QueueEvents(IMAGE_QUEUE_NAME, {
      connection: queueEventsConnection,
    });
    await queueEvents.waitUntilReady();
  }

  return {
    queue,
    queueEvents,
    close: async () => {
      if (queueEvents) {
        await queueEvents.close().catch(() => undefined);
      }
      if (queueEventsConnection) {
        await queueEventsConnection.quit().catch(() => undefined);
      }
      await queue.close().catch(() => undefined);
      await queueConnection.quit().catch(() => undefined);
    },
  };
}

export async function waitForOpsRunCompletion(input: {
  queueEvents: QueueEvents;
  queueName: string;
  expectedJobs: number;
  timeoutMs: number;
  onProgress: (state: {
    completed: number;
    failed: number;
    expected: number;
    processedItems: number;
    failedItems: number;
    completedJobIds: string[];
    failedJobIds: string[];
  }) => void;
}): Promise<{ completedJobIds: string[]; failedJobIds: string[] }> {
  const completedSet = new Set<string>();
  const failedSet = new Set<string>();
  const progressByJob = new Map<
    string,
    { succeeded: number; failed: number }
  >();

  const summarizeLiveItems = (): {
    processedItems: number;
    failedItems: number;
  } => {
    let processedItems = 0;
    let failedItems = 0;

    for (const entry of progressByJob.values()) {
      processedItems += Math.max(0, Number(entry.succeeded) || 0);
      failedItems += Math.max(0, Number(entry.failed) || 0);
    }

    // If a job failed before reporting structured progress, treat it as one failed item.
    for (const failedJobId of failedSet) {
      if (!progressByJob.has(failedJobId)) {
        failedItems += 1;
      }
    }

    return { processedItems, failedItems };
  };

  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `timeout waiting for queue completion queue=${input.queueName} completed=${completedSet.size} failed=${failedSet.size} expected=${input.expectedJobs}`,
        ),
      );
    }, input.timeoutMs);

    const maybeDone = (): void => {
      const liveItems = summarizeLiveItems();
      input.onProgress({
        completed: completedSet.size,
        failed: failedSet.size,
        expected: input.expectedJobs,
        processedItems: liveItems.processedItems,
        failedItems: liveItems.failedItems,
        completedJobIds: [...completedSet],
        failedJobIds: [...failedSet],
      });

      if (completedSet.size + failedSet.size >= input.expectedJobs) {
        cleanup();
        resolve({
          completedJobIds: [...completedSet],
          failedJobIds: [...failedSet],
        });
      }
    };

    const onCompleted = (event: { jobId: string }): void => {
      completedSet.add(String(event.jobId));
      maybeDone();
    };

    const onFailed = (event: { jobId: string }): void => {
      failedSet.add(String(event.jobId));
      maybeDone();
    };

    const onProgressEvent = (event: { jobId: string; data: unknown }): void => {
      const jobId = String(event?.jobId || "");
      if (!jobId) {
        return;
      }

      const payload =
        event?.data &&
        typeof event.data === "object" &&
        !Array.isArray(event.data)
          ? (event.data as Record<string, unknown>)
          : null;

      if (!payload) {
        return;
      }

      const succeeded = Number(payload.succeeded);
      const failed = Number(payload.failed);
      if (!Number.isFinite(succeeded) && !Number.isFinite(failed)) {
        return;
      }

      progressByJob.set(jobId, {
        succeeded: Number.isFinite(succeeded) ? Math.max(0, succeeded) : 0,
        failed: Number.isFinite(failed) ? Math.max(0, failed) : 0,
      });
      maybeDone();
    };

    const cleanup = (): void => {
      clearTimeout(timeout);
      input.queueEvents.off("completed", onCompleted);
      input.queueEvents.off("failed", onFailed);
      input.queueEvents.off("progress", onProgressEvent);
    };

    input.queueEvents.on("completed", onCompleted);
    input.queueEvents.on("failed", onFailed);
    input.queueEvents.on("progress", onProgressEvent);
  });
}

export async function listOpsPendingJobsForOperation(
  queue: Queue<ImageProcessingQueueJob>,
  operationId: string,
): Promise<Array<{ id: string; remove: () => Promise<void> }>> {
  const jobs = await queue.getJobs(["waiting", "delayed", "paused"], 0, -1);
  return jobs
    .filter(
      (job) =>
        (job.data as ImageProcessingQueueJob).operationId === operationId,
    )
    .map((job) => ({
      id: String(job.id || ""),
      remove: async () => {
        await job.remove();
      },
    }));
}

export async function enqueueOpsImageJobsForOperation(input: {
  queue: Queue<ImageProcessingQueueJob>;
  operationId: string;
  claimedItems: OpsClaimedItem[];
  options: OpsEnqueueOptions;
}): Promise<Job<ImageProcessingQueueJob>[]> {
  return Promise.all(
    input.claimedItems.map((item, index) =>
      input.queue.add(
        "process-image",
        {
          operationId: input.operationId,
          batchId: `${input.operationId}-job-${String(index + 1).padStart(5, "0")}`,
          batchIndex: index,
          batchCount: input.claimedItems.length,
          workId: item.workId,
          sourceType: "url",
          sourceImageUrl: item.sourceImageUrl,
          fetchTimeoutMs: input.options.fetchTimeoutMs,
          fetchRetryCount: input.options.fetchRetryCount,
          dryRun: input.options.dryRunCloud,
          uploadPrefix: input.options.uploadPrefix,
          verboseLogs: false,
          sleepSecondsPerItem: 0,
        } satisfies ImageProcessingQueueJob,
        {
          // Keep enough completed/failed jobs to allow end-of-run result reload.
          removeOnComplete: input.options.jobRetentionCount,
          removeOnFail: input.options.jobRetentionCount,
        },
      ),
    ),
  );
}

export async function setOpsBacklogForOperation(input: {
  queue: Queue<ImageProcessingQueueJob>;
  operationId: string;
  target: number;
  nextIndex: number;
}): Promise<number> {
  const jobs = await listOpsPendingJobsForOperation(
    input.queue,
    input.operationId,
  );
  const current = jobs.length;

  if (current < input.target) {
    const addCount = input.target - current;
    await Promise.all(
      Array.from({ length: addCount }).map((_, idx) =>
        input.queue.add(
          "sim-image-job",
          makeSimJob(input.operationId, input.nextIndex + idx),
          {
            removeOnComplete: 200,
            removeOnFail: 200,
          },
        ),
      ),
    );
    return input.nextIndex + addCount;
  }

  if (current > input.target) {
    const removeCount = current - input.target;
    await Promise.all(
      jobs
        .slice(0, removeCount)
        .map((job) => job.remove().catch(() => undefined)),
    );
  }

  return input.nextIndex;
}

export async function writeOpsControlSettings(
  settings: RunnerControlSettings,
  redis?: IORedis,
): Promise<void> {
  await withControlRedis(redis, async (connection) => {
    await writeRunnerControlSettings(connection, settings);
    await publishOpsStateUpdate(connection, {
      at: new Date().toISOString(),
      source: "writeOpsControlSettings",
      fields: ["settings"],
    });
  });
}

export async function updateOpsControlSettings(
  updater: (current: RunnerControlSettings) => RunnerControlSettings,
  redis?: IORedis,
): Promise<RunnerControlSettings> {
  return withControlRedis(redis, async (connection) => {
    const current = await readRunnerControlSettings(connection);
    const next = updater(current);
    await writeRunnerControlSettings(connection, next);
    await publishOpsStateUpdate(connection, {
      at: new Date().toISOString(),
      source: "updateOpsControlSettings",
      fields: ["settings"],
    });
    return next;
  });
}

export async function readOpsControlSnapshot(redis?: IORedis): Promise<{
  settings: RunnerControlSettings;
  infra: RunnerInfraSnapshot | null;
  status: RunnerStatusSnapshot | null;
}> {
  return withControlRedis(redis, async (connection) => {
    const [settings, infra, status] = await Promise.all([
      readRunnerControlSettings(connection),
      readRunnerInfraSnapshot(connection),
      readRunnerStatus(connection),
    ]);
    return { settings, infra, status };
  });
}

export async function readOpsSharedState(
  redis?: IORedis,
): Promise<OpsSharedState> {
  const [queue, db, control] = await Promise.all([
    readOpsQueueSnapshot(),
    readOpsDbProgress(),
    readOpsControlSnapshot(redis),
  ]);

  return {
    queue,
    db,
    settings: control.settings,
    infra: control.infra,
    status: control.status,
  };
}

export async function readOpsQueueSnapshot(): Promise<ImageQueueCounts> {
  return readImageQueueCounts();
}

export async function readOpsQueuePausedState(): Promise<boolean> {
  return readImageQueuePausedState();
}

export async function setOpsQueuePaused(
  paused: boolean,
  redis?: IORedis,
): Promise<boolean> {
  const nextPaused = await setImageQueuePaused(paused);
  await withControlRedis(redis, async (connection) => {
    await publishOpsStateUpdate(connection, {
      at: new Date().toISOString(),
      source: "setOpsQueuePaused",
      fields: ["queue"],
    });
  });
  return nextPaused;
}

export async function pauseOpsSystemFlow(redis?: IORedis): Promise<{
  settings: RunnerControlSettings;
  queuePaused: boolean;
}> {
  const settings = await updateOpsControlSettings(
    (current) => ({
      ...current,
      desiredMode: "idle",
      enqueueEnabled: false,
    }),
    redis,
  );
  const queuePaused = await setOpsQueuePaused(true, redis);
  return { settings, queuePaused };
}

export async function resumeOpsSystemFlow(redis?: IORedis): Promise<{
  settings: RunnerControlSettings;
  queuePaused: boolean;
}> {
  const settings = await updateOpsControlSettings(
    (current) => ({
      ...current,
      desiredMode: "run",
      enqueueEnabled: true,
    }),
    redis,
  );
  const queuePaused = await setOpsQueuePaused(false, redis);
  return { settings, queuePaused };
}

export async function clearOpsQueueIfPaused(redis?: IORedis): Promise<{
  queuePaused: boolean;
  purge: QueuePurgeResult;
}> {
  const queuePaused = await readOpsQueuePausedState();
  if (!queuePaused) {
    throw new Error("queue clear blocked: pause the queue first");
  }

  const purge = await purgePendingImageQueueJobs();
  await withControlRedis(redis, async (connection) => {
    await publishOpsStateUpdate(connection, {
      at: new Date().toISOString(),
      source: "clearOpsQueueIfPaused",
      fields: ["queue"],
    });
  });

  return { queuePaused, purge };
}

export async function readOpsDbProgress(): Promise<OpsDbProgress> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    return null;
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  try {
    const [{ rows: processedRows }, { rows: pendingRows }] = await Promise.all([
      pool.query<{ count: string }>(
        "select count(*)::bigint as count from listing_source_image where status = 'processed_site'",
      ),
      pool.query<{ count: string }>(
        `select count(*)::bigint as count
         from listing_source_image lsi
         join listing_source_link lsl on lsl.id = lsi.source_link_id
         where lsi.site_image is null
           and coalesce(lsi.source_image_url, '') <> ''
           and lsl.source_status = 'active'
           and lsl.active_to is null`,
      ),
    ]);

    const processed = Number(processedRows[0]?.count || 0);
    const pending = Number(pendingRows[0]?.count || 0);
    const total = processed + pending;

    return {
      processed,
      pending,
      total,
      pct: total > 0 ? (processed / total) * 100 : 0,
    };
  } finally {
    await pool.end();
  }
}

export async function readOpsUiSnapshot(
  appName: string,
  timeoutMs = 8000,
): Promise<OpsUiSnapshot> {
  const projectionLimit = OPS_TREND_PROJECTION_DEFAULT_LIMIT;
  const projectionAnchorAtMs = Date.now();
  const projectionWindowMs = projectionLimit * 1000;

  const snapshot: OpsUiSnapshot = {
    at: new Date().toISOString(),
    machines: null,
    queue: null,
    db: null,
    settings: null,
    infra: null,
    status: null,
    projections: deriveOpsTrendProjection([]),
    errors: {},
  };

  try {
    const fly = await withTimeout(
      "fly",
      timeoutMs,
      refreshOpsInfraFromFly(appName),
    );
    snapshot.machines = fly.machines;
    snapshot.infra = fly.infra;
  } catch (error) {
    snapshot.errors.fly = shortError(error);
  }

  const [shared, trendProjection] = await Promise.allSettled([
    withTimeout("shared", timeoutMs, readOpsSharedState()),
    withTimeout(
      "trend",
      timeoutMs,
      readOpsTrendProjectionSampled({
        limit: projectionLimit,
        sampleMode: "interpolated",
        sampleAnchorAtMs: projectionAnchorAtMs,
        sampleWindowMs: projectionWindowMs,
      }),
    ),
  ]);

  if (shared.status === "fulfilled") {
    snapshot.queue = shared.value.queue;
    snapshot.db = shared.value.db;
    snapshot.settings = shared.value.settings;
    snapshot.infra = shared.value.infra;
    snapshot.status = shared.value.status;
  } else {
    const message = shortError(shared.reason);
    snapshot.errors.queue = message;
    snapshot.errors.db = message;
    snapshot.errors.control = message;
  }

  if (trendProjection.status === "fulfilled") {
    snapshot.projections = trendProjection.value;
  }

  await writeOpsUiTrendMetrics(snapshot);

  return snapshot;
}

export async function scaleOpsWorkers(
  appName: string,
  count: number,
): Promise<void> {
  await scaleFlyWorkers(appName, count);
}

export async function readOpsFlyMachines(
  appName: string,
): Promise<FlyMachine[]> {
  return fetchFlyMachines(appName);
}

export async function refreshOpsInfraFromFly(
  appName: string,
  redis?: IORedis,
): Promise<{ machines: FlyMachine[]; infra: RunnerInfraSnapshot }> {
  const machines = await fetchFlyMachines(appName);
  const workersRunning = machines.filter(
    (machine) => String(machine.state || "").toLowerCase() === "started",
  ).length;
  const infra: RunnerInfraSnapshot = {
    workersRunning,
    source: "image-ops-module:fly-api",
    updatedAt: new Date().toISOString(),
  };
  await writeOpsInfraSnapshot(infra, redis);
  return { machines, infra };
}

function sourceStatusForErrorCode(code: string): string {
  if (code === "source_403") {
    return "failed_source_exception_403";
  }
  if (code === "source_429") {
    return "failed_source_exception_429";
  }
  if (code === "source_404") {
    return "failed_source_retry_later_404";
  }
  if (code === "source_5xx") {
    return "failed_source_retry_later_5xx";
  }
  return "failed_trigger";
}

export function createOpsDbPool(max = 6): Pool {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("Missing DATABASE_URL");
  }
  return new Pool({ connectionString: databaseUrl, max });
}

export async function claimPendingImageRows(
  pool: Pool,
  targetCount: number,
  claimPoolSize: number,
): Promise<OpsClaimedItem[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const query = `
      with candidate_pool as (
        select
          lsi.id,
          lsi.source_image_url,
          coalesce(
            nullif(substring(lsi.source_image_url from '^https?://([^/]+)'), ''),
            'unknown-host'
          ) as source_host
        from listing_source_image lsi
        join listing_source_link lsl
          on lsl.id = lsi.source_link_id
        where lsi.site_image is null
          and coalesce(lsi.source_image_url, '') <> ''
          and lsl.source_status = 'active'
          and lsl.active_to is null
          and (
            lsi.status in (
              'pending',
              'ready_source',
              'failed_trigger',
              'failed_source_403',
              'failed_source_exception_403',
              'failed_source_exception_429',
              'failed_source_retry_later_404',
              'failed_source_retry_later_5xx',
              'failed_cloakbrowser_recovery'
            )
            or (
              lsi.status in ('processing_worker', 'processing_trigger')
              and lsi.updated_at < (now() - interval '30 minutes')
            )
          )
        order by random(), lsi.id
        limit $2
        for update of lsi skip locked
      ),
      ranked as (
        select
          candidate_pool.id,
          candidate_pool.source_image_url,
          row_number() over (
            partition by candidate_pool.source_host
            order by random(), candidate_pool.id
          ) as host_round,
          random() as tie_breaker
        from candidate_pool
      ),
      picked as (
        select ranked.id, ranked.source_image_url
        from ranked
        order by ranked.host_round asc, ranked.tie_breaker asc
        limit $1
      )
      update listing_source_image lsi
      set
        status = 'processing_worker',
        error_payload = coalesce(lsi.error_payload, '{}'::jsonb) || jsonb_build_object(
          'bullmq_attempt_started_at', now()::text
        ),
        updated_at = now()
      from picked
      where lsi.id = picked.id
      returning lsi.id, lsi.source_image_url
    `;

    const { rows } = await client.query(query, [targetCount, claimPoolSize]);
    await client.query("COMMIT");
    return rows.map((row) => ({
      workId: String(row.id),
      sourceImageUrl: String(row.source_image_url),
    }));
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function applySuccessRows(
  pool: Pool,
  items: ImageProcessingItemResult[],
): Promise<{ uploadedCount: number; notUploadedCount: number }> {
  let uploadedCount = 0;
  let notUploadedCount = 0;

  for (const item of items) {
    const storedStatus = String(item.stored_status_on_s3 || "unknown");
    const isUploaded = storedStatus === "uploaded";

    const info = {
      source_mode: "url",
      source_content_hash: item.calculated_hash ?? null,
      transformed_content_hash: item.transformed_hash ?? null,
      source_fetch_mode: item.source_fetch_mode ?? null,
      source_http_status: item.source_http_status ?? null,
      transformed_bytes: item.transformed_bytes ?? null,
      source_width: item.source_width ?? null,
      source_height: item.source_height ?? null,
      transformed_width: item.transformed_width ?? null,
      transformed_height: item.transformed_height ?? null,
      fetch_elapsed_ms: item.fetch_elapsed_ms ?? null,
      transform_elapsed_ms: item.transform_elapsed_ms ?? null,
      upload_elapsed_ms: item.upload_elapsed_ms ?? null,
      upload_skipped_existing: item.upload_skipped_existing ?? null,
      target_width: item.target_width ?? null,
      target_height: item.target_height ?? null,
      below_target_hd: item.below_target_hd ?? null,
      stored_status_on_s3: item.stored_status_on_s3 ?? null,
      processed_at: new Date().toISOString(),
      pipeline: "bullmq",
    };

    if (isUploaded) {
      await pool.query(
        `
        update listing_source_image
        set
          status = 'processed_site',
          source_content_hash = $2,
          site_image = $3,
          error_payload = coalesce(error_payload, '{}'::jsonb) || $4::jsonb,
          updated_at = now()
        where id = $1
        `,
        [
          String(item.work_id),
          String(item.calculated_hash || ""),
          String(item.final_name || ""),
          JSON.stringify(info),
        ],
      );
      uploadedCount += 1;
    } else {
      const notUploadedPayload = {
        ...info,
        error_stage: "storage_finalize",
        error_code: "storage_not_uploaded",
        error_message:
          "worker item did not reach definitive uploaded S3 status; completion withheld",
      };

      await pool.query(
        `
        update listing_source_image
        set
          status = 'failed_trigger',
          error_payload = coalesce(error_payload, '{}'::jsonb) || $2::jsonb,
          updated_at = now()
        where id = $1
        `,
        [String(item.work_id), JSON.stringify(notUploadedPayload)],
      );
      notUploadedCount += 1;
    }
  }

  return { uploadedCount, notUploadedCount };
}

export async function applyFailureRows(
  pool: Pool,
  rows: ImageProcessingTaskError[],
  marker: string,
): Promise<void> {
  for (const errorRow of rows) {
    const code = String(errorRow.code || "worker_error");
    const status = sourceStatusForErrorCode(code);

    const payload = {
      error_stage: marker,
      error_code: code,
      error_message: String(errorRow.message || "unknown error"),
      failed_at: new Date().toISOString(),
      source_image_url: errorRow.source_image_url || null,
      pipeline: "bullmq",
    };

    await pool.query(
      `
      update listing_source_image
      set
        status = $2,
        error_payload = coalesce(error_payload, '{}'::jsonb) || $3::jsonb,
        updated_at = now()
      where id = $1
      `,
      [String(errorRow.work_id), status, JSON.stringify(payload)],
    );
  }
}

export async function writeOpsInfraSnapshot(
  snapshot: RunnerInfraSnapshot,
  redis?: IORedis,
): Promise<void> {
  await withControlRedis(redis, async (connection) => {
    await writeRunnerInfraSnapshot(connection, snapshot);
    await publishOpsStateUpdate(
      connection,
      {
        at: new Date().toISOString(),
        source: "writeOpsInfraSnapshot",
        fields: ["infra"],
      },
      { minIntervalMs: opsStateUpdatesMinIntervalMs() },
    );
  });
}

export async function writeOpsRunnerStatus(
  status: RunnerStatusSnapshot,
  redis?: IORedis,
): Promise<void> {
  await withControlRedis(redis, async (connection) => {
    await writeRunnerStatus(connection, status);
    const atMs = nextTrendTimestampMs();
    await Promise.all(
      OPS_TREND_METRIC_REGISTRY.map((metric) =>
        appendTrendMetric(
          connection,
          metric.key,
          atMs,
          metric.getValue(status),
        ),
      ),
    );
    await publishOpsStateUpdate(
      connection,
      {
        at: new Date().toISOString(),
        source: "writeOpsRunnerStatus",
        fields: ["status", "trend"],
      },
      { minIntervalMs: opsStateUpdatesMinIntervalMs() },
    );
  });
}

export async function readOpsTrendHistory(
  limit = 120,
  redis?: IORedis,
): Promise<OpsTrendPoint[]> {
  const boundedLimit = Math.max(1, Math.min(OPS_TREND_HISTORY_MAX, limit));
  return withControlRedis(redis, async (connection) => {
    const rowsByMetric = await readTrendMetricRowsBatch(
      connection,
      [
        { name: "queueBacklog", key: OPS_TREND_METRIC_KEYS.queueBacklog },
        { name: "processedItems", key: OPS_TREND_METRIC_KEYS.processedItems },
        { name: "failedItems", key: OPS_TREND_METRIC_KEYS.failedItems },
        { name: "workersRunning", key: OPS_TREND_METRIC_KEYS.workersRunning },
      ],
      boundedLimit,
    );

    const queueBacklogRows =
      rowsByMetric.find((row) => row.name === "queueBacklog")?.rows || [];
    const processedRows =
      rowsByMetric.find((row) => row.name === "processedItems")?.rows || [];
    const failedRows =
      rowsByMetric.find((row) => row.name === "failedItems")?.rows || [];
    const workersRows =
      rowsByMetric.find((row) => row.name === "workersRunning")?.rows || [];

    const count = Math.max(
      0,
      Math.min(
        queueBacklogRows.length,
        processedRows.length,
        failedRows.length,
        workersRows.length,
      ),
    );

    const points: OpsTrendPoint[] = [];
    for (let index = 0; index < count; index += 1) {
      points.push({
        atMs: queueBacklogRows[index].atMs,
        queueBacklog: queueBacklogRows[index].value,
        processedItems: processedRows[index].value,
        failedItems: failedRows[index].value,
        workersRunning: workersRows[index].value,
      });
    }
    return points;
  });
}

export async function readOpsTrendProjection(
  limit = OPS_TREND_PROJECTION_DEFAULT_LIMIT,
  redis?: IORedis,
): Promise<OpsTrendProjection> {
  const points = await readOpsTrendHistory(limit, redis);
  return deriveOpsTrendProjection(points);
}

export async function readOpsTrendProjectionSampled(input?: {
  limit?: number;
  sampleMode?: OpsTrendSampleMode;
  sampleMaxGapMs?: number;
  sampleMaxAgeMs?: number;
  sampleAnchorAtMs?: number;
  sampleWindowMs?: number;
  redis?: IORedis;
}): Promise<OpsTrendProjection> {
  const limit = Math.max(
    1,
    Math.min(
      OPS_TREND_HISTORY_MAX,
      input?.limit ?? OPS_TREND_PROJECTION_DEFAULT_LIMIT,
    ),
  );
  const sampleMode = input?.sampleMode ?? "raw";
  const sampleMaxGapMs = input?.sampleMaxGapMs;
  const sampleMaxAgeMs = input?.sampleMaxAgeMs;
  const sampleAnchorAtMs = input?.sampleAnchorAtMs;
  const sampleWindowMs = input?.sampleWindowMs;
  const pointsRaw = await readOpsTrendHistory(limit, input?.redis);
  const points =
    sampleMaxAgeMs && Number.isFinite(sampleMaxAgeMs) && sampleMaxAgeMs > 0
      ? pointsRaw.filter((point) => point.atMs >= Date.now() - sampleMaxAgeMs)
      : pointsRaw;
  if (sampleMode === "raw" || points.length === 0) {
    return deriveOpsTrendProjection(points);
  }

  const queueRows = points.map((point) => ({
    atMs: point.atMs,
    value: point.queueBacklog,
  }));
  const processedRows = points.map((point) => ({
    atMs: point.atMs,
    value: point.processedItems,
  }));
  const failedRows = points.map((point) => ({
    atMs: point.atMs,
    value: point.failedItems,
  }));
  const workerRows = points.map((point) => ({
    atMs: point.atMs,
    value: point.workersRunning,
  }));

  const useAnchoredWindow =
    Number.isFinite(sampleAnchorAtMs) &&
    Number.isFinite(sampleWindowMs) &&
    (sampleWindowMs || 0) > 0;
  const startAtMs = useAnchoredWindow
    ? Number(sampleAnchorAtMs) - Number(sampleWindowMs)
    : points[0].atMs;
  const endAtMs = useAnchoredWindow
    ? Number(sampleAnchorAtMs)
    : points[points.length - 1].atMs;
  const atMsSeries =
    limit === 1 || endAtMs <= startAtMs
      ? Array.from({ length: limit }, () => endAtMs)
      : Array.from({ length: limit }, (_, index) => {
          const ratio = index / (limit - 1);
          return Math.round(startAtMs + (endAtMs - startAtMs) * ratio);
        });

  const queueValues = sampleTrendRows(
    queueRows,
    "interpolated",
    limit,
    sampleMaxGapMs,
    {
      anchorAtMs: sampleAnchorAtMs,
      windowMs: sampleWindowMs,
    },
  );
  const processedValues = sampleTrendRows(
    processedRows,
    "interpolated",
    limit,
    sampleMaxGapMs,
    {
      anchorAtMs: sampleAnchorAtMs,
      windowMs: sampleWindowMs,
    },
  );
  const failedValues = sampleTrendRows(
    failedRows,
    "interpolated",
    limit,
    sampleMaxGapMs,
    {
      anchorAtMs: sampleAnchorAtMs,
      windowMs: sampleWindowMs,
    },
  );
  const workerValues = sampleTrendRows(
    workerRows,
    "interpolated",
    limit,
    sampleMaxGapMs,
    {
      anchorAtMs: sampleAnchorAtMs,
      windowMs: sampleWindowMs,
    },
  );

  const sampledPoints: OpsTrendPoint[] = atMsSeries.map((atMs, index) => ({
    atMs,
    queueBacklog: queueValues[index] || 0,
    processedItems: processedValues[index] || 0,
    failedItems: failedValues[index] || 0,
    workersRunning: workerValues[index] || 0,
  }));

  return deriveOpsTrendProjection(sampledPoints);
}

export async function maybePurgeForDesiredMode(input: {
  desiredMode: RunnerDesiredMode;
  queue?: ImageQueueCounts;
  infra?: RunnerInfraSnapshot | null;
}): Promise<QueuePurgeResult | null> {
  if (input.desiredMode === "stop") {
    return purgePendingImageQueueJobs();
  }

  if (input.desiredMode !== "drain") {
    return null;
  }

  const [liveQueue, liveInfra] = await Promise.all([
    input.queue ? Promise.resolve(input.queue) : readImageQueueCounts(),
    input.infra !== undefined
      ? Promise.resolve(input.infra)
      : readOpsControlSnapshot().then((snapshot) => snapshot.infra),
  ]);

  if ((liveInfra?.workersRunning ?? 0) <= 0 && liveQueue.backlog > 0) {
    return purgePendingImageQueueJobs();
  }

  return null;
}

export async function setOpsDesiredModeWithQueueAction(
  desiredMode: RunnerDesiredMode,
  redis?: IORedis,
): Promise<DesiredModeActionResult> {
  const settings = await updateOpsControlSettings(
    (current) => ({
      ...current,
      desiredMode,
    }),
    redis,
  );

  const purge = await maybePurgeForDesiredMode({ desiredMode });
  return {
    settings,
    purged: Boolean(purge),
    purge,
  };
}
