import { createCoastProperties30AAdapter } from "./scraper-engine/adapters/coastproperties30a";
import { runScraperEngine } from "./scraper-engine/runner";

runScraperEngine(createCoastProperties30AAdapter()).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`CoastProperties30A engine scrape failed: ${message}`);
  process.exit(1);
});
