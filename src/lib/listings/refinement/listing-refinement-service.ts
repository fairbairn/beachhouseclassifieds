import "@/core/tooling/env/load-env-profile";

import { createHash, randomUUID } from "node:crypto";

import { and, eq, isNull } from "drizzle-orm";

import { pgDb } from "@/core/server/db";
import { resolveProfileEnvironment } from "@/core/tooling/env/profile-env";
import {
  listing,
  listing_ai_refinement_cache,
  listing_source_link,
} from "@/lib/db/schema-postgres";
import { sleeping_arrangements_schema } from "@/lib/listings/canonical/contracts";

type RefinementOutput = {
  description_markdown: string;
  description_short_plain: string;
  seo_meta_title: string;
  seo_meta_description: string;
  seo_hidden_summary_plain: string;
  highlights: string[];
  helpful_hints: string[];
  sleeping_arrangements: unknown;
  sleeping_rollups: Record<string, number>;
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
  source_amenities_original: string[];
  source_amenities_categories: Record<string, string[]>;
  description_markdown: string | null;
  description_short_plain: string | null;
  seo_meta_title: string | null;
  seo_meta_description: string | null;
  seo_hidden_summary_plain: string | null;
  sleeping_arrangements: unknown;
  amenities_normalized: unknown;
  ai_refinement: Record<string, unknown> | null;
  source_link_id: string | null;
  match_evidence: Record<string, unknown>;
};

export type RefinementResult = {
  model: string;
  prompt_version: string;
  output: RefinementOutput;
  usage: RefinementUsage | null;
  audit: RefinementAudit | null;
};

const PROMPT_VERSION = "v3";
const AUDIT_MIN_ACCURACY_SCORE = 0.9;

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
  const totals = usageValues.reduce(
    (acc, usage) => {
      acc.input_tokens += usage?.input_tokens ?? 0;
      acc.output_tokens += usage?.output_tokens ?? 0;
      acc.total_tokens += usage?.total_tokens ?? 0;
      return acc;
    },
    { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  );

  if (
    totals.input_tokens === 0 &&
    totals.output_tokens === 0 &&
    totals.total_tokens === 0
  ) {
    return null;
  }

  return totals;
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

  const categories = Object.fromEntries(
    Object.entries(categoriesRaw)
      .map(([key, categoryValue]) => [
        key,
        dedupe(asStringArray(categoryValue), 80),
      ])
      .filter(([, entries]) => entries.length > 0),
  );

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
      ? `${input.bedrooms}-bedroom `
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

  const sentenceCandidates = splitIntoSentences(normalized);
  const lineCandidates = normalized
    .split(/\n+/)
    .flatMap((line) => line.split(/\s+-\s+/))
    .map((entry) => entry.trim())
    .filter(Boolean);

  const candidates = [...sentenceCandidates, ...lineCandidates]
    .map((entry) =>
      entry
        .replace(/^home\s+highlights\s*:?\s*/i, "")
        .replace(/^features\s*:?\s*/i, "")
        .trim(),
    )
    .filter(Boolean);

  return Array.from(
    new Set(
      candidates.filter(
        (candidate) =>
          isOperationalHintText(candidate) &&
          !isRepetitiveFeatureRecap(candidate),
      ),
    ),
  ).slice(0, 4);
}

function sanitizeHelpfulHints(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  const splitCandidates = values.flatMap((entry) => {
    if (typeof entry !== "string") {
      return [];
    }

    return entry
      .split(/(?=Please note:|If this policy is violated|Per WaterColor HOA)/i)
      .map((part) => normalizeHintText(part))
      .filter(Boolean);
  });

  const filtered = splitCandidates.filter(
    (candidate) =>
      isOperationalHintText(candidate) && !isRepetitiveFeatureRecap(candidate),
  );

  return Array.from(new Set(filtered)).slice(0, 6);
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
      const sentences = splitIntoSentences(paragraph).filter(
        (sentence) => !isOperationalHintText(sentence),
      );
      return sentences.join(" ").trim();
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

  const leadSentence = buildDeterministicLeadSentence({
    canonicalName: input.canonicalName,
    propertyType: input.propertyType,
    bedrooms: input.bedrooms,
    sourceDescription: input.sourceDescription,
  });

  const firstParagraphSentences = splitIntoSentences(cleanedParagraphs[0]);
  const remainder = firstParagraphSentences.slice(1);
  cleanedParagraphs[0] = [leadSentence, ...remainder].join(" ").trim();

  return cleanedParagraphs.join("\n\n");
}

function normalizeSleepingRollups(value: unknown): Record<string, number> {
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
  ];

  const output: Record<string, number> = {};
  for (const key of keys) {
    const raw = input[key];
    const numeric = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
    output[key] = Math.max(0, Math.round(numeric));
  }

  return output;
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

function extractOutputText(response: Record<string, unknown>): string {
  const top = asString(response.output_text);
  if (top) {
    return top;
  }

  const output = response.output;
  if (!Array.isArray(output)) {
    return "";
  }

  for (const item of output) {
    const objectItem = asObject(item);
    const content = objectItem.content;
    if (!Array.isArray(content)) {
      continue;
    }

    for (const contentItem of content) {
      const objectContent = asObject(contentItem);
      const text = asString(objectContent.text);
      if (text) {
        return text;
      }
    }
  }

  return "";
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
  const outputText = extractOutputText(json);
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

  const banned = [
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

    if (!normalized) {
      return false;
    }

    return !banned.some((token) => token && normalized.includes(token));
  });

  return filtered.join(" ").trim();
}

function buildSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      description_markdown: { type: "string" },
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
      sleeping_arrangements: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            room_label: { type: "string" },
            room_role: {
              type: "string",
              enum: [
                "primary",
                "guest",
                "bunk_room",
                "loft",
                "hall",
                "living_area",
                "other",
              ],
            },
            sleeps: { type: ["number", "null"] },
            beds: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  bed_type: {
                    type: "string",
                    enum: [
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
                    ],
                  },
                  count: { type: "number" },
                  bunk_configuration: {
                    type: ["string", "null"],
                    enum: [
                      "twin_over_twin",
                      "twin_over_full",
                      "full_over_full",
                      "queen_over_queen",
                      "twin_over_queen",
                      "twin_over_king",
                      "other",
                      null,
                    ],
                  },
                  notes: { type: ["string", "null"] },
                },
                required: ["bed_type", "count", "bunk_configuration", "notes"],
              },
            },
            notes: { type: ["string", "null"] },
          },
          required: ["room_label", "room_role", "sleeps", "beds", "notes"],
        },
      },
      sleeping_rollups: {
        type: "object",
        additionalProperties: false,
        properties: {
          bed_count_king: { type: "number" },
          bed_count_queen: { type: "number" },
          bed_count_full: { type: "number" },
          bed_count_twin: { type: "number" },
          bed_count_bunk_total: { type: "number" },
          bed_count_sofa_bed: { type: "number" },
          bed_count_daybed: { type: "number" },
          bed_count_trundle: { type: "number" },
          bed_count_murphy: { type: "number" },
          bed_count_air_mattress: { type: "number" },
          bed_count_futon: { type: "number" },
        },
        required: [
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
        ],
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
      "description_short_plain",
      "seo_meta_title",
      "seo_meta_description",
      "seo_hidden_summary_plain",
      "highlights",
      "helpful_hints",
      "sleeping_arrangements",
      "sleeping_rollups",
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
      descriptionShortPlain: listing.description_short_plain,
      seoMetaTitle: listing.seo_meta_title,
      seoMetaDescription: listing.seo_meta_description,
      seoHiddenSummaryPlain: listing.seo_hidden_summary_plain,
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
    source_amenities_original: sourceAmenities.all,
    source_amenities_categories: sourceAmenities.categories,
    description_markdown: row.descriptionMarkdown,
    description_short_plain: row.descriptionShortPlain,
    seo_meta_title: row.seoMetaTitle,
    seo_meta_description: row.seoMetaDescription,
    seo_hidden_summary_plain: row.seoHiddenSummaryPlain,
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

  const model = (input.model?.trim() || "gpt-4.1-mini").trim();

  const sourceDescription = input.snapshot.source_description_original || "";
  const sourceAmenities = input.snapshot.source_amenities_original;

  if (!sourceDescription && sourceAmenities.length === 0) {
    throw new Error(
      "Source description and amenities are empty; cannot refine.",
    );
  }

  const systemPrompt = [
    "You are refining vacation rental listing content for a premium 30A classifieds experience.",
    "Output only JSON matching the schema.",
    "Voice goals: enthusiastic, welcoming, polished, informative, and trustworthy.",
    "Write like you are selling an incredible vacation experience, not just describing real estate.",
    "Preserve the listing personality and standout character while improving clarity and correctness.",
    "Fix typos, grammar issues, and run-on sentences; keep factual meaning intact.",
    "Respect listing.property_type as authoritative asset-type context and keep wording aligned with it.",
    "Do not describe the property as a different asset type than listing.property_type.",
    "description_markdown must be readable markdown: short paragraphs (1-3 sentences each), no wall-of-text blocks.",
    "description_markdown should only contain the experiential narrative prose (no 'What Makes It Special' or 'Helpful Hints' sections inside description_markdown).",
    "Do not misclassify the asset type. If a carriage house appears as an accessory feature, do not describe the entire rental as a carriage house or carriage home.",
    "Return highlights as a separate 'highlights' array (4-6 concise bullets).",
    "Return operational constraints as a separate 'helpful_hints' array (for example wristbands, age restrictions, amenity access requirements).",
    "Use concrete, guest-facing language about memorable moments, nearby context, and standout amenities.",
    "Prioritize differentiators guests care about when present: garage/parking capacity, game room, hot tub or spa, patio/balcony, community pool access, beach access, location cues, and home size.",
    "Do not invent facts not supported by source context.",
    "Do not include property management company references, booking brand names, website references, or calls-to-action.",
    "Create short, specific highlights that surface noteworthy attributes as scannable bullets.",
    "Normalize amenities to canonical amenity ids only.",
    "Extract sleeping arrangements with room-level precision and bed-type counts.",
    "If uncertain on structured data, return conservative values (empty arrays or zero counts) rather than guessing.",
  ].join(" ");

  const userPayload = {
    listing: {
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
      title: input.snapshot.canonical_name,
      description_original: sourceDescription,
      amenities_original: sourceAmenities,
      amenities_categories: input.snapshot.source_amenities_categories,
      instructional_notes_candidates: extractHelpfulNotes(sourceDescription),
      known_sleeping_arrangements: input.snapshot.sleeping_arrangements,
      known_amenities_normalized: input.snapshot.amenities_normalized,
    },
    canonical_amenity_ids: [...CANONICAL_AMENITY_IDS],
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
  const validatedSleeping = sleeping_arrangements_schema.safeParse(
    parsed.sleeping_arrangements,
  );

  const cleanedMarkdown = cleanManagerReferences(
    asString(parsed.description_markdown),
    input.snapshot.adapter_key,
  );
  const cleanedShort = cleanManagerReferences(
    asString(parsed.description_short_plain),
    input.snapshot.adapter_key,
  );
  const cleanedSeoMetaDescription = cleanManagerReferences(
    asString(parsed.seo_meta_description),
    input.snapshot.adapter_key,
  );
  const cleanedSeoHiddenSummary = cleanManagerReferences(
    asString(parsed.seo_hidden_summary_plain),
    input.snapshot.adapter_key,
  );

  const highlights = sanitizeHighlights(
    (parsed as Record<string, unknown>).highlights,
  );
  const helpfulHintsFromModel = sanitizeHelpfulHints(
    (parsed as Record<string, unknown>).helpful_hints,
  );
  const helpfulHintsFromSource = extractHelpfulNotes(sourceDescription);
  const helpfulHints = Array.from(
    new Set([...helpfulHintsFromModel, ...helpfulHintsFromSource]),
  ).slice(0, 6);
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

  let output: RefinementOutput = {
    description_markdown: formattedMarkdown,
    description_short_plain: cleanedShort,
    seo_meta_title: asString(parsed.seo_meta_title),
    seo_meta_description: cleanedSeoMetaDescription,
    seo_hidden_summary_plain: cleanedSeoHiddenSummary,
    highlights,
    helpful_hints: helpfulHints,
    sleeping_arrangements: validatedSleeping.success
      ? validatedSleeping.data
      : [],
    sleeping_rollups: normalizeSleepingRollups(
      (parsed as Record<string, unknown>).sleeping_rollups,
    ),
    amenities_normalized: mergedAmenities,
    amenities_evidence: mergedAmenityEvidence,
  };

  const auditPrompt = [
    "You are a factual consistency auditor for vacation rental content.",
    "Compare source facts against candidate generated output.",
    "Flag only factual mismatches, overstatements, or misleading wording.",
    "Be strict about primary asset type wording, occupancy, policy constraints, and amenity claims.",
    "If output is mostly accurate, keep issue list short.",
    "Return JSON only matching schema.",
  ].join(" ");

  let audit: RefinementAudit | null = null;
  let auditUsage: RefinementUsage | null = null;

  try {
    const auditResponse = await callStructuredOpenAi({
      apiKey,
      model: "gpt-4.1-mini",
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
          description_original: sourceDescription,
          amenities_original: sourceAmenities,
        },
        candidate_output: output,
      },
      schemaName: "listing_refinement_audit",
      schema: buildAuditSchema(),
    });

    auditUsage = auditResponse.usage;
    const auditParsed = auditResponse.parsed;
    const accuracyRaw = (auditParsed.accuracy_score as number) ?? 0;
    const accuracy =
      typeof accuracyRaw === "number" && Number.isFinite(accuracyRaw)
        ? Math.max(0, Math.min(1, accuracyRaw))
        : 0;
    const retryRecommended = Boolean(auditParsed.retry_recommended);
    const issues = sanitizeAuditIssues(auditParsed.issues);

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
      parsed = retryResponse.parsed as unknown as RefinementOutput;

      const retryValidatedSleeping = sleeping_arrangements_schema.safeParse(
        parsed.sleeping_arrangements,
      );

      const retryMarkdownRaw = cleanManagerReferences(
        asString(parsed.description_markdown),
        input.snapshot.adapter_key,
      );
      const retryShort = cleanManagerReferences(
        asString(parsed.description_short_plain),
        input.snapshot.adapter_key,
      );
      const retrySeoDescription = cleanManagerReferences(
        asString(parsed.seo_meta_description),
        input.snapshot.adapter_key,
      );
      const retrySeoHidden = cleanManagerReferences(
        asString(parsed.seo_hidden_summary_plain),
        input.snapshot.adapter_key,
      );

      const retryHighlights = sanitizeHighlights(
        (parsed as Record<string, unknown>).highlights,
      );
      const retryHintsModel = sanitizeHelpfulHints(
        (parsed as Record<string, unknown>).helpful_hints,
      );
      const retryHints = Array.from(
        new Set([...retryHintsModel, ...helpfulHintsFromSource]),
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
        description_short_plain: retryShort,
        seo_meta_title: asString(parsed.seo_meta_title),
        seo_meta_description: retrySeoDescription,
        seo_hidden_summary_plain: retrySeoHidden,
        highlights: retryHighlights,
        helpful_hints: retryHints,
        sleeping_arrangements: retryValidatedSleeping.success
          ? retryValidatedSleeping.data
          : [],
        sleeping_rollups: normalizeSleepingRollups(
          (parsed as Record<string, unknown>).sleeping_rollups,
        ),
        amenities_normalized: retryMergedAmenities,
        amenities_evidence: retryMergedEvidence,
      };

      audit.retry_performed = true;
    }
  } catch {
    audit = null;
  }

  return {
    model,
    prompt_version: PROMPT_VERSION,
    output,
    usage: mergeUsage([refinementUsage, auditUsage]),
    audit,
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
  const usagePayload = (input.result.usage ?? {}) as Record<string, unknown>;
  const sourceHash =
    (input.snapshot.source_content_hash ?? "no_source_hash").trim() ||
    "no_source_hash";
  const outputHash = createHash("sha256")
    .update(JSON.stringify(outputPayload))
    .digest("hex");

  await pgDb
    .insert(listing_ai_refinement_cache)
    .values({
      id: `lrc_${randomUUID().replace(/-/g, "")}`,
      listing_id: input.snapshot.listing_id,
      source_link_id: input.snapshot.source_link_id,
      adapter_key: input.snapshot.adapter_key,
      source_content_hash: sourceHash,
      status: "staged",
      model: input.result.model,
      prompt_version: input.result.prompt_version,
      output_hash: outputHash,
      output_payload: outputPayload,
      usage_payload: usagePayload,
      generated_at: now,
      applied_at: null,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: [
        listing_ai_refinement_cache.listing_id,
        listing_ai_refinement_cache.source_content_hash,
        listing_ai_refinement_cache.prompt_version,
      ],
      set: {
        source_link_id: input.snapshot.source_link_id,
        adapter_key: input.snapshot.adapter_key,
        status: "staged",
        model: input.result.model,
        output_hash: outputHash,
        output_payload: outputPayload,
        usage_payload: usagePayload,
        generated_at: now,
        applied_at: null,
        updated_at: now,
      },
    });
}
