import { createFiveStar30AAdapter } from "./scraper-engine/adapters/fivestar30a";
import { runScraperEngine } from "./scraper-engine/runner";

runScraperEngine(createFiveStar30AAdapter()).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Five Star 30A engine scrape failed: ${message}`);
  process.exit(1);
});
