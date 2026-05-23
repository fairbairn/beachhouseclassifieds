# Adapter Quote Runtime Migration Implementation Playbook

This is an implementation checklist for migrating one adapter to quote-runtime mode, wiring quote_context correctly, and reaching compliance gates.

## Purpose

Use this guide when converting an adapter from legacy quote capture logic to runtime quote execution under:

- src/lib/pricing/quote-runtime/adapters
- src/lib/pricing/quote-runtime/registry.ts
- src/lib/pricing/scraper-engine/adapters

Outcome target:

1. Quote capture runs through runtime executor.
2. quote_context is available for every listing index entry.
3. Quote, handoff, cache, and filename validators pass.
4. Adapter status can be moved forward in conformance docs.

## Phase 0: Preflight Inventory

1. Confirm adapter key and existing scraper adapter file.
2. Confirm quote provider function already exists (or identify where to extract it from).
3. Evaluate listing identity strategy first:

- If stable slugs exist, migrate `external_listing_id` to slug values first.
- Move provider-required numeric identifiers to `quote_context` (for example `listing_id`, `entity_id`, `unit_id`).
- Plan removal of legacy numeric-named detail artifacts after migration.

4. Verify data folders exist:

- src/lib/data/external-sources/ADAPTER_KEY/details/index.json
- src/lib/data/external-sources/ADAPTER_KEY/details/quotes

5. Verify current commands run for this adapter:

- quote capture
- quote validator
- handoff validator
- pricing cache builder and validator

## Phase 1: Build Runtime Adapter Executor

1. Add runtime adapter file:

- src/lib/pricing/quote-runtime/adapters/ADAPTER_KEY.ts

2. Export one executor function with QuoteExecutionRequest -> QuoteExecutionResult behavior.
3. Delegate extraction to provider logic when possible instead of re-implementing parsing.
4. Ensure standard success and failure mapping:

- quoteAvailable true only when usable totals are present
- structured failure code and message for unavailable or request errors
- preserve handoff URL when available

## Phase 2: Wire Registry

1. Register executor in:

- src/lib/pricing/quote-runtime/registry.ts

2. Ensure adapter key is listed in getKnownQuoteRuntimeAdapterKeys output.
3. Confirm getQuoteRuntimeExecutor(adapterKey) returns the new executor.

## Phase 3: Move Scraper Adapter Quote Capture to Runtime

1. In scraper adapter file:

- src/lib/pricing/scraper-engine/adapters/ADAPTER_KEY.ts

2. Update runQuoteCapture to use runtime shared runner:

- runRuntimeAdapterQuoteCli(...)

3. Keep scope handling aligned with canonical selection helper:

- normalizeAdapterQuoteScopeArgs(adapterKey, argv)

4. Remove direct dependency on legacy quote-module paths.

## Phase 4: quote_context Compliance

For runtime adapters, details index records must include quote_context.

1. Open:

- src/lib/data/external-sources/ADAPTER_KEY/details/index.json

2. For every entry, ensure quote_context exists.
3. Populate only required runtime fields for this adapter.
4. Use {} when no fields are needed by the runtime executor.
5. Do not duplicate external_listing_id values into quote_context scalar fields.

Recommended quote_context rules:

1. Keep stable identifiers only (unit/property codes, API keys, endpoint hints).
2. Keep values deterministic and serializable.
3. Do not store volatile runtime payloads that change per quote request.

Slug migration cleanup rules:

1. Ensure canonical artifact filenames align with slug-based `external_listing_id`.
2. Remove legacy numeric-named files from `details/json`, `details/html`, `details/quotes`, and `details/pricing` once slug artifacts are rebuilt.
3. Re-run scrape filename validation after cleanup.

## Phase 5: Functional Validation Loop

Run in this order for one adapter:

1. Quote capture refresh:

- npm run pricing:quote:adapter -- --adapter-key ADAPTER_KEY --weeks 24

2. Quote validator:

- npm run pricing:validate:quotes -- --adapter-key ADAPTER_KEY

3. Handoff alignment validator:

- npm run pricing:validate:handoff -- --adapter-key ADAPTER_KEY

4. Pricing cache build:

- npm run pricing:cache:adapter -- --adapter-key ADAPTER_KEY

5. Pricing cache validator:

- npm run pricing:validate:cache -- --adapter-key ADAPTER_KEY

6. Scrape filename validator:

- npm run pricing:validate:scrape-filenames -- --adapter-key ADAPTER_KEY

7. Ad hoc runtime latency smoke:

- npm run pricing:latency:adhoc -- --adapter-key ADAPTER_KEY --random-single --include-booking-fetch

Run order rule:

- Execute ad-hoc runtime latency smoke last, after all validators, isolation audit, and documentation updates.

If quote validator or handoff validator fails, inspect failure classes first:

1. request_error: transport, endpoint, anti-bot, auth, or payload shape drift.
2. total_not_found: extractor selectors or response contract changed.
3. grand_total_mismatch/component_mismatch: parser mapping or currency math mismatch.

## Phase 6: Isolation and Contract Audit

Run runtime isolation audit after migration:

- npm run pricing:audit:quote-isolation

Expected outcome:

1. Adapter is runtime-backed.
2. Legacy quote module path is not used for the migrated adapter.
3. quote_context contract checks pass.

## Phase 7: Documentation and Status Updates

1. Update adapter status doc:

- docs/adapter-conformance-status.md

2. Update rollout matrix where applicable:

- docs/rates-conformity-rollout-matrix.md

3. Add migration notes to session/handoff docs if the adapter changed behavior materially.

## Phase 8: Gradual Browser Runtime Migration (Playwright -> CloakBrowser)

Use this phase only where anti-bot behavior or transport-level blocking creates repeatable failures in existing adapter flows.

Scope rules:

1. Do not do broad global browser swaps.
2. Migrate one adapter at a time.
3. Migrate one surface at a time inside an adapter:

- scrape-engine detail fetch
- scrape-engine discovery (only if required)
- quote-runtime execution (only if required)

4. Keep default behavior stable for unaffected adapters.

Decision gate (when to migrate a surface):

1. Baseline run shows meaningful failure pressure in the target surface.
2. Evidence points to transport/browser fingerprint blocking rather than parser breakage.
3. A/B probe or limited adapter run demonstrates improved pass rate with CloakBrowser.

Recommended adapter-level rollout:

1. Baseline with current Playwright flow:

- `npm run managers:scrape:adapter:engine -- --adapter-key ADAPTER_KEY --refresh-known --max-listings 10 --detail-retry-attempts 0`

2. Add CloakBrowser in detail fetch path only (keep discovery unchanged).
3. Re-run the same constrained command and compare:

- pulled details
- failed detail URLs
- HTTP/transport failure classes

4. Promote only if failure reduction is clear and parser outputs remain stable.
5. Consider discovery migration only when discovery itself is blocked and detail improvements are insufficient.
6. Consider quote-runtime migration only when quote endpoint navigation/request steps are blocked in current runtime execution.

Implementation notes:

1. Prefer the minimal CloakBrowser pattern first:

- `const browser = await launchCloakBrowser()`
- `const page = await browser.newPage()`
- navigate/extract
- `await page.close()`
- `await browser.close()`

2. Introduce context-based APIs only when needed for a proven scenario (for example persistent state requirements).
3. Keep adapter-level browser helpers local to that adapter until the pattern is validated across multiple adapters.
4. Keep retry behavior explicit and deterministic during migration testing (`--detail-retry-attempts 0` for failure analysis runs).

Validation gates after each surface migration:

1. Scrape-engine sanity:

- `npm run managers:scrape:adapter:engine -- --adapter-key ADAPTER_KEY --refresh-known --max-listings 10 --detail-retry-attempts 0`

2. Quote runtime and validators (if quote surface changed):

- `npm run pricing:quote:adapter -- --adapter-key ADAPTER_KEY --max-listings 1 --weeks 2 --listing-concurrency 1 --quote-concurrency 1`
- `npm run pricing:validate:quotes -- --adapter-key ADAPTER_KEY`
- `npm run pricing:validate:handoff -- --adapter-key ADAPTER_KEY --max-observations 1`

3. Latency smoke (runtime path):

- `npm run pricing:latency:adhoc -- --adapter-key ADAPTER_KEY --random-single`

Rollback rule:

1. If CloakBrowser does not reduce failures or causes extraction regressions, revert the adapter surface to the previous Playwright flow and document findings before moving to another adapter.

## Compliance Exit Checklist

Treat migration as complete only when all items are true.

1. Runtime adapter executor exists and is registry-wired.
2. Scraper adapter quote capture path uses runtime runner.
3. details/index.json has quote_context for all entries.
4. Quote validator passes for active listings.
5. Handoff validator passes or has explicit accepted exclusions with rationale.
6. Pricing cache build and validator pass.
7. Scrape filename validator passes.
8. quote-runtime isolation audit passes.
9. Conformance docs updated with current status.
10. Ad hoc latency run returns valid quote and checkout/handoff URL (final completion step).
11. If browser runtime changed, migration notes include before/after failure behavior and selected surface scope (detail/discovery/runtime).

## Operator Notes

1. Prefer deterministic retries and explicit operator-facing errors.
2. Keep adapter-specific workaround logic inside that adapter only.
3. Avoid dynamic import shortcuts across server/client boundaries.
4. Keep reusable infrastructure in src/core and app behavior in src/lib and adapter modules.
