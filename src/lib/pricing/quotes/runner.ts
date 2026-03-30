import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { createScrapeProgress } from "@/core/tooling/terminal/scrape-progress";
import {
  createQuoteAdapterByKey,
  getKnownQuoteAdapterKeys,
} from "@/lib/pricing/quotes/adapter-registry";

type ParsedQuoteArgs = {
  adapterKey: string | null;
  passthroughArgs: string[];
  showHelp: boolean;
};

function buildUsageText(entryPath: string): string {
  const adapters = getKnownQuoteAdapterKeys().join(", ");
  return [
    "Usage:",
    `  tsx ${entryPath} --adapter-key <adapter> [quote-options]`,
    `  tsx ${entryPath} <adapter> [quote-options]`,
    "",
    "Examples:",
    "  npm run pricing:quote:adapter -- --adapter-key royaldestinations --max-listings 2 --weeks 24",
    "  npm run pricing:quote:adapter -- --adapter-key royaldestinations --all-listings --weeks 24",
    "  npm run pricing:quote:adapter -- homeownerscollection30a --detail-url <url> --check-in 2026-04-04",
    "",
    `Known adapters: ${adapters}`,
  ].join("\n");
}

function hasFlag(args: string[], flagName: string): boolean {
  return args.some((arg) => arg === flagName || arg.startsWith(`${flagName}=`));
}

function readFlagValue(args: string[], flagName: string): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === flagName) {
      const value = args[index + 1];
      return value && !value.startsWith("--") ? value : null;
    }
    if (arg.startsWith(`${flagName}=`)) {
      const value = arg.slice(`${flagName}=`.length).trim();
      return value.length > 0 ? value : null;
    }
  }

  return null;
}

async function countAdapterDetailJson(adapterKey: string): Promise<number> {
  const detailsDir = resolve(
    process.cwd(),
    "src",
    "lib",
    "data",
    "external-sources",
    adapterKey,
    "details",
    "json",
  );

  const entries = await readdir(detailsDir, { withFileTypes: true });
  return entries.filter(
    (entry) => entry.isFile() && entry.name.endsWith(".json"),
  ).length;
}

async function normalizeScope(
  adapterKey: string,
  passthroughArgs: string[],
): Promise<string[]> {
  const requiresScopedSelection = new Set([
    "royaldestinations",
    "benchmark30a",
    "dunevr30a",
  ]);
  if (!requiresScopedSelection.has(adapterKey)) {
    return passthroughArgs;
  }

  const hasScopedSelection =
    hasFlag(passthroughArgs, "--listing-id") ||
    hasFlag(passthroughArgs, "--max-listings");
  const hasAllListings = hasFlag(passthroughArgs, "--all-listings");
  if (!hasScopedSelection && !hasAllListings) {
    throw new Error(
      [
        `Missing selection scope for adapter '${adapterKey}'.`,
        "Use one of:",
        "- --listing-id <id>",
        "- --max-listings <n>",
        "- --all-listings",
      ].join("\n"),
    );
  }

  if (!hasAllListings) {
    return passthroughArgs;
  }

  const filteredArgs = passthroughArgs.filter(
    (arg) => arg !== "--all-listings" && !arg.startsWith("--all-listings="),
  );
  if (hasFlag(filteredArgs, "--max-listings")) {
    return filteredArgs;
  }

  const totalListings = await countAdapterDetailJson(adapterKey);
  if (totalListings <= 0) {
    throw new Error(
      `No detail json files found for adapter '${adapterKey}', cannot expand --all-listings.`,
    );
  }

  return [...filteredArgs, "--max-listings", String(totalListings)];
}

function parseAdapterArgs(argv: string[]): ParsedQuoteArgs {
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
      if (getKnownQuoteAdapterKeys().includes(positional)) {
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

export async function runQuoteRunnerCli(
  argv: string[],
  processArgv: string[] = process.argv,
): Promise<void> {
  const parsed = parseAdapterArgs(argv);
  const entryPath = processArgv[1] ?? "src/lib/scripts/run-adapter-quote.ts";

  if (parsed.showHelp) {
    console.log(buildUsageText(entryPath));
    process.exit(0);
  }

  if (!parsed.adapterKey) {
    throw new Error(
      `Missing adapter key. Use --adapter-key <adapter>.\n\n${buildUsageText(entryPath)}`,
    );
  }

  const adapter = createQuoteAdapterByKey(parsed.adapterKey);
  if (!adapter) {
    throw new Error(
      `Unknown adapter key '${parsed.adapterKey}'.\n\n${buildUsageText(entryPath)}`,
    );
  }

  const progress = createScrapeProgress({ script: "quote-runner" });
  progress.phase("starting quote runner");
  progress.info(`adapter=${parsed.adapterKey}`);

  const normalizedArgs = await normalizeScope(
    parsed.adapterKey,
    parsed.passthroughArgs,
  );
  progress.info(
    `selection_scope listing_id=${readFlagValue(normalizedArgs, "--listing-id") ?? "n/a"} max_listings=${readFlagValue(normalizedArgs, "--max-listings") ?? "n/a"} weeks=${readFlagValue(normalizedArgs, "--weeks") ?? "n/a"}`,
  );

  progress.phase("dispatching adapter quote engine");
  await adapter.run(normalizedArgs, progress);
}
