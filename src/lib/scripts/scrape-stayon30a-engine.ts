import { createStayOn30AAdapter } from "./scraper-engine/adapters/stayon30a";
import { runScraperEngine } from "./scraper-engine/runner";

runScraperEngine(createStayOn30AAdapter()).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`StayOn30A engine scrape failed: ${message}`);
  process.exit(1);
});
