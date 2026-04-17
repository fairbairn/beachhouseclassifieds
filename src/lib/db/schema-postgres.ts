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

export const listing_status_enum = pgEnum("listing_status", [
  "draft",
  "active",
  "inactive",
  "archived",
]);

export const listing_source_link_status_enum = pgEnum(
  "listing_source_link_status",
  ["active", "inactive"],
);

export const site = pgTable(
  "site",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    status: text("status").notNull().default("active"),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    slug_unique_idx: uniqueIndex("site_slug_unique_idx").on(table.slug),
    status_idx: index("site_status_idx").on(table.status),
  }),
);

export const listing = pgTable(
  "listing",
  {
    id: text("id").primaryKey(),
    listing_number: integer("listing_number").notNull(),
    site_id: text("site_id").references(() => site.id, {
      onDelete: "set null",
    }),
    status: listing_status_enum("status").notNull().default("active"),
    slug: text("slug").notNull(),
    slug_base: text("slug_base").notNull(),
    slug_qualifier: text("slug_qualifier"),
    slug_hash8: text("slug_hash8").notNull(),
    canonical_name: text("canonical_name").notNull(),
    property_type: text("property_type"),
    bedrooms: integer("bedrooms"),
    bathrooms: numeric("bathrooms", { precision: 4, scale: 1 }),
    sleeps: integer("sleeps"),
    description_markdown: text("description_markdown"),
    description_headline_plain: text("description_headline_plain"),
    description_short_plain: text("description_short_plain"),
    seo_meta_description: text("seo_meta_description"),
    seo_meta_title: text("seo_meta_title"),
    seo_hidden_summary_plain: text("seo_hidden_summary_plain"),
    highlights: jsonb("highlights")
      .notNull()
      .default(sql`'[]'::jsonb`),
    helpful_hints: jsonb("helpful_hints")
      .notNull()
      .default(sql`'[]'::jsonb`),
    sleeping_arrangements: jsonb("sleeping_arrangements")
      .notNull()
      .default(sql`'[]'::jsonb`),
    sleeping_summary: jsonb("sleeping_summary")
      .notNull()
      .default(sql`'{}'::jsonb`),
    content_version: integer("content_version").notNull().default(1),
    content_generated_at: timestamp("content_generated_at", {
      mode: "string",
      withTimezone: true,
    }),
    lat: doublePrecision("lat"),
    lng: doublePrecision("lng"),
    city: text("city"),
    state: text("state"),
    postal_code: text("postal_code"),
    country_code: text("country_code").notNull().default("US"),
    area: text("area"),
    area_name: text("area_name"),
    beach_area_name: text("beach_area_name"),
    community_name: text("community_name"),
    is_gulf_front: boolean("is_gulf_front").notNull().default(false),
    traits: jsonb("traits")
      .notNull()
      .default(sql`'[]'::jsonb`),
    amenities_normalized: jsonb("amenities_normalized")
      .notNull()
      .default(sql`'[]'::jsonb`),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    listing_number_unique_idx: uniqueIndex(
      "listing_listing_number_unique_idx",
    ).on(table.listing_number),
    slug_unique_idx: uniqueIndex("listing_slug_unique_idx").on(table.slug),
    site_id_idx: index("listing_site_id_idx").on(table.site_id),
    status_idx: index("listing_status_idx").on(table.status),
    discover_visibility_idx: index("listing_discover_visibility_idx").on(
      table.site_id,
      table.status,
      table.state,
      table.area_name,
    ),
    city_idx: index("listing_city_idx").on(table.city),
    state_idx: index("listing_state_idx").on(table.state),
    community_name_idx: index("listing_community_name_idx").on(
      table.community_name,
    ),
    is_gulf_front_idx: index("listing_is_gulf_front_idx").on(
      table.is_gulf_front,
    ),
  }),
);

export const listing_source_link = pgTable(
  "listing_source_link",
  {
    id: text("id").primaryKey(),
    listing_id: text("listing_id")
      .notNull()
      .references(() => listing.id, { onDelete: "cascade" }),
    adapter_key: text("adapter_key").notNull(),
    external_listing_id: text("external_listing_id").notNull(),
    details_url: text("details_url"),
    quote_context: jsonb("quote_context")
      .notNull()
      .default(sql`'{}'::jsonb`),
    is_primary_source: boolean("is_primary_source").notNull().default(false),
    source_status: listing_source_link_status_enum("source_status")
      .notNull()
      .default("active"),
    confidence_score: numeric("confidence_score", { precision: 5, scale: 4 }),
    excluded_by_match: boolean("excluded_by_match").notNull().default(false),
    first_seen_at: timestamp("first_seen_at", {
      mode: "string",
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
    last_seen_at: timestamp("last_seen_at", {
      mode: "string",
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
    active_from: timestamp("active_from", {
      mode: "string",
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
    active_to: timestamp("active_to", { mode: "string", withTimezone: true }),
    match_method: text("match_method"),
    match_evidence: jsonb("match_evidence")
      .notNull()
      .default(sql`'{}'::jsonb`),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    listing_id_idx: index("listing_source_link_listing_id_idx").on(
      table.listing_id,
    ),
    adapter_external_unique_idx: uniqueIndex(
      "listing_source_link_adapter_external_unique_idx",
    ).on(table.adapter_key, table.external_listing_id),
    listing_primary_unique_idx: uniqueIndex(
      "listing_source_link_listing_primary_unique_idx",
    )
      .on(table.listing_id)
      .where(
        sql`${table.is_primary_source} = true and ${table.source_status} = 'active' and ${table.active_to} is null`,
      ),
    source_status_idx: index("listing_source_link_source_status_idx").on(
      table.source_status,
    ),
  }),
);

export const listing_geocode_cache = pgTable(
  "listing_geocode_cache",
  {
    id: text("id").primaryKey(),
    listing_id: text("listing_id")
      .notNull()
      .references(() => listing.id, { onDelete: "cascade" }),
    provider: text("provider").notNull().default("google"),
    source_fingerprint: text("source_fingerprint").notNull(),
    source_input: jsonb("source_input")
      .notNull()
      .default(sql`'{}'::jsonb`),
    geocode_mode: text("geocode_mode").notNull().default("reverse"),
    query_text: text("query_text"),
    lat: doublePrecision("lat"),
    lng: doublePrecision("lng"),
    formatted_address: text("formatted_address"),
    street_address: text("street_address"),
    city: text("city"),
    state: text("state"),
    postal_code: text("postal_code"),
    country_code: text("country_code"),
    place_id: text("place_id"),
    location_type: text("location_type"),
    confidence_score: numeric("confidence_score", { precision: 5, scale: 4 }),
    geocode_status: text("geocode_status").notNull().default("resolved"),
    raw_response: jsonb("raw_response")
      .notNull()
      .default(sql`'{}'::jsonb`),
    resolved_at: timestamp("resolved_at", {
      mode: "string",
      withTimezone: true,
    }),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    listing_id_idx: index("listing_geocode_cache_listing_id_idx").on(
      table.listing_id,
    ),
    status_idx: index("listing_geocode_cache_status_idx").on(
      table.geocode_status,
    ),
    listing_unique_idx: uniqueIndex(
      "listing_geocode_cache_listing_unique_idx",
    ).on(table.listing_id),
  }),
);

export const listing_ai_enrichment = pgTable(
  "listing_ai_enrichment",
  {
    id: text("id").primaryKey(),
    listing_id: text("listing_id")
      .notNull()
      .references(() => listing.id, { onDelete: "cascade" }),
    source_link_id: text("source_link_id").references(
      () => listing_source_link.id,
      {
        onDelete: "set null",
      },
    ),
    adapter_key: text("adapter_key"),
    source_content_hash: text("source_content_hash").notNull(),
    status: text("status").notNull().default("pending"),
    model: text("model"),
    audit_model: text("audit_model"),
    prompt_version: text("prompt_version").notNull(),
    output_hash: text("output_hash"),
    source_snapshot_payload: jsonb("source_snapshot_payload")
      .notNull()
      .default(sql`'{}'::jsonb`),
    output_payload: jsonb("output_payload")
      .notNull()
      .default(sql`'{}'::jsonb`),
    usage_payload: jsonb("usage_payload")
      .notNull()
      .default(sql`'{}'::jsonb`),
    cost_usd: numeric("cost_usd", { precision: 12, scale: 6 }),
    audit_payload: jsonb("audit_payload")
      .notNull()
      .default(sql`'{}'::jsonb`),
    generated_at: timestamp("generated_at", {
      mode: "string",
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
    applied_at: timestamp("applied_at", { mode: "string", withTimezone: true }),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    listing_id_idx: index("listing_ai_enrichment_listing_id_idx").on(
      table.listing_id,
    ),
    status_idx: index("listing_ai_enrichment_status_idx").on(table.status),
    generated_at_idx: index("listing_ai_enrichment_generated_at_idx").on(
      table.generated_at,
    ),
    listing_hash_prompt_unique_idx: uniqueIndex(
      "listing_ai_enrichment_listing_hash_prompt_unique_idx",
    ).on(table.listing_id, table.source_content_hash, table.prompt_version),
  }),
);

// Compatibility alias for existing call sites while migration work completes.
export const listing_ai_refinement_cache = listing_ai_enrichment;

export const users = pgTable(
  "user",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    time_zone: text("time_zone"),
    email_verified: boolean("email_verified").notNull(),
    image: text("image"),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    email_unique_idx: uniqueIndex("user_email_unique_idx").on(table.email),
  }),
);

export const auth_accounts = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    account_id: text("account_id").notNull(),
    provider_id: text("provider_id").notNull(),
    user_id: text("user_id")
      .notNull()
      .references(() => users.id),
    access_token: text("access_token"),
    refresh_token: text("refresh_token"),
    id_token: text("id_token"),
    access_token_expires_at: timestamp("access_token_expires_at", {
      mode: "string",
      withTimezone: true,
    }),
    refresh_token_expires_at: timestamp("refresh_token_expires_at", {
      mode: "string",
      withTimezone: true,
    }),
    scope: text("scope"),
    password: text("password"),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    user_id_idx: index("account_user_id_idx").on(table.user_id),
    account_provider_unique_idx: uniqueIndex("account_provider_unique_idx").on(
      table.provider_id,
      table.account_id,
    ),
  }),
);

export const auth_sessions = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expires_at: timestamp("expires_at", {
      mode: "string",
      withTimezone: true,
    }).notNull(),
    token: text("token").notNull(),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
    ip_address: text("ip_address"),
    user_agent: text("user_agent"),
    user_id: text("user_id")
      .notNull()
      .references(() => users.id),
  },
  (table) => ({
    token_unique_idx: uniqueIndex("session_token_unique_idx").on(table.token),
    user_id_idx: index("session_user_id_idx").on(table.user_id),
  }),
);

export const auth_verifications = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expires_at: timestamp("expires_at", {
      mode: "string",
      withTimezone: true,
    }).notNull(),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    identifier_value_unique_idx: uniqueIndex(
      "verification_identifier_value_unique_idx",
    ).on(table.identifier, table.value),
  }),
);
