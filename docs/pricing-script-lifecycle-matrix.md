# Pricing Script Lifecycle Matrix

## Purpose

Define what stays, what should be reduced, and what can be removed only after compatibility gates are met.

## Keep (Primary Operational Entry Points)

- `src/lib/scripts/run-adapter-ops.ts`
  - Primary multi-adapter orchestration entrypoint.
  - Must stay stable; package script contract is `adapters:ops:raw`.
- `src/lib/scripts/run-quote-validation.ts`
  - Single validator engine for quote sidecars across adapters.
- `src/lib/scripts/run-pricing-cache.ts`
  - Single cache build wrapper using `--adapter-key`.
- `src/lib/scripts/run-adapter-quote.ts`
  - Universal quote CLI entrypoint (`--adapter-key`) for adapter quote engines.
- `src/lib/scripts/run-scrape-engine.ts`
  - Universal scrape CLI entrypoint (`--adapter-key`) for adapter scrape engine runs.

## Concurrency Policy

- Quote and listing operations must expose configurable concurrency controls across adapters.
- Concurrency should be implemented in shared runner/engine layers (not bespoke per-adapter wrappers) whenever feasible.
- Adapter-specific concurrency logic is allowed only for clear edge cases and must be documented inline.
- Weekly refresh-oriented operations should default to safe parallel settings and allow explicit override flags.

## Adapter Proxy Contract Policy

- Unified operation call-in API must be adapter-owned via `AdapterOperationProxy` in `src/lib/pricing/scraper-engine/adapter-registry.ts`.
- Runners must resolve adapters through `createValidatedAdapterOperationProxyByKey(...)` and avoid direct operation wiring.
- Proxy validation is required before execution and must enforce:
  - method presence (`runScrape`, `runQuoteCapture`, `runQuoteValidation`, `runPricingCache`)
  - capability booleans
  - capability consistency against registry-backed capability sets
- Adapter internals can diverge for optimization, but the proxy API surface must remain stable.

## Quote Scope Controls

- `run-adapter-ops` quote capture requires explicit selection scope for adapters that enforce it (for example royaldestinations).
- Use one of:
  - `--quote-listing-id <id>`
  - `--quote-max-listings <n>`
  - `--quote-all-listings`

## Review For Deprecation (After Replacement Exists)

- Adapter-specific quote wrapper scripts should remain removed; route through the universal quote runner.

## Completed Consolidations

- `src/lib/scripts/run-30aescapes-ops.ts` removed.
- `src/lib/scripts/reparse-30aescapes-availability-from-html.ts` removed from active package script surface.
- `src/lib/scripts/refresh-keyco30a-pricing-assumptions.ts` removed from active package script surface.
- `src/lib/scripts/validate-keyco30a-pricing-credibility.ts` removed from active package script surface.
- `src/lib/scripts/quote-royaldestinations.ts` and `src/lib/scripts/quote-homeownerscollection30a.ts` removed in favor of `src/lib/scripts/run-adapter-quote.ts`.
- `src/lib/pricing/validation/validate-keyco30a-pricing-credibility.ts` removed (adapter-specific validation logic retired in favor of shared engine).
- Pricing runtime logic moved under `src/lib/pricing/{cache,quotes,validation,assumptions,ops,scraper-engine}`.
- Shared cache builds consolidated under `src/lib/pricing/cache/build-listing-pricing-cache.ts` + adapter definitions.
- Adapter cache wrappers replaced by a single script: `src/lib/scripts/run-pricing-cache.ts`.
- Remaining files in `src/lib/scripts/*` are execution wrappers or operational utilities.

## Noisy But Not Pricing-Critical

- `src/lib/scripts/run-pull-source-images-to-b2.ts`
  - Keep outside pricing cleanup scope.

## Deletion Gates (Required Before Removing Any Legacy Script)

1. Package script compatibility is preserved in `package.json`.
2. `run-adapter-ops.ts` still executes all required steps for impacted adapters.
3. Quote validation passes for affected adapters.
4. Pricing cache build succeeds for affected adapters.
5. Operational docs/usage strings are updated.
6. At least one dry run and one real run are completed for changed adapters.

## Baseline Folder Contract Going Forward

- Reusable engines: `src/lib/pricing/*`
- Executable wrappers: `src/lib/scripts/*`
- Adapter runtime scraping engine: `src/lib/pricing/scraper-engine/*`
- No app-specific pricing modules in `src/core/*` without explicit user permission.
