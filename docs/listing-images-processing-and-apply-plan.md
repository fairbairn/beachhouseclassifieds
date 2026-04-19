# Listing Images Processing and Apply Plan

Status: draft (living document)
Last updated: 2026-04-18

## Why This Plan Exists

We need image-backed UX now, but full canonical image processing (download, color-correct, dedupe, archive, CDN) will take time at current scale (~190,000 images).

This plan separates:

1. Processing truth (source observations, hashing, storage lineage)
2. Runtime truth (join-free image payload on `listing`)

Primary goals:

1. Keep source image payloads out of runtime listing semantics long-term.
2. Enable immediate UX development using interim source URLs.
3. Preserve future migration path to canonical hash-based site images without API contract churn.
4. Prevent duplicate image storage via content-hash identity.

## Core Architecture

### Runtime read model (`listing`)

`listing` remains query-optimized and join-free for discover/detail reads.

Store only runtime-ready image projection:

1. `images` (jsonb): ordered array used by APIs/UI
2. `image_count` (integer): count derived from `images`
3. `images_version` (integer): increments only when projection payload changes

No raw `source_images` payload on `listing`.

### Processing model (`listing_image_processing`)

Create a dedicated processing table for lineage and state, keyed operationally by `source_link_id`.

One row should represent one ingest/apply candidate for one listing-source relationship. Keep history by writing new rows over time instead of mutating a single permanent row.

Suggested columns (first pass):

1. `id` (text pk)
2. `listing_id` (fk -> listing.id)
3. `source_link_id` (fk -> listing_source_link.id)
4. `adapter_key` (snapshot)
5. `external_listing_id` (snapshot)
6. `source_json_image_count` (integer) // source detail json count field for verification
7. `source_images_count` (integer) // normalized `source_images` array length
8. `source_images` (jsonb) // extracted from detail JSON `image_urls`
9. `site_images_count` (integer) // normalized `site_images` array length
10. `site_images` (jsonb) // canonical processed images (initially empty)
11. `active_source` (text) // `source_images` or `site_images`
12. `status` (text) // pending | processing | ready | failed | superseded | orphaned
13. `source_content_hash` (text) // hash of normalized source image payload
14. `output_hash` (text) // hash of chosen active payload used for apply
15. `error_payload` (jsonb)
16. `metrics_payload` (jsonb)
17. `generated_at` (timestamptz)
18. `applied_at` (timestamptz)
19. `created_at` (timestamptz)
20. `updated_at` (timestamptz)

Required indexes and constraints:

1. index on `source_link_id`
2. index on `listing_id`
3. index on (`status`, `active_source`)
4. index on (`adapter_key`, `external_listing_id`)
5. idempotency unique guard (for example `source_link_id` + `source_content_hash`)

This table semantics intentionally mirrors enrichment-style workflow.

### Universal asset model (future dedupe backbone)

Canonical image bytes live in object storage, not DB rows.

Storage paths:

1. Source archive copy (immutable):
   - `source-listings/{adapter}/{external_listing_id}/{image_name.ext}`
2. Final canonical hash archive:
   - `/listing/images/{shard2}/{shard4}/{content_hash}.{ext}`

Canonical identity is content hash of bytes, not source URL.

## Interim Now (Development Unblock)

### Interim source of truth

Until canonical processing finishes, we apply from `source_images` in processing table into `listing.images`.

Result:

1. UX can develop against real image URLs now.
2. Runtime APIs already use `listing.images` shape.
3. No runtime joins required.

### Interim apply rules

1. Choose active processing row for listing (prefer active primary source link).
2. Use `source_images` as active payload.
3. Normalize to runtime image item shape and write `listing.images`.
4. Set `image_count` and increment `images_version` only when payload changes.

### Interim ingest rules (all adapters/listings)

1. Traverse all adapter detail JSON files currently available.
2. Resolve each record to `listing_source_link` and `listing`.
3. Extract `image_urls` array and source-provided image count field.
4. Normalize and dedupe URLs for `source_images`.
5. Persist both `source_json_image_count` and `source_images_count`.
6. Record mismatch details in `metrics_payload` for QA visibility.
7. Mark row `ready` when structural validations pass.

### Count verification checks

1. `source_json_image_count` equals `source_images_count` -> pass
2. mismatch -> keep row but flag discrepancy in `metrics_payload`
3. malformed/empty source arrays -> `failed` with concise `error_payload`

## Next Week (Parallel Canonical Pipeline)

Build high-throughput pipeline for all source images:

1. Extract source URLs per active source link.
2. Download to source archive path.
3. Hash image bytes.
4. Color-correct/process.
5. Store canonical hash-keyed image file in final archive.
6. Populate `site_images` in processing table with canonical references.

When a listing has complete canonical coverage:

1. Flip apply source from `source_images` to `site_images`.
2. Re-apply listing projection.
3. Keep runtime API contract unchanged.

## Runtime Image Item Contract

Keep `listing.images` contract stable across interim and final phases.

Suggested item shape:

1. `src` (string)
2. `sort_order` (integer)
3. `alt` (string | null)
4. `content_hash` (string | null) // null in earliest interim if not yet computed
5. `source` (text) // `source` or `site`

Interim:

1. `src` points to source URL
2. `source = source`

Final:

1. `src` points to canonical CDN URL
2. `source = site`
3. `content_hash` required

## Source Link Churn and Orphan Handling

Image set authority is tied to active `listing_source_link`.

If active source changes:

1. Ingest new source image set under new source link context.
2. Re-run apply using new active source set.
3. Mark stale rows as `superseded`/`orphaned` as needed.
4. Preserve historical rows for audit/replay.

## Idempotency and Safety Rules

1. Upserts must be idempotent.
2. Apply step should no-op when output hash unchanged.
3. Never write empty runtime `listing.images` unless explicitly allowed by policy.
4. Store concise error payloads for failed processing runs.
5. Keep `listing` runtime fields strictly projection-only.

## Phase Plan

### Phase 1: Schema + interim ingest/apply

1. Add `listing` runtime image projection columns.
2. Add processing table.
3. Build ingestion from all adapter detail JSON `image_urls` plus source count field.
4. Build apply runner using `source_images` from active processing rows.
5. Copy interim image projection into `listing.images` for discover/detail UX.
6. Wire discover/detail query paths to `listing.images`.

### Phase 2: Canonical archive + dedupe

1. Implement source archive downloader.
2. Implement hash + canonical path writer.
3. Populate `site_images` payloads.
4. Validate coverage and parity.

### Phase 3: source -> site cutover

1. Switch apply source preference to `site_images` where available.
2. Re-apply all listings.
3. Keep source payload for fallback until confidence threshold met.

## Open Decisions

1. Exact enum values for processing status.
2. Hash algorithm standard (expected: SHA-256).
3. Canonical image format policy per source format (keep extension or normalize).
4. Alt text generation timing and ownership.
5. Rollback rule if canonical image URL is unavailable at serve time.

## Immediate Start Checklist

1. Create migration for `listing` image projection columns.
2. Create migration for `listing_image_processing` table.
3. Add normalization utility for image item contract.
4. Add interim ingest command from existing detail JSONs.
5. Add apply command writing to `listing.images`.
6. Validate discover and detail route payloads against projected listing images.
