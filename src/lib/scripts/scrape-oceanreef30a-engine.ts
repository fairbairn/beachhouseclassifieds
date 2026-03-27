import { createOceanReef30AAdapter } from "./scraper-engine/adapters/oceanreef30a";
import { runScraperEngine } from "./scraper-engine/runner";

runScraperEngine(createOceanReef30AAdapter()).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`OceanReef30A engine scrape failed: ${message}`);
  process.exit(1);
});