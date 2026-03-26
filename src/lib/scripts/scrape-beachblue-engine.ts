import { createBeachBlueAdapter } from "./scraper-engine/adapters/beachblue";
import { runScraperEngine } from "./scraper-engine/runner";

runScraperEngine(createBeachBlueAdapter()).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Beach Blue engine scrape failed: ${message}`);
  process.exit(1);
});
