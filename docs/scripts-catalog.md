# src/lib/scripts Catalog

Status: active (living inventory)
Last updated: 2026-04-15

## Purpose

This page is the canonical inventory for top-level scripts under src/lib/scripts.

Use this catalog to:

1. See which scripts are package-surfaced versus internal-only.
2. Locate the npm script aliases that invoke each runner.
3. Reduce duplicate command documentation across runbooks.

Use docs/cli-runner-reference.md for operator guidance and flag details.
Use this page for inventory and ownership coverage.

## Coverage Summary

1. Top-level TypeScript scripts in src/lib/scripts: 35
2. Package-surfaced scripts: 32
3. Internal-only scripts: 3

## Inventory

| Script                                                        | Domain             | Package Scripts                                                                                                                                                                                | Status        | Purpose                                 |
| ------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | --------------------------------------- |
| src/lib/scripts/backfill-quote-sidecar-pricing.ts             | pricing-and-scrape | (none)                                                                                                                                                                                         | internal-only | backfill quote sidecar pricing          |
| src/lib/scripts/refresh-30aescapes-quote-windows.ts           | pricing-and-scrape | (none)                                                                                                                                                                                         | internal-only | refresh 30aescapes quote windows        |
| src/lib/scripts/run-ad-hoc-quote-latency.ts                   | pricing-and-scrape | pricing:latency:adhoc:raw                                                                                                                                                                      | active        | ad hoc quote latency                    |
| src/lib/scripts/run-adapter-ops.ts                            | orchestration      | adapters:ops:raw                                                                                                                                                                               | active        | adapter operations orchestrator         |
| src/lib/scripts/run-adapter-quote.ts                          | pricing-and-scrape | pricing:quote:adapter:raw                                                                                                                                                                      | active        | runtime quote capture runner            |
| src/lib/scripts/run-ai-derivation-readiness-report.ts         | listings           | listings:derivation:readiness:raw                                                                                                                                                              | active        | derivation readiness report             |
| src/lib/scripts/run-ai-enrichment-apply-evaluate.ts           | listings           | listings:enrichment:apply:evaluate:raw                                                                                                                                                         | active        | enrichment apply evaluation             |
| src/lib/scripts/run-ai-enrichment-apply.ts                    | listings           | listings:enrichment:apply:raw                                                                                                                                                                  | active        | enrichment apply runner                 |
| src/lib/scripts/run-ai-enrichment-coverage.ts                 | listings           | listings:enrichment:coverage:raw                                                                                                                                                               | active        | enrichment source coverage audit        |
| src/lib/scripts/run-ai-enrichment-pending.ts                  | listings           | listings:enrichment:pending:raw                                                                                                                                                                | active        | pending enrichment processor            |
| src/lib/scripts/run-ai-enrichment-sleep-repair.ts             | listings           | (none)                                                                                                                                                                                         | internal-only | sleeping arrangement repair utility     |
| src/lib/scripts/run-ai-enrichment-validation.ts               | listings           | listings:enrichment:validate:raw                                                                                                                                                               | active        | enrichment payload validation           |
| src/lib/scripts/run-build-listing-geocode-cache.ts            | listings           | listings:geocode:cache:raw                                                                                                                                                                     | active        | geocode cache builder                   |
| src/lib/scripts/run-canonical-listing-ingest.ts               | listings           | listings:ingest:canonical:all:raw, listings:ingest:canonical:raw                                                                                                                               | active        | canonical listing ingest runner         |
| src/lib/scripts/run-clear-legacy-description-markdown.ts      | listings           | listings:description:clear-legacy:raw                                                                                                                                                          | active        | legacy description cleanup              |
| src/lib/scripts/run-discover-community-normalization-audit.ts | discovery          | discover:normalize:audit:raw                                                                                                                                                                   | active        | community normalization audit           |
| src/lib/scripts/run-fill-null-bedroom-bathroom.ts             | listings           | listings:fill-null-rooms:raw                                                                                                                                                                   | active        | null room-field repair                  |
| src/lib/scripts/run-listing-duplicate-analysis.ts             | listings           | listings:duplicates:analyze:raw                                                                                                                                                                | active        | duplicate analysis and exclusion sync   |
| src/lib/scripts/run-occupancy-health-check.ts                 | pricing-and-scrape | occupancy:health:raw                                                                                                                                                                           | active        | occupancy health diagnostics            |
| src/lib/scripts/run-pricing-cache.ts                          | pricing-and-scrape | pricing:cache:30aescapes:raw, pricing:cache:360blue:raw, pricing:cache:adapter:raw, pricing:cache:homeownerscollection30a:raw, pricing:cache:keyco30a:raw, pricing:cache:royaldestinations:raw | active        | pricing cache builder                   |
| src/lib/scripts/run-pricing-validation.ts                     | pricing-and-scrape | pricing:validate:cache:raw                                                                                                                                                                     | active        | pricing cache validation                |
| src/lib/scripts/run-pull-source-images-to-b2.ts               | media              | images:pull:source:raw                                                                                                                                                                         | active        | source image pull to B2                 |
| src/lib/scripts/run-quote-handoff-alignment-all.ts            | pricing-and-scrape | pricing:validate:handoff:all:raw                                                                                                                                                               | active        | handoff alignment all-adapter run       |
| src/lib/scripts/run-quote-handoff-alignment.ts                | pricing-and-scrape | pricing:validate:handoff:raw                                                                                                                                                                   | active        | handoff alignment runner                |
| src/lib/scripts/run-quote-handoff-render-sample.ts            | pricing-and-scrape | pricing:validate:handoff:render:raw                                                                                                                                                            | active        | sample handoff render validator         |
| src/lib/scripts/run-quote-latency-benchmark.ts                | pricing-and-scrape | pricing:latency:quotes:raw                                                                                                                                                                     | active        | quote latency benchmark                 |
| src/lib/scripts/run-quote-module-isolation-audit.ts           | pricing-and-scrape | pricing:audit:quote-isolation:raw                                                                                                                                                              | active        | quote module isolation audit            |
| src/lib/scripts/run-quote-validation-all.ts                   | pricing-and-scrape | pricing:validate:quotes:all:raw                                                                                                                                                                | active        | quote validation all adapters           |
| src/lib/scripts/run-quote-validation.ts                       | pricing-and-scrape | pricing:validate:30aescapes:raw, pricing:validate:360blue:raw, pricing:validate:keyco30a:raw, pricing:validate:quotes:raw                                                                      | active        | quote validation runner                 |
| src/lib/scripts/run-ready-conformance-matrix-validation.ts    | conformance        | pricing:validate:ready-conformance-matrix:raw                                                                                                                                                  | active        | conformance matrix validation           |
| src/lib/scripts/run-refine-single-listing.ts                  | listings           | listings:refine:single:raw                                                                                                                                                                     | active        | single listing refinement runner        |
| src/lib/scripts/run-scrape-engine.ts                          | pricing-and-scrape | managers:scrape:adapter:engine:raw                                                                                                                                                             | active        | shared scrape engine entrypoint         |
| src/lib/scripts/run-scrape-filename-validation-all.ts         | pricing-and-scrape | pricing:validate:scrape-filenames:all:raw                                                                                                                                                      | active        | scrape filename validation all adapters |
| src/lib/scripts/run-scrape-filename-validation.ts             | pricing-and-scrape | pricing:validate:scrape-filenames:raw                                                                                                                                                          | active        | scrape filename validation runner       |
| src/lib/scripts/run-vrbo-match-summary.ts                     | vrbo               | vrbo:match:summary:raw                                                                                                                                                                         | active        | VRBO match summary report               |

## Catalog Maintenance Rules

1. When adding a new top-level file under src/lib/scripts, add a row here.
2. If package.json exposes a new alias, update Package Scripts cell.
3. If a script becomes internal-only, retain row and change Status to internal-only.
4. Keep this inventory as a reference index; do not duplicate full flag docs already maintained in docs/cli-runner-reference.md.
