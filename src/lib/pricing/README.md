# Pricing Module Layout

This folder holds reusable pricing logic used by scripts and adapter workflows.

## Structure

- `contracts/`
  - Runtime validation and shared typing contracts for quote sidecars, pricing cache, assumptions, and handoff payloads.
- `cache/`
  - Shared pricing-cache build engine and cache-specific orchestration helpers.
- `validation/`
  - Shared validators for quote/cache conformance checks.
- `assumptions/`
  - Assumption refresh and derivation routines.
- `ops/`
  - Multi-adapter pricing orchestration logic.
- `scraper-engine/`
  - Shared adapter scraping runtime, foundations, registries, and adapter implementations used by pricing and acquisition flows.
- `quotes/`
  - Shared quote acquisition/parsing/generation engines.

## Placement Rules

- Put reusable pricing logic here under `src/lib/pricing/*`.
- Keep `src/lib/scripts/*` as executable entrypoints and thin wrappers.
- Do not place app pricing modules under `src/core/*` without explicit user approval.

## Migration Direction

1. Keep reusable cache logic in `cache/` and adapter settings in adapter-definition modules.
2. Use `src/lib/scripts/run-pricing-cache.ts` as the single cache build entrypoint.
3. Extract reusable quote-sidecar logic into `quotes/` as adapters converge.
4. Keep scraper runtime internals in `scraper-engine/` and expose only wrapper entrypoints via `src/lib/scripts/*`.
5. Keep adapter orchestration internals in `ops/` with script wrappers in `src/lib/scripts/*`.
