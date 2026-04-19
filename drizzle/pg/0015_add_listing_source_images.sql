ALTER TABLE "listing_source_link"
ADD COLUMN IF NOT EXISTS "source_image_count_expected" integer,
ADD COLUMN IF NOT EXISTS "source_image_count_ingested" integer,
ADD COLUMN IF NOT EXISTS "source_image_count_verified_at" timestamp with time zone;

CREATE TABLE IF NOT EXISTS "listing_source_image" (
  "id" text PRIMARY KEY NOT NULL,
  "source_link_id" text NOT NULL REFERENCES "listing_source_link"("id") ON DELETE cascade,
  "source_image_url" text NOT NULL,
  "source_content_hash" text,
  "source_order" integer NOT NULL,
  "site_image" text,
  "status" text NOT NULL DEFAULT 'pending',
  "error_payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "listing_source_image_source_link_id_idx"
  ON "listing_source_image" ("source_link_id");

CREATE INDEX IF NOT EXISTS "listing_source_image_status_idx"
  ON "listing_source_image" ("status");

CREATE UNIQUE INDEX IF NOT EXISTS "listing_source_image_source_link_order_unique_idx"
  ON "listing_source_image" ("source_link_id", "source_order");

CREATE UNIQUE INDEX IF NOT EXISTS "listing_source_image_source_link_url_unique_idx"
  ON "listing_source_image" ("source_link_id", "source_image_url");

CREATE INDEX IF NOT EXISTS "listing_source_image_source_content_hash_idx"
  ON "listing_source_image" ("source_content_hash");
