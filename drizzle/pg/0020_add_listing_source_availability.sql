CREATE TABLE IF NOT EXISTS "listing_source_availability" (
  "id" text PRIMARY KEY NOT NULL,
  "listing_id" text NOT NULL REFERENCES "listing"("id") ON DELETE CASCADE,
  "source_link_id" text NOT NULL REFERENCES "listing_source_link"("id") ON DELETE CASCADE,
  "window_start_date" text NOT NULL,
  "window_end_date" text NOT NULL,
  "status_code_string" text NOT NULL,
  "days_count" integer NOT NULL DEFAULT 0,
  "captured_at" timestamp with time zone,
  "ingest_run_id" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "listing_source_availability_source_link_unique_idx"
  ON "listing_source_availability" ("source_link_id");

CREATE INDEX IF NOT EXISTS "listing_source_availability_listing_window_idx"
  ON "listing_source_availability" ("listing_id", "window_start_date", "window_end_date");

CREATE INDEX IF NOT EXISTS "listing_source_availability_window_bounds_idx"
  ON "listing_source_availability" ("window_start_date", "window_end_date");
