import { createFunVacay30AAdapter } from "./scraper-engine/adapters/funvacay30a";
import { runScraperEngine } from "./scraper-engine/runner";

runScraperEngine(createFunVacay30AAdapter()).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`FunVacay30A engine scrape failed: ${message}`);
  process.exit(1);
});
