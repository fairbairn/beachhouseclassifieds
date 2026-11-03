import "@/core/tooling/env/load-env-profile";

import { runImageOpsSurfaceTest } from "../workers/image-ops-surface-test";

async function run(): Promise<void> {
  const output = await runImageOpsSurfaceTest();

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  process.exit(output.ok ? 0 : 1);
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`image ops surface tester failed: ${message}\n`);
  process.exit(1);
});
