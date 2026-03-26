import { create30ALuxuryAdapter } from "./scraper-engine/adapters/30aluxury";
import { runScraperEngine } from "./scraper-engine/runner";

runScraperEngine(create30ALuxuryAdapter()).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`30A Luxury engine scrape failed: ${message}`);
  process.exit(1);
});
