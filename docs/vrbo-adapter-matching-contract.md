# VRBO Adapter Matching Contract

## Purpose

This contract defines how adapter listing detail JSON files are matched against the VRBO population and how output artifacts are written.

The goal is deterministic, auditable matching with confidence scoring and repeatable lookup/report outputs.

## Inputs

### Adapter Listing Source

Path pattern:

- `src/lib/data/external-sources/<adapter-key>/details/json/<external-listing-id>.json`

Required fields consumed:

- `external_listing_id`
- `detail_url`
- `normalized_matching_profile.name` (fallback to `h1` or `title`)
- `normalized_matching_profile.description` (fallback to `description_expanded`)
- `location.address`

### VRBO Population Source

Path pattern:

- `db/listings/<vrbo-ref-id>.json`

Fields consumed:

- `id` (fallback to filename)
- `url` (source listing id parsed from path segment)
- `name`
- `description.about.items[0].items[0].items[0]` (fallback paths supported)
- `address.city`
- `address.display`
- `coordinate.latitude`
- `coordinate.longitude`

## Output Structure

### Match Artifacts

Path pattern:

- `db/matches/<adapter-key>/<external-listing-id>.json`

Contract key:

- `vrbo-adapter-match-v1`

Top-level shape:

- `adapter`
- `vrbo`
- `deduced`
- `match`
- `prototype`

### Lookup Files

Generated paths:

- `db/lookups/adapter-to-vrbo.json`
- `db/lookups/vrbo-to-adapter.json`
- `db/lookups/coverage-summary.json`
- `db/lookups/<adapter-key>-match-report.json`

## Scoring Model

For each adapter listing, every VRBO listing is scored and ranked.

Score formula:

- `name_similarity * 0.60`
- `description_overlap * 0.15`
- `address_signal * 0.20`
- `city_signal * 0.05`

Hard exact override:

- if `name_similarity == 1` and `address_signal == 1` and `city_signal == 1`, final score is `1.0`

Acceptance gate:

- score must be `>= min_score` (default `0.88`)
- margin from second-ranked candidate must be `>= 0.015`

Confidence labels:

- `exact` for `1.0`
- `high` for `>= 0.95`
- `medium` for `>= 0.88`
- `low` otherwise

## CLI Contract

Script:

- `src/lib/vrbo/run-adapter-vrbo-matching.ts`

NPM entrypoints:

- `npm run vrbo:match:adapter -- --adapter-key <adapter-key> [options]`
- `npm run vrbo:match:royaldestinations`

Supported options:

- `--adapter-key <key>` required
- `--external-root <path>` default `src/lib/data/external-sources`
- `--vrbo-listings-dir <path>` default `db/listings`
- `--matches-root <path>` default `db/matches`
- `--lookups-dir <path>` default `db/lookups`
- `--min-score <0..1>` default `0.88`
- `--limit <n>` optional
- `--dry-run`
- `--reset`
- `--verbose`

Exit codes:

- `0` success
- `1` handled failure
- `130` cancellation (Ctrl-C)

## Operational Procedure

1. Load adapter detail JSON files for one adapter.
2. Load full VRBO listing population from `db/listings`.
3. Score and rank candidates per adapter listing.
4. Apply threshold and margin gate.
5. Write adapter-scoped match artifacts.
6. Rebuild lookup files and summary/report files.
7. Review unmatched set for threshold tuning or signal improvements.

## Notes and Evolution

- This is a deterministic baseline contract designed for repeatability.
- Future revisions may add geocode distance and stricter address parsing.
- If scoring model weights change, increment contract version and document migration notes.
