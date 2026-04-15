# Listings Operations and Exclusion Spec

Status: active (living spec)
Last updated: 2026-04-15

## Purpose

This document is the canonical operations spec for:

1. Listing AI enrichment generation/apply loops.
2. Sleeping arrangements processing behavior used by search projection.
3. Cross-adapter duplicate analysis.
4. Deterministic exclusion remap for `keyco30a` in `listing_source_link`.

This spec intentionally focuses on runtime operations and policy behavior, not schema design history.

## Existing Docs and Boundaries

To avoid duplicate documentation, use this split:

1. Use `docs/listings-persistence-and-bootstrap-plan.md` for schema evolution/bootstrap strategy.
2. Use this document for day-2 operations and policy execution.
3. Use `docs/cli-runner-reference.md` for command catalog; this document defines policy and run semantics for listing-specific workflows.

## What Was Implemented Recently

## 1) AI Enrichment Pipeline Operations

Implemented and validated:

1. Pending enrichment runner with progress output and concurrency controls.
2. Apply runner with progress output (`--progress-every`) and dry-run support.
3. Full reset/reseed/run patterns validated operationally.

Primary CLIs:

1. `npm run listings:enrichment:pending:postgres:local -- --limit <n> --concurrency <n> --progress-every <n> [--adapter-key <key>] [--dry-run]`
2. `npm run listings:enrichment:apply:postgres:local -- --progress-every <n> [--adapter-key <key>] [--dry-run]`
3. `npm run listings:enrichment:coverage:postgres:local -- [--adapter-key <key>]`

## 2) Sleeping Arrangements Processing Path

Current behavior:

1. Enrichment output contract requires `sleeping_arrangements` and `sleeping_rollups`.
2. Search projection derives canonical bed-type rollups from `sleeping_arrangements`.
3. Invalid or absent structures degrade safely to zeroed rollups (no runtime crash path).

Key implementation locations:

1. `src/lib/listings/enrichment/contracts.ts`
2. `src/lib/listings/search/search-projection.ts`

## 3) Duplicate Analysis CLI Enhancements

Current duplicate analysis capabilities:

1. Geo + text + attribute confidence scoring.
2. Property-type-aware confidence weighting:
   - condo-like pairs downweight geo influence.
   - house-like pairs upweight geo influence.
3. Terminal report sections:
   - top adapter pairs
   - top adapters across matches
   - root-adapter tree view (for aggregator analysis)
4. Export support:
   - JSON detailed match payload
   - CSV pair table

Primary CLI:

1. `npm run listings:duplicates:analyze:postgres:local -- [flags]`

High-value flags:

1. `--root-adapter <key>`
2. `--radius-meters <n>`
3. `--confidence-distance-meters <n>`
4. `--min-confidence <0..1>`
5. `--output-json <path>`
6. `--output-csv <path>`

## 4) keyco30a Exclusion Remap

## Scope

Only `listing_source_link` rows are touched.

Scoped row set for remap:

1. `adapter_key = 'keyco30a'` (or supplied adapter key)
2. `is_primary_source = true`
3. `source_status = 'active'`
4. `active_to is null`

Field updated:

1. `listing_source_link.excluded_by_match` (boolean)

Schema/migration:

1. Column in `src/lib/db/schema-postgres.ts`
2. Migration `drizzle/pg/0012_add_listing_source_link_excluded_by_match.sql`

## Deterministic No-Leak Behavior

When exclusion sync mode is used:

1. Every scoped source-link row is evaluated each run.
2. Rows meeting rule are set `excluded_by_match = true`.
3. Rows not meeting rule are set `excluded_by_match = false`.

This guarantees complete remap semantics across the scoped adapter cohort and prevents stale flag leakage when rules change.

## Exclusion Rule Inputs

Current configurable controls:

1. `--exclude-confidence-threshold <0..1>`
2. `--sync-adapter-key <key>`
3. `--no-require-houselike` (default behavior requires houselike pair classification)

Default policy profile currently used in operations:

1. threshold: `0.75`
2. adapter: `keyco30a`
3. houselike required: true

Houselike classifier (default):

1. include keywords: `house`, `carriage`, `cottage`
2. exclude keywords: `townhome`, `townhouse`, `condo`, `apartment`, `suite`, `unit`

## Operational Commands

Dry-run remap preview (safe default):

```bash
npm run listings:duplicates:analyze:postgres:local -- \
  --radius-meters 120 \
  --confidence-distance-meters 10 \
  --min-confidence 0.6 \
  --sync-exclusions \
  --sync-adapter-key keyco30a \
  --exclude-confidence-threshold 0.75 \
  --top 1
```

Apply remap writes:

```bash
npm run listings:duplicates:analyze:postgres:local -- \
  --radius-meters 120 \
  --confidence-distance-meters 10 \
  --min-confidence 0.6 \
  --sync-exclusions \
  --apply-exclusions \
  --sync-adapter-key keyco30a \
  --exclude-confidence-threshold 0.75 \
  --top 1
```

Expected remap summary fields in terminal output:

1. `scoped_source_links`
2. `qualifying_listing_ids`
3. `set_true`
4. `set_false`
5. `unchanged_true`
6. `unchanged_false`
7. `dry_run`

## Listing CLI Operational Standards

These listing CLIs standardize on:

1. Exit codes:
   - `0`: success
   - `1`: handled failure
   - `130`: cancellation (`Ctrl-C`)
2. Deterministic operator-facing output with explicit summary blocks.
3. Explicit dry-run behavior before mutating operations.
4. Progress telemetry on long-running loops (`--progress-every`).
5. Adapter-scoped execution and clear parameter echo at start.
6. No hidden partial state updates for exclusion remap (full true/false reconciliation).

## Policy Tuning Notes

1. Use dry-run first for threshold changes.
2. Review low-band confidence examples before lowering thresholds.
3. Treat `>= 0.80` as high-confidence candidate band; evaluate sub-bands separately for risk.
4. Re-run remap after any scoring or property-type rule changes.
