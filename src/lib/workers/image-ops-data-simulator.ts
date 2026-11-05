import { randomUUID } from "node:crypto";
import {
  appendOpsBullmqSample,
  createOpsQueueRuntime,
  listOpsPendingJobsForOperation,
  readOpsControlSettings,
  readOpsSharedState,
  setOpsBacklogForOperation,
  updateOpsControlSettings,
  writeOpsInfraSnapshot,
  writeOpsRunnerStatus,
} from "./image-ops-control-module";

export type ImageOpsDataSimulatorOptions = {
  durationSeconds: number;
  tickMs: number;
  injectBullmqSamples: boolean;
  bullmqSampleCount: number;
  minBacklog: number;
  maxBacklog: number;
  workersMin: number;
  workersMax: number;
  mutateSettings: boolean;
  cleanupOnExit: boolean;
  trendProfile: "smooth" | "saw" | "bursty";
  noisePct: number;
  verbose: boolean;
  logIntervalSeconds: number;
};

export type ImageOpsDataSimulatorResult = {
  operationId: string;
  ticks: number;
  finalBacklog: number;
  finalWorkersRunning: number;
};

const DEFAULT_OPTIONS: ImageOpsDataSimulatorOptions = {
  durationSeconds: 60,
  tickMs: 1000,
  injectBullmqSamples: true,
  bullmqSampleCount: 10,
  minBacklog: 5,
  maxBacklog: 80,
  workersMin: 0,
  workersMax: 4,
  mutateSettings: true,
  cleanupOnExit: false,
  trendProfile: "smooth",
  noisePct: 0.08,
  verbose: false,
  logIntervalSeconds: 5,
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function wave(step: number, period: number): number {
  const p = Math.max(2, period);
  const phase = step % p;
  const half = p / 2;
  if (phase <= half) {
    return phase / half;
  }
  return (p - phase) / half;
}

function saw(step: number, period: number): number {
  const p = Math.max(2, period);
  const phase = step % p;
  return phase / (p - 1);
}

function boundedNoise(pct: number): number {
  const raw = (Math.random() * 2 - 1) * Math.max(0, Math.min(1, pct));
  return raw;
}

function resolveSimMode(
  desiredMode: "run" | "idle" | "drain" | "stop",
): "running" | "idle" | "stopping" {
  if (desiredMode === "stop") {
    return "stopping";
  }
  if (desiredMode === "idle") {
    return "idle";
  }
  return "running";
}

function resolveGateReason(
  desiredMode: "run" | "idle" | "drain" | "stop",
): string {
  if (desiredMode === "run") {
    return "gate=open";
  }
  if (desiredMode === "drain") {
    return "gate=drain";
  }
  if (desiredMode === "idle") {
    return "gate=idle";
  }
  return "gate=stop";
}

async function seedBullmqSampleCompletedJobs(input: {
  operationId: string;
  sampleCount: number;
}): Promise<void> {
  const count = Math.max(0, Math.floor(input.sampleCount));
  if (count <= 0) {
    return;
  }

  for (let index = 0; index < count; index += 1) {
    const nowMs = Date.now() - (count - index) * 900;
    const itemCount = 1 + (index % 3);
    const fetchMs = 120 + (index % 5) * 14;
    const transformMs = 75 + (index % 4) * 10;
    const uploadMs = 52 + (index % 4) * 8;
    const failedCount = index % 9 === 0 ? 1 : 0;

    await appendOpsBullmqSample({
      operationId: input.operationId,
      sampleId: `seeded:${String(index + 1).padStart(3, "0")}`,
      atMs: nowMs,
      processedCount: itemCount,
      failedCount,
      avgFetchMs: fetchMs,
      avgTransformMs: transformMs,
      avgUploadMs: uploadMs,
    });
  }
}

async function appendBullmqSampleFromTick(input: {
  operationId: string;
  tick: number;
  completedDelta: number;
  failedDelta: number;
  avgFetchMs: number;
  avgTransformMs: number;
  avgUploadMs: number;
}): Promise<void> {
  const completedCount = Math.max(0, Math.floor(input.completedDelta));
  const failedCount = Math.max(0, Math.floor(input.failedDelta));
  if (completedCount <= 0 && failedCount <= 0) {
    return;
  }

  await appendOpsBullmqSample({
    operationId: input.operationId,
    sampleId: `tick:${String(input.tick).padStart(6, "0")}`,
    atMs: Date.now(),
    processedCount: completedCount,
    failedCount,
    avgFetchMs: input.avgFetchMs,
    avgTransformMs: input.avgTransformMs,
    avgUploadMs: input.avgUploadMs,
  });
}

export async function runImageOpsDataSimulator(
  overrides?: Partial<ImageOpsDataSimulatorOptions>,
): Promise<ImageOpsDataSimulatorResult> {
  const options: ImageOpsDataSimulatorOptions = {
    ...DEFAULT_OPTIONS,
    ...overrides,
  };

  const durationSeconds = clamp(options.durationSeconds, 1, 86_400);
  const tickMs = clamp(options.tickMs, 250, 10_000);
  const bullmqSampleCount = clamp(options.bullmqSampleCount, 0, 200);
  const minBacklog = clamp(options.minBacklog, 0, 100_000);
  const maxBacklog = clamp(options.maxBacklog, minBacklog, 100_000);
  const workersMin = clamp(options.workersMin, 0, 100);
  const workersMax = clamp(options.workersMax, workersMin, 100);
  const trendProfile = options.trendProfile;
  const noisePct = clamp(options.noisePct, 0, 0.8);
  const verbose = options.verbose;
  const logIntervalSeconds = clamp(options.logIntervalSeconds, 1, 300);
  const logEveryTicks = Math.max(
    1,
    Math.round((logIntervalSeconds * 1000) / tickMs),
  );

  const operationId = `ops-sim-${new Date().toISOString().replace(/[.:]/g, "-")}-${randomUUID().slice(0, 6)}`;
  const queueRuntime = await createOpsQueueRuntime();
  const queue = queueRuntime.queue;

  const totalTicks = Math.max(1, Math.floor((durationSeconds * 1000) / tickMs));
  let nextIndex = 0;
  let processedItems = 0;
  let failedItems = 0;
  let completedJobs = 0;
  let failedJobs = 0;
  let simulatedQueueCompleted = 0;
  let simulatedQueueFailed = 0;

  if (options.mutateSettings) {
    await updateOpsControlSettings((current) => ({
      ...current,
      desiredMode: "run",
      maxQueueBacklog: Math.max(current.maxQueueBacklog, maxBacklog),
    }));
  }

  if (verbose) {
    process.stdout.write(
      `${JSON.stringify(
        {
          event: "image_ops_data_simulator_start",
          operationId,
          totalTicks,
          tickMs,
          injectBullmqSamples: options.injectBullmqSamples,
          bullmqSampleCount,
          minBacklog,
          maxBacklog,
          workersMin,
          workersMax,
          trendProfile,
          noisePct,
          logIntervalSeconds,
        },
        null,
        0,
      )}\n`,
    );
  }

  try {
    if (options.injectBullmqSamples && bullmqSampleCount > 0) {
      await seedBullmqSampleCompletedJobs({
        operationId,
        sampleCount: bullmqSampleCount,
      });
    }

    for (let tick = 0; tick < totalTicks; tick += 1) {
      const settings = await readOpsControlSettings();
      const desiredMode = settings.desiredMode;

      const backlogFactorBase =
        trendProfile === "saw"
          ? saw(tick, 16)
          : trendProfile === "bursty"
            ? wave(tick, 18)
            : wave(tick, 40);
      const workerFactorBase =
        trendProfile === "saw"
          ? saw(tick + 5, 12)
          : trendProfile === "bursty"
            ? wave(tick + 3, 10)
            : wave(tick + 5, 28);

      const backlogFactor = clamp(
        backlogFactorBase + boundedNoise(noisePct),
        0,
        1,
      );
      const workerFactor = clamp(
        workerFactorBase + boundedNoise(noisePct * 0.7),
        0,
        1,
      );

      const backlogWave = Math.round(
        minBacklog + (maxBacklog - minBacklog) * backlogFactor,
      );
      const workerWave = Math.round(
        workersMin + (workersMax - workersMin) * workerFactor,
      );

      const burstActive = trendProfile === "bursty" && tick % 14 < 3;
      const burstBacklog = burstActive
        ? Math.round((maxBacklog - minBacklog) * 0.18)
        : 0;

      const workersRunning =
        desiredMode === "run"
          ? workerWave
          : desiredMode === "drain"
            ? Math.max(0, workerWave - 1)
            : 0;

      const targetBacklog =
        desiredMode === "stop"
          ? 0
          : desiredMode === "drain"
            ? Math.round(minBacklog * wave(tick + 2, 7))
            : desiredMode === "idle"
              ? Math.round(minBacklog + wave(tick + 3, 9) * 2)
              : clamp(backlogWave + burstBacklog, minBacklog, maxBacklog);

      nextIndex = await setOpsBacklogForOperation({
        queue,
        operationId,
        target: targetBacklog,
        nextIndex,
      });

      const state = await readOpsSharedState();
      const tickSeconds = tickMs / 1000;
      const backlog = state.queue.backlog;
      const activeCapacity = Math.max(0, Math.round(workersRunning * 1.6));
      const simulatedQueueActive = Math.min(backlog, activeCapacity);

      const throughputBase =
        trendProfile === "saw"
          ? 0.4 + 1.6 * saw(tick + 1, 12)
          : trendProfile === "bursty"
            ? 0.35 + 1.8 * wave(tick + 1, 8)
            : 0.65 + 1.15 * wave(tick + 1, 24);
      const throughputPerSecond =
        workersRunning *
        Math.max(0, throughputBase * (1 + boundedNoise(noisePct * 0.6)));
      const completedDelta =
        desiredMode === "stop"
          ? 0
          : Math.min(
              Math.max(0, Math.round(throughputPerSecond * tickSeconds)),
              backlog,
            );
      const failedDelta =
        workersRunning > 0 && desiredMode !== "stop" && tick % 11 === 0 ? 1 : 0;

      processedItems += completedDelta;
      failedItems += failedDelta;
      completedJobs = processedItems;
      failedJobs = failedItems;

      const avgFetchMs = Math.max(
        10,
        Math.round(
          85 + 190 * wave(tick + 1, 21) * (1 + boundedNoise(noisePct)),
        ),
      );
      const avgTransformMs = Math.max(
        8,
        Math.round(
          40 + 140 * wave(tick + 5, 19) * (1 + boundedNoise(noisePct)),
        ),
      );
      const avgUploadMs = Math.max(
        6,
        Math.round(30 + 90 * wave(tick + 9, 17) * (1 + boundedNoise(noisePct))),
      );
      const avgEndToEndMs = avgFetchMs + avgTransformMs + avgUploadMs;
      const throughputImagesPerMinute = Math.max(
        0,
        Number((throughputPerSecond * 60).toFixed(2)),
      );
      simulatedQueueCompleted += completedDelta;
      simulatedQueueFailed += failedDelta;

      const simulatedQueueWaiting = Math.max(0, backlog - simulatedQueueActive);
      const simulatedQueueDelayed = Math.max(
        0,
        Math.round(simulatedQueueWaiting * 0.12 * wave(tick + 4, 10)),
      );
      const simulatedQueuePaused =
        desiredMode === "idle" ? state.queue.paused : 0;
      const simulatedQueueBacklog =
        simulatedQueueWaiting +
        simulatedQueueActive +
        simulatedQueueDelayed +
        simulatedQueuePaused;

      const mode = resolveSimMode(desiredMode);
      const gateReason = resolveGateReason(desiredMode);

      await writeOpsInfraSnapshot({
        workersRunning,
        source: "image-ops-data-simulator",
        updatedAt: new Date().toISOString(),
      });

      await writeOpsRunnerStatus({
        operationId,
        mode,
        desiredMode,
        gateReason,
        workersRunning,
        claimedCount: Math.max(
          state.queue.backlog,
          processedItems + failedItems,
        ),
        queuedCount: state.queue.backlog,
        completedJobs,
        failedJobs,
        processedItems,
        failedItems,
        queueWaiting: simulatedQueueWaiting,
        queueActive: simulatedQueueActive,
        queueCompleted: simulatedQueueCompleted,
        queueFailed: simulatedQueueFailed,
        queueDelayed: simulatedQueueDelayed,
        queuePaused: simulatedQueuePaused,
        queueBacklog: simulatedQueueBacklog,
        lastFlushAt: new Date().toISOString(),
        flushBatchCount: tick + 1,
        pendingSuccessBuffer: Math.max(
          0,
          Math.round(simulatedQueueActive * wave(tick + 6, 8)),
        ),
        pendingErrorBuffer: Math.max(
          0,
          Math.round(simulatedQueueActive * 0.08 * wave(tick + 7, 12)),
        ),
        throughputImagesPerMinute,
        avgFetchMs,
        avgTransformMs,
        avgUploadMs,
        avgEndToEndMs,
        updatedAt: new Date().toISOString(),
      });

      if (options.injectBullmqSamples) {
        await appendBullmqSampleFromTick({
          operationId,
          tick: tick + 1,
          completedDelta,
          failedDelta,
          avgFetchMs,
          avgTransformMs,
          avgUploadMs,
        });
      }

      if (
        verbose &&
        (tick === 0 ||
          (tick + 1) % logEveryTicks === 0 ||
          tick === totalTicks - 1)
      ) {
        process.stdout.write(
          `${JSON.stringify(
            {
              event: "image_ops_data_simulator_tick",
              operationId,
              tick: tick + 1,
              totalTicks,
              desiredMode,
              workersRunning,
              throughputImagesPerMinute,
              avgFetchMs,
              avgTransformMs,
              avgUploadMs,
              avgEndToEndMs,
              targetBacklog,
              queueBacklog: simulatedQueueBacklog,
              processedItems,
              failedItems,
            },
            null,
            0,
          )}\n`,
        );
      }

      if (tick < totalTicks - 1) {
        await new Promise((resolve) => setTimeout(resolve, tickMs));
      }
    }

    const finalState = await readOpsSharedState();
    return {
      operationId,
      ticks: totalTicks,
      finalBacklog: finalState.queue.backlog,
      finalWorkersRunning: finalState.infra?.workersRunning ?? 0,
    };
  } finally {
    if (options.cleanupOnExit) {
      const jobs = await listOpsPendingJobsForOperation(queue, operationId);
      await Promise.all(jobs.map((job) => job.remove().catch(() => undefined)));
    }
    await queueRuntime.close();
  }
}
