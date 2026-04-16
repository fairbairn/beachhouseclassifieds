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

## Platform Capability Reuse Rule

When an adapter belongs to the same underlying platform family, test known platform capabilities first before creating adapter-specific DOM logic.

For Streamline WordPress bridge adapters (`/wp-admin/admin-ajax.php?action=streamlinecore-api-request`):

1. Probe `GetPropertyRoomDetails` first for structured room/bed data.
2. If unavailable, parse rendered Room Details table content.
3. Use description heuristics only as a final fallback.

This keeps `rooms_guidance` extraction deterministic and reduces fragile UI-only parsing work across adapters that share the same stack.

## Adapter Inventory Source of Truth

Current adapter-by-adapter status is tracked in:

- [Adapter Conformance Status](./adapter-conformance-status.md)
- [Rates Conformity Rollout Matrix](./rates-conformity-rollout-matrix.md)

These docs should be updated as adapters move through seeded to ready.
