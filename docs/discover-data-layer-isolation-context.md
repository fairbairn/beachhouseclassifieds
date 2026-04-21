# Discover Data Layer Isolation Context

## Problem Summary

The Discover implementation has drifted into mixed concerns across transport (API/SSR), data access, and coercion. This created duplicate logic, unclear ownership, and slower iteration when tuning query performance.

## Core Boundary Rule

- API endpoints and SSR server functions are transport adapters only.
- DB querying and response shaping belong to a dedicated Discover data layer.
- Shared contracts/types must be isolated from UI demo data and static fixtures.

## What Must Not Happen

- No data coercion or database query logic in API endpoints.
- No data coercion or database query logic in SSR server functions.
- No runtime dependence on demo data in production Discover paths.
- No app-specific Discover modules under `src/core/*`.

## Target Architecture

1. Contract module

- Owns request/response types and exchange contracts.
- Has no dependency on UI components, image assets, or fake data.

2. Discover data layer

- Executes optimized database queries.
- Applies contractual shaping and reusable coercion rules.
- Serves as the single implementation consumed by API, SSR, and CLI.

3. Transport adapters

- API route parses request, calls data layer, returns contract response.
- SSR loader/server function does the same.
- No duplicate business/data logic.

4. CLI benchmark path

- Calls data layer directly without web server runtime.
- Measures metadata and result-window latency.
- Validates contract constraints and visibility compliance.

## Current Direction

- Discover data-layer implementation has been moved to `src/lib/discover/discover-listings-data-layer.server.ts`.
- Wrapper/adapter modules now consume that implementation instead of embedding DB logic.
- Visibility gating remains a primary eligibility rule (`visibility_disabled_reason is null`).
- Metadata/facet aggregation has been consolidated into a single optimized SQL execution path.

## Performance and Validation Requirements

- Measure data-layer stages before embedding behavior into transport adapters.
- Keep fixed listing windows for current flow (12 SSR + 84 fetch).
- Ensure returned listings never include visibility-disabled records.
- Keep query plans and response shaping deterministic and contract-aligned.

## Cleanup Agenda

1. Remove all legacy demo-data runtime dependencies from Discover server paths.
2. Isolate shared Discover contracts/types into a dedicated module separate from UI/demo content.
3. Split oversized files (>400 LOC) by concern:

- contracts/types
- query execution
- coercion/normalization helpers
- transport adapters
- CLI validation

## Definition of Done

- API and SSR are thin adapters with no DB/coercion logic.
- Data layer is reusable by API, SSR, and CLI without web server dependency.
- Shared contracts/types are isolated and consistently imported.
- Demo data is not used in runtime Discover data flow.
- CLI benchmark validates latency, limits, and visibility compliance.
