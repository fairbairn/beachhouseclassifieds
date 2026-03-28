import { createPanhandle30AAdapter } from "./scraper-engine/adapters/panhandle30a";
import { runScraperEngine } from "./scraper-engine/runner";

runScraperEngine(createPanhandle30AAdapter()).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Panhandle30A engine scrape failed: ${message}`);
  process.exit(1);
});
