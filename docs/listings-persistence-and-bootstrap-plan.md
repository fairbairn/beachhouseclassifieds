# Listings Persistence and Postgres Bootstrap Plan

Status: draft (living document)
Last updated: 2026-04-11

## Why This Plan Exists

We are resetting the listing-domain persistence model to match the current architecture:

- canonical 30ACollections listing as product source of truth
- adapter artifacts remain scrape/query/refresh inputs
- pricing and availability are first-class operational datasets
- search index population is downstream from canonical Postgres state

Auth tables remain managed separately by Better Auth migrations and are not part of the listing-domain Drizzle baseline.

## Core Decisions (Agreed)

1. Use one master Postgres database with environment naming convention:
   - beachclassifieds_local
   - beachclassifieds_dev
   - beachclassifieds_prod
2. Site identity is data, not database naming.
3. Keep canonical listing identity internal:
   - primary id: UUID
   - internal listing number: unique integer
   - canonical slug: deterministic and unique
4. Slug generation is deterministic (no AI generation).
5. Slug pattern:
   - {base-name}[-in-{qualifier}]-{hash8}-at-30a-collections
6. hash8 comes from UUID-derived logic.
7. Adapter linkage is modeled in a separate FK table, not embedded in primary listing table.
8. Keep listing table focused on canonical product data; volatile pricing/availability lives in related tables.

## Slug Policy

1. Base name comes from cleaned property name routine.
2. Optional qualifier priority:
   - community
   - beach area
   - area
   - none
3. Final suffix:
   - hash8
   - at-30a-collections
4. Slug is unique and indexed.
5. Slug should be treated as immutable post-publish.
6. Future slug changes must be handled via slug history redirects.

## Canonical Listings Table (Field List Draft)

Identity and lifecycle:

1. id (uuid, pk)
2. listing_number (int, unique)
3. status (enum)
4. created_at
5. updated_at
6. published_at

Slug fields: 7. slug (text, unique) 8. slug_base (text) 9. slug_qualifier (text, nullable) 10. slug_hash8 (char(8)) 11. slug_generation_version (int) 12. slug_locked (bool)

Core property profile: 13. canonical_name (text, required) 14. display_name (text, nullable) 15. property_type (text initially; enum later) 16. bedrooms (smallint, nullable) 17. bathrooms (numeric(4,1), nullable) 18. sleeps (smallint, nullable)

Content and SEO: 19. description_markdown (text) 20. description_short_plain (text) 21. seo_meta_description (text) 22. seo_meta_title (text) 23. seo_hidden_summary_plain (text) 24. content_version (int) 25. content_generated_at (timestamptz, nullable)

Location and geo: 26. lat (double precision) 27. lng (double precision) 28. address_line1 (text, nullable) 29. city (text, nullable) 30. state (text, nullable) 31. postal_code (text, nullable) 32. country_code (text) 33. area_name (text, nullable) 34. beach_area_name (text, nullable) 35. community_name (text, nullable) 36. is_gulf_front (bool) 37. location_confidence_score (numeric, nullable)

Flexible canonical metadata: 38. traits (jsonb) 39. amenities_normalized (jsonb) 40. search_tags (jsonb) 41. location_profile (jsonb) 42. geo_lineage (jsonb) 43. content_lineage (jsonb) 44. quality_flags (jsonb)

Media placeholders (images deferred): 45. primary_image_id (nullable) 46. image_count (int)

## Required Related Tables (Next)

1. listing_source_link
   - maps canonical listing to adapter_key + external_listing_id
   - tracks active window, confidence, primary-source status, and match evidence
2. listing_availability_day
   - day-level availability status and min-night constraints
3. listing_price_day
   - day-level base/all-in normalized pricing
4. listing_quote_observation
   - quote windows and all-in totals for audit and model confidence
5. site
   - site metadata (for now includes 30acollections)
6. listing_site or listing.site_id
   - initial simple approach: listing.site_id FK to site
   - potential future many-to-many if needed

## Postgres Bootstrap Flow (Step-by-Step)

Phase A: Baseline and cleanup

1. Ensure lint is clean before schema/bootstrap work.
2. Confirm legacy drizzle history reset is completed.

Phase B: Local Postgres with persistence

1. Start postgres local container via core script.
2. Ensure docker volume mount is present and named.
3. Ensure DATABASE_URL target database exists according to naming rule.
4. Verify container restart preserves data via volume.

Phase C: Initial setup

1. Run db setup path using existing core scripts and env profile.
2. Verify minimal current schema is applied.
3. Confirm DB connectivity and migrations are functioning.

Phase D: Rebuild architecture (after bootstrap)

1. Draft new schema (listing + related tables) in Drizzle.
2. Generate initial clean migration set for the new listing domain.
3. Add ingestion pipeline updates for canonical listing construction.
4. Add Meilisearch projection job from canonical DB state.

## Phase D Step 1 (MVP Scope Lock)

Goal: get canonical listings on screen first, without AI enrichment.

### Must-Have Now (MVP)

`listing` fields:

1. `id` (uuid, pk)
2. `listing_number` (int, unique)
3. `site_id` (fk to `site`)
4. `status`
5. `slug` (unique)
6. `slug_base`
7. `slug_qualifier` (nullable)
8. `slug_hash8`
9. `canonical_name`
10. `property_type` (text)
11. `bedrooms`
12. `bathrooms`
13. `sleeps`
14. `description_markdown` (temporary: store existing source description text)
15. `lat`
16. `lng`
17. `city`
18. `state`
19. `postal_code`
20. `country_code`
21. `area_name`
22. `beach_area_name`
23. `community_name`
24. `is_gulf_front`
25. `traits` (jsonb)
26. `amenities_normalized` (jsonb)
27. `created_at`
28. `updated_at`

`site` table (minimal):

1. `id`
2. `slug` (unique, initial value `30acollections`)
3. `name`
4. `status`
5. timestamps

`listing_source_link` table (minimal provenance):

1. `id`
2. `listing_id` (fk)
3. `adapter_key`
4. `external_listing_id`
5. `is_primary_source`
6. `source_status` (active/inactive)
7. `confidence_score`
8. `first_seen_at`
9. `last_seen_at`
10. `active_from`
11. `active_to`
12. `match_method`
13. `match_evidence` (jsonb)

MVP ingestion behavior:

1. Use existing cleaned listing name as slug base input.
2. Build deterministic slug using agreed pattern.
3. Do not run AI description refinement yet.
4. Copy current normalized/source description into canonical `description_markdown` as a temporary display field.

### Deferred Until Detail UX Exists

1. AI-generated long markdown description passes
2. `description_short_plain` refinement
3. `seo_meta_description` generation
4. `seo_meta_title` generation
5. `seo_hidden_summary_plain` generation
6. content generation versioning beyond minimal lineage
7. large-batch enrichment workflows

## AI Enrichment Versioning (Simplified Initial Plan)

Goal: keep first implementation minimal while still supporting source-to-enrichment alignment and quick revert.

### MVP Scope (Phase E1)

Use one version table and one optional pointer field on listing.

1. New table: `listing_ai_enrichment_version`
   - `id` (text, pk)
   - `listing_id` (fk -> listing.id)
   - `source_link_id` (fk -> listing_source_link.id, nullable)
   - `source_content_hash` (text, required)
   - `version_number` (int, required, per-listing sequence)
   - `prompt_version` (text, required)
   - `model` (text, required)
   - `output_payload` (jsonb, required)
   - `output_hash` (text, required)
   - `status` (text, default `generated`) // generated | applied | superseded | failed
   - `generated_at` (timestamptz, required)
   - `applied_at` (timestamptz, nullable)
   - `created_at` (timestamptz, required)
   - `updated_at` (timestamptz, required)

2. Optional pointer on `listing`
   - `active_enrichment_version_id` (nullable fk -> listing_ai_enrichment_version.id)

3. Required indexes/constraints
   - index on (`listing_id`, `generated_at desc`)
   - index on (`listing_id`, `source_content_hash`)
   - unique on (`listing_id`, `version_number`)

### MVP Lifecycle

1. During ingest:
   - continue normal canonical listing ingest
   - update/derive latest source context hash from source snapshot (`description_expanded` driven)
2. During enrichment:
   - generate a new version row tied to current `source_content_hash`
3. During apply:
   - copy selected output fields into `listing`
   - set `listing.active_enrichment_version_id`
   - mark selected version `applied`
4. Drift detection query:
   - compare current source hash vs. source hash of active enrichment version
   - mismatches become rerun candidates
5. Revert:
   - select a previous enrichment version for that listing
   - copy its payload fields back into `listing`
   - repoint `active_enrichment_version_id`

### Why This Is Enough For Now

1. Keeps schema and orchestration simple.
2. Supports explicit source hash alignment.
3. Supports rollback by reapplying prior version payload.
4. Gives immediate churn telemetry from `version_number` growth.

### Deferred Robust Model (Future)

If needed later, evolve into separated context/output/assignment/state tables for higher auditability and queue control:

1. `listing_enrichment_context_version`
2. `listing_enrichment_output_version`
3. `listing_enrichment_assignment_event`
4. `listing_enrichment_state`

Trigger for upgrade: when operational complexity (parallel runs, manual approvals, replay tooling, or frequent churn triage) exceeds what a single version table can manage cleanly.

### Exit Criteria for Step 1

1. New MVP schema migrated successfully.
2. One adapter cohort ingested into canonical `listing` + `listing_source_link`.
3. Listings can be rendered from canonical DB records in UX.
4. Slug resolution is fast and deterministic via unique index.

### Step 1 Progress (2026-04-11)

Completed:

1. Added minimal `site` table to Postgres schema.
2. Added nullable `listing.site_id` FK to enable gradual site scoping rollout.
3. Added `listing_source_link` table for canonical-to-adapter provenance.
4. Added status enum `listing_source_link_status` (`active`, `inactive`).
5. Added migration and applied successfully:
   - `drizzle/pg/0001_common_obadiah_stane.sql`
6. Verified DB objects now exist:
   - `site`
   - `listing_source_link`
7. Reset Drizzle to a clean listing-domain baseline that includes only first-party tables:
   - `site`
   - `listing`
   - `listing_source_link`
8. Standardized listing-domain table/field naming to snake_case for the new baseline.
9. Generated new baseline migration:
   - `drizzle/pg/0000_busy_norman_osborn.sql`

Next:

1. Seed initial site record (`30acollections`).
2. Update ingestion path to populate `listing.site_id` and `listing_source_link`.
3. Keep AI content enrichment deferred until detail UX exists.

## Execution Notes

- Reuse existing core target/profile scripts; avoid one-off local hacks.
- Keep iteration speed high; avoid over-modeling in first pass.
- Preserve determinism and lineage in all canonical transforms.
- Keep this document current as decisions and field lists evolve.

## Bootstrap Execution Log (2026-04-11)

Completed:

1. Started postgres local container via core script (`run:postgres:container:start`).
2. Verified persistent Docker volume mount:
   - volume name: `local_db_container_pgdata`
   - mount destination: `/var/lib/postgresql/data`
3. Verified target DB naming from env profile:
   - expected DB: `beachclassifieds_local`
4. Database did not exist on initial start because the reused volume already had a pre-existing cluster.
5. Created target database manually: `beachclassifieds_local`.
6. Persistence test passed:
   - wrote probe row to `bootstrap_persistence_probe`
   - removed/recreated container
   - probe row persisted (`1:persist-check`)

Blocker resolved:

1. Legacy drizzle migration history was removed and regenerated from clean baseline.
2. Auth column naming in `schema-postgres.ts` was aligned to Better Auth camelCase fields.
3. Postgres setup order was updated to run Drizzle migrations before Better Auth migrations.
4. `db:setup:postgres:local` now completes successfully.

Verification after fix:

1. Fresh migration baseline generated:
   - `drizzle/pg/0000_polite_the_stranger.sql`
2. Clean DB reset and setup performed:
   - dropped and recreated `beachclassifieds_local`
   - reran `db:setup:postgres:local`
3. Public tables present after setup:
   - `account`, `session`, `verification`, `user`
   - `listing`, `sources`, `managers`, `listing_manager_relationships`, `listing_price_snapshot`
4. Drizzle tracking table present and populated:
   - `drizzle.__drizzle_migrations` count = 1

Baseline reset update:

1. Replaced prior listing-domain migration history with a new clean baseline migration rooted in the current agreed MVP schema.
2. Drizzle config now scopes schema generation to first-party listing-domain tables only.
3. New baseline migration currently contains only:
   - `site`
   - `listing`
   - `listing_source_link`
