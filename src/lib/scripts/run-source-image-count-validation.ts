import "@/core/tooling/env/load-env-profile";

import { runValidateSourceImageCountsCli } from "@/lib/pricing/validation/validate-source-image-counts";

async function main(): Promise<void> {
  const code = await runValidateSourceImageCountsCli(process.argv.slice(2));
  process.exit(code);
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

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Source image count validation failed: ${message}`);
  process.exit(1);
});
