import { createLuxe30AAdapter } from "./scraper-engine/adapters/luxe30a";
import { runScraperEngine } from "./scraper-engine/runner";

runScraperEngine(createLuxe30AAdapter()).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Luxe30A engine scrape failed: ${message}`);
  process.exit(1);
});
