import { createGrayt30AAdapter } from "./scraper-engine/adapters/grayt30a";
import { runScraperEngine } from "./scraper-engine/runner";

runScraperEngine(createGrayt30AAdapter()).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Grayt30A engine scrape failed: ${message}`);
  process.exit(1);
});
