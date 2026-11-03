import { createRedisConnection } from "../../workers/image-queue";
import {
  deriveOpsTelemetry,
  initialOpsMachineState,
  reduceOpsMachine,
} from "./image-ops-state-machine";
import { readImageQueueCounts } from "./image-queue-ops";
import {
  readRunnerControlSettings,
  readRunnerInfraSnapshot,
  readRunnerStatus,
  writeRunnerControlSettings,
  type RunnerControlSettings,
} from "./image-runner-control";

export type VerifyResult = {
  ok: boolean;
  checks: {
    settingsRead: boolean;
    settingsWriteRoundtrip: boolean;
    infraRead: boolean;
    statusRead: boolean;
    queueRead: boolean;
    telemetryDerived: boolean;
    machineReduced: boolean;
  };
  details: Record<string, unknown>;
};

export type StateVerifyOptions = {
  exerciseSet: boolean;
};

function sameSettings(
  a: RunnerControlSettings,
  b: RunnerControlSettings,
): boolean {
  return (
    a.desiredMode === b.desiredMode &&
    a.enqueueEnabled === b.enqueueEnabled &&
    a.requireWorkersForEnqueue === b.requireWorkersForEnqueue &&
    a.minWorkersToEnqueue === b.minWorkersToEnqueue &&
    a.maxQueueBacklog === b.maxQueueBacklog &&
    a.refillLowWatermark === b.refillLowWatermark &&
    a.refillTargetBacklog === b.refillTargetBacklog &&
    a.maxClaimPerCycle === b.maxClaimPerCycle &&
    a.flushIntervalMs === b.flushIntervalMs &&
    a.harvestEnabled === b.harvestEnabled
  );
}

export async function runImageOpsStateVerify(
  options: StateVerifyOptions,
): Promise<VerifyResult> {
  const redis = createRedisConnection();

  const result: VerifyResult = {
    ok: false,
    checks: {
      settingsRead: false,
      settingsWriteRoundtrip: false,
      infraRead: false,
      statusRead: false,
      queueRead: false,
      telemetryDerived: false,
      machineReduced: false,
    },
    details: {},
  };

  try {
    const settings = await readRunnerControlSettings(redis);
    result.checks.settingsRead = true;
    result.details.settings = settings;

    if (options.exerciseSet) {
      const before = settings;
      await writeRunnerControlSettings(redis, { ...before });
      const after = await readRunnerControlSettings(redis);
      result.checks.settingsWriteRoundtrip = sameSettings(before, after);
      result.details.settingsRoundtrip = {
        exercised: true,
        same: result.checks.settingsWriteRoundtrip,
      };
    } else {
      result.checks.settingsWriteRoundtrip = true;
      result.details.settingsRoundtrip = {
        exercised: false,
      };
    }

    const infra = await readRunnerInfraSnapshot(redis);
    result.checks.infraRead = true;
    result.details.infra = infra;

    const status = await readRunnerStatus(redis);
    result.checks.statusRead = true;
    result.details.status = status;

    const queue = await readImageQueueCounts();
    result.checks.queueRead = true;
    result.details.queue = queue;

    const telemetry = deriveOpsTelemetry({
      settings,
      infra,
      status,
      queue,
      errors: {},
    });
    result.checks.telemetryDerived = true;
    result.details.telemetry = telemetry;

    const machine = reduceOpsMachine(initialOpsMachineState(), {
      type: "refresh_success",
      input: {
        settings,
        infra,
        status,
        queue,
        errors: {},
      },
      nowMs: Date.now(),
    });
    result.checks.machineReduced = true;
    result.details.machine = machine;

    result.ok = Object.values(result.checks).every(Boolean);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.details.error = message;
    result.ok = false;
    return result;
  } finally {
    await redis.quit();
  }
}
