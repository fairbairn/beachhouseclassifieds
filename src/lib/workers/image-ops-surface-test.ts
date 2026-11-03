import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

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
} from "./image-runner-control";

export type SurfaceCheck = {
  name: string;
  ok: boolean;
  detail?: string;
};

export type SurfaceTestResult = {
  ok: boolean;
  total: number;
  passed: number;
  failed: number;
  failures: SurfaceCheck[];
};

function check(name: string, ok: boolean, detail?: string): SurfaceCheck {
  return { name, ok, detail };
}

function nonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

export async function runImageOpsSurfaceTest(): Promise<SurfaceTestResult> {
  const checks: SurfaceCheck[] = [];
  const redis = createRedisConnection();

  try {
    const [settings, infra, status, queue] = await Promise.all([
      readRunnerControlSettings(redis),
      readRunnerInfraSnapshot(redis),
      readRunnerStatus(redis),
      readImageQueueCounts(),
    ]);

    checks.push(check("settings.read", settings !== null));
    checks.push(
      check(
        "settings.range.maxQueueBacklog",
        settings.maxQueueBacklog >= 10,
        `maxQueueBacklog=${settings.maxQueueBacklog}`,
      ),
    );
    checks.push(
      check(
        "settings.range.maxClaimPerCycle",
        settings.maxClaimPerCycle >= 1,
        `maxClaimPerCycle=${settings.maxClaimPerCycle}`,
      ),
    );

    checks.push(check("queue.read", queue !== null));
    checks.push(
      check(
        "queue.nonNegative",
        nonNegative(queue.waiting) &&
          nonNegative(queue.active) &&
          nonNegative(queue.delayed) &&
          nonNegative(queue.paused) &&
          nonNegative(queue.completed) &&
          nonNegative(queue.failed) &&
          nonNegative(queue.backlog),
      ),
    );
    checks.push(
      check(
        "queue.backlogFormula",
        queue.backlog ===
          queue.waiting + queue.active + queue.delayed + queue.paused,
        `backlog=${queue.backlog} formula=${queue.waiting + queue.active + queue.delayed + queue.paused}`,
      ),
    );

    checks.push(check("infra.read", true));
    if (infra) {
      checks.push(
        check(
          "infra.nonNegative.workersRunning",
          nonNegative(infra.workersRunning),
          `workersRunning=${infra.workersRunning}`,
        ),
      );
    }

    checks.push(check("status.read", true));
    if (status) {
      checks.push(
        check(
          "status.backlogFormula",
          status.queueBacklog ===
            status.queueWaiting +
              status.queueActive +
              status.queueDelayed +
              status.queuePaused,
          `status.queueBacklog=${status.queueBacklog} formula=${status.queueWaiting + status.queueActive + status.queueDelayed + status.queuePaused}`,
        ),
      );
    }

    const telemetry = deriveOpsTelemetry({
      settings,
      infra,
      status,
      queue,
      errors: {},
    });
    checks.push(check("telemetry.derive", telemetry !== null));
    checks.push(
      check(
        "telemetry.liveGate.string",
        typeof telemetry.liveGate === "string" && telemetry.liveGate.length > 0,
        `liveGate=${telemetry.liveGate}`,
      ),
    );

    const machine0 = initialOpsMachineState();
    const machine1 = reduceOpsMachine(machine0, {
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
    checks.push(check("machine.initial.booting", machine0.phase === "booting"));
    checks.push(
      check(
        "machine.refreshSuccess.increments",
        machine1.refreshCount === machine0.refreshCount + 1,
        `from=${machine0.refreshCount} to=${machine1.refreshCount}`,
      ),
    );

    const machine2 = reduceOpsMachine(machine1, {
      type: "refresh_error",
      message: "synthetic",
      nowMs: Date.now(),
    });
    checks.push(
      check("machine.refreshError.phase", machine2.phase === "error"),
    );
    checks.push(
      check(
        "machine.refreshError.keepsCount",
        machine2.refreshCount === machine1.refreshCount,
      ),
    );

    const repoRoot = resolve(process.cwd());
    const cliPath = resolve(repoRoot, "src/lib/scripts/run-image-ops-cli.ts");
    const hqtuiPath = resolve(
      repoRoot,
      "src/lib/scripts/run-image-ops-hqtui.ts",
    );
    const [cliText, hqtuiText] = await Promise.all([
      readFile(cliPath, "utf8"),
      readFile(hqtuiPath, "utf8"),
    ]);

    checks.push(
      check(
        "surface.cli.imports.shared.queue",
        cliText.includes("../workers/image-queue-ops"),
      ),
    );
    checks.push(
      check(
        "surface.cli.imports.shared.stateMachine",
        cliText.includes("../workers/image-ops-state-machine"),
      ),
    );
    checks.push(
      check(
        "surface.hqtui.imports.shared.queue",
        hqtuiText.includes("../workers/image-queue-ops"),
      ),
    );
    checks.push(
      check(
        "surface.hqtui.imports.shared.stateMachine",
        hqtuiText.includes("../workers/image-ops-state-machine"),
      ),
    );
    checks.push(
      check(
        "surface.hqtui.imports.shared.controlModule",
        hqtuiText.includes("../workers/image-ops-control-module"),
      ),
    );
    checks.push(
      check(
        "surface.hqtui.reads.sharedState",
        hqtuiText.includes("readOpsSharedState(") ||
          hqtuiText.includes("readOpsUiSnapshot("),
      ),
    );
    checks.push(
      check(
        "surface.hqtui.commands.sharedDesiredMode",
        hqtuiText.includes("setOpsDesiredModeWithQueueAction("),
      ),
    );
    checks.push(
      check(
        "surface.hqtui.commands.sharedSettingsUpdate",
        hqtuiText.includes("updateOpsControlSettings("),
      ),
    );

    checks.push(
      check(
        "surface.cli.noDirectQueueBypass",
        !cliText.includes("getJobCounts("),
      ),
    );
    checks.push(
      check(
        "surface.hqtui.noDirectQueueBypass",
        !hqtuiText.includes("getJobCounts("),
      ),
    );
  } finally {
    await redis.quit();
  }

  const failures = checks.filter((c) => !c.ok);
  return {
    ok: failures.length === 0,
    total: checks.length,
    passed: checks.length - failures.length,
    failed: failures.length,
    failures,
  };
}
