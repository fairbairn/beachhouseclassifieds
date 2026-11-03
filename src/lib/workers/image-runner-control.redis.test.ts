import IORedis from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  IMAGE_RUNNER_INFRA_KEY,
  IMAGE_RUNNER_SETTINGS_KEY,
  IMAGE_RUNNER_STATUS_KEY,
  defaultRunnerControlSettings,
  readRunnerControlSettings,
  readRunnerInfraSnapshot,
  readRunnerStatus,
  writeRunnerControlSettings,
  writeRunnerInfraSnapshot,
  writeRunnerStatus,
  type RunnerControlSettings,
  type RunnerInfraSnapshot,
  type RunnerStatusSnapshot,
} from "@/lib/workers/image-runner-control";

const RUN_REDIS_TESTS = process.env.IMAGE_OPS_REDIS_INTEGRATION === "1";
const describeRedis = RUN_REDIS_TESTS ? describe : describe.skip;

const redisUrl =
  process.env.IMAGE_OPS_TEST_REDIS_URL?.trim() ||
  process.env.REDIS_URL?.trim() ||
  "redis://127.0.0.1:6379";

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
    flushIntervalMs: 15_000,
    harvestEnabled: true,
    ...overrides,
  };
}

function makeInfra(
  overrides?: Partial<RunnerInfraSnapshot>,
): RunnerInfraSnapshot {
  return {
    workersRunning: 2,
    source: "test-suite",
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeStatus(
  overrides?: Partial<RunnerStatusSnapshot>,
): RunnerStatusSnapshot {
  return {
    operationId: "op-integration-test",
    mode: "running",
    desiredMode: "run",
    gateReason: "gate=open",
    workersRunning: 2,
    claimedCount: 7,
    queuedCount: 7,
    completedJobs: 10,
    failedJobs: 1,
    processedItems: 97,
    failedItems: 3,
    queueWaiting: 4,
    queueActive: 2,
    queueCompleted: 50,
    queueFailed: 2,
    queueDelayed: 1,
    queuePaused: 0,
    queueBacklog: 6,
    lastFlushAt: new Date().toISOString(),
    flushBatchCount: 5,
    pendingSuccessBuffer: 2,
    pendingErrorBuffer: 1,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describeRedis("image-runner-control redis integration", () => {
  let redis: IORedis;

  beforeAll(async () => {
    redis = new IORedis(redisUrl, {
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
    });
    await redis.ping();
  });

  afterAll(async () => {
    await redis.quit();
  });

  beforeEach(async () => {
    await redis.del(
      IMAGE_RUNNER_SETTINGS_KEY,
      IMAGE_RUNNER_INFRA_KEY,
      IMAGE_RUNNER_STATUS_KEY,
    );
  });

  it("returns defaults when settings are absent", async () => {
    const settings = await readRunnerControlSettings(redis);
    expect(settings).toEqual(defaultRunnerControlSettings());
  });

  it("roundtrips every settings field and reflects subsequent writes", async () => {
    const first = makeSettings({
      desiredMode: "drain",
      enqueueEnabled: false,
      requireWorkersForEnqueue: false,
      minWorkersToEnqueue: 0,
      maxQueueBacklog: 999,
      refillLowWatermark: 12,
      refillTargetBacklog: 800,
      maxClaimPerCycle: 77,
      flushIntervalMs: 31_000,
      harvestEnabled: false,
    });

    await writeRunnerControlSettings(redis, first);
    const firstRead = await readRunnerControlSettings(redis);
    expect(firstRead).toEqual(first);

    const second = makeSettings({
      desiredMode: "stop",
      enqueueEnabled: true,
      requireWorkersForEnqueue: true,
      minWorkersToEnqueue: 3,
      maxQueueBacklog: 1234,
      refillLowWatermark: 321,
      refillTargetBacklog: 876,
      maxClaimPerCycle: 333,
      flushIntervalMs: 45_000,
      harvestEnabled: true,
    });

    await writeRunnerControlSettings(redis, second);
    const secondRead = await readRunnerControlSettings(redis);
    expect(secondRead).toEqual(second);
  });

  it("parses and clamps settings edge values consistently", async () => {
    await redis.hset(IMAGE_RUNNER_SETTINGS_KEY, {
      desired_mode: "invalid-mode",
      enqueue_enabled: "yes",
      require_workers_for_enqueue: "off",
      min_workers_to_enqueue: "9999",
      max_queue_backlog: "3",
      refill_low_watermark: "-100",
      refill_target_backlog: "abc",
      max_claim_per_cycle: "1000000",
      flush_interval_ms: "0",
      harvest_enabled: "0",
    });

    const settings = await readRunnerControlSettings(redis);

    expect(settings).toEqual({
      desiredMode: "run",
      enqueueEnabled: true,
      requireWorkersForEnqueue: false,
      minWorkersToEnqueue: 200,
      maxQueueBacklog: 10,
      refillLowWatermark: 120,
      refillTargetBacklog: 180,
      maxClaimPerCycle: 10_000,
      flushIntervalMs: 15_000,
      harvestEnabled: false,
    });
  });

  it("roundtrips infra snapshot fields and reflects re-write", async () => {
    const first = makeInfra({ workersRunning: 4, source: "flyctl" });
    await writeRunnerInfraSnapshot(redis, first);
    expect(await readRunnerInfraSnapshot(redis)).toEqual(first);

    const second = makeInfra({ workersRunning: 0, source: "manual" });
    await writeRunnerInfraSnapshot(redis, second);
    expect(await readRunnerInfraSnapshot(redis)).toEqual(second);
  });

  it("handles infra read nulls and numeric fallback", async () => {
    expect(await readRunnerInfraSnapshot(redis)).toBeNull();

    await redis.hset(IMAGE_RUNNER_INFRA_KEY, {
      workers_running: "-123",
      source: "",
      updated_at: "2026-01-01T00:00:00.000Z",
    });

    expect(await readRunnerInfraSnapshot(redis)).toEqual({
      workersRunning: 0,
      source: "unknown",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("roundtrips every status field and reflects re-write", async () => {
    const first = makeStatus({
      operationId: "op-1",
      mode: "running",
      desiredMode: "drain",
      gateReason: "first-gate",
      workersRunning: 1,
      claimedCount: 10,
      queuedCount: 8,
      completedJobs: 100,
      failedJobs: 2,
      processedItems: 300,
      failedItems: 4,
      queueWaiting: 5,
      queueActive: 2,
      queueCompleted: 80,
      queueFailed: 7,
      queueDelayed: 3,
      queuePaused: 1,
      queueBacklog: 7,
      lastFlushAt: "2026-01-01T01:00:00.000Z",
      flushBatchCount: 9,
      pendingSuccessBuffer: 5,
      pendingErrorBuffer: 1,
      updatedAt: "2026-01-01T01:02:00.000Z",
    });

    await writeRunnerStatus(redis, first);
    expect(await readRunnerStatus(redis)).toEqual(first);

    const second = makeStatus({
      operationId: "op-2",
      mode: "stopping",
      desiredMode: "stop",
      gateReason: "second-gate",
      workersRunning: 0,
      claimedCount: 0,
      queuedCount: 0,
      completedJobs: 200,
      failedJobs: 5,
      processedItems: 450,
      failedItems: 11,
      queueWaiting: 0,
      queueActive: 0,
      queueCompleted: 120,
      queueFailed: 10,
      queueDelayed: 0,
      queuePaused: 0,
      queueBacklog: 0,
      lastFlushAt: null,
      flushBatchCount: 0,
      pendingSuccessBuffer: 0,
      pendingErrorBuffer: 0,
      updatedAt: "2026-01-01T02:02:00.000Z",
    });

    await writeRunnerStatus(redis, second);
    expect(await readRunnerStatus(redis)).toEqual(second);
  });

  it("parses status edge values and preserves structure", async () => {
    await redis.hset(IMAGE_RUNNER_STATUS_KEY, {
      operation_id: "edge-op",
      mode: "unknown-mode",
      desired_mode: "unknown-desired",
      gate_reason: "",
      workers_running: "-1",
      claimed_count: "NaN",
      queued_count: "-20",
      completed_jobs: "22",
      failed_jobs: "-9",
      processed_items: "99",
      failed_items: "abc",
      queue_waiting: "5",
      queue_active: "-4",
      queue_completed: "3",
      queue_failed: "-2",
      queue_delayed: "8",
      queue_paused: "-1",
      queue_backlog: "-7",
      last_flush_at: "",
      flush_batch_count: "-4",
      pending_success_buffer: "-1",
      pending_error_buffer: "x",
      updated_at: "",
    });

    const status = await readRunnerStatus(redis);
    expect(status).not.toBeNull();

    expect(status).toEqual({
      operationId: "edge-op",
      mode: "idle",
      desiredMode: "run",
      gateReason: "",
      workersRunning: 0,
      claimedCount: 0,
      queuedCount: 0,
      completedJobs: 22,
      failedJobs: 0,
      processedItems: 99,
      failedItems: 0,
      queueWaiting: 5,
      queueActive: 0,
      queueCompleted: 3,
      queueFailed: 0,
      queueDelayed: 8,
      queuePaused: 0,
      queueBacklog: 0,
      lastFlushAt: null,
      flushBatchCount: 0,
      pendingSuccessBuffer: 0,
      pendingErrorBuffer: 0,
      updatedAt: expect.any(String),
    });

    const updatedAtMs = Date.parse((status as RunnerStatusSnapshot).updatedAt);
    expect(Number.isFinite(updatedAtMs)).toBe(true);
  });

  it("returns null status when operation id is missing", async () => {
    await redis.hset(IMAGE_RUNNER_STATUS_KEY, {
      mode: "running",
      updated_at: new Date().toISOString(),
    });

    expect(await readRunnerStatus(redis)).toBeNull();
  });
});
