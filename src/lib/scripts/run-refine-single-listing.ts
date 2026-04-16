import "@/core/tooling/env/load-env-profile";

import { executeListingAiEnrichment } from "@/lib/listings/enrichment/listing-ai-enrichment-service";
import { loadListingRefinementSnapshot } from "@/lib/listings/refinement/listing-refinement-service";

type Options = {
  listingId: string | null;
  slug: string | null;
  model: string | null;
  rebuildHelpfulHints: boolean;
  dryRun: boolean;
};

type ModelPricing = {
  inputPer1M: number;
  outputPer1M: number;
};

const MODEL_PRICING_USD_PER_1M: Record<string, ModelPricing> = {
  "gpt-4.1-mini": { inputPer1M: 0.4, outputPer1M: 1.6 },
  "gpt-4.1": { inputPer1M: 2.0, outputPer1M: 8.0 },
};

function getPricingForModel(model: string): ModelPricing | null {
  const envInputRaw = process.env.OPENAI_PRICE_INPUT_PER_1M?.trim();
  const envOutputRaw = process.env.OPENAI_PRICE_OUTPUT_PER_1M?.trim();

  if (envInputRaw && envOutputRaw) {
    const inputPer1M = Number(envInputRaw);
    const outputPer1M = Number(envOutputRaw);
    if (
      Number.isFinite(inputPer1M) &&
      inputPer1M >= 0 &&
      Number.isFinite(outputPer1M) &&
      outputPer1M >= 0
    ) {
      return { inputPer1M, outputPer1M };
    }
  }

  return MODEL_PRICING_USD_PER_1M[model] ?? null;
}

function estimateCostUsd(input: {
  model: string;
  inputTokens: number;
  outputTokens: number;
}): number | null {
  const pricing = getPricingForModel(input.model);
  if (!pricing) {
    return null;
  }

  return (
    (input.inputTokens / 1_000_000) * pricing.inputPer1M +
    (input.outputTokens / 1_000_000) * pricing.outputPer1M
  );
}

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
  console.log("  --model <name>      OpenAI model (default gpt-5.4-nano)");
  console.log(
    "  --rebuild-helpful-hints  Rebuild helpful_hints with stricter sentence-quality rules",
  );
  console.log("  --dry-run           Generate output without persisting");
  console.log("  --help              Show help");
}

function parseArgs(argv: string[]): Options {
  let listingId: string | null = null;
  let slug: string | null = null;
  let model: string | null = null;
  let rebuildHelpfulHints = false;
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

    if (arg === "--rebuild-helpful-hints") {
      rebuildHelpfulHints = true;
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
    rebuildHelpfulHints,
    dryRun,
  };
}

async function run(): Promise<number> {
  const startedAt = Date.now();
  const options = parseArgs(process.argv.slice(2));

  const snapshot = await loadListingRefinementSnapshot({
    listingId: options.listingId ?? undefined,
    slug: options.slug ?? undefined,
  });

  if (!snapshot) {
    throw new Error("Listing not found.");
  }

  const result = await executeListingAiEnrichment({
    snapshot,
    model: options.model ?? undefined,
    rebuildHelpfulHints: options.rebuildHelpfulHints,
    persist: !options.dryRun,
  });

  const completedAt = Date.now();
  const elapsedMs = Math.max(0, completedAt - startedAt);
  const inputTokens = result.usage?.input_tokens ?? 0;
  const outputTokens = result.usage?.output_tokens ?? 0;
  const totalTokens = result.usage?.total_tokens ?? 0;
  const estimatedCostUsd = estimateCostUsd({
    model: result.model,
    inputTokens,
    outputTokens,
  });

  console.log(
    `listing_refinement_complete listing_id=${snapshot.listing_id} slug=${snapshot.slug} dry_run=${options.dryRun} rebuild_helpful_hints=${options.rebuildHelpfulHints} save_target=${options.dryRun ? "none" : "listing_ai_enrichment"} model=${result.model}`,
  );
  console.log(
    `listing_refinement_usage input_tokens=${inputTokens} output_tokens=${outputTokens} total_tokens=${totalTokens}`,
  );
  console.log(
    `listing_refinement_runtime duration_ms=${elapsedMs} estimated_cost_usd=${estimatedCostUsd === null ? "n/a" : estimatedCostUsd.toFixed(6)}`,
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
