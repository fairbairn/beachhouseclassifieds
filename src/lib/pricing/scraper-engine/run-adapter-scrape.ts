import { createAdapterByKey, getKnownAdapterKeys } from "./adapter-registry";
import { runScraperEngine } from "./runner";

type ParsedAdapterArgs = {
  adapterKey: string | null;
  passthroughArgs: string[];
  showHelp: boolean;
};

function buildUsageText(entryPath: string): string {
  const adapters = getKnownAdapterKeys().join(", ");
  return [
    "Usage:",
    `  tsx ${entryPath} --adapter-key <adapter> [engine-options]`,
    `  tsx ${entryPath} <adapter> [engine-options]`,
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

export async function runAdapterScrapeCli(
  argv: string[],
  processArgv: string[] = process.argv,
): Promise<void> {
  const parsed = parseAdapterArgs(argv);
  const entryPath = processArgv[1] ?? "src/lib/scripts/run-scrape-engine.ts";

  if (parsed.showHelp) {
    console.log(buildUsageText(entryPath));
    process.exit(0);
  }

  if (!parsed.adapterKey) {
    throw new Error(
      `Missing adapter key. Use --adapter-key <adapter>.\n\n${buildUsageText(entryPath)}`,
    );
  }

  const adapter = createAdapterByKey(parsed.adapterKey);
  if (!adapter) {
    throw new Error(
      `Unknown adapter key '${parsed.adapterKey}'.\n\n${buildUsageText(entryPath)}`,
    );
  }

  const forwardedArgv = [
    processArgv[0] ?? "node",
    processArgv[1] ?? "run-scrape-engine",
    ...parsed.passthroughArgs,
  ];

  await runScraperEngine(adapter, forwardedArgv);
}
