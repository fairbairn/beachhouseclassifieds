# Universal Detail JSON Structure

This document defines the target detail JSON structure that all scraper adapters should feed into.

The goal is to keep a stable, cross-adapter shape while allowing controlled growth over time.

## Design Principles

- Keep a small required core that every adapter must populate.
- Keep optional sections for provider-specific depth.
- Prefer normalized values for cross-source comparison.
- Preserve raw/provider diagnostics where useful for reparsing.
- Track coverage gaps so adapters can be improved incrementally.

## Versioning

- Current structure version: `1.0`
- Add `schema_version` when a breaking shape change is introduced.
- Backward-compatible additions should be additive fields only.

## Required Core (All Adapters)

Every detail JSON must include:

- `external_listing_id: string`
- `detail_url: string`
- `fetched_at: string` (ISO timestamp)
- `html_path: string`

## Standard Cross-Adapter Fields

These are strongly recommended and should be populated whenever available.

### Identity and SEO

- `title: string`
- `h1: string`
- `canonical_url: string`
- `meta_description: string`

### Property Profile

- `property_profile.unit_id: string`
- `property_profile.area: string`
- `property_profile.location: string`
- `property_profile.beds: number | null`
- `property_profile.baths: number | null`
- `property_profile.sleeps: number | null`
- `property_profile.city: string`
- `property_profile.state: string`

### Matching Normalization

- `normalized_matching_profile.source: string`
- `normalized_matching_profile.external_listing_id: string`
- `normalized_matching_profile.name: string`
- `normalized_matching_profile.description: string`
- `normalized_matching_profile.match_signals.description_normalized: string`
- `normalized_matching_profile.match_signals.description_sha256: string`
- `normalized_matching_profile.match_signals.title_normalized: string`
- `normalized_matching_profile.match_signals.title_sha256: string`
- `normalized_matching_profile.match_signals.listing_composite_key: string`

### Availability Normalization

- `normalized_availability.source: string`
- `normalized_availability.external_listing_id: string`
- `normalized_availability.captured_at: string`
- `normalized_availability.has_calendar_widget: boolean`
- `normalized_availability.window_start: string` (YYYY-MM-DD)
- `normalized_availability.window_end: string` (YYYY-MM-DD)
- `normalized_availability.code_legend: { A, U, I, O, X }`
- `normalized_availability.day_codes: string`
- `normalized_availability.days: Array<DayRow>`
- `normalized_availability.counts: { available, unavailable, checkin_only, checkout_only, other, booking_available, booking_unavailable, booking_unknown }`

Day row (`DayRow`) shape:

- `date: string` (YYYY-MM-DD)
- `status_code: "A" | "U" | "I" | "O" | "X"`
- `is_available: boolean`
- `is_available_for_checkin: boolean`
- `is_available_for_checkout: boolean`
- `booking_day_state: "bookable" | "blocked" | "unknown"`
- `min_nights_required: number | null`

### Raw Availability Sidecar

- `availability_raw.booking_ranges: Array<{ start, end }>`
- `availability_raw.min_day_rules: Array<{ startDate, endDate, minimum }>`

## Expanded Content Sections

These sections are now first-class targets for detail scraping when available.

### Full Description

- `description_expanded: string`

Expected behavior:

- Capture full visible content in the description area.
- If a `Read More` action gates text, capture the expanded result in the stored HTML and parse full text.

### Amenities

- `amenities.categories: Record<string, string[]>`
- `amenities.all: string[]`

Expected behavior:

- Capture tabbed amenities grouped by label (for example General, Kitchen, Outdoor).
- Also emit a de-duplicated flattened list for easy downstream filtering.

### Location

- `location.directions_url: string`
- `location.directions_daddr: string`
- `location.latitude: number | null`
- `location.longitude: number | null`

Expected behavior:

- Always capture at least one location signal (directions URL or address string).
- Capture lat/lng if directly available in page markup or tab data.

### Media Gallery

- `media_gallery.image_count: number`
- `media_gallery.image_urls: string[]`

Expected behavior:

- Capture all source image URLs from the listing gallery.
- De-duplicate variant URLs (for example size params) when possible.
- Preserve canonical retrievable links for future image fetch workflows.

## Coverage Targets

For each adapter, aim for:

- Core required fields: 100%
- Standard cross-adapter fields: >= 95% where source provides data
- Daily availability rows: continuous window out to 2 years if source exposes it
- Media gallery URLs: >= 1 image for listings with photo galleries

## Adapter Gap Audit Template

Use this checklist when enhancing any adapter.

- [ ] Required core fields all present
- [ ] Identity/SEO fields present
- [ ] Property profile beds/baths/sleeps parsed from detail page
- [ ] Description expanded content captured
- [ ] Amenities tab captured and grouped
- [ ] Availability day rows normalized to A/U/I/O/X
- [ ] Availability window and counts consistent with day rows
- [ ] Location signals captured (address and/or lat/lng)
- [ ] Media gallery URLs captured with stable count
- [ ] Reviews intentionally skipped unless explicitly requested

## Suggested Workflow for Future Adapter Upgrades

1. Run a 1-listing direct-detail probe using a known reference property.
2. Compare output against this universal structure.
3. Record missing fields and parser blockers.
4. Patch adapter extraction logic.
5. Re-run direct-detail probe and confirm section counts/lengths.
6. Run 5-listing sample and verify consistency.
7. Update this doc only when structure (not just extraction quality) changes.
