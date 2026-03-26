import { createBenchmark30AAdapter } from "./scraper-engine/adapters/benchmark30a";
import { runScraperEngine } from "./scraper-engine/runner";

runScraperEngine(createBenchmark30AAdapter()).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Benchmark30A engine scrape failed: ${message}`);
  process.exit(1);
});
