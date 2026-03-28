import { create30ABeachAdapter } from "./scraper-engine/adapters/30abeach";
import { runScraperEngine } from "./scraper-engine/runner";

runScraperEngine(create30ABeachAdapter()).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`30abeach engine scrape failed: ${message}`);
  process.exit(1);
});
