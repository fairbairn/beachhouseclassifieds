import { createHomeownersCollection30AAdapter } from "./scraper-engine/adapters/homeownerscollection30a";
import { runScraperEngine } from "./scraper-engine/runner";

runScraperEngine(createHomeownersCollection30AAdapter()).catch(
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`HomeownersCollection30A engine scrape failed: ${message}`);
    process.exit(1);
  },
);
