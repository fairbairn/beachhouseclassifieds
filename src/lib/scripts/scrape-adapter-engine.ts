import {
  createAdapterByKey,
  getKnownAdapterKeys,
} from "./scraper-engine/adapter-registry";
import { runScraperEngine } from "./scraper-engine/runner";

type ParsedAdapterArgs = {
  adapterKey: string | null;
  passthroughArgs: string[];
  showHelp: boolean;
};

function buildUsageText(): string {
  const adapters = getKnownAdapterKeys().join(", ");
  return [
    "Usage:",
    "  tsx src/lib/scripts/scrape-adapter-engine.ts --adapter-key <adapter> [engine-options]",
    "  tsx src/lib/scripts/scrape-adapter-engine.ts <adapter> [engine-options]",
    "",
    "Examples:",
    "  npm run managers:scrape:360blue:engine -- --detail-url <url>",
    "  npm run managers:scrape:adapter:engine -- --adapter-key keyco30a --refresh-known --refresh-mode dynamic",
    "",
    `Known adapters: ${adapters}`,
    "",
    "All remaining args are passed to the shared scraper-engine runner.",
  ].join("\n");
}

function parseAdapterArgs(argv: string[]): ParsedAdapterArgs {
  let adapterKey: string | null = null;
  const passthroughArgs: string[] = [];
  let showHelp = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      showHelp = true;
      continue;
    }

    if (arg === "--adapter-key") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--adapter-key requires a value.");
      }
      adapterKey = value.trim().toLowerCase();
      index += 1;
      continue;
    }

    if (arg.startsWith("--adapter-key=")) {
      const value = arg.slice("--adapter-key=".length).trim();
      if (!value) {
        throw new Error("--adapter-key requires a value.");
      }
      adapterKey = value.toLowerCase();
      continue;
    }

    if (!adapterKey && !arg.startsWith("--")) {
      const positional = arg.trim().toLowerCase();
      if (getKnownAdapterKeys().includes(positional)) {
        adapterKey = positional;
        continue;
      }
    }

    passthroughArgs.push(arg);
  }

  return {
    adapterKey,
    passthroughArgs,
    showHelp,
  };
}

async function main(): Promise<void> {
  const parsed = parseAdapterArgs(process.argv.slice(2));
  if (parsed.showHelp) {
    console.log(buildUsageText());
    process.exit(0);
  }

  if (!parsed.adapterKey) {
    throw new Error(
      `Missing adapter key. Use --adapter-key <adapter>.\n\n${buildUsageText()}`,
    );
  }

  const adapter = createAdapterByKey(parsed.adapterKey);
  if (!adapter) {
    throw new Error(
      `Unknown adapter key '${parsed.adapterKey}'.\n\n${buildUsageText()}`,
    );
  }

  const forwardedArgv = [
    process.argv[0] ?? "node",
    process.argv[1] ?? "scrape-adapter-engine",
    ...parsed.passthroughArgs,
  ];

  await runScraperEngine(adapter, forwardedArgv);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Adapter engine scrape failed: ${message}`);
  process.exit(1);
});
