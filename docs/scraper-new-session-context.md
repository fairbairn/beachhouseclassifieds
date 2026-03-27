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

- Listing snapshots: external-sources root with `<managerKey>_listings*.json`
- Per-listing detail files: manager folder under external-sources with `details/json` and `details/html`
- Run reports + manifests: `.tmp/reports`
- Manager key must be reused consistently across:
  - adapter filename
  - entry script name
  - npm script alias
  - output artifact filenames

## Progress + Coverage Notes

- Multiple managers are already on the shared engine.
- RealJoy has a dedicated adapter and script; expected listing target currently tracked as `140`.
- Recent RealJoy artifacts indicate subset/direct-detail reports exist; full-set history confirmation was still being verified when context was requested.
- LocalVR is the next adapter target.

## Next Adapter Focus: localvr30a

Input assumptions for upcoming implementation:

- Base URL provided for discovery.
- Discovery likely needs scrolling to load all listings.
- Expected listing count target: `42`.
- Detail pages include a Summary section with a Read More expansion.
- Calendar appears only after clicking check-in date field.
- Calendar uses popup with month navigation arrows and must be paginated to capture availability horizon.

## Immediate Next Steps

1. Build `localvr30a` adapter using shared runner contract.
2. Implement robust scroll-based listing discovery and de-duplication.
3. Implement detail extraction with:
   - Read More expansion
   - check-in click to reveal calendar
   - month-by-month calendar pagination
4. Emit normalized matching + availability blocks in the standard schema.
5. Run a full pull and validate:
   - discovered listings vs expected `42`
   - reports/manifests/details are written to standard locations.
6. Add/update docs if any convention changes during implementation.

## Working Rules for New Sessions

- Prefer extending existing patterns over introducing new structures.
- Keep manager-specific logic in adapter files only.
- Keep runner generic and reusable.
- If a provider needs special handling, isolate it inside that adapter and keep normalized output contract unchanged.

## Quick Handoff Prompt

Start from the existing shared scraper engine and continue implementing manager adapters with strict schema and folder consistency.

Current priority: implement `localvr30a` adapter with scroll-based listing discovery and click-to-open calendar extraction from detail pages.

Expected outcomes:

- manager key and filenames follow current conventions
- normalized matching and availability blocks match existing manager structure
- artifacts written to standard external-sources and `.tmp/reports` locations
- run validation against expected listing count (`42`) and report any gap with diagnostics
