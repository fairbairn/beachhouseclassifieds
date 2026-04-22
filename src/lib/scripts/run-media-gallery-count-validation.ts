import { runValidateMediaGalleryCountCoverageCli } from "@/lib/pricing/validation/validate-media-gallery-count-coverage";

async function main(): Promise<void> {
  const code = await runValidateMediaGalleryCountCoverageCli(
    process.argv.slice(2),
  );
  process.exit(code);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Media gallery count validation failed: ${message}`);
  process.exit(1);
});
