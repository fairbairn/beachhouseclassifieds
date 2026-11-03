import "@/core/tooling/env/load-env-profile";

import { runImageOpsStateVerify } from "../workers/image-ops-state-verify";

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) {
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

function parseArgs(argv: string[]): { exerciseSet: boolean } {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      values.set(key, next);
      i += 1;
    }
  }

  return {
    exerciseSet: parseBoolean(values.get("exercise-set"), true),
  };
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await runImageOpsStateVerify({
    exerciseSet: args.exerciseSet,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.ok ? 0 : 1);
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`image ops state verify failed: ${message}\n`);
  process.exit(1);
});
