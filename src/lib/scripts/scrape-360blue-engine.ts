import { create360BlueAdapter } from "./scraper-engine/adapters/360blue";
import { runScraperEngine } from "./scraper-engine/runner";

runScraperEngine(create360BlueAdapter()).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`360Blue engine scrape failed: ${message}`);
  process.exit(1);
});
