import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

const QUOTE_SCOPED_ADAPTERS = new Set([
  "30abeach",
  "30aluxury",
  "royaldestinations",
  "benchmark30a",
  "dunevr30a",
  "realjoy30a",
]);

function hasFlag(args: string[], flagName: string): boolean {
  return args.some((arg) => arg === flagName || arg.startsWith(`${flagName}=`));
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

export async function normalizeAdapterQuoteScopeArgs(
  adapterKey: string,
  passthroughArgs: string[],
): Promise<string[]> {
  const normalizedAdapter = adapterKey.trim().toLowerCase();
  if (!QUOTE_SCOPED_ADAPTERS.has(normalizedAdapter)) {
    return passthroughArgs;
  }

  const hasScopedSelection =
    hasFlag(passthroughArgs, "--listing-id") ||
    hasFlag(passthroughArgs, "--max-listings");
  const hasAllListings = hasFlag(passthroughArgs, "--all-listings");
  if (!hasScopedSelection && !hasAllListings) {
    throw new Error(
      [
        `Missing selection scope for adapter '${normalizedAdapter}'.`,
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

  const totalListings = await countAdapterDetailJson(normalizedAdapter);
  if (totalListings <= 0) {
    throw new Error(
      `No detail json files found for adapter '${normalizedAdapter}', cannot expand --all-listings.`,
    );
  }

  return [...filteredArgs, "--max-listings", String(totalListings)];
}
