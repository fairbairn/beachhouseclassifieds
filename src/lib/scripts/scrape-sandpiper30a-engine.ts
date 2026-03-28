import { createSandpiper30AAdapter } from "./scraper-engine/adapters/sandpiper30a";
import { runScraperEngine } from "./scraper-engine/runner";

runScraperEngine(createSandpiper30AAdapter()).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Sandpiper30A engine scrape failed: ${message}`);
  process.exit(1);
});
