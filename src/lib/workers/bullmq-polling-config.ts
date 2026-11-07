export type BullmqPollingConfig = {
  eventsEnabled: boolean;
  pollingEnabled: boolean;
  eventMinIntervalMs: number;
  pollBatchLimit: number;
  collectorIntervalMs: number;
  pollLookbackMs: number;
};

function readBooleanEnv(
  env: Record<string, string | undefined>,
  name: string,
  fallback: boolean,
): boolean {
  const raw = env[name];
  if (raw === undefined) {
    return fallback;
  }
  const normalized = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function readIntEnv(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

export function resolveBullmqPollingConfig(
  env: Record<string, string | undefined> = process.env,
): BullmqPollingConfig {
  const eventsEnabled = readBooleanEnv(
    env,
    "IMAGE_OPS_BULLMQ_EVENTS_ENABLED",
    false,
  );
  const pollingEnabled = readBooleanEnv(
    env,
    "IMAGE_OPS_BULLMQ_POLLING_ENABLED",
    true,
  );

  return {
    eventsEnabled,
    pollingEnabled,
    eventMinIntervalMs: readIntEnv(
      env,
      "IMAGE_OPS_BULLMQ_EVENT_MIN_INTERVAL_MS",
      100,
      50,
      5000,
    ),
    pollBatchLimit: readIntEnv(
      env,
      "IMAGE_OPS_BULLMQ_POLL_BATCH_LIMIT",
      1200,
      100,
      10000,
    ),
    collectorIntervalMs: readIntEnv(
      env,
      "IMAGE_OPS_BULLMQ_COLLECTOR_INTERVAL_MS",
      1000,
      100,
      10000,
    ),
    pollLookbackMs: readIntEnv(
      env,
      "IMAGE_OPS_BULLMQ_POLL_LOOKBACK_MS",
      60 * 1000,
      15_000,
      24 * 60 * 60 * 1000,
    ),
  };
}
