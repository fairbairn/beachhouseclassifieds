import IORedis from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  maybePurgeForDesiredMode,
  OPS_SNAPSHOT_TREND_METRIC_REGISTRY,
  OPS_TREND_METRIC_REGISTRY,
  readOpsControlSettings,
  readOpsControlSnapshot,
  readOpsSnapshotTrendRows,
  readOpsSnapshotTrendSeries,
  readOpsTrendHistory,
  readOpsTrendProjection,
  readOpsTrendProjectionSampled,
  readOpsUiSnapshot,
  setOpsDesiredModeWithQueueAction,
  updateOpsControlSettings,
  writeOpsControlSettings,
  writeOpsInfraSnapshot,
  writeOpsRunnerStatus,
  writeOpsSnapshotTrendMetrics,
} from "@/lib/workers/image-ops-control-module";
import {
  IMAGE_RUNNER_INFRA_KEY,
  IMAGE_RUNNER_SETTINGS_KEY,
  IMAGE_RUNNER_STATUS_KEY,
  type RunnerControlSettings,
  type RunnerStatusSnapshot,
} from "@/lib/workers/image-runner-control";
import {
  createImageQueue,
  createRedisConnection,
  DEFAULT_LOCAL_REDIS_URL,
  type ImageProcessingQueueJob,
} from "@/workers/image-queue";

const RUN_REDIS_TESTS = process.env.IMAGE_OPS_REDIS_INTEGRATION === "1";
const describeRedis = RUN_REDIS_TESTS ? describe : describe.skip;
const VERBOSE_ASSERTIONS = process.env.IMAGE_OPS_ASSERTION_LOG === "1";

const redisUrl =
  process.env.IMAGE_OPS_TEST_REDIS_URL?.trim() ||
  process.env.REDIS_URL?.trim() ||
  DEFAULT_LOCAL_REDIS_URL;

function assertLoopbackRedisUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(
      `Invalid redis URL for integration tests: ${rawUrl}. Set IMAGE_OPS_TEST_REDIS_URL to redis://127.0.0.1:<port>.`,
    );
  }

  const host = parsed.hostname.trim().toLowerCase();
  const isLoopback =
    host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (!isLoopback) {
    throw new Error(
      `Redis integration tests must run against local loopback/container mapping (127.0.0.1/localhost). Got host=${host} url=${rawUrl}`,
    );
  }
}

const RUNNER_TREND_KEYS = OPS_TREND_METRIC_REGISTRY.map((metric) => metric.key);
const UI_TREND_KEYS = OPS_SNAPSHOT_TREND_METRIC_REGISTRY.map(
  (metric) => metric.key,
);
const RUNNER_TREND_LATEST_KEYS = RUNNER_TREND_KEYS.map(
  (key) => `${key}:latest`,
);
const UI_TREND_LATEST_KEYS = UI_TREND_KEYS.map((key) => `${key}:latest`);
const ALL_TREND_KEYS = [
  ...RUNNER_TREND_KEYS,
  ...UI_TREND_KEYS,
  ...RUNNER_TREND_LATEST_KEYS,
  ...UI_TREND_LATEST_KEYS,
];

const STATUS_HASH_FIELDS = [
  "operation_id",
  "mode",
  "desired_mode",
  "gate_reason",
  "workers_running",
  "claimed_count",
  "queued_count",
  "completed_jobs",
  "failed_jobs",
  "processed_items",
  "failed_items",
  "queue_waiting",
  "queue_active",
  "queue_completed",
  "queue_failed",
  "queue_delayed",
  "queue_paused",
  "queue_backlog",
  "last_flush_at",
  "flush_batch_count",
  "pending_success_buffer",
  "pending_error_buffer",
  "updated_at",
] as const;

const SETTINGS_HASH_FIELDS = [
  "desired_mode",
  "enqueue_enabled",
  "require_workers_for_enqueue",
  "min_workers_to_enqueue",
  "max_queue_backlog",
  "refill_low_watermark",
  "refill_target_backlog",
  "max_claim_per_cycle",
  "flush_interval_ms",
  "harvest_enabled",
  "updated_at",
] as const;

const INFRA_HASH_FIELDS = ["workers_running", "source", "updated_at"] as const;

function parseTrendMemberValue(member: string): number {
  try {
    const parsed = JSON.parse(member) as { value?: unknown };
    if (Number.isFinite(parsed.value)) {
      return Number(parsed.value);
    }
  } catch {
    // ignore and try numeric fallback
  }
  const numeric = Number(member);
  if (Number.isFinite(numeric)) {
    return numeric;
  }
  throw new Error(`invalid trend member payload: ${member}`);
}

function assertLabeledEqual<T>(label: string, actual: T, expected: T): void {
  expect(actual, label).toEqual(expected);
  if (VERBOSE_ASSERTIONS) {
    process.stdout.write(`[assert:pass] ${label}\n`);
  }
}

function makeJob(suffix: string): ImageProcessingQueueJob {
  return {
    operationId: `op-${suffix}`,
    batchId: `batch-${suffix}`,
    batchIndex: 0,
    batchCount: 1,
    workId: `work-${suffix}`,
    sourceType: "url",
    sourceImageUrl: `https://example.com/${suffix}.jpg`,
  };
}

function makeStatus(
  overrides?: Partial<RunnerStatusSnapshot>,
): RunnerStatusSnapshot {
  return {
    operationId: "op-module-test",
    mode: "running",
    desiredMode: "run",
    gateReason: "gate=open",
    workersRunning: 1,
    claimedCount: 3,
    queuedCount: 3,
    completedJobs: 1,
    failedJobs: 0,
    processedItems: 1,
    failedItems: 0,
    queueWaiting: 1,
    queueActive: 0,
    queueCompleted: 1,
    queueFailed: 0,
    queueDelayed: 0,
    queuePaused: 0,
    queueBacklog: 1,
    lastFlushAt: null,
    flushBatchCount: 0,
    pendingSuccessBuffer: 0,
    pendingErrorBuffer: 0,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function expectSettingsEqual(
  actual: RunnerControlSettings,
  expected: RunnerControlSettings,
  context = "settings",
): void {
  assertLabeledEqual(
    `${context}.desiredMode`,
    actual.desiredMode,
    expected.desiredMode,
  );
  assertLabeledEqual(
    `${context}.enqueueEnabled`,
    actual.enqueueEnabled,
    expected.enqueueEnabled,
  );
  assertLabeledEqual(
    `${context}.requireWorkersForEnqueue`,
    actual.requireWorkersForEnqueue,
    expected.requireWorkersForEnqueue,
  );
  assertLabeledEqual(
    `${context}.minWorkersToEnqueue`,
    actual.minWorkersToEnqueue,
    expected.minWorkersToEnqueue,
  );
  assertLabeledEqual(
    `${context}.maxQueueBacklog`,
    actual.maxQueueBacklog,
    expected.maxQueueBacklog,
  );
  assertLabeledEqual(
    `${context}.refillLowWatermark`,
    actual.refillLowWatermark,
    expected.refillLowWatermark,
  );
  assertLabeledEqual(
    `${context}.refillTargetBacklog`,
    actual.refillTargetBacklog,
    expected.refillTargetBacklog,
  );
  assertLabeledEqual(
    `${context}.maxClaimPerCycle`,
    actual.maxClaimPerCycle,
    expected.maxClaimPerCycle,
  );
  assertLabeledEqual(
    `${context}.flushIntervalMs`,
    actual.flushIntervalMs,
    expected.flushIntervalMs,
  );
  assertLabeledEqual(
    `${context}.harvestEnabled`,
    actual.harvestEnabled,
    expected.harvestEnabled,
  );
}

function expectStatusEqual(
  actual: RunnerStatusSnapshot,
  expected: RunnerStatusSnapshot,
  context = "status",
): void {
  assertLabeledEqual(
    `${context}.operationId`,
    actual.operationId,
    expected.operationId,
  );
  assertLabeledEqual(`${context}.mode`, actual.mode, expected.mode);
  assertLabeledEqual(
    `${context}.desiredMode`,
    actual.desiredMode,
    expected.desiredMode,
  );
  assertLabeledEqual(
    `${context}.gateReason`,
    actual.gateReason,
    expected.gateReason,
  );
  assertLabeledEqual(
    `${context}.workersRunning`,
    actual.workersRunning,
    expected.workersRunning,
  );
  assertLabeledEqual(
    `${context}.claimedCount`,
    actual.claimedCount,
    expected.claimedCount,
  );
  assertLabeledEqual(
    `${context}.queuedCount`,
    actual.queuedCount,
    expected.queuedCount,
  );
  assertLabeledEqual(
    `${context}.completedJobs`,
    actual.completedJobs,
    expected.completedJobs,
  );
  assertLabeledEqual(
    `${context}.failedJobs`,
    actual.failedJobs,
    expected.failedJobs,
  );
  assertLabeledEqual(
    `${context}.processedItems`,
    actual.processedItems,
    expected.processedItems,
  );
  assertLabeledEqual(
    `${context}.failedItems`,
    actual.failedItems,
    expected.failedItems,
  );
  assertLabeledEqual(
    `${context}.queueWaiting`,
    actual.queueWaiting,
    expected.queueWaiting,
  );
  assertLabeledEqual(
    `${context}.queueActive`,
    actual.queueActive,
    expected.queueActive,
  );
  assertLabeledEqual(
    `${context}.queueCompleted`,
    actual.queueCompleted,
    expected.queueCompleted,
  );
  assertLabeledEqual(
    `${context}.queueFailed`,
    actual.queueFailed,
    expected.queueFailed,
  );
  assertLabeledEqual(
    `${context}.queueDelayed`,
    actual.queueDelayed,
    expected.queueDelayed,
  );
  assertLabeledEqual(
    `${context}.queuePaused`,
    actual.queuePaused,
    expected.queuePaused,
  );
  assertLabeledEqual(
    `${context}.queueBacklog`,
    actual.queueBacklog,
    expected.queueBacklog,
  );
  assertLabeledEqual(
    `${context}.lastFlushAt`,
    actual.lastFlushAt,
    expected.lastFlushAt,
  );
  assertLabeledEqual(
    `${context}.flushBatchCount`,
    actual.flushBatchCount,
    expected.flushBatchCount,
  );
  assertLabeledEqual(
    `${context}.pendingSuccessBuffer`,
    actual.pendingSuccessBuffer,
    expected.pendingSuccessBuffer,
  );
  assertLabeledEqual(
    `${context}.pendingErrorBuffer`,
    actual.pendingErrorBuffer,
    expected.pendingErrorBuffer,
  );
  assertLabeledEqual(
    `${context}.updatedAt`,
    actual.updatedAt,
    expected.updatedAt,
  );
}

const SETTINGS_KEYS: Array<keyof RunnerControlSettings> = [
  "desiredMode",
  "enqueueEnabled",
  "requireWorkersForEnqueue",
  "minWorkersToEnqueue",
  "maxQueueBacklog",
  "refillLowWatermark",
  "refillTargetBacklog",
  "maxClaimPerCycle",
  "flushIntervalMs",
  "harvestEnabled",
];

function changedSettingKeys(
  before: RunnerControlSettings,
  after: RunnerControlSettings,
): Array<keyof RunnerControlSettings> {
  return SETTINGS_KEYS.filter((key) => before[key] !== after[key]);
}

async function waitForCondition(
  check: () => Promise<boolean>,
  timeoutMs = 3000,
  pollMs = 50,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

describeRedis("image-ops-control-module redis integration", () => {
  let redis: IORedis;
  let previousRedisUrl: string | undefined;

  beforeAll(async () => {
    assertLoopbackRedisUrl(redisUrl);
    previousRedisUrl = process.env.REDIS_URL;
    process.env.REDIS_URL = redisUrl;

    redis = new IORedis(redisUrl, {
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
    });
    await redis.ping();
  });

  afterAll(async () => {
    await redis.quit();

    if (previousRedisUrl === undefined) {
      delete process.env.REDIS_URL;
    } else {
      process.env.REDIS_URL = previousRedisUrl;
    }
  });

  beforeEach(async () => {
    await redis.del(
      IMAGE_RUNNER_SETTINGS_KEY,
      IMAGE_RUNNER_INFRA_KEY,
      IMAGE_RUNNER_STATUS_KEY,
      ...ALL_TREND_KEYS,
    );

    const queueConnection = createRedisConnection();
    const queue = createImageQueue(queueConnection);
    try {
      await queue.obliterate({ force: true });
    } finally {
      await queue.close();
      await queueConnection.quit();
    }
  });

  it("reads default control settings via module", async () => {
    const settings = await readOpsControlSettings(redis);
    expect(settings.desiredMode).toBe("run");
    expect(settings.maxQueueBacklog).toBe(240);
  });

  it("updates settings via module updater and re-reads consistently", async () => {
    const next = await updateOpsControlSettings(
      (current) => ({
        ...current,
        desiredMode: "idle",
        flushIntervalMs: 20000,
        maxClaimPerCycle: 55,
      }),
      redis,
    );

    expect(next.desiredMode).toBe("idle");
    expect(next.flushIntervalMs).toBe(20000);
    expect(next.maxClaimPerCycle).toBe(55);

    const reread = await readOpsControlSettings(redis);
    expect(reread.desiredMode).toBe("idle");
    expect(reread.flushIntervalMs).toBe(20000);
    expect(reread.maxClaimPerCycle).toBe(55);
  });

  it("writes full settings via module and roundtrips exactly", async () => {
    const full: RunnerControlSettings = {
      desiredMode: "stop",
      enqueueEnabled: false,
      requireWorkersForEnqueue: false,
      minWorkersToEnqueue: 9,
      maxQueueBacklog: 888,
      refillLowWatermark: 222,
      refillTargetBacklog: 444,
      maxClaimPerCycle: 66,
      flushIntervalMs: 17000,
      harvestEnabled: false,
    };

    await writeOpsControlSettings(full, redis);
    const reread = await readOpsControlSettings(redis);
    expect(reread).toEqual(full);
  });

  it.each([
    {
      name: "desiredMode",
      patch: { desiredMode: "idle" as const },
    },
    {
      name: "enqueueEnabled",
      patch: { enqueueEnabled: false },
    },
    {
      name: "requireWorkersForEnqueue",
      patch: { requireWorkersForEnqueue: false },
    },
    {
      name: "minWorkersToEnqueue",
      patch: { minWorkersToEnqueue: 5 },
    },
    {
      name: "maxQueueBacklog",
      patch: { maxQueueBacklog: 777 },
    },
    {
      name: "refillLowWatermark",
      patch: { refillLowWatermark: 111 },
    },
    {
      name: "refillTargetBacklog",
      patch: { refillTargetBacklog: 333 },
    },
    {
      name: "maxClaimPerCycle",
      patch: { maxClaimPerCycle: 99 },
    },
    {
      name: "flushIntervalMs",
      patch: { flushIntervalMs: 21000 },
    },
    {
      name: "harvestEnabled",
      patch: { harvestEnabled: false },
    },
  ])("single-field mutation roundtrip: $name", async ({ patch }) => {
    const base = await readOpsControlSettings(redis);
    const expected = { ...base, ...patch };
    await updateOpsControlSettings(
      (current) => ({
        ...current,
        ...patch,
      }),
      redis,
    );
    const reread = await readOpsControlSettings(redis);
    expect(reread).toEqual(expected);
    expect(changedSettingKeys(base, reread)).toEqual(
      Object.keys(patch) as Array<keyof RunnerControlSettings>,
    );
  });

  it("covers full settings mutation matrix via updater", async () => {
    const next = await updateOpsControlSettings(
      (current) => ({
        ...current,
        desiredMode: "drain",
        enqueueEnabled: false,
        requireWorkersForEnqueue: false,
        minWorkersToEnqueue: 7,
        maxQueueBacklog: 999,
        refillLowWatermark: 111,
        refillTargetBacklog: 222,
        maxClaimPerCycle: 44,
        flushIntervalMs: 18000,
        harvestEnabled: false,
      }),
      redis,
    );

    expect(next).toEqual({
      desiredMode: "drain",
      enqueueEnabled: false,
      requireWorkersForEnqueue: false,
      minWorkersToEnqueue: 7,
      maxQueueBacklog: 999,
      refillLowWatermark: 111,
      refillTargetBacklog: 222,
      maxClaimPerCycle: 44,
      flushIntervalMs: 18000,
      harvestEnabled: false,
    });

    const reread = await readOpsControlSettings(redis);
    expect(reread).toEqual(next);
  });

  it("reads full snapshot including infra and status", async () => {
    await writeOpsInfraSnapshot(
      {
        workersRunning: 2,
        source: "module-test",
        updatedAt: "2026-11-03T00:00:00.000Z",
      },
      redis,
    );
    await writeOpsRunnerStatus(
      makeStatus({
        operationId: "op-snapshot",
        queueWaiting: 7,
        queueActive: 0,
        queueDelayed: 0,
        queuePaused: 0,
        queueBacklog: 7,
      }),
      redis,
    );

    const snapshot = await readOpsControlSnapshot(redis);
    expect(snapshot.settings).not.toBeNull();
    expect(snapshot.infra?.workersRunning).toBe(2);
    expect(snapshot.infra?.source).toBe("module-test");
    expect(snapshot.status?.operationId).toBe("op-snapshot");
    expect(snapshot.status?.queueBacklog).toBe(7);
  });

  it("status write/read roundtrips every persisted runner field", async () => {
    const status = makeStatus({
      operationId: "op-status-roundtrip",
      mode: "stopping",
      desiredMode: "drain",
      gateReason: "gate=drain",
      workersRunning: 4,
      claimedCount: 77,
      queuedCount: 55,
      completedJobs: 33,
      failedJobs: 2,
      processedItems: 123,
      failedItems: 5,
      queueWaiting: 11,
      queueActive: 3,
      queueCompleted: 88,
      queueFailed: 9,
      queueDelayed: 2,
      queuePaused: 1,
      queueBacklog: 17,
      lastFlushAt: "2026-11-03T12:00:00.000Z",
      flushBatchCount: 12,
      pendingSuccessBuffer: 6,
      pendingErrorBuffer: 1,
      updatedAt: "2026-11-03T12:00:05.000Z",
    });

    await writeOpsRunnerStatus(status, redis);
    const snapshot = await readOpsControlSnapshot(redis);
    expect(snapshot.status).not.toBeNull();
    expectStatusEqual(snapshot.status as RunnerStatusSnapshot, status);
  });

  it("status field matrix performs explicit write/read verification across many value sets", async () => {
    const statuses: RunnerStatusSnapshot[] = [];
    for (let index = 1; index <= 12; index += 1) {
      const waiting = index * 3;
      const active = index % 4;
      const delayed = index % 3;
      const paused = index % 2;
      statuses.push(
        makeStatus({
          operationId: `op-status-matrix-${index}`,
          mode:
            index % 5 === 0
              ? "done"
              : index % 4 === 0
                ? "stopping"
                : index % 3 === 0
                  ? "idle"
                  : "running",
          desiredMode:
            index % 4 === 0 ? "drain" : index % 3 === 0 ? "idle" : "run",
          gateReason: index % 4 === 0 ? "gate=drain" : "gate=open",
          workersRunning: (index % 6) + 1,
          claimedCount: 40 + index,
          queuedCount: 30 + index,
          completedJobs: 20 + index,
          failedJobs: index % 5,
          processedItems: index * 10,
          failedItems: index % 7,
          queueWaiting: waiting,
          queueActive: active,
          queueCompleted: 100 + index,
          queueFailed: 10 + (index % 4),
          queueDelayed: delayed,
          queuePaused: paused,
          queueBacklog: waiting + active + delayed + paused,
          lastFlushAt: `2026-11-03T12:${String(index).padStart(2, "0")}:00.000Z`,
          flushBatchCount: index,
          pendingSuccessBuffer: index % 3,
          pendingErrorBuffer: index % 2,
          updatedAt: `2026-11-03T12:${String(index).padStart(2, "0")}:05.000Z`,
        }),
      );
    }

    for (const status of statuses) {
      await writeOpsRunnerStatus(status, redis);
      const snapshot = await readOpsControlSnapshot(redis);
      expect(snapshot.status).not.toBeNull();
      expectStatusEqual(snapshot.status as RunnerStatusSnapshot, status);
    }
  });

  it("settings field matrix performs explicit write/read verification across many value sets", async () => {
    const variants: RunnerControlSettings[] = [
      {
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
      },
      {
        desiredMode: "idle",
        enqueueEnabled: false,
        requireWorkersForEnqueue: false,
        minWorkersToEnqueue: 0,
        maxQueueBacklog: 1000,
        refillLowWatermark: 100,
        refillTargetBacklog: 400,
        maxClaimPerCycle: 75,
        flushIntervalMs: 20000,
        harvestEnabled: false,
      },
      {
        desiredMode: "drain",
        enqueueEnabled: true,
        requireWorkersForEnqueue: false,
        minWorkersToEnqueue: 3,
        maxQueueBacklog: 3000,
        refillLowWatermark: 200,
        refillTargetBacklog: 450,
        maxClaimPerCycle: 99,
        flushIntervalMs: 60000,
        harvestEnabled: true,
      },
      {
        desiredMode: "stop",
        enqueueEnabled: false,
        requireWorkersForEnqueue: true,
        minWorkersToEnqueue: 12,
        maxQueueBacklog: 500,
        refillLowWatermark: 125,
        refillTargetBacklog: 250,
        maxClaimPerCycle: 12,
        flushIntervalMs: 1000,
        harvestEnabled: false,
      },
    ];

    for (const variant of variants) {
      await writeOpsControlSettings(variant, redis);
      const reread = await readOpsControlSettings(redis);
      expectSettingsEqual(reread, variant);
    }
  });

  it("ui snapshot exposes all CLI-consumed value groups", async () => {
    await writeOpsControlSettings(
      {
        desiredMode: "run",
        enqueueEnabled: true,
        requireWorkersForEnqueue: true,
        minWorkersToEnqueue: 1,
        maxQueueBacklog: 300,
        refillLowWatermark: 120,
        refillTargetBacklog: 200,
        maxClaimPerCycle: 42,
        flushIntervalMs: 17000,
        harvestEnabled: true,
      },
      redis,
    );

    await writeOpsInfraSnapshot(
      {
        workersRunning: 2,
        source: "ui-snapshot-test",
        updatedAt: "2026-11-03T12:03:00.000Z",
      },
      redis,
    );

    await writeOpsRunnerStatus(
      makeStatus({
        operationId: "op-ui-snapshot",
        mode: "running",
        desiredMode: "run",
        gateReason: "gate=open",
        workersRunning: 2,
        processedItems: 20,
        failedItems: 1,
        queueWaiting: 8,
        queueActive: 2,
        queueDelayed: 1,
        queuePaused: 0,
        queueBacklog: 11,
      }),
      redis,
    );

    const uiSnapshot = await readOpsUiSnapshot("local-test-app", 1000);

    expect(uiSnapshot.settings).not.toBeNull();
    expect(uiSnapshot.infra).not.toBeNull();
    expect(uiSnapshot.status).not.toBeNull();
    expect(uiSnapshot.queue).not.toBeNull();
    expect(uiSnapshot.projections.sampleCount).toBeGreaterThan(0);

    expect(uiSnapshot.settings?.desiredMode).toBe("run");
    expect(uiSnapshot.settings?.maxQueueBacklog).toBe(300);
    expect(uiSnapshot.infra?.workersRunning).toBe(2);
    expect(uiSnapshot.status?.operationId).toBe("op-ui-snapshot");
    expect(uiSnapshot.status?.queueBacklog).toBe(11);

    expect(uiSnapshot.projections.queueBacklogTrendRaw.length).toBe(
      uiSnapshot.projections.sampleCount,
    );
    expect(uiSnapshot.projections.processedItemsTrend.length).toBe(
      uiSnapshot.projections.sampleCount,
    );
    expect(uiSnapshot.projections.failedItemsTrend.length).toBe(
      uiSnapshot.projections.sampleCount,
    );
    expect(Number.isFinite(uiSnapshot.projections.headline.ipsNow)).toBe(true);
    expect(Number.isFinite(uiSnapshot.projections.headline.ipmAvg30)).toBe(
      true,
    );
    expect(
      Number.isFinite(uiSnapshot.projections.headline.backlogDeltaSmoothedNow),
    ).toBe(true);
  });

  it("ui snapshot writes trend data for every ui metric key with depth cap", async () => {
    await writeOpsControlSettings(
      {
        desiredMode: "run",
        enqueueEnabled: true,
        requireWorkersForEnqueue: true,
        minWorkersToEnqueue: 1,
        maxQueueBacklog: 300,
        refillLowWatermark: 120,
        refillTargetBacklog: 200,
        maxClaimPerCycle: 42,
        flushIntervalMs: 17000,
        harvestEnabled: true,
      },
      redis,
    );

    await writeOpsInfraSnapshot(
      {
        workersRunning: 2,
        source: "ui-trend-test",
        updatedAt: "2026-11-03T12:03:00.000Z",
      },
      redis,
    );

    for (let index = 1; index <= 125; index += 1) {
      await writeOpsRunnerStatus(
        makeStatus({
          operationId: `op-ui-trend-${index}`,
          processedItems: index,
          failedItems: Math.floor(index / 7),
          workersRunning: (index % 4) + 1,
          queueWaiting: index,
          queueActive: 2,
          queueCompleted: 80 + index,
          queueFailed: 4 + (index % 3),
          queueDelayed: index % 2,
          queuePaused: 0,
          queueBacklog: index + 2,
          flushBatchCount: index,
          pendingSuccessBuffer: index % 3,
          pendingErrorBuffer: index % 2,
        }),
        redis,
      );

      const projection = await readOpsTrendProjection(50, redis);
      await writeOpsSnapshotTrendMetrics(
        {
          at: new Date().toISOString(),
          machines: [],
          queue: {
            waiting: index,
            active: 2,
            completed: 80 + index,
            failed: 4 + (index % 3),
            delayed: index % 2,
            paused: 0,
            backlog: index + 2,
          },
          db: {
            processed: 1000 + index,
            pending: 5000 - index,
            total: 6000,
            pct: ((1000 + index) / 6000) * 100,
          },
          settings: {
            desiredMode: "run",
            enqueueEnabled: true,
            requireWorkersForEnqueue: true,
            minWorkersToEnqueue: 1,
            maxQueueBacklog: 300,
            refillLowWatermark: 120,
            refillTargetBacklog: 200,
            maxClaimPerCycle: 42,
            flushIntervalMs: 17000,
            harvestEnabled: true,
          },
          infra: {
            workersRunning: 2,
            source: "ui-trend-test",
            updatedAt: "2026-11-03T12:03:00.000Z",
          },
          status: makeStatus({
            operationId: `op-ui-trend-${index}`,
            processedItems: index,
            failedItems: Math.floor(index / 7),
            workersRunning: (index % 4) + 1,
            queueWaiting: index,
            queueActive: 2,
            queueCompleted: 80 + index,
            queueFailed: 4 + (index % 3),
            queueDelayed: index % 2,
            queuePaused: 0,
            queueBacklog: index + 2,
            flushBatchCount: index,
            pendingSuccessBuffer: index % 3,
            pendingErrorBuffer: index % 2,
          }),
          projections: projection,
          errors: {},
        },
        redis,
      );
    }

    const uiTrendTypes = await Promise.all(
      UI_TREND_KEYS.map((key) => redis.type(key)),
    );
    for (const type of uiTrendTypes) {
      expect(type).toBe("zset");
    }

    const uiTrendDepths = await Promise.all(
      UI_TREND_KEYS.map((key) => redis.zcard(key)),
    );
    for (const depth of uiTrendDepths) {
      expect(depth).toBe(100);
    }
  });

  it("reads ui trend rows with timestamps and stable ordering", async () => {
    for (let index = 1; index <= 6; index += 1) {
      await writeOpsSnapshotTrendMetrics(
        {
          at: new Date().toISOString(),
          machines: [],
          queue: {
            waiting: index,
            active: 2,
            completed: 80 + index,
            failed: 4,
            delayed: 0,
            paused: 0,
            backlog: index + 1,
          },
          db: {
            processed: 1000 + index,
            pending: 5000 - index,
            total: 6000,
            pct: ((1000 + index) / 6000) * 100,
          },
          settings: {
            desiredMode: "run",
            enqueueEnabled: true,
            requireWorkersForEnqueue: true,
            minWorkersToEnqueue: 1,
            maxQueueBacklog: 300,
            refillLowWatermark: 120,
            refillTargetBacklog: 200,
            maxClaimPerCycle: 42,
            flushIntervalMs: 17000,
            harvestEnabled: true,
          },
          infra: {
            workersRunning: 2,
            source: "ui-trend-row-test",
            updatedAt: "2026-11-03T12:03:00.000Z",
          },
          status: makeStatus({
            operationId: `op-ui-trend-row-${index}`,
            processedItems: index,
            failedItems: 0,
            workersRunning: 2,
            queueWaiting: index,
            queueActive: 2,
            queueCompleted: 80 + index,
            queueFailed: 4,
            queueDelayed: 0,
            queuePaused: 0,
            queueBacklog: index + 1,
            flushBatchCount: index,
            pendingSuccessBuffer: index % 2,
            pendingErrorBuffer: 0,
          }),
          projections: {
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
          },
          errors: {},
        },
        redis,
      );
    }

    const rows = await readOpsSnapshotTrendRows(
      {
        metricNames: ["queueWaitingLive", "workersRunningLive"],
        limit: 6,
      },
      redis,
    );

    expect(rows.queueWaitingLive).toHaveLength(6);
    expect(rows.workersRunningLive).toHaveLength(6);

    const waitingValues = rows.queueWaitingLive.map((row) => row.value);
    expect(waitingValues).toEqual([1, 2, 3, 4, 5, 6]);

    const waitingAtMs = rows.queueWaitingLive.map((row) => row.atMs);
    for (let index = 1; index < waitingAtMs.length; index += 1) {
      expect(waitingAtMs[index]).toBeGreaterThan(waitingAtMs[index - 1]);
    }
  });

  it("returns sampled ui trend series and supports smaller requested limits", async () => {
    for (let index = 1; index <= 40; index += 1) {
      await writeOpsSnapshotTrendMetrics(
        {
          at: new Date().toISOString(),
          machines: [],
          queue: {
            waiting: index,
            active: 1,
            completed: 10 + index,
            failed: index % 3,
            delayed: 0,
            paused: 0,
            backlog: index,
          },
          db: {
            processed: 1000 + index,
            pending: 5000 - index,
            total: 6000,
            pct: ((1000 + index) / 6000) * 100,
          },
          settings: {
            desiredMode: "run",
            enqueueEnabled: true,
            requireWorkersForEnqueue: true,
            minWorkersToEnqueue: 1,
            maxQueueBacklog: 300,
            refillLowWatermark: 120,
            refillTargetBacklog: 200,
            maxClaimPerCycle: 42,
            flushIntervalMs: 17000,
            harvestEnabled: true,
          },
          infra: {
            workersRunning: 2,
            source: "ui-series-sampled",
            updatedAt: new Date().toISOString(),
          },
          status: makeStatus({
            operationId: `op-ui-series-sampled-${index}`,
            queueWaiting: index,
            queueBacklog: index,
          }),
          projections: {
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
          },
          errors: {},
        },
        redis,
      );
    }

    const sampled20 = await readOpsSnapshotTrendSeries(
      {
        metricNames: ["queueWaitingLive"],
        limit: 20,
        sampleMode: "raw",
      },
      redis,
    );

    expect(sampled20.queueWaitingLive).toHaveLength(20);
    expect(sampled20.queueWaitingLive[0]).toBe(21);
    expect(sampled20.queueWaitingLive[19]).toBe(40);
  });

  it("filters stale ui trend rows when max age is applied", async () => {
    const queueWaitingKey =
      OPS_SNAPSHOT_TREND_METRIC_REGISTRY.find(
        (metric) => metric.name === "queueWaitingLive",
      )?.key || "";
    expect(queueWaitingKey).not.toBe("");

    const now = Date.now();
    await redis.zadd(
      queueWaitingKey,
      now - 60_000,
      JSON.stringify({ value: 1 }),
    );
    await redis.zadd(
      queueWaitingKey,
      now - 45_000,
      JSON.stringify({ value: 2 }),
    );
    await redis.zadd(queueWaitingKey, now - 500, JSON.stringify({ value: 3 }));
    await redis.zadd(queueWaitingKey, now, JSON.stringify({ value: 4 }));

    const rowsFresh = await readOpsSnapshotTrendRows(
      {
        metricNames: ["queueWaitingLive"],
        limit: 10,
        maxAgeMs: 5_000,
      },
      redis,
    );

    const valuesFresh = rowsFresh.queueWaitingLive.map((row) => row.value);
    expect(valuesFresh).toEqual([3, 4]);
  });

  it("interpolated sampled projection zero-fills across wide gaps", async () => {
    const keyFor = (name: string): string =>
      OPS_TREND_METRIC_REGISTRY.find((metric) => metric.name === name)?.key ||
      "";

    const queueBacklogKey = keyFor("queueBacklog");
    const processedItemsKey = keyFor("processedItems");
    const failedItemsKey = keyFor("failedItems");
    const workersRunningKey = keyFor("workersRunning");

    expect(queueBacklogKey).not.toBe("");
    expect(processedItemsKey).not.toBe("");
    expect(failedItemsKey).not.toBe("");
    expect(workersRunningKey).not.toBe("");

    const now = Date.now();
    const older = now - 120_000;

    await redis.zadd(queueBacklogKey, older, JSON.stringify({ value: 10 }));
    await redis.zadd(queueBacklogKey, now, JSON.stringify({ value: 20 }));
    await redis.zadd(processedItemsKey, older, JSON.stringify({ value: 100 }));
    await redis.zadd(processedItemsKey, now, JSON.stringify({ value: 200 }));
    await redis.zadd(failedItemsKey, older, JSON.stringify({ value: 1 }));
    await redis.zadd(failedItemsKey, now, JSON.stringify({ value: 2 }));
    await redis.zadd(workersRunningKey, older, JSON.stringify({ value: 3 }));
    await redis.zadd(workersRunningKey, now, JSON.stringify({ value: 4 }));

    const sampled = await readOpsTrendProjectionSampled(
      {
        limit: 20,
        sampleMode: "interpolated",
        sampleMaxGapMs: 2_000,
      },
      redis,
    );

    expect(sampled.sampleCount).toBe(20);
    expect(sampled.queueBacklogTrendRaw[0]).toBe(10);
    expect(sampled.queueBacklogTrendRaw[19]).toBe(20);

    const middle = sampled.queueBacklogTrendRaw.slice(1, 19);
    expect(middle.some((value) => value === 0)).toBe(true);
  });

  it("writes expected Redis key types and full hash field contracts", async () => {
    const now = new Date().toISOString();

    await writeOpsControlSettings(
      {
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
      },
      redis,
    );

    await writeOpsInfraSnapshot(
      {
        workersRunning: 3,
        source: "contract-test",
        updatedAt: now,
      },
      redis,
    );

    await writeOpsRunnerStatus(
      makeStatus({
        operationId: "op-contract-test",
        processedItems: 17,
        failedItems: 2,
        queueWaiting: 9,
        queueActive: 2,
        queueDelayed: 1,
        queuePaused: 0,
        queueBacklog: 12,
      }),
      redis,
    );

    const [settingsType, infraType, statusType, ...trendTypes] =
      await Promise.all([
        redis.type(IMAGE_RUNNER_SETTINGS_KEY),
        redis.type(IMAGE_RUNNER_INFRA_KEY),
        redis.type(IMAGE_RUNNER_STATUS_KEY),
        ...RUNNER_TREND_KEYS.map((key) => redis.type(key)),
      ]);

    expect(settingsType).toBe("hash");
    expect(infraType).toBe("hash");
    expect(statusType).toBe("hash");
    for (const trendType of trendTypes) {
      expect(trendType).toBe("zset");
    }

    const [settingsRaw, infraRaw, statusRaw] = await Promise.all([
      redis.hgetall(IMAGE_RUNNER_SETTINGS_KEY),
      redis.hgetall(IMAGE_RUNNER_INFRA_KEY),
      redis.hgetall(IMAGE_RUNNER_STATUS_KEY),
    ]);

    expect(Object.keys(settingsRaw).sort()).toEqual(
      [...SETTINGS_HASH_FIELDS].sort(),
    );
    expect(Object.keys(infraRaw).sort()).toEqual([...INFRA_HASH_FIELDS].sort());
    expect(Object.keys(statusRaw).sort()).toEqual(
      [...STATUS_HASH_FIELDS].sort(),
    );
  });

  it("persists trend in per-metric sorted sets with capped depth", async () => {
    for (let index = 1; index <= 150; index += 1) {
      await writeOpsRunnerStatus(
        makeStatus({
          operationId: `op-trend-${index}`,
          processedItems: index,
          failedItems: Math.floor(index / 10),
          workersRunning: (index % 5) + 1,
          queueWaiting: index,
          queueActive: 1,
          queueDelayed: 0,
          queuePaused: 0,
          queueBacklog: index + 1,
        }),
        redis,
      );
    }

    const history = await readOpsTrendHistory(200, redis);
    expect(history.length).toBe(100);
    expect(history[0]?.processedItems).toBe(51);
    expect(history[99]?.processedItems).toBe(150);

    const trendDepths = await Promise.all(
      RUNNER_TREND_KEYS.map((key) => redis.zcard(key)),
    );
    for (const depth of trendDepths) {
      expect(depth).toBe(100);
    }

    const projection = await readOpsTrendProjection(200, redis);
    expect(projection.sampleCount).toBe(100);
    expect(projection.queueBacklogTrendRaw.length).toBe(100);
    expect(projection.processedItemsTrend.length).toBe(100);
    expect(projection.failedItemsTrend.length).toBe(100);
    expect(projection.ipsRaw.length).toBe(100);
    expect(projection.backlogDeltaRaw.length).toBe(100);
  });

  it("maintains aligned per-metric trend sequences and projection dimensions", async () => {
    for (let index = 1; index <= 65; index += 1) {
      await writeOpsRunnerStatus(
        makeStatus({
          operationId: `op-align-${index}`,
          workersRunning: (index % 4) + 1,
          processedItems: index * 2,
          failedItems: Math.floor(index / 8),
          queueWaiting: index,
          queueActive: 2,
          queueDelayed: 1,
          queuePaused: 0,
          queueBacklog: index + 3,
        }),
        redis,
      );
    }

    const history = await readOpsTrendHistory(50, redis);
    expect(history.length).toBe(50);

    for (const point of history) {
      expect(point.queueBacklog).toBeGreaterThanOrEqual(4);
      expect(point.processedItems % 2).toBe(0);
      expect(point.workersRunning).toBeGreaterThanOrEqual(1);
      expect(point.workersRunning).toBeLessThanOrEqual(4);
    }

    const projection = await readOpsTrendProjection(50, redis);
    expect(projection.sampleCount).toBe(50);
    expect(projection.latestAtMs).not.toBeNull();
    expect(projection.queueBacklogTrendRaw.length).toBe(projection.sampleCount);
    expect(projection.queueBacklogTrendSmoothed.length).toBe(
      projection.sampleCount,
    );
    expect(projection.processedItemsTrend.length).toBe(projection.sampleCount);
    expect(projection.failedItemsTrend.length).toBe(projection.sampleCount);
    expect(projection.ipsRaw.length).toBe(projection.sampleCount);
    expect(projection.ipsSmoothed.length).toBe(projection.sampleCount);
    expect(projection.backlogDeltaRaw.length).toBe(projection.sampleCount);
    expect(projection.backlogDeltaSmoothed.length).toBe(projection.sampleCount);

    expect(Number.isFinite(projection.headline.ipsNow)).toBe(true);
    expect(Number.isFinite(projection.headline.ipsSmoothedNow)).toBe(true);
    expect(Number.isFinite(projection.headline.ipsAvg30)).toBe(true);
    expect(Number.isFinite(projection.headline.ipmAvg30)).toBe(true);
    expect(Number.isFinite(projection.headline.backlogDeltaNow)).toBe(true);
    expect(Number.isFinite(projection.headline.backlogDeltaSmoothedNow)).toBe(
      true,
    );
    expect(projection.headline.drainPerSecSmoothed).toBeGreaterThanOrEqual(0);
    expect(projection.headline.fillPerSecSmoothed).toBeGreaterThanOrEqual(0);
  });

  it.each(OPS_TREND_METRIC_REGISTRY)(
    "trend key uses timestamp-sorted depth-capped history for $name",
    async ({ key, getValue }) => {
      let latestStatus = makeStatus();
      for (let index = 1; index <= 150; index += 1) {
        latestStatus = makeStatus({
          operationId: `op-trend-depth-${index}`,
          processedItems: index,
          failedItems: Math.floor(index / 10),
          workersRunning: (index % 5) + 1,
          claimedCount: 20 + index,
          queuedCount: 10 + index,
          completedJobs: 4 + index,
          failedJobs: index % 4,
          queueWaiting: index,
          queueActive: 1,
          queueCompleted: 100 + index,
          queueFailed: 2 + (index % 3),
          queueDelayed: index % 2,
          queuePaused: index % 2,
          queueBacklog: index + 2,
          flushBatchCount: index,
          pendingSuccessBuffer: index % 3,
          pendingErrorBuffer: index % 2,
        });
        await writeOpsRunnerStatus(latestStatus, redis);
      }

      const depth = await redis.zcard(key);
      expect(depth).toBe(100);

      const latest = await redis.zrevrange(key, 0, 0, "WITHSCORES");
      expect(latest.length).toBe(2);
      expect(Number(latest[1])).toBeGreaterThan(0);
      expect(parseTrendMemberValue(latest[0])).toBe(getValue(latestStatus));
    },
  );

  it("returns null infra/status in snapshot when not yet published", async () => {
    const snapshot = await readOpsControlSnapshot(redis);
    expect(snapshot.settings).not.toBeNull();
    expect(snapshot.infra).toBeNull();
    expect(snapshot.status).toBeNull();
  });

  it("set desired_mode=stop purges pending jobs", async () => {
    const queueConnection = createRedisConnection();
    const queue = createImageQueue(queueConnection);
    try {
      await queue.add("process-image", makeJob("stop-waiting"));
      await queue.add("process-image", makeJob("stop-delayed"), {
        delay: 60000,
      });
    } finally {
      await queue.close();
      await queueConnection.quit();
    }

    const result = await setOpsDesiredModeWithQueueAction("stop", redis);
    expect(result.settings.desiredMode).toBe("stop");
    expect(result.purged).toBe(true);
    expect(result.purge).not.toBeNull();
    expect(
      (result.purge?.remainingWaiting ?? 0) +
        (result.purge?.remainingDelayed ?? 0) +
        (result.purge?.remainingPaused ?? 0),
    ).toBe(0);
  });

  it("set desired_mode=drain purges when workers are zero and backlog exists", async () => {
    await writeOpsInfraSnapshot(
      {
        workersRunning: 0,
        source: "module-test",
        updatedAt: new Date().toISOString(),
      },
      redis,
    );

    const queueConnection = createRedisConnection();
    const queue = createImageQueue(queueConnection);
    try {
      await queue.add("process-image", makeJob("drain-purge"));
    } finally {
      await queue.close();
      await queueConnection.quit();
    }

    const result = await setOpsDesiredModeWithQueueAction("drain", redis);
    expect(result.settings.desiredMode).toBe("drain");
    expect(result.purged).toBe(true);
    expect(result.purge).not.toBeNull();
    expect(result.purge?.remainingWaiting).toBe(0);
    expect(result.purge?.remainingDelayed).toBe(0);
    expect(result.purge?.remainingPaused).toBe(0);
  });

  it("set desired_mode=drain does not purge when workers are running", async () => {
    await writeOpsInfraSnapshot(
      {
        workersRunning: 2,
        source: "module-test",
        updatedAt: new Date().toISOString(),
      },
      redis,
    );

    const result = await setOpsDesiredModeWithQueueAction("drain", redis);
    expect(result.settings.desiredMode).toBe("drain");
    expect(result.purged).toBe(false);
    expect(result.purge).toBeNull();
  });

  it("set desired_mode=run and idle only mutate settings without purge", async () => {
    await writeOpsControlSettings(
      {
        desiredMode: "stop",
        enqueueEnabled: false,
        requireWorkersForEnqueue: false,
        minWorkersToEnqueue: 9,
        maxQueueBacklog: 777,
        refillLowWatermark: 123,
        refillTargetBacklog: 345,
        maxClaimPerCycle: 66,
        flushIntervalMs: 19000,
        harvestEnabled: false,
      },
      redis,
    );

    const beforeRun = await readOpsControlSettings(redis);
    const runResult = await setOpsDesiredModeWithQueueAction("run", redis);
    expect(runResult.settings.desiredMode).toBe("run");
    expect(runResult.purged).toBe(false);
    expect(runResult.purge).toBeNull();
    const afterRun = await readOpsControlSettings(redis);
    expect(changedSettingKeys(beforeRun, afterRun)).toEqual(["desiredMode"]);

    const beforeIdle = await readOpsControlSettings(redis);
    const idleResult = await setOpsDesiredModeWithQueueAction("idle", redis);
    expect(idleResult.settings.desiredMode).toBe("idle");
    expect(idleResult.purged).toBe(false);
    expect(idleResult.purge).toBeNull();
    const afterIdle = await readOpsControlSettings(redis);
    expect(changedSettingKeys(beforeIdle, afterIdle)).toEqual(["desiredMode"]);
  });

  it("command mutation flows through polling snapshot source of truth", async () => {
    await setOpsDesiredModeWithQueueAction("run", redis);
    await waitForCondition(async () => {
      const snapshot = await readOpsControlSnapshot(redis);
      return snapshot.settings.desiredMode === "run";
    });

    await setOpsDesiredModeWithQueueAction("idle", redis);
    await waitForCondition(async () => {
      const snapshot = await readOpsControlSnapshot(redis);
      return snapshot.settings.desiredMode === "idle";
    });

    const snapshot = await readOpsControlSnapshot(redis);
    expect(snapshot.settings.desiredMode).toBe("idle");
  });

  it.each([
    { mode: "run" as const },
    { mode: "idle" as const },
    { mode: "drain" as const },
    { mode: "stop" as const },
  ])(
    "setOpsDesiredModeWithQueueAction persists desired mode: $mode",
    async ({ mode }) => {
      const before = await readOpsControlSettings(redis);
      if (mode === "stop") {
        const queueConnection = createRedisConnection();
        const queue = createImageQueue(queueConnection);
        try {
          await queue.add("process-image", makeJob(`mode-${mode}`));
        } finally {
          await queue.close();
          await queueConnection.quit();
        }
      }

      if (mode === "drain") {
        await writeOpsInfraSnapshot(
          {
            workersRunning: 2,
            source: "mode-test",
            updatedAt: new Date().toISOString(),
          },
          redis,
        );
      }

      const result = await setOpsDesiredModeWithQueueAction(mode, redis);
      const snapshot = await readOpsControlSnapshot(redis);
      expect(result.settings.desiredMode).toBe(mode);
      expect(snapshot.settings.desiredMode).toBe(mode);
      const after = await readOpsControlSettings(redis);
      const changed = changedSettingKeys(before, after);
      if (before.desiredMode === mode) {
        expect(changed).toEqual([]);
      } else {
        expect(changed).toEqual(["desiredMode"]);
      }
    },
  );

  it("maybePurgeForDesiredMode does not purge drain when backlog is zero", async () => {
    const result = await maybePurgeForDesiredMode({
      desiredMode: "drain",
      queue: {
        waiting: 0,
        active: 0,
        completed: 10,
        failed: 1,
        delayed: 0,
        paused: 0,
        backlog: 0,
      },
      infra: {
        workersRunning: 0,
        source: "test",
        updatedAt: new Date().toISOString(),
      },
    });
    expect(result).toBeNull();
  });

  it("maybePurgeForDesiredMode only purges for stop/drain conditions", async () => {
    const idle = await maybePurgeForDesiredMode({
      desiredMode: "idle",
      queue: {
        waiting: 4,
        active: 0,
        completed: 0,
        failed: 0,
        delayed: 0,
        paused: 0,
        backlog: 4,
      },
      infra: {
        workersRunning: 0,
        source: "test",
        updatedAt: new Date().toISOString(),
      },
    });
    expect(idle).toBeNull();
  });
});
