import { randomUUID } from "node:crypto";

import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";

import { pgDb } from "@/core/server/db";
import { listing, listing_ai_enrichment } from "@/lib/db/schema-postgres";
import type { ListingAiEnrichmentSourceSnapshotPayload } from "@/lib/listings/enrichment/contracts";
import {
  LISTING_REFINEMENT_PROMPT_VERSION,
  type ListingRefinementSnapshot,
  type RefinementResult,
  generateListingRefinement,
  loadListingRefinementSnapshot,
  persistListingRefinement,
} from "@/lib/listings/refinement/listing-refinement-service";

export type EnrichmentSeedInput = {
  listingId: string;
  sourceLinkId: string | null;
  adapterKey: string;
  sourceContentHash: string;
  sourceSnapshot: ListingAiEnrichmentSourceSnapshotPayload;
};

export type PendingEnrichmentRow = {
  id: string;
  listing_id: string;
  adapter_key: string | null;
  source_content_hash: string;
  prompt_version: string;
};

export type PendingEnrichmentProcessResult = {
  selected: number;
  processed: number;
  completed: number;
  failed: number;
  skipped_missing_snapshot: number;
  dry_run: boolean;
};

export type PendingEnrichmentProgressOutcome =
  | "start"
  | "heartbeat"
  | "completed"
  | "failed"
  | "skipped_missing_snapshot"
  | "end";

export type PendingEnrichmentProgressEvent = {
  outcome: PendingEnrichmentProgressOutcome;
  selected: number;
  processed: number;
  completed: number;
  failed: number;
  skipped_missing_snapshot: number;
  dry_run: boolean;
  started_at_ms: number;
  elapsed_ms: number;
  listing_id?: string;
  row_id?: string;
  model?: string;
  message?: string;
};

export type EnrichmentApplyResult = {
  selected: number;
  compared: number;
  updated: number;
  unchanged: number;
  dry_run: boolean;
};

const LISTING_ENRICHMENT_TARGET_FIELDS = [
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
] as const;

type ListingEnrichmentTargetField =
  (typeof LISTING_ENRICHMENT_TARGET_FIELDS)[number];

export type ListingEnrichmentFieldUpdate = {
  field: ListingEnrichmentTargetField;
  reason: "fill_missing" | "overwrite_changed";
  current_value: unknown;
  proposed_value: unknown;
};

export type ListingEnrichmentApplyCandidate = {
  listing_id: string;
  enrichment_id: string;
  adapter_key: string | null;
  field_updates: ListingEnrichmentFieldUpdate[];
};

export type ListingEnrichmentApplyEvaluation = {
  selected: number;
  compared: number;
  candidates: number;
  unchanged: number;
  rows_fill_missing_only: number;
  rows_with_overwrite_changed: number;
  rows_with_mixed_updates: number;
  fill_missing_field_updates: number;
  overwrite_changed_field_updates: number;
  by_field: Record<
    ListingEnrichmentTargetField,
    { fill_missing: number; overwrite_changed: number }
  >;
  by_adapter: Record<
    string,
    {
      selected: number;
      candidates: number;
      unchanged: number;
      rows_fill_missing_only: number;
      rows_with_overwrite_changed: number;
      rows_with_mixed_updates: number;
      fill_missing_field_updates: number;
      overwrite_changed_field_updates: number;
      total_field_updates: number;
    }
  >;
  rows: ListingEnrichmentApplyCandidate[];
};

export async function executeListingAiEnrichment(input: {
  snapshot: ListingRefinementSnapshot;
  model?: string;
  persist: boolean;
}): Promise<RefinementResult> {
  const result = await generateListingRefinement({
    snapshot: input.snapshot,
    model: input.model,
  });

  if (input.persist) {
    await persistListingRefinement({ snapshot: input.snapshot, result });
  }

  return result;
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

function buildListingProjectionFromEnrichment(
  outputPayload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    description_markdown: outputPayload.description_markdown ?? null,
    description_short_plain: outputPayload.description_short_plain ?? null,
    seo_meta_title: outputPayload.seo_meta_title ?? null,
    seo_meta_description: outputPayload.seo_meta_description ?? null,
    seo_hidden_summary_plain: outputPayload.seo_hidden_summary_plain ?? null,
    highlights: outputPayload.highlights ?? [],
    helpful_hints: outputPayload.helpful_hints ?? [],
    sleeping_arrangements: outputPayload.sleeping_arrangements ?? [],
    sleeping_rollups: outputPayload.sleeping_rollups ?? {},
    amenities_normalized: outputPayload.amenities_normalized ?? [],
  };
}

function buildListingProjectionFromListingRow(row: {
  description_markdown: string | null;
  description_short_plain: string | null;
  seo_meta_title: string | null;
  seo_meta_description: string | null;
  seo_hidden_summary_plain: string | null;
  highlights: unknown;
  helpful_hints: unknown;
  sleeping_arrangements: unknown;
  sleeping_rollups: unknown;
  amenities_normalized: unknown;
}): Record<string, unknown> {
  return {
    description_markdown: row.description_markdown ?? null,
    description_short_plain: row.description_short_plain ?? null,
    seo_meta_title: row.seo_meta_title ?? null,
    seo_meta_description: row.seo_meta_description ?? null,
    seo_hidden_summary_plain: row.seo_hidden_summary_plain ?? null,
    highlights: row.highlights ?? [],
    helpful_hints: row.helpful_hints ?? [],
    sleeping_arrangements: row.sleeping_arrangements ?? [],
    sleeping_rollups: row.sleeping_rollups ?? {},
    amenities_normalized: row.amenities_normalized ?? [],
  };
}

function isMissingListingValue(value: unknown): boolean {
  if (value === null || value === undefined) {
    return true;
  }

  if (typeof value === "string") {
    return value.trim().length === 0;
  }

  if (Array.isArray(value)) {
    return value.length === 0;
  }

  if (typeof value === "object") {
    return Object.keys(value as Record<string, unknown>).length === 0;
  }

  return false;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isAuditEligibleForApply(auditPayload: unknown): boolean {
  const payload = asObject(auditPayload);

  const sleepTolerancePass =
    payload.deterministic_sleep_capacity_tolerance_pass;
  const sleepMatch = payload.deterministic_sleep_capacity_match;

  if (sleepMatch === false && sleepTolerancePass !== true) {
    return false;
  }

  if (typeof payload.audit_passed === "boolean") {
    return payload.audit_passed;
  }

  const callStatus = asString(payload.audit_call_status);
  if (callStatus === "failed_or_unparsed") {
    return false;
  }

  const audit = asObject(payload.audit);
  const scoreValue = audit.accuracy_score;
  const score =
    typeof scoreValue === "number"
      ? scoreValue
      : typeof scoreValue === "string"
        ? Number(scoreValue)
        : null;

  if (Number.isFinite(score) && Number(score) < 0.9) {
    return false;
  }

  if (audit.retry_recommended === true) {
    return false;
  }

  return true;
}

async function runWithConcurrency<T>(input: {
  items: T[];
  concurrency: number;
  worker: (item: T) => Promise<void>;
}): Promise<void> {
  const lanes = Array.from({ length: Math.max(1, input.concurrency) }, () =>
    Promise.resolve(),
  );

  let cursor = 0;
  for (let i = 0; i < lanes.length; i += 1) {
    lanes[i] = (async () => {
      while (cursor < input.items.length) {
        const index = cursor;
        cursor += 1;
        await input.worker(input.items[index]);
      }
    })();
  }

  await Promise.all(lanes);
}

export async function seedListingAiEnrichmentFromIngest(
  input: EnrichmentSeedInput,
): Promise<void> {
  if (!pgDb) {
    throw new Error("Postgres database is not configured.");
  }

  const now = new Date().toISOString();

  await pgDb
    .insert(listing_ai_enrichment)
    .values({
      id: `lae_${randomUUID().replace(/-/g, "")}`,
      listing_id: input.listingId,
      source_link_id: input.sourceLinkId,
      adapter_key: input.adapterKey,
      source_content_hash: input.sourceContentHash,
      status: "pending",
      model: null,
      audit_model: null,
      prompt_version: LISTING_REFINEMENT_PROMPT_VERSION,
      output_hash: null,
      source_snapshot_payload: input.sourceSnapshot,
      output_payload: {},
      usage_payload: {},
      audit_payload: {},
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
        source_link_id: input.sourceLinkId,
        adapter_key: input.adapterKey,
        source_snapshot_payload: input.sourceSnapshot,
        updated_at: now,
      },
    });
}

export async function selectPendingListingAiEnrichment(input: {
  limit: number;
  adapterKey?: string;
  listingId?: string;
}): Promise<PendingEnrichmentRow[]> {
  if (!pgDb) {
    throw new Error("Postgres database is not configured.");
  }

  const predicates = [
    eq(listing_ai_enrichment.status, "pending"),
    eq(listing_ai_enrichment.prompt_version, LISTING_REFINEMENT_PROMPT_VERSION),
  ];

  if (input.adapterKey) {
    predicates.push(eq(listing_ai_enrichment.adapter_key, input.adapterKey));
  }

  if (input.listingId) {
    predicates.push(eq(listing_ai_enrichment.listing_id, input.listingId));
  }

  return pgDb
    .select({
      id: listing_ai_enrichment.id,
      listing_id: listing_ai_enrichment.listing_id,
      adapter_key: listing_ai_enrichment.adapter_key,
      source_content_hash: listing_ai_enrichment.source_content_hash,
      prompt_version: listing_ai_enrichment.prompt_version,
    })
    .from(listing_ai_enrichment)
    .where(and(...predicates))
    .orderBy(desc(listing_ai_enrichment.updated_at))
    .limit(Math.max(1, input.limit));
}

export async function processPendingListingAiEnrichment(input: {
  limit: number;
  concurrency: number;
  model?: string;
  adapterKey?: string;
  listingId?: string;
  dryRun: boolean;
  progressEvery?: number;
  heartbeatIntervalMs?: number;
  onProgress?: (event: PendingEnrichmentProgressEvent) => void | Promise<void>;
}): Promise<PendingEnrichmentProcessResult> {
  const startedAtMs = Date.now();
  const progressEvery = Math.max(1, Math.floor(input.progressEvery ?? 1));
  const heartbeatIntervalMs = Math.max(
    1000,
    Math.floor(input.heartbeatIntervalMs ?? 15_000),
  );
  const pending = await selectPendingListingAiEnrichment({
    limit: input.limit,
    adapterKey: input.adapterKey,
    listingId: input.listingId,
  });

  const summary: PendingEnrichmentProcessResult = {
    selected: pending.length,
    processed: 0,
    completed: 0,
    failed: 0,
    skipped_missing_snapshot: 0,
    dry_run: input.dryRun,
  };

  const emitProgress = async (
    event: Omit<
      PendingEnrichmentProgressEvent,
      | "selected"
      | "processed"
      | "completed"
      | "failed"
      | "skipped_missing_snapshot"
      | "dry_run"
      | "started_at_ms"
      | "elapsed_ms"
    >,
  ): Promise<void> => {
    if (!input.onProgress) {
      return;
    }

    try {
      await input.onProgress({
        ...event,
        selected: summary.selected,
        processed: summary.processed,
        completed: summary.completed,
        failed: summary.failed,
        skipped_missing_snapshot: summary.skipped_missing_snapshot,
        dry_run: summary.dry_run,
        started_at_ms: startedAtMs,
        elapsed_ms: Math.max(0, Date.now() - startedAtMs),
      });
    } catch {
      // Logging callbacks should never fail the enrichment pipeline.
    }
  };

  await emitProgress({
    outcome: "start",
  });

  const heartbeatInterval =
    summary.selected > 0
      ? setInterval(() => {
          if (summary.processed >= summary.selected) {
            return;
          }

          void emitProgress({
            outcome: "heartbeat",
            message: "pending_heartbeat",
          });
        }, heartbeatIntervalMs)
      : null;

  try {
    await runWithConcurrency({
      items: pending,
      concurrency: input.concurrency,
      worker: async (row) => {
        summary.processed += 1;
        const snapshot = await loadListingRefinementSnapshot({
          listingId: row.listing_id,
        });

        if (!snapshot) {
          summary.skipped_missing_snapshot += 1;
          if (pgDb && !input.dryRun) {
            await pgDb
              .update(listing_ai_enrichment)
              .set({
                status: "failed",
                audit_payload: {
                  error: "snapshot_not_found",
                },
                updated_at: new Date().toISOString(),
              })
              .where(eq(listing_ai_enrichment.id, row.id));
          }

          const shouldEmit =
            summary.processed % progressEvery === 0 ||
            summary.processed === summary.selected;
          if (shouldEmit) {
            await emitProgress({
              outcome: "skipped_missing_snapshot",
              listing_id: row.listing_id,
              row_id: row.id,
              message: "snapshot_not_found",
            });
          }
          return;
        }

        try {
          const result = await generateListingRefinement({
            snapshot,
            model: input.model,
          });

          if (!input.dryRun) {
            await persistListingRefinement({ snapshot, result });
          }

          summary.completed += 1;
          const shouldEmit =
            summary.processed % progressEvery === 0 ||
            summary.processed === summary.selected;
          if (shouldEmit) {
            await emitProgress({
              outcome: "completed",
              listing_id: row.listing_id,
              row_id: row.id,
              model: result.model,
            });
          }
        } catch (error) {
          summary.failed += 1;
          const message =
            error instanceof Error ? error.message : String(error);
          if (!input.dryRun && pgDb) {
            await pgDb
              .update(listing_ai_enrichment)
              .set({
                status: "failed",
                audit_payload: {
                  error: message,
                },
                updated_at: new Date().toISOString(),
              })
              .where(eq(listing_ai_enrichment.id, row.id));
          }

          await emitProgress({
            outcome: "failed",
            listing_id: row.listing_id,
            row_id: row.id,
            message,
          });
        }
      },
    });
  } finally {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
    }
  }

  await emitProgress({
    outcome: "end",
  });

  return summary;
}

export async function applyListingAiEnrichmentToListings(input: {
  limit?: number;
  adapterKey?: string;
  listingId?: string;
  dryRun: boolean;
}): Promise<EnrichmentApplyResult> {
  if (!pgDb) {
    throw new Error("Postgres database is not configured.");
  }

  if (!input.dryRun) {
    const failingAuditRowsResult = await pgDb
      .select({
        count: sql<number>`count(*)::int`,
      })
      .from(listing_ai_enrichment)
      .where(
        sql`case
          when jsonb_typeof(${listing_ai_enrichment.audit_payload}->'audit_passed') = 'boolean'
          then (${listing_ai_enrichment.audit_payload}->>'audit_passed')::boolean
          else false
        end = false`,
      );

    const failingAuditRows = failingAuditRowsResult[0]?.count ?? 0;
    if (failingAuditRows > 0) {
      throw new Error(
        `Apply blocked: ${failingAuditRows} enrichment rows still have audit_passed=false. Resolve all failing enrichment rows before applying listing updates.`,
      );
    }
  }

  const predicates = [
    inArray(listing_ai_enrichment.status, ["completed", "applied"]),
    isNotNull(listing_ai_enrichment.output_hash),
  ];
  if (input.adapterKey) {
    predicates.push(eq(listing_ai_enrichment.adapter_key, input.adapterKey));
  }
  if (input.listingId) {
    predicates.push(eq(listing_ai_enrichment.listing_id, input.listingId));
  }

  const candidates = await pgDb
    .select({
      id: listing_ai_enrichment.id,
      listing_id: listing_ai_enrichment.listing_id,
      adapter_key: listing_ai_enrichment.adapter_key,
      source_content_hash: listing_ai_enrichment.source_content_hash,
      status: listing_ai_enrichment.status,
      audit_payload: listing_ai_enrichment.audit_payload,
      output_hash: listing_ai_enrichment.output_hash,
      output_payload: listing_ai_enrichment.output_payload,
      generated_at: listing_ai_enrichment.generated_at,
    })
    .from(listing_ai_enrichment)
    .where(and(...predicates))
    .orderBy(
      desc(listing_ai_enrichment.generated_at),
      desc(listing_ai_enrichment.updated_at),
    );

  const latestByListing = new Map<string, (typeof candidates)[number]>();
  const latestAppliedByListing = new Map<string, (typeof candidates)[number]>();
  const effectiveLimit =
    typeof input.limit === "number" && Number.isFinite(input.limit)
      ? Math.max(0, Math.floor(input.limit))
      : 0;

  for (const row of candidates) {
    if (!latestByListing.has(row.listing_id)) {
      latestByListing.set(row.listing_id, row);
    }
    if (
      row.status === "applied" &&
      !latestAppliedByListing.has(row.listing_id)
    ) {
      latestAppliedByListing.set(row.listing_id, row);
    }
    if (effectiveLimit > 0 && latestByListing.size >= effectiveLimit) {
      break;
    }
  }

  const latestRows = Array.from(latestByListing.values());
  const listingRows = await pgDb
    .select({
      id: listing.id,
      description_markdown: listing.description_markdown,
      description_short_plain: listing.description_short_plain,
      seo_meta_title: listing.seo_meta_title,
      seo_meta_description: listing.seo_meta_description,
      seo_hidden_summary_plain: listing.seo_hidden_summary_plain,
      highlights: listing.highlights,
      helpful_hints: listing.helpful_hints,
      sleeping_arrangements: listing.sleeping_arrangements,
      sleeping_rollups: listing.sleeping_rollups,
      amenities_normalized: listing.amenities_normalized,
    })
    .from(listing)
    .where(
      inArray(
        listing.id,
        latestRows.map((row) => row.listing_id),
      ),
    );

  const listingById = new Map(listingRows.map((row) => [row.id, row]));

  const selected = latestRows.filter((row) => {
    if (!isAuditEligibleForApply(row.audit_payload)) {
      return false;
    }

    const listingRow = listingById.get(row.listing_id);
    if (!listingRow) {
      return false;
    }

    const currentProjection = buildListingProjectionFromListingRow(listingRow);
    const hasMissingTargetField = LISTING_ENRICHMENT_TARGET_FIELDS.some(
      (field) => isMissingListingValue(currentProjection[field]),
    );

    if (hasMissingTargetField) {
      return true;
    }

    const applied = latestAppliedByListing.get(row.listing_id);
    if (!applied) {
      return false;
    }

    return applied.source_content_hash !== row.source_content_hash;
  });

  const summary: EnrichmentApplyResult = {
    selected: selected.length,
    compared: 0,
    updated: 0,
    unchanged: 0,
    dry_run: input.dryRun,
  };

  for (const row of selected) {
    summary.compared += 1;
    const listingRow = listingById.get(row.listing_id);
    if (!listingRow) {
      continue;
    }

    const enrichmentProjection = buildListingProjectionFromEnrichment(
      asObject(row.output_payload),
    );

    summary.updated += 1;

    if (!input.dryRun) {
      const now = new Date().toISOString();
      await pgDb
        .update(listing)
        .set({
          description_markdown:
            (enrichmentProjection.description_markdown as string | null) ??
            null,
          description_short_plain:
            (enrichmentProjection.description_short_plain as string | null) ??
            null,
          seo_meta_title:
            (enrichmentProjection.seo_meta_title as string | null) ?? null,
          seo_meta_description:
            (enrichmentProjection.seo_meta_description as string | null) ??
            null,
          seo_hidden_summary_plain:
            (enrichmentProjection.seo_hidden_summary_plain as string | null) ??
            null,
          highlights: enrichmentProjection.highlights,
          helpful_hints: enrichmentProjection.helpful_hints,
          sleeping_arrangements: enrichmentProjection.sleeping_arrangements,
          sleeping_rollups: enrichmentProjection.sleeping_rollups,
          amenities_normalized: enrichmentProjection.amenities_normalized,
          content_generated_at: now,
          content_version: sql`${listing.content_version} + 1`,
          updated_at: now,
        })
        .where(eq(listing.id, row.listing_id));

      await pgDb
        .update(listing_ai_enrichment)
        .set({
          status: "applied",
          applied_at: now,
          updated_at: now,
        })
        .where(eq(listing_ai_enrichment.id, row.id));
    }
  }

  return summary;
}

export async function evaluateListingAiEnrichmentApplyCandidates(input: {
  limit?: number;
  adapterKey?: string;
  listingId?: string;
}): Promise<ListingEnrichmentApplyEvaluation> {
  if (!pgDb) {
    throw new Error("Postgres database is not configured.");
  }

  const predicates = [
    inArray(listing_ai_enrichment.status, ["completed", "applied"]),
    isNotNull(listing_ai_enrichment.output_hash),
  ];
  if (input.adapterKey) {
    predicates.push(eq(listing_ai_enrichment.adapter_key, input.adapterKey));
  }
  if (input.listingId) {
    predicates.push(eq(listing_ai_enrichment.listing_id, input.listingId));
  }

  const candidates = await pgDb
    .select({
      id: listing_ai_enrichment.id,
      listing_id: listing_ai_enrichment.listing_id,
      adapter_key: listing_ai_enrichment.adapter_key,
      source_content_hash: listing_ai_enrichment.source_content_hash,
      status: listing_ai_enrichment.status,
      audit_payload: listing_ai_enrichment.audit_payload,
      output_payload: listing_ai_enrichment.output_payload,
      generated_at: listing_ai_enrichment.generated_at,
      updated_at: listing_ai_enrichment.updated_at,
    })
    .from(listing_ai_enrichment)
    .where(and(...predicates))
    .orderBy(
      desc(listing_ai_enrichment.generated_at),
      desc(listing_ai_enrichment.updated_at),
    );

  const latestByListing = new Map<string, (typeof candidates)[number]>();
  const latestAppliedByListing = new Map<string, (typeof candidates)[number]>();
  const effectiveLimit =
    typeof input.limit === "number" && Number.isFinite(input.limit)
      ? Math.max(0, Math.floor(input.limit))
      : 0;

  for (const row of candidates) {
    if (!latestByListing.has(row.listing_id)) {
      latestByListing.set(row.listing_id, row);
    }
    if (
      row.status === "applied" &&
      !latestAppliedByListing.has(row.listing_id)
    ) {
      latestAppliedByListing.set(row.listing_id, row);
    }
    if (effectiveLimit > 0 && latestByListing.size >= effectiveLimit) {
      break;
    }
  }

  const considered = Array.from(latestByListing.values());
  if (considered.length === 0) {
    return {
      selected: 0,
      compared: 0,
      candidates: 0,
      unchanged: 0,
      rows_fill_missing_only: 0,
      rows_with_overwrite_changed: 0,
      rows_with_mixed_updates: 0,
      fill_missing_field_updates: 0,
      overwrite_changed_field_updates: 0,
      by_field: Object.fromEntries(
        LISTING_ENRICHMENT_TARGET_FIELDS.map((field) => [
          field,
          { fill_missing: 0, overwrite_changed: 0 },
        ]),
      ) as ListingEnrichmentApplyEvaluation["by_field"],
      by_adapter: {},
      rows: [],
    };
  }

  const listingIds = considered.map((row) => row.listing_id);
  const listingRows = await pgDb
    .select({
      id: listing.id,
      description_markdown: listing.description_markdown,
      description_short_plain: listing.description_short_plain,
      seo_meta_title: listing.seo_meta_title,
      seo_meta_description: listing.seo_meta_description,
      seo_hidden_summary_plain: listing.seo_hidden_summary_plain,
      highlights: listing.highlights,
      helpful_hints: listing.helpful_hints,
      sleeping_arrangements: listing.sleeping_arrangements,
      sleeping_rollups: listing.sleeping_rollups,
      amenities_normalized: listing.amenities_normalized,
    })
    .from(listing)
    .where(inArray(listing.id, listingIds));

  const listingById = new Map(listingRows.map((row) => [row.id, row]));

  const byField: ListingEnrichmentApplyEvaluation["by_field"] =
    Object.fromEntries(
      LISTING_ENRICHMENT_TARGET_FIELDS.map((field) => [
        field,
        { fill_missing: 0, overwrite_changed: 0 },
      ]),
    ) as ListingEnrichmentApplyEvaluation["by_field"];

  const rows: ListingEnrichmentApplyCandidate[] = [];
  const byAdapter: ListingEnrichmentApplyEvaluation["by_adapter"] = {};
  let unchanged = 0;
  let rowsFillMissingOnly = 0;
  let rowsWithOverwriteChanged = 0;
  const rowsWithMixedUpdates = 0;
  let fillMissingFieldUpdates = 0;
  let overwriteChangedFieldUpdates = 0;

  for (const selectedRow of considered) {
    if (!isAuditEligibleForApply(selectedRow.audit_payload)) {
      continue;
    }

    const currentListing = listingById.get(selectedRow.listing_id);
    if (!currentListing) {
      continue;
    }

    const adapterKey = selectedRow.adapter_key?.trim() || "unknown";
    if (!byAdapter[adapterKey]) {
      byAdapter[adapterKey] = {
        selected: 0,
        candidates: 0,
        unchanged: 0,
        rows_fill_missing_only: 0,
        rows_with_overwrite_changed: 0,
        rows_with_mixed_updates: 0,
        fill_missing_field_updates: 0,
        overwrite_changed_field_updates: 0,
        total_field_updates: 0,
      };
    }
    byAdapter[adapterKey].selected += 1;

    const currentProjection =
      buildListingProjectionFromListingRow(currentListing);
    const enrichmentProjection = buildListingProjectionFromEnrichment(
      asObject(selectedRow.output_payload),
    );

    const hasMissingTargetField = LISTING_ENRICHMENT_TARGET_FIELDS.some(
      (field) => isMissingListingValue(currentProjection[field]),
    );
    const applied = latestAppliedByListing.get(selectedRow.listing_id);
    const hasNewSourceHash =
      Boolean(applied) &&
      applied.source_content_hash !== selectedRow.source_content_hash;
    const shouldSelect = hasMissingTargetField || hasNewSourceHash;

    const fieldUpdates: ListingEnrichmentFieldUpdate[] = [];
    let rowFillMissingCount = 0;
    let rowOverwriteChangedCount = 0;

    for (const field of LISTING_ENRICHMENT_TARGET_FIELDS) {
      const currentValue = currentProjection[field];
      const proposedValue = enrichmentProjection[field];

      if (valuesEqual(currentValue, proposedValue)) {
        continue;
      }

      const reason: ListingEnrichmentFieldUpdate["reason"] =
        isMissingListingValue(currentValue)
          ? "fill_missing"
          : "overwrite_changed";

      if (reason === "fill_missing") {
        fillMissingFieldUpdates += 1;
        rowFillMissingCount += 1;
        byField[field].fill_missing += 1;
      } else {
        overwriteChangedFieldUpdates += 1;
        rowOverwriteChangedCount += 1;
        byField[field].overwrite_changed += 1;
      }

      fieldUpdates.push({
        field,
        reason,
        current_value: currentValue,
        proposed_value: proposedValue,
      });
    }

    if (!shouldSelect) {
      unchanged += 1;
      byAdapter[adapterKey].unchanged += 1;
      continue;
    }

    byAdapter[adapterKey].candidates += 1;

    if (hasMissingTargetField) {
      rowsFillMissingOnly += 1;
      byAdapter[adapterKey].rows_fill_missing_only += 1;
    } else {
      rowsWithOverwriteChanged += 1;
      byAdapter[adapterKey].rows_with_overwrite_changed += 1;
    }

    byAdapter[adapterKey].fill_missing_field_updates += rowFillMissingCount;
    byAdapter[adapterKey].overwrite_changed_field_updates +=
      rowOverwriteChangedCount;
    byAdapter[adapterKey].total_field_updates += fieldUpdates.length;

    rows.push({
      listing_id: selectedRow.listing_id,
      enrichment_id: selectedRow.id,
      adapter_key: selectedRow.adapter_key,
      field_updates: fieldUpdates,
    });
  }

  return {
    selected: considered.length,
    compared: considered.length,
    candidates: rows.length,
    unchanged,
    rows_fill_missing_only: rowsFillMissingOnly,
    rows_with_overwrite_changed: rowsWithOverwriteChanged,
    rows_with_mixed_updates: rowsWithMixedUpdates,
    fill_missing_field_updates: fillMissingFieldUpdates,
    overwrite_changed_field_updates: overwriteChangedFieldUpdates,
    by_field: byField,
    by_adapter: byAdapter,
    rows,
  };
}
