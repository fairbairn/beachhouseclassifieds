type ParsedArgs = {
  adapterKey: string | null;
  passthroughArgs: string[];
  showHelp: boolean;
};

const ADAPTER_MODULE_BY_KEY: Record<string, string> = {
  royaldestinations: "@/lib/pricing/quotes/quote-royaldestinations",
  homeownerscollection30a: "@/lib/pricing/quotes/quote-homeownerscollection30a",
};

function getKnownAdapters(): string[] {
  return Object.keys(ADAPTER_MODULE_BY_KEY).sort();
}

function buildUsageText(entryPath: string): string {
  return [
    "Usage:",
    `  tsx ${entryPath} --adapter-key <adapter> [quote-options]`,
    `  tsx ${entryPath} <adapter> [quote-options]`,
    "",
    "Examples:",
    "  npm run pricing:quote:adapter -- --adapter-key royaldestinations --listing-id 12345",
    "  npm run pricing:quote:adapter -- homeownerscollection30a --detail-url <url> --check-in 2026-04-04",
    "",
    `Known adapters: ${getKnownAdapters().join(", ")}`,
  ].join("\n");
}

function parseArgs(argv: string[]): ParsedArgs {
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
      if (getKnownAdapters().includes(positional)) {
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
  const parsed = parseArgs(process.argv.slice(2));
  const entryPath = process.argv[1] ?? "src/lib/scripts/run-adapter-quote.ts";

  if (parsed.showHelp) {
    console.log(buildUsageText(entryPath));
    process.exit(0);
  }

  if (!parsed.adapterKey) {
    throw new Error(
      `Missing adapter key. Use --adapter-key <adapter>.\n\n${buildUsageText(entryPath)}`,
    );
  }

  const modulePath = ADAPTER_MODULE_BY_KEY[parsed.adapterKey];
  if (!modulePath) {
    throw new Error(
      `Unknown adapter key '${parsed.adapterKey}'.\n\n${buildUsageText(entryPath)}`,
    );
  }

  process.argv = [
    process.argv[0] ?? "node",
    entryPath,
    ...parsed.passthroughArgs,
  ];
  await import(modulePath);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Adapter quote runner failed: ${message}`);
  process.exit(1);
});
