import { createSandersBeach30AAdapter } from "./scraper-engine/adapters/sandersbeach30a";
import { runScraperEngine } from "./scraper-engine/runner";

runScraperEngine(createSandersBeach30AAdapter()).catch(
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`SandersBeach30A engine scrape failed: ${message}`);
    process.exit(1);
  },
);
