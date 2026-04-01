# Adapter Scrape and Extraction

This document explains how primary adapters scrape manager sites, normalize extracted data, and write canonical detail records.

## Purpose

Primary adapters provide a consistent way to ingest listing detail data from many manager sites with different HTML structures and booking stacks.

They are responsible for:

- Discovering listing URLs.
- Fetching listing detail pages.
- Extracting normalized fields into the universal detail contract.
- Producing canonical detail JSON under adapter-specific storage.

## Typical Adapter Lifecycle

1. Discovery

- Crawl or paginate a manager search/listing endpoint.
- Normalize and deduplicate detail links.
- Keep only URLs that match adapter detail URL rules.

2. Detail Pull

- Open detail page with adapter-defined pacing and concurrency.
- Extract page metadata, listing identifiers, title, location, amenities, media, and availability/rates payloads when present.
- Capture source HTML path for traceability/debug.

3. Normalization

- Map extracted source fields into the shared detail schema.
- Build normalized availability day records.
- Populate normalized rates where a deterministic source exists.

4. Output

- Write per-listing detail JSON under adapter data folder.
- Preserve stable keys such as external listing id and detail URL.

## What Adapters Extract

Core required payload typically includes:

- external_listing_id
- detail_url
- fetched_at
- html_path
- property_profile
- description_expanded
- amenities
- media_gallery.image_urls
- location
- normalized_availability.days
- normalized_rates.days when available

Contract and definitions live in:

- [Universal Detail JSON Structure](./universal-detail-json-structure.md)

## Runtime Controls

Scrape adapters generally expose environment-driven controls for:

- Detail fetch concurrency.
- Inter-request delays/min gap.
- Availability horizon.
- Calendar advance limits.
- Progress logging channels and counters.

## Quality Expectations

For adapter readiness, extraction quality must satisfy:

- Required core fields complete for all current files.
- Description, amenities, media, and availability thresholds at 100%.
- Pricing-record parity gate tracked separately in conformance status.

See:

- [Adapter Conformance Status](./adapter-conformance-status.md)
- [Rates Conformity Rollout Matrix](./rates-conformity-rollout-matrix.md)
