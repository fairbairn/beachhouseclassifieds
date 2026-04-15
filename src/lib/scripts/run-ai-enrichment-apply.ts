import "@/core/tooling/env/load-env-profile";

import { createScrapeProgress } from "@/core/tooling/terminal/scrape-progress";
import { applyListingAiEnrichmentToListings } from "@/lib/listings/enrichment/listing-ai-enrichment-service";

type Options = {
  limit: number | null;
  adapterKey: string | null;
  listingId: string | null;
  dryRun: boolean;
};

function printUsage(): void {
  console.log("Apply AI Enrichment To Listing Fields");
  console.log("Usage:");
  console.log(
    "  tsx src/lib/scripts/run-ai-enrichment-apply.ts [--limit <n>] [--adapter-key <key>] [--listing-id <id>] [--dry-run]",
  );
  console.log("");
  console.log("Options:");
  console.log(
    "  --limit <n>          Max listings to compare/apply (default all)",
  );
  console.log("  --adapter-key <key>  Restrict to one adapter");
  console.log("  --listing-id <id>    Restrict to one listing id");
  console.log(
    "  --dry-run            Compute diffs only; do not update listing rows",
  );
  console.log("  --help               Show help");
}

function parseArgs(argv: string[]): Options {
  let limit: number | null = null;
  let adapterKey: string | null = null;
  let listingId: string | null = null;
  let dryRun = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (arg === "--limit" && next) {
      const parsed = Number(next);
      if (Number.isFinite(parsed) && parsed > 0) {
        limit = Math.floor(parsed);
      } else {
        throw new Error("--limit must be a positive integer");
      }
      i += 1;
      continue;
    }

    if (arg === "--adapter-key" && next) {
      adapterKey = next.trim().toLowerCase() || null;
      i += 1;
      continue;
    }

    if (arg === "--listing-id" && next) {
      listingId = next.trim() || null;
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { limit, adapterKey, listingId, dryRun };
}

async function run(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const progress = createScrapeProgress({ script: "ai-enrichment-apply" });

  progress.phase("starting enrichment apply");
  progress.info(
    `params limit=${options.limit ?? "all"} adapter_key=${options.adapterKey ?? "all"} listing_id=${options.listingId ?? "all"} dry_run=${options.dryRun}`,
  );

  const summary = await applyListingAiEnrichmentToListings({
    limit: options.limit ?? undefined,
    adapterKey: options.adapterKey ?? undefined,
    listingId: options.listingId ?? undefined,
    dryRun: options.dryRun,
  });

  progress.success(
    `apply complete selected=${summary.selected} compared=${summary.compared} updated=${summary.updated} unchanged=${summary.unchanged} dry_run=${summary.dry_run}`,
  );

  console.log("listing_ai_enrichment_apply_complete");
  console.log(`- selected: ${summary.selected}`);
  console.log(`- compared: ${summary.compared}`);
  console.log(`- updated: ${summary.updated}`);
  console.log(`- unchanged: ${summary.unchanged}`);
  console.log(`- dry_run: ${summary.dry_run}`);

  return 0;
}

run()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`run-ai-enrichment-apply failed: ${message}`);
    process.exit(1);
  });
