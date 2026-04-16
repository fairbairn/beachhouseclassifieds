import "@/core/tooling/env/load-env-profile";

import { createHash } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";

import { pgDb } from "@/core/server/db";
import { resolveProfileEnvironment } from "@/core/tooling/env/profile-env";
import { createScrapeProgress } from "@/core/tooling/terminal/scrape-progress";
import {
  listing_ai_enrichment,
  listing_source_link,
} from "@/lib/db/schema-postgres";
import {
  buildSleepResolutionSchema,
  extractStructuredOutputText,
  SLEEP_RESOLUTION_PROMPT_BASE,
} from "@/lib/listings/refinement/sleep-contracts";
import { runWithConcurrency } from "@/lib/pricing/quotes/shared/run-with-concurrency";

type Options = {
  limit: number;
  concurrency: number;
  progressEvery: number;
  adapterKey: string | null;
  listingId: string | null;
  externalListingId: string | null;
  includeAuditPassed: boolean;
  primaryModel: string;
  secondaryModel: string | null;
  deterministicFallback: boolean;
  dryRun: boolean;
};

type RepairRow = {
  id: string;
  listing_id: string;
  status: string;
  model: string | null;
  source_snapshot_payload: unknown;
  output_payload: unknown;
  audit_payload: unknown;
};

type SleepMatch = {
  derived: number;
  target: number | null;
  delta: number;
  matches: boolean;
};

type SleepRepairAttemptResult = {
  sleeping_arrangements: unknown[];
  modelUsed: string | null;
  resolvedBy: "primary" | "secondary" | "deterministic" | "none";
  attempts: string[];
};

type ArrangementBed = {
  bed_type: string;
  count: number;
  bunk_configuration?: string;
};

const CAPACITY_KEYS = [
  "bed_count_king",
  "bed_count_queen",
  "bed_count_full",
  "bed_count_twin",
  "bed_count_sofa_bed",
  "bed_count_daybed",
  "bed_count_trundle",
  "bed_count_murphy",
  "bed_count_air_mattress",
  "bed_count_futon",
] as const;

const CAPACITY_PER_BED: Record<(typeof CAPACITY_KEYS)[number], number> = {
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

function printUsage(): void {
  console.log("Repair Enrichment Sleep Data Only");
  console.log("Usage:");
  console.log(
    "  tsx src/lib/scripts/run-ai-enrichment-sleep-repair.ts [--limit 100] [--concurrency 10] [--adapter-key <key>] [--listing-id <id>] [--external-listing-id <id>] [--include-audit-passed] [--primary-model gpt-4.1-mini] [--secondary-model gpt-4.1] [--disable-secondary-model] [--disable-deterministic-fallback] [--dry-run]",
  );
  console.log("");
  console.log("Options:");
  console.log(
    "  --limit <n>                         Max failing rows to repair",
  );
  console.log(
    "  --concurrency <n>                   Concurrent workers (default 10)",
  );
  console.log(
    "  --progress-every <n>                Emit progress every n rows",
  );
  console.log("  --adapter-key <key>                 Restrict to one adapter");
  console.log("  --listing-id <id>                   Restrict to one listing");
  console.log(
    "  --external-listing-id <id>          Restrict via source link external listing id",
  );
  console.log(
    "  --include-audit-passed              Allow targeting rows even when audit_passed=true",
  );
  console.log(
    "  --primary-model <name>              First model (default gpt-4.1-mini)",
  );
  console.log(
    "  --secondary-model <name>            Fallback model (default gpt-4.1)",
  );
  console.log("  --disable-secondary-model           Skip second model stage");
  console.log(
    "  --disable-deterministic-fallback    Skip deterministic fallback",
  );
  console.log(
    "  --dry-run                           Compute repairs only; do not persist",
  );
  console.log("  --help                              Show help");
}

function parseArgs(argv: string[]): Options {
  let limit = 100;
  let concurrency = 10;
  let progressEvery = 25;
  let adapterKey: string | null = null;
  let listingId: string | null = null;
  let externalListingId: string | null = null;
  let includeAuditPassed = false;
  let primaryModel = "gpt-4.1-mini";
  let secondaryModel: string | null = "gpt-4.1";
  let deterministicFallback = true;
  let dryRun = false;

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

    if (arg === "--disable-secondary-model") {
      secondaryModel = null;
      continue;
    }

    if (arg === "--disable-deterministic-fallback") {
      deterministicFallback = false;
      continue;
    }

    if (arg === "--include-audit-passed") {
      includeAuditPassed = true;
      continue;
    }

    if (arg === "--limit" && next) {
      const parsed = Number(next);
      if (!Number.isFinite(parsed) || parsed < 1) {
        throw new Error("--limit must be a positive integer");
      }
      limit = Math.floor(parsed);
      i += 1;
      continue;
    }

    if (arg === "--concurrency" && next) {
      const parsed = Number(next);
      if (!Number.isFinite(parsed) || parsed < 1) {
        throw new Error("--concurrency must be a positive integer");
      }
      concurrency = Math.floor(parsed);
      i += 1;
      continue;
    }

    if (arg === "--progress-every" && next) {
      const parsed = Number(next);
      if (!Number.isFinite(parsed) || parsed < 1) {
        throw new Error("--progress-every must be a positive integer");
      }
      progressEvery = Math.floor(parsed);
      i += 1;
      continue;
    }

    if (arg === "--adapter-key" && next) {
      adapterKey = next.trim().toLowerCase() || null;
      i += 1;
      continue;
    }

    if (arg === "--listing-id" && next) {
      listingId = next.trim() || null;
      i += 1;
      continue;
    }

    if (arg === "--external-listing-id" && next) {
      externalListingId = next.trim() || null;
      i += 1;
      continue;
    }

    if (arg === "--primary-model" && next) {
      primaryModel = next.trim() || primaryModel;
      i += 1;
      continue;
    }

    if (arg === "--secondary-model" && next) {
      secondaryModel = next.trim() || null;
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    limit,
    concurrency,
    progressEvery,
    adapterKey,
    listingId,
    externalListingId,
    includeAuditPassed,
    primaryModel,
    secondaryModel,
    deterministicFallback,
    dryRun,
  };
}

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

function normalizeCount(value: unknown): number {
  const parsed = asNumber(value);
  if (parsed === null) {
    return 0;
  }
  return Math.max(0, Math.round(parsed));
}

function normalizeSleepingRollups(
  value: unknown,
  expectedSleeps: number | null,
): Record<string, number> {
  const input = asObject(value);
  const rollups: Record<string, number> = {};

  for (const key of CAPACITY_KEYS) {
    rollups[key] = normalizeCount(input[key]);
  }

  for (const [key, raw] of Object.entries(input)) {
    if (key in rollups) {
      continue;
    }
    if (/^bed_count_|sleep_capacity_|bunk_/.test(key)) {
      rollups[key] = normalizeCount(raw);
    }
  }

  const derived = estimateSleepCapacityFromRollups(rollups);
  const target =
    expectedSleeps === null ? 0 : Math.max(0, Math.round(expectedSleeps));
  rollups.sleep_capacity_from_rollups = derived;
  rollups.sleep_capacity_target = target;
  rollups.sleep_capacity_delta = target > 0 ? derived - target : 0;
  rollups.bed_type_count_distinct = CAPACITY_KEYS.reduce(
    (sum, key) => sum + (rollups[key] > 0 ? 1 : 0),
    0,
  );
  rollups.bed_count_king_standalone = normalizeCount(
    rollups.bed_count_king_standalone ?? rollups.bed_count_king,
  );
  rollups.bed_count_queen_standalone = normalizeCount(
    rollups.bed_count_queen_standalone ?? rollups.bed_count_queen,
  );
  rollups.bed_count_full_standalone = normalizeCount(
    rollups.bed_count_full_standalone ?? rollups.bed_count_full,
  );
  rollups.bed_count_twin_standalone = normalizeCount(
    rollups.bed_count_twin_standalone ?? rollups.bed_count_twin,
  );
  rollups.bed_count_bunk_total = normalizeCount(rollups.bed_count_bunk_total);
  rollups.bunk_unit_count_total = normalizeCount(rollups.bunk_unit_count_total);
  rollups.bunk_sleep_slot_count_total = normalizeCount(
    rollups.bunk_sleep_slot_count_total,
  );

  return rollups;
}

function normalizeSleepingArrangements(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function mapBunkConfigurationToCapacity(
  bunkConfiguration: string,
): { key: string; unitCapacity: number } | null {
  const normalized = bunkConfiguration.trim().toLowerCase();
  if (normalized === "twin_over_twin") {
    return { key: "bed_count_twin_over_twin_bunk", unitCapacity: 2 };
  }
  if (normalized === "twin_over_full") {
    return { key: "bed_count_twin_over_full_bunk", unitCapacity: 3 };
  }
  if (normalized === "full_over_full") {
    return { key: "bed_count_full_over_full_bunk", unitCapacity: 4 };
  }
  if (normalized === "queen_over_queen") {
    return { key: "bed_count_queen_over_queen_bunk", unitCapacity: 4 };
  }
  if (normalized === "twin_over_queen") {
    return { key: "bed_count_twin_over_queen_bunk", unitCapacity: 3 };
  }
  if (normalized === "twin_over_king") {
    return { key: "bed_count_twin_over_king_bunk", unitCapacity: 3 };
  }
  return null;
}

function deriveRollupsFromArrangements(
  arrangements: unknown[],
  expectedSleeps: number | null,
): Record<string, number> {
  const rollups: Record<string, number> = {
    bed_count_king: 0,
    bed_count_queen: 0,
    bed_count_full: 0,
    bed_count_twin: 0,
    bed_count_sofa_bed: 0,
    bed_count_daybed: 0,
    bed_count_trundle: 0,
    bed_count_murphy: 0,
    bed_count_air_mattress: 0,
    bed_count_futon: 0,
    bed_count_bunk_total: 0,
    bunk_unit_count_total: 0,
    bunk_sleep_slot_count_total: 0,
  };

  for (const room of arrangements) {
    const roomObj = asObject(room);
    const beds = Array.isArray(roomObj.beds) ? roomObj.beds : [];

    for (const bedRaw of beds) {
      const bed = asObject(bedRaw) as ArrangementBed;
      const count = normalizeCount(bed.count);
      if (count < 1) {
        continue;
      }

      const bunkConfiguration = asString(bed.bunk_configuration);
      if (bunkConfiguration.length > 0) {
        const mapped = mapBunkConfigurationToCapacity(bunkConfiguration);
        if (mapped) {
          rollups[mapped.key] = normalizeCount(rollups[mapped.key]) + count;
          rollups.bed_count_bunk_total =
            normalizeCount(rollups.bed_count_bunk_total) + count;
          rollups.bunk_unit_count_total =
            normalizeCount(rollups.bunk_unit_count_total) + count;
          rollups.bunk_sleep_slot_count_total =
            normalizeCount(rollups.bunk_sleep_slot_count_total) +
            count * mapped.unitCapacity;
          continue;
        }
      }

      const key = `bed_count_${asString(bed.bed_type).toLowerCase()}`;
      if (CAPACITY_KEYS.includes(key as (typeof CAPACITY_KEYS)[number])) {
        rollups[key] = normalizeCount(rollups[key]) + count;
      }
    }
  }

  rollups.bed_count_king_standalone = normalizeCount(rollups.bed_count_king);
  rollups.bed_count_queen_standalone = normalizeCount(rollups.bed_count_queen);
  rollups.bed_count_full_standalone = normalizeCount(rollups.bed_count_full);
  rollups.bed_count_twin_standalone = normalizeCount(rollups.bed_count_twin);

  return normalizeSleepingRollups(rollups, expectedSleeps);
}

function estimateSleepCapacityFromRollups(
  rollups: Record<string, number>,
): number {
  let total = 0;
  for (const key of CAPACITY_KEYS) {
    total += normalizeCount(rollups[key]) * CAPACITY_PER_BED[key];
  }

  const bunkTwinOverTwin = normalizeCount(
    rollups.bed_count_twin_over_twin_bunk ?? rollups.bed_count_twin_bunk,
  );
  const bunkTwinOverFull = normalizeCount(
    rollups.bed_count_twin_over_full_bunk,
  );
  const bunkFullOverFull = normalizeCount(
    rollups.bed_count_full_over_full_bunk ?? rollups.bed_count_full_bunk,
  );
  const bunkQueenOverQueen = normalizeCount(
    rollups.bed_count_queen_over_queen_bunk ?? rollups.bed_count_queen_bunk,
  );
  const bunkTwinOverQueen = normalizeCount(
    rollups.bed_count_twin_over_queen_bunk,
  );
  const bunkTwinOverKing = normalizeCount(
    rollups.bed_count_twin_over_king_bunk ?? rollups.bed_count_king_bunk,
  );

  total += bunkTwinOverTwin * 2;
  total += bunkTwinOverFull * 3;
  total += bunkFullOverFull * 4;
  total += bunkQueenOverQueen * 4;
  total += bunkTwinOverQueen * 3;
  total += bunkTwinOverKing * 3;

  return Math.max(0, Math.round(total));
}

function evaluateSleepCapacityMatch(input: {
  rollups: Record<string, number>;
  expectedSleeps: number | null;
}): SleepMatch {
  const target =
    input.expectedSleeps === null
      ? null
      : Math.max(0, Math.round(input.expectedSleeps));
  const derived = estimateSleepCapacityFromRollups(input.rollups);
  if (target === null) {
    return {
      derived,
      target: null,
      delta: 0,
      matches: true,
    };
  }
  return {
    derived,
    target,
    delta: derived - target,
    matches: derived === target,
  };
}

function hasMeaningfulSleepEnvironment(
  rollups: Record<string, number>,
): boolean {
  return CAPACITY_KEYS.some((key) => normalizeCount(rollups[key]) > 0);
}

function isSleepTolerancePass(
  match: SleepMatch,
  rollups: Record<string, number>,
): boolean {
  if (match.target === null) {
    return true;
  }
  if (match.matches) {
    return true;
  }
  return match.delta === -1 && hasMeaningfulSleepEnvironment(rollups);
}

function reduceCapacity(
  rollups: Record<string, number>,
  requiredReduction: number,
): number {
  let remaining = requiredReduction;
  const order: Array<{
    key: (typeof CAPACITY_KEYS)[number];
    capacity: number;
  }> = [
    { key: "bed_count_twin", capacity: 1 },
    { key: "bed_count_daybed", capacity: 1 },
    { key: "bed_count_trundle", capacity: 1 },
    { key: "bed_count_air_mattress", capacity: 1 },
    { key: "bed_count_full", capacity: 2 },
    { key: "bed_count_queen", capacity: 2 },
    { key: "bed_count_king", capacity: 2 },
    { key: "bed_count_sofa_bed", capacity: 2 },
    { key: "bed_count_murphy", capacity: 2 },
    { key: "bed_count_futon", capacity: 2 },
  ];

  for (const item of order) {
    if (remaining <= 0) {
      break;
    }
    const available = normalizeCount(rollups[item.key]);
    if (available < 1) {
      continue;
    }

    if (item.capacity === 1) {
      const remove = Math.min(available, remaining);
      rollups[item.key] = available - remove;
      remaining -= remove;
      continue;
    }

    const remove = Math.min(available, Math.ceil(remaining / 2));
    rollups[item.key] = available - remove;
    remaining -= remove * item.capacity;
  }

  return remaining;
}

function reduceBunkCapacity(
  rollups: Record<string, number>,
  requiredReduction: number,
): number {
  let remaining = requiredReduction;
  const order: Array<{ key: string; capacity: number }> = [
    { key: "bed_count_twin_over_twin_bunk", capacity: 2 },
    { key: "bed_count_twin_over_full_bunk", capacity: 3 },
    { key: "bed_count_twin_over_queen_bunk", capacity: 3 },
    { key: "bed_count_twin_over_king_bunk", capacity: 3 },
    { key: "bed_count_full_over_full_bunk", capacity: 4 },
    { key: "bed_count_queen_over_queen_bunk", capacity: 4 },
  ];

  for (const item of order) {
    if (remaining <= 0) {
      break;
    }

    const available = normalizeCount(rollups[item.key]);
    if (available < 1) {
      continue;
    }

    const remove = Math.min(available, Math.ceil(remaining / item.capacity));
    rollups[item.key] = available - remove;
    rollups.bunk_unit_count_total = Math.max(
      0,
      normalizeCount(rollups.bunk_unit_count_total) - remove,
    );
    rollups.bed_count_bunk_total = Math.max(
      0,
      normalizeCount(rollups.bed_count_bunk_total) - remove,
    );
    rollups.bunk_sleep_slot_count_total = Math.max(
      0,
      normalizeCount(rollups.bunk_sleep_slot_count_total) -
        remove * item.capacity,
    );
    remaining -= remove * item.capacity;
  }

  return remaining;
}

function deriveArrangementsFromRollups(
  rollups: Record<string, number>,
  expectedSleeps: number | null,
): unknown[] {
  const beds: Array<Record<string, unknown>> = [];
  const map: Array<{ key: (typeof CAPACITY_KEYS)[number]; bedType: string }> = [
    { key: "bed_count_king", bedType: "king" },
    { key: "bed_count_queen", bedType: "queen" },
    { key: "bed_count_full", bedType: "full" },
    { key: "bed_count_twin", bedType: "twin" },
    { key: "bed_count_sofa_bed", bedType: "sofa_bed" },
    { key: "bed_count_daybed", bedType: "daybed" },
    { key: "bed_count_trundle", bedType: "trundle" },
    { key: "bed_count_murphy", bedType: "murphy" },
    { key: "bed_count_air_mattress", bedType: "air_mattress" },
    { key: "bed_count_futon", bedType: "futon" },
  ];

  for (const entry of map) {
    const count = normalizeCount(rollups[entry.key]);
    if (count < 1) {
      continue;
    }
    beds.push({ bed_type: entry.bedType, count });
  }

  if (beds.length === 0) {
    return [];
  }

  const match = evaluateSleepCapacityMatch({ rollups, expectedSleeps });

  return [
    {
      room_label: "Sleeping Areas",
      room_role: "other",
      sleeps: match.target ?? match.derived,
      beds,
      notes: "Sleep-only repair derivation from sleeping_summary.",
    },
  ];
}

function buildSleepingSummaryFromRollups(
  rollups: Record<string, number>,
  expectedSleeps: number | null,
): Record<string, unknown> {
  const derivedTotal = estimateSleepCapacityFromRollups(rollups);
  const targetSleeps =
    expectedSleeps === null ? 0 : Math.max(0, Math.round(expectedSleeps));

  return {
    bed_counts: {
      king: normalizeCount(rollups.bed_count_king),
      queen: normalizeCount(rollups.bed_count_queen),
      full: normalizeCount(rollups.bed_count_full),
      twin_standalone: normalizeCount(rollups.bed_count_twin),
      bunk_beds: normalizeCount(rollups.bed_count_bunk_total),
      other: 0,
    },
    bunk_configurations: {
      default_twin_over_twin: normalizeCount(
        rollups.bed_count_twin_over_twin_bunk,
      ),
      twin_over_full: normalizeCount(rollups.bed_count_twin_over_full_bunk),
      full_over_full: normalizeCount(rollups.bed_count_full_over_full_bunk),
      queen_over_queen: normalizeCount(rollups.bed_count_queen_over_queen_bunk),
      twin_over_queen: normalizeCount(rollups.bed_count_twin_over_queen_bunk),
      twin_over_king: normalizeCount(rollups.bed_count_twin_over_king_bunk),
      other: 0,
    },
    sleep_capacity: {
      derived_total: derivedTotal,
      target_sleeps: targetSleeps,
      delta: derivedTotal - targetSleeps,
      aligned: derivedTotal === targetSleeps,
    },
  };
}

function deterministicSleepRepair(input: {
  rollups: Record<string, number>;
  arrangements: unknown[];
  expectedSleeps: number | null;
}): { rollups: Record<string, number>; arrangements: unknown[] } {
  const adjusted = { ...input.rollups };
  const match = evaluateSleepCapacityMatch({
    rollups: adjusted,
    expectedSleeps: input.expectedSleeps,
  });

  if (match.target === null || match.matches) {
    return {
      rollups: normalizeSleepingRollups(adjusted, input.expectedSleeps),
      arrangements: input.arrangements,
    };
  }

  if (match.delta < 0) {
    adjusted.bed_count_twin =
      normalizeCount(adjusted.bed_count_twin) + Math.abs(match.delta);
  } else if (match.delta > 0) {
    let unresolved = reduceCapacity(adjusted, match.delta);
    if (unresolved > 0) {
      unresolved = reduceBunkCapacity(adjusted, unresolved);
    }
    if (unresolved > 0) {
      adjusted.bed_count_twin = Math.max(
        0,
        normalizeCount(adjusted.bed_count_twin) - unresolved,
      );
    }
  }

  let normalized = normalizeSleepingRollups(adjusted, input.expectedSleeps);

  // Rebalance after deterministic reduction to avoid odd-delta over-corrections
  // (for example, removing one 2-capacity bed when delta is 1).
  const postMatch = evaluateSleepCapacityMatch({
    rollups: normalized,
    expectedSleeps: input.expectedSleeps,
  });
  if (postMatch.target !== null && postMatch.derived < postMatch.target) {
    normalized.bed_count_twin =
      normalizeCount(normalized.bed_count_twin) +
      (postMatch.target - postMatch.derived);
    normalized = normalizeSleepingRollups(normalized, input.expectedSleeps);
  }

  return {
    rollups: normalized,
    arrangements: deriveArrangementsFromRollups(
      normalized,
      input.expectedSleeps,
    ),
  };
}

function getOpenAiApiKey(): string {
  const profileApiKey =
    resolveProfileEnvironment({
      profileValue: process.env.APP_ENV_PROFILE,
      processEnv: {
        APP_ENV_PROFILE: process.env.APP_ENV_PROFILE,
      },
    }).resolvedEnv.OPENAI_API_KEY?.trim() ?? "";

  const processApiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
  return profileApiKey || processApiKey;
}

async function callSleepResolutionModel(input: {
  apiKey: string;
  model: string;
  expectedSleeps: number | null;
  sourceSnapshot: Record<string, unknown>;
  currentArrangements: unknown[];
  currentRollups: Record<string, number>;
}): Promise<{ arrangements: unknown[]; summary: Record<string, unknown> }> {
  const prompt = [
    ...SLEEP_RESOLUTION_PROMPT_BASE,
    "Return sleeping_arrangements and sleeping_summary.",
  ].join(" ");

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
          content: [{ type: "input_text", text: prompt }],
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify({
                description_expanded: asString(
                  input.sourceSnapshot.description_expanded,
                ),
                bedrooms: asNumber(input.sourceSnapshot.bedrooms),
                bathrooms: asString(input.sourceSnapshot.bathrooms),
                sleeps: input.expectedSleeps,
              }),
            },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "sleep_only_repair",
          strict: true,
          schema: buildSleepResolutionSchema(),
        },
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `OpenAI sleep repair failed model=${input.model} status=${response.status} body=${body}`,
    );
  }

  const json = (await response.json()) as Record<string, unknown>;
  const outputText = extractStructuredOutputText(json);

  if (!outputText) {
    throw new Error(
      `OpenAI sleep repair returned no output text model=${input.model}`,
    );
  }

  const parsed = JSON.parse(outputText) as Record<string, unknown>;

  return {
    arrangements: normalizeSleepingArrangements(parsed.sleeping_arrangements),
    summary: asObject(parsed.sleeping_summary),
  };
}

function deriveRollupsFromSleepingSummary(input: {
  summary: Record<string, unknown>;
  expectedSleeps: number | null;
}): Record<string, number> {
  const bedCounts = asObject(input.summary.bed_counts);
  const bunkConfigurations = asObject(input.summary.bunk_configurations);

  const rollups: Record<string, number> = {
    bed_count_king: normalizeCount(bedCounts.king),
    bed_count_queen: normalizeCount(bedCounts.queen),
    bed_count_full: normalizeCount(bedCounts.full),
    bed_count_twin: normalizeCount(bedCounts.twin_standalone),
    bed_count_sofa_bed: 0,
    bed_count_daybed: 0,
    bed_count_trundle: 0,
    bed_count_murphy: 0,
    bed_count_air_mattress: 0,
    bed_count_futon: 0,
    bed_count_twin_over_twin_bunk: normalizeCount(
      bunkConfigurations.default_twin_over_twin,
    ),
    bed_count_twin_over_full_bunk: normalizeCount(
      bunkConfigurations.twin_over_full,
    ),
    bed_count_full_over_full_bunk: normalizeCount(
      bunkConfigurations.full_over_full,
    ),
    bed_count_queen_over_queen_bunk: normalizeCount(
      bunkConfigurations.queen_over_queen,
    ),
    bed_count_twin_over_queen_bunk: normalizeCount(
      bunkConfigurations.twin_over_queen,
    ),
    bed_count_twin_over_king_bunk: normalizeCount(
      bunkConfigurations.twin_over_king,
    ),
  };

  rollups.bed_count_bunk_total =
    rollups.bed_count_twin_over_twin_bunk +
    rollups.bed_count_twin_over_full_bunk +
    rollups.bed_count_full_over_full_bunk +
    rollups.bed_count_queen_over_queen_bunk +
    rollups.bed_count_twin_over_queen_bunk +
    rollups.bed_count_twin_over_king_bunk +
    normalizeCount(bedCounts.bunk_beds) +
    normalizeCount(bunkConfigurations.other);

  return normalizeSleepingRollups(rollups, input.expectedSleeps);
}

async function repairSleepForRow(input: {
  row: RepairRow;
  options: Options;
  apiKey: string;
}): Promise<{
  repaired: boolean;
  resolvedBy: string;
  model: string | null;
  message: string;
}> {
  const sourceSnapshot = asObject(input.row.source_snapshot_payload);
  const outputPayload = asObject(input.row.output_payload);
  const auditPayload = asObject(input.row.audit_payload);

  const expectedSleepsRaw = asNumber(sourceSnapshot.sleeps);
  const expectedSleeps =
    expectedSleepsRaw === null
      ? null
      : Math.max(0, Math.round(expectedSleepsRaw));

  let currentArrangements = normalizeSleepingArrangements(
    outputPayload.sleeping_arrangements,
  );
  let currentSummary = asObject(outputPayload.sleeping_summary);
  let currentRollups =
    currentArrangements.length > 0
      ? deriveRollupsFromArrangements(currentArrangements, expectedSleeps)
      : deriveRollupsFromSleepingSummary({
          summary: currentSummary,
          expectedSleeps,
        });

  const attempts: string[] = [];
  const attemptErrors: string[] = [];

  const attemptModel = async (model: string): Promise<boolean> => {
    attempts.push(model);
    const modelResult = await callSleepResolutionModel({
      apiKey: input.apiKey,
      model,
      expectedSleeps,
      sourceSnapshot,
      currentArrangements,
      currentRollups,
    });

    currentArrangements = modelResult.arrangements;
    currentSummary = modelResult.summary;
    currentRollups =
      currentArrangements.length > 0
        ? deriveRollupsFromArrangements(currentArrangements, expectedSleeps)
        : deriveRollupsFromSleepingSummary({
            summary: currentSummary,
            expectedSleeps,
          });
    const match = evaluateSleepCapacityMatch({
      rollups: currentRollups,
      expectedSleeps,
    });

    return match.matches;
  };

  let resolvedBy: SleepRepairAttemptResult["resolvedBy"] = "none";
  let modelUsed: string | null = null;

  try {
    const primaryResolved = await attemptModel(input.options.primaryModel);
    if (primaryResolved) {
      resolvedBy = "primary";
      modelUsed = input.options.primaryModel;
    }
  } catch (error: unknown) {
    attemptErrors.push(
      `primary:${error instanceof Error ? error.message : String(error)}`,
    );
    // fall through to secondary/deterministic
  }

  if (resolvedBy === "none" && input.options.secondaryModel) {
    try {
      const secondaryResolved = await attemptModel(
        input.options.secondaryModel,
      );
      if (secondaryResolved) {
        resolvedBy = "secondary";
        modelUsed = input.options.secondaryModel;
      }
    } catch (error: unknown) {
      attemptErrors.push(
        `secondary:${error instanceof Error ? error.message : String(error)}`,
      );
      // deterministic fallback will decide final state
    }
  }

  if (resolvedBy === "none" && input.options.deterministicFallback) {
    const deterministic = deterministicSleepRepair({
      rollups: currentRollups,
      arrangements: currentArrangements,
      expectedSleeps,
    });
    currentRollups = deterministic.rollups;
    currentArrangements = deterministic.arrangements;
    const deterministicMatch = evaluateSleepCapacityMatch({
      rollups: currentRollups,
      expectedSleeps,
    });
    if (deterministicMatch.matches) {
      resolvedBy = "deterministic";
      modelUsed = null;
    }
  }

  const finalMatch = evaluateSleepCapacityMatch({
    rollups: currentRollups,
    expectedSleeps,
  });
  const tolerancePass = isSleepTolerancePass(finalMatch, currentRollups);
  const repaired = finalMatch.matches || tolerancePass;

  const nextOutputPayload = {
    ...outputPayload,
    sleeping_arrangements: currentArrangements,
    sleeping_summary:
      Object.keys(currentSummary).length > 0
        ? currentSummary
        : buildSleepingSummaryFromRollups(currentRollups, expectedSleeps),
  } as Record<string, unknown>;

  const nextAuditPayload = {
    ...auditPayload,
    deterministic_sleep_capacity_from_rollups: finalMatch.derived,
    deterministic_sleep_capacity_target: finalMatch.target,
    deterministic_sleep_capacity_delta: finalMatch.delta,
    deterministic_sleep_capacity_match: finalMatch.matches,
    deterministic_sleep_environment_present:
      hasMeaningfulSleepEnvironment(currentRollups),
    deterministic_sleep_capacity_tolerance_pass: tolerancePass,
    audit_passed: repaired,
    sleep_repair: {
      attempted_models: attempts,
      attempt_errors: attemptErrors,
      resolved_by: resolvedBy,
      repaired,
      repaired_at: new Date().toISOString(),
    },
  } as Record<string, unknown>;

  if (!input.options.dryRun && pgDb) {
    const now = new Date().toISOString();
    const outputHash = createHash("sha256")
      .update(JSON.stringify(nextOutputPayload))
      .digest("hex");

    await pgDb
      .update(listing_ai_enrichment)
      .set({
        output_payload: nextOutputPayload,
        output_hash: outputHash,
        audit_payload: nextAuditPayload,
        status: repaired ? "completed" : input.row.status,
        model: modelUsed ?? input.row.model,
        updated_at: now,
      })
      .where(eq(listing_ai_enrichment.id, input.row.id));
  }

  return {
    repaired,
    resolvedBy,
    model: modelUsed,
    message: repaired
      ? `repaired resolved_by=${resolvedBy}`
      : `not_repaired delta=${finalMatch.delta}`,
  };
}

async function run(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const progress = createScrapeProgress({
    script: "ai-enrichment-sleep-repair",
  });

  if (!pgDb) {
    throw new Error("Postgres database is not configured.");
  }

  const apiKey = getOpenAiApiKey();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is missing.");
  }

  if (options.externalListingId && !options.adapterKey) {
    throw new Error(
      "--external-listing-id requires --adapter-key to avoid cross-adapter ambiguity.",
    );
  }

  const predicates = [];
  if (!options.includeAuditPassed) {
    predicates.push(
      sql`(${listing_ai_enrichment.audit_payload}->>'audit_passed')::boolean = false`,
    );
  }

  if (options.adapterKey) {
    predicates.push(eq(listing_ai_enrichment.adapter_key, options.adapterKey));
  }

  if (options.listingId) {
    predicates.push(eq(listing_ai_enrichment.listing_id, options.listingId));
  }

  if (options.externalListingId) {
    const sourceLinkRows = await pgDb
      .select({ id: listing_source_link.id })
      .from(listing_source_link)
      .where(
        and(
          eq(listing_source_link.adapter_key, options.adapterKey!),
          eq(
            listing_source_link.external_listing_id,
            options.externalListingId,
          ),
        ),
      );

    const sourceLinkIds = sourceLinkRows
      .map((row) => row.id)
      .filter((value) => value.trim().length > 0);

    if (sourceLinkIds.length === 0) {
      predicates.push(sql`1 = 0`);
    } else {
      predicates.push(
        inArray(listing_ai_enrichment.source_link_id, sourceLinkIds),
      );
    }
  }

  const rows = await pgDb
    .select({
      id: listing_ai_enrichment.id,
      listing_id: listing_ai_enrichment.listing_id,
      status: listing_ai_enrichment.status,
      model: listing_ai_enrichment.model,
      source_snapshot_payload: listing_ai_enrichment.source_snapshot_payload,
      output_payload: listing_ai_enrichment.output_payload,
      audit_payload: listing_ai_enrichment.audit_payload,
    })
    .from(listing_ai_enrichment)
    .where(and(...predicates))
    .orderBy(listing_ai_enrichment.updated_at)
    .limit(options.limit);

  progress.phase(
    `starting sleep repair selected=${rows.length} concurrency=${options.concurrency} primary_model=${options.primaryModel} secondary_model=${options.secondaryModel ?? "none"} deterministic_fallback=${options.deterministicFallback} dry_run=${options.dryRun} include_audit_passed=${options.includeAuditPassed}`,
  );

  let processed = 0;
  let repaired = 0;
  let unresolved = 0;
  let resolvedPrimary = 0;
  let resolvedSecondary = 0;
  let resolvedDeterministic = 0;

  await runWithConcurrency(rows, options.concurrency, async (row) => {
    const result = await repairSleepForRow({
      row,
      options,
      apiKey,
    });

    processed += 1;
    if (result.repaired) {
      repaired += 1;
      if (result.resolvedBy === "primary") {
        resolvedPrimary += 1;
      } else if (result.resolvedBy === "secondary") {
        resolvedSecondary += 1;
      } else if (result.resolvedBy === "deterministic") {
        resolvedDeterministic += 1;
      }
    } else {
      unresolved += 1;
    }

    const shouldEmit =
      processed % options.progressEvery === 0 || processed === rows.length;
    if (shouldEmit) {
      progress.progress(
        `processed=${processed}/${rows.length} repaired=${repaired} unresolved=${unresolved} primary=${resolvedPrimary} secondary=${resolvedSecondary} deterministic=${resolvedDeterministic}`,
      );
    }
  });

  progress.success(
    `sleep repair complete selected=${rows.length} processed=${processed} repaired=${repaired} unresolved=${unresolved} primary=${resolvedPrimary} secondary=${resolvedSecondary} deterministic=${resolvedDeterministic} dry_run=${options.dryRun}`,
  );

  console.log("listing_ai_enrichment_sleep_repair_complete");
  console.log(`- selected: ${rows.length}`);
  console.log(`- processed: ${processed}`);
  console.log(`- repaired: ${repaired}`);
  console.log(`- unresolved: ${unresolved}`);
  console.log(`- resolved_primary_model: ${resolvedPrimary}`);
  console.log(`- resolved_secondary_model: ${resolvedSecondary}`);
  console.log(`- resolved_deterministic: ${resolvedDeterministic}`);
  if (!options.includeAuditPassed) {
    const remaining = await pgDb
      .select({
        count: sql<number>`count(*)::int`,
      })
      .from(listing_ai_enrichment)
      .where(
        sql`(${listing_ai_enrichment.audit_payload}->>'audit_passed')::boolean = false`,
      );

    const remainingCount = remaining[0]?.count ?? 0;
    console.log(`- remaining_audit_false: ${remainingCount}`);
  } else {
    console.log("- remaining_audit_false: skipped (include_audit_passed=true)");
  }
  console.log(`- dry_run: ${options.dryRun}`);

  return unresolved > 0 ? 1 : 0;
}

run()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`run-ai-enrichment-sleep-repair failed: ${message}`);
    process.exit(1);
  });
