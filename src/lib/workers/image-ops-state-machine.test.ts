import { describe, expect, it } from "vitest";

import {
  deriveOpsTelemetry,
  initialOpsMachineState,
  reduceOpsMachine,
  type OpsMachineInput,
} from "@/lib/workers/image-ops-state-machine";
import type {
  RunnerControlSettings,
  RunnerStatusSnapshot,
} from "@/lib/workers/image-runner-control";

function makeSettings(
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
    flushIntervalMs: 15000,
    harvestEnabled: true,
    ...overrides,
  };
}

function makeStatus(
  overrides?: Partial<RunnerStatusSnapshot>,
): RunnerStatusSnapshot {
  return {
    operationId: "op-test",
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
    queueWaiting: 0,
    queueActive: 0,
    queueCompleted: 0,
    queueFailed: 0,
    queueDelayed: 0,
    queuePaused: 0,
    queueBacklog: 0,
    lastFlushAt: null,
    flushBatchCount: 0,
    pendingSuccessBuffer: 0,
    pendingErrorBuffer: 0,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeInput(overrides?: Partial<OpsMachineInput>): OpsMachineInput {
  return {
    settings: makeSettings(),
    infra: {
      workersRunning: 2,
      source: "test",
      updatedAt: new Date().toISOString(),
    },
    status: makeStatus(),
    queue: {
      waiting: 0,
      active: 0,
      completed: 10,
      failed: 1,
      delayed: 0,
      paused: 0,
      backlog: 0,
    },
    errors: {},
    ...overrides,
  };
}

describe("deriveOpsTelemetry", () => {
  it("marks snapshot stale and mismatch when expected", () => {
    const nowMs = Date.now();
    const staleUpdatedAt = new Date(nowMs - 120_000).toISOString();
    const input = makeInput({
      status: makeStatus({
        updatedAt: staleUpdatedAt,
        queueBacklog: 124,
        gateReason: "queue_backlog=124 above refill_low_watermark=120",
      }),
      infra: {
        workersRunning: 2,
        source: "test",
        updatedAt: staleUpdatedAt,
      },
      queue: {
        waiting: 0,
        active: 0,
        completed: 10,
        failed: 1,
        delayed: 0,
        paused: 0,
        backlog: 0,
      },
    });

    const telemetry = deriveOpsTelemetry(input, nowMs);

    expect(telemetry.runnerSnapshotIsStale).toBe(true);
    expect(telemetry.snapshotGate).toContain("queue_backlog=124");
    expect(telemetry.snapshotGateLabel).toContain("[stale]");
    expect(telemetry.backlogMismatch).toBe(true);
    expect(telemetry.snapshotBacklog).toBe(124);
  });

  it("evaluates live gate from settings, queue, and workers", () => {
    const stopGate = deriveOpsTelemetry(
      makeInput({ settings: makeSettings({ desiredMode: "stop" }) }),
    );
    expect(stopGate.liveGate).toBe("live=stop_requested");

    const workersGate = deriveOpsTelemetry(
      makeInput({
        settings: makeSettings({
          desiredMode: "run",
          minWorkersToEnqueue: 3,
          requireWorkersForEnqueue: true,
        }),
        infra: {
          workersRunning: 1,
          source: "test",
          updatedAt: new Date().toISOString(),
        },
      }),
    );
    expect(workersGate.liveGate).toContain("below min_workers_to_enqueue=3");

    const backlogGate = deriveOpsTelemetry(
      makeInput({
        settings: makeSettings({ maxQueueBacklog: 5 }),
        queue: {
          waiting: 5,
          active: 0,
          completed: 0,
          failed: 0,
          delayed: 0,
          paused: 0,
          backlog: 5,
        },
      }),
    );
    expect(backlogGate.liveGate).toContain("at_or_above max_queue_backlog=5");

    const openGate = deriveOpsTelemetry(makeInput());
    expect(openGate.liveGate).toBe("live=gate_open");
  });
});

describe("ops machine reducer", () => {
  it("transitions booting -> live on successful refresh", () => {
    const initial = initialOpsMachineState();
    const next = reduceOpsMachine(initial, {
      type: "refresh_success",
      input: makeInput(),
      nowMs: Date.now(),
    });

    expect(initial.phase).toBe("booting");
    expect(next.phase).toBe("live");
    expect(next.notice).toBe("live");
    expect(next.refreshCount).toBe(1);
    expect(next.lastRefreshAtMs).not.toBeNull();
  });

  it("transitions to partial when source errors are present", () => {
    const initial = initialOpsMachineState();
    const next = reduceOpsMachine(initial, {
      type: "refresh_success",
      input: makeInput({ errors: { queue: "timeout" } }),
      nowMs: Date.now(),
    });

    expect(next.phase).toBe("partial");
    expect(next.notice).toContain("partial connectivity");
    expect(next.refreshCount).toBe(1);
  });

  it("transitions to error on refresh_error and keeps refreshCount", () => {
    const live = reduceOpsMachine(initialOpsMachineState(), {
      type: "refresh_success",
      input: makeInput(),
      nowMs: Date.now(),
    });
    const errored = reduceOpsMachine(live, {
      type: "refresh_error",
      message: "boom",
      nowMs: Date.now(),
    });

    expect(errored.phase).toBe("error");
    expect(errored.notice).toContain("refresh error: boom");
    expect(errored.refreshCount).toBe(live.refreshCount);
  });
});
