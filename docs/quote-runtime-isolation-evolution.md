# Quote Runtime Isolation Evolution

## Purpose

Capture the agreed architecture and execution plan for migrating quote execution into a portable, isolated runtime that can be invoked by local runners, RPC handlers, or REST endpoints without relying on project filesystem state.

## Problem Statement

Current quote adapter modules mix concerns:

- orchestration and batch sidecar generation (disk reads/writes, scheduling, reporting), and
- single-observation quote execution logic.

That coupling makes portability harder and increases risk when deploying quote execution in environments where local scrape artifacts are unavailable.

## Target Architecture

Separate responsibilities into two layers.

1. Orchestration layer (runner/process)

- Reads/writes disk.
- Selects listings and quote windows.
- Handles retries, pacing, summaries, sidecar persistence.
- Calls quote runtime as a dependency.

2. Quote runtime layer (execution)

- Pure callable adapter executors.
- No local filesystem access.
- No hidden lookup against project files.
- Uses input payload + outbound HTTP only.
- Returns normalized quote output and a signature-matched `handoffUrl`.

## Runtime Contract (Public Invocation)

Required request fields:

- `adapter`
- `listingId`
- `checkInIso`
- `checkOutIso`
- `adults`
- `children`
- `quoteContext` (nullable object)
- `options` (optional object)
  - `timeoutMs` (optional; caller override for request timeout)

Behavior rules:

- If an adapter requires additional identifiers (for example `eid`, `property_id`), they MUST come from `quoteContext`.
- Required context missing MUST fail explicitly.
- Quote execution MUST NOT infer required identifiers from `handoffUrl`, `detailUrl`, or filesystem lookups.

Response contract is a discriminated union:

- Success (`success: true`)
  - `elapsedMs`
  - `observation` with normalized quote fields and `handoffUrl`
- Failure (`success: false`)
  - `elapsedMs`
  - `error` block:
    - `code` (stable machine-readable identifier)
    - `message` (operator-readable explanation)
    - `retryable` (boolean)
    - `details` (optional structured context)

Contract rule:

- Runtime executors should return structured failure results for handled errors instead of throwing, so callers can diagnose issues deterministically.

## Non-Negotiable Boundaries

1. Quote runtime executors do not import `fs`/`node:fs` APIs.
2. Quote runtime executors do not read project artifacts from disk.
3. Latency and validation runners call quote runtime executors only.
4. Scraper-engine quote modules can remain during migration, but as orchestration/compat layers only.

## Current Status

Implemented:

- Quote runtime types:
  - `src/lib/pricing/quote-runtime/types.ts`
- Quote runtime registry:
  - `src/lib/pricing/quote-runtime/registry.ts`
- First isolated executor:
  - `src/lib/pricing/quote-runtime/adapters/panhandle30a.ts`
- Latency runner dispatch updated to quote-runtime only:
  - `src/lib/scripts/run-ad-hoc-quote-latency.ts`

Important migration note:

- Existing `scraper-engine/adapters/quotes/*.ts` files are still mixed (batch capture + execution wrappers in same file) and continue to fail strict isolation audit until extraction is complete for all adapters.

## Migration Plan

### Phase 1: Establish Pattern

- Finalize one high-confidence isolated adapter executor pattern (Panhandle reference).
- Keep compatibility bridge in existing adapter quote file while runtime coverage expands.
- Ensure latency runner uses quote-runtime dispatch only.

### Phase 2: Adapter-by-Adapter Extraction

For each adapter:

1. Create runtime executor under `src/lib/pricing/quote-runtime/adapters/<adapter>.ts`.
2. Move single-observation HTTP request logic into runtime executor.
3. Remove dependency on `detailUrl`, `endpointPath`, `handoffUrl` in runtime input.
4. Require `quoteContext` for adapter-specific required identifiers.
5. Keep orchestration logic (quote capture sidecars, file traversal) in scraper-engine layer.

Runtime location rule:

- Every migrated adapter MUST have a named executor file under `src/lib/pricing/quote-runtime/adapters/<adapter>.ts`.
- Registry wiring MUST reference that file (single pattern of location for quote execution logic).
- Do not place new quote execution logic in scraper-engine quote modules.

## Per-Adapter Quality Gate (Mandatory)

Do not move to the next adapter until the current adapter passes both checks below.

1. Scraper-engine quote mode must still work for the adapter.
2. Ad-hoc latency runner must work and pass for the same adapter.

If either check fails, fix the adapter before proceeding.

### Required Validation Loop Per Adapter

For adapter `<adapterKey>`:

1. Implement/refine runtime extraction for `<adapterKey>`.
2. Run scraper-engine quote mode for `<adapterKey>` and confirm success.
3. Run ad-hoc latency for `<adapterKey>` and confirm success.
4. Run isolation audit and confirm no regression in architecture rules.
5. Record outcome and only then start the next adapter.

### Suggested Command Sequence

Use the adapter-specific command variants already in this repo where available.

1. Quote capture path (scraper-engine quote mode):

- `npm run pricing:quote:adapter -- --adapter-key <adapterKey>`

2. Latency path (runtime-dispatched single-observation):

- `npm run pricing:latency:adhoc -- --adapter-key <adapterKey> --sample-listings 1 --repeats 1 --summary-only --adults 2 --children 0`

3. Isolation guard:

- `npm run pricing:audit:quote-isolation`

### Pass Criteria for Adapter Approval

Adapter `<adapterKey>` is approved when all are true:

1. Quote mode command exits successfully and produces expected quote-sidecar outputs.
2. Latency command completes with successful quote responses for sampled listing(s).
3. No adapter-specific regressions introduced in runtime output shape or handoff URL behavior.
4. Isolation audit result is acceptable for current migration stage.

### Failure Policy

If checks fail for `<adapterKey>`:

1. Stop progression to next adapter.
2. Fix runtime/scraper-engine bridge issues.
3. Re-run all three checks.
4. Resume only after pass.

### Phase 3: Contract Tightening

- Introduce runtime-first caller paths for validation tools and any new quote APIs.
- Narrow or retire legacy single-observation input fields that violate runtime boundary.
- Add adapter-level conformance checks for required `quoteContext` fields.

### Phase 4: Cleanup and Enforcement

- Remove remaining execution logic from `scraper-engine/adapters/quotes/*` modules.
- Keep those modules orchestration-only or retire where redundant.
- Promote isolation audit to required pre-merge gate for runtime evolution.

## Adapter Tasking Tracker

Use this list as the working migration board.

- `panhandle30a`: runtime executor created; continue cleanup/removal of wrapper dependency
- `360blue`: runtime executor created; continue cleanup and strict quote_context propagation
- `30abeach`: extract runtime executor
- `30avacay`: extract runtime executor
- `coastproperties30a`: extract runtime executor
- `dunevr30a`: extract runtime executor
- `exclusive30a`: extract runtime executor
- `fivestar30a`: extract runtime executor
- `funvacay30a`: extract runtime executor
- `grayt30a`: extract runtime executor
- `localvr30a`: extract runtime executor
- `oceanreef30a`: extract runtime executor
- `oversee30a`: extract runtime executor
- `realjoy30a`: extract runtime executor
- `30aescapes`: extract runtime executor

## Validation and Governance

Primary audit command:

- `npm run pricing:audit:quote-isolation`

Near-term expectation:

- Fails while migration is in progress.

Definition of done:

1. All quote executors live under `src/lib/pricing/quote-runtime/adapters/*`.
2. Latency runner and equivalent runtime callers resolve adapters via quote-runtime registry only.
3. Runtime executors pass no-filesystem rule and contract checks.
4. Legacy scraper-engine quote modules no longer own quote execution responsibilities.

## Decision Log

- Adopt runtime isolation as a hard architectural direction for portability.
- Treat quote modules as callable execution units (RPC-like behavior).
- Keep orchestration concerns out of runtime executors.
- Prefer explicit required context over fallback inference.
