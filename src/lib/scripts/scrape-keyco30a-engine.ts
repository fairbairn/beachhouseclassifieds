import { createKeyco30AAdapter } from "./scraper-engine/adapters/keyco30a";
import { runScraperEngine } from "./scraper-engine/runner";

runScraperEngine(createKeyco30AAdapter()).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Keyco30A engine scrape failed: ${message}`);
  process.exit(1);
});
