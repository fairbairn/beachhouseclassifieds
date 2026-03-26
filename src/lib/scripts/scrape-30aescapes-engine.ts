import { create30AEscapesAdapter } from "./scraper-engine/adapters/30aescapes";
import { runScraperEngine } from "./scraper-engine/runner";

runScraperEngine(create30AEscapesAdapter()).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`30A Escapes engine scrape failed: ${message}`);
  process.exit(1);
});
