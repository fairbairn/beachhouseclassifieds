# Adapter Quote Refactor Playbook

## Purpose

Preserve the exact process, goals, and guardrails for migrating quote capture from adapter-specific batch wrappers to the shared runtime-backed runner pattern.

This document records what was learned from the 360blue migration and defines the repeatable approach for all remaining high-value adapters.

## Ultimate Goals

1. Runtime isolation: single-observation quote execution lives in `src/lib/pricing/quote-runtime/adapters/<adapter>.ts` and does not read local files.
2. Single source of truth: `details/index.json` controls active listing scope for quote, pricing, and validation workflows.
3. Shared orchestration: batch quote capture behavior is centralized in `src/lib/pricing/quotes/shared/runtime-adapter-quote-runner.ts`.
4. Contract stability: quote sidecars continue to satisfy validator requirements (shape + observation coverage).
5. Operational observability: quote runs provide deterministic progress and per-listing flush visibility.
6. Controlled rollout: one adapter at a time with mandatory green gates before moving on.

## Findings From 360blue Migration

### Architecture Findings

1. Transitional 3-file shape is not the target.

- Transitional shape (what existed):
  - primary adapter in `src/lib/pricing/scraper-engine/adapters/360blue.ts`
  - adapter quote wrapper in `src/lib/pricing/scraper-engine/adapters/quotes/360blue.ts`
  - runtime executor in `src/lib/pricing/quote-runtime/adapters/360blue.ts`
- Target shape (what now exists for 360blue):
  - primary adapter + runtime executor + shared quote runner
  - no adapter-specific batch quote wrapper

2. Shared runner pattern is viable in production-like flows.

- The shared runner now handles listing selection, quote windows, retries, sidecar shaping, per-listing flush, and progress reporting.
- Primary adapter integration is reduced to passing adapter config + runtime executor.

### Data Governance Findings

1. Canonical listing scope must be index-driven everywhere.

- `details/index.json` should define which listings are in scope for all quote/pricing/validation systems.
- Optional detail JSON backfill is an explicit fallback path, not the default control surface.

2. Quote sidecars can be accidentally downgraded by smoke runs.

- Running short windows (for example `--weeks 2`) against canonical output paths can overwrite full sidecars and break validation expectations.
- Repair strategy: rerun impacted listings at full expected horizon (`--weeks 24`) before validation.

### Runtime and Ops Findings

1. Mid-run flush is required for operator confidence.

- Buffered end-of-run writes made long captures appear stalled.
- Per-listing sidecar flush during execution solves this and improves failure recovery visibility.

2. Handoff validation latency is correctness-biased.

- Signed handoff flows plus browser checks can take seconds even for small samples.
- Current behavior is acceptable for correctness checks; optimize separately if quick-smoke mode is required.

## Reference End-State Architecture

For each migrated adapter:

1. Primary scraper adapter

- File: `src/lib/pricing/scraper-engine/adapters/<adapter>.ts`
- Responsibility:
  - Keep scrape/detail extraction behavior.
  - In `runQuoteCapture`, normalize scope args and invoke shared runner.

2. Runtime single-quote executor

- File: `src/lib/pricing/quote-runtime/adapters/<adapter>.ts`
- Responsibility:
  - Execute one quote request from runtime inputs.
  - Return normalized success/failure contract.
  - No local filesystem access.

3. Shared batch quote runner

- File: `src/lib/pricing/quotes/shared/runtime-adapter-quote-runner.ts`
- Responsibility:
  - Parse quote CLI options.
  - Load listing seeds from canonical index.
  - Execute date windows with concurrency and retries.
  - Build canonical sidecar records.
  - Flush sidecar per listing.

## Anti-Goals

1. Do not add new adapter-specific batch wrappers under `src/lib/pricing/scraper-engine/adapters/quotes`.
2. Do not reintroduce runtime filesystem dependency in quote execution adapters.
3. Do not bypass canonical index selection with ad hoc file scans in new paths.
4. Do not proceed to next adapter when current adapter is not green.

## Adapter Migration Procedure (Top to Bottom)

### Phase 0: Baseline and Safety

1. Confirm adapter has quote-capable behavior and current sidecars validate.
2. Capture baseline commands and outcomes in the PR/task notes.
3. Avoid broad reruns unless needed; prefer targeted listing scopes during development.

### Phase 1: Runtime Executor

1. Create or verify runtime executor at `src/lib/pricing/quote-runtime/adapters/<adapter>.ts`.
2. Ensure request input is runtime contract based (`listingId`, dates, occupancy, `quoteContext`, options).
3. Ensure failures return structured runtime errors (do not rely on unhandled throws).
4. Ensure no direct filesystem usage.

### Phase 2: Shared Runner Integration

1. In primary adapter `runQuoteCapture`, call `runRuntimeAdapterQuoteCli(...)`.
2. Pass adapter config defaults:

- `adapterKey`
- `executeSingleQuote`
- timeout/retry defaults
- endpoint/handoff defaults as needed
- fallback estimate defaults (`defaultTaxPct`, `defaultBaseNightly`) when appropriate

3. Keep scope normalization through existing `normalizeAdapterQuoteScopeArgs(...)`.

### Phase 3: Wrapper Removal

1. Remove adapter-specific import from `./quotes/<adapter>` in primary adapter.
2. Delete `src/lib/pricing/scraper-engine/adapters/quotes/<adapter>.ts` once integration is green.
3. Confirm no stale references remain.

### Phase 4: Validation Gates (Mandatory)

Run all gates for the migrated adapter before moving to another adapter.

1. Quote capture smoke check:

- `npm run pricing:quote:adapter -- --adapter-key <adapterKey> --max-listings 1 --weeks 2 --listing-concurrency 1 --quote-concurrency 1`

2. Restore full sidecar horizon for any listing touched by smoke:

- `npm run pricing:quote:adapter -- --adapter-key <adapterKey> --listing-id <listingId> --weeks 24 --quote-concurrency 8`

3. Quote validator:

- `npm run pricing:validate:quotes -- --adapter-key <adapterKey>`

4. Pricing validator:

- `npm run pricing:validate:pricing -- --adapter-key <adapterKey>`

5. Handoff validator (scoped sample):

- `npm run pricing:validate:handoff -- --adapter-key <adapterKey> --listing-id <listingId> --max-observations 1`

6. Build checkpoint (after meaningful code changes):

- `npm run build`

### Phase 5: Documentation and Handoff

1. Update migration tracker docs with status and date.
2. Record adapter-specific quirks and defaults.
3. Note any validator caveats discovered during rollout.

## Quality Checklist Per Adapter

An adapter migration is complete when all are true:

1. Primary adapter uses shared runtime quote runner.
2. Runtime single-quote executor exists and is used.
3. Adapter-specific quote batch wrapper is removed.
4. Quote validator passes.
5. Pricing validator passes.
6. Handoff validator sample passes.
7. Build passes.
8. Documentation updated.

## High-Value Adapter Prioritization Rubric

Score each candidate adapter on:

1. Listing volume impact (higher listing count = higher value).
2. Runtime similarity to already migrated adapters (faster migration, lower risk).
3. Existing validation health (prefer currently green adapters first).
4. Operational pain level (frequent failures, frequent manual intervention).

Recommended first pass after 360blue:

1. `keyco30a` (large listing volume, quote-capable, currently validated in status docs).
2. `30aescapes` (large listing volume, quote-capable, currently validated).
3. `realjoy30a` (high volume and known quote/handoff significance).

## Change Control and Rollback

If migration regresses:

1. Stop progression to next adapter.
2. Restore passing behavior for the current adapter before any further rollout.
3. Re-run full validation gate list.
4. Only proceed when all gates are green again.

## Current Program Snapshot

As of 2026-04-02:

1. Shared runtime quote runner is in place.
2. 360blue is migrated to the target shape (no adapter-specific quote wrapper).
3. 360blue quote/pricing/handoff validations are passing after sidecar horizon repair.
4. Next step is adapter-by-adapter rollout using this playbook.
