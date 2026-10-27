# Adapter Operations Top-Down Flow

Status: active
Last updated: 2026-10-26

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

7. Full quote pass

```bash
npm run pricing:quote:adapter -- --adapter-key <adapterKey> --all-listings --weeks 24 --continue-on-internal-error
```

8. Quote validator (immediately after quote pass)

```bash
npm run pricing:validate:quotes -- --adapter-key <adapterKey>
```

9. If quote validator fails on one/few listings:

- Prefer targeted action, not full recapture.
- If listing has no normalized availability days and is non-quotable, prune it from `details/index.json` and delete matching `json/html/quotes/pricing` artifacts for that listing.
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
