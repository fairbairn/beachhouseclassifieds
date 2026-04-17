import { loadPromptLinesFromMarkdown } from "./prompt-markdown-loader";

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

export const SLEEP_RESOLUTION_PROMPT_BASE = loadPromptLinesFromMarkdown({
  fileName: "sleep-resolution-system.md",
});

const SLEEP_RESOLUTION_ROOMS_GUIDANCE_INSTRUCTION =
  "Context field available: rooms_guidance. Treat rooms_guidance as property-sourced, high-confidence baseline evidence for room and bed breakdowns when present; use it to anchor sleeping_arrangements and sleeping_summary before falling back to description text.";

export function buildSleepResolutionPrompt(input: {
  hasRoomsGuidance: boolean;
}): string {
  return [
    ...SLEEP_RESOLUTION_PROMPT_BASE,
    input.hasRoomsGuidance ? SLEEP_RESOLUTION_ROOMS_GUIDANCE_INSTRUCTION : "",
    "Return sleeping_arrangements and sleeping_summary.",
  ]
    .filter(Boolean)
    .join(" ");
}

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
              trundles: { type: "number" },
              other: { type: "number" },
            },
            required: [
              "king",
              "queen",
              "full",
              "twin_standalone",
              "bunk_beds",
              "trundles",
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
