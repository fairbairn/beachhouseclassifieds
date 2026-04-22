# Discover Search Enablement (Meilisearch)

## Goal

Enable a Meilisearch-backed Discover query path while preserving the existing Postgres path as fallback/default.

## Current Status

- Container runtime: ready (`run:meilisearch:container:start`)
- Env wiring: added (`DISCOVER_SEARCH_BACKEND`, `MEILISEARCH_*`)
- Search document schema: implemented in code
- Indexing pipeline: implemented in code
- Query layer: implemented behind backend switch with Postgres fallback
- Basic query probe: implemented in code

## Implemented Components

- Runtime backend switch: `DISCOVER_SEARCH_BACKEND=postgres|meilisearch`
- Shared document mapper:
  - source listing -> search document
  - search document -> discover listing
- Meilisearch data-layer implementation for:
  - listings
  - filtered count
  - corpus metadata + facet counts
- Postgres fallback path if Meilisearch errors.

## Search Document Shape

Primary key: `id`

Fields:

- Identity/location: `id`, `name`, `area`, `areaCode`, `beach`, `beachCode`, `community`, `communityCode`
- Map/card fields: `lat`, `lng`, `previewImages`
- Capacity: `bedrooms`, `bathrooms`, `sleeps`
- Feature facets: `privatePool`, `gulffront`, `golfCart`
- Pricing: `typicalPricingMonth`, `typicalBaseNightly`, `typicalAllInNightly`

Index settings:

- `filterableAttributes` include location codes, feature booleans, and key numeric fields
- `sortableAttributes` include nightly price and room capacity numbers
- `searchableAttributes` include listing/location names

## Commands

Container:

- `npm run run:meilisearch:container:start`
- `npm run run:meilisearch:container:status`
- `npm run run:meilisearch:container:stop`

Sync index from Postgres discover corpus:

- `npm run discover:search:sync:meilisearch`
- Optional: `npm run discover:search:sync:meilisearch -- --batch-size 300`
- Dry run: `npm run discover:search:sync:meilisearch -- --dry-run`

Probe Meilisearch query output:

- `npm run discover:search:probe:meilisearch`
- With features: `npm run discover:search:probe:meilisearch -- --feature private_pool`

Enable Meilisearch backend for Discover requests:

- Set `DISCOVER_SEARCH_BACKEND=meilisearch`

## Run Log

- Success: added Meilisearch dependency and backend modules.
- Success: added index sync + query probe scripts.
- Success: added environment wiring in `.env.example` and `.env.local`.
- Pending: run sync, run probe, and compare parity for key counts/facets on local DB snapshot.
- Pending: broaden query support (sort semantics, optional text query, and richer metadata parity).
