import { runValidateAvailabilityStatusCodesCli } from "@/lib/pricing/validation/validate-availability-status-codes";

async function main(): Promise<void> {
  const code = await runValidateAvailabilityStatusCodesCli(process.argv.slice(2));
  process.exit(code);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Availability status validation failed: ${message}`);
  process.exit(1);
});
