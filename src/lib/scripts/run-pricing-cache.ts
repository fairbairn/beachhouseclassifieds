import { SHARED_LISTING_CACHE_ADAPTER_DEFINITIONS } from "@/lib/pricing/cache/listing-pricing-cache-adapter-definitions";
import { runSharedListingPricingCacheCli } from "@/lib/pricing/cache/run-shared-listing-pricing-cache-cli";

function parseAdapterKey(argv: string[]): {
  adapterKeys: string[];
  remainingArgs: string[];
} {
  let adapterKey: string | null = null;
  const remainingArgs: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    if (arg === "--adapter-key" && value) {
      adapterKey = value.trim().toLowerCase();
      index += 1;
      continue;
    }

    if (arg.startsWith("--adapter-key=")) {
      adapterKey = arg.slice("--adapter-key=".length).trim().toLowerCase();
      continue;
    }

    remainingArgs.push(arg);
  }

  if (!adapterKey) {
    throw new Error(
      "Missing --adapter-key. Usage: tsx src/lib/scripts/run-pricing-cache.ts --adapter-key <adapter|:all> [--weeks N] [--from-date YYYY-MM-DD] [--max-listings N] [--listing-id ID] [--dry-run]",
    );
  }

  const allAdapters = Object.keys(
    SHARED_LISTING_CACHE_ADAPTER_DEFINITIONS,
  ).sort();
  const normalized = adapterKey.trim().toLowerCase();
  const adapterKeys =
    normalized === ":all" || normalized === "all" ? allAdapters : [normalized];

  return { adapterKeys, remainingArgs };
}

async function main(): Promise<void> {
  const parsed = parseAdapterKey(process.argv.slice(2));
  const failedAdapters: string[] = [];

  for (const adapterKey of parsed.adapterKeys) {
    try {
      await runSharedListingPricingCacheCli(adapterKey, parsed.remainingArgs);
    } catch (error: unknown) {
      failedAdapters.push(adapterKey);
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[pricing-cache] adapter=${adapterKey} failed: ${message}`);
    }
  }

  if (failedAdapters.length > 0) {
    throw new Error(
      `Pricing cache build failed for ${failedAdapters.length} adapter(s): ${failedAdapters.join(", ")}`,
    );
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to build adapter listing pricing cache: ${message}`);
  process.exit(1);
});
