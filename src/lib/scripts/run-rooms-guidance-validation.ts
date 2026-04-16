import { runValidateRoomsGuidanceCoverageCli } from "@/lib/pricing/validation/validate-rooms-guidance-coverage";

async function main(): Promise<void> {
  const code = await runValidateRoomsGuidanceCoverageCli(process.argv.slice(2));
  process.exit(code);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Rooms guidance validation failed: ${message}`);
  process.exit(1);
});
