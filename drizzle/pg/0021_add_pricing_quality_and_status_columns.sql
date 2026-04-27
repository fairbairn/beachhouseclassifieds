ALTER TABLE "listing_source_pricing"
  ADD COLUMN IF NOT EXISTS "value_origin" text,
  ADD COLUMN IF NOT EXISTS "quote_anchor_scope" text,
  ADD COLUMN IF NOT EXISTS "has_any_quote_observations" boolean,
  ADD COLUMN IF NOT EXISTS "nearest_quote_observation_distance_days" integer;

ALTER TABLE "listing_pricing_summary"
  ADD COLUMN IF NOT EXISTS "pricing_status" text NOT NULL DEFAULT 'no_truth',
  ADD COLUMN IF NOT EXISTS "recommended_usable_for_ux" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "has_any_availability" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "has_any_quote_foundation" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "has_quote_same_month_foundation" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "has_quote_surrounding_month_foundation" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "contrived_day_ratio" numeric(5, 4),
  ADD COLUMN IF NOT EXISTS "quality_band" text;

CREATE INDEX IF NOT EXISTS "listing_pricing_summary_pricing_status_idx"
  ON "listing_pricing_summary" ("pricing_status");

CREATE INDEX IF NOT EXISTS "listing_pricing_summary_recommended_usable_idx"
  ON "listing_pricing_summary" ("recommended_usable_for_ux");
