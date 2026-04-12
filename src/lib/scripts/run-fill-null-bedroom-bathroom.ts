import "@/core/tooling/env/load-env-profile";

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { sql } from "drizzle-orm";

import { pgDb } from "@/core/server/db";

type Options = {
  dryRun: boolean;
  limit: number;
  model: string;
  minConfidence: number;
  progressEvery: number;
  listingId: string | null;
};

type CandidateRow = {
  listing_id: string;
  slug: string;
  canonical_name: string;
  bedrooms: number | null;
  bathrooms: number | null;
  sleeps: number | null;
  adapter_key: string | null;
  external_listing_id: string | null;
};

type OpenAiUsage = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
};

type ParsedInference = {
  bedrooms: number | null;
  bathrooms: number | null;
  sleeps: number | null;
  confidence_score: number;
  evidence_excerpt: string;
};

const PROMPT_VERSION = "rooms_v1";

function printUsage(): void {
  console.log("Fill Null Bedroom/Bathroom/Sleeps Values");
  console.log("Usage:");
  console.log(
    "  tsx src/lib/scripts/run-fill-null-bedroom-bathroom.ts [--dry-run] [--limit <n>] [--model <name>] [--min-confidence <0-1>]",
  );
  console.log("");
  console.log("Options:");
  console.log("  --dry-run                 Preview only (no DB updates)");
  console.log(
    "  --limit <n>               Max listings to process (default 100)",
  );
  console.log(
    "  --model <name>            OpenAI model (default gpt-4.1-mini)",
  );
  console.log(
    "  --min-confidence <0-1>    Minimum confidence to apply (default 0.6)",
  );
  console.log(
    "  --progress-every <n>      Emit progress line every n listings (default 1)",
  );
  console.log(
    "  --listing-id <id>         Process one specific listing id only",
  );
  console.log("  --help                    Show help");
}

function parseArgs(argv: string[]): Options {
  let dryRun = false;
  let limit = 100;
  let model = "gpt-4.1-mini";
  let minConfidence = 0.6;
  let progressEvery = 1;
  let listingId: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (arg === "--limit") {
      if (!next) {
        throw new Error("Missing value for --limit");
      }
      const parsed = Number.parseInt(next, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("--limit must be a positive integer");
      }
      limit = parsed;
      i += 1;
      continue;
    }

    if (arg === "--model") {
      if (!next) {
        throw new Error("Missing value for --model");
      }
      model = next.trim() || model;
      i += 1;
      continue;
    }

    if (arg === "--min-confidence") {
      if (!next) {
        throw new Error("Missing value for --min-confidence");
      }
      const parsed = Number.parseFloat(next);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
        throw new Error("--min-confidence must be a number between 0 and 1");
      }
      minConfidence = parsed;
      i += 1;
      continue;
    }

    if (arg === "--progress-every") {
      if (!next) {
        throw new Error("Missing value for --progress-every");
      }
      const parsed = Number.parseInt(next, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("--progress-every must be a positive integer");
      }
      progressEvery = parsed;
      i += 1;
      continue;
    }

    if (arg === "--listing-id") {
      if (!next) {
        throw new Error("Missing value for --listing-id");
      }
      listingId = next.trim() || null;
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    dryRun,
    limit,
    model,
    minConfidence,
    progressEvery,
    listingId,
  };
}

function formatDuration(ms: number): string {
  const safe = Math.max(0, Math.floor(ms));
  const totalSeconds = Math.floor(safe / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function formatPercent(processed: number, total: number): string {
  if (total <= 0) {
    return "0.0";
  }
  return ((processed / total) * 100).toFixed(1);
}

function computeEtaMs(input: {
  startedAtMs: number;
  processed: number;
  total: number;
}): number {
  if (input.processed <= 0) {
    return 0;
  }

  const elapsed = Date.now() - input.startedAtMs;
  const avgPerItem = elapsed / input.processed;
  const remaining = Math.max(0, input.total - input.processed);
  return Math.max(0, Math.round(avgPerItem * remaining));
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
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

function clampBedroom(value: number | null): number | null {
  if (value === null) return null;
  const rounded = Math.round(value);
  if (!Number.isFinite(rounded) || rounded <= 0 || rounded > 30) {
    return null;
  }
  return rounded;
}

function clampBathroom(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isFinite(value) || value <= 0 || value > 20) {
    return null;
  }
  const normalized = Math.round(value * 2) / 2;
  return normalized;
}

function clampSleeps(value: number | null): number | null {
  if (value === null) return null;
  const rounded = Math.round(value);
  if (!Number.isFinite(rounded) || rounded <= 0 || rounded > 40) {
    return null;
  }
  return rounded;
}

function buildInferenceSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      bedrooms: {
        anyOf: [{ type: "integer", minimum: 0, maximum: 30 }, { type: "null" }],
      },
      bathrooms: {
        anyOf: [{ type: "number", minimum: 0, maximum: 20 }, { type: "null" }],
      },
      sleeps: {
        anyOf: [{ type: "integer", minimum: 0, maximum: 40 }, { type: "null" }],
      },
      confidence_score: { type: "number", minimum: 0, maximum: 1 },
      evidence_excerpt: { type: "string" },
    },
    required: [
      "bedrooms",
      "bathrooms",
      "sleeps",
      "confidence_score",
      "evidence_excerpt",
    ],
  };
}

async function callInferenceModel(input: {
  apiKey: string;
  model: string;
  payload: Record<string, unknown>;
}): Promise<{ parsed: ParsedInference; usage: OpenAiUsage | null }> {
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
          content: [
            {
              type: "input_text",
              text: [
                "Extract bedroom, bathroom, and sleeps counts for vacation rentals.",
                "Return null for any field not explicitly supported by text.",
                "If totals are not stated directly, infer from layout clues and room narratives (for example, ensuite mentions, floor-by-floor breakdowns, and shared-bath descriptions).",
                "Use conservative best estimates from the provided text only.",
                "Use confidence_score to reflect certainty from the provided text only.",
              ].join(" "),
            },
          ],
        },
        {
          role: "user",
          content: [
            { type: "input_text", text: JSON.stringify(input.payload) },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "room_count_inference",
          schema: buildInferenceSchema(),
          strict: true,
        },
      },
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `OpenAI request failed status=${response.status} body=${errorBody}`,
    );
  }

  const json = (await response.json()) as Record<string, unknown>;
  const outputText = extractOutputText(json);
  if (!outputText) {
    throw new Error("OpenAI response had no output text.");
  }

  const parsedRaw = asObject(JSON.parse(outputText));
  const parsed: ParsedInference = {
    bedrooms: clampBedroom(asNumber(parsedRaw.bedrooms)),
    bathrooms: clampBathroom(asNumber(parsedRaw.bathrooms)),
    sleeps: clampSleeps(asNumber(parsedRaw.sleeps)),
    confidence_score: Math.max(
      0,
      Math.min(1, asNumber(parsedRaw.confidence_score) ?? 0),
    ),
    evidence_excerpt: asString(parsedRaw.evidence_excerpt),
  };

  return {
    parsed,
    usage: asObject(json.usage) as OpenAiUsage,
  };
}

function buildDetailJsonPath(
  adapterKey: string,
  externalListingId: string,
): string {
  return resolve(
    process.cwd(),
    "src",
    "lib",
    "data",
    "external-sources",
    adapterKey,
    "details",
    "json",
    `${externalListingId}.json`,
  );
}

async function run(): Promise<number> {
  if (!pgDb) {
    throw new Error("Postgres database is not configured.");
  }

  const options = parseArgs(process.argv.slice(2));
  const apiKey = asString(process.env.OPENAI_API_KEY);
  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY in environment.");
  }

  const listingFilterSql = options.listingId
    ? sql`and l.id = ${options.listingId}`
    : sql``;

  const candidatesResult = await pgDb.execute<CandidateRow>(sql`
    select
      l.id as listing_id,
      l.slug,
      l.canonical_name,
      l.bedrooms,
      l.bathrooms,
      l.sleeps,
      lsl.adapter_key,
      lsl.external_listing_id
    from listing l
    left join listing_source_link lsl
      on lsl.listing_id = l.id
      and lsl.is_primary_source = true
      and lsl.source_status = 'active'
      and lsl.active_to is null
    where l.status = 'active'
      and (l.bedrooms is null or l.bathrooms is null or l.sleeps is null)
      and lsl.adapter_key is not null
      and lsl.external_listing_id is not null
      ${listingFilterSql}
    order by l.id
    limit ${options.limit}
  `);

  const candidates = candidatesResult.rows;
  const total = candidates.length;

  console.log(
    `fill_null_bed_bath_start dry_run=${options.dryRun} total_candidates=${total} model=${options.model} min_confidence=${options.minConfidence} progress_every=${options.progressEvery} listing_id=${options.listingId ?? "all"}`,
  );

  const startedAtMs = Date.now();

  let processed = 0;
  let inferredAny = 0;
  let updated = 0;
  let skippedLowConfidence = 0;
  let skippedNoEvidence = 0;
  let skippedNoDetail = 0;
  let skippedModelError = 0;

  let usageInputTokens = 0;
  let usageOutputTokens = 0;
  let usageTotalTokens = 0;

  for (const row of candidates) {
    processed += 1;
    const prefix = `[${processed}/${total} ${formatPercent(processed, total)}%]`;

    let itemStatus = "";
    let itemConfidence = 0;

    const adapterKey = asString(row.adapter_key);
    const externalListingId = asString(row.external_listing_id);
    if (!adapterKey || !externalListingId) {
      skippedNoDetail += 1;
      itemStatus = "skip_no_detail";
      const elapsed = Date.now() - startedAtMs;
      const eta = computeEtaMs({ startedAtMs, processed, total });
      if (
        processed === 1 ||
        processed % options.progressEvery === 0 ||
        processed === total
      ) {
        console.log(
          `${prefix} status=${itemStatus} elapsed=${formatDuration(elapsed)} eta=${formatDuration(eta)}`,
        );
      }
      continue;
    }

    const detailPath = buildDetailJsonPath(adapterKey, externalListingId);

    let detail: Record<string, unknown>;
    try {
      const raw = await readFile(detailPath, "utf8");
      detail = asObject(JSON.parse(raw));
    } catch {
      skippedNoDetail += 1;
      itemStatus = "skip_no_detail";
      const elapsed = Date.now() - startedAtMs;
      const eta = computeEtaMs({ startedAtMs, processed, total });
      if (
        processed === 1 ||
        processed % options.progressEvery === 0 ||
        processed === total
      ) {
        console.log(
          `${prefix} status=${itemStatus} listing_id=${row.listing_id} elapsed=${formatDuration(elapsed)} eta=${formatDuration(eta)}`,
        );
      }
      continue;
    }

    const payload: Record<string, unknown> = {
      prompt_version: PROMPT_VERSION,
      listing_id: row.listing_id,
      slug: row.slug,
      canonical_name: row.canonical_name,
      current_values: {
        bedrooms: row.bedrooms,
        bathrooms: row.bathrooms,
        sleeps: row.sleeps,
      },
      source: {
        adapter_key: adapterKey,
        external_listing_id: externalListingId,
        title: asString(detail.title),
        h1: asString(detail.h1),
        meta_description: asString(detail.meta_description),
        description_expanded: asString(detail.description_expanded),
        normalized_matching_description: asString(
          asObject(detail.normalized_matching_profile).description,
        ),
        property_profile: {
          beds: asObject(detail.property_profile).beds ?? null,
          baths: asObject(detail.property_profile).baths ?? null,
          sleeps: asObject(detail.property_profile).sleeps ?? null,
        },
      },
    };

    let parsed: ParsedInference;
    let usage: OpenAiUsage | null;

    try {
      const inference = await callInferenceModel({
        apiKey,
        model: options.model,
        payload,
      });
      parsed = inference.parsed;
      usage = inference.usage;
    } catch (error) {
      skippedModelError += 1;
      itemStatus = "skip_model_error";
      const message = error instanceof Error ? error.message : String(error);
      const elapsed = Date.now() - startedAtMs;
      const eta = computeEtaMs({ startedAtMs, processed, total });
      console.log(
        `${prefix} status=${itemStatus} listing_id=${row.listing_id} error=${message} elapsed=${formatDuration(elapsed)} eta=${formatDuration(eta)}`,
      );
      continue;
    }

    usageInputTokens += usage?.input_tokens ?? 0;
    usageOutputTokens += usage?.output_tokens ?? 0;
    usageTotalTokens += usage?.total_tokens ?? 0;
    itemConfidence = parsed.confidence_score;

    if (parsed.confidence_score < options.minConfidence) {
      skippedLowConfidence += 1;
      itemStatus = "skip_low_confidence";
      const elapsed = Date.now() - startedAtMs;
      const eta = computeEtaMs({ startedAtMs, processed, total });
      if (
        processed === 1 ||
        processed % options.progressEvery === 0 ||
        processed === total
      ) {
        console.log(
          `${prefix} status=${itemStatus} listing_id=${row.listing_id} confidence=${itemConfidence.toFixed(2)} elapsed=${formatDuration(elapsed)} eta=${formatDuration(eta)}`,
        );
      }
      continue;
    }

    const nextBedrooms = row.bedrooms ?? parsed.bedrooms;
    const nextBathrooms = row.bathrooms ?? parsed.bathrooms;
    const nextSleeps = row.sleeps ?? parsed.sleeps;

    const canFillBedroom = row.bedrooms === null && parsed.bedrooms !== null;
    const canFillBathroom = row.bathrooms === null && parsed.bathrooms !== null;
    const canFillSleeps = row.sleeps === null && parsed.sleeps !== null;

    if (!canFillBedroom && !canFillBathroom && !canFillSleeps) {
      skippedNoEvidence += 1;
      itemStatus = "skip_no_evidence";
      const elapsed = Date.now() - startedAtMs;
      const eta = computeEtaMs({ startedAtMs, processed, total });
      if (
        processed === 1 ||
        processed % options.progressEvery === 0 ||
        processed === total
      ) {
        console.log(
          `${prefix} status=${itemStatus} listing_id=${row.listing_id} confidence=${itemConfidence.toFixed(2)} elapsed=${formatDuration(elapsed)} eta=${formatDuration(eta)}`,
        );
      }
      continue;
    }

    inferredAny += 1;

    if (options.dryRun) {
      itemStatus = "dry_run_inferred";
      const elapsed = Date.now() - startedAtMs;
      const eta = computeEtaMs({ startedAtMs, processed, total });
      if (
        processed === 1 ||
        processed % options.progressEvery === 0 ||
        processed === total
      ) {
        console.log(
          `${prefix} status=${itemStatus} listing_id=${row.listing_id} fill_bedrooms=${canFillBedroom} fill_bathrooms=${canFillBathroom} confidence=${itemConfidence.toFixed(2)} elapsed=${formatDuration(elapsed)} eta=${formatDuration(eta)}`,
        );
      }
      continue;
    }

    await pgDb.execute(sql`
      update listing
      set
        bedrooms = coalesce(bedrooms, ${nextBedrooms}),
        bathrooms = coalesce(bathrooms, ${nextBathrooms}),
        sleeps = coalesce(sleeps, ${nextSleeps}),
        updated_at = now()
      where id = ${row.listing_id}
    `);

    updated += 1;
    itemStatus = "updated";
    const elapsed = Date.now() - startedAtMs;
    const eta = computeEtaMs({ startedAtMs, processed, total });
    if (
      processed === 1 ||
      processed % options.progressEvery === 0 ||
      processed === total
    ) {
      console.log(
        `${prefix} status=${itemStatus} listing_id=${row.listing_id} fill_bedrooms=${canFillBedroom} fill_bathrooms=${canFillBathroom} confidence=${itemConfidence.toFixed(2)} elapsed=${formatDuration(elapsed)} eta=${formatDuration(eta)}`,
      );
    }
  }

  const totalElapsedMs = Date.now() - startedAtMs;

  console.log(
    `fill_null_bed_bath_complete dry_run=${options.dryRun} processed=${processed} inferred_any=${inferredAny} updated=${updated} skipped_low_confidence=${skippedLowConfidence} skipped_no_evidence=${skippedNoEvidence} skipped_no_detail=${skippedNoDetail} skipped_model_error=${skippedModelError} elapsed=${formatDuration(totalElapsedMs)}`,
  );
  console.log(
    `fill_null_bed_bath_usage model=${options.model} input_tokens=${usageInputTokens} output_tokens=${usageOutputTokens} total_tokens=${usageTotalTokens}`,
  );

  return 0;
}

run()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`fill null bedroom/bathroom failed: ${message}`);
    process.exit(1);
  });
