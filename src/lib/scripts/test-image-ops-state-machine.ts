import "@/core/tooling/env/load-env-profile";

import {
  deriveOpsTelemetry,
  initialOpsMachineState,
  reduceOpsMachine,
  type OpsMachineInput,
} from "../workers/image-ops-state-machine";
import type {
  RunnerControlSettings,
  RunnerStatusSnapshot,
} from "../workers/image-runner-control";

type CaseResult = {
  name: string;
  ok: boolean;
  details?: Record<string, unknown>;
};

function assertCase(
  name: string,
  condition: boolean,
  details?: Record<string, unknown>,
): CaseResult {
  return { name, ok: condition, details: condition ? undefined : details };
}

function sampleSettings(
  overrides?: Partial<RunnerControlSettings>,
): RunnerControlSettings {
  return {
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
    ...overrides,
  };
}

function sampleStatus(
  overrides?: Partial<RunnerStatusSnapshot>,
): RunnerStatusSnapshot {
  return {
    operationId: "op-1",
    mode: "idle",
    desiredMode: "run",
    gateReason: "gate=open",
    workersRunning: 2,
    claimedCount: 0,
    queuedCount: 0,
    completedJobs: 0,
    failedJobs: 0,
    processedItems: 0,
    failedItems: 0,
    queueWaiting: 10,
    queueActive: 0,
    queueCompleted: 100,
    queueFailed: 3,
    queueDelayed: 0,
    queuePaused: 0,
    queueBacklog: 10,
    lastFlushAt: null,
    flushBatchCount: 0,
    pendingSuccessBuffer: 0,
    pendingErrorBuffer: 0,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function run(): void {
  const nowMs = Date.now();
  const staleUpdatedAt = new Date(nowMs - 120_000).toISOString();

  const baseInput: OpsMachineInput = {
    settings: sampleSettings(),
    infra: {
      workersRunning: 2,
      source: "test",
      updatedAt: staleUpdatedAt,
    },
    status: sampleStatus({
      updatedAt: staleUpdatedAt,
      gateReason: "queue_backlog=124 above refill_low_watermark=120",
      queueBacklog: 124,
    }),
    queue: {
      waiting: 0,
      active: 0,
      completed: 100,
      failed: 3,
      delayed: 0,
      paused: 0,
      backlog: 0,
    },
    errors: {},
  };

  const results: CaseResult[] = [];

  const telemetry = deriveOpsTelemetry(baseInput, nowMs);
  results.push(
    assertCase(
      "telemetry stale detected",
      telemetry.runnerSnapshotIsStale === true,
      {
        runnerSnapshotIsStale: telemetry.runnerSnapshotIsStale,
      },
    ),
  );
  results.push(
    assertCase(
      "telemetry mismatch detected",
      telemetry.backlogMismatch === true,
      {
        backlogMismatch: telemetry.backlogMismatch,
        live: baseInput.queue?.backlog,
        snapshot: baseInput.status?.queueBacklog,
      },
    ),
  );
  results.push(
    assertCase(
      "telemetry stop gate",
      deriveOpsTelemetry(
        {
          ...baseInput,
          settings: sampleSettings({ desiredMode: "stop" }),
        },
        nowMs,
      ).liveGate === "live=stop_requested",
    ),
  );

  const initial = initialOpsMachineState();
  results.push(
    assertCase("initial state booting", initial.phase === "booting"),
  );

  const stateLive = reduceOpsMachine(initial, {
    type: "refresh_success",
    input: baseInput,
    nowMs,
  });
  results.push(
    assertCase("refresh_success -> live", stateLive.phase === "live", {
      phase: stateLive.phase,
    }),
  );
  results.push(
    assertCase("refresh_count increments", stateLive.refreshCount === 1, {
      refreshCount: stateLive.refreshCount,
    }),
  );

  const statePartial = reduceOpsMachine(stateLive, {
    type: "refresh_success",
    input: {
      ...baseInput,
      errors: { queue: "timeout" },
    },
    nowMs: nowMs + 1,
  });
  results.push(
    assertCase("errors -> partial", statePartial.phase === "partial", {
      phase: statePartial.phase,
    }),
  );
  results.push(
    assertCase(
      "partial increments refresh_count",
      statePartial.refreshCount === 2,
      { refreshCount: statePartial.refreshCount },
    ),
  );

  const stateError = reduceOpsMachine(statePartial, {
    type: "refresh_error",
    message: "boom",
    nowMs: nowMs + 2,
  });
  results.push(
    assertCase("refresh_error -> error", stateError.phase === "error", {
      phase: stateError.phase,
    }),
  );
  results.push(
    assertCase("error keeps refresh_count", stateError.refreshCount === 2, {
      refreshCount: stateError.refreshCount,
    }),
  );

  const failed = results.filter((row) => !row.ok);
  const payload = {
    ok: failed.length === 0,
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    failures: failed,
  };

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

run();
