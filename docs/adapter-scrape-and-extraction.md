# Adapter Scrape and Extraction

This document explains how primary adapters scrape manager sites, normalize extracted data, and write canonical detail records.

## Purpose

Primary adapters provide a consistent way to ingest listing detail data from many manager sites with different HTML structures and booking stacks.

They are responsible for:

- Discovering listing URLs.
- Fetching listing detail pages.
- Extracting normalized fields into the universal detail contract.
- Producing canonical detail JSON under adapter-specific storage.

Canonical workflow order for full adapter operations lives in:

- [Adapter Operations Top-Down Flow](./adapter-operations-top-down-flow.md)

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

## Mandatory Post-Rescrape Validator Gate

After every fresh adapter rescrape, run scraper validators before any quote capture or pricing cache work.

Required order:

1. npm run pricing:validate:scrape-filenames -- --adapter-key <adapterKey>
2. npm run pricing:validate:availability-status -- --adapter-key <adapterKey>
3. npm run pricing:validate:media-gallery-count -- --adapter-key <adapterKey>
4. npm run pricing:validate:rooms -- --adapter-key <adapterKey>

Operational rule:

1. Do not proceed to quote runs until all four validators pass.
2. Treat orphan artifact warnings as cleanup-required before quote execution.
3. Re-run the same validator set after orphan cleanup to confirm warnings and issues are cleared.

## Mandatory Quote Sequence After Scrape Validators

Once the post-rescrape scraper validators are clean, run quote operations in this order:

1. npm run pricing:quote:adapter -- --adapter-key <adapterKey> --all-listings --weeks 24 --continue-on-internal-error
2. npm run pricing:validate:quotes -- --adapter-key <adapterKey>

Operational rule:

1. Always run quote validator immediately after full quote capture.
2. If quote validator fails, remediate failing listings first, then re-run quote validator before proceeding to pricing cache and adapter suite.

## Command Syntax and Flags Quick Reference

Use these templates for the numbered operational flow. Replace `<adapterKey>` with the target adapter key (for example `alysbeach30a`).

1. Full rescrape + availability refresh

- `npm run managers:scrape:adapter:engine -- --adapter-key <adapterKey> --inventory-mode full-scan --run-mode detail,avail --allow-canonical-prune`

2. Scrape validators (required order)

- `npm run pricing:validate:scrape-filenames -- --adapter-key <adapterKey>`
- `npm run pricing:validate:availability-status -- --adapter-key <adapterKey>`
- `npm run pricing:validate:media-gallery-count -- --adapter-key <adapterKey>`
- `npm run pricing:validate:rooms -- --adapter-key <adapterKey>`

3. Quote capture + quote validation

- `npm run pricing:quote:adapter -- --adapter-key <adapterKey> --all-listings --weeks 24 --continue-on-internal-error`
- `npm run pricing:validate:quotes -- --adapter-key <adapterKey>`

4. Pricing cache + validation + suite + matrix sync

- `npm run pricing:cache:adapter -- --adapter-key <adapterKey>`
- `npm run pricing:validate:cache -- --adapter-key <adapterKey>`
- `npm run pricing:validate:adapter-suite -- --adapter-key <adapterKey>`
- `npm run pricing:sync:conformance-matrix:raw`

### Flag Meanings

- `--adapter-key <adapterKey>`: selects the adapter scope for all adapter-specific operations.
- `--inventory-mode full-scan`: runs discovery/full inventory refresh.
- `--run-mode detail,avail`: captures listing detail and availability data in the same scrape pass.
- `--allow-canonical-prune`: allows canonical index pruning during full-scan reconciliation.
- `--all-listings`: quote all listings in current canonical index.
- `--weeks 24`: quote horizon for weekly quote windows.
- `--continue-on-internal-error`: continue quote run when individual listing quote calls fail; handle failures in post-run validation/remediation.
