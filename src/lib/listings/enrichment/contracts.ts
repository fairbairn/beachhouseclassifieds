export type ListingAiEnrichmentSourceSnapshotPayload = {
  canonical_name: string;
  description_expanded: string | null;
  meta_description: string | null;
  rooms_guidance?: string[];
  property_type: string | null;
  amenities: string[];
  bedrooms: number | null;
  bathrooms: string | null;
  sleeps: number | null;
  area: string | null;
  lat: number | null;
  lng: number | null;
};

export const LISTING_AI_ENRICHMENT_SOURCE_SNAPSHOT_REQUIRED_KEYS = [
  "canonical_name",
  "description_expanded",
  "meta_description",
  "property_type",
  "amenities",
  "bedrooms",
  "bathrooms",
  "sleeps",
] as const;

export type ListingAiEnrichmentOutputPayload = {
  description_markdown: string;
  description_short_plain: string;
  seo_meta_title: string;
  seo_meta_description: string;
  seo_hidden_summary_plain: string;
  highlights: string[];
  helpful_hints: string[];
  sleeping_arrangements: unknown[];
  sleeping_summary: Record<string, unknown>;
  amenities_normalized: string[];
};

export const LISTING_AI_ENRICHMENT_OUTPUT_REQUIRED_KEYS = [
  "description_markdown",
  "description_short_plain",
  "seo_meta_title",
  "seo_meta_description",
  "seo_hidden_summary_plain",
  "highlights",
  "helpful_hints",
  "sleeping_arrangements",
  "sleeping_summary",
  "amenities_normalized",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringOrNull(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function isNumberOrNull(value: unknown): boolean {
  return (
    value === null || (typeof value === "number" && Number.isFinite(value))
  );
}

export function validateSourceSnapshotPayload(value: unknown): string[] {
  const issues: string[] = [];

  if (!isRecord(value)) {
    return ["source_snapshot_payload must be an object."];
  }

  for (const key of LISTING_AI_ENRICHMENT_SOURCE_SNAPSHOT_REQUIRED_KEYS) {
    if (!(key in value)) {
      issues.push(`missing required source snapshot key: ${key}`);
    }
  }

  if (
    typeof value.canonical_name !== "string" ||
    value.canonical_name.trim().length === 0
  ) {
    issues.push("canonical_name must be a non-empty string.");
  }
  if (!isStringOrNull(value.description_expanded)) {
    issues.push("description_expanded must be string|null.");
  }
  if (!isStringOrNull(value.meta_description)) {
    issues.push("meta_description must be string|null.");
  }
  if (
    value.rooms_guidance !== undefined &&
    !(
      Array.isArray(value.rooms_guidance) &&
      value.rooms_guidance.every((entry) => typeof entry === "string")
    )
  ) {
    issues.push("rooms_guidance must be string[] when provided.");
  }
  if (!isStringOrNull(value.property_type)) {
    issues.push("property_type must be string|null.");
  }
  if (!Array.isArray(value.amenities)) {
    issues.push("amenities must be an array.");
  }
  if (!isNumberOrNull(value.bedrooms)) {
    issues.push("bedrooms must be number|null.");
  }
  if (!isStringOrNull(value.bathrooms)) {
    issues.push("bathrooms must be string|null.");
  }
  if (!isNumberOrNull(value.sleeps)) {
    issues.push("sleeps must be number|null.");
  }
  if (!isStringOrNull(value.area)) {
    issues.push("area must be string|null.");
  }
  if (!isNumberOrNull(value.lat)) {
    issues.push("lat must be number|null.");
  }
  if (!isNumberOrNull(value.lng)) {
    issues.push("lng must be number|null.");
  }

  return issues;
}

export function validateOutputPayloadStructure(value: unknown): string[] {
  const issues: string[] = [];

  if (!isRecord(value)) {
    return ["output_payload must be an object."];
  }

  for (const key of LISTING_AI_ENRICHMENT_OUTPUT_REQUIRED_KEYS) {
    if (!(key in value)) {
      issues.push(`missing required output key: ${key}`);
    }
  }

  const stringKeys: Array<keyof ListingAiEnrichmentOutputPayload> = [
    "description_markdown",
    "description_short_plain",
    "seo_meta_title",
    "seo_meta_description",
    "seo_hidden_summary_plain",
  ];
  for (const key of stringKeys) {
    if (typeof value[key] !== "string") {
      issues.push(`${key} must be a string.`);
    }
  }

  const arrayKeys: Array<keyof ListingAiEnrichmentOutputPayload> = [
    "highlights",
    "helpful_hints",
    "sleeping_arrangements",
    "amenities_normalized",
  ];
  for (const key of arrayKeys) {
    if (!Array.isArray(value[key])) {
      issues.push(`${key} must be an array.`);
    }
  }

  if (!isRecord(value.sleeping_summary)) {
    issues.push("sleeping_summary must be an object.");
  }

  return issues;
}
