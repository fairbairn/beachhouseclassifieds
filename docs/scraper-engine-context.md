# Scraper Engine Context

This document is the shared implementation context for manager adapters in this repo.

## Purpose

Use this as the default reference when adding or updating a manager adapter so we keep behavior, output shape, and folder layout consistent.

## Core Architecture

The scraper engine has three layers:

1. Entry script per manager
2. Manager adapter
3. Shared runner

### 1) Entry Scripts

Pattern:

- `src/lib/scripts/scrape-<manager>-engine.ts`

Responsibilities:

- Import `create<Manager>Adapter()` from `src/lib/scripts/scraper-engine/adapters/*`
- Call `runScraperEngine(adapter)`
- Catch and print concise failure message
- Exit non-zero on failure

### 2) Manager Adapters

Pattern:

- `src/lib/scripts/scraper-engine/adapters/<manager>.ts`

Responsibilities:

- Define manager-specific types and extraction logic
- Implement `ScraperAdapter<TDetail>` contract from `src/lib/scripts/scraper-engine/types.ts`
- Normalize detail URLs (`isValidDetailUrl`)
- Discover listing links (`discoverListings`)
- Extract full detail record (`fetchDetail`)

### 3) Shared Runner

File:

- `src/lib/scripts/scraper-engine/runner.ts`

Responsibilities:

- Parse CLI options
- Launch Playwright
- Run one of the supported modes (full, refresh-known, direct-detail)
- Manage concurrency, delays, and output writing

## Standardized Folder Layout

### Source Artifacts

Root:

- `src/lib/data/external-sources/`

Per-manager details:

- `src/lib/data/external-sources/<managerKey>/details/html/`
- `src/lib/data/external-sources/<managerKey>/details/json/`

Listing link snapshots (flat files written by runner):

- `src/lib/data/external-sources/<managerKey>_listings.json`
- `src/lib/data/external-sources/<managerKey>_listings_subset.json`

### Run Reports

Root:

- `.tmp/reports/`

Common files:

- `<managerKey>-playwright-links.json`
- `<managerKey>-playwright-links-subset.json`
- `<managerKey>-details-manifest.json`
- `<managerKey>-details-manifest-subset.json`
- `<managerKey>-refresh-known-report.json` (refresh mode)
- `<managerKey>-direct-detail-report.json` (direct mode)

## Naming Conventions

- Manager key: lowercase identifier used consistently across scripts, adapter, and output files (examples: `oversee30a`, `realjoy30a`, `benchmark30a`).
- Adapter filename: matches manager key in `adapters/`.
- Entry script filename: `scrape-<managerKey>-engine.ts`.
- Listing file prefixes: always use manager key.

## JSON Structure Standards

## Base Detail Fields (required)

All detail records extend `DetailRecordBase`:

- `external_listing_id`
- `detail_url`
- `fetched_at`
- `html_path`

## Normalized Matching Block (expected)

Use a stable block for cross-source matching:

- `normalized_matching_profile.source`
- `normalized_matching_profile.external_listing_id`
- `normalized_matching_profile.name`
- `normalized_matching_profile.description`
- `normalized_matching_profile.match_signals`
  - `description_normalized`
  - `description_sha256`
  - `title_normalized`
  - `title_sha256`
  - `listing_composite_key`

## Normalized Availability Block (expected)

Use a stable block for day-level availability:

- `normalized_availability.source`
- `normalized_availability.external_listing_id`
- `normalized_availability.captured_at`
- `normalized_availability.window_start`
- `normalized_availability.window_end`
- `normalized_availability.code_legend`
- `normalized_availability.day_codes`
- `normalized_availability.days[]`
  - `date`
  - `status_code` (`A`, `U`, `I`, `O`, `X`)
  - `is_available`
  - `is_available_for_checkin`
  - `is_available_for_checkout`
  - `booking_day_state`
- `normalized_availability.counts`

## Raw Provider Diagnostics (recommended)

Keep provider-specific diagnostics in `availability_raw` so debugging does not pollute normalized fields.

## Calendar Extraction Playbook

For providers that gate calendar data behind UI interaction:

1. Open detail page
2. Expand hidden content (`Read More` / `Show More`) when needed
3. Click date input (commonly Check-in) to open calendar popup
4. Read visible month/day states
5. Advance calendar with next-arrow controls
6. Stop when horizon is met or no next-month control remains
7. Convert provider states to standard status codes (`A/U/I/O/X`)
8. Populate `days`, `day_codes`, and aggregate counts

## Runner Modes (Operational)

The shared runner supports:

- Full run (discover + detail pull)
- Refresh-known run (`--refresh-known` and/or `--detail-urls-file`)
- Direct-detail run (`--detail-url`)

Common tuning flags:

- `--max-listings`
- `--start-index`
- `--max-scroll-steps`
- `--scroll-pause-ms`
- `--network-idle-wait-ms`
- `--detail-fetch-concurrency`
- `--detail-fetch-delay-ms`

## Runner CLI Contract

The shared runner now uses prefixed flag families so mixed commands are unambiguous.

### `run-*`

- `--run-mode <detail|avail|quote|...>`
- `--run-refresh-mode <full|dynamic|static>`
- `--run-discover-only`

Defaults:

- `run-mode` defaults to `detail,avail`.
- If `run-refresh-mode` is omitted:
  - mode includes `quote` => defaults to `dynamic`
  - mode excludes `quote` => defaults to `static`

### `target-*`

- `--target-detail-url <url>`
- `--target-detail-urls-file <path>`
- `--target-refresh-known`
- `--target-max-listings <n>`
- `--target-start-index <n>`

Constraints:

- `target-detail-url` cannot be combined with `target-detail-urls-file`, `target-refresh-known`, or `run-discover-only`.

### `detail-*`

- `--detail-fetch-concurrency <n>`
- `--detail-fetch-delay-ms <n>`
- `--detail-timeout-ms <n>`

### `avail-*`

- `--avail-horizon-days <n>`
- `--avail-max-calendar-months <n>`

### `quote-*`

- `--quote-window-days <n>`
- `--quote-sample-step-days <n>`
- `--quote-nights <n>`
- `--quote-max-queries <n>`
- `--quote-anchor-date <YYYY-MM-DD>`
- `--quote-observation-retry-delays-ms <csv>`

Typed validation:

- Numeric flags must be valid positive integers (delay flags allow non-negative values).
- `quote-anchor-date` must match `YYYY-MM-DD`.
- `quote-observation-retry-delays-ms` must be comma-separated non-negative integers.

Backward-compatible aliases remain supported for existing scripts (`--mode`, `--refresh-mode`, `--detail-url`, `--detail-urls-file`, `--refresh-known`, `--discover-only`, `--max-listings`, `--start-index`, `--max-scroll-steps`, `--scroll-pause-ms`, `--network-idle-wait-ms`).

## Exclusion Lifecycle Policy

Use exclusion lifecycle files per adapter to avoid permanent hard-coded excludes:

- `src/lib/data/external-sources/<managerKey>/exclusions.lifecycle.json`

Adapter behavior:

- Active exclusions are loaded from lifecycle files.
- Exclusions can be bypassed for lifecycle rechecks using `SCRAPER_INCLUDE_EXCLUDED=1`.

Lifecycle behavior:

- Rechecks run through normal `--refresh-known` flow.
- Listings only move between `active`, `probation`, and `retired` when a detail JSON is actually observed in the current run.
- If a previously pruned listing does not reappear in normal discovery, it is skipped for that cycle (not counted as a failure).

Operational scripts:

- Single adapter: `.tmp/scripts/run-exclusion-lifecycle-for-adapter.mjs`
- All adapters + matrix rebuild: `.tmp/scripts/run-exclusion-lifecycle-all.mjs`

## Current History Model

There is no centralized `external-sources/history` directory in the current runner flow.

Run history is currently represented by:

- Report artifacts under `.tmp/reports/`
- Listing snapshots under `src/lib/data/external-sources/*_listings*.json`
- Detail JSON files under each manager folder

If we later add a dedicated history ledger, keep this document updated and keep legacy artifacts backward-compatible.

## Platform Hints and Troubleshooting

Use these adapter/platform hints when quote/handoff validation fails in ways that look transport-related instead of data-related.

### Signed Handoff URLs (Marker Contract)

Some adapters intentionally encode handoff request behavior in the URL hash fragment.

Contract markers:

- `method`
- `contentType`
- `payload`

Example:

- `https://www.callistavacations.com/api/nrbe/carts/create.json#method=POST&contentType=application%2Fjson&payload=...`

Guidance:

- Do not treat these marker URLs as plain GET endpoints.
- Parse the hash markers and execute the specified request shape exactly.
- Preserve backward compatibility: non-marker URLs continue using normal GET/query flow.

### 360blue / Callista Handoff Behavior

Observed behavior:

- `create.json` returns `200` JSON (cart/session payload) rather than a direct HTML checkout page.
- `/booking` depends on session state and redirects to home when state is missing.

Resolution pattern:

1. Execute signed `POST` from browser context (Playwright).
2. Carry session forward by setting the cart/session references expected by the booking app (`nret[sessionId]` cookie and cart session payload).
3. Navigate to `/booking` in the same browser context.
4. Wait for hydration (`networkidle` + short settle delay).
5. Read visible total from booking DOM (`#total-price`) for compliance checks.

Diagnostic symptom:

- Repeated `405` or home-page redirects in handoff validation usually indicate marker/session flow was bypassed.

### LocalVR and 360blue Completion Notes

- `localvr30a`: quote pricing validation passing (`42/42`) with pricing parity.
- `360blue`: quote pricing validation passing (`592/592`) and handoff validation aligned to visible booking total path.

## New Adapter Checklist

Before merging a new adapter:

1. Add adapter file in `adapters/` with `ScraperAdapter` contract
2. Add entry script `scrape-<managerKey>-engine.ts`
3. Wire npm script aliases in `package.json`
4. Verify full run writes links report, details manifest, and detail JSON
5. Confirm normalized blocks follow this context doc
6. Validate expected listing count in adapter diagnostics when applicable
7. Keep manager key and filenames consistent across all outputs
