import "@/core/tooling/env/load-env-profile";

import {
  generateListingRefinement,
  loadListingRefinementSnapshot,
  persistListingRefinement,
} from "@/lib/listings/refinement/listing-refinement-service";

type Options = {
  listingId: string | null;
  slug: string | null;
  model: string | null;
  dryRun: boolean;
};

function printUsage(): void {
  console.log("Refine Single Listing Content");
  console.log("Usage:");
  console.log(
    "  tsx src/lib/scripts/run-refine-single-listing.ts --listing-id <id> [--dry-run]",
  );
  console.log(
    "  tsx src/lib/scripts/run-refine-single-listing.ts --slug <slug> [--dry-run]",
  );
  console.log("");
  console.log("Options:");
  console.log("  --listing-id <id>   Canonical listing id");
  console.log("  --slug <slug>       Canonical listing slug");
  console.log("  --model <name>      OpenAI model (default gpt-4.1-mini)");
  console.log("  --dry-run           Generate output without persisting");
  console.log("  --help              Show help");
}

function parseArgs(argv: string[]): Options {
  let listingId: string | null = null;
  let slug: string | null = null;
  let model: string | null = null;
  let dryRun = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }

    if (arg === "--listing-id") {
      if (!next) {
        throw new Error("Missing value for --listing-id");
      }
      listingId = next.trim() || null;
      i += 1;
      continue;
    }

    if (arg === "--slug") {
      if (!next) {
        throw new Error("Missing value for --slug");
      }
      slug = next.trim() || null;
      i += 1;
      continue;
    }

    if (arg === "--model") {
      if (!next) {
        throw new Error("Missing value for --model");
      }
      model = next.trim() || null;
      i += 1;
      continue;
    }

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!listingId && !slug) {
    throw new Error("Provide --listing-id or --slug.");
  }

  return {
    listingId,
    slug,
    model,
    dryRun,
  };
}

async function run(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));

  const snapshot = await loadListingRefinementSnapshot({
    listingId: options.listingId ?? undefined,
    slug: options.slug ?? undefined,
  });

  if (!snapshot) {
    throw new Error("Listing not found.");
  }

  const result = await generateListingRefinement({
    snapshot,
    model: options.model ?? undefined,
  });

  if (!options.dryRun) {
    await persistListingRefinement({ snapshot, result });
  }

  console.log(
    `listing_refinement_complete listing_id=${snapshot.listing_id} slug=${snapshot.slug} dry_run=${options.dryRun} save_target=${options.dryRun ? "none" : "listing_ai_refinement_cache"} model=${result.model}`,
  );
  console.log(
    `listing_refinement_usage input_tokens=${result.usage?.input_tokens ?? 0} output_tokens=${result.usage?.output_tokens ?? 0} total_tokens=${result.usage?.total_tokens ?? 0}`,
  );

  return 0;
}

run()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`single listing refinement failed: ${message}`);
    process.exit(1);
  });
