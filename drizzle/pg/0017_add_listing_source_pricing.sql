CREATE TABLE IF NOT EXISTS "listing_source_pricing" (
  "id" text PRIMARY KEY NOT NULL,
  "listing_id" text NOT NULL REFERENCES "listing"("id") ON DELETE CASCADE,
  "source_link_id" text NOT NULL REFERENCES "listing_source_link"("id") ON DELETE CASCADE,
  "stay_date" text NOT NULL,
  "is_available" boolean NOT NULL,
  "min_nights" integer,
  "base_nightly" numeric(12, 2),
  "estimated_fees_nightly" numeric(12, 2),
  "estimated_taxes_nightly" numeric(12, 2),
  "all_in_nightly" numeric(12, 2) NOT NULL,
  "currency" text NOT NULL DEFAULT 'USD',
  "price_source" text NOT NULL,
  "confidence" text,
  "scrape_observed_at" timestamp with time zone,
  "window_start_date" text,
  "window_end_date" text,
  "ingest_run_id" text,
  "is_current" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "listing_source_pricing_source_link_stay_date_unique_idx"
  ON "listing_source_pricing" ("source_link_id", "stay_date");

CREATE INDEX IF NOT EXISTS "listing_source_pricing_listing_id_stay_date_idx"
  ON "listing_source_pricing" ("listing_id", "stay_date");

CREATE INDEX IF NOT EXISTS "listing_source_pricing_stay_date_source_link_id_idx"
  ON "listing_source_pricing" ("stay_date", "source_link_id");
