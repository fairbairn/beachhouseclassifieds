import { z } from "zod";

import {
  FEATURE_TRAIT_KEYS,
  listing_traits_schema,
  sleeping_arrangements_schema,
  type FeatureTraitKey,
  type ListingTrait,
} from "@/lib/listings/canonical/contracts";
import {
  areaLabelFromCode,
  beachAreaLabelFromCode,
  communityLabelFromCode,
} from "@/lib/listings/taxonomy/location-taxonomy";

const canonical_listing_record_schema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  canonical_name: z.string().min(1),
  property_type: z.string().nullable().optional(),
  bedrooms: z.number().int().nullable().optional(),
  bathrooms: z.number().nullable().optional(),
  sleeps: z.number().int().nullable().optional(),
  city: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  area: z.string().nullable().optional(),
  area_name: z.string().nullable().optional(),
  beach_area_name: z.string().nullable().optional(),
  community_name: z.string().nullable().optional(),
  is_gulf_front: z.boolean(),
  lat: z.number().nullable().optional(),
  lng: z.number().nullable().optional(),
  traits: z.unknown().optional(),
  sleeping_arrangements: z.unknown().optional(),
  updated_at: z.string().optional(),
});

const feature_key_to_output_field: Record<
  FeatureTraitKey,
  keyof SearchFeatureFlags
> = {
  "feature.private_pool": "has_private_pool",
  "feature.pets_allowed": "allows_pets",
  "feature.golf_cart": "has_golf_cart",
  "feature.accessible": "is_accessible",
  "feature.elevator": "has_elevator",
};

export type CanonicalListingRecord = z.infer<
  typeof canonical_listing_record_schema
>;

export type SearchFeatureFlags = {
  has_private_pool: boolean;
  allows_pets: boolean;
  has_golf_cart: boolean;
  is_accessible: boolean;
  has_elevator: boolean;
};

export type ListingSearchDocument = {
  id: string;
  slug: string;
  canonical_name: string;
  property_type: string | null;
  bedrooms: number;
  bathrooms: number;
  sleeps: number;
  city: string | null;
  state: string | null;
  area: string | null;
  area_name: string | null;
  area_label: string | null;
  beach_area_name: string | null;
  beach_area_label: string | null;
  community_name: string | null;
  community_label: string | null;
  is_gulf_front: boolean;
  lat: number | null;
  lng: number | null;
  features: SearchFeatureFlags;
  feature_keys: string[];
  searchable_sleeping_text: string;
  updated_at: string | null;
};

function parse_listing_traits(input: unknown): ListingTrait[] {
  const parsed = listing_traits_schema.safeParse(input);
  if (parsed.success) {
    return parsed.data;
  }

  // Backward compatibility for early seed shapes where traits was an array of strings.
  if (
    Array.isArray(input) &&
    input.every((entry) => typeof entry === "string")
  ) {
    return input.map((entry) => ({
      key: entry,
      value_type: "boolean",
      value_boolean: true,
      sources: [],
    }));
  }

  // Backward compatibility for object map shape like {"feature.private_pool": true}
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return Object.entries(input).flatMap(([key, value]) => {
      if (typeof value === "boolean") {
        return [
          {
            key,
            value_type: "boolean" as const,
            value_boolean: value,
            sources: [],
          },
        ];
      }
      if (typeof value === "number") {
        return [
          {
            key,
            value_type: "number" as const,
            value_number: value,
            sources: [],
          },
        ];
      }
      if (typeof value === "string") {
        return [
          {
            key,
            value_type: "text" as const,
            value_text: value,
            sources: [],
          },
        ];
      }
      return [];
    });
  }

  return [];
}

function extract_feature_flags(traits: ListingTrait[]): {
  feature_flags: SearchFeatureFlags;
  feature_keys: string[];
} {
  const feature_flags: SearchFeatureFlags = {
    has_private_pool: false,
    allows_pets: false,
    has_golf_cart: false,
    is_accessible: false,
    has_elevator: false,
  };

  const feature_keys = new Set<string>();

  for (const trait of traits) {
    if (!FEATURE_TRAIT_KEYS.includes(trait.key as FeatureTraitKey)) {
      continue;
    }

    if (trait.value_type === "boolean" && trait.value_boolean === true) {
      const output_key =
        feature_key_to_output_field[trait.key as FeatureTraitKey];
      feature_flags[output_key] = true;
      feature_keys.add(trait.key);
    }
  }

  return {
    feature_flags,
    feature_keys: Array.from(feature_keys).sort((a, b) => a.localeCompare(b)),
  };
}

function derive_sleeping_search_text(input: unknown): string {
  const parsed = sleeping_arrangements_schema.safeParse(input);

  if (!parsed.success) {
    return "";
  }

  const text_parts: string[] = [];

  for (const room of parsed.data) {
    text_parts.push(room.room_label);

    for (const bed of room.beds) {
      text_parts.push(`${bed.count} ${bed.bed_type}`);
      if (bed.bunk_configuration) {
        text_parts.push(bed.bunk_configuration);
      }
    }
  }

  return text_parts.join(" ").trim();
}

export function project_listing_to_search_document(
  input: CanonicalListingRecord,
): ListingSearchDocument {
  const record = canonical_listing_record_schema.parse(input);
  const traits = parse_listing_traits(record.traits);
  const { feature_flags, feature_keys } = extract_feature_flags(traits);
  const searchable_sleeping_text = derive_sleeping_search_text(
    record.sleeping_arrangements,
  );

  return {
    id: record.id,
    slug: record.slug,
    canonical_name: record.canonical_name,
    property_type: record.property_type ?? null,
    bedrooms: record.bedrooms ?? 0,
    bathrooms: record.bathrooms ?? 0,
    sleeps: record.sleeps ?? 0,
    city: record.city ?? null,
    state: record.state ?? null,
    area: record.area ?? null,
    area_name: record.area_name ?? null,
    area_label: areaLabelFromCode(record.area_name ?? null),
    beach_area_name: record.beach_area_name ?? null,
    beach_area_label: beachAreaLabelFromCode(record.beach_area_name ?? null),
    community_name: record.community_name ?? null,
    community_label: communityLabelFromCode(record.community_name ?? null),
    is_gulf_front: record.is_gulf_front,
    lat: record.lat ?? null,
    lng: record.lng ?? null,
    features: feature_flags,
    feature_keys,
    searchable_sleeping_text,
    updated_at: record.updated_at ?? null,
  };
}
