import { metadata, task, wait } from "@trigger.dev/sdk";

type ProgressProbePayload = {
  steps?: number;
  sleepSeconds?: number;
  label?: string;
};

type ProgressProbeResult = {
  label: string;
  steps: number;
  sleep_seconds: number;
  started_at: string;
  completed_at: string;
  elapsed_ms: number;
};

export const progressProbeTask = task({
  id: "progress-probe-task",
  run: async (payload: ProgressProbePayload = {}): Promise<ProgressProbeResult> => {
    const steps = Math.max(1, Math.min(50, Math.floor(payload.steps ?? 8)));
    const sleepSeconds = Math.max(1, Math.min(10, Math.floor(payload.sleepSeconds ?? 2)));
    const label = String(payload.label ?? "default");

    const startedAtDate = new Date();
    const startedAt = startedAtDate.toISOString();

    console.log(
      `[progress-probe-task] started label=${label} steps=${steps} sleep_seconds=${sleepSeconds}`,
    );

    metadata.set("progress", {
      current: 0,
      total: steps,
      percentage: 0,
      label,
    });

    for (let index = 0; index < steps; index += 1) {
      const stepNumber = index + 1;
      const percentage = Math.round((stepNumber / steps) * 100);
      console.log(`[progress-probe-task] step ${stepNumber}/${steps}`);
      metadata.set("progress", {
        current: stepNumber,
        total: steps,
        percentage,
        label,
      });
      await wait.for({ seconds: sleepSeconds });
    }

    metadata.set("status", "completed");

    const completedAtDate = new Date();
    const completedAt = completedAtDate.toISOString();

    return {
      label,
      steps,
      sleep_seconds: sleepSeconds,
      started_at: startedAt,
      completed_at: completedAt,
      elapsed_ms: completedAtDate.getTime() - startedAtDate.getTime(),
    };
  },
});
