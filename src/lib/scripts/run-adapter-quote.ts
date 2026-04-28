import "@/core/tooling/env/load-env-profile";

import { createScrapeProgress } from "@/core/tooling/terminal/scrape-progress";
import {
  createValidatedAdapterOperationProxyByKey,
  getKnownAdapterKeys,
} from "@/lib/pricing/scraper-engine/adapter-registry";

function buildUsageText(entryPath: string): string {
  return [
    "Usage:",
    `  tsx ${entryPath} --adapter-key <adapter> [quote-options]`,
    `  tsx ${entryPath} <adapter> [quote-options]`,
    "",
    `Known adapters: ${getKnownAdapterKeys().join(", ")}`,
  ].join("\n");
}

function parseArgs(argv: string[]): {
  adapterKey: string | null;
  passthroughArgs: string[];
  showHelp: boolean;
} {
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
      adapterKey = arg.trim().toLowerCase();
      continue;
    }

    passthroughArgs.push(arg);
  }

  return { adapterKey, passthroughArgs, showHelp };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const entryPath = process.argv[1] ?? "src/lib/scripts/run-adapter-quote.ts";
  if (parsed.showHelp) {
    console.log(buildUsageText(entryPath));
    return;
  }

  if (!parsed.adapterKey) {
    throw new Error(
      `Missing adapter key. Use --adapter-key <adapter>.\n\n${buildUsageText(entryPath)}`,
    );
  }

  const proxy = createValidatedAdapterOperationProxyByKey(parsed.adapterKey);
  if (!proxy) {
    throw new Error(
      `Unknown adapter key '${parsed.adapterKey}'.\n\n${buildUsageText(entryPath)}`,
    );
  }
  if (!proxy.capabilities.quoteCapture) {
    throw new Error(`Adapter '${parsed.adapterKey}' is not quote-capable.`);
  }

  const progress = createScrapeProgress({ script: parsed.adapterKey });
  await proxy.runQuoteCapture(parsed.passthroughArgs, progress);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Adapter quote runner failed: ${message}`);
  process.exit(1);
});
