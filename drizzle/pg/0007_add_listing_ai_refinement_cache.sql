CREATE TABLE "listing_ai_refinement_cache" (
  "id" text PRIMARY KEY NOT NULL,
  "listing_id" text NOT NULL,
  "source_link_id" text,
  "adapter_key" text,
  "source_content_hash" text NOT NULL,
  "status" text NOT NULL DEFAULT 'staged',
  "model" text NOT NULL,
  "prompt_version" text NOT NULL,
  "output_hash" text NOT NULL,
  "output_payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "usage_payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "generated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "applied_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "listing_ai_refinement_cache_listing_id_fk"
    FOREIGN KEY ("listing_id") REFERENCES "listing"("id") ON DELETE CASCADE,
  CONSTRAINT "listing_ai_refinement_cache_source_link_id_fk"
    FOREIGN KEY ("source_link_id") REFERENCES "listing_source_link"("id") ON DELETE SET NULL
);

CREATE INDEX "listing_ai_refinement_cache_listing_id_idx"
  ON "listing_ai_refinement_cache" ("listing_id");

CREATE INDEX "listing_ai_refinement_cache_status_idx"
  ON "listing_ai_refinement_cache" ("status");

CREATE UNIQUE INDEX "listing_ai_refinement_cache_listing_hash_prompt_unique_idx"
  ON "listing_ai_refinement_cache" ("listing_id", "source_content_hash", "prompt_version");
