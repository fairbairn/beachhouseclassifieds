import { runQuoteRunnerCli } from "@/lib/pricing/quotes/runner";

async function main(): Promise<void> {
  await runQuoteRunnerCli(process.argv.slice(2), process.argv);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Adapter quote runner failed: ${message}`);
  process.exit(1);
});
