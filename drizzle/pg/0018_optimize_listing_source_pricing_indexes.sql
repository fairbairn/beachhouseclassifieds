DROP INDEX IF EXISTS "listing_source_pricing_source_link_id_stay_date_idx";
DROP INDEX IF EXISTS "listing_source_pricing_stay_date_idx";

CREATE INDEX IF NOT EXISTS "listing_source_pricing_stay_date_source_link_id_idx"
  ON "listing_source_pricing" ("stay_date", "source_link_id");
