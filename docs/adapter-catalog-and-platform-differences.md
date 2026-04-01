# Adapter Catalog and Platform Differences

This document summarizes adapter targeting strategy and platform-family differences.

## Why Families Matter

Adapters that sit on the same underlying booking stack can share probe tactics, payload expectations, and parser patterns.

This accelerates onboarding and reduces duplicate discovery work.

## Common Families in Use

- track_bluetent
- streamline
- custom_hybrid
- guesty

See broader pattern guidance in:

- [Scraper Adapter Pattern Playbook](./scraper-adapter-pattern-playbook.md)

## How Adapters Differ

Primary differences include:

1. Availability source

- Calendar HTML vs API payload vs mixed mode.

2. Quote support

- Deterministic endpoint present, partial support, or unsupported.

3. Handoff behavior

- Quoted URL returned directly vs template signature vs detail fallback.

4. Rate granularity

- Daily rates available directly vs quote-window-derived averages.

5. Anti-bot/performance profile

- Sensitivity to concurrency, timeout windows, and request cadence.

## Adapter Inventory Source of Truth

Current adapter-by-adapter status is tracked in:

- [Adapter Conformance Status](./adapter-conformance-status.md)
- [Rates Conformity Rollout Matrix](./rates-conformity-rollout-matrix.md)

These docs should be updated as adapters move through seeded to ready.
