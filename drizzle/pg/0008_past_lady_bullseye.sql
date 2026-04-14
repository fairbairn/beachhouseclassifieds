ALTER TABLE "listing" ADD COLUMN "highlights" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "listing" ADD COLUMN "helpful_hints" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "listing" ADD COLUMN "sleeping_rollups" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint