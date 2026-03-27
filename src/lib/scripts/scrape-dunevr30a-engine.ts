import { createDuneVR30AAdapter } from "./scraper-engine/adapters/dunevr30a";
import { runScraperEngine } from "./scraper-engine/runner";

runScraperEngine(createDuneVR30AAdapter()).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`DuneVR30A engine scrape failed: ${message}`);
  process.exit(1);
});
