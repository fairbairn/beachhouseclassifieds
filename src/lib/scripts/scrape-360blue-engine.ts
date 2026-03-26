import { createBlue360Adapter } from "./scraper-engine/adapters/blue360";
import { runScraperEngine } from "./scraper-engine/runner";

runScraperEngine(createBlue360Adapter()).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`360Blue engine scrape failed: ${message}`);
  process.exit(1);
});
