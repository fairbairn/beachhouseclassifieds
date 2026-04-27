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
- Query-formation validator: implemented in code

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

Current pricing-quality/search additions:

- `typical_pricing_status` (quality tier)
- `typical_pricing_priority` (sort priority for low-price semantics)

Current availability-stream additions for detail reconstruction:

- `status_code_string`
- `availability_window_start_date`
- `availability_days_count`

Detail reads reconstruct sequential calendar day status in memory from these fields.

Index settings:

- `filterableAttributes` include location codes, feature booleans, and key numeric fields
- `sortableAttributes` include nightly price and room capacity numbers
- `searchableAttributes` include listing/location names

Current required query-time settings include:

- `typical_pricing_status` as filterable
- `typical_pricing_priority` as sortable

These are validated by CLI before deploy.

## Sort Semantics (Current)

- `price-low` now uses priority-aware ordering:
  - `typical_pricing_priority:asc`
  - then `typical_all_in_nightly:asc`

This keeps full result counts while ranking grounded pricing ahead of lower-confidence tiers.

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

Validate query formation and index-setting compatibility:

- `npm run discover:search:validate:meilisearch`
- Raw form: `npm run discover:search:validate:meilisearch:raw -- --limit 2`

The validator checks:

- required filterable/sortable attributes
- listings/count/snapshot execution across sort modes
- facet and availability query paths
- population/consistency of priority/status fields used by `price-low`

Enable Meilisearch backend for Discover requests:

- Set `DISCOVER_SEARCH_BACKEND=meilisearch`

## Run Log

- Success: added Meilisearch dependency and backend modules.
- Success: added index sync + query probe scripts.
- Success: added environment wiring in `.env.example` and `.env.local`.
- Pending: run sync, run probe, and compare parity for key counts/facets on local DB snapshot.
- Pending: broaden query support (sort semantics, optional text query, and richer metadata parity).
