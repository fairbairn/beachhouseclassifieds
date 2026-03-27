import { createRealJoy30AAdapter } from "./scraper-engine/adapters/realjoy30a";
import { runScraperEngine } from "./scraper-engine/runner";

runScraperEngine(createRealJoy30AAdapter()).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`RealJoy30A engine scrape failed: ${message}`);
  process.exit(1);
});
