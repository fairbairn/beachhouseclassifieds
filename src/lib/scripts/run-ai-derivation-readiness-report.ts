import "@/core/tooling/env/load-env-profile";

import { sql } from "drizzle-orm";

import { pgDb } from "@/core/server/db";

type ReadinessRow = {
  total_active: number;
  has_source_hash: number;
  missing_source_hash: number;
  description_pending: number;
  sleeping_pending: number;
  ready_for_ai_derivation: number;
};

async function run(): Promise<number> {
  if (!pgDb) {
    throw new Error("Postgres database is not configured.");
  }

  const result = await pgDb.execute<ReadinessRow>(sql`
    with primary_source as (
      select
        lsl.listing_id,
        lsl.match_evidence
      from listing_source_link lsl
      where lsl.is_primary_source = true
        and lsl.source_status = 'active'
        and lsl.active_to is null
    )
    select
      count(*)::int as total_active,
      sum((ps.match_evidence ? 'source_content_hash')::int)::int as has_source_hash,
      sum((not (ps.match_evidence ? 'source_content_hash'))::int)::int as missing_source_hash,
      sum((l.description_markdown is null or btrim(l.description_markdown) = '')::int)::int as description_pending,
      sum((jsonb_typeof(l.sleeping_arrangements) <> 'array' or jsonb_array_length(l.sleeping_arrangements) = 0)::int)::int as sleeping_pending,
      sum((
        (ps.match_evidence ? 'source_content_hash')
        and (l.description_markdown is null or btrim(l.description_markdown) = '')
      )::int)::int as ready_for_ai_derivation
    from listing l
    left join primary_source ps on ps.listing_id = l.id
    where l.status = 'active'
  `);

  const row = result.rows[0];
  if (!row) {
    console.log("ai_derivation_readiness no_active_listings");
    return 0;
  }

  console.log("ai_derivation_readiness");
  console.log(`  total_active=${row.total_active}`);
  console.log(`  has_source_hash=${row.has_source_hash}`);
  console.log(`  missing_source_hash=${row.missing_source_hash}`);
  console.log(`  description_pending=${row.description_pending}`);
  console.log(`  sleeping_pending=${row.sleeping_pending}`);
  console.log(`  ready_for_ai_derivation=${row.ready_for_ai_derivation}`);

  return 0;
}

run()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`ai derivation readiness report failed: ${message}`);
    process.exit(1);
  });
