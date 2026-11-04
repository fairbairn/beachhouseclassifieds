import "@/core/tooling/env/load-env-profile";

import {
  runImageOpsMetricsHarness,
  type ImageOpsMetricsHarnessOptions,
} from "@/lib/workers/image-ops-metrics-harness";
import { configureRedisTarget } from "@/workers/image-queue";

type RedisTarget = "local" | "cloud";

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

function parseArgs(argv: string[]): {
  redisTarget: RedisTarget;
  appName: string;
  options: ImageOpsMetricsHarnessOptions;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      values.set(key, next);
      index += 1;
      continue;
    }

    values.set(key, "true");
  }

  const redisTargetRaw = (values.get("redis-target") || "local")
    .trim()
    .toLowerCase();

  return {
    redisTarget: redisTargetRaw === "cloud" ? "cloud" : "local",
    appName: values.get("app")?.trim() || "beachhouseclassifieds",
    options: {
      appName: values.get("app")?.trim() || "beachhouseclassifieds",
      runSeededRollupScenario: parseBool(values.get("run-seeded"), true),
      runSimulatorScenario: parseBool(values.get("run-simulator"), true),
    },
  };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  configureRedisTarget(args.redisTarget);

  const result = await runImageOpsMetricsHarness(args.options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.ok ? 0 : 1;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`run-image-ops-metrics-harness failed: ${message}\n`);
    process.exit(1);
  });
