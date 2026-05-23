# Scraper Engine Adapter Foundation

This document defines the baseline contract for all new scraper-engine adapters.

## Goals

- Keep existing adapters stable.
- Make new adapters consistent in runtime knobs and log output.
- Preserve compatibility with existing env names while standardizing new names.

## Scope

Applies to new adapters under `src/lib/pricing/scraper-engine/adapters/*` and the shared engine entrypoint `src/lib/scripts/run-scrape-engine.ts`.

## Shared CLI Contract (Already Standard)

All adapter runs use the shared runner flags in `src/lib/pricing/scraper-engine/runner.ts`:

- `--max-listings`
- `--start-index`
- `--detail-url`
- `--discover-only`
- `--detail-urls-file`
- `--refresh-known`
- `--max-scroll-steps`
- `--scroll-pause-ms`
- `--network-idle-wait-ms`
- `--detail-fetch-concurrency`
- `--detail-fetch-delay-ms`

For new adapters, do not add adapter-specific CLI flags unless they are promoted to the shared runner.

## Runtime Env Contract For New Adapters

Use canonical env names derived from adapter manager key:

- `<PREFIX>_DETAIL_FETCH_DELAY_MS`
- `<PREFIX>_DETAIL_FETCH_CONCURRENCY`
- `<PREFIX>_AVAILABILITY_HORIZON_DAYS`
- `<PREFIX>_MAX_CALENDAR_ADVANCE_MONTHS`

Where `<PREFIX>` is uppercase snake case from manager key.

### Backward Compatibility

The foundation resolver also supports legacy aliases for compatibility:

- `<PREFIX>_FETCH_CONCURRENCY` alias for `DETAIL_FETCH_CONCURRENCY`
- `<PREFIX>_CALENDAR_MAX_MONTHS` alias for `MAX_CALENDAR_ADVANCE_MONTHS`

## Discovery Log Taxonomy For New Adapters

Use standardized discovery event shapes:

- `discovery expected ...`
- `discovery progress ...`
- `discovery early_stop ...`
- `discovery summary ...`

This makes logs machine-comparable across adapters while preserving free-form extras.

## Minimum Run Logging Standard

New adapters should preserve the shared progress event flow emitted by the runner and keep adapter messages compatible with it:

- `phase`: lifecycle transitions (start, open page, discover, pull details, discover-only completion)
- `info`: effective runtime knobs (mode, scroll/delay/concurrency)
- `tick`: incremental progress and adapter discovery diagnostics
- `done`: completion summary

Adapter code should emit concise `reportProgress(...)` messages that naturally fit under `tick`.

Preferred style reference adapters:

- `stayon30a`
- `scenicstays30a`
- `royaldestinations` (adds manager-specific detail while staying runner-compatible)

This is a minimum consistency target, not a hard cap: adapters may add richer diagnostics when it improves operability.

## Foundation Helper

Use `src/lib/pricing/scraper-engine/adapter-foundation.ts` in new adapters.

Exports:

- `resolveAdapterRuntime(...)`
- `createDiscoveryLogger(...)`

### Example Pattern

```ts
import {
  createDiscoveryLogger,
  resolveAdapterRuntime,
} from "./adapter-foundation";

const runtime = resolveAdapterRuntime({
  managerKey: "30abeach",
  defaults: {
    detailFetchDelayMs: 250,
    detailFetchConcurrency: 6,
    availabilityHorizonDays: 730,
    maxCalendarAdvanceMonths: 24,
  },
});

const logger = createDiscoveryLogger(context.reportProgress);
logger.expected({
  source: "dom",
  expected: expectedCount,
  initialDiscovered: rows.length,
});
logger.progress({
  stage: "scroll",
  discovered: rows.length,
  step,
  maxSteps: maxScrollSteps,
});
logger.summary({
  selected: merged.length,
  bySource: { dom: domCount, api: apiCount },
});
```

## Non-Breaking Migration Plan

- Phase 1: Use foundation only for newly created adapters.
- Phase 2: Opt-in migration for adapters that need maintenance anyway.
- Phase 3: Optional lint/check script to enforce canonical env names and minimum logging events for newly added adapter files.

This avoids risky broad rewrites of already-working adapters.

## Browser Engine Migration Policy (Playwright -> CloakBrowser)

Use browser-engine migration only where needed. Playwright remains the default baseline unless an adapter shows repeatable blocking that is mitigated by CloakBrowser.

### Scope and Rollout Rules

1. Migrate one adapter at a time.
2. Migrate one stage at a time:

- detail fetch first
- discovery second (only if required)

3. Do not convert all adapters by default.
4. Preserve shared runner CLI contract and adapter output schemas during migration.

### Required Evidence Before Promotion

1. Baseline Playwright run on constrained sample (for example 10 listings, no retries).
2. Equivalent constrained CloakBrowser run.
3. Comparison shows lower transport/blocking failures without introducing extraction regressions.

### Minimal Adapter Integration Pattern

1. Start with adapter-local helper that launches CloakBrowser and uses `browser.newPage()`.
2. Keep lifecycle explicit: launch, navigate, extract, close page, close browser.
3. Avoid introducing context-based flows unless required by proven adapter behavior.
4. Keep existing parser and normalization paths unchanged while swapping browser fetch surface.

### Validation Loop Per Adapter Change

1. Run constrained scrape check:

- `npm run managers:scrape:adapter:engine -- --adapter-key ADAPTER_KEY --refresh-known --max-listings 10 --detail-retry-attempts 0`

2. Confirm report-level deltas:

- detail pages pulled
- detail pages failed
- failed detail URL signatures/status patterns

3. If behavior improved, run a broader but still controlled sample before considering next adapter.

### Failure and Rollback Rule

1. If CloakBrowser path fails to improve outcomes or causes parser/output instability, roll back that adapter stage and document findings.
2. Do not proceed to the next adapter until current adapter stage is stable.
