CREATE TYPE "public"."listing_source_link_status" AS ENUM('active', 'inactive');--> statement-breakpoint
CREATE TYPE "public"."listing_status" AS ENUM('draft', 'active', 'inactive', 'archived');--> statement-breakpoint
CREATE TABLE "listing" (
	"id" text PRIMARY KEY NOT NULL,
	"listing_number" integer NOT NULL,
	"site_id" text,
	"status" "listing_status" DEFAULT 'active' NOT NULL,
	"slug" text NOT NULL,
	"slug_base" text NOT NULL,
	"slug_qualifier" text,
	"slug_hash8" text NOT NULL,
	"canonical_name" text NOT NULL,
	"property_type" text,
	"bedrooms" integer,
	"bathrooms" numeric(4, 1),
	"sleeps" integer,
	"description_markdown" text,
	"lat" double precision,
	"lng" double precision,
	"city" text,
	"state" text,
	"postal_code" text,
	"country_code" text DEFAULT 'US' NOT NULL,
	"area_name" text,
	"beach_area_name" text,
	"community_name" text,
	"is_gulf_front" boolean DEFAULT false NOT NULL,
	"traits" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"amenities_normalized" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "listing_source_link" (
	"id" text PRIMARY KEY NOT NULL,
	"listing_id" text NOT NULL,
	"adapter_key" text NOT NULL,
	"external_listing_id" text NOT NULL,
	"is_primary_source" boolean DEFAULT false NOT NULL,
	"source_status" "listing_source_link_status" DEFAULT 'active' NOT NULL,
	"confidence_score" numeric(5, 4),
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"active_from" timestamp with time zone DEFAULT now() NOT NULL,
	"active_to" timestamp with time zone,
	"match_method" text,
	"match_evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "listing" ADD CONSTRAINT "listing_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_source_link" ADD CONSTRAINT "listing_source_link_listing_id_listing_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listing"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "listing_listing_number_unique_idx" ON "listing" USING btree ("listing_number");--> statement-breakpoint
CREATE UNIQUE INDEX "listing_slug_unique_idx" ON "listing" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "listing_site_id_idx" ON "listing" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "listing_status_idx" ON "listing" USING btree ("status");--> statement-breakpoint
CREATE INDEX "listing_city_idx" ON "listing" USING btree ("city");--> statement-breakpoint
CREATE INDEX "listing_state_idx" ON "listing" USING btree ("state");--> statement-breakpoint
CREATE INDEX "listing_community_name_idx" ON "listing" USING btree ("community_name");--> statement-breakpoint
CREATE INDEX "listing_is_gulf_front_idx" ON "listing" USING btree ("is_gulf_front");--> statement-breakpoint
CREATE INDEX "listing_source_link_listing_id_idx" ON "listing_source_link" USING btree ("listing_id");--> statement-breakpoint
CREATE UNIQUE INDEX "listing_source_link_adapter_external_unique_idx" ON "listing_source_link" USING btree ("adapter_key","external_listing_id");--> statement-breakpoint
CREATE UNIQUE INDEX "listing_source_link_listing_primary_unique_idx" ON "listing_source_link" USING btree ("listing_id") WHERE "listing_source_link"."is_primary_source" = true and "listing_source_link"."source_status" = 'active' and "listing_source_link"."active_to" is null;--> statement-breakpoint
CREATE INDEX "listing_source_link_source_status_idx" ON "listing_source_link" USING btree ("source_status");--> statement-breakpoint
CREATE UNIQUE INDEX "site_slug_unique_idx" ON "site" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "site_status_idx" ON "site" USING btree ("status");