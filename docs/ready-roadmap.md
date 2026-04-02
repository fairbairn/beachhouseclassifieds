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

- Discover and normalize quote/handoff signatures.
- Add validator coverage and sidecar policy.

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

- `panhandle30a` is now Ready after full quote pull (51 listings), quote validation pass (51/51), pricing cache parity (51/51), and full handoff alignment pass (204/204).

## Operating Principle

Prefer targeted remediation and modular hardening over large reruns whenever failures are isolated.
