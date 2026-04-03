import { runValidateScrapeFilenameAlignmentCli } from "@/lib/pricing/validation/validate-scrape-filename-alignment";

async function main(): Promise<void> {
  const code = await runValidateScrapeFilenameAlignmentCli(
    process.argv.slice(2),
  );
  process.exit(code);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Scrape filename validation failed: ${message}`);
  process.exit(1);
});
