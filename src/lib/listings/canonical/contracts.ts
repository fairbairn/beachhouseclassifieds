import { z } from "zod";

export const FEATURE_TRAIT_KEYS = [
  "feature.private_pool",
  "feature.pets_allowed",
  "feature.golf_cart",
  "feature.accessible",
  "feature.elevator",
] as const;

export const feature_trait_key_schema = z.enum(FEATURE_TRAIT_KEYS);

export const listing_trait_source_schema = z.object({
  source: z.string().min(1),
  source_path: z.string().min(1).optional(),
  excerpt: z.string().min(1).optional(),
});

export const listing_trait_schema = z.object({
  key: z.string().min(1),
  value_type: z.enum(["boolean", "number", "text"]),
  value_boolean: z.boolean().optional(),
  value_number: z.number().optional(),
  value_text: z.string().optional(),
  confidence_score: z.number().min(0).max(1).optional(),
  extraction_method: z.enum(["rule", "llm", "hybrid"]).optional(),
  sources: z.array(listing_trait_source_schema).default([]),
});

export const listing_traits_schema = z.array(listing_trait_schema);

export const sleeping_bed_type_schema = z.enum([
  "king",
  "queen",
  "full",
  "twin",
  "bunk",
  "sofa_bed",
  "daybed",
  "trundle",
  "murphy",
  "futon",
  "air_mattress",
  "unknown",
]);

export const bunk_configuration_schema = z.enum([
  "twin_over_twin",
  "twin_over_full",
  "full_over_full",
  "queen_over_queen",
  "twin_over_queen",
  "twin_over_king",
  "other",
]);

export const sleeping_bed_item_schema = z.object({
  bed_type: sleeping_bed_type_schema,
  count: z.number().int().positive(),
  bunk_configuration: bunk_configuration_schema.optional(),
  notes: z.string().optional(),
});

export const sleeping_room_role_schema = z.enum([
  "primary",
  "guest",
  "bunk_room",
  "loft",
  "hall",
  "living_area",
  "other",
]);

export const sleeping_room_schema = z.object({
  room_label: z.string().min(1),
  room_role: sleeping_room_role_schema.default("other"),
  sleeps: z.number().int().positive().optional(),
  beds: z.array(sleeping_bed_item_schema).default([]),
  notes: z.string().optional(),
});

export const sleeping_arrangements_schema = z.array(sleeping_room_schema);

export const sleeping_derivation_schema = z.object({
  confidence_score: z.number().min(0).max(1),
  extraction_method: z.enum(["rule", "llm", "hybrid"]),
  extraction_version: z.string().min(1),
  derived_at: z.string().min(1),
  unresolved_notes: z.array(z.string()).default([]),
});

export type FeatureTraitKey = z.infer<typeof feature_trait_key_schema>;
export type ListingTrait = z.infer<typeof listing_trait_schema>;
export type SleepingBedItem = z.infer<typeof sleeping_bed_item_schema>;
export type SleepingRoom = z.infer<typeof sleeping_room_schema>;
export type SleepingArrangements = z.infer<typeof sleeping_arrangements_schema>;
export type SleepingDerivation = z.infer<typeof sleeping_derivation_schema>;
