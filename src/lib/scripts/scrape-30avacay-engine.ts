import { createThirtyAVacayAdapter } from "./scraper-engine/adapters/30avacay";
import { runScraperEngine } from "./scraper-engine/runner";

runScraperEngine(createThirtyAVacayAdapter()).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`ThirtyAVacay engine scrape failed: ${message}`);
  process.exit(1);
});
