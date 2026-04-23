# Discover Search Engine Reference

## Purpose

This document defines how Discover search is modeled end-to-end:

- input normalization and state ownership
- reactive fetch signaling
- API and server contracts
- Meilisearch document schema
- ingestion/sync lifecycle
- query semantics (including current sort behavior)

It is intended to keep Discover behavior deterministic and explainable under the model:

- inputs -> state machine -> signal-controlled fetch cycle -> response -> render

## Runtime Topology

### Client (Discover page)

- UI inputs are owned in component state and normalized into a single inputs state object.
- The normalized inputs are mirrored into a Discover inputs store.
- A stable signature of that store is used as the fetch effect trigger.
- Client list rendering uses server response order directly (no client resorting).

Primary files:

- `src/components/discover/DiscoverPage.tsx`
- `src/lib/discover/discover-state.ts`
- `src/lib/discover/discover-inputs-store.ts`
- `src/lib/discover/discover-results-store.ts`

### Transport/API

- Client and SSR call `/api/discover/listings` through one request helper.
- API route parses and validates request bounds, then delegates to search service.
- Search service sanitizes input and delegates to page payload builder.

Primary files:

- `src/lib/discover/discover-listings-query.ts`
- `src/routes/api/discover/listings.tsx`
- `src/lib/discover/discover-search-service.server.ts`
- `src/lib/discover/discover-listings-api.server.ts`

### Data Layer

- Backend switch determines active search source (`meilisearch` or guarded postgres paths).
- Current operational path for discover search is Meilisearch.
- Listing/facet/snapshot execution is centralized in Meilisearch adapter module.

Primary files:

- `src/lib/discover/discover-listings.server.ts`
- `src/lib/discover/discover-listings-meilisearch.server.ts`
- `src/lib/discover/meilisearch-discover-documents.server.ts`

## Reactive Fetch Model

## Canonical Flow

1. Inputs change in Discover controls.
2. Inputs are normalized (`normalizeDiscoverInputsState`) and mirrored into inputs store.
3. Signature changes (`buildDiscoverInputsSignature`) drive one fetch effect.
4. Effect computes request window:
   - SSR seed is 12
   - first post-SSR backfill is 84 at offset 12
   - subsequent cycles use target window semantics from current state
5. Request helper calls `/api/discover/listings`.
6. Response is merged into results store (`append` for first backfill, `replace` otherwise).
7. UI renders from results store and map seed metadata.

## DRY Fetch Rule

`fetchDiscoverListingsPage(...)` currently has exactly:

- one producer function (`src/lib/discover/discover-listings-query.ts`)
- one SSR call-site (`src/routes/discover.tsx`)
- one client reactive call-site (`src/components/discover/DiscoverPage.tsx`)

This is the intended fetch boundary for listing-page payloads.

## Duplicate-Request and Stale-Response Guarding

Client effect protections:

- in-flight request fingerprint dedupe for identical request payloads
- monotonic request id guard to ignore stale resolutions

These guards are required to avoid double-dispatch/reactive races while preserving single authoritative apply behavior.

## Meilisearch Search Document Schema

Document type source:

- `src/lib/discover/meilisearch-discover-documents.server.ts`

Key fields:

- identity: `id`, `name`
- normalized location: `area_name`, `beach_area_name`, `community_name`
- display location: `area`, `beach`, `community`
- geo: `lat`, `lng`
- capacity: `bedrooms`, `bathrooms`, `sleeps`
- feature booleans: `private_pool`, `gulf_front`, `golf_cart`, `pet_friendly`, `accessible`, `elevator`
- bed counts: `king_bed_count`, `queen_bed_count`, `bunk_bed_count`
- media preview: `preview_images`, `thumbnail_image_url`
- pricing: `typical_pricing_month`, `typical_base_nightly`, `typical_all_in_nightly`

## Index Settings and Ingestion

Sync pipeline:

- script: `src/lib/scripts/run-discover-meilisearch-sync.ts`
- command: `npm run discover:search:sync:meilisearch -- [flags]`

Settings include:

- `filterableAttributes` for facets and numeric filters
- `sortableAttributes` for supported sort dimensions
- `searchableAttributes` for text-query fields

Sort-relevant sortable fields already configured include:

- `typical_all_in_nightly`
- `sleeps`

## Query Semantics (Current)

Supported sortOption behavior:

- `recommended`: no explicit Meilisearch sort (relevance/default ranking)
- `price-low`: `typical_all_in_nightly:asc`
- `price-high`: `typical_all_in_nightly:desc`
- `sleeps-high`: `sleeps:desc`
- `beach-pool-first`: currently treated as `recommended` (deferred boost strategy)

Filter semantics:

- location facets resolve labels/codes to canonical taxonomy codes
- feature selections map to boolean predicates
- min beds/sleeps/rooms compile into numeric lower-bound filters

Snapshot semantics:

- page listings and map listings are generated from same filtered query set
- map seed is bounded by requested map limit

## Validation and Probing

- Script probe: `npm run discover:search:probe:meilisearch -- [flags]`
- Optional local verification script: `.tmp/scripts/verify-discover-sort.ts`

Operational expectation:

- sort monotonicity should hold for price and sleeps options
- recommended should remain unsorted/default ranking

## Guardrails

- Keep transport layers thin; no query logic in route handlers.
- Keep query/sort/filter behavior in the data layer.
- Keep render order server-authoritative.
- Do not add client-side resorting for returned listing subsets.
- Preserve single-source fetch orchestration for list-page payloads.
