import "@/core/tooling/env/load-env-profile";

import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { pgDb } from "@/core/server/db";
import { listing_ai_enrichment } from "@/lib/db/schema-postgres";
import { LISTING_AI_ENRICHMENT_SOURCE_SNAPSHOT_REQUIRED_KEYS } from "@/lib/listings/enrichment/contracts";
import { computeSourceContentHashFromDescription } from "@/lib/listings/enrichment/source-content-hash";

type Options = {
  adapterKey: string | null;
  statuses: Array<"pending" | "completed" | "applied" | "failed">;
  limit: number;
  strict: boolean;
  latestPerListing: boolean;
};

type Severity = "error" | "warning";

type ValidationIssue = {
  severity: Severity;
  code: string;
  rowId: string;
  listingId: string;
  message: string;
};

type EnrichmentRow = {
  id: string;
  listing_id: string;
  status: string;
  source_content_hash: string;
  model: string | null;
  output_hash: string | null;
  source_snapshot_payload: unknown;
  output_payload: unknown;
  usage_payload: unknown;
  audit_payload: unknown;
  generated_at: string;
  applied_at: string | null;
  updated_at: string;
};

const VALID_STATUSES = ["pending", "completed", "applied", "failed"] as const;

function printUsage(): void {
  console.log("Validate AI Enrichment Rows");
  console.log("Usage:");
  console.log(
    "  tsx src/lib/scripts/run-ai-enrichment-validation.ts [--adapter-key <key>] [--status pending,completed,applied,failed] [--limit 500] [--strict]",
  );
  console.log("");
  console.log("Options:");
  console.log("  --adapter-key <key>  Restrict rows to one adapter");
  console.log(
    "  --status <csv>       Restrict statuses (default pending,completed,applied,failed)",
  );
  console.log("  --limit <n>          Max rows to validate (default 500)");
  console.log("  --strict             Treat warnings as failure");
  console.log(
    "  --all-rows           Validate all selected rows (default validates latest row per listing)",
  );
  console.log("  --help               Show help");
}

function parseStatuses(value: string): Options["statuses"] {
  const parsed = value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);

  const unique = Array.from(new Set(parsed));
  const statuses: Options["statuses"] = [];

  for (const status of unique) {
    if ((VALID_STATUSES as readonly string[]).includes(status)) {
      statuses.push(status as Options["statuses"][number]);
      continue;
    }
    throw new Error(`Invalid status: ${status}`);
  }

  if (statuses.length === 0) {
    throw new Error("At least one valid --status value is required.");
  }

  return statuses;
}

function parseArgs(argv: string[]): Options {
  let adapterKey: string | null = null;
  let statuses: Options["statuses"] = [...VALID_STATUSES];
  let limit = 500;
  let strict = false;
  let latestPerListing = true;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }

    if (arg === "--strict") {
      strict = true;
      continue;
    }

    if (arg === "--all-rows") {
      latestPerListing = false;
      continue;
    }

    if (arg === "--adapter-key" && next) {
      adapterKey = next.trim().toLowerCase() || null;
      i += 1;
      continue;
    }

    if (arg === "--status" && next) {
      statuses = parseStatuses(next);
      i += 1;
      continue;
    }

    if (arg === "--limit" && next) {
      const parsed = Number(next);
      if (Number.isFinite(parsed) && parsed > 0) {
        limit = Math.floor(parsed);
      }
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { adapterKey, statuses, limit, strict, latestPerListing };
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNullableString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return typeof value === "string" ? value : null;
}

function isNumberOrNull(value: unknown): boolean {
  return (
    value === null || (typeof value === "number" && Number.isFinite(value))
  );
}

function addIssue(
  issues: ValidationIssue[],
  input: Omit<ValidationIssue, "severity"> & { severity?: Severity },
): void {
  issues.push({
    severity: input.severity ?? "error",
    code: input.code,
    rowId: input.rowId,
    listingId: input.listingId,
    message: input.message,
  });
}

function validateSourceSnapshot(
  row: EnrichmentRow,
  issues: ValidationIssue[],
): void {
  const snapshot = asObject(row.source_snapshot_payload);

  const requiredKeys = LISTING_AI_ENRICHMENT_SOURCE_SNAPSHOT_REQUIRED_KEYS;

  for (const key of requiredKeys) {
    if (!(key in snapshot)) {
      addIssue(issues, {
        code: "source_snapshot_missing_key",
        rowId: row.id,
        listingId: row.listing_id,
        message: `source_snapshot_payload is missing key: ${key}`,
      });
    }
  }

  if (asString(snapshot.canonical_name).trim().length === 0) {
    addIssue(issues, {
      code: "source_snapshot_bad_canonical_name",
      rowId: row.id,
      listingId: row.listing_id,
      message:
        "source_snapshot_payload.canonical_name must be a non-empty string.",
    });
  }

  const descriptionExpanded = asNullableString(snapshot.description_expanded);
  if (descriptionExpanded === null) {
    addIssue(issues, {
      code: "source_snapshot_bad_description_expanded_type",
      rowId: row.id,
      listingId: row.listing_id,
      message:
        "source_snapshot_payload.description_expanded must be string|null.",
    });
  }

  const metaDescription = asNullableString(snapshot.meta_description);
  if (metaDescription === null && snapshot.meta_description !== null) {
    addIssue(issues, {
      code: "source_snapshot_bad_meta_description_type",
      rowId: row.id,
      listingId: row.listing_id,
      message: "source_snapshot_payload.meta_description must be string|null.",
    });
  }

  const propertyType = asNullableString(snapshot.property_type);
  if (propertyType === null && snapshot.property_type !== null) {
    addIssue(issues, {
      code: "source_snapshot_bad_property_type",
      rowId: row.id,
      listingId: row.listing_id,
      message: "source_snapshot_payload.property_type must be string|null.",
    });
  }

  if (!Array.isArray(snapshot.amenities)) {
    addIssue(issues, {
      code: "source_snapshot_bad_amenities",
      rowId: row.id,
      listingId: row.listing_id,
      message: "source_snapshot_payload.amenities must be an array.",
    });
  }

  if (!isNumberOrNull(snapshot.bedrooms)) {
    addIssue(issues, {
      code: "source_snapshot_bad_bedrooms",
      rowId: row.id,
      listingId: row.listing_id,
      message: "source_snapshot_payload.bedrooms must be number|null.",
    });
  }

  const bathroomsRaw = snapshot.bathrooms;
  const bathroomsTypeValid =
    bathroomsRaw === null ||
    typeof bathroomsRaw === "string" ||
    (typeof bathroomsRaw === "number" && Number.isFinite(bathroomsRaw));
  if (!bathroomsTypeValid) {
    addIssue(issues, {
      code: "source_snapshot_bad_bathrooms",
      rowId: row.id,
      listingId: row.listing_id,
      message: "source_snapshot_payload.bathrooms must be string|number|null.",
    });
  }

  if (!isNumberOrNull(snapshot.sleeps)) {
    addIssue(issues, {
      code: "source_snapshot_bad_sleeps",
      rowId: row.id,
      listingId: row.listing_id,
      message: "source_snapshot_payload.sleeps must be number|null.",
    });
  }

  const hasMaterialSource =
    (descriptionExpanded ?? "").trim().length > 0 ||
    (metaDescription ?? "").trim().length > 0 ||
    (Array.isArray(snapshot.amenities) && snapshot.amenities.length > 0);

  if (!hasMaterialSource) {
    addIssue(issues, {
      severity: "warning",
      code: "source_snapshot_sparse",
      rowId: row.id,
      listingId: row.listing_id,
      message:
        "source_snapshot_payload has no description_expanded, meta_description, or amenities values.",
    });
  }
}

function validateSourceHash(
  row: EnrichmentRow,
  issues: ValidationIssue[],
): void {
  const snapshot = asObject(row.source_snapshot_payload);
  const descriptionExpanded = asString(snapshot.description_expanded);
  const expected = computeSourceContentHashFromDescription(descriptionExpanded);

  if (expected !== row.source_content_hash) {
    addIssue(issues, {
      code: "source_hash_mismatch",
      rowId: row.id,
      listingId: row.listing_id,
      message: `source_content_hash mismatch (stored=${row.source_content_hash}, expected=${expected}).`,
    });
  }
}

function validateOutputPayload(
  row: EnrichmentRow,
  issues: ValidationIssue[],
): void {
  if (row.status !== "completed" && row.status !== "applied") {
    return;
  }

  const payload = asObject(row.output_payload);
  const requiredKeys = [
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
  ];

  for (const key of requiredKeys) {
    if (!(key in payload)) {
      addIssue(issues, {
        code: "output_payload_missing_key",
        rowId: row.id,
        listingId: row.listing_id,
        message: `output_payload is missing key: ${key}`,
      });
    }
  }

  const stringKeys = [
    "description_markdown",
    "description_short_plain",
    "seo_meta_title",
    "seo_meta_description",
    "seo_hidden_summary_plain",
  ];

  for (const key of stringKeys) {
    if (typeof payload[key] !== "string") {
      addIssue(issues, {
        code: "output_payload_bad_string",
        rowId: row.id,
        listingId: row.listing_id,
        message: `output_payload.${key} must be a string.`,
      });
    }
  }

  const arrayKeys = [
    "highlights",
    "helpful_hints",
    "sleeping_arrangements",
    "amenities_normalized",
  ];

  for (const key of arrayKeys) {
    if (!Array.isArray(payload[key])) {
      addIssue(issues, {
        code: "output_payload_bad_array",
        rowId: row.id,
        listingId: row.listing_id,
        message: `output_payload.${key} must be an array.`,
      });
    }
  }

  const sleepingRollups = payload.sleeping_rollups;
  if (
    !sleepingRollups ||
    typeof sleepingRollups !== "object" ||
    Array.isArray(sleepingRollups)
  ) {
    addIssue(issues, {
      code: "output_payload_bad_sleeping_rollups",
      rowId: row.id,
      listingId: row.listing_id,
      message: "output_payload.sleeping_rollups must be an object.",
    });
  }
}

function validateStageExpectations(
  row: EnrichmentRow,
  issues: ValidationIssue[],
): void {
  const usagePayloadObject = asObject(row.usage_payload);

  if (row.status === "pending") {
    if (row.model !== null) {
      addIssue(issues, {
        code: "stage_pending_model_present",
        rowId: row.id,
        listingId: row.listing_id,
        message: "pending rows should not have model set.",
      });
    }
    if (row.output_hash !== null) {
      addIssue(issues, {
        code: "stage_pending_output_hash_present",
        rowId: row.id,
        listingId: row.listing_id,
        message: "pending rows should not have output_hash set.",
      });
    }
    if (row.applied_at !== null) {
      addIssue(issues, {
        code: "stage_pending_applied_at_present",
        rowId: row.id,
        listingId: row.listing_id,
        message: "pending rows should not have applied_at set.",
      });
    }
    return;
  }

  if (row.status === "completed" || row.status === "applied") {
    if (!row.model) {
      addIssue(issues, {
        code: "stage_completed_missing_model",
        rowId: row.id,
        listingId: row.listing_id,
        message: `${row.status} rows should have model set.`,
      });
    }
    if (!row.output_hash) {
      addIssue(issues, {
        code: "stage_completed_missing_output_hash",
        rowId: row.id,
        listingId: row.listing_id,
        message: `${row.status} rows should have output_hash set.`,
      });
    }
    if (Object.keys(usagePayloadObject).length === 0) {
      addIssue(issues, {
        severity: "warning",
        code: "stage_completed_empty_usage_payload",
        rowId: row.id,
        listingId: row.listing_id,
        message: `${row.status} rows have empty usage_payload; cost estimation may be unavailable.`,
      });
    }
  }

  if (row.status === "applied" && row.applied_at === null) {
    addIssue(issues, {
      code: "stage_applied_missing_applied_at",
      rowId: row.id,
      listingId: row.listing_id,
      message: "applied rows should have applied_at set.",
    });
  }

  if (row.status === "failed") {
    const auditPayload = asObject(row.audit_payload);
    const errorMessage = asString(auditPayload.error).trim();
    if (errorMessage.length === 0) {
      addIssue(issues, {
        severity: "warning",
        code: "stage_failed_missing_error",
        rowId: row.id,
        listingId: row.listing_id,
        message: "failed rows should include audit_payload.error message.",
      });
    }
  }
}

function renderIssue(issue: ValidationIssue): string {
  return `${issue.severity.toUpperCase()} ${issue.code} listing_id=${issue.listingId} row_id=${issue.rowId} ${issue.message}`;
}

async function run(): Promise<number> {
  if (!pgDb) {
    throw new Error("Postgres database is not configured.");
  }

  const options = parseArgs(process.argv.slice(2));

  const predicates = [
    inArray(
      listing_ai_enrichment.status,
      options.statuses as [string, ...string[]],
    ),
  ];

  if (options.adapterKey) {
    predicates.push(eq(listing_ai_enrichment.adapter_key, options.adapterKey));
  }

  const fetchedRows = await pgDb
    .select({
      id: listing_ai_enrichment.id,
      listing_id: listing_ai_enrichment.listing_id,
      status: listing_ai_enrichment.status,
      source_content_hash: listing_ai_enrichment.source_content_hash,
      model: listing_ai_enrichment.model,
      output_hash: listing_ai_enrichment.output_hash,
      source_snapshot_payload: listing_ai_enrichment.source_snapshot_payload,
      output_payload: listing_ai_enrichment.output_payload,
      usage_payload: listing_ai_enrichment.usage_payload,
      audit_payload: listing_ai_enrichment.audit_payload,
      generated_at: listing_ai_enrichment.generated_at,
      applied_at: listing_ai_enrichment.applied_at,
      updated_at: listing_ai_enrichment.updated_at,
    })
    .from(listing_ai_enrichment)
    .where(and(...predicates))
    .orderBy(desc(listing_ai_enrichment.updated_at))
    .limit(Math.max(1, options.limit));

  const rows = options.latestPerListing
    ? Array.from(
        fetchedRows
          .reduce((acc, row) => {
            if (!acc.has(row.listing_id)) {
              acc.set(row.listing_id, row);
            }
            return acc;
          }, new Map<string, (typeof fetchedRows)[number]>())
          .values(),
      )
    : fetchedRows;

  const issues: ValidationIssue[] = [];
  for (const row of rows) {
    validateSourceSnapshot(row as EnrichmentRow, issues);
    validateSourceHash(row as EnrichmentRow, issues);
    validateOutputPayload(row as EnrichmentRow, issues);
    validateStageExpectations(row as EnrichmentRow, issues);
  }

  const byStatusRows = await pgDb
    .select({
      status: listing_ai_enrichment.status,
      count: sql<number>`count(*)::int`,
    })
    .from(listing_ai_enrichment)
    .groupBy(listing_ai_enrichment.status)
    .orderBy(listing_ai_enrichment.status);

  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");

  console.log("listing_ai_enrichment_validation");
  console.log(`- rows_checked: ${rows.length}`);
  console.log(`- statuses_filter: ${options.statuses.join(",")}`);
  console.log(`- adapter_filter: ${options.adapterKey ?? "all"}`);
  console.log(`- strict_mode: ${options.strict}`);
  console.log(`- latest_per_listing: ${options.latestPerListing}`);
  console.log(`- errors: ${errors.length}`);
  console.log(`- warnings: ${warnings.length}`);

  console.log("- stage_counts:");
  for (const statusRow of byStatusRows) {
    console.log(`  - ${statusRow.status}: ${statusRow.count}`);
  }

  const maxIssueLines = 200;
  if (issues.length > 0) {
    console.log("- issues:");
    for (const issue of issues.slice(0, maxIssueLines)) {
      console.log(`  - ${renderIssue(issue)}`);
    }
    if (issues.length > maxIssueLines) {
      console.log(
        `  - ... truncated ${issues.length - maxIssueLines} additional issues`,
      );
    }
  }

  if (errors.length > 0) {
    return 1;
  }
  if (options.strict && warnings.length > 0) {
    return 1;
  }

  return 0;
}

run()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`run-ai-enrichment-validation failed: ${message}`);
    process.exit(1);
  });
