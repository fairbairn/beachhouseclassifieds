import "@/core/tooling/env/load-env-profile";

import { runCanonicalListingIngestCli } from "@/lib/listings/ingestion/run-canonical-listing-ingest-cli";

async function run(): Promise<number> {
  return runCanonicalListingIngestCli(process.argv.slice(2));
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
    console.error(`canonical listing ingest failed: ${message}`);
    process.exit(1);
  });
