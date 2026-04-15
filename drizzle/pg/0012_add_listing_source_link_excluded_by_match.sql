ALTER TABLE "listing_source_link"
ADD COLUMN "excluded_by_match" boolean DEFAULT false NOT NULL;
