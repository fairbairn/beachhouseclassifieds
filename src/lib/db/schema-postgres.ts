import { sql } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const listingSourceTypeEnum = pgEnum("listing_source_type", ["vrbo"]);
export const listingPriceChannelEnum = pgEnum("listing_price_channel", [
  "vrbo",
  "airbnb",
  "pm_direct",
]);
export const listingManagerRelationshipTypeEnum = pgEnum(
  "listing_manager_relationship_type",
  ["manager", "owner", "co_manager"],
);

export const sources = pgTable(
  "sources",
  {
    id: text("id").primaryKey(),
    listingId: text("listing_id")
      .notNull()
      .references(() => listings.id, { onDelete: "cascade" }),
    sourceType: listingSourceTypeEnum("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    source_listing_id: text("source_listing_id"),
    sourceUrl: text("source_url"),
    payloadHash: text("payload_hash").notNull(),
    payload: jsonb("payload").notNull(),
    capturedAt: timestamp("captured_at", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    listingIdIdx: index("sources_listing_id_idx").on(table.listingId),
    sourceLookupIdx: index("sources_source_lookup_idx").on(
      table.sourceType,
      table.sourceId,
    ),
    sourceListingLookupIdx: index("sources_source_listing_lookup_idx").on(
      table.sourceType,
      table.source_listing_id,
    ),
    payloadHashIdx: index("sources_payload_hash_idx").on(table.payloadHash),
    capturedAtIdx: index("sources_captured_at_idx").on(table.capturedAt),
    listingPayloadUniqueIdx: uniqueIndex(
      "sources_listing_payload_unique_idx",
    ).on(table.listingId, table.payloadHash),
  }),
);

export const managers = pgTable(
  "managers",
  {
    id: text("id").primaryKey(),
    company_name: text("company_name").notNull(),
    contact_first_name: text("contact_first_name"),
    contact_last_name: text("contact_last_name"),
    contact_email: text("contact_email"),
    contact_phone: text("contact_phone"),
    website_url: text("website_url"),
    street_address: text("street_address"),
    street_address_line2: text("street_address_line2"),
    city: text("city"),
    state: text("state"),
    postal_code: text("postal_code"),
    country_code: text("country_code"),
    notes: text("notes"),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    companyNameIdx: index("managers_company_name_idx").on(table.company_name),
    contactEmailIdx: index("managers_contact_email_idx").on(
      table.contact_email,
    ),
    contactPhoneIdx: index("managers_contact_phone_idx").on(
      table.contact_phone,
    ),
  }),
);

export const listing_manager_relationships = pgTable(
  "listing_manager_relationships",
  {
    id: text("id").primaryKey(),
    listing_id: text("listing_id")
      .notNull()
      .references(() => listings.id, { onDelete: "cascade" }),
    manager_id: text("manager_id")
      .notNull()
      .references(() => managers.id, { onDelete: "cascade" }),
    relationship_type: listingManagerRelationshipTypeEnum("relationship_type")
      .notNull()
      .default("manager"),
    is_active: boolean("is_active").notNull().default(true),
    start_date: timestamp("start_date", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
    end_date: timestamp("end_date", { mode: "string", withTimezone: true }),
    confidence_score: numeric("confidence_score", { precision: 5, scale: 4 }),
    evidence_source_id: text("evidence_source_id").references(
      () => sources.id,
      {
        onDelete: "set null",
      },
    ),
    notes: text("notes"),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    listingIdIdx: index("listing_manager_relationships_listing_id_idx").on(
      table.listing_id,
    ),
    managerIdIdx: index("listing_manager_relationships_manager_id_idx").on(
      table.manager_id,
    ),
    relationshipTypeIdx: index(
      "listing_manager_relationships_relationship_type_idx",
    ).on(table.relationship_type),
    evidenceSourceIdIdx: index(
      "listing_manager_relationships_evidence_source_id_idx",
    ).on(table.evidence_source_id),
    singleActiveListingRelationshipIdx: uniqueIndex(
      "listing_manager_relationships_single_active_idx",
    )
      .on(table.listing_id)
      .where(sql`${table.is_active} = true and ${table.end_date} is null`),
  }),
);

export const listings = pgTable(
  "listing",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    city: text("city"),
    state: text("state"),
    countryCode: text("country_code"),
    propertyType: text("property_type"),
    description: text("description"),
    descriptionSummary: text("description_summary"),
    descriptionMarketingMd: text("description_marketing_md"),
    traits: jsonb("traits")
      .notNull()
      .default(sql`'[]'::jsonb`),
    amenitiesSection: jsonb("amenities_section")
      .notNull()
      .default(sql`'{}'::jsonb`),
    spacesSection: jsonb("spaces_section")
      .notNull()
      .default(sql`'{}'::jsonb`),
    policiesSection: jsonb("policies_section")
      .notNull()
      .default(sql`'{}'::jsonb`),
    faqsSection: jsonb("faqs_section")
      .notNull()
      .default(sql`'{}'::jsonb`),
    reviewsSection: jsonb("reviews_section")
      .notNull()
      .default(sql`'{}'::jsonb`),
    locationSection: jsonb("location_section")
      .notNull()
      .default(sql`'{}'::jsonb`),
    isOceanfront: boolean("is_oceanfront").notNull().default(false),
    isBeachfront: boolean("is_beachfront").notNull().default(false),
    isWaterfront: boolean("is_waterfront").notNull().default(false),
    hasPrivatePool: boolean("has_private_pool").notNull().default(false),
    hasNeighborhoodPool: boolean("has_neighborhood_pool")
      .notNull()
      .default(false),
    hasPool: boolean("has_pool").notNull().default(false),
    allowsPets: boolean("allows_pets").notNull().default(false),
    hasNeighborhoodAmenities: boolean("has_neighborhood_amenities")
      .notNull()
      .default(false),
    bedrooms: integer("bedrooms"),
    bathrooms: numeric("bathrooms", { precision: 4, scale: 1 }),
    maxGuests: integer("max_guests"),
    currencyCode: text("currency_code"),
    nightlyRate: numeric("nightly_rate", { precision: 12, scale: 2 }),
    streetAddress: text("street_address"),
    zipCode: text("zip_code"),
    lat: doublePrecision("lat"),
    lng: doublePrecision("lng"),
    geo: jsonb("geo"),
    mergeStrategyVersion: text("merge_strategy_version")
      .notNull()
      .default("v1"),
    fieldLineage: jsonb("field_lineage")
      .notNull()
      .default(sql`'{}'::jsonb`),
    sourceRefs: jsonb("source_refs")
      .notNull()
      .default(sql`'[]'::jsonb`),
    images: jsonb("images")
      .notNull()
      .default(sql`'[]'::jsonb`),
    primaryImageId: text("primary_image_id"),
    createdAt: timestamp("created_at", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    slugUniqueIdx: uniqueIndex("listing_slug_unique_idx").on(table.slug),
    cityIdx: index("listing_city_idx").on(table.city),
    stateIdx: index("listing_state_idx").on(table.state),
    propertyTypeIdx: index("listing_property_type_idx").on(table.propertyType),
    isOceanfrontIdx: index("listing_is_oceanfront_idx").on(table.isOceanfront),
    isBeachfrontIdx: index("listing_is_beachfront_idx").on(table.isBeachfront),
    isWaterfrontIdx: index("listing_is_waterfront_idx").on(table.isWaterfront),
    hasPrivatePoolIdx: index("listing_has_private_pool_idx").on(
      table.hasPrivatePool,
    ),
    hasNeighborhoodPoolIdx: index("listing_has_neighborhood_pool_idx").on(
      table.hasNeighborhoodPool,
    ),
    hasPoolIdx: index("listing_has_pool_idx").on(table.hasPool),
    allowsPetsIdx: index("listing_allows_pets_idx").on(table.allowsPets),
    hasNeighborhoodAmenitiesIdx: index(
      "listing_has_neighborhood_amenities_idx",
    ).on(table.hasNeighborhoodAmenities),
    bedroomsIdx: index("listing_bedrooms_idx").on(table.bedrooms),
    nightlyRateIdx: index("listing_nightly_rate_idx").on(table.nightlyRate),
    latIdx: index("listing_lat_idx").on(table.lat),
    lngIdx: index("listing_lng_idx").on(table.lng),
    primaryImageIdIdx: index("listing_primary_image_id_idx").on(
      table.primaryImageId,
    ),
  }),
);

export const listingPriceSnapshots = pgTable(
  "listing_price_snapshot",
  {
    id: text("id").primaryKey(),
    listingId: text("listing_id")
      .notNull()
      .references(() => listings.id, { onDelete: "cascade" }),
    channel: listingPriceChannelEnum("channel").notNull(),
    sourceUrl: text("source_url"),
    checkInDate: text("check_in_date").notNull(),
    checkOutDate: text("check_out_date").notNull(),
    nights: integer("nights"),
    currencyCode: text("currency_code").notNull().default("USD"),
    nightlyRate: numeric("nightly_rate", { precision: 12, scale: 2 }),
    subtotal: numeric("subtotal", { precision: 12, scale: 2 }),
    taxesAndFees: numeric("taxes_and_fees", { precision: 12, scale: 2 }),
    totalPrice: numeric("total_price", { precision: 12, scale: 2 }),
    isBookable: boolean("is_bookable").notNull().default(true),
    payload: jsonb("payload"),
    capturedAt: timestamp("captured_at", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    listingIdIdx: index("listing_price_snapshot_listing_id_idx").on(
      table.listingId,
    ),
    channelIdx: index("listing_price_snapshot_channel_idx").on(table.channel),
    dateRangeIdx: index("listing_price_snapshot_date_range_idx").on(
      table.checkInDate,
      table.checkOutDate,
    ),
    capturedAtIdx: index("listing_price_snapshot_captured_at_idx").on(
      table.capturedAt,
    ),
  }),
);

export const users = pgTable(
  "user",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    timeZone: text("time_zone"),
    emailVerified: boolean("email_verified").notNull(),
    image: text("image"),
    createdAt: timestamp("created_at", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    emailUniqueIdx: uniqueIndex("user_email_unique_idx").on(table.email),
  }),
);

export const authAccounts = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      mode: "string",
      withTimezone: true,
    }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      mode: "string",
      withTimezone: true,
    }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    userIdIdx: index("account_user_id_idx").on(table.userId),
    accountProviderUniqueIdx: uniqueIndex("account_provider_unique_idx").on(
      table.providerId,
      table.accountId,
    ),
  }),
);

export const authSessions = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", {
      mode: "string",
      withTimezone: true,
    }).notNull(),
    token: text("token").notNull(),
    createdAt: timestamp("created_at", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
  },
  (table) => ({
    tokenUniqueIdx: uniqueIndex("session_token_unique_idx").on(table.token),
    userIdIdx: index("session_user_id_idx").on(table.userId),
  }),
);

export const authVerifications = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", {
      mode: "string",
      withTimezone: true,
    }).notNull(),
    createdAt: timestamp("created_at", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    identifierValueUniqueIdx: uniqueIndex(
      "verification_identifier_value_unique_idx",
    ).on(table.identifier, table.value),
  }),
);
