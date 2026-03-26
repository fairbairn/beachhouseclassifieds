import { createExclusive30AAdapter } from "./scraper-engine/adapters/exclusive30a";
import { runScraperEngine } from "./scraper-engine/runner";

runScraperEngine(createExclusive30AAdapter()).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Exclusive30A engine scrape failed: ${message}`);
  process.exit(1);
});
