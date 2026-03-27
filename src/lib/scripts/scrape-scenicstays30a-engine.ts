import { createScenicStays30AAdapter } from "./scraper-engine/adapters/scenicstays30a";
import { runScraperEngine } from "./scraper-engine/runner";

runScraperEngine(createScenicStays30AAdapter()).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`ScenicStays30A engine scrape failed: ${message}`);
  process.exit(1);
});
