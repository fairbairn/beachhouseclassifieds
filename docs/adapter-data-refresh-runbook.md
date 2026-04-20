# Adapter Data Refresh Runbook

Status: active
Last updated: 2026-04-20

## Purpose

Use this runbook when you need to pull updated adapter-source data into Postgres and apply it to listing-facing fields.

This sequence covers:

1. Listing ingest
2. Image ingest
3. Pricing ingest
4. AI enrichment
5. Sleep repair
6. Pricing summary
7. Listing data apply
8. Listing image apply
9. Geocode city/state backfill
10. Listing visibility sync

## Standard Order (Postgres Local)

Run commands in this order.

1. Ingest listings

```bash
npm run listings:ingest:canonical:all:postgres:local
```

2. Ingest images from adapter detail snapshots into source-image tables

```bash
npm run images:ingest:source-links:postgres:local
```

3. Ingest pricing sidecar data

```bash
npm run pricing:ingest:sidecar:postgres:local
```

4. Run pending AI enrichment for listing content generation

```bash
npm run listings:enrichment:pending:postgres:local -- --limit 5000 --concurrency 20 --progress-every 25
```

5. Repair sleep-capacity audit failures

```bash
npm run listings:enrichment:sleep-repair:postgres:local -- --limit 5000 --concurrency 20 --progress-every 25
```

6. Refresh pricing summary rows used by listing-facing pricing data

```bash
npm run pricing:summary:refresh:postgres:local
```

7. Apply latest enrichment content to listing fields

```bash
npm run listings:enrichment:apply:postgres:local
```

8. Apply latest image references to listing `images` and `image_count`

```bash
npm run images:apply:listing:postgres:local
```

9. Run geocode city/state/postal backfill for listing holes

```bash
npm run listings:geocode:cache:postgres:local
```

10. Sync listing visibility reasons (null = visible, non-null = hidden)

```bash
npm run listings:visibility:sync:postgres:local
```

## Post-Run Verification

Use these quick checks after the run.

1. Enrichment pending should be near zero:

```bash
npm run listings:enrichment:pending:postgres:local -- --count-only --limit 5000
```

2. Sleep repair candidates should be zero:

```bash
npm run listings:enrichment:sleep-repair:postgres:local -- --count-only --limit 5000
```

3. Optional image apply idempotency check (second run should usually show low or zero updates):

```bash
npm run images:apply:listing:postgres:local
```

4. Visibility sync dry run (preview reason distribution without writes):

```bash
npm run listings:visibility:sync:postgres:local -- --dry-run
```

## Notes

1. Keep `--concurrency` at 20 for full-pass enrichment/sleep-repair runs unless intentionally tuning.
2. If you only need forecasting counts without model work, use `--count-only` for enrichment pending and sleep repair.
3. `--dry-run` runs processing logic without persistence; use it for behavior checks, not production updates.
4. Geocode backfill acts on active listings with missing or invalid location fields.
5. Visibility sync never deletes listings and does not change listing status; it only sets `listing.visibility_disabled_reason`.

## Visibility Criteria (Current)

A listing is hidden from UX when `visibility_disabled_reason` is non-null.

Current reason precedence:

1. `manual_listing_hidden`
2. `manual_adapter_hidden`
3. `missing_images`
4. `missing_description_markdown`
5. `missing_area_name`
6. `missing_beach_area_name`
7. `missing_lat_lng`
8. `excluded_by_source_link`
9. `missing_active_source_link`

Manual overrides are defined centrally in:

1. `src/lib/listings/visibility/visibility-rules.ts`

## Future Optimization (Incremental Image Ingest)

A useful enhancement is an image-ingest mode that processes only deltas:

1. New listings without prior ingested image rows.
2. Listings where source expected image count differs from currently ingested count.
3. Optional force-refresh mode for full reingest.

This would reduce runtime and make onboarding + quick refresh cycles cheaper than full-batch image ingestion.
