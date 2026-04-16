ALTER TABLE "listing"
ADD COLUMN IF NOT EXISTS "sleeping_summary" jsonb NOT NULL DEFAULT '{}'::jsonb,
ADD COLUMN IF NOT EXISTS "sleeping_ux_summary" jsonb NOT NULL DEFAULT '{}'::jsonb;