CREATE TABLE "listing_geocode_cache" (
	"id" text PRIMARY KEY NOT NULL,
	"listing_id" text NOT NULL,
	"provider" text DEFAULT 'google' NOT NULL,
	"source_fingerprint" text NOT NULL,
	"source_input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"geocode_mode" text DEFAULT 'reverse' NOT NULL,
	"query_text" text,
	"lat" double precision,
	"lng" double precision,
	"formatted_address" text,
	"street_address" text,
	"city" text,
	"state" text,
	"postal_code" text,
	"country_code" text,
	"place_id" text,
	"location_type" text,
	"confidence_score" numeric(5, 4),
	"geocode_status" text DEFAULT 'resolved' NOT NULL,
	"raw_response" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "listing_geocode_cache" ADD CONSTRAINT "listing_geocode_cache_listing_id_listing_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listing"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "listing_geocode_cache_listing_id_idx" ON "listing_geocode_cache" USING btree ("listing_id");
--> statement-breakpoint
CREATE INDEX "listing_geocode_cache_status_idx" ON "listing_geocode_cache" USING btree ("geocode_status");
--> statement-breakpoint
CREATE UNIQUE INDEX "listing_geocode_cache_listing_provider_fingerprint_unique_idx" ON "listing_geocode_cache" USING btree ("listing_id","provider","source_fingerprint");
