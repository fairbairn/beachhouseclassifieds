import { runSharedListingPricingCacheCli } from "@/lib/pricing/cache/run-shared-listing-pricing-cache-cli";

function parseAdapterKey(argv: string[]): {
  adapterKey: string;
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
      "Missing --adapter-key. Usage: tsx src/lib/scripts/run-pricing-cache.ts --adapter-key <adapter> [--weeks N] [--from-date YYYY-MM-DD] [--max-listings N] [--listing-id ID] [--dry-run]",
    );
  }

  return { adapterKey, remainingArgs };
}

async function main(): Promise<void> {
  const parsed = parseAdapterKey(process.argv.slice(2));
  await runSharedListingPricingCacheCli(
    parsed.adapterKey,
    parsed.remainingArgs,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to build adapter listing pricing cache: ${message}`);
  process.exit(1);
});
