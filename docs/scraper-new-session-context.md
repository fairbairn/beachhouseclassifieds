# Scraper Program New Session Context

Use this context at the start of a new chat so work can continue without re-discovery.

## Program Status Snapshot

- We are building manager-specific scraper adapters on top of a shared Playwright runner.
- The runner + adapter pattern is established and already used by multiple managers.
- We are standardizing output shape for:
  - listing discovery links
  - detail records
  - normalized matching fields
  - normalized availability fields
- We store pull artifacts in standardized locations (see Storage + Naming section below).

## Strategic Direction

- Keep adding dedicated manager adapters instead of one-off scripts.
- Keep normalized JSON structures consistent across managers.
- Keep calendar extraction logic mapped to a shared status model (`A/U/I/O/X`) so downstream matching/reporting stays uniform.
- Preserve folder and file naming conventions to avoid fragmentation.

## Current Standards

### Runner + Adapter Contract

- Shared runner orchestrates execution modes, concurrency, delays, and artifact writing.
- Each manager has:
  - one adapter file implementing discovery + detail extraction
  - one entry script that calls the shared runner with that adapter

### Calendar Extraction Standard

For calendars that are hidden until user interaction:

1. Open detail page
2. Expand gated content if needed (for example Read More)
3. Click check-in/date control to open calendar popup
4. Read day states for visible month(s)
5. Advance month with next-arrow controls
6. Repeat until horizon/limit reached
7. Map provider day state -> normalized status code (`A/U/I/O/X`)

### JSON Normalization Standard

- Matching block:
  - source manager identifier
  - external listing id
  - normalized title/description fields
  - deterministic hashes and composite key
- Availability block:
  - stable code legend (`A/U/I/O/X`)
  - day-by-day normalized array
  - compact `day_codes` string
  - summary counts
- Provider-specific debug/trace fields go in raw diagnostic blocks.

## Storage + Naming Conventions

- Listing snapshots: adapter-local working files at `external-sources/<managerKey>/working/listings*.json`
- Per-listing detail files: manager folder under external-sources with `details/json` and `details/html`
- Run reports + manifests: `.tmp/reports`
- Manager key must be reused consistently across:
  - adapter filename
  - entry script name
  - npm script alias
  - output artifact filenames

## Progress + Coverage Notes

- Multiple managers are already on the shared engine.
- RealJoy runtime migration is complete and validated (quote validator, pricing alignment, scrape filename checks, and latency smoke).
- Listing discovery manifests are now adapter-local under `working/` folders.
- Benchmark is the next runtime migration target.

## Next Adapter Focus: benchmark30a

Input assumptions for upcoming implementation:

- Adapter already has quote API support but still requires quote-runtime migration completion.
- Existing detail and pricing sidecar corpus is already at parity and can be used for runtime validation.
- Migration target is to switch scraper quote flow to shared runtime quote execution and remove legacy adapter-specific quote module usage.

## Immediate Next Steps

1. Migrate `benchmark30a` quote capture to runtime executor path.
2. Remove legacy quote-module dependency from scraper adapter flow.
3. Run quote refresh at `--weeks 24` to satisfy validator thresholds.
4. Validate quote sidecars, pricing alignment, scrape filename contract, and latency smoke.
5. Update conformance status docs and runtime migration ledger.

## Working Rules for New Sessions

- Prefer extending existing patterns over introducing new structures.
- Keep manager-specific logic in adapter files only.
- Keep runner generic and reusable.
- If a provider needs special handling, isolate it inside that adapter and keep normalized output contract unchanged.

## Quick Handoff Prompt

Start from the existing shared scraper engine and continue implementing manager adapters with strict schema and folder consistency.

Current priority: complete `benchmark30a` runtime quote migration and validation loop.

Expected outcomes:

- runtime quote executor is wired and legacy quote module path is removed
- artifacts are written using adapter-local `external-sources/<managerKey>/working/listings*.json`
- quote/pricing/scrape validators pass at full sampling horizon
