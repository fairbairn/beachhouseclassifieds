# Adapter Operations Top-Down Flow

Status: active
Last updated: 2026-10-29

## Purpose

Use this as the exact top-down operating sequence for any adapter run.

This is intentionally strict and ordered to avoid drift, repeated work, and late-stage surprises.

## Non-Negotiable Rules

1. Do not run quote capture before scraper validators are clean.
2. Do not update conformance matrix until all runtime and validator gates are green.
3. Do not run global recaptures to fix a single listing issue; use targeted prune or targeted remediation.
4. For adapter workflow, do not run Vite build as a required gate.

## Step-by-Step Operational Flow

1. Full refresh (includes discovery in full-scan mode)

```bash
npm run managers:scrape:adapter:engine -- --adapter-key <adapterKey> --inventory-mode full-scan --run-mode detail,avail --allow-canonical-prune
```

2. Scrape filename validator (must pass; orphan warnings must be resolved)

```bash
npm run pricing:validate:scrape-filenames -- --adapter-key <adapterKey>
```

3. Availability status validator

```bash
npm run pricing:validate:availability-status -- --adapter-key <adapterKey>
```

4. Media validator

```bash
npm run pricing:validate:media-gallery-count -- --adapter-key <adapterKey>
```

5. Rooms validator

```bash
npm run pricing:validate:rooms -- --adapter-key <adapterKey>
```

6. If step 2 reports orphan artifacts, remove orphans immediately and re-run step 2 before moving on.

### Preferred Orphan Cleanup Procedure (Required)

When step 2 reports `orphan_artifact` warnings, use the prune runner first. This keeps canonical index + artifact cleanup in one command.

1. Run scrape filename validator and collect orphan listing IDs from warning lines.

```bash
npm run pricing:validate:scrape-filenames -- --adapter-key <adapterKey>
```

2. Remove all orphan listing IDs with the prune runner.

```bash
npm run pricing:prune:listings -- --adapter-key <adapterKey> --listing-ids <id1,id2,...>
```

- Equivalent granular flags are also supported: `--listing-id <id>` (repeatable) and `--listing-ids-file <path>`.
- This command updates `details/index.json` and removes matching artifacts in `details/json`, `details/html`, `details/quotes`, and `details/pricing`.

3. Re-run scrape filename validator and confirm no orphan warnings remain.

```bash
npm run pricing:validate:scrape-filenames -- --adapter-key <adapterKey>
```

4. Continue to availability/media/rooms validators only after orphan warnings are cleared.

### Manual Orphan Cleanup Procedure (Fallback)

When step 2 reports `orphan_artifact` warnings, perform cleanup manually with this exact order.

1. Run scrape filename validator and collect orphan listing IDs from warning lines.

```bash
npm run pricing:validate:scrape-filenames -- --adapter-key <adapterKey>
```

2. Open `src/lib/data/external-sources/<adapterKey>/details/index.json` and ensure canonical index alignment.
   - If an orphan listing ID still appears in `index.json`, remove that listing entry.
   - Save `index.json` before artifact deletion.

3. For each orphan listing ID, remove matching artifacts (if present):
   - `src/lib/data/external-sources/<adapterKey>/details/json/<listingId>.json`
   - `src/lib/data/external-sources/<adapterKey>/details/html/<listingId>.html`
   - `src/lib/data/external-sources/<adapterKey>/details/quotes/<listingId>.json`
   - `src/lib/data/external-sources/<adapterKey>/details/pricing/<listingId>.json`

Example (single listing):

```bash
rm -f src/lib/data/external-sources/<adapterKey>/details/json/<listingId>.json
rm -f src/lib/data/external-sources/<adapterKey>/details/html/<listingId>.html
rm -f src/lib/data/external-sources/<adapterKey>/details/quotes/<listingId>.json
rm -f src/lib/data/external-sources/<adapterKey>/details/pricing/<listingId>.json
```

4. Re-run scrape filename validator and confirm no orphan warnings remain.

```bash
npm run pricing:validate:scrape-filenames -- --adapter-key <adapterKey>
```

5. Continue to availability/media/rooms validators only after orphan warnings are cleared.

6. Full quote pass

```bash
npm run pricing:quote:adapter -- --adapter-key <adapterKey> --all-listings --weeks 24 --continue-on-internal-error
```

8. Quote validator (immediately after quote pass)

```bash
npm run pricing:validate:quotes -- --adapter-key <adapterKey>
```

9. If quote validator fails on one/few listings:

- Prefer targeted action, not full recapture.
- If listing has no normalized availability days and is non-quotable, use the prune runner to remove it from canonical index and matching artifacts:

```bash
npm run pricing:prune:listings -- --adapter-key <adapterKey> --listing-ids <id1,id2,...>
```

- Equivalent granular flags are also supported: `--listing-id <id>` (repeatable) and `--listing-ids-file <path>`.
- Also prune any additional listings that meet the same condition (no availability and unable to quote) before revalidation.
- Re-run quote validator only.

10. Pricing cache build

```bash
npm run pricing:cache:adapter -- --adapter-key <adapterKey>
```

11. Pricing cache validator

```bash
npm run pricing:validate:cache -- --adapter-key <adapterKey>
```

12. Adapter validation suite

```bash
npm run pricing:validate:adapter-suite -- --adapter-key <adapterKey>
```

13. Only after steps 1-12 are green, sync conformance matrix

```bash
npm run pricing:sync:conformance-matrix:raw
```

## Fast Failure Handling

1. Single-listing quote failure: treat as targeted fix.
2. Broad quote failure: inspect adapter runtime behavior and availability extraction before reruns.
3. Orphan warnings: clean immediately; do not defer.
4. Never use full quote reruns just to clear one known rogue listing.

## Definition of Done

Adapter run is done when all are true:

1. Scrape validators are clean (`filenames`, `availability`, `media`, `rooms`).
2. Quote validator passes.
3. Pricing cache build succeeds.
4. Pricing validator passes.
5. Adapter suite passes.
6. Conformance matrix sync is run last.
