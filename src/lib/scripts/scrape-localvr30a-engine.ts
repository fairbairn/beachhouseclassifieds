import { createLocalVR30AAdapter } from "./scraper-engine/adapters/localvr30a";
import { runScraperEngine } from "./scraper-engine/runner";

runScraperEngine(createLocalVR30AAdapter()).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`LocalVR30A engine scrape failed: ${message}`);
  process.exit(1);
});
