# Pricing and Conformance System Reference

This reference explains how the pricing-conformance system works end to end, how the adapter modules are organized, what validators enforce, and how we progress adapters to Ready.

Use this as the top-level map, then drill into the focused docs below.

## Why This System Exists

The project needs consistent, comparable pricing data across many property-manager sites that run on different booking stacks and expose different levels of API support.

The system is designed to:

- Normalize listing detail and pricing data into a shared contract.
- Capture quote observations per listing/date-window where possible.
- Build per-day pricing caches for serving and parity checks.
- Validate quote sidecars and handoff parity before declaring adapters Ready.
- Track adapter maturity and remaining work in docs and rollout matrices.

## Core Runtime Flow

1. Run adapter scrape engine to collect/update canonical detail JSON.
2. Run quote capture for quote-capable adapters to build sidecar observations.
3. Run quote validator to enforce sidecar quality and contract rules.
4. Run handoff validator to compare observed totals with handoff/book-now totals.
5. Build pricing cache from observed and derived rates.
6. Update conformance docs and rollout status.

## Runtime Compliance Guardrails

Runtime-migrated adapters must satisfy the following policy checks before moving to the next adapter:

- Every adapter with a file under `src/lib/pricing/quote-runtime/adapters` must have `details/index.json` and include a `quote_context` object on every entry.
- `quote_context` may be an empty object (`{}`) when the runtime adapter does not require context fields.
- No runtime adapter key may also keep a legacy file under `src/lib/pricing/scraper-engine/adapters/quotes/<adapter>.ts`.
- `quote_context` scalar values must not echo `external_listing_id` anywhere (red-flag isolation check).

These checks are enforced by `npm run pricing:audit:quote-isolation` and are the migration gate for selecting the next adapter.

## Reference Map

- [CLI Runner Reference](./cli-runner-reference.md)
- [Adapter Scrape and Extraction](./adapter-scrape-and-extraction.md)
- [Quote Modules and Platform Strategy](./quote-modules-platform-strategy.md)
- [Pricing Cache Builder](./pricing-cache-builder.md)
- [Quote Validator](./quote-validator.md)
- [Handoff Validator](./handoff-validator.md)
- [Central Runner and Modular Adapters](./central-runner-and-modular-adapters.md)
- [Adapter Catalog and Platform Differences](./adapter-catalog-and-platform-differences.md)
- [Known Peculiarities and Workarounds](./known-peculiarities-and-workarounds.md)
- [Ready Roadmap](./ready-roadmap.md)

## Existing Canonical Docs

These remain authoritative for specific contracts and status tracking:

- [Universal Detail JSON Structure](./universal-detail-json-structure.md)
- [Rates Conformity Contract](./rates-conformity-contract.md)
- [Rates Conformity Rollout Matrix](./rates-conformity-rollout-matrix.md)
- [Adapter Conformance Status](./adapter-conformance-status.md)
- [Pricing Quote Sync Reference](./pricing-quote-sync-reference.md)
