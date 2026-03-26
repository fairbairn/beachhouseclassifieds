# Canonical Rental Data Model

This project uses a source-agnostic canonical listing contract.

Principles:

- `sources` stores raw payloads exactly as collected from each platform.
- `listing` stores normalized, product-facing property data for search and UX.
- Channel pricing and availability intelligence is stored separately from `listing` and can change frequently.

## Listing: Search-First Canonical Fields

High-frequency search/filter fields are first-class columns:

- Location and category: `city`, `state`, `zip_code`, `lat`, `lng`, `property_type`
- Occupancy and pricing: `bedrooms`, `bathrooms`, `max_guests`, `nightly_rate`
- Market drivers: `is_oceanfront`, `is_beachfront`, `is_waterfront`, `has_pool`, `allows_pets`, `has_neighborhood_amenities`
- Content layers: `description`, `description_summary`, `description_marketing_md`

## Canonical Sections

Structured detail lives in canonical section JSON fields that are independent of any one source schema:

- `amenities_section`
- `spaces_section`
- `policies_section`
- `faqs_section`
- `reviews_section`
- `location_section`

These sections are normalized by source adapters to a stable contract for UI rendering.

## Merge Reproducibility

`listing` tracks merge reproducibility fields:

- `source_refs` ordered source contributions
- `merge_strategy_version` strategy identifier
- `field_lineage` canonical field provenance

This allows deterministic re-merges when source data changes or adapter rules evolve.

## Future: Pricing Comparison Engine

Cross-channel quote data is intentionally not stored on `listing`.

Use `listing_price_snapshot` for quote snapshots by date range and channel:

- channels: VRBO, Airbnb, PM direct
- date range: check-in/check-out
- price components: nightly, subtotal, fees, total
- capture metadata for historical comparison and UX proof points

This separation preserves a stable property model while supporting dynamic price-comparison features.
