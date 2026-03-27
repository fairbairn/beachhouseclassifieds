import { createOversee30AAdapter } from "./scraper-engine/adapters/oversee30a";
import { runScraperEngine } from "./scraper-engine/runner";

runScraperEngine(createOversee30AAdapter()).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Oversee30A engine scrape failed: ${message}`);
  process.exit(1);
});
