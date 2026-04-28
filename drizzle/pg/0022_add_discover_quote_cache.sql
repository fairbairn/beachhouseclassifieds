CREATE TABLE IF NOT EXISTS "discover_quote_cache" (
  "id" text PRIMARY KEY NOT NULL,
  "cache_key" text NOT NULL,
  "slug" text NOT NULL,
  "adapter_key" text NOT NULL,
  "external_listing_id" text NOT NULL,
  "check_in_date" text NOT NULL,
  "check_out_date" text NOT NULL,
  "adults" integer NOT NULL,
  "kids" integer NOT NULL,
  "response_payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "discover_quote_cache_cache_key_unique_idx"
  ON "discover_quote_cache" ("cache_key");

CREATE INDEX IF NOT EXISTS "discover_quote_cache_expires_at_idx"
  ON "discover_quote_cache" ("expires_at");

CREATE INDEX IF NOT EXISTS "discover_quote_cache_lookup_idx"
  ON "discover_quote_cache" (
    "slug",
    "check_in_date",
    "check_out_date",
    "adults",
    "kids",
    "expires_at"
  );
