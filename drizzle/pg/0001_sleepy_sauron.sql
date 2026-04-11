ALTER TABLE "listing" ADD COLUMN "description_short_plain" text;--> statement-breakpoint
ALTER TABLE "listing" ADD COLUMN "seo_meta_description" text;--> statement-breakpoint
ALTER TABLE "listing" ADD COLUMN "seo_meta_title" text;--> statement-breakpoint
ALTER TABLE "listing" ADD COLUMN "seo_hidden_summary_plain" text;--> statement-breakpoint
ALTER TABLE "listing" ADD COLUMN "content_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "listing" ADD COLUMN "content_generated_at" timestamp with time zone;