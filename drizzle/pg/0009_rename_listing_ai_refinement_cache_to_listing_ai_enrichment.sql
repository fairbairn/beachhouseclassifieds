ALTER TABLE "listing_ai_refinement_cache"
  RENAME TO "listing_ai_enrichment";

ALTER INDEX "listing_ai_refinement_cache_listing_id_idx"
  RENAME TO "listing_ai_enrichment_listing_id_idx";

ALTER INDEX "listing_ai_refinement_cache_status_idx"
  RENAME TO "listing_ai_enrichment_status_idx";

ALTER INDEX "listing_ai_refinement_cache_listing_hash_prompt_unique_idx"
  RENAME TO "listing_ai_enrichment_listing_hash_prompt_unique_idx";

ALTER TABLE "listing_ai_enrichment"
  ADD COLUMN IF NOT EXISTS "audit_model" text;

ALTER TABLE "listing_ai_enrichment"
  ADD COLUMN IF NOT EXISTS "source_snapshot_payload" jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE "listing_ai_enrichment"
  ADD COLUMN IF NOT EXISTS "audit_payload" jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE "listing_ai_enrichment"
  ALTER COLUMN "status" SET DEFAULT 'pending';

ALTER TABLE "listing_ai_enrichment"
  ALTER COLUMN "model" DROP NOT NULL;

ALTER TABLE "listing_ai_enrichment"
  ALTER COLUMN "output_hash" DROP NOT NULL;

CREATE INDEX IF NOT EXISTS "listing_ai_enrichment_generated_at_idx"
  ON "listing_ai_enrichment" ("generated_at");
