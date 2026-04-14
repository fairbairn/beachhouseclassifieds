ALTER TABLE "listing_ai_enrichment"
  ADD COLUMN IF NOT EXISTS "cost_usd" numeric(12, 6);