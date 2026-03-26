ALTER TABLE "listing" ADD COLUMN "sourceStreetAddress" text;--> statement-breakpoint
ALTER TABLE "listing" ADD COLUMN "sourcePostalCode" text;--> statement-breakpoint
ALTER TABLE "listing" ADD COLUMN "sourceLat" double precision;--> statement-breakpoint
ALTER TABLE "listing" ADD COLUMN "sourceLng" double precision;--> statement-breakpoint
ALTER TABLE "listing" ADD COLUMN "locationLat" double precision;--> statement-breakpoint
ALTER TABLE "listing" ADD COLUMN "locationLng" double precision;--> statement-breakpoint
ALTER TABLE "listing" ADD COLUMN "geo" jsonb;--> statement-breakpoint
ALTER TABLE "listing" ADD COLUMN "images" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "listing" ADD COLUMN "primaryImageId" text;--> statement-breakpoint
CREATE INDEX "listing_location_lat_idx" ON "listing" USING btree ("locationLat");--> statement-breakpoint
CREATE INDEX "listing_location_lng_idx" ON "listing" USING btree ("locationLng");--> statement-breakpoint
CREATE INDEX "listing_primary_image_id_idx" ON "listing" USING btree ("primaryImageId");--> statement-breakpoint
ALTER TABLE "listing" DROP COLUMN "heroImageUrl";