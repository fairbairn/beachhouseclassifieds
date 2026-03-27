import { createRoyalDestinationsAdapter } from "./scraper-engine/adapters/royaldestinations";
import { runScraperEngine } from "./scraper-engine/runner";

runScraperEngine(createRoyalDestinationsAdapter()).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Royal Destinations engine scrape failed: ${message}`);
  process.exit(1);
});
