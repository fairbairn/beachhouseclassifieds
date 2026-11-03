import type {
  RunnerControlSettings,
  RunnerStatusSnapshot,
} from "./image-runner-control";

export const RUNNER_SNAPSHOT_STALE_MS = 30_000;

export function getSnapshotAgeMs(
  updatedAt: string | null | undefined,
  nowMs = Date.now(),
): number | null {
  if (!updatedAt) {
    return null;
  }
  const updatedAtMs = Date.parse(updatedAt);
  if (!Number.isFinite(updatedAtMs)) {
    return null;
  }
  return Math.max(0, nowMs - updatedAtMs);
}

export function isRunnerSnapshotStale(
  status: RunnerStatusSnapshot | null | undefined,
  nowMs = Date.now(),
): boolean {
  const ageMs = getSnapshotAgeMs(status?.updatedAt, nowMs);
  return ageMs !== null && ageMs > RUNNER_SNAPSHOT_STALE_MS;
}

export function evaluateLiveGate(input: {
  settings: RunnerControlSettings | null | undefined;
  workersRunning: number;
  queueBacklog: number;
}): string {
  const settings = input.settings;
  if (!settings) {
    return "live=unknown";
  }

  if (settings.desiredMode === "stop") {
    return "live=stop_requested";
  }

  if (!settings.enqueueEnabled) {
    return "live=enqueue_disabled";
  }

  if (
    settings.requireWorkersForEnqueue &&
    input.workersRunning < settings.minWorkersToEnqueue
  ) {
    return (
      `live=workers_running=${input.workersRunning} ` +
      `below min_workers_to_enqueue=${settings.minWorkersToEnqueue}`
    );
  }

  if (input.queueBacklog >= settings.maxQueueBacklog) {
    return (
      `live=queue_backlog=${input.queueBacklog} ` +
      `at_or_above max_queue_backlog=${settings.maxQueueBacklog}`
    );
  }

  return "live=gate_open";
}

export function hasQueueBacklogMismatch(input: {
  liveBacklog: number | null | undefined;
  snapshotBacklog: number | null | undefined;
}): boolean {
  if (
    input.liveBacklog === null ||
    input.liveBacklog === undefined ||
    input.snapshotBacklog === null ||
    input.snapshotBacklog === undefined
  ) {
    return false;
  }
  return input.liveBacklog !== input.snapshotBacklog;
}
