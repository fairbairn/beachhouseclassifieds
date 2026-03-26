CREATE TYPE "public"."listing_source_type" AS ENUM('vrbo');--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"accountId" text NOT NULL,
	"providerId" text NOT NULL,
	"userId" text NOT NULL,
	"accessToken" text,
	"refreshToken" text,
	"idToken" text,
	"accessTokenExpiresAt" timestamp with time zone,
	"refreshTokenExpiresAt" timestamp with time zone,
	"scope" text,
	"password" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"ipAddress" text,
	"userAgent" text,
	"userId" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "listing_source_record" (
	"id" text PRIMARY KEY NOT NULL,
	"sourceType" "listing_source_type" NOT NULL,
	"sourceId" text NOT NULL,
	"sourceUrl" text,
	"payload" jsonb NOT NULL,
	"fetchedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "listing" (
	"id" text PRIMARY KEY NOT NULL,
	"listingId" text NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"city" text,
	"region" text,
	"countryCode" text,
	"propertyType" text,
	"bedrooms" integer,
	"bathrooms" numeric(4, 1),
	"maxGuests" integer,
	"currencyCode" text,
	"nightlyRate" numeric(12, 2),
	"heroImageUrl" text,
	"sourceType" "listing_source_type" NOT NULL,
	"sourceId" text NOT NULL,
	"referenceId" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"timeZone" text,
	"emailVerified" boolean NOT NULL,
	"image" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing" ADD CONSTRAINT "listing_referenceId_listing_source_record_id_fk" FOREIGN KEY ("referenceId") REFERENCES "public"."listing_source_record"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_id_idx" ON "account" USING btree ("userId");--> statement-breakpoint
CREATE UNIQUE INDEX "account_provider_unique_idx" ON "account" USING btree ("providerId","accountId");--> statement-breakpoint
CREATE UNIQUE INDEX "session_token_unique_idx" ON "session" USING btree ("token");--> statement-breakpoint
CREATE INDEX "session_user_id_idx" ON "session" USING btree ("userId");--> statement-breakpoint
CREATE UNIQUE INDEX "verification_identifier_value_unique_idx" ON "verification" USING btree ("identifier","value");--> statement-breakpoint
CREATE UNIQUE INDEX "listing_source_record_source_unique_idx" ON "listing_source_record" USING btree ("sourceType","sourceId");--> statement-breakpoint
CREATE INDEX "listing_source_record_fetched_at_idx" ON "listing_source_record" USING btree ("fetchedAt");--> statement-breakpoint
CREATE UNIQUE INDEX "listing_listing_id_unique_idx" ON "listing" USING btree ("listingId");--> statement-breakpoint
CREATE UNIQUE INDEX "listing_slug_unique_idx" ON "listing" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "listing_source_unique_idx" ON "listing" USING btree ("sourceType","sourceId");--> statement-breakpoint
CREATE INDEX "listing_city_idx" ON "listing" USING btree ("city");--> statement-breakpoint
CREATE INDEX "listing_region_idx" ON "listing" USING btree ("region");--> statement-breakpoint
CREATE INDEX "listing_property_type_idx" ON "listing" USING btree ("propertyType");--> statement-breakpoint
CREATE INDEX "listing_bedrooms_idx" ON "listing" USING btree ("bedrooms");--> statement-breakpoint
CREATE INDEX "listing_nightly_rate_idx" ON "listing" USING btree ("nightlyRate");--> statement-breakpoint
CREATE INDEX "listing_reference_id_idx" ON "listing" USING btree ("referenceId");--> statement-breakpoint
CREATE UNIQUE INDEX "user_email_unique_idx" ON "user" USING btree ("email");