ALTER TABLE "listing_source_link" ADD COLUMN "details_url" text;--> statement-breakpoint
ALTER TABLE "listing_source_link" ADD COLUMN "quote_context" jsonb DEFAULT '{}'::jsonb NOT NULL;