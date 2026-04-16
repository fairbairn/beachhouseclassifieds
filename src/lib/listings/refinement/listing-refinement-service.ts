import "@/core/tooling/env/load-env-profile";

import { createHash, randomUUID } from "node:crypto";

import { and, eq, isNull } from "drizzle-orm";

import { pgDb } from "@/core/server/db";
import { resolveProfileEnvironment } from "@/core/tooling/env/profile-env";
import {
  listing,
  listing_ai_enrichment,
  listing_source_link,
} from "@/lib/db/schema-postgres";
import { sleeping_arrangements_schema } from "@/lib/listings/canonical/contracts";
import {
  buildSleepResolutionSchema,
  extractStructuredOutputText,
  SLEEP_RESOLUTION_PROMPT_BASE,
} from "./sleep-contracts";

type RefinementOutput = {
  description_markdown: string;
  description_headline_plain: string;
  description_short_plain: string;
  seo_meta_title: string;
  seo_meta_description: string;
  seo_hidden_summary_plain: string;
  highlights: string[];
  helpful_hints: string[];
  sleeping_arrangements: unknown;
  sleeping_summary: {
    bed_counts: {
      king: number;
      queen: number;
      full: number;
      twin_standalone: number;
      bunk_beds: number;
      other: number;
    };
    bunk_configurations: {
      default_twin_over_twin: number;
      twin_over_full: number;
      full_over_full: number;
      queen_over_queen: number;
      twin_over_queen: number;
      twin_over_king: number;
      other: number;
    };
    sleep_capacity: {
      derived_total: number;
      target_sleeps: number;
      delta: number;
      aligned: boolean;
    };
  };
  amenities_normalized: string[];
  amenities_evidence: Array<{
    amenity_id: string;
    confidence_score: number;
    evidence_snippets: string[];
  }>;
};

type RefinementUsage = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
};

type ModelPricing = {
  inputPer1M: number;
  outputPer1M: number;
};

type ModelUsage = {
  model: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
};

type RefinementAuditIssue = {
  severity: "low" | "medium" | "high";
  field: string;
  issue: string;
  source_evidence: string;
  correction_hint: string;
};

type RefinementAudit = {
  accuracy_score: number;
  retry_recommended: boolean;
  issues: RefinementAuditIssue[];
  retry_performed: boolean;
};

type RefinementAuditDecision = {
  performed: boolean;
  trigger_reasons: string[];
  skipped_reason: string | null;
};

type AmenityEvidence = {
  amenity_id: string;
  confidence_score: number;
  evidence_snippets: string[];
};

export type ListingRefinementSnapshot = {
  listing_id: string;
  slug: string;
  canonical_name: string;
  property_type: string | null;
  bedrooms: number | null;
  bathrooms: string | null;
  sleeps: number | null;
  adapter_key: string | null;
  source_description_original: string | null;
  source_meta_description_original: string | null;
  source_amenities_original: string[];
  source_amenities_categories: Record<string, string[]>;
  description_markdown: string | null;
  description_headline_plain: string | null;
  description_short_plain: string | null;
  seo_meta_title: string | null;
  seo_meta_description: string | null;
  seo_hidden_summary_plain: string | null;
  highlights: unknown;
  helpful_hints: unknown;
  sleeping_arrangements: unknown;
  amenities_normalized: unknown;
  ai_refinement: Record<string, unknown> | null;
  source_content_hash: string | null;
  source_link_id: string | null;
  match_evidence: Record<string, unknown>;
};

export type RefinementResult = {
  model: string;
  audit_model: string;
  prompt_version: string;
  output: RefinementOutput;
  usage: RefinementUsage | null;
  usage_by_model: ModelUsage[];
  audit: RefinementAudit | null;
  audit_decision: RefinementAuditDecision;
};

const PROMPT_VERSION = "v5";
export const LISTING_REFINEMENT_PROMPT_VERSION = PROMPT_VERSION;
const AUDIT_MIN_ACCURACY_SCORE = 0.9;
const SEO_BRAND_NAME = "30A Collections";
const FORCE_AUDIT = process.env.LISTING_REFINEMENT_FORCE_AUDIT === "1";
const DEFAULT_GENERATION_MODEL =
  process.env.LISTING_REFINEMENT_MODEL?.trim() || "gpt-5.4-nano";
const DEFAULT_AUDIT_MODEL =
  process.env.LISTING_REFINEMENT_AUDIT_MODEL?.trim() || "gpt-4.1-mini";
const DEFAULT_SLEEP_RESOLUTION_MODEL =
  process.env.LISTING_REFINEMENT_SLEEP_RESOLUTION_MODEL?.trim() || "gpt-4.1";

const MODEL_PRICING_USD_PER_1M: Record<string, ModelPricing> = {
  "gpt-5.4-nano": { inputPer1M: 0.2, outputPer1M: 1.25 },
  "gpt-4.1-mini": { inputPer1M: 0.4, outputPer1M: 1.6 },
  "gpt-4.1": { inputPer1M: 2.0, outputPer1M: 8.0 },
};

const CANONICAL_AMENITY_IDS = [
  "private_pool",
  "community_pool",
  "hot_tub",
  "gulf_front",
  "beachfront",
  "near_beach",
  "walk_to_beach",
  "golf_cart",
  "elevator",
  "pet_friendly",
  "game_room",
  "outdoor_grill",
  "outdoor_shower",
  "fire_pit",
  "wifi",
  "workspace",
  "smart_tv",
  "balcony_or_patio",
  "water_view",
  "parking",
  "garage",
] as const;

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
}

function mergeUsage(
  usageValues: Array<RefinementUsage | null | undefined>,
): RefinementUsage | null {
  const totals: Required<RefinementUsage> = {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
  };

  for (const usage of usageValues) {
    totals.input_tokens += usage?.input_tokens ?? 0;
    totals.output_tokens += usage?.output_tokens ?? 0;
    totals.total_tokens += usage?.total_tokens ?? 0;
  }

  if (
    totals.input_tokens === 0 &&
    totals.output_tokens === 0 &&
    totals.total_tokens === 0
  ) {
    return null;
  }

  return totals;
}

function getPricingForModel(model: string): ModelPricing | null {
  const envInputRaw = process.env.OPENAI_PRICE_INPUT_PER_1M?.trim();
  const envOutputRaw = process.env.OPENAI_PRICE_OUTPUT_PER_1M?.trim();

  if (envInputRaw && envOutputRaw) {
    const inputPer1M = Number(envInputRaw);
    const outputPer1M = Number(envOutputRaw);
    if (
      Number.isFinite(inputPer1M) &&
      inputPer1M >= 0 &&
      Number.isFinite(outputPer1M) &&
      outputPer1M >= 0
    ) {
      return { inputPer1M, outputPer1M };
    }
  }

  return MODEL_PRICING_USD_PER_1M[model] ?? null;
}

function estimateRunCostUsd(input: {
  usageByModel: ModelUsage[];
  fallbackModel: string;
  fallbackUsage: RefinementUsage | null;
}): string | null {
  const usageRows =
    input.usageByModel.length > 0
      ? input.usageByModel
      : [
          {
            model: input.fallbackModel,
            input_tokens: input.fallbackUsage?.input_tokens ?? 0,
            output_tokens: input.fallbackUsage?.output_tokens ?? 0,
            total_tokens: input.fallbackUsage?.total_tokens ?? 0,
          },
        ];

  let total = 0;

  for (const row of usageRows) {
    const pricing = getPricingForModel(row.model);
    if (!pricing) {
      return null;
    }

    total +=
      (Math.max(0, row.input_tokens) / 1_000_000) * pricing.inputPer1M +
      (Math.max(0, row.output_tokens) / 1_000_000) * pricing.outputPer1M;
  }

  return total.toFixed(6);
}

function pushModelUsage(
  usageByModel: Map<string, ModelUsage>,
  model: string,
  usage: RefinementUsage | null | undefined,
): void {
  const inputTokens = usage?.input_tokens ?? 0;
  const outputTokens = usage?.output_tokens ?? 0;
  const totalTokens = usage?.total_tokens ?? 0;

  if (inputTokens === 0 && outputTokens === 0 && totalTokens === 0) {
    return;
  }

  const existing = usageByModel.get(model);
  if (existing) {
    existing.input_tokens += inputTokens;
    existing.output_tokens += outputTokens;
    existing.total_tokens += totalTokens;
    return;
  }

  usageByModel.set(model, {
    model,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
  });
}

function extractSourceAmenities(value: unknown): {
  all: string[];
  categories: Record<string, string[]>;
} {
  const dedupe = (items: string[], limit: number): string[] =>
    Array.from(new Set(items.filter(Boolean))).slice(0, limit);

  if (Array.isArray(value)) {
    return {
      all: dedupe(asStringArray(value), 300),
      categories: {},
    };
  }

  const amenitiesObject = asObject(value);
  const all = asStringArray(amenitiesObject.all);
  const categoriesRaw = asObject(amenitiesObject.categories);

  const categories: Record<string, string[]> = {};
  for (const [key, categoryValue] of Object.entries(categoriesRaw)) {
    const entries = dedupe(asStringArray(categoryValue), 80);
    if (entries.length > 0) {
      categories[key] = entries;
    }
  }

  const categoryEntries = Object.values(categories).flat();

  return {
    all: dedupe([...all, ...categoryEntries], 300),
    categories,
  };
}

function normalizeAmenity(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/[-_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeAmenities(values: string[]): string[] {
  const normalized = values.map(normalizeAmenity).filter(Boolean);
  const mapped: string[] = [];

  const pushIf = (condition: boolean, amenityId: string) => {
    if (condition) {
      mapped.push(amenityId);
    }
  };

  for (const amenity of normalized) {
    pushIf(
      /private\s+pool|pool\s*\(\s*private\s*\)/.test(amenity),
      "private_pool",
    );
    pushIf(/community\s+pool|shared\s+pool/.test(amenity), "community_pool");
    pushIf(/hot\s+tub|spa/.test(amenity), "hot_tub");
    pushIf(/gulf\s*front/.test(amenity), "gulf_front");
    pushIf(/beach\s*front/.test(amenity), "beachfront");
    pushIf(/near\s+beach|beach\s+nearby/.test(amenity), "near_beach");
    pushIf(/walk\s+to\s+beach/.test(amenity), "walk_to_beach");
    pushIf(/golf\s*cart|lsv/.test(amenity), "golf_cart");
    pushIf(/elevator/.test(amenity), "elevator");
    pushIf(/pet\s*friendly|pets?\s+allowed/.test(amenity), "pet_friendly");
    pushIf(/game\s+room/.test(amenity), "game_room");
    pushIf(/grill|bbq/.test(amenity), "outdoor_grill");
    pushIf(/outdoor\s+shower/.test(amenity), "outdoor_shower");
    pushIf(/fire\s*pit/.test(amenity), "fire_pit");
    pushIf(/wi\s*-?fi|internet/.test(amenity), "wifi");
    pushIf(/workspace|desk/.test(amenity), "workspace");
    pushIf(/smart\s*tv|streaming/.test(amenity), "smart_tv");
    pushIf(/balcony|patio|deck/.test(amenity), "balcony_or_patio");
    pushIf(/water\s+view|gulf\s+view|ocean\s+view/.test(amenity), "water_view");
    pushIf(/parking|garage/.test(amenity), "parking");
  }

  const finalIds = mapped.filter((id) =>
    (CANONICAL_AMENITY_IDS as readonly string[]).includes(id),
  );

  return Array.from(new Set(finalIds)).sort((a, b) => a.localeCompare(b));
}

function deriveAmenitiesFromSource(values: string[]): {
  ids: string[];
  evidence: AmenityEvidence[];
} {
  const rules: Array<{ amenity_id: string; regex: RegExp }> = [
    { amenity_id: "garage", regex: /\bgarage\b/i },
    { amenity_id: "parking", regex: /\bparking\b|\bpark\b|driveway/i },
    {
      amenity_id: "game_room",
      regex: /\bgame\s*room\b|arcade|billiards|pool\s*table/i,
    },
    { amenity_id: "hot_tub", regex: /hot\s*tub|spa\b|jacuzzi/i },
    { amenity_id: "balcony_or_patio", regex: /balcony|patio|deck|porch/i },
    {
      amenity_id: "community_pool",
      regex: /community\s*pool|shared\s*pool|resort\s*pool/i,
    },
    { amenity_id: "private_pool", regex: /private\s*pool/i },
    {
      amenity_id: "walk_to_beach",
      regex: /walk\s*to\s*beach|steps?\s*(from|to)\s*(the\s*)?beach/i,
    },
    {
      amenity_id: "near_beach",
      regex: /near\s*beach|beach\s*access|beach\s*walkover/i,
    },
    { amenity_id: "golf_cart", regex: /golf\s*cart|\blsv\b/i },
    {
      amenity_id: "water_view",
      regex: /water\s*view|gulf\s*view|ocean\s*view|lake\s*view/i,
    },
  ];

  const allIds: string[] = [];
  const evidenceByAmenity = new Map<string, Set<string>>();

  for (const sourceLine of values) {
    const trimmed = sourceLine.trim();
    if (!trimmed) {
      continue;
    }

    for (const rule of rules) {
      if (!rule.regex.test(trimmed)) {
        continue;
      }

      allIds.push(rule.amenity_id);
      if (!evidenceByAmenity.has(rule.amenity_id)) {
        evidenceByAmenity.set(rule.amenity_id, new Set<string>());
      }
      evidenceByAmenity.get(rule.amenity_id)!.add(trimmed);
    }
  }

  const ids = Array.from(
    new Set(
      allIds.filter((id) =>
        (CANONICAL_AMENITY_IDS as readonly string[]).includes(id),
      ),
    ),
  ).sort((a, b) => a.localeCompare(b));

  const evidence: AmenityEvidence[] = ids.map((amenityId) => ({
    amenity_id: amenityId,
    confidence_score: 0.9,
    evidence_snippets: Array.from(evidenceByAmenity.get(amenityId) ?? []).slice(
      0,
      3,
    ),
  }));

  return { ids, evidence };
}

function sanitizeHighlights(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  return Array.from(
    new Set(
      values
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter((entry) => entry.length > 0),
    ),
  ).slice(0, 8);
}

function splitIntoParagraphs(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return [];
  }

  const existing = normalized
    .split(/\n\s*\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (existing.length >= 2) {
    return existing;
  }

  const sentences = normalized
    .split(/(?<=[.!?])\s+/)
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (sentences.length <= 3) {
    return [normalized];
  }

  const grouped: string[] = [];
  for (let i = 0; i < sentences.length; i += 2) {
    grouped.push(
      sentences
        .slice(i, i + 2)
        .join(" ")
        .trim(),
    );
  }

  return grouped.slice(0, 4);
}

function splitIntoSentences(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .split(/(?<=[.!?])(?:\s+|(?=[A-Z]))/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

const OPERATIONAL_HINT_PATTERNS = [
  /wristband/i,
  /minimum\s+age|must\s+be\s+\d+|under\s+\d+|years?\s+of\s+age/i,
  /required|required to|must provide|must present/i,
  /access\s+to\s+amenities|amenit(y|ies)\s+access/i,
  /rules|policy|policies|quiet\s+hours|hoa/i,
  /asked\s+to\s+vacate|forfeit|fines?/i,
  /effective\s+[a-z]+\s+\d{1,2},?\s+\d{4}/i,
  /limited\s+to\s+\d+\s+vehicles?/i,
];

const REPETITIVE_FEATURE_PATTERNS = [
  /corner\s+lot|park|gourmet\s+kitchen|commercial[-\s]grade/i,
  /screened\s+porch|wrap[-\s]around\s+porch|private\s+screened\s+porch/i,
  /carriage\s+house|garage|golf\s*cart|adult\s+bikes?/i,
  /beach\s+club|gulf\s+views?|multiple\s+pools?/i,
  /bed(room)?s?|queen\s+bed|bunk/i,
];

function isOperationalHintText(value: string): boolean {
  return OPERATIONAL_HINT_PATTERNS.some((pattern) => pattern.test(value));
}

function isRepetitiveFeatureRecap(value: string): boolean {
  return REPETITIVE_FEATURE_PATTERNS.some((pattern) => pattern.test(value));
}

function normalizeHintText(value: string): string {
  return value
    .replace(/^[-*]\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeHumanProse(value: string): string {
  return value
    .replace(/[–—]/g, " ")
    .replace(/\s-\s/g, " ")
    .replace(/([A-Za-z])-(?=[A-Za-z])/g, "$1 ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .trim();
}

function ensureSentenceTerminalPunctuation(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  if (/[.!?]$/.test(trimmed)) {
    return trimmed;
  }

  return `${trimmed}.`;
}

function normalizeHintTone(value: string): string {
  return value
    .replace(/\bDO NOT\b/g, "do not")
    .replace(/\bNOT\b/g, "not")
    .replace(/\bMUST\b/g, "must")
    .replace(/\bREQUIRED\b/g, "required")
    .replace(/\bIS NOT\b/g, "is not")
    .replace(/\bARE NOT\b/g, "are not")
    .replace(/\bCAN NOT\b/g, "cannot")
    .replace(/\s+/g, " ")
    .trim();
}

function buildDeterministicLeadSentence(input: {
  canonicalName: string;
  propertyType: string | null;
  bedrooms: number | null;
  sourceDescription: string;
}): string {
  const name = input.canonicalName.trim() || "This property";
  const propertyType =
    (input.propertyType ?? "home").trim().toLowerCase() || "home";
  const normalizedPropertyType = (() => {
    if (!propertyType || propertyType === "unknown") {
      return "home";
    }

    if (propertyType.includes("house") || propertyType.includes("home")) {
      return "home";
    }

    if (
      propertyType.includes("carriage") ||
      inferCarriageHouseIsAccessory(input.sourceDescription)
    ) {
      return "home";
    }

    if (
      propertyType.includes("condo") ||
      propertyType.includes("condominium")
    ) {
      return "condo";
    }

    if (
      propertyType.includes("townhome") ||
      propertyType.includes("townhouse")
    ) {
      return "townhome";
    }

    if (propertyType.includes("villa")) {
      return "villa";
    }

    return "home";
  })();
  const bedroomPrefix =
    typeof input.bedrooms === "number" && input.bedrooms > 0
      ? `${input.bedrooms} bedroom `
      : "";

  const source = input.sourceDescription.toLowerCase();
  let locationPhrase = "";
  if (/watercolor/.test(source) && /camp\s+district/.test(source)) {
    locationPhrase = " in WaterColor's Camp District";
  } else if (/watercolor/.test(source)) {
    locationPhrase = " in WaterColor";
  }

  return `Discover ${name}, a ${bedroomPrefix}${normalizedPropertyType}${locationPhrase}.`;
}

function inferCarriageHouseIsAccessory(sourceDescription: string): boolean {
  const normalized = sourceDescription.toLowerCase();
  if (!normalized) {
    return false;
  }

  const accessorySignals = [
    /separate\s+carriage\s+house/,
    /carriage\s+house\s+guest\s+quarters/,
    /two\s*car\s+carriage\s+house\s+garage/,
    /main\s+house/,
    /includes\s+a\s+carriage\s+house/,
  ];

  return accessorySignals.some((pattern) => pattern.test(normalized));
}

function preventCarriageHouseMisclassification(input: {
  markdown: string;
  sourceDescription: string;
}): string {
  if (!input.markdown.trim()) {
    return "";
  }

  if (!inferCarriageHouseIsAccessory(input.sourceDescription)) {
    return input.markdown;
  }

  const lines = input.markdown.split("\n");
  const firstBodyLineIndex = lines.findIndex((line) => line.trim().length > 0);
  if (firstBodyLineIndex < 0) {
    return input.markdown;
  }

  const firstLine = lines[firstBodyLineIndex];
  const correctedFirstLine = firstLine
    .replace(/\bcarriage\s+home\b/gi, "home")
    .replace(/\bcarriage\s+house\b/gi, "home");

  lines[firstBodyLineIndex] = correctedFirstLine;
  return lines.join("\n");
}

function extractHelpfulNotes(sourceDescription: string): string[] {
  const normalized = sourceDescription.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return [];
  }

  const policySectionMatch = normalized.match(
    /\*{2,}\s*other\s+things\s+to\s+know\s*\*{2,}([\s\S]*?)(?:\*{2,}|$)/i,
  );
  const policySection = policySectionMatch?.[1]?.trim() ?? "";
  const policySectionCandidates = policySection
    ? splitHelpfulHintEntry(policySection)
    : [];

  const sentenceCandidates = splitIntoSentences(normalized);
  const lineCandidates = normalized
    .split(/\n+/)
    .flatMap((line) => line.split(/\s+-\s+/))
    .map((entry) => entry.trim())
    .filter(Boolean);

  const candidates = [
    ...policySectionCandidates,
    ...sentenceCandidates,
    ...lineCandidates,
  ]
    .map((entry) =>
      normalizeHintText(
        entry
          .replace(/^home\s+highlights\s*:?\s*/i, "")
          .replace(/^features\s*:?\s*/i, "")
          .trim(),
      ),
    )
    .filter(Boolean);

  return finalizeHelpfulHintCandidates(candidates).slice(0, 4);
}

function splitHelpfulHintEntry(value: string): string[] {
  const expanded = value
    .replace(/\*{2,}/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1. $2")
    .replace(/[•▪●]/g, ". ")
    .replace(
      /\b(we\s+do\s+not|travel\s+insurance|payment\s+policy|beach\s+services|waiver\s+required|bicycle\s+rentals?|additional\s+bikes|lsvs?\s+are|please\s+note|per\s+[a-z]+\s+hoa)\b/gi,
      (match) => `. ${match}`,
    )
    .replace(/\s+/g, " ")
    .trim();

  return expanded
    .split(/(?<=[.!?])\s+|\n+/)
    .map((part) => normalizeHintText(part))
    .filter(Boolean);
}

function isHighQualityHelpfulHint(value: string): boolean {
  if (!value) {
    return false;
  }

  if (value.length < 24 || value.length > 220) {
    return false;
  }

  if (/[a-z][A-Z]/.test(value)) {
    return false;
  }

  if (/\*{2,}|https?:\/\//i.test(value)) {
    return false;
  }

  if (
    /\b(30a\s*escapes|30aescapes|book\s+today|start\s+your\s+30a\s+escape)\b/i.test(
      value,
    )
  ) {
    return false;
  }

  const words = value.split(/\s+/).filter(Boolean).length;
  if (words < 5) {
    return false;
  }

  const advisoryPatterns = [
    /\b(please\s+note|important|note\s+that)\b/i,
    /\b(required|must|must\s+be|waiver|policy|rules?)\b/i,
    /\b(not\s+allowed|do\s+not|cannot|not\s+included|not\s+for\s+guest\s+use|prohibited)\b/i,
    /\b(check\s*in|check\s*out|minimum\s+age|quiet\s+hours|visitor|unregistered\s+guest)\b/i,
    /\b(parking|vehicles?|permit|hoa|wire\s+transfer|insurance|cancellation)\b/i,
    /\b(pool\s+heat|fireplace|camera|construction|bikes?|lsv|golf\s*cart)\b/i,
  ];
  const featureMarketingPatterns = [
    /\b(stunning|gorgeous|beautiful|luxury|upscale|chic|designer|elegant|serene|cozy)\b/i,
    /\b(private\s+courtyard|chef'?s\s+kitchen|living\s+area|dining\s+area|baby\s+grand\s+piano)\b/i,
    /\b(beach\s+access|walk\s+to\s+beach|resort\s+pools?|boutique\s+shops?)\b/i,
  ];
  const hasAdvisorySignal = advisoryPatterns.some((pattern) =>
    pattern.test(value),
  );
  const hasFeatureMarketingSignal = featureMarketingPatterns.some((pattern) =>
    pattern.test(value),
  );

  if (!hasAdvisorySignal) {
    return false;
  }
  if (
    hasFeatureMarketingSignal &&
    !/\b(required|must|not\s+allowed|do\s+not|policy|waiver|hoa)\b/i.test(value)
  ) {
    return false;
  }

  const lower = value.toLowerCase();
  const operationalSignals = [
    "required",
    "must",
    "do not",
    "not included",
    "not for guest use",
    "not allowed",
    "policy",
    "waiver",
    "hoa",
    "wristband",
    "check in",
    "check out",
    "wire transfer",
    "insurance",
    "event",
    "visitor",
    "vehicles",
    "pets",
    "quiet hours",
  ];
  if (!operationalSignals.some((signal) => lower.includes(signal))) {
    return false;
  }

  return !isRepetitiveFeatureRecap(value);
}

function normalizeHelpfulHintDedupKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b(get\s+access\s+to|access\s+to)\b/g, "access")
    .replace(/\b(a|an|the)\b/g, " ")
    .replace(/\d+/g, "#")
    .replace(/[^a-z#\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function classifyHelpfulHintTopic(value: string): string {
  const lower = value.toLowerCase();
  if (lower.includes("travel insurance") || lower.includes("insurance")) {
    return "insurance_policy";
  }
  if (lower.includes("waiver") && /\bbikes?\b/.test(lower)) {
    return "waiver_bikes";
  }
  if (lower.includes("wire transfer")) {
    return "wire_transfer";
  }
  if (lower.includes("hoa") || lower.includes("unregistered guests")) {
    return "hoa_guest_policy";
  }
  if (lower.includes("lsv") || lower.includes("golf cart")) {
    return "lsv_policy";
  }
  if (lower.includes("check in") || lower.includes("check out")) {
    return "checkin_checkout";
  }
  if (lower.includes("parking") || lower.includes("vehicles")) {
    return "parking_policy";
  }
  return "";
}

function finalizeHelpfulHintCandidates(values: string[]): string[] {
  const normalized = values
    .flatMap((entry) => splitHelpfulHintEntry(entry))
    .map((entry) => normalizeHumanProse(normalizeHintText(entry)))
    .map((entry) => normalizeHintTone(entry))
    .map((entry) => ensureSentenceTerminalPunctuation(entry))
    .filter((entry) => isHighQualityHelpfulHint(entry));

  const deduped: string[] = [];
  const seenKeys = new Set<string>();
  const seenTopics = new Set<string>();

  for (const entry of normalized) {
    const key = normalizeHelpfulHintDedupKey(entry);
    const topic = classifyHelpfulHintTopic(entry);
    if (!key || seenKeys.has(key)) {
      continue;
    }
    if (topic && seenTopics.has(topic)) {
      continue;
    }
    seenKeys.add(key);
    if (topic) {
      seenTopics.add(topic);
    }
    deduped.push(entry);
    if (deduped.length >= 6) {
      break;
    }
  }

  return deduped;
}

function sanitizeHelpfulHints(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  const splitCandidates = values.flatMap((entry) => {
    if (typeof entry !== "string") {
      return [];
    }

    return splitHelpfulHintEntry(entry);
  });

  return finalizeHelpfulHintCandidates(splitCandidates);
}

function formatDescriptionMarkdown(input: {
  markdown: string;
  sourceDescription: string;
  canonicalName: string;
  propertyType: string | null;
  bedrooms: number | null;
}): string {
  const correctedMarkdown = preventCarriageHouseMisclassification({
    markdown: input.markdown,
    sourceDescription: input.sourceDescription,
  });

  const paragraphs = splitIntoParagraphs(correctedMarkdown);
  const body = paragraphs.join("\n\n").trim();

  const normalizedHeading = body
    .replace(/\s+##\s*What\s+Makes\s+It\s+Special\b/gi, "\n\n")
    .replace(/\s+##\s*Helpful\s+Hints\b/gi, "\n\n");

  const proseOnly = normalizedHeading
    .split(/\n##\s*(What\s+Makes\s+It\s+Special|Helpful\s+Hints)\b/i)[0]
    ?.trim();

  const prose = proseOnly || body;
  const paragraphCandidates = splitIntoParagraphs(prose);

  const cleanedParagraphs = paragraphCandidates
    .map((paragraph) => {
      const unwrappedParagraph = paragraph
        .replace(/^\*\*([\s\S]+)\*\*$/m, "$1")
        .replace(/^__([\s\S]+)__$/m, "$1")
        .trim();
      const sentences = splitIntoSentences(unwrappedParagraph).filter(
        (sentence) => !isOperationalHintText(sentence),
      );
      const normalizedSentences =
        sentences.length > 0
          ? sentences
          : splitIntoSentences(unwrappedParagraph);
      return normalizeHumanProse(normalizedSentences.join(" ").trim());
    })
    .filter(Boolean);

  if (cleanedParagraphs.length === 0) {
    return buildDeterministicLeadSentence({
      canonicalName: input.canonicalName,
      propertyType: input.propertyType,
      bedrooms: input.bedrooms,
      sourceDescription: input.sourceDescription,
    });
  }

  return cleanedParagraphs.join("\n\n");
}

function normalizeSleepingRollups(
  value: unknown,
  expectedSleeps: number | null,
): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const input = value as Record<string, unknown>;
  const keys = [
    "bed_count_king",
    "bed_count_queen",
    "bed_count_full",
    "bed_count_twin",
    "bed_count_bunk_total",
    "bed_count_sofa_bed",
    "bed_count_daybed",
    "bed_count_trundle",
    "bed_count_murphy",
    "bed_count_air_mattress",
    "bed_count_futon",
    "bed_count_king_bunk",
    "bed_count_queen_bunk",
    "bed_count_full_bunk",
    "bed_count_twin_bunk",
    "bed_count_king_standalone",
    "bed_count_queen_standalone",
    "bed_count_full_standalone",
    "bed_count_twin_standalone",
    "bunk_unit_count_total",
    "bunk_sleep_slot_count_total",
    "bed_type_count_distinct",
    "sleep_capacity_from_rollups",
    "sleep_capacity_target",
    "sleep_capacity_delta",
  ];

  const output: Record<string, number> = {};
  const getCount = (key: string): number => {
    const raw = input[key];
    const numeric = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
    return Math.max(0, Math.round(numeric));
  };

  const kingTotal = getCount("bed_count_king");
  const queenTotal = getCount("bed_count_queen");
  const fullTotal = getCount("bed_count_full");
  const twinTotal = getCount("bed_count_twin");

  const bunkUnits = Math.max(
    getCount("bed_count_bunk_total"),
    getCount("bunk_unit_count_total"),
  );

  const kingBunk = Math.min(kingTotal, getCount("bed_count_king_bunk"));
  const queenBunk = Math.min(queenTotal, getCount("bed_count_queen_bunk"));
  const fullBunk = Math.min(fullTotal, getCount("bed_count_full_bunk"));

  const twinBunkRaw = getCount("bed_count_twin_bunk");
  const twinBunkFallback =
    bunkUnits > 0 ? Math.min(twinTotal, bunkUnits * 2) : 0;
  const twinBunk = Math.min(twinTotal, Math.max(twinBunkRaw, twinBunkFallback));

  const kingStandalone = Math.max(0, kingTotal - kingBunk);
  const queenStandalone = Math.max(0, queenTotal - queenBunk);
  const fullStandalone = Math.max(0, fullTotal - fullBunk);
  const twinStandalone = Math.max(0, twinTotal - twinBunk);

  const bunkSleepSlotCount = Math.max(
    getCount("bunk_sleep_slot_count_total"),
    twinBunk + fullBunk * 2 + queenBunk * 2 + kingBunk * 2,
  );

  const distinctBedTypeCount = [
    kingTotal,
    queenTotal,
    fullTotal,
    twinTotal,
  ].filter((count) => count > 0).length;

  const sleepCapacityFromRollups =
    kingTotal * 2 +
    queenTotal * 2 +
    fullTotal * 2 +
    twinTotal +
    getCount("bed_count_sofa_bed") * 2 +
    getCount("bed_count_daybed") +
    getCount("bed_count_trundle") +
    getCount("bed_count_murphy") * 2 +
    getCount("bed_count_air_mattress") +
    getCount("bed_count_futon") * 2;

  const sleepCapacityTarget =
    typeof expectedSleeps === "number" && Number.isFinite(expectedSleeps)
      ? Math.max(0, Math.round(expectedSleeps))
      : getCount("sleep_capacity_target");

  const sleepCapacityDelta =
    sleepCapacityTarget > 0
      ? sleepCapacityFromRollups - sleepCapacityTarget
      : 0;

  for (const key of keys) {
    output[key] = getCount(key);
  }

  output.bed_count_bunk_total = bunkUnits;
  output.bunk_unit_count_total = bunkUnits;
  output.bed_count_king_bunk = kingBunk;
  output.bed_count_queen_bunk = queenBunk;
  output.bed_count_full_bunk = fullBunk;
  output.bed_count_twin_bunk = twinBunk;
  output.bed_count_king_standalone = kingStandalone;
  output.bed_count_queen_standalone = queenStandalone;
  output.bed_count_full_standalone = fullStandalone;
  output.bed_count_twin_standalone = twinStandalone;
  output.bunk_sleep_slot_count_total = bunkSleepSlotCount;
  output.bed_type_count_distinct = distinctBedTypeCount;
  output.sleep_capacity_from_rollups = sleepCapacityFromRollups;
  output.sleep_capacity_target = sleepCapacityTarget;
  output.sleep_capacity_delta = sleepCapacityDelta;

  return output;
}

function hasMeaningfulSleepingRollups(
  rollups: Record<string, number>,
): boolean {
  return (
    (rollups.bed_count_king ?? 0) > 0 ||
    (rollups.bed_count_queen ?? 0) > 0 ||
    (rollups.bed_count_full ?? 0) > 0 ||
    (rollups.bed_count_twin ?? 0) > 0 ||
    (rollups.bed_count_bunk_total ?? 0) > 0
  );
}

function deriveSleepingRollupsFromArrangements(
  arrangements: unknown[],
  expectedSleeps: number | null,
): Record<string, number> {
  if (!Array.isArray(arrangements) || arrangements.length === 0) {
    return {};
  }

  const totals = {
    king: 0,
    queen: 0,
    full: 0,
    twin: 0,
    sofa_bed: 0,
    daybed: 0,
    trundle: 0,
    murphy: 0,
    air_mattress: 0,
    futon: 0,
  };

  const bunkBySize = {
    king: 0,
    queen: 0,
    full: 0,
    twin: 0,
  };

  let bunkUnits = 0;

  const addBunkByConfiguration = (
    bunkConfiguration: string,
    count: number,
  ): void => {
    bunkUnits += count;

    if (bunkConfiguration === "twin_over_full") {
      addSize("twin", count, true);
      addSize("full", count, true);
      return;
    }
    if (bunkConfiguration === "full_over_full") {
      addSize("full", count * 2, true);
      return;
    }
    if (bunkConfiguration === "queen_over_queen") {
      addSize("queen", count * 2, true);
      return;
    }
    if (bunkConfiguration === "twin_over_queen") {
      addSize("twin", count, true);
      addSize("queen", count, true);
      return;
    }
    if (bunkConfiguration === "twin_over_king") {
      addSize("twin", count, true);
      addSize("king", count, true);
      return;
    }

    // Default and twin_over_twin both map to two twin sleep surfaces per bunk.
    addSize("twin", count * 2, true);
  };

  const addSize = (bedType: string, count: number, bunkAttributed: boolean) => {
    if (bedType === "king") {
      totals.king += count;
      if (bunkAttributed) bunkBySize.king += count;
      return;
    }
    if (bedType === "queen") {
      totals.queen += count;
      if (bunkAttributed) bunkBySize.queen += count;
      return;
    }
    if (bedType === "full") {
      totals.full += count;
      if (bunkAttributed) bunkBySize.full += count;
      return;
    }
    if (bedType === "twin") {
      totals.twin += count;
      if (bunkAttributed) bunkBySize.twin += count;
      return;
    }
    if (bedType === "sofa_bed") {
      totals.sofa_bed += count;
      return;
    }
    if (bedType === "daybed") {
      totals.daybed += count;
      return;
    }
    if (bedType === "trundle") {
      totals.trundle += count;
      return;
    }
    if (bedType === "murphy") {
      totals.murphy += count;
      return;
    }
    if (bedType === "air_mattress") {
      totals.air_mattress += count;
      return;
    }
    if (bedType === "futon") {
      totals.futon += count;
    }
  };

  for (const room of arrangements) {
    if (!room || typeof room !== "object" || Array.isArray(room)) {
      continue;
    }

    const roomObject = room as Record<string, unknown>;
    const beds = Array.isArray(roomObject.beds) ? roomObject.beds : [];

    for (const bed of beds) {
      if (!bed || typeof bed !== "object" || Array.isArray(bed)) {
        continue;
      }

      const bedObject = bed as Record<string, unknown>;
      const bedType = asString(bedObject.bed_type);
      const countRaw = bedObject.count;
      const count =
        typeof countRaw === "number" && Number.isFinite(countRaw)
          ? Math.max(0, Math.round(countRaw))
          : 0;

      if (count < 1) {
        continue;
      }

      const bunkConfiguration = asString(bedObject.bunk_configuration);

      if (bedType === "bunk") {
        addBunkByConfiguration(bunkConfiguration, count);
        continue;
      }

      if (bunkConfiguration) {
        addBunkByConfiguration(bunkConfiguration, count);
        continue;
      }

      addSize(bedType, count, false);
    }
  }

  if (bunkUnits === 0 && bunkBySize.twin > 0) {
    bunkUnits = Math.ceil(bunkBySize.twin / 2);
  }

  return normalizeSleepingRollups(
    {
      bed_count_king: totals.king,
      bed_count_queen: totals.queen,
      bed_count_full: totals.full,
      bed_count_twin: totals.twin,
      bed_count_bunk_total: bunkUnits,
      bed_count_sofa_bed: totals.sofa_bed,
      bed_count_daybed: totals.daybed,
      bed_count_trundle: totals.trundle,
      bed_count_murphy: totals.murphy,
      bed_count_air_mattress: totals.air_mattress,
      bed_count_futon: totals.futon,
      bed_count_king_bunk: bunkBySize.king,
      bed_count_queen_bunk: bunkBySize.queen,
      bed_count_full_bunk: bunkBySize.full,
      bed_count_twin_bunk: bunkBySize.twin,
    },
    expectedSleeps,
  );
}

function normalizeSleepingArrangements(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const allowedRoles = new Set([
    "primary",
    "guest",
    "bunk_room",
    "loft",
    "hall",
    "living_area",
    "other",
  ]);
  const allowedBedTypes = new Set([
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
  const allowedBunkConfigs = new Set([
    "twin_over_twin",
    "twin_over_full",
    "full_over_full",
    "queen_over_queen",
    "twin_over_queen",
    "twin_over_king",
    "other",
  ]);

  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return null;
      }

      const row = entry as Record<string, unknown>;
      const roomLabel = asString(row.room_label);
      if (!roomLabel) {
        return null;
      }

      const roleRaw = asString(row.room_role);
      const roomRole = allowedRoles.has(roleRaw) ? roleRaw : "other";

      const sleepsRaw = row.sleeps;
      const sleeps =
        typeof sleepsRaw === "number" && Number.isFinite(sleepsRaw)
          ? Math.max(0, Math.round(sleepsRaw))
          : 0;

      const bedsRaw = Array.isArray(row.beds) ? row.beds : [];
      const beds = bedsRaw
        .map((bed) => {
          if (!bed || typeof bed !== "object" || Array.isArray(bed)) {
            return null;
          }

          const bedObject = bed as Record<string, unknown>;
          const bedType = asString(bedObject.bed_type);
          if (!allowedBedTypes.has(bedType)) {
            return null;
          }

          const countRaw = bedObject.count;
          const count =
            typeof countRaw === "number" && Number.isFinite(countRaw)
              ? Math.max(0, Math.round(countRaw))
              : 0;
          if (count < 1) {
            return null;
          }

          const bunkConfigurationRaw = asString(bedObject.bunk_configuration);
          const bunkConfiguration = allowedBunkConfigs.has(bunkConfigurationRaw)
            ? bunkConfigurationRaw
            : undefined;

          return {
            bed_type: bedType,
            count,
            bunk_configuration: bunkConfiguration,
            notes: asString(bedObject.notes) || undefined,
          };
        })
        .filter((bed): bed is NonNullable<typeof bed> => Boolean(bed));

      if (beds.length === 0 && sleeps === 0) {
        return null;
      }

      return {
        room_label: roomLabel,
        room_role: roomRole,
        sleeps: sleeps > 0 ? sleeps : undefined,
        beds,
        notes: asString(row.notes) || undefined,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
}

function deriveSleepingArrangementsFromRollups(
  rollups: Record<string, number>,
): unknown[] {
  const mapping: Array<{ key: string; bedType: string }> = [
    { key: "bed_count_king", bedType: "king" },
    { key: "bed_count_queen", bedType: "queen" },
    { key: "bed_count_full", bedType: "full" },
    { key: "bed_count_twin", bedType: "twin" },
    { key: "bed_count_bunk_total", bedType: "bunk" },
    { key: "bed_count_sofa_bed", bedType: "sofa_bed" },
    { key: "bed_count_daybed", bedType: "daybed" },
    { key: "bed_count_trundle", bedType: "trundle" },
    { key: "bed_count_murphy", bedType: "murphy" },
    { key: "bed_count_air_mattress", bedType: "air_mattress" },
    { key: "bed_count_futon", bedType: "futon" },
  ];

  const beds = mapping
    .map(({ key, bedType }) => {
      const count = Math.max(0, Math.round(rollups[key] ?? 0));
      if (count < 1) {
        return null;
      }

      return {
        bed_type: bedType,
        count,
        bunk_configuration: undefined,
        notes: undefined,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

  if (beds.length === 0) {
    return [];
  }

  return [
    {
      room_label: "Sleeping Areas",
      room_role: "other",
      beds,
      notes:
        "Derived from sleeping rollups when room-level source details were unavailable.",
    },
  ];
}

function sanitizeAmenitiesEvidence(value: unknown): AmenityEvidence[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const allowedIds = new Set(CANONICAL_AMENITY_IDS as readonly string[]);

  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return null;
      }

      const objectEntry = entry as Record<string, unknown>;
      const amenityId = normalizeAmenity(
        asString(objectEntry.amenity_id),
      ).replace(/\s+/g, "_");
      if (!allowedIds.has(amenityId)) {
        return null;
      }

      const confidenceRaw = objectEntry.confidence_score;
      const confidence =
        typeof confidenceRaw === "number" && Number.isFinite(confidenceRaw)
          ? Math.max(0, Math.min(1, confidenceRaw))
          : 0.5;

      const evidenceSnippets = asStringArray(
        objectEntry.evidence_snippets,
      ).slice(0, 3);

      return {
        amenity_id: amenityId,
        confidence_score: confidence,
        evidence_snippets: evidenceSnippets,
      };
    })
    .filter((entry): entry is AmenityEvidence => Boolean(entry));
}

function mergeAmenityEvidence(
  modelEvidence: AmenityEvidence[],
  sourceEvidence: AmenityEvidence[],
): AmenityEvidence[] {
  const merged = new Map<string, AmenityEvidence>();

  for (const item of [...modelEvidence, ...sourceEvidence]) {
    const existing = merged.get(item.amenity_id);
    if (!existing) {
      merged.set(item.amenity_id, {
        amenity_id: item.amenity_id,
        confidence_score: item.confidence_score,
        evidence_snippets: Array.from(new Set(item.evidence_snippets)).slice(
          0,
          3,
        ),
      });
      continue;
    }

    merged.set(item.amenity_id, {
      amenity_id: item.amenity_id,
      confidence_score: Math.max(
        existing.confidence_score,
        item.confidence_score,
      ),
      evidence_snippets: Array.from(
        new Set([...existing.evidence_snippets, ...item.evidence_snippets]),
      ).slice(0, 3),
    });
  }

  return Array.from(merged.values()).sort((a, b) =>
    a.amenity_id.localeCompare(b.amenity_id),
  );
}

function sanitizeAuditIssues(values: unknown): RefinementAuditIssue[] {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return null;
      }

      const objectEntry = entry as Record<string, unknown>;
      const severityRaw = asString(objectEntry.severity).toLowerCase();
      const severity: RefinementAuditIssue["severity"] =
        severityRaw === "high" ||
        severityRaw === "medium" ||
        severityRaw === "low"
          ? (severityRaw as RefinementAuditIssue["severity"])
          : "medium";

      const field = asString(objectEntry.field) || "description_markdown";
      const issue = asString(objectEntry.issue);
      const sourceEvidence = asString(objectEntry.source_evidence);
      const correctionHint = asString(objectEntry.correction_hint);

      if (!issue) {
        return null;
      }

      return {
        severity,
        field,
        issue,
        source_evidence: sourceEvidence,
        correction_hint: correctionHint,
      };
    })
    .filter((entry): entry is RefinementAuditIssue => Boolean(entry))
    .slice(0, 8);
}

function estimateSleepCapacityFromRollups(
  rollups: Record<string, number>,
): number {
  return (
    (rollups.bed_count_king ?? 0) * 2 +
    (rollups.bed_count_queen ?? 0) * 2 +
    (rollups.bed_count_full ?? 0) * 2 +
    (rollups.bed_count_twin ?? 0) +
    (rollups.bed_count_sofa_bed ?? 0) * 2 +
    (rollups.bed_count_daybed ?? 0) +
    (rollups.bed_count_trundle ?? 0) +
    (rollups.bed_count_murphy ?? 0) * 2 +
    (rollups.bed_count_air_mattress ?? 0) +
    (rollups.bed_count_futon ?? 0) * 2
  );
}

function getExpectedSleeps(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.round(value));
}

function evaluateSleepCapacityMatch(input: {
  rollups: Record<string, number>;
  expectedSleeps: number | null;
}): {
  derived: number;
  target: number | null;
  delta: number;
  matches: boolean;
} {
  const derived = estimateSleepCapacityFromRollups(input.rollups);
  const target = getExpectedSleeps(input.expectedSleeps);
  if (target === null) {
    return {
      derived,
      target: null,
      delta: 0,
      matches: true,
    };
  }

  const delta = derived - target;
  return {
    derived,
    target,
    delta,
    matches: delta === 0,
  };
}

function hasMeaningfulSleepEnvironment(
  rollups: Record<string, number>,
): boolean {
  return (
    (rollups.bed_count_king ?? 0) > 0 ||
    (rollups.bed_count_queen ?? 0) > 0 ||
    (rollups.bed_count_full ?? 0) > 0 ||
    (rollups.bed_count_twin ?? 0) > 0 ||
    (rollups.bed_count_bunk_total ?? 0) > 0 ||
    (rollups.bed_count_sofa_bed ?? 0) > 0 ||
    (rollups.bed_count_daybed ?? 0) > 0 ||
    (rollups.bed_count_trundle ?? 0) > 0 ||
    (rollups.bed_count_murphy ?? 0) > 0 ||
    (rollups.bed_count_air_mattress ?? 0) > 0 ||
    (rollups.bed_count_futon ?? 0) > 0
  );
}

function isSleepAccommodationAcceptable(input: {
  match: ReturnType<typeof evaluateSleepCapacityMatch>;
  rollups: Record<string, number>;
}): boolean {
  if (input.match.matches) {
    return true;
  }

  if (input.match.target === null) {
    return false;
  }

  return (
    input.match.delta === -1 && hasMeaningfulSleepEnvironment(input.rollups)
  );
}

function buildSleepingSummary(input: {
  arrangements: unknown[];
  expectedSleeps: number | null;
}): RefinementOutput["sleeping_summary"] {
  const bedCounts = {
    king: 0,
    queen: 0,
    full: 0,
    twin_standalone: 0,
    bunk_beds: 0,
    other: 0,
  };

  const bunkConfigurations = {
    default_twin_over_twin: 0,
    twin_over_full: 0,
    full_over_full: 0,
    queen_over_queen: 0,
    twin_over_queen: 0,
    twin_over_king: 0,
    other: 0,
  };

  let derivedTotal = 0;

  const addBunk = (configuration: string, count: number): void => {
    const cfg = configuration.trim().toLowerCase();
    bedCounts.bunk_beds += count;

    if (!cfg || cfg === "twin_over_twin") {
      bunkConfigurations.default_twin_over_twin += count;
      derivedTotal += count * 2;
      return;
    }
    if (cfg === "twin_over_full") {
      bunkConfigurations.twin_over_full += count;
      derivedTotal += count * 3;
      return;
    }
    if (cfg === "full_over_full") {
      bunkConfigurations.full_over_full += count;
      derivedTotal += count * 4;
      return;
    }
    if (cfg === "queen_over_queen") {
      bunkConfigurations.queen_over_queen += count;
      derivedTotal += count * 4;
      return;
    }
    if (cfg === "twin_over_queen") {
      bunkConfigurations.twin_over_queen += count;
      derivedTotal += count * 3;
      return;
    }
    if (cfg === "twin_over_king") {
      bunkConfigurations.twin_over_king += count;
      derivedTotal += count * 3;
      return;
    }

    bunkConfigurations.other += count;
    derivedTotal += count * 2;
  };

  for (const room of input.arrangements) {
    if (!room || typeof room !== "object" || Array.isArray(room)) {
      continue;
    }
    const roomObj = room as Record<string, unknown>;
    const beds = Array.isArray(roomObj.beds) ? roomObj.beds : [];

    for (const bed of beds) {
      if (!bed || typeof bed !== "object" || Array.isArray(bed)) {
        continue;
      }
      const bedObj = bed as Record<string, unknown>;
      const bedType = asString(bedObj.bed_type).toLowerCase();
      const bunkConfiguration = asString(bedObj.bunk_configuration);
      const count = Math.max(0, Math.round(asNumber(bedObj.count) ?? 0));
      if (count < 1) {
        continue;
      }

      if (bedType === "bunk" || bunkConfiguration.length > 0) {
        addBunk(bunkConfiguration, count);
        continue;
      }

      if (bedType === "king") {
        bedCounts.king += count;
        derivedTotal += count * 2;
        continue;
      }
      if (bedType === "queen") {
        bedCounts.queen += count;
        derivedTotal += count * 2;
        continue;
      }
      if (bedType === "full") {
        bedCounts.full += count;
        derivedTotal += count * 2;
        continue;
      }
      if (bedType === "twin") {
        bedCounts.twin_standalone += count;
        derivedTotal += count;
        continue;
      }

      // Keep uncommon bed types visible without overfitting UX fields.
      bedCounts.other += count;
      if (
        bedType === "daybed" ||
        bedType === "trundle" ||
        bedType === "air_mattress"
      ) {
        derivedTotal += count;
      } else if (
        bedType === "sofa_bed" ||
        bedType === "murphy" ||
        bedType === "futon"
      ) {
        derivedTotal += count * 2;
      }
    }
  }

  const targetSleeps =
    typeof input.expectedSleeps === "number" &&
    Number.isFinite(input.expectedSleeps)
      ? Math.max(0, Math.round(input.expectedSleeps))
      : 0;

  return {
    bed_counts: bedCounts,
    bunk_configurations: bunkConfigurations,
    sleep_capacity: {
      derived_total: derivedTotal,
      target_sleeps: targetSleeps,
      delta: derivedTotal - targetSleeps,
      aligned: derivedTotal === targetSleeps,
    },
  };
}

function deriveSleepingRollupsFromSummary(input: {
  sleepingSummary: unknown;
  expectedSleeps: number | null;
}): Record<string, number> {
  const summary = asObject(input.sleepingSummary);
  const bedCounts = asObject(summary.bed_counts);
  const bunkConfigurations = asObject(summary.bunk_configurations);

  const rollups = normalizeSleepingRollups(
    {
      bed_count_king: asNumber(bedCounts.king) ?? 0,
      bed_count_queen: asNumber(bedCounts.queen) ?? 0,
      bed_count_full: asNumber(bedCounts.full) ?? 0,
      bed_count_twin: asNumber(bedCounts.twin_standalone) ?? 0,
      bed_count_bunk_total:
        (asNumber(bedCounts.bunk_beds) ?? 0) +
        (asNumber(bunkConfigurations.default_twin_over_twin) ?? 0) +
        (asNumber(bunkConfigurations.twin_over_full) ?? 0) +
        (asNumber(bunkConfigurations.full_over_full) ?? 0) +
        (asNumber(bunkConfigurations.queen_over_queen) ?? 0) +
        (asNumber(bunkConfigurations.twin_over_queen) ?? 0) +
        (asNumber(bunkConfigurations.twin_over_king) ?? 0) +
        (asNumber(bunkConfigurations.other) ?? 0),
      bed_count_twin_bunk:
        (asNumber(bunkConfigurations.default_twin_over_twin) ?? 0) * 2,
      bed_count_full_bunk:
        (asNumber(bunkConfigurations.twin_over_full) ?? 0) +
        (asNumber(bunkConfigurations.full_over_full) ?? 0) * 2,
      bed_count_queen_bunk:
        (asNumber(bunkConfigurations.queen_over_queen) ?? 0) * 2 +
        (asNumber(bunkConfigurations.twin_over_queen) ?? 0),
      bed_count_king_bunk: asNumber(bunkConfigurations.twin_over_king) ?? 0,
    },
    input.expectedSleeps,
  );

  return rollups;
}

function deriveSleepRollupsFromOutput(input: {
  output: RefinementOutput;
  expectedSleeps: number | null;
}): Record<string, number> {
  return deriveSleepingRollupsFromSummary({
    sleepingSummary: input.output.sleeping_summary,
    expectedSleeps: input.expectedSleeps,
  });
}

type SleepResolutionResult = {
  arrangements: unknown[];
  rollups: Record<string, number>;
};

function buildSleepResolutionPrompt(): string {
  return [
    ...SLEEP_RESOLUTION_PROMPT_BASE,
    "Return sleeping_arrangements and sleeping_summary.",
  ].join(" ");
}

async function resolveSleepWithModel(input: {
  apiKey: string;
  sourceDescription: string;
  bedrooms: number | null;
  bathrooms: string | null;
  sleeps: number | null;
}): Promise<{
  result: SleepResolutionResult;
  usage: RefinementUsage | null;
}> {
  const sleepResolutionResponse = await callStructuredOpenAi({
    apiKey: input.apiKey,
    model: DEFAULT_SLEEP_RESOLUTION_MODEL,
    systemPrompt: buildSleepResolutionPrompt(),
    userPayload: {
      description_expanded: input.sourceDescription,
      bedrooms: input.bedrooms,
      bathrooms: input.bathrooms,
      sleeps: input.sleeps,
    },
    schemaName: "listing_refinement_sleep_resolution",
    schema: buildSleepResolutionSchema(),
  });

  const sleepParsed = sleepResolutionResponse.parsed;
  const parsedArrangements = normalizeSleepingArrangements(
    sleepParsed.sleeping_arrangements,
  );
  const parsedRollups = deriveSleepingRollupsFromSummary({
    sleepingSummary: sleepParsed.sleeping_summary,
    expectedSleeps: input.sleeps,
  });
  const parsedValidated =
    sleeping_arrangements_schema.safeParse(parsedArrangements);
  const parsedFallbackArrangements =
    deriveSleepingArrangementsFromRollups(parsedRollups);

  const arrangements =
    parsedValidated.success && parsedValidated.data.length > 0
      ? parsedValidated.data
      : parsedFallbackArrangements;

  return {
    result: {
      arrangements,
      rollups: parsedRollups,
    },
    usage: sleepResolutionResponse.usage,
  };
}

function finalizeSleepingOutput(input: {
  arrangements: unknown[];
  rollups: Record<string, number>;
  fallbackRollups: Record<string, number>;
  expectedSleeps: number | null;
}): {
  arrangements: unknown[];
  summary: RefinementOutput["sleeping_summary"];
} {
  const baseArrangements =
    input.arrangements.length > 0
      ? input.arrangements
      : deriveSleepingArrangementsFromRollups(input.fallbackRollups);
  const rollupsFromArrangements = deriveSleepingRollupsFromArrangements(
    baseArrangements,
    input.expectedSleeps,
  );
  const baseRollups = hasMeaningfulSleepingRollups(rollupsFromArrangements)
    ? rollupsFromArrangements
    : input.rollups;

  const reconciled = reconcileSleepingDataToExpected({
    arrangements: baseArrangements,
    rollups: baseRollups,
    expectedSleeps: input.expectedSleeps,
  });

  return {
    arrangements: reconciled.arrangements,
    summary: buildSleepingSummary({
      arrangements: reconciled.arrangements,
      expectedSleeps: input.expectedSleeps,
    }),
  };
}

function getBedCapacity(input: {
  bedType: string;
  count: number;
  bunkConfiguration?: string;
}): number {
  const count = Math.max(0, Math.round(input.count));
  if (count < 1) {
    return 0;
  }

  const bunk = input.bunkConfiguration?.trim() ?? "";
  if (bunk === "twin_over_full") {
    return count * 3;
  }
  if (bunk === "full_over_full") {
    return count * 4;
  }
  if (bunk === "queen_over_queen") {
    return count * 4;
  }
  if (bunk === "twin_over_queen") {
    return count * 3;
  }
  if (bunk === "twin_over_king") {
    return count * 3;
  }
  if (bunk === "twin_over_twin") {
    return count * 2;
  }

  if (input.bedType === "king") {
    return count * 2;
  }
  if (input.bedType === "queen") {
    return count * 2;
  }
  if (input.bedType === "full") {
    return count * 2;
  }
  if (input.bedType === "twin") {
    return count;
  }
  if (input.bedType === "sofa_bed") {
    return count * 2;
  }
  if (input.bedType === "murphy") {
    return count * 2;
  }
  if (input.bedType === "futon") {
    return count * 2;
  }
  if (input.bedType === "daybed") {
    return count;
  }
  if (input.bedType === "trundle") {
    return count;
  }
  if (input.bedType === "air_mattress") {
    return count;
  }

  return 0;
}

function reconcileSleepingDataToExpected(input: {
  arrangements: unknown[];
  rollups: Record<string, number>;
  expectedSleeps: number | null;
}): {
  arrangements: unknown[];
  rollups: Record<string, number>;
} {
  const target = getExpectedSleeps(input.expectedSleeps);
  if (target === null) {
    return {
      arrangements: input.arrangements,
      rollups: input.rollups,
    };
  }

  const rollups = { ...input.rollups };
  type SleepCountKey =
    | "bed_count_king"
    | "bed_count_queen"
    | "bed_count_full"
    | "bed_count_twin"
    | "bed_count_sofa_bed"
    | "bed_count_daybed"
    | "bed_count_trundle"
    | "bed_count_murphy"
    | "bed_count_air_mattress"
    | "bed_count_futon";

  const capacityWeights: Record<SleepCountKey, number> = {
    bed_count_king: 2,
    bed_count_queen: 2,
    bed_count_full: 2,
    bed_count_twin: 1,
    bed_count_sofa_bed: 2,
    bed_count_daybed: 1,
    bed_count_trundle: 1,
    bed_count_murphy: 2,
    bed_count_air_mattress: 1,
    bed_count_futon: 2,
  };

  let delta = estimateSleepCapacityFromRollups(rollups) - target;

  if (delta > 0) {
    const reducePriority: SleepCountKey[] = [
      "bed_count_twin",
      "bed_count_trundle",
      "bed_count_daybed",
      "bed_count_air_mattress",
      "bed_count_full",
      "bed_count_queen",
      "bed_count_king",
      "bed_count_sofa_bed",
      "bed_count_murphy",
      "bed_count_futon",
    ];

    for (const key of reducePriority) {
      if (delta <= 0) {
        break;
      }

      const weight = capacityWeights[key];
      const available = Math.max(0, Math.round(rollups[key] ?? 0));
      if (available < 1) {
        continue;
      }

      if (weight === 1) {
        const removeCount = Math.min(available, delta);
        rollups[key] = available - removeCount;
        delta -= removeCount;
        continue;
      }

      const removeCount = Math.min(available, Math.floor(delta / weight));
      if (removeCount > 0) {
        rollups[key] = available - removeCount;
        delta -= removeCount * weight;
      }
    }

    if (delta > 0) {
      const adjustable = [
        "bed_count_full",
        "bed_count_queen",
        "bed_count_king",
      ] as const;
      for (const key of adjustable) {
        if (delta <= 0) {
          break;
        }
        const available = Math.max(0, Math.round(rollups[key] ?? 0));
        if (available < 1) {
          continue;
        }
        rollups[key] = available - 1;
        delta = Math.max(0, delta - 2);
      }
    }
  } else if (delta < 0) {
    rollups.bed_count_twin =
      Math.max(0, Math.round(rollups.bed_count_twin ?? 0)) + Math.abs(delta);
  }

  const reconciledRollups = normalizeSleepingRollups(rollups, target);

  const roomRows = input.arrangements
    .map((room) => {
      if (!room || typeof room !== "object" || Array.isArray(room)) {
        return null;
      }
      const roomObject = room as Record<string, unknown>;
      const beds = Array.isArray(roomObject.beds) ? roomObject.beds : [];
      const roomCapacity = beds.reduce((sum, bed) => {
        if (!bed || typeof bed !== "object" || Array.isArray(bed)) {
          return sum;
        }
        const bedObject = bed as Record<string, unknown>;
        const countRaw = bedObject.count;
        const count =
          typeof countRaw === "number" && Number.isFinite(countRaw)
            ? Math.max(0, Math.round(countRaw))
            : 0;
        if (count < 1) {
          return sum;
        }
        return (
          sum +
          getBedCapacity({
            bedType: asString(bedObject.bed_type),
            count,
            bunkConfiguration:
              asString(bedObject.bunk_configuration) || undefined,
          })
        );
      }, 0);

      const currentSleepsRaw = roomObject.sleeps;
      const currentSleeps =
        typeof currentSleepsRaw === "number" &&
        Number.isFinite(currentSleepsRaw)
          ? Math.max(0, Math.round(currentSleepsRaw))
          : 0;

      return {
        roomObject,
        roomCapacity,
        assignedSleeps:
          roomCapacity > 0
            ? Math.min(roomCapacity, Math.max(1, currentSleeps || roomCapacity))
            : 0,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

  if (roomRows.length > 0) {
    let assignedTotal = roomRows.reduce(
      (sum, room) => sum + room.assignedSleeps,
      0,
    );

    if (assignedTotal > target) {
      let toReduce = assignedTotal - target;
      for (let i = roomRows.length - 1; i >= 0; i -= 1) {
        if (toReduce <= 0) {
          break;
        }
        const room = roomRows[i];
        const minAllowed = room.roomCapacity > 0 ? 1 : 0;
        const reducible = Math.max(0, room.assignedSleeps - minAllowed);
        if (reducible < 1) {
          continue;
        }
        const reduceBy = Math.min(reducible, toReduce);
        room.assignedSleeps -= reduceBy;
        toReduce -= reduceBy;
      }
      assignedTotal = roomRows.reduce(
        (sum, room) => sum + room.assignedSleeps,
        0,
      );
    }

    if (assignedTotal < target) {
      let toAdd = target - assignedTotal;
      for (const room of roomRows) {
        if (toAdd <= 0) {
          break;
        }
        const addable = Math.max(0, room.roomCapacity - room.assignedSleeps);
        if (addable < 1) {
          continue;
        }
        const addBy = Math.min(addable, toAdd);
        room.assignedSleeps += addBy;
        toAdd -= addBy;
      }

      if (toAdd > 0) {
        // If existing room capacities cannot reach target, add a deterministic overflow room
        // instead of creating impossible per-room sleeps.
        const overflowBeds = [
          {
            bed_type: "twin",
            count: toAdd,
            notes:
              "Deterministic reconciliation overflow to satisfy listing.sleeps exactly.",
          },
        ];
        input.arrangements.push({
          room_label: "Additional Sleeping Area",
          room_role: "other",
          sleeps: toAdd,
          beds: overflowBeds,
          notes:
            "Added during deterministic reconciliation because source sleeping details were insufficient to allocate all sleeping slots.",
        });
      }
    }

    for (const room of roomRows) {
      room.roomObject.sleeps =
        room.assignedSleeps > 0 ? room.assignedSleeps : undefined;
    }
  }

  const hasRoomWithoutBeds = input.arrangements.some((room) => {
    if (!room || typeof room !== "object" || Array.isArray(room)) {
      return false;
    }
    const roomObject = room as Record<string, unknown>;
    const beds = Array.isArray(roomObject.beds) ? roomObject.beds : [];
    return beds.length === 0;
  });

  const reconciledArrangements = hasRoomWithoutBeds
    ? deriveSleepingArrangementsFromRollups(reconciledRollups)
    : input.arrangements;

  return {
    arrangements: reconciledArrangements,
    rollups: reconciledRollups,
  };
}

function determinePropertyTypeCategory(
  propertyType: string | null,
): "home" | "condo" | "townhome" | "villa" | "other" {
  const normalized = (propertyType ?? "").toLowerCase();
  if (normalized.includes("condo")) {
    return "condo";
  }
  if (normalized.includes("townhome") || normalized.includes("townhouse")) {
    return "townhome";
  }
  if (normalized.includes("villa")) {
    return "villa";
  }
  if (
    normalized.includes("home") ||
    normalized.includes("house") ||
    normalized.includes("carriage")
  ) {
    return "home";
  }
  return "other";
}

function detectPropertyTypeKeywordMismatch(input: {
  propertyType: string | null;
  output: RefinementOutput;
}): string | null {
  const category = determinePropertyTypeCategory(input.propertyType);
  if (category === "other") {
    return null;
  }

  const text = [
    input.output.description_markdown,
    input.output.description_short_plain,
    input.output.seo_meta_description,
    ...input.output.highlights,
  ]
    .join(" ")
    .toLowerCase();

  const hasCondo = /\bcondo\b|\bcondominium\b/.test(text);
  const hasTownhome = /\btownhome\b|\btownhouse\b/.test(text);
  const hasVilla = /\bvilla\b/.test(text);
  const hasHomeType = /\bhome\b|\bhouse\b/.test(text);

  if (category === "condo" && (hasTownhome || hasVilla)) {
    return "Output references townhome/villa keywords while property_type is condo.";
  }
  if (category === "townhome" && (hasCondo || hasVilla)) {
    return "Output references condo/villa keywords while property_type is townhome.";
  }
  if (category === "villa" && (hasCondo || hasTownhome)) {
    return "Output references condo/townhome keywords while property_type is villa.";
  }
  if (category === "home" && (hasCondo || hasTownhome)) {
    return "Output references condo/townhome keywords while property_type is home.";
  }
  if (category !== "home" && hasHomeType && /(this|a|an)\s+home/.test(text)) {
    return "Output repeatedly frames the asset as a home while property_type indicates a different class.";
  }

  return null;
}

function determineAuditTriggerReasons(input: {
  output: RefinementOutput;
  snapshot: ListingRefinementSnapshot;
}): string[] {
  const reasons: string[] = [];
  const sleepMatch = evaluateSleepCapacityMatch({
    rollups: deriveSleepingRollupsFromSummary({
      sleepingSummary: input.output.sleeping_summary,
      expectedSleeps: input.snapshot.sleeps,
    }),
    expectedSleeps: input.snapshot.sleeps,
  });
  if (!sleepMatch.matches && sleepMatch.target !== null) {
    reasons.push(
      `Sleeping capacity mismatch (${sleepMatch.derived} vs listing.sleeps ${sleepMatch.target}).`,
    );
  }

  const propertyTypeMismatch = detectPropertyTypeKeywordMismatch({
    propertyType: input.snapshot.property_type,
    output: input.output,
  });
  if (propertyTypeMismatch) {
    reasons.push(propertyTypeMismatch);
  }

  if (!/\bvacation\s+rental\b/i.test(input.output.seo_meta_description)) {
    reasons.push(
      "seo_meta_description is missing the phrase 'vacation rental'.",
    );
  }

  return reasons;
}

function buildAmenitiesContext(input: {
  all: string[];
  categories: Record<string, string[]>;
}): {
  categories: Record<string, string[]>;
  features: string[];
  all: string[];
} {
  const categories = Object.fromEntries(
    Object.entries(input.categories)
      .map(([key, values]) => [key, asStringArray(values)])
      .filter(([, values]) => values.length > 0),
  );

  const features = asStringArray(categories.features ?? []);

  return {
    categories,
    features,
    all: asStringArray(input.all),
  };
}

async function callStructuredOpenAi(input: {
  apiKey: string;
  model: string;
  systemPrompt: string;
  userPayload: Record<string, unknown>;
  schemaName: string;
  schema: Record<string, unknown>;
}): Promise<{
  parsed: Record<string, unknown>;
  usage: RefinementUsage | null;
}> {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: input.model,
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: input.systemPrompt }],
        },
        {
          role: "user",
          content: [
            { type: "input_text", text: JSON.stringify(input.userPayload) },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: input.schemaName,
          schema: input.schema,
          strict: true,
        },
      },
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    let errorCode = "";
    let errorMessage = "";

    try {
      const parsedError = JSON.parse(errorBody) as Record<string, unknown>;
      const errorObject = asObject(parsedError.error);
      errorCode = asString(errorObject.code);
      errorMessage = asString(errorObject.message);
    } catch {
      errorCode = "";
      errorMessage = "";
    }

    if (response.status === 401 || errorCode === "invalid_issuer") {
      throw new Error(
        "OpenAI authentication failed (invalid issuer). Set OPENAI_API_KEY to a valid OpenAI Platform API key for this environment.",
      );
    }

    const details = errorMessage || errorBody;
    throw new Error(
      `OpenAI request failed status=${response.status} code=${errorCode || "unknown"} body=${details}`,
    );
  }

  const json = (await response.json()) as Record<string, unknown>;
  const outputText = extractStructuredOutputText(json);
  if (!outputText) {
    throw new Error("OpenAI response had no output text.");
  }

  return {
    parsed: JSON.parse(outputText) as Record<string, unknown>,
    usage: asObject(json.usage) as RefinementUsage,
  };
}

function buildAuditSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      accuracy_score: { type: "number" },
      retry_recommended: { type: "boolean" },
      issues: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            severity: { type: "string", enum: ["low", "medium", "high"] },
            field: { type: "string" },
            issue: { type: "string" },
            source_evidence: { type: "string" },
            correction_hint: { type: "string" },
          },
          required: [
            "severity",
            "field",
            "issue",
            "source_evidence",
            "correction_hint",
          ],
        },
      },
    },
    required: ["accuracy_score", "retry_recommended", "issues"],
  };
}

function cleanManagerReferences(
  text: string,
  adapterKey: string | null,
): string {
  if (!text.trim()) {
    return "";
  }

  const adapterToken = (adapterKey ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const adapterTokenSpaced = adapterToken
    .replace(/([0-9])([a-z])/g, "$1 $2")
    .replace(/([a-z])([0-9])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();

  const banned = [
    "30a collections",
    "30a escapes",
    "30aescapes",
    "property management",
    "management company",
    "book direct",
    "book with",
    "contact us",
    "call us",
    "visit our",
  ];

  if (adapterToken) {
    banned.push(adapterToken);
  }
  if (adapterTokenSpaced && adapterTokenSpaced !== adapterToken) {
    banned.push(adapterTokenSpaced);
  }

  const sentences = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((entry) => entry.trim())
    .filter(Boolean);

  const filtered = sentences.filter((sentence) => {
    const normalized = sentence
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, "")
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const compact = normalized.replace(/\s+/g, "");

    if (!normalized) {
      return false;
    }

    return !banned.some((token) => {
      if (!token) {
        return false;
      }

      const tokenNormalized = token
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const tokenCompact = tokenNormalized.replace(/\s+/g, "");

      return (
        normalized.includes(tokenNormalized) ||
        (tokenCompact.length > 0 && compact.includes(tokenCompact))
      );
    });
  });

  return filtered.join(" ").trim();
}

function ensureSeoTitleBranding(input: {
  title: string;
  canonicalName: string;
}): string {
  const baseTitle = input.title.trim() || input.canonicalName.trim();
  if (!baseTitle) {
    return SEO_BRAND_NAME;
  }

  if (/\b30a\s+collections\b/i.test(baseTitle)) {
    return baseTitle;
  }

  return `${baseTitle} | ${SEO_BRAND_NAME}`;
}

function ensureSeoBodyBranding(input: {
  text: string;
  canonicalName: string;
}): string {
  const fallback = `Discover ${input.canonicalName.trim() || "this property"} on ${SEO_BRAND_NAME}.`;
  const base = input.text.trim() || fallback;
  if (/\b30a\s+collections\b/i.test(base)) {
    return base;
  }

  const normalized = base.replace(/[\s.!?]+$/g, "");
  return `${normalized}. Available on ${SEO_BRAND_NAME}.`;
}

function ensureSeoMetaDescriptionIntent(input: {
  text: string;
  canonicalName: string;
}): string {
  const branded = ensureSeoBodyBranding(input);
  if (/\bvacation\s+rental\b/i.test(branded)) {
    return branded;
  }

  const normalized = branded.replace(/[\s.!?]+$/g, "");
  return `${normalized}. This vacation rental is available on ${SEO_BRAND_NAME}.`;
}

function normalizeHeadlinePlain(input: {
  headline: string;
  fallbackShort: string;
}): string {
  const cleaned = input.headline
    .replace(/[^a-zA-Z0-9\s'’-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const fallback = input.fallbackShort
    .replace(/[^a-zA-Z0-9\s'’-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const asWords = (value: string) =>
    value
      .split(/\s+/)
      .map((word) => word.trim())
      .filter(Boolean);

  const primaryWords = asWords(cleaned);
  if (primaryWords.length >= 2 && primaryWords.length <= 8) {
    return primaryWords.join(" ");
  }

  const fallbackWords = asWords(fallback);
  if (fallbackWords.length >= 2) {
    return fallbackWords.slice(0, 8).join(" ");
  }

  return primaryWords.slice(0, 8).join(" ");
}

function stripBrandReferencesFromList(
  values: string[],
  adapterKey: string | null,
  maxItems: number,
): string[] {
  return Array.from(
    new Set(
      values
        .map((entry) =>
          cleanManagerReferences(normalizeHintText(entry), adapterKey),
        )
        .map((entry) => normalizeHintText(entry))
        .filter(Boolean),
    ),
  ).slice(0, maxItems);
}

function buildSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      description_markdown: { type: "string" },
      description_headline_plain: { type: "string" },
      description_short_plain: { type: "string" },
      seo_meta_title: { type: "string" },
      seo_meta_description: { type: "string" },
      seo_hidden_summary_plain: { type: "string" },
      highlights: {
        type: "array",
        items: { type: "string" },
      },
      helpful_hints: {
        type: "array",
        items: { type: "string" },
      },
      amenities_normalized: {
        type: "array",
        items: {
          type: "string",
          enum: [...CANONICAL_AMENITY_IDS],
        },
      },
      amenities_evidence: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            amenity_id: {
              type: "string",
              enum: [...CANONICAL_AMENITY_IDS],
            },
            confidence_score: { type: "number" },
            evidence_snippets: {
              type: "array",
              items: { type: "string" },
            },
          },
          required: ["amenity_id", "confidence_score", "evidence_snippets"],
        },
      },
    },
    required: [
      "description_markdown",
      "description_headline_plain",
      "description_short_plain",
      "seo_meta_title",
      "seo_meta_description",
      "seo_hidden_summary_plain",
      "highlights",
      "helpful_hints",
      "amenities_normalized",
      "amenities_evidence",
    ],
  };
}

export async function loadListingRefinementSnapshot(input: {
  listingId?: string;
  slug?: string;
  externalListingId?: string;
}): Promise<ListingRefinementSnapshot | null> {
  if (!pgDb) {
    throw new Error("Postgres database is not configured.");
  }

  const identifier =
    input.listingId?.trim() ||
    input.slug?.trim() ||
    input.externalListingId?.trim();
  if (!identifier) {
    throw new Error("listingId, slug, or externalListingId is required.");
  }

  const whereClause = input.listingId
    ? eq(listing.id, input.listingId.trim())
    : input.slug
      ? eq(listing.slug, input.slug.trim())
      : eq(
          listing_source_link.external_listing_id,
          input.externalListingId!.trim(),
        );

  const rows = await pgDb
    .select({
      listingId: listing.id,
      slug: listing.slug,
      canonicalName: listing.canonical_name,
      propertyType: listing.property_type,
      bedrooms: listing.bedrooms,
      bathrooms: listing.bathrooms,
      sleeps: listing.sleeps,
      descriptionMarkdown: listing.description_markdown,
      descriptionHeadlinePlain: listing.description_headline_plain,
      descriptionShortPlain: listing.description_short_plain,
      seoMetaTitle: listing.seo_meta_title,
      seoMetaDescription: listing.seo_meta_description,
      seoHiddenSummaryPlain: listing.seo_hidden_summary_plain,
      highlights: listing.highlights,
      helpfulHints: listing.helpful_hints,
      sleepingArrangements: listing.sleeping_arrangements,
      amenitiesNormalized: listing.amenities_normalized,
      sourceLinkId: listing_source_link.id,
      adapterKey: listing_source_link.adapter_key,
      matchEvidence: listing_source_link.match_evidence,
    })
    .from(listing)
    .leftJoin(
      listing_source_link,
      and(
        eq(listing_source_link.listing_id, listing.id),
        eq(listing_source_link.is_primary_source, true),
        eq(listing_source_link.source_status, "active"),
        isNull(listing_source_link.active_to),
      ),
    )
    .where(whereClause)
    .limit(1);

  if (rows.length === 0) {
    return null;
  }

  const row = rows[0];
  const evidence = asObject(row.matchEvidence);
  const sourceSnapshot = asObject(evidence.source_snapshot);
  const aiRefinement = asObject(evidence.ai_refinement);

  const sourceDescriptionOriginal =
    asString(sourceSnapshot.description_expanded) ||
    asString(sourceSnapshot.meta_description) ||
    null;
  const sourceMetaDescriptionOriginal =
    asString(sourceSnapshot.meta_description) || null;
  const sourceAmenities = extractSourceAmenities(sourceSnapshot.amenities);

  return {
    listing_id: row.listingId,
    slug: row.slug,
    canonical_name: row.canonicalName,
    property_type: row.propertyType,
    bedrooms: row.bedrooms,
    bathrooms: row.bathrooms,
    sleeps: row.sleeps,
    adapter_key: row.adapterKey,
    source_content_hash: asString(evidence.source_content_hash) || null,
    source_description_original: sourceDescriptionOriginal,
    source_meta_description_original: sourceMetaDescriptionOriginal,
    source_amenities_original: sourceAmenities.all,
    source_amenities_categories: sourceAmenities.categories,
    description_markdown: row.descriptionMarkdown,
    description_headline_plain: row.descriptionHeadlinePlain,
    description_short_plain: row.descriptionShortPlain,
    seo_meta_title: row.seoMetaTitle,
    seo_meta_description: row.seoMetaDescription,
    seo_hidden_summary_plain: row.seoHiddenSummaryPlain,
    highlights: row.highlights,
    helpful_hints: row.helpfulHints,
    sleeping_arrangements: row.sleepingArrangements,
    amenities_normalized: row.amenitiesNormalized,
    ai_refinement: Object.keys(aiRefinement).length > 0 ? aiRefinement : null,
    source_link_id: row.sourceLinkId,
    match_evidence: evidence,
  };
}

export async function generateListingRefinement(input: {
  snapshot: ListingRefinementSnapshot;
  model?: string;
  rebuildHelpfulHints?: boolean;
}): Promise<RefinementResult> {
  const profileApiKey =
    resolveProfileEnvironment({
      profileValue: process.env.APP_ENV_PROFILE,
      processEnv: {
        APP_ENV_PROFILE: process.env.APP_ENV_PROFILE,
      },
    }).resolvedEnv.OPENAI_API_KEY?.trim() ?? "";
  const processApiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
  const apiKey = profileApiKey || processApiKey;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is missing.");
  }

  const model = (input.model?.trim() || DEFAULT_GENERATION_MODEL).trim();

  const sourceDescription = input.snapshot.source_description_original || "";
  const sourceMetaDescription =
    input.snapshot.source_meta_description_original || "";
  const sourceAmenities = input.snapshot.source_amenities_original;
  const sourceAmenitiesContext = buildAmenitiesContext({
    all: input.snapshot.source_amenities_original,
    categories: input.snapshot.source_amenities_categories,
  });

  if (
    !sourceDescription &&
    !sourceMetaDescription &&
    sourceAmenities.length === 0
  ) {
    throw new Error(
      "Source description/meta and amenities are empty; cannot refine.",
    );
  }

  const systemPrompt = [
    "You are refining vacation rental listing content for a premium 30A classifieds experience.",
    "Output only JSON matching the schema.",
    "Use strong factual discipline: reason through details internally, but never reveal chain-of-thought and never emit anything except valid JSON.",
    "Prioritize precision over flourish. Favor specific, source-grounded claims and avoid generic travel copy.",
    "Voice goals: enthusiastic, welcoming, polished, informative, and trustworthy.",
    "Write like you are selling an incredible vacation experience, not just describing real estate.",
    "description_markdown must feel personal, vivid, and emotionally engaging while remaining factual.",
    "Write directly to the reader in second person ('you' and 'your') where natural.",
    "Center the guest perspective: describe what the reader will feel, enjoy, and experience in the home.",
    "Avoid detached third-person brochure tone.",
    "Emphasize how families and friends gather, unwind, and make memories in the space.",
    "Focus on experiential outcomes (comfort, connection, celebration, ease) more than feature inventory.",
    "Do not lead with specs. Weave factual details into a guest-first narrative.",
    "When mentioning amenities, tie each one to how the reader will use and enjoy it.",
    "Keep copy warm, vivid, and aspirational, while remaining truthful to source facts.",
    "Avoid boilerplate language and repeated formulas across listings.",
    "Use at least two property-specific cues from source content in the narrative voice (for example courtyard flow, piano moments, carriage house privacy, walkability rhythm), and make those cues feel unique to the listing.",
    "Do not reuse stock opening patterns such as 'Discover <name>' as a default.",
    "Never start description_markdown with 'Discover' or with '<Property Name> is'.",
    "The first sentence of description_markdown must read as a lived guest moment, not an introduction line.",
    "Vary sentence rhythm, imagery, and paragraph openings so each listing reads personalized rather than templated.",
    "Use sensory and experiential language grounded in source facts (for example light, atmosphere, rhythm, gathering moments, ease, privacy).",
    "Avoid clinical or boilerplate phrasing. Do not write like a property spec sheet.",
    "Avoid formulaic sentence openers repeated across paragraphs (for example repeated 'Discover', 'Step outside', 'Inside').",
    "Vary cadence and sentence structure so each paragraph feels intentional and human.",
    "Preserve the listing personality and standout character while improving clarity and correctness.",
    "Fix typos, grammar issues, and run-on sentences; keep factual meaning intact.",
    "The authoritative source input fields are: source.h1, source.meta_description, source.description_expanded, source.amenities, and source.property_profile.",
    "Do not infer from page titles or branding artifacts.",
    "Respect listing.property_type as authoritative asset-type context and keep wording aligned with it.",
    "Do not describe the property as a different asset type than listing.property_type.",
    "description_markdown must be readable markdown: short paragraphs (1-3 sentences each), no wall-of-text blocks.",
    "description_markdown should open with an evocative lead paragraph before feature specifics.",
    "description_markdown should balance emotional narrative with concrete guest-relevant details.",
    "description_markdown should end with a warm, confidence-building closing tone rather than a checklist recap.",
    "description_headline_plain must be an emotional lead-in phrase that feels evocative, elegant, and coherent as a standalone headline.",
    "description_headline_plain must be 2 to 8 words, sentence case, and must not include punctuation at the end.",
    "description_headline_plain should be derived from source.description_expanded mood and standout experiences, without inventing facts.",
    "Do not force location into description_headline_plain. Include location only if it improves natural phrasing.",
    "description_headline_plain may include the exact property name once when it reads naturally, but avoid awkward noun stacking.",
    "Avoid template-like phrasing such as '<property name> in <location> ...' unless no better experiential phrasing is possible.",
    "Prefer concise experiential wording over geographic labeling for description_headline_plain.",
    "description_headline_plain should suggest the feeling of the stay, not summarize facts.",
    "Avoid repeating the same headline construction across listings; make phrasing distinct to the listing personality.",
    "description_markdown should only contain the experiential narrative prose (no 'What Makes It Special' or 'Helpful Hints' sections inside description_markdown).",
    "Do not misclassify the asset type. If a carriage house appears as an accessory feature, do not describe the entire rental as a carriage house or carriage home.",
    "Return highlights as a separate 'highlights' array (4-6 concise bullets).",
    "Return operational constraints as a separate 'helpful_hints' array (for example wristbands, age restrictions, amenity access requirements).",
    "Use concrete, guest-facing language about memorable moments, nearby context, and standout amenities.",
    "Prioritize differentiators guests care about when present: garage/parking capacity, game room, hot tub or spa, patio/balcony, community pool access, beach access, location cues, and home size.",
    "Do not invent facts not supported by source context.",
    "Do not include property management company references, booking brand names, website references, or calls-to-action.",
    "Keep description_markdown, description_short_plain, highlights, and helpful_hints property-centric and brand-agnostic.",
    "SEO fields must include the marketplace brand name '30A Collections' in natural wording.",
    "Create short, specific highlights that surface noteworthy attributes as scannable bullets.",
    "Do not use dashes in prose. Avoid em dash, en dash, or hyphenated style in generated copy.",
    "Normalize amenities to canonical amenity ids only.",
    "If uncertain on structured data, return conservative values (empty arrays or zero counts) rather than guessing.",
    input.rebuildHelpfulHints
      ? "Rebuild mode: helpful_hints must be complete standalone sentences, one operational policy per array entry, no concatenated fragments."
      : "",
  ].join(" ");

  const userPayload = {
    listing: {
      h1: input.snapshot.canonical_name,
      id: input.snapshot.listing_id,
      slug: input.snapshot.slug,
      canonical_name: input.snapshot.canonical_name,
      property_type: input.snapshot.property_type,
      bedrooms: input.snapshot.bedrooms,
      bathrooms: input.snapshot.bathrooms,
      sleeps: input.snapshot.sleeps,
      adapter_key: input.snapshot.adapter_key,
    },
    source: {
      h1: input.snapshot.canonical_name,
      meta_description: sourceMetaDescription,
      description_expanded: sourceDescription,
      amenities: sourceAmenitiesContext,
      property_profile: {
        property_type: input.snapshot.property_type,
        bedrooms: input.snapshot.bedrooms,
        bathrooms: input.snapshot.bathrooms,
        sleeps: input.snapshot.sleeps,
      },
    },
    canonical_amenity_ids: [...CANONICAL_AMENITY_IDS],
    refinement_mode: input.rebuildHelpfulHints
      ? "rebuild_helpful_hints"
      : "default",
  };

  const refinementResponse = await callStructuredOpenAi({
    apiKey,
    model,
    systemPrompt,
    userPayload,
    schemaName: "listing_refinement",
    schema: buildSchema(),
  });

  let parsed = refinementResponse.parsed as unknown as RefinementOutput;
  let refinementUsage = refinementResponse.usage;
  const usageByModel = new Map<string, ModelUsage>();
  pushModelUsage(usageByModel, model, refinementUsage);

  const cleanedMarkdown = cleanManagerReferences(
    asString(parsed.description_markdown),
    input.snapshot.adapter_key,
  );
  const cleanedHeadlineRaw = cleanManagerReferences(
    asString(parsed.description_headline_plain),
    input.snapshot.adapter_key,
  );
  const cleanedShortRaw = cleanManagerReferences(
    asString(parsed.description_short_plain),
    input.snapshot.adapter_key,
  );
  const cleanedShort = normalizeHumanProse(cleanedShortRaw);
  const cleanedHeadline = normalizeHeadlinePlain({
    headline: normalizeHumanProse(cleanedHeadlineRaw),
    fallbackShort: cleanedShort,
  });
  const cleanedSeoMetaDescription = normalizeHumanProse(
    cleanManagerReferences(
      asString(parsed.seo_meta_description),
      input.snapshot.adapter_key,
    ),
  );
  const cleanedSeoHiddenSummary = normalizeHumanProse(
    cleanManagerReferences(
      asString(parsed.seo_hidden_summary_plain),
      input.snapshot.adapter_key,
    ),
  );

  const highlights = stripBrandReferencesFromList(
    sanitizeHighlights((parsed as Record<string, unknown>).highlights),
    input.snapshot.adapter_key,
    8,
  )
    .map((entry) => normalizeHumanProse(entry))
    .filter(Boolean);
  const helpfulHintsFromModel = stripBrandReferencesFromList(
    sanitizeHelpfulHints((parsed as Record<string, unknown>).helpful_hints),
    input.snapshot.adapter_key,
    6,
  );
  const helpfulHintsFromSource = stripBrandReferencesFromList(
    extractHelpfulNotes(sourceDescription),
    input.snapshot.adapter_key,
    6,
  );
  const helpfulHintsMerged = Array.from(
    new Set([...helpfulHintsFromModel, ...helpfulHintsFromSource]),
  );
  const helpfulHints = finalizeHelpfulHintCandidates(helpfulHintsMerged).slice(
    0,
    6,
  );
  const amenitiesFromModel = sanitizeAmenities(
    asStringArray(parsed.amenities_normalized),
  );
  const sourceAmenitySignals = deriveAmenitiesFromSource(
    input.snapshot.source_amenities_original,
  );
  const mergedAmenities = Array.from(
    new Set([...amenitiesFromModel, ...sourceAmenitySignals.ids]),
  ).sort((a, b) => a.localeCompare(b));
  const mergedAmenityEvidence = mergeAmenityEvidence(
    sanitizeAmenitiesEvidence(
      (parsed as Record<string, unknown>).amenities_evidence,
    ),
    sourceAmenitySignals.evidence,
  );

  const formattedMarkdown = formatDescriptionMarkdown({
    markdown: cleanedMarkdown,
    sourceDescription,
    canonicalName: input.snapshot.canonical_name,
    propertyType: input.snapshot.property_type,
    bedrooms: input.snapshot.bedrooms,
  });

  const snapshotNormalizedSleeping = normalizeSleepingArrangements(
    input.snapshot.sleeping_arrangements,
  );
  const snapshotNormalizedRollups = normalizeSleepingRollups(
    deriveSleepingRollupsFromArrangements(
      snapshotNormalizedSleeping,
      input.snapshot.sleeps,
    ),
    input.snapshot.sleeps,
  );

  let resolvedSleepingArrangements = snapshotNormalizedSleeping;
  let resolvedSleepingRollups = snapshotNormalizedRollups;

  try {
    const sleepResolution = await resolveSleepWithModel({
      apiKey,
      sourceDescription,
      bedrooms: input.snapshot.bedrooms,
      bathrooms: input.snapshot.bathrooms,
      sleeps: input.snapshot.sleeps,
    });

    pushModelUsage(
      usageByModel,
      DEFAULT_SLEEP_RESOLUTION_MODEL,
      sleepResolution.usage,
    );
    refinementUsage = mergeUsage([refinementUsage, sleepResolution.usage]);

    resolvedSleepingArrangements = sleepResolution.result.arrangements;
    resolvedSleepingRollups = hasMeaningfulSleepingRollups(
      sleepResolution.result.rollups,
    )
      ? sleepResolution.result.rollups
      : snapshotNormalizedRollups;
  } catch {
    // Keep snapshot-derived sleep state and rely on deterministic reconciliation below.
  }

  const finalizedSleeping = finalizeSleepingOutput({
    arrangements: resolvedSleepingArrangements,
    rollups: resolvedSleepingRollups,
    fallbackRollups: snapshotNormalizedRollups,
    expectedSleeps: input.snapshot.sleeps,
  });

  let output: RefinementOutput = {
    description_markdown: formattedMarkdown,
    description_headline_plain: cleanedHeadline,
    description_short_plain: cleanedShort,
    seo_meta_title: ensureSeoTitleBranding({
      title: asString(parsed.seo_meta_title),
      canonicalName: input.snapshot.canonical_name,
    }),
    seo_meta_description: ensureSeoBodyBranding({
      text: cleanedSeoMetaDescription,
      canonicalName: input.snapshot.canonical_name,
    }),
    seo_hidden_summary_plain: ensureSeoBodyBranding({
      text: cleanedSeoHiddenSummary,
      canonicalName: input.snapshot.canonical_name,
    }),
    highlights,
    helpful_hints: helpfulHints,
    sleeping_arrangements: finalizedSleeping.arrangements,
    sleeping_summary: finalizedSleeping.summary,
    amenities_normalized: mergedAmenities,
    amenities_evidence: mergedAmenityEvidence,
  };

  output.seo_meta_description = ensureSeoMetaDescriptionIntent({
    text: cleanedSeoMetaDescription,
    canonicalName: input.snapshot.canonical_name,
  });

  const auditTriggerReasons = determineAuditTriggerReasons({
    output,
    snapshot: input.snapshot,
  });
  const shouldRunAuditPass = FORCE_AUDIT || auditTriggerReasons.length > 0;
  const auditDecision: RefinementAuditDecision = shouldRunAuditPass
    ? {
        performed: true,
        trigger_reasons: FORCE_AUDIT
          ? [
              "Audit forced via LISTING_REFINEMENT_FORCE_AUDIT=1.",
              ...auditTriggerReasons,
            ]
          : auditTriggerReasons,
        skipped_reason: null,
      }
    : {
        performed: false,
        trigger_reasons: [],
        skipped_reason: "No deterministic audit triggers detected.",
      };

  const auditPrompt = [
    "You are a factual consistency auditor for vacation rental content.",
    "Compare source facts against candidate generated output.",
    "Flag only factual mismatches, overstatements, or misleading wording.",
    "Be strict about primary asset type wording, occupancy, policy constraints, and amenity claims.",
    "Be strict about sleeping capacity consistency: candidate_output.sleeping_summary and candidate_output.sleeping_arrangements must align with listing.sleeps.",
    "Capacity rules: king=2, queen=2, full=2, twin=1, daybed=1, trundle=1, air_mattress=1, sofa_bed=2, murphy=2, futon=2.",
    "For bunk configurations: twin_over_twin=2 sleeps, twin_over_full=3 sleeps, full_over_full=4 sleeps, queen_over_queen=4 sleeps, twin_over_queen=3 sleeps, twin_over_king=3 sleeps.",
    "If output is mostly accurate, keep issue list short.",
    "Return JSON only matching schema.",
  ].join(" ");

  let audit: RefinementAudit | null = null;
  let auditUsage: RefinementUsage | null = null;

  if (shouldRunAuditPass) {
    try {
      const auditResponse = await callStructuredOpenAi({
        apiKey,
        model: DEFAULT_AUDIT_MODEL,
        systemPrompt: auditPrompt,
        userPayload: {
          listing: {
            id: input.snapshot.listing_id,
            canonical_name: input.snapshot.canonical_name,
            property_type: input.snapshot.property_type,
            bedrooms: input.snapshot.bedrooms,
            bathrooms: input.snapshot.bathrooms,
            sleeps: input.snapshot.sleeps,
          },
          source: {
            h1: input.snapshot.canonical_name,
            meta_description: sourceMetaDescription,
            description_expanded: sourceDescription,
            amenities: sourceAmenitiesContext,
            property_profile: {
              property_type: input.snapshot.property_type,
              bedrooms: input.snapshot.bedrooms,
              bathrooms: input.snapshot.bathrooms,
              sleeps: input.snapshot.sleeps,
            },
          },
          candidate_output: output,
        },
        schemaName: "listing_refinement_audit",
        schema: buildAuditSchema(),
      });

      auditUsage = auditResponse.usage;
      pushModelUsage(usageByModel, DEFAULT_AUDIT_MODEL, auditUsage);
      const auditParsed = auditResponse.parsed;
      const accuracyRaw = (auditParsed.accuracy_score as number) ?? 0;
      let accuracy =
        typeof accuracyRaw === "number" && Number.isFinite(accuracyRaw)
          ? Math.max(0, Math.min(1, accuracyRaw))
          : 0;
      let retryRecommended = Boolean(auditParsed.retry_recommended);
      const issues = sanitizeAuditIssues(auditParsed.issues);

      const expectedSleeps = getExpectedSleeps(input.snapshot.sleeps);
      if (expectedSleeps !== null) {
        const outputSleepRollups = deriveSleepRollupsFromOutput({
          output,
          expectedSleeps,
        });
        const derivedCapacity =
          estimateSleepCapacityFromRollups(outputSleepRollups);
        if (derivedCapacity !== expectedSleeps) {
          issues.unshift({
            severity: "high",
            field: "sleeping_summary",
            issue: `Derived sleep capacity ${derivedCapacity} does not match listing sleeps ${expectedSleeps}.`,
            source_evidence: `listing.sleeps=${expectedSleeps}; derived_from_rollups=${derivedCapacity}`,
            correction_hint:
              "Correct sleeping_arrangements and sleeping_summary so bed counts and bunk configurations produce the exact listing.sleeps value.",
          });
          retryRecommended = true;
          accuracy = Math.min(accuracy, 0.5);
        }
      }

      audit = {
        accuracy_score: accuracy,
        retry_recommended: retryRecommended,
        issues,
        retry_performed: false,
      };

      const shouldRetry =
        retryRecommended &&
        accuracy < AUDIT_MIN_ACCURACY_SCORE &&
        issues.length > 0;

      if (shouldRetry) {
        const correctionGuidance = issues
          .map(
            (issue, index) =>
              `${index + 1}. Field=${issue.field}; Issue=${issue.issue}; Evidence=${issue.source_evidence}; Fix=${issue.correction_hint}`,
          )
          .join("\n");

        const retrySystemPrompt = `${systemPrompt} Apply these correction constraints strictly:\n${correctionGuidance}`;

        const retryResponse = await callStructuredOpenAi({
          apiKey,
          model,
          systemPrompt: retrySystemPrompt,
          userPayload,
          schemaName: "listing_refinement_retry",
          schema: buildSchema(),
        });

        refinementUsage = mergeUsage([refinementUsage, retryResponse.usage]);
        pushModelUsage(usageByModel, model, retryResponse.usage);
        parsed = retryResponse.parsed as unknown as RefinementOutput;

        const retryMarkdownRaw = cleanManagerReferences(
          asString(parsed.description_markdown),
          input.snapshot.adapter_key,
        );
        const retryHeadlineRaw = cleanManagerReferences(
          asString(parsed.description_headline_plain),
          input.snapshot.adapter_key,
        );
        const retryShort = normalizeHumanProse(
          cleanManagerReferences(
            asString(parsed.description_short_plain),
            input.snapshot.adapter_key,
          ),
        );
        const retryHeadline = normalizeHeadlinePlain({
          headline: normalizeHumanProse(retryHeadlineRaw),
          fallbackShort: retryShort,
        });
        const retrySeoDescription = normalizeHumanProse(
          cleanManagerReferences(
            asString(parsed.seo_meta_description),
            input.snapshot.adapter_key,
          ),
        );
        const retrySeoHidden = normalizeHumanProse(
          cleanManagerReferences(
            asString(parsed.seo_hidden_summary_plain),
            input.snapshot.adapter_key,
          ),
        );

        const retryHighlights = stripBrandReferencesFromList(
          sanitizeHighlights((parsed as Record<string, unknown>).highlights),
          input.snapshot.adapter_key,
          8,
        )
          .map((entry) => normalizeHumanProse(entry))
          .filter(Boolean);
        const retryHintsModel = stripBrandReferencesFromList(
          sanitizeHelpfulHints(
            (parsed as Record<string, unknown>).helpful_hints,
          ),
          input.snapshot.adapter_key,
          6,
        );
        const retryHintsMerged = Array.from(
          new Set([...retryHintsModel, ...helpfulHintsFromSource]),
        );
        const retryHints = finalizeHelpfulHintCandidates(
          retryHintsMerged,
        ).slice(0, 6);
        const retryAmenitiesModel = sanitizeAmenities(
          asStringArray(parsed.amenities_normalized),
        );
        const retryMergedAmenities = Array.from(
          new Set([...retryAmenitiesModel, ...sourceAmenitySignals.ids]),
        ).sort((a, b) => a.localeCompare(b));
        const retryMergedEvidence = mergeAmenityEvidence(
          sanitizeAmenitiesEvidence(
            (parsed as Record<string, unknown>).amenities_evidence,
          ),
          sourceAmenitySignals.evidence,
        );

        output = {
          description_markdown: formatDescriptionMarkdown({
            markdown: retryMarkdownRaw,
            sourceDescription,
            canonicalName: input.snapshot.canonical_name,
            propertyType: input.snapshot.property_type,
            bedrooms: input.snapshot.bedrooms,
          }),
          description_headline_plain: retryHeadline,
          description_short_plain: retryShort,
          seo_meta_title: ensureSeoTitleBranding({
            title: asString(parsed.seo_meta_title),
            canonicalName: input.snapshot.canonical_name,
          }),
          seo_meta_description: ensureSeoBodyBranding({
            text: retrySeoDescription,
            canonicalName: input.snapshot.canonical_name,
          }),
          seo_hidden_summary_plain: ensureSeoBodyBranding({
            text: retrySeoHidden,
            canonicalName: input.snapshot.canonical_name,
          }),
          highlights: retryHighlights,
          helpful_hints: retryHints,
          sleeping_arrangements: output.sleeping_arrangements,
          sleeping_summary: output.sleeping_summary,
          amenities_normalized: retryMergedAmenities,
          amenities_evidence: retryMergedEvidence,
        };

        output.seo_meta_description = ensureSeoMetaDescriptionIntent({
          text: retrySeoDescription,
          canonicalName: input.snapshot.canonical_name,
        });

        audit.retry_performed = true;

        const hasSleepRelatedIssue = issues.some(
          (issue) => /sleep/i.test(issue.field) || /sleep/i.test(issue.issue),
        );
        const postRetryRollups = deriveSleepRollupsFromOutput({
          output,
          expectedSleeps,
        });
        const postRetrySleepMatch = evaluateSleepCapacityMatch({
          rollups: postRetryRollups,
          expectedSleeps,
        });

        if (
          expectedSleeps !== null &&
          (hasSleepRelatedIssue || !postRetrySleepMatch.matches)
        ) {
          try {
            const sleepResolution = await resolveSleepWithModel({
              apiKey,
              sourceDescription,
              bedrooms: input.snapshot.bedrooms,
              bathrooms: input.snapshot.bathrooms,
              sleeps: input.snapshot.sleeps,
            });

            pushModelUsage(
              usageByModel,
              DEFAULT_SLEEP_RESOLUTION_MODEL,
              sleepResolution.usage,
            );
            refinementUsage = mergeUsage([
              refinementUsage,
              sleepResolution.usage,
            ]);

            const finalizedRetrySleeping = finalizeSleepingOutput({
              arrangements: sleepResolution.result.arrangements,
              rollups: sleepResolution.result.rollups,
              fallbackRollups: postRetryRollups,
              expectedSleeps: input.snapshot.sleeps,
            });

            output.sleeping_arrangements = finalizedRetrySleeping.arrangements;
            output.sleeping_summary = finalizedRetrySleeping.summary;
          } catch {
            // Keep existing retry output and fall through to deterministic reconciliation checks.
          }
        }

        const finalOutputRollups = deriveSleepRollupsFromOutput({
          output,
          expectedSleeps,
        });
        const finalSleepMatch = evaluateSleepCapacityMatch({
          rollups: finalOutputRollups,
          expectedSleeps,
        });
        const finalSleepAcceptable = isSleepAccommodationAcceptable({
          match: finalSleepMatch,
          rollups: finalOutputRollups,
        });
        const isSleepIssue = (issue: RefinementAuditIssue): boolean =>
          /sleep/i.test(issue.field) || /sleep/i.test(issue.issue);

        if (finalSleepAcceptable) {
          audit.issues = audit.issues.filter((issue) => !isSleepIssue(issue));
          if (audit.issues.length === 0) {
            audit.retry_recommended = false;
            audit.accuracy_score = Math.max(
              audit.accuracy_score,
              AUDIT_MIN_ACCURACY_SCORE,
            );
          }
        } else {
          const hasCapacityIssue = audit.issues.some(
            (issue) =>
              isSleepIssue(issue) &&
              /sleep capacity|listing sleeps|derived sleep capacity/i.test(
                issue.issue,
              ),
          );
          if (!hasCapacityIssue && finalSleepMatch.target !== null) {
            audit.issues.unshift({
              severity: "high",
              field: "sleeping_summary",
              issue: `Derived sleep capacity ${finalSleepMatch.derived} does not match listing sleeps ${finalSleepMatch.target}.`,
              source_evidence: `listing.sleeps=${finalSleepMatch.target}; derived_from_rollups=${finalSleepMatch.derived}`,
              correction_hint:
                "Correct sleeping_arrangements and sleeping_summary so bed counts and bunk configurations produce the exact listing.sleeps value.",
            });
          }
          audit.retry_recommended = true;
          audit.accuracy_score = Math.min(audit.accuracy_score, 0.5);
        }
      }
    } catch {
      audit = null;
    }
  }

  return {
    model,
    audit_model: DEFAULT_AUDIT_MODEL,
    prompt_version: PROMPT_VERSION,
    output,
    usage: mergeUsage([refinementUsage, auditUsage]),
    usage_by_model: Array.from(usageByModel.values()),
    audit,
    audit_decision: auditDecision,
  };
}

export async function persistListingRefinement(input: {
  snapshot: ListingRefinementSnapshot;
  result: RefinementResult;
}): Promise<void> {
  if (!pgDb) {
    throw new Error("Postgres database is not configured.");
  }

  const now = new Date().toISOString();
  const outputPayload = input.result.output as Record<string, unknown>;
  const usagePayload = {
    ...(input.result.usage ?? {}),
    usage_by_model: input.result.usage_by_model,
  } as Record<string, unknown>;
  const auditInvoked = Boolean(input.result.audit_decision.performed);
  const auditInvokedModel = auditInvoked ? input.result.audit_model : null;
  const auditCallStatus = !auditInvoked
    ? "skipped"
    : input.result.audit
      ? "succeeded"
      : "failed_or_unparsed";
  const auditScore =
    typeof input.result.audit?.accuracy_score === "number"
      ? input.result.audit.accuracy_score
      : null;
  const outputSleepRollups = deriveSleepRollupsFromOutput({
    output: input.result.output,
    expectedSleeps: input.snapshot.sleeps,
  });
  const sleepCapacityMatch = evaluateSleepCapacityMatch({
    rollups: outputSleepRollups,
    expectedSleeps: input.snapshot.sleeps,
  });
  const sleepEnvironmentPresent =
    hasMeaningfulSleepEnvironment(outputSleepRollups);
  const sleepTolerancePass = isSleepAccommodationAcceptable({
    match: sleepCapacityMatch,
    rollups: outputSleepRollups,
  });
  const auditPassed = !auditInvoked
    ? sleepTolerancePass
    : auditCallStatus === "succeeded" &&
      auditScore !== null &&
      auditScore >= AUDIT_MIN_ACCURACY_SCORE &&
      !input.result.audit?.retry_recommended &&
      sleepTolerancePass;
  const auditPayload = {
    audit: input.result.audit,
    audit_decision: input.result.audit_decision,
    audit_invoked: auditInvoked,
    audit_invoked_model: auditInvokedModel,
    audit_call_status: auditCallStatus,
    audit_score: auditScore,
    deterministic_sleep_capacity_from_rollups: sleepCapacityMatch.derived,
    deterministic_sleep_capacity_target: sleepCapacityMatch.target,
    deterministic_sleep_capacity_delta: sleepCapacityMatch.delta,
    deterministic_sleep_capacity_match: sleepCapacityMatch.matches,
    deterministic_sleep_environment_present: sleepEnvironmentPresent,
    deterministic_sleep_capacity_tolerance_pass: sleepTolerancePass,
    audit_passed: auditPassed,
  } as Record<string, unknown>;
  const costUsd = estimateRunCostUsd({
    usageByModel: input.result.usage_by_model,
    fallbackModel: input.result.model,
    fallbackUsage: input.result.usage,
  });
  const sourceSnapshotPayload = asObject(
    input.snapshot.match_evidence,
  ).source_snapshot;
  const sourceHash =
    (input.snapshot.source_content_hash ?? "no_source_hash").trim() ||
    "no_source_hash";
  const outputHash = createHash("sha256")
    .update(JSON.stringify(outputPayload))
    .digest("hex");

  await pgDb
    .insert(listing_ai_enrichment)
    .values({
      id: `lae_${randomUUID().replace(/-/g, "")}`,
      listing_id: input.snapshot.listing_id,
      source_link_id: input.snapshot.source_link_id,
      adapter_key: input.snapshot.adapter_key,
      source_content_hash: sourceHash,
      status: "completed",
      model: input.result.model,
      audit_model: input.result.audit_model,
      prompt_version: input.result.prompt_version,
      output_hash: outputHash,
      source_snapshot_payload:
        sourceSnapshotPayload && typeof sourceSnapshotPayload === "object"
          ? sourceSnapshotPayload
          : {},
      output_payload: outputPayload,
      usage_payload: usagePayload,
      cost_usd: costUsd,
      audit_payload: auditPayload,
      generated_at: now,
      applied_at: null,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: [
        listing_ai_enrichment.listing_id,
        listing_ai_enrichment.source_content_hash,
        listing_ai_enrichment.prompt_version,
      ],
      set: {
        source_link_id: input.snapshot.source_link_id,
        adapter_key: input.snapshot.adapter_key,
        status: "completed",
        model: input.result.model,
        audit_model: input.result.audit_model,
        output_hash: outputHash,
        source_snapshot_payload:
          sourceSnapshotPayload && typeof sourceSnapshotPayload === "object"
            ? sourceSnapshotPayload
            : {},
        output_payload: outputPayload,
        usage_payload: usagePayload,
        cost_usd: costUsd,
        audit_payload: auditPayload,
        generated_at: now,
        applied_at: null,
        updated_at: now,
      },
    });
}
