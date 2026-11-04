import { Queue } from "bullmq";
import type IORedis from "ioredis";

import {
  imageJobMetricTrendKeys,
  readImageJobMetricRollupWindows,
  syncImageJobMetricTrends,
} from "@/lib/workers/image-job-metric-trends";
import {
  IMAGE_PERF_ROLLUPS_HASH_KEY,
  IMAGE_RAW_JOB_TREND_PREFIX,
} from "@/lib/workers/image-metrics-redis-keys";
import {
  createOpsUiStateWatcher,
  readOpsTrendHistory,
  type OpsPerformanceRollup,
  type OpsUiSnapshot,
} from "@/lib/workers/image-ops-control-module";
import { runImageOpsDataSimulator } from "@/lib/workers/image-ops-data-simulator";
import {
  IMAGE_RUNNER_INFRA_KEY,
  IMAGE_RUNNER_SETTINGS_KEY,
  IMAGE_RUNNER_STATUS_KEY,
} from "@/lib/workers/image-runner-control";
import { createImageQueue, createRedisConnection } from "@/workers/image-queue";

const PERF_ROLLUP_HASH_KEY = IMAGE_PERF_ROLLUPS_HASH_KEY;
const DEFAULT_APP = "beachhouseclassifieds";

type HarnessScenarioName = "seeded-rollups" | "simulator-state-trends";

export type HarnessCheck = {
  name: string;
  ok: boolean;
  expected: string;
  actual: string;
};

export type HarnessScenarioResult = {
  scenario: HarnessScenarioName;
  ok: boolean;
  durationMs: number;
  checks: HarnessCheck[];
};

export type ImageOpsMetricsHarnessResult = {
  ok: boolean;
  appName: string;
  scenarios: HarnessScenarioResult[];
  passedChecks: number;
  failedChecks: number;
  failed: Array<{
    scenario: HarnessScenarioName;
    name: string;
    expected: string;
    actual: string;
  }>;
};

export type ImageOpsMetricsHarnessOptions = {
  appName?: string;
  runSeededRollupScenario?: boolean;
  runSimulatorScenario?: boolean;
};

type SeededMetricRow = {
  id: string;
  finishedAtMs: number;
  processedCount: number;
  failedCount: number;
  fetchMs: number;
  transformMs: number;
  uploadMs: number;
  sourceBytes: number;
  transformedBytes: number;
};

type WindowExpectation = {
  completedJobs: number;
  failedJobs: number;
  processedItems: number;
  failedItems: number;
  sampledCompletedJobs: number;
  avgFetchMs: number;
  avgTransformMs: number;
  avgUploadMs: number;
  avgEndToEndMs: number;
};

function boolToString(value: boolean): string {
  return value ? "true" : "false";
}

function pushCheck(
  checks: HarnessCheck[],
  name: string,
  ok: boolean,
  expected: string,
  actual: string,
): void {
  checks.push({ name, ok, expected, actual });
}

function meanRounded(values: number[]): number {
  if (values.length <= 0) {
    return 0;
  }
  const sum = values.reduce((acc, value) => acc + value, 0);
  return Math.round(sum / values.length);
}

function buildExpectedWindow(
  rows: SeededMetricRow[],
  failedTimestampsMs: number[],
  windowStartMs: number,
): WindowExpectation {
  const included = rows.filter((row) => row.finishedAtMs >= windowStartMs);
  const fetches = included.map((row) => row.fetchMs);
  const transforms = included.map((row) => row.transformMs);
  const uploads = included.map((row) => row.uploadMs);
  const endToEnd = included.map(
    (row) => row.fetchMs + row.transformMs + row.uploadMs,
  );

  return {
    completedJobs: included.length,
    failedJobs: failedTimestampsMs.filter((atMs) => atMs >= windowStartMs)
      .length,
    processedItems: included.reduce(
      (acc, row) => acc + Math.max(0, row.processedCount),
      0,
    ),
    failedItems: included.reduce(
      (acc, row) => acc + Math.max(0, row.failedCount),
      0,
    ),
    sampledCompletedJobs: included.length,
    avgFetchMs: meanRounded(fetches),
    avgTransformMs: meanRounded(transforms),
    avgUploadMs: meanRounded(uploads),
    avgEndToEndMs: meanRounded(endToEnd),
  };
}

function assertRollupWindow(
  checks: HarnessCheck[],
  windowName: string,
  actual: OpsPerformanceRollup,
  expected: WindowExpectation,
): void {
  pushCheck(
    checks,
    `${windowName}.completedJobs`,
    actual.completedJobs === expected.completedJobs,
    String(expected.completedJobs),
    String(actual.completedJobs),
  );
  pushCheck(
    checks,
    `${windowName}.failedJobs`,
    actual.failedJobs === expected.failedJobs,
    String(expected.failedJobs),
    String(actual.failedJobs),
  );
  pushCheck(
    checks,
    `${windowName}.processedItems`,
    actual.processedItems === expected.processedItems,
    String(expected.processedItems),
    String(actual.processedItems),
  );
  pushCheck(
    checks,
    `${windowName}.failedItems`,
    actual.failedItems === expected.failedItems,
    String(expected.failedItems),
    String(actual.failedItems),
  );
  pushCheck(
    checks,
    `${windowName}.sampledCompletedJobs`,
    actual.sampledCompletedJobs === expected.sampledCompletedJobs,
    String(expected.sampledCompletedJobs),
    String(actual.sampledCompletedJobs),
  );
  pushCheck(
    checks,
    `${windowName}.avgFetchMs`,
    actual.avgFetchMs === expected.avgFetchMs,
    String(expected.avgFetchMs),
    String(actual.avgFetchMs),
  );
  pushCheck(
    checks,
    `${windowName}.avgTransformMs`,
    actual.avgTransformMs === expected.avgTransformMs,
    String(expected.avgTransformMs),
    String(actual.avgTransformMs),
  );
  pushCheck(
    checks,
    `${windowName}.avgUploadMs`,
    actual.avgUploadMs === expected.avgUploadMs,
    String(expected.avgUploadMs),
    String(actual.avgUploadMs),
  );
  pushCheck(
    checks,
    `${windowName}.avgEndToEndMs`,
    actual.avgEndToEndMs === expected.avgEndToEndMs,
    String(expected.avgEndToEndMs),
    String(actual.avgEndToEndMs),
  );
}

function allChecksPass(checks: HarnessCheck[]): boolean {
  return checks.every((check) => check.ok);
}

async function scanDeleteByPrefix(
  redis: IORedis,
  prefix: string,
): Promise<number> {
  let cursor = "0";
  let deleted = 0;
  do {
    const [nextCursor, keys] = await redis.scan(
      cursor,
      "MATCH",
      `${prefix}*`,
      "COUNT",
      "200",
    );
    cursor = nextCursor;
    if (Array.isArray(keys) && keys.length > 0) {
      deleted += await redis.del(...keys);
    }
  } while (cursor !== "0");
  return deleted;
}

async function resetHarnessState(redis: IORedis): Promise<void> {
  await redis.del(
    IMAGE_RUNNER_SETTINGS_KEY,
    IMAGE_RUNNER_STATUS_KEY,
    IMAGE_RUNNER_INFRA_KEY,
    PERF_ROLLUP_HASH_KEY,
  );

  const queueConnection = createRedisConnection();
  const queue = createImageQueue(queueConnection);
  try {
    await queue.obliterate({ force: true });
  } finally {
    await queue.close().catch(() => undefined);
    await queueConnection.quit().catch(() => undefined);
  }

  for (const keySet of imageJobMetricTrendKeys()) {
    await redis.del(keySet.idsKey, keySet.valuesKey, keySet.latestKey);
  }
  await scanDeleteByPrefix(redis, `${IMAGE_RAW_JOB_TREND_PREFIX}:`);
}

async function seedCompletedJobMetrics(input: {
  redis: IORedis;
  queue: Queue;
  rows: SeededMetricRow[];
  failedAtMs: number[];
}): Promise<void> {
  const completedKey = input.queue.toKey("completed");
  const failedKey = input.queue.toKey("failed");
  const pipeline = input.redis.pipeline();

  for (const row of input.rows) {
    const itemCount = Math.max(1, Math.floor(row.processedCount));
    const items = Array.from({ length: itemCount }, () => ({
      fetch_elapsed_ms: row.fetchMs,
      transform_elapsed_ms: row.transformMs,
      upload_elapsed_ms: row.uploadMs,
      source_bytes: row.sourceBytes,
      transformed_bytes: row.transformedBytes,
    }));

    const payload = {
      processed_count: row.processedCount,
      failed_count: row.failedCount,
      elapsed_ms: row.fetchMs + row.transformMs + row.uploadMs,
      items,
    };

    pipeline.zadd(completedKey, row.finishedAtMs, row.id);
    pipeline.hset(
      input.queue.toKey(row.id),
      "returnvalue",
      JSON.stringify(payload),
    );
  }

  for (let index = 0; index < input.failedAtMs.length; index += 1) {
    pipeline.zadd(failedKey, input.failedAtMs[index], `failed-${index + 1}`);
  }

  await pipeline.exec();
}

async function readSnapshotWithWatchdog(
  appName: string,
): Promise<OpsUiSnapshot> {
  const watcher = await createOpsUiStateWatcher({
    appName,
    profile: "cli",
    snapshotTimeoutMs: 12_000,
    skipInitialRefresh: false,
  });
  try {
    await watcher.waitForState(12_000);
    const snapshot = watcher.getSnapshot() || (await watcher.refreshNow());
    return snapshot;
  } finally {
    await watcher.close().catch(() => undefined);
  }
}

async function runSeededRollupScenario(
  appName: string,
): Promise<HarnessScenarioResult> {
  const startedAtMs = Date.now();
  const checks: HarnessCheck[] = [];

  const redis = createRedisConnection();
  const queue = createImageQueue(redis);
  try {
    await resetHarnessState(redis);

    const nowMs = Date.now();
    const rows: SeededMetricRow[] = [
      {
        id: "harness-job-15s",
        finishedAtMs: nowMs - 3_000,
        processedCount: 2,
        failedCount: 0,
        fetchMs: 80,
        transformMs: 40,
        uploadMs: 30,
        sourceBytes: 150_000,
        transformedBytes: 80_000,
      },
      {
        id: "harness-job-1m",
        finishedAtMs: nowMs - 25_000,
        processedCount: 3,
        failedCount: 1,
        fetchMs: 120,
        transformMs: 55,
        uploadMs: 35,
        sourceBytes: 165_000,
        transformedBytes: 82_000,
      },
      {
        id: "harness-job-15m",
        finishedAtMs: nowMs - 5 * 60_000,
        processedCount: 4,
        failedCount: 0,
        fetchMs: 140,
        transformMs: 70,
        uploadMs: 45,
        sourceBytes: 175_000,
        transformedBytes: 90_000,
      },
      {
        id: "harness-job-24h",
        finishedAtMs: nowMs - 2 * 60 * 60_000,
        processedCount: 1,
        failedCount: 0,
        fetchMs: 110,
        transformMs: 65,
        uploadMs: 40,
        sourceBytes: 140_000,
        transformedBytes: 78_000,
      },
      {
        id: "harness-job-deep-only",
        finishedAtMs: nowMs - 30 * 60 * 60_000,
        processedCount: 5,
        failedCount: 2,
        fetchMs: 160,
        transformMs: 90,
        uploadMs: 50,
        sourceBytes: 190_000,
        transformedBytes: 100_000,
      },
    ];

    const failedAtMs = [nowMs - 20_000, nowMs - 3 * 60 * 60_000];
    await seedCompletedJobMetrics({ redis, queue, rows, failedAtMs });

    const sync = await syncImageJobMetricTrends({
      sampleLimit: 1000,
      depthLimit: 1000,
    });
    pushCheck(
      checks,
      "sync.parsedCompletedJobs",
      sync.parsedCompletedJobs === rows.length,
      String(rows.length),
      String(sync.parsedCompletedJobs),
    );

    const rollup = await readImageJobMetricRollupWindows({
      windowsMs: [15_000, 60_000, 15 * 60_000, 24 * 60 * 60_000],
      deepSampleLimit: 1000,
      syncBeforeRead: false,
    });

    const expected15s = buildExpectedWindow(rows, failedAtMs, nowMs - 15_000);
    const expected1m = buildExpectedWindow(rows, failedAtMs, nowMs - 60_000);
    const expected15m = buildExpectedWindow(
      rows,
      failedAtMs,
      nowMs - 15 * 60_000,
    );
    const expected24h = buildExpectedWindow(
      rows,
      failedAtMs,
      nowMs - 24 * 60 * 60_000,
    );
    const expectedDeep = buildExpectedWindow(rows, failedAtMs, -1);

    const window15s = rollup.windows[String(15_000)];
    const window1m = rollup.windows[String(60_000)];
    const window15m = rollup.windows[String(15 * 60_000)];
    const window24h = rollup.windows[String(24 * 60 * 60_000)];
    const deep = rollup.deepWindow;

    pushCheck(
      checks,
      "rollup.window15s.exists",
      Boolean(window15s),
      "true",
      boolToString(Boolean(window15s)),
    );
    pushCheck(
      checks,
      "rollup.window1m.exists",
      Boolean(window1m),
      "true",
      boolToString(Boolean(window1m)),
    );
    pushCheck(
      checks,
      "rollup.window15m.exists",
      Boolean(window15m),
      "true",
      boolToString(Boolean(window15m)),
    );
    pushCheck(
      checks,
      "rollup.window24h.exists",
      Boolean(window24h),
      "true",
      boolToString(Boolean(window24h)),
    );
    pushCheck(
      checks,
      "rollup.deep.exists",
      Boolean(deep),
      "true",
      boolToString(Boolean(deep)),
    );

    if (window15s && window1m && window15m && window24h && deep) {
      assertRollupWindow(checks, "rollup15s", window15s, expected15s);
      assertRollupWindow(checks, "rollup1m", window1m, expected1m);
      assertRollupWindow(checks, "rollup15m", window15m, expected15m);
      assertRollupWindow(checks, "rollup24h", window24h, expected24h);
      assertRollupWindow(checks, "rollupDeep", deep, expectedDeep);
    }

    const snapshot = await readSnapshotWithWatchdog(appName);
    const stateRollups = snapshot.performanceRollups;
    pushCheck(
      checks,
      "state.rollups.present",
      Boolean(stateRollups),
      "true",
      boolToString(Boolean(stateRollups)),
    );

    if (stateRollups) {
      pushCheck(
        checks,
        "state.rollup1m.completedJobs",
        stateRollups.rollup1m.completedJobs === expected1m.completedJobs,
        String(expected1m.completedJobs),
        String(stateRollups.rollup1m.completedJobs),
      );
      pushCheck(
        checks,
        "state.rollup24h.completedJobs",
        stateRollups.rollup24h.completedJobs === expected24h.completedJobs,
        String(expected24h.completedJobs),
        String(stateRollups.rollup24h.completedJobs),
      );
      pushCheck(
        checks,
        "state.rollupDeep.completedJobs",
        stateRollups.rollupDeep.completedJobs === expectedDeep.completedJobs,
        String(expectedDeep.completedJobs),
        String(stateRollups.rollupDeep.completedJobs),
      );
    }

    return {
      scenario: "seeded-rollups",
      ok: allChecksPass(checks),
      durationMs: Date.now() - startedAtMs,
      checks,
    };
  } finally {
    await queue.close().catch(() => undefined);
    await redis.quit().catch(() => undefined);
  }
}

async function runSimulatorStateScenario(
  appName: string,
): Promise<HarnessScenarioResult> {
  const startedAtMs = Date.now();
  const checks: HarnessCheck[] = [];

  const redis = createRedisConnection();
  try {
    await resetHarnessState(redis);
  } finally {
    await redis.quit().catch(() => undefined);
  }

  await runImageOpsDataSimulator({
    durationSeconds: 12,
    tickMs: 1000,
    minBacklog: 20,
    maxBacklog: 20,
    workersMin: 3,
    workersMax: 3,
    mutateSettings: true,
    cleanupOnExit: true,
    trendProfile: "smooth",
    noisePct: 0,
    verbose: false,
  });

  const snapshot = await readSnapshotWithWatchdog(appName);
  const status = snapshot.status;
  pushCheck(
    checks,
    "sim.status.present",
    Boolean(status),
    "true",
    boolToString(Boolean(status)),
  );

  if (status) {
    pushCheck(
      checks,
      "sim.status.processedItemsNonNegative",
      status.processedItems >= 0,
      ">= 0",
      String(status.processedItems),
    );
    pushCheck(
      checks,
      "sim.status.backlogFormula",
      status.queueBacklog ===
        status.queueWaiting +
          status.queueActive +
          status.queueDelayed +
          status.queuePaused,
      "queueBacklog = waiting + active + delayed + paused",
      `${status.queueBacklog} vs ${status.queueWaiting + status.queueActive + status.queueDelayed + status.queuePaused}`,
    );
    pushCheck(
      checks,
      "sim.status.completedMatchesProcessed",
      status.completedJobs === status.processedItems,
      String(status.processedItems),
      String(status.completedJobs),
    );
  }

  pushCheck(
    checks,
    "sim.snapshot.projectionSampleCount",
    snapshot.projections.sampleCount >= 2,
    ">= 2",
    String(snapshot.projections.sampleCount),
  );
  pushCheck(
    checks,
    "sim.snapshot.ipsFinite",
    Number.isFinite(snapshot.projections.headline.ipsNow),
    "finite",
    String(snapshot.projections.headline.ipsNow),
  );

  const trendHistory = await readOpsTrendHistory(40);
  pushCheck(
    checks,
    "sim.trendHistory.populated",
    trendHistory.length >= 8,
    ">= 8",
    String(trendHistory.length),
  );

  if (trendHistory.length > 1) {
    const processedTrend = trendHistory.map((row) => row.processedItems);
    const maxProcessed = processedTrend.reduce(
      (acc, value) => Math.max(acc, value),
      0,
    );
    const hasIncreasingStep = processedTrend.some(
      (value, index) => index > 0 && value > processedTrend[index - 1],
    );
    pushCheck(
      checks,
      "sim.trendHistory.processedHasPositiveSample",
      maxProcessed > 0,
      "max(processedItems) > 0",
      String(maxProcessed),
    );
    pushCheck(
      checks,
      "sim.trendHistory.processedHasIncreasingStep",
      hasIncreasingStep,
      "at least one increasing processedItems step",
      JSON.stringify(processedTrend),
    );
  }

  return {
    scenario: "simulator-state-trends",
    ok: allChecksPass(checks),
    durationMs: Date.now() - startedAtMs,
    checks,
  };
}

export async function runImageOpsMetricsHarness(
  options?: ImageOpsMetricsHarnessOptions,
): Promise<ImageOpsMetricsHarnessResult> {
  const appName = options?.appName?.trim() || DEFAULT_APP;
  const runSeededRollupScenarioEnabled =
    options?.runSeededRollupScenario !== false;
  const runSimulatorScenarioEnabled = options?.runSimulatorScenario !== false;

  const scenarios: HarnessScenarioResult[] = [];

  if (runSeededRollupScenarioEnabled) {
    scenarios.push(await runSeededRollupScenario(appName));
  }

  if (runSimulatorScenarioEnabled) {
    scenarios.push(await runSimulatorStateScenario(appName));
  }

  const failed = scenarios.flatMap((scenario) =>
    scenario.checks
      .filter((check) => !check.ok)
      .map((check) => ({
        scenario: scenario.scenario,
        name: check.name,
        expected: check.expected,
        actual: check.actual,
      })),
  );

  const passedChecks = scenarios
    .flatMap((scenario) => scenario.checks)
    .filter((check) => check.ok).length;
  const failedChecks = failed.length;

  return {
    ok: failedChecks === 0,
    appName,
    scenarios,
    passedChecks,
    failedChecks,
    failed,
  };
}
