import {
  evaluateLiveGate,
  getSnapshotAgeMs,
  hasQueueBacklogMismatch,
  isRunnerSnapshotStale,
} from "./image-ops-telemetry";
import type { ImageQueueCounts } from "./image-queue-ops";
import type {
  RunnerControlSettings,
  RunnerInfraSnapshot,
  RunnerStatusSnapshot,
} from "./image-runner-control";

export type OpsMachineInput = {
  settings: RunnerControlSettings | null;
  infra: RunnerInfraSnapshot | null;
  status: RunnerStatusSnapshot | null;
  queue: ImageQueueCounts | null;
  errors: {
    fly?: string;
    queue?: string;
    db?: string;
    control?: string;
  };
};

export type OpsDerivedTelemetry = {
  runnerStaleSeconds: number | null;
  infraStaleSeconds: number | null;
  runnerSnapshotIsStale: boolean;
  snapshotGate: string;
  snapshotGateLabel: string;
  liveWorkersRunning: number;
  liveGate: string;
  snapshotBacklog: number | null;
  backlogMismatch: boolean;
};

export function deriveOpsTelemetry(
  input: OpsMachineInput,
  nowMs = Date.now(),
): OpsDerivedTelemetry {
  const runnerAgeMs = getSnapshotAgeMs(input.status?.updatedAt, nowMs);
  const infraAgeMs = getSnapshotAgeMs(input.infra?.updatedAt, nowMs);
  const runnerStaleSeconds =
    runnerAgeMs === null ? null : Math.round(runnerAgeMs / 1000);
  const infraStaleSeconds =
    infraAgeMs === null ? null : Math.round(infraAgeMs / 1000);
  const runnerSnapshotIsStale = isRunnerSnapshotStale(input.status, nowMs);

  const snapshotGate = input.status?.gateReason || "-";
  const snapshotGateLabel = runnerSnapshotIsStale
    ? `${snapshotGate} [stale]`
    : snapshotGate;

  const liveWorkersRunning = input.infra?.workersRunning ?? 0;
  const liveGate = evaluateLiveGate({
    settings: input.settings,
    workersRunning: liveWorkersRunning,
    queueBacklog: input.queue?.backlog ?? 0,
  });

  const snapshotBacklog = input.status?.queueBacklog ?? null;
  const backlogMismatch = hasQueueBacklogMismatch({
    liveBacklog: input.queue?.backlog,
    snapshotBacklog,
  });

  return {
    runnerStaleSeconds,
    infraStaleSeconds,
    runnerSnapshotIsStale,
    snapshotGate,
    snapshotGateLabel,
    liveWorkersRunning,
    liveGate,
    snapshotBacklog,
    backlogMismatch,
  };
}

export type OpsMachinePhase = "booting" | "live" | "partial" | "error";

export type OpsMachineState = {
  phase: OpsMachinePhase;
  notice: string;
  refreshCount: number;
  lastRefreshAtMs: number | null;
};

export function initialOpsMachineState(): OpsMachineState {
  return {
    phase: "booting",
    notice: "booting",
    refreshCount: 0,
    lastRefreshAtMs: null,
  };
}

export type OpsMachineEvent =
  | {
      type: "refresh_success";
      input: OpsMachineInput;
      nowMs: number;
    }
  | {
      type: "refresh_error";
      message: string;
      nowMs: number;
    };

export function reduceOpsMachine(
  previous: OpsMachineState,
  event: OpsMachineEvent,
): OpsMachineState {
  if (event.type === "refresh_error") {
    return {
      phase: "error",
      notice: `refresh error: ${event.message}`,
      refreshCount: previous.refreshCount,
      lastRefreshAtMs: event.nowMs,
    };
  }

  const errorCount = Object.keys(event.input.errors).length;
  if (errorCount > 0) {
    return {
      phase: "partial",
      notice: `partial connectivity (${errorCount} source${errorCount === 1 ? "" : "s"} degraded)`,
      refreshCount: previous.refreshCount + 1,
      lastRefreshAtMs: event.nowMs,
    };
  }

  return {
    phase: "live",
    notice: "live",
    refreshCount: previous.refreshCount + 1,
    lastRefreshAtMs: event.nowMs,
  };
}
