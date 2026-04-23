import "@/core/tooling/env/load-env-profile";

import { runSourceAvailabilityIngestCli } from "@/lib/pricing/ingestion/run-source-availability-ingest-cli";

async function run(): Promise<number> {
  return runSourceAvailabilityIngestCli(process.argv.slice(2));
}

let exiting = false;
process.on("SIGINT", () => {
  if (exiting) {
    process.exit(130);
  }
  exiting = true;
  process.stderr.write("Operation cancelled by user.\n");
  process.exit(130);
});

run()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`source availability ingest failed: ${message}`);
    process.exit(1);
  });
