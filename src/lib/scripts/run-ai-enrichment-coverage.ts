import "@/core/tooling/env/load-env-profile";

import { and, eq, sql } from "drizzle-orm";

import { pgDb } from "@/core/server/db";
import { listing_ai_enrichment } from "@/lib/db/schema-postgres";
import { LISTING_REFINEMENT_PROMPT_VERSION } from "@/lib/listings/refinement/listing-refinement-service";

type Options = {
  adapterKey: string | null;
};

function printUsage(): void {
  console.log("AI Enrichment Source Coverage Report");
  console.log("Usage:");
  console.log(
    "  tsx src/lib/scripts/run-ai-enrichment-coverage.ts [--adapter-key <key>]",
  );
}

function parseArgs(argv: string[]): Options {
  let adapterKey: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }

    if (arg === "--adapter-key" && next) {
      adapterKey = next.trim().toLowerCase() || null;
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { adapterKey };
}

async function run(): Promise<number> {
  if (!pgDb) {
    throw new Error("Postgres database is not configured.");
  }

  const options = parseArgs(process.argv.slice(2));

  const baseWhere = [
    eq(listing_ai_enrichment.prompt_version, LISTING_REFINEMENT_PROMPT_VERSION),
  ];
  if (options.adapterKey) {
    baseWhere.push(eq(listing_ai_enrichment.adapter_key, options.adapterKey));
  }

  const rows = await pgDb
    .select({
      total: sql<number>`count(*)::int`,
      with_description: sql<number>`sum(case when coalesce(${listing_ai_enrichment.source_snapshot_payload}->>'description_expanded', '') <> '' then 1 else 0 end)::int`,
      with_meta: sql<number>`sum(case when coalesce(${listing_ai_enrichment.source_snapshot_payload}->>'meta_description', '') <> '' then 1 else 0 end)::int`,
      with_bedrooms: sql<number>`sum(case when (${listing_ai_enrichment.source_snapshot_payload}->>'bedrooms') is not null then 1 else 0 end)::int`,
      with_bathrooms: sql<number>`sum(case when (${listing_ai_enrichment.source_snapshot_payload}->>'bathrooms') is not null then 1 else 0 end)::int`,
      with_sleeps: sql<number>`sum(case when (${listing_ai_enrichment.source_snapshot_payload}->>'sleeps') is not null then 1 else 0 end)::int`,
    })
    .from(listing_ai_enrichment)
    .where(and(...baseWhere));

  const row = rows[0] ?? {
    total: 0,
    with_description: 0,
    with_meta: 0,
    with_bedrooms: 0,
    with_bathrooms: 0,
    with_sleeps: 0,
  };

  console.log("listing_ai_enrichment_source_coverage");
  console.log(`- prompt_version: ${LISTING_REFINEMENT_PROMPT_VERSION}`);
  console.log(`- adapter_key: ${options.adapterKey ?? "all"}`);
  console.log(`- total_rows: ${row.total}`);
  console.log(`- with_description_expanded: ${row.with_description}`);
  console.log(`- with_meta_description: ${row.with_meta}`);
  console.log(`- with_bedrooms: ${row.with_bedrooms}`);
  console.log(`- with_bathrooms: ${row.with_bathrooms}`);
  console.log(`- with_sleeps: ${row.with_sleeps}`);

  return 0;
}

run()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`run-ai-enrichment-coverage failed: ${message}`);
    process.exit(1);
  });
