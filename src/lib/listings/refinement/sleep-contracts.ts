function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function extractStructuredOutputText(
  response: Record<string, unknown>,
): string {
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

export const SLEEP_RESOLUTION_PROMPT_BASE = [
  "Task: extract sleeping_arrangements and sleeping_summary from provided listing context.",
  "This is a correction task focused on sleeping data structures; preserve structure when possible and only change what is required for correctness.",
  "Context fields available: description_expanded, rooms_guidance, bedrooms, bathrooms, sleeps.",
  "Prioritize rooms_guidance as high-signal evidence when it contains room or bed breakdown details.",
  "Output exactly one JSON object with this shape: { sleeping_arrangements: [...], sleeping_summary: { bed_counts: {...}, bunk_configurations: {...}, sleep_capacity: {...} } }.",
  "Rules: sleeps is a strict target for total capacity; use explicit evidence from description_expanded; keep counts conservative; do not double count bunk beds as standalone beds.",
  "Reconciliation logic: recompute room sleeps from bed types and counts, remove duplicated rooms, include missing bunk/carriage sleeping areas when explicitly supported, and keep arrangements plus summary aligned.",
  "Hard constraint: total derived sleep capacity must equal sleeps exactly before returning output.",
  "Capacity map: standalone king=2, queen=2, full=2, twin=1, sofa_bed=2, murphy=2, futon=2, daybed=1, trundle=1, air_mattress=1.",
  "Bunk rules: bunks are stacked two-bed units, so compute capacity from bunk_configuration only and never add bunk surfaces as standalone beds.",
  "Bunk capacity map: twin_over_twin=2, full_over_full=4, queen_over_queen=4, twin_over_full=3, twin_over_queen=3, twin_over_king=3.",
  "When standalone bed counts are provided in context as trusted anchors, keep those counts fixed and adjust bunk interpretations to align derived_total to sleeps.",
  "Validation before output: check total capacity equals sleeps, check room entries are not missing or duplicated, and ensure sleeping_summary matches sleeping_arrangements.",
  "Return JSON only matching schema.",
];

export function buildSleepResolutionSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
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
                "hallway",
                "living_area",
                "loft",
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
                      "air_mattress",
                      "futon",
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
      sleeping_summary: {
        type: "object",
        additionalProperties: false,
        properties: {
          bed_counts: {
            type: "object",
            additionalProperties: false,
            properties: {
              king: { type: "number" },
              queen: { type: "number" },
              full: { type: "number" },
              twin_standalone: { type: "number" },
              bunk_beds: { type: "number" },
              other: { type: "number" },
            },
            required: [
              "king",
              "queen",
              "full",
              "twin_standalone",
              "bunk_beds",
              "other",
            ],
          },
          bunk_configurations: {
            type: "object",
            additionalProperties: false,
            properties: {
              default_twin_over_twin: { type: "number" },
              twin_over_full: { type: "number" },
              full_over_full: { type: "number" },
              queen_over_queen: { type: "number" },
              twin_over_queen: { type: "number" },
              twin_over_king: { type: "number" },
              other: { type: "number" },
            },
            required: [
              "default_twin_over_twin",
              "twin_over_full",
              "full_over_full",
              "queen_over_queen",
              "twin_over_queen",
              "twin_over_king",
              "other",
            ],
          },
          sleep_capacity: {
            type: "object",
            additionalProperties: false,
            properties: {
              derived_total: { type: "number" },
              target_sleeps: { type: "number" },
              delta: { type: "number" },
              aligned: { type: "boolean" },
            },
            required: ["derived_total", "target_sleeps", "delta", "aligned"],
          },
        },
        required: ["bed_counts", "bunk_configurations", "sleep_capacity"],
      },
    },
    required: ["sleeping_arrangements", "sleeping_summary"],
  };
}
