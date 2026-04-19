import "@/core/tooling/env/load-env-profile";

import { runListingPricingSummaryRefreshCli } from "@/lib/pricing/summary/run-listing-pricing-summary-refresh-cli";

async function run(): Promise<number> {
  return runListingPricingSummaryRefreshCli(process.argv.slice(2));
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
    console.error(`listing pricing summary refresh failed: ${message}`);
    process.exit(1);
  });
