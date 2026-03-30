import { runAdapterScrapeCli } from "@/lib/pricing/scraper-engine/run-adapter-scrape";

async function main(): Promise<void> {
  await runAdapterScrapeCli(process.argv.slice(2), process.argv);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Adapter engine scrape failed: ${message}`);
  process.exit(1);
});
