# Ready Roadmap

This document outlines the next phase of work: moving remaining adapters to Ready status.

## Current Objective

Progress adapters from none/seeded to ready by satisfying both:

- Data quality and contract thresholds.
- Pricing/handoff parity gates.

## Ready Definition

An adapter is fully Ready when:

- Required conformance thresholds pass for current corpus.
- Quote/handoff validation is reliable for quote-capable adapters.
- Pricing Records equals Files for current adapter scope.

See:

- [Adapter Conformance Status](./adapter-conformance-status.md)
- [Rates Conformity Rollout Matrix](./rates-conformity-rollout-matrix.md)

## Workstream Priorities

1. Seeded adapters to ready

- Close remaining assumptions depth and handoff-signature proof tasks.
- Maintain regression checks while promoting readiness.

2. None adapters with quote potential

- Build quote-runtime first.
- Investigate provider systems for quote patterns and candidate endpoints.
- Normalize identity/files in parallel so generated artifacts stay in conformity while runtime is being built.

3. None adapters without deterministic quote

- Harden assumptions-only path.
- Keep confidence policy explicit and conservative.

## Execution Cadence

For each adapter promoted:

1. Refresh quote/data inputs as needed.
2. Run quote validator.
3. Run handoff validator.
4. Build/verify pricing cache parity.
5. Update status docs with counts and rationale.

## Latest Promotion

- `funvacay30a` is now Ready after full scrape refresh (46 listings), full quote pull (46/46), pricing cache parity (46/46), and handoff smoke alignment pass (10/10 sampled).
- `grayt30a` is now Ready with quote and pricing parity at 35/35/35 and handoff smoke alignment passing at one observation per listing (35/35).
- `coastproperties30a` is now Ready with slug-based detail identity + quote_context migration complete, quote/pricing parity at 30/30/30, and handoff validations passing (smoke 9/9 sampled; full 116/116).
- `30abeach` is now Ready with mixed detail identity conformity (slug when detail URL leaf is slug, numeric when leaf is numeric), full quote-runtime capture, quote validation pass (17/17), pricing parity pass (17/17), and handoff alignment pass (63/63).

## Current In Progress

- Next quote-runtime-first discovery target: `stayon30a`.
- Current execution order for discovery adapters: scrape conformity -> quote-runtime implementation -> quote capture -> validators (quote, pricing, handoff).

## Operating Principle

Prefer targeted remediation and modular hardening over large reruns whenever failures are isolated.
