import { createStayAt30AAdapter } from "./scraper-engine/adapters/stayat30a";
import { runScraperEngine } from "./scraper-engine/runner";

runScraperEngine(createStayAt30AAdapter()).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`StayAt30A engine scrape failed: ${message}`);
  process.exit(1);
});
