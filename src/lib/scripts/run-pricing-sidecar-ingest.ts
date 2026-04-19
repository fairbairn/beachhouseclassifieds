import "@/core/tooling/env/load-env-profile";

import { runPricingSidecarIngestCli } from "@/lib/pricing/ingestion/run-pricing-sidecar-ingest-cli";

async function run(): Promise<number> {
  return runPricingSidecarIngestCli(process.argv.slice(2));
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
    console.error(`pricing sidecar ingest failed: ${message}`);
    process.exit(1);
  });
