import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const QUOTE_SCOPED_ADAPTERS = new Set([
  "30abeach",
  "30aescapes",
  "30aluxury",
  "360blue",
  "coastproperties30a",
  "exclusive30a",
  "royaldestinations",
  "benchmark30a",
  "dunevr30a",
  "fivestar30a",
  "keyco30a",
  "oceanreef30a",
  "oversee30a",
  "realjoy30a",
]);

function hasFlag(args: string[], flagName: string): boolean {
  return args.some((arg) => arg === flagName || arg.startsWith(`${flagName}=`));
}

async function countAdapterCanonicalListings(
  adapterKey: string,
): Promise<number> {
  const indexPath = resolve(
    process.cwd(),
    "src",
    "lib",
    "data",
    "external-sources",
    adapterKey,
    "details",
    "index.json",
  );
  const raw = await readFile(indexPath, "utf8");
  const parsed = JSON.parse(raw) as Array<{ detail_url?: unknown }>;
  if (!Array.isArray(parsed)) {
    throw new Error(
      `Canonical manifest is malformed for adapter '${adapterKey}' at ${indexPath}.`,
    );
  }

  return parsed.filter(
    (entry) => typeof entry?.detail_url === "string" && entry.detail_url.trim(),
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

  const totalListings = await countAdapterCanonicalListings(normalizedAdapter);
  if (totalListings <= 0) {
    throw new Error(
      `No entries found in canonical manifest for adapter '${normalizedAdapter}', cannot expand --all-listings. Run a full inventory scan first.`,
    );
  }

  return [...filteredArgs, "--max-listings", String(totalListings)];
}
