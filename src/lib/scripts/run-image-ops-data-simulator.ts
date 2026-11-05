import "@/core/tooling/env/load-env-profile";

import { runImageOpsDataSimulator } from "@/lib/workers/image-ops-data-simulator";

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(raw || "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseNonNegativeInt(
  raw: string | undefined,
  fallback: number,
): number {
  const parsed = Number.parseInt(String(raw || "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (!raw) {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parseTrendProfile(
  raw: string | undefined,
): "smooth" | "saw" | "bursty" {
  const value = String(raw || "")
    .trim()
    .toLowerCase();
  if (value === "saw" || value === "bursty" || value === "smooth") {
    return value;
  }
  return "smooth";
}

function parseNoisePct(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(String(raw || "").trim());
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.max(0, Math.min(0.8, parsed));
}

function parseArgs(argv: string[]) {
  const options = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      options.set(key, next);
      i += 1;
      continue;
    }
    options.set(key, "true");
  }

  return {
    durationSeconds: parsePositiveInt(options.get("duration-seconds"), 60),
    tickMs: parsePositiveInt(options.get("tick-ms"), 1000),
    injectBullmqSamples: parseBool(options.get("inject-bullmq-samples"), true),
    bullmqSampleCount: parsePositiveInt(options.get("bullmq-sample-count"), 10),
    minBacklog: parseNonNegativeInt(options.get("min-backlog"), 5),
    maxBacklog: parseNonNegativeInt(options.get("max-backlog"), 80),
    workersMin: parseNonNegativeInt(options.get("workers-min"), 0),
    workersMax: parseNonNegativeInt(options.get("workers-max"), 4),
    mutateSettings: parseBool(options.get("mutate-settings"), true),
    cleanupOnExit: parseBool(options.get("cleanup-on-exit"), false),
    trendProfile: parseTrendProfile(options.get("trend-profile")),
    noisePct: parseNoisePct(options.get("noise-pct"), 0.08),
    verbose: parseBool(options.get("verbose"), false),
    logIntervalSeconds: parsePositiveInt(
      options.get("log-interval-seconds"),
      5,
    ),
  };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const result = await runImageOpsDataSimulator(args);
  process.stdout.write("image_ops_data_simulation_complete\n");
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`run-image-ops-data-simulator failed: ${message}\n`);
    process.exit(1);
  });
