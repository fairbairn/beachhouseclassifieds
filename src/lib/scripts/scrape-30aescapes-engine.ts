import { createEscapes30AAdapter } from "./scraper-engine/adapters/escapes-30a";
import { runScraperEngine } from "./scraper-engine/runner";

runScraperEngine(createEscapes30AAdapter()).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`30A Escapes engine scrape failed: ${message}`);
  process.exit(1);
});
