ALTER TABLE "listing"
ADD COLUMN IF NOT EXISTS "images" jsonb NOT NULL DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS "image_count" integer NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS "images_version" integer NOT NULL DEFAULT 1;
