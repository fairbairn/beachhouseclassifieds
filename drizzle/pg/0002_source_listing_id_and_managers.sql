ALTER TABLE "sources" ADD COLUMN "source_listing_id" text;--> statement-breakpoint
CREATE INDEX "sources_source_listing_lookup_idx" ON "sources" USING btree ("source_type","source_listing_id");--> statement-breakpoint

DO $$
BEGIN
  CREATE TYPE "listing_manager_relationship_type" AS ENUM('manager', 'owner', 'co_manager');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;--> statement-breakpoint

CREATE TABLE "managers" (
  "id" text PRIMARY KEY NOT NULL,
  "company_name" text NOT NULL,
  "contact_first_name" text,
  "contact_last_name" text,
  "contact_email" text,
  "contact_phone" text,
  "website_url" text,
  "street_address" text,
  "street_address_line2" text,
  "city" text,
  "state" text,
  "postal_code" text,
  "country_code" text,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE INDEX "managers_company_name_idx" ON "managers" USING btree ("company_name");--> statement-breakpoint
CREATE INDEX "managers_contact_email_idx" ON "managers" USING btree ("contact_email");--> statement-breakpoint
CREATE INDEX "managers_contact_phone_idx" ON "managers" USING btree ("contact_phone");--> statement-breakpoint

CREATE TABLE "listing_manager_relationships" (
  "id" text PRIMARY KEY NOT NULL,
  "listing_id" text NOT NULL,
  "manager_id" text NOT NULL,
  "relationship_type" "listing_manager_relationship_type" DEFAULT 'manager' NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "start_date" timestamp with time zone DEFAULT now() NOT NULL,
  "end_date" timestamp with time zone,
  "confidence_score" numeric(5, 4),
  "evidence_source_id" text,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "listing_manager_relationships_listing_id_listing_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listing"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "listing_manager_relationships_manager_id_managers_fk" FOREIGN KEY ("manager_id") REFERENCES "public"."managers"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "listing_manager_relationships_evidence_source_id_sources_fk" FOREIGN KEY ("evidence_source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action
);--> statement-breakpoint

CREATE INDEX "listing_manager_relationships_listing_id_idx" ON "listing_manager_relationships" USING btree ("listing_id");--> statement-breakpoint
CREATE INDEX "listing_manager_relationships_manager_id_idx" ON "listing_manager_relationships" USING btree ("manager_id");--> statement-breakpoint
CREATE INDEX "listing_manager_relationships_relationship_type_idx" ON "listing_manager_relationships" USING btree ("relationship_type");--> statement-breakpoint
CREATE INDEX "listing_manager_relationships_evidence_source_id_idx" ON "listing_manager_relationships" USING btree ("evidence_source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "listing_manager_relationships_single_active_idx" ON "listing_manager_relationships" USING btree ("listing_id") WHERE "listing_manager_relationships"."is_active" = true and "listing_manager_relationships"."end_date" is null;--> statement-breakpoint

UPDATE "sources"
SET "source_listing_id" = substring(("payload"->>'url') from 'vrbo\\.com/([0-9]+)')
WHERE "source_listing_id" IS NULL
  AND "payload" ? 'url'
  AND ("payload"->>'url') IS NOT NULL;