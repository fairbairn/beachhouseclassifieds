import { describe, expect, it, vi } from "vitest";

const capturedIngestCalls: Array<{
  samples: Array<{ key: string; value: number; atMs?: number }>;
}> = [];
const capturedStatusWrites: Array<{
  completedJobs: number;
  failedJobs: number;
  queueBacklog: number;
  flushBatchCount: number;
}> = [];
let mockBacklog = 7;

vi.mock("./image-ops-control-module", async () => {
  const actual = await vi.importActual<
    typeof import("./image-ops-control-module")
  >("./image-ops-control-module");

  return {
    ...actual,
    appendOpsBullmqSample: vi.fn(async () => undefined),
    createOpsQueueRuntime: vi.fn(async () => ({
      queue: {},
      close: async () => undefined,
    })),
    ingestOpsMetricSamples: vi.fn(
      async (input: {
        samples: Array<{ key: string; value: number; atMs?: number }>;
      }) => {
        capturedIngestCalls.push({ samples: input.samples });
      },
    ),
    listOpsPendingJobsForOperation: vi.fn(async () => []),
    readOpsControlSettings: vi.fn(async () => ({ desiredMode: "run" })),
    readOpsSharedState: vi.fn(async () => ({
      queue: {
        waiting: mockBacklog,
        active: 0,
        completed: 0,
        failed: 0,
        delayed: 0,
        paused: 0,
        backlog: mockBacklog,
      },
      db: null,
      settings: {
        desiredMode: "run",
        enqueueEnabled: true,
        requireWorkersForEnqueue: true,
        minWorkersToEnqueue: 1,
        maxQueueBacklog: 100,
        refillLowWatermark: 50,
        refillTargetBacklog: 80,
        maxClaimPerCycle: 20,
        flushIntervalMs: 1000,
        harvestEnabled: true,
      },
      infra: {
        workersRunning: 1,
        source: "sim-test",
        updatedAt: new Date().toISOString(),
      },
      status: null,
    })),
    setOpsBacklogForOperation: vi.fn(async (input: { target: number }) => {
      mockBacklog = Math.max(0, Math.floor(input.target));
      return 0;
    }),
    updateOpsControlSettings: vi.fn(async () => undefined),
    writeOpsInfraSnapshot: vi.fn(async () => undefined),
    writeOpsRunnerStatus: vi.fn(
      async (status: {
        completedJobs: number;
        failedJobs: number;
        queueBacklog: number;
        flushBatchCount: number;
      }) => {
        capturedStatusWrites.push({
          completedJobs: status.completedJobs,
          failedJobs: status.failedJobs,
          queueBacklog: status.queueBacklog,
          flushBatchCount: status.flushBatchCount,
        });
      },
    ),
  };
});

describe("image ops data simulator registry coverage", () => {
  it("emits synthetic samples for every metric in runner+snapshot registries", async () => {
    mockBacklog = 7;
    capturedIngestCalls.length = 0;
    capturedStatusWrites.length = 0;

    const { runImageOpsDataSimulator } =
      await import("./image-ops-data-simulator");
    const { OPS_TREND_METRIC_REGISTRY, OPS_SNAPSHOT_TREND_METRIC_REGISTRY } =
      await import("./image-ops-control-module");

    await runImageOpsDataSimulator({
      durationSeconds: 1,
      tickMs: 1000,
      injectBullmqSamples: false,
      mutateSettings: false,
      cleanupOnExit: false,
      verbose: false,
    });

    expect(capturedIngestCalls.length).toBeGreaterThan(0);
    const syntheticTickCall =
      capturedIngestCalls[capturedIngestCalls.length - 1] || null;
    expect(syntheticTickCall).not.toBeNull();

    const keys = (syntheticTickCall?.samples || []).map((sample) => sample.key);
    const expectedKeys = [
      ...OPS_TREND_METRIC_REGISTRY.map((metric) => metric.key),
      ...OPS_SNAPSHOT_TREND_METRIC_REGISTRY.map((metric) => metric.key),
    ];

    expect(keys.sort((left, right) => left.localeCompare(right))).toEqual(
      expectedKeys.sort((left, right) => left.localeCompare(right)),
    );
  });

  it("updates queue and job synthetic status values across refresh ticks", async () => {
    mockBacklog = 7;
    capturedIngestCalls.length = 0;
    capturedStatusWrites.length = 0;

    const { runImageOpsDataSimulator } =
      await import("./image-ops-data-simulator");

    await runImageOpsDataSimulator({
      durationSeconds: 4,
      tickMs: 1000,
      injectBullmqSamples: false,
      mutateSettings: false,
      cleanupOnExit: false,
      verbose: false,
      trendProfile: "saw",
      minBacklog: 5,
      maxBacklog: 30,
      workersMin: 1,
      workersMax: 3,
    });

    expect(capturedStatusWrites.length).toBeGreaterThan(1);

    const uniqueCompletedJobs = new Set(
      capturedStatusWrites.map((status) => status.completedJobs),
    );
    const uniqueQueueBacklog = new Set(
      capturedStatusWrites.map((status) => status.queueBacklog),
    );
    const uniqueFlushBatchCount = new Set(
      capturedStatusWrites.map((status) => status.flushBatchCount),
    );

    expect(uniqueCompletedJobs.size).toBeGreaterThan(1);
    expect(uniqueQueueBacklog.size).toBeGreaterThan(1);
    expect(uniqueFlushBatchCount.size).toBeGreaterThan(1);
  });
});
