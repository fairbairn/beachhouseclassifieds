# Discover Search Transition Plan (Postgres Now, Meilisearch Later)

Last updated: 2026-04-21

## Purpose

Capture the current decision context for Discover search evolution and define an incremental path to deliver full-corpus faceting/filtering/sorting behavior now using Postgres, while preserving a clean migration path to Meilisearch.

## Current Query Reality

The UX currently depends on two query paths:

1. Discover listings query (primary evolution target)
2. Detail page query (keep stable for now)

Detail query behavior is not the current bottleneck and should remain unchanged while Discover listing search evolves.

## Decision Context

### Why Postgres-First Right Now

- Canonical visibility rules, listing eligibility, and pricing/availability context already live in Postgres.
- Existing Discover server flow already sources listing rows from Postgres and enriches pricing context.
- We can deliver full-corpus totals/facets and filtered peeks without introducing immediate dual-system sync operations.
- Lower implementation risk and faster time-to-value for current UX needs.

### What Postgres-First Does Not Replace

- It does not provide Meilisearch-grade typo tolerance or ranking quality by default.
- It does not remove the need for a later dedicated search index if search relevance/performance requirements grow.

## Target Discover Contract (Near-Term)

For each Discover listing request, return:

- `results`: filtered + sorted listing rows, capped at `max 96`
- `totalCount`: full filtered corpus count (not capped)
- `facets`: full filtered corpus facet counts

Facet semantics target:

- AND across facet groups
- OR within each facet group

## Incremental Phases

### Phase 1: Contract + Server Query Shape

- Introduce a Discover server query input contract for filters/facets/sort/limit.
- Build base eligibility scope from canonical listing visibility rules.
- Keep existing detail query unchanged.

### Phase 2: Full-Corpus Counts/Facets in Postgres

- Compute `totalCount` from full filtered scope.
- Compute facet buckets from the same filtered scope.
- Ensure counts are not derived from client-local limited sets.

### Phase 3: Result Peek and Hydration

- Sort + limit to `max 96` for listing result payload.
- Hydrate pricing/availability context only for limited result IDs.

### Phase 4: UI Integration + Parity Checks

- Wire client to consume server-provided totals/facets.
- Keep fallback behavior behind a temporary flag if needed.
- Validate parity and UX behavior with existing Discover interactions.

### Phase 5: Meilisearch Prep (Deferred)

- Keep the same frontend query contract.
- Add Meilisearch index schema and ingest/sync from Postgres when ready.
- Swap backend provider behind stable contract (Postgres or Meilisearch).

## Operational Notes

- Do not change current map behavior as part of this transition.
- Preserve route server/client boundaries: no direct `.server` imports in client-reachable route modules.
- Keep this document updated as phases are implemented or reprioritized.
