# CLI Runner Reference

This is the central operator reference for the main runtime and validation CLIs.

Use this doc to avoid re-reading source every time you need a command or flag.

For full inventory coverage of top-level scripts and package alias mapping, see `docs/scripts-catalog.md`.

## Conventions

- Exit codes:
  - `0`: success
  - `1`: handled failure
  - `130`: cancellation (`Ctrl-C`)
- Adapter selection:
  - Most runners accept `--adapter-key <key>`.
  - Some also support positional `<adapter>`.
- Data roots:
  - Canonical artifacts live under `src/lib/data/external-sources/<adapter>/details`.

For listing-domain policy semantics (enrichment behavior, sleeping arrangement processing, duplicate analysis policy, and exclusion remap rules), use `docs/listings-operations-and-exclusion-spec.md` as the canonical operations spec.

## 1) Unified Adapter Operations

- Package command: `npm run adapters:ops -- [flags]`
- Wrapper: `src/lib/scripts/run-adapter-ops.ts`
- Core implementation: `src/lib/pricing/ops/run-adapter-ops.ts`
- Use when: you want one orchestrated command to run scrape/availability/quote/cache/validation steps.

Common flags:

- Selection:
  - `--adapters <key1,key2,...|all>`
- Step controls:
  - `--mode <detail|avail|quote|pricing>`
  - `--full-scrape`
  - `--discover-new`
  - `--availability-refresh`
  - `--pricing-refresh`
  - `--quote-capture`
  - `--quotes-validate`
  - `--pricing-cache`
  - `--all-steps`
- Quote tuning:
  - `--quote-weeks <n>`
  - `--quote-concurrency <n>`
  - `--quote-listing-concurrency <n>`
  - `--quote-listing-id <listingId>`
  - `--quote-max-listings <n>`
  - `--quote-all-listings`
  - `--quote-skip-existing`
- Discovery/pricing tuning:
  - `--max-new-listings <n>`
  - `--pricing-weeks <n>`
- Runtime behavior:
  - `--continue-on-error`
  - `--dry-run`

Examples:

```bash
npm run adapters:ops -- --adapters funvacay30a --full-scrape --quotes-validate
npm run adapters:ops -- --adapters all --mode detail,quote --quote-max-listings 25
```

## 2) Scrape Engine Runner

- Package command (generic): `npm run managers:scrape:adapter:engine -- --adapter-key <key> [engine flags]`
- Package command (adapter shortcut): `npm run managers:scrape:<adapter>`
- Wrapper: `src/lib/scripts/run-scrape-engine.ts`
- Core implementation: `src/lib/pricing/scraper-engine/run-adapter-scrape.ts`
- Engine options source: `src/lib/pricing/scraper-engine/runner.ts`
- Use when: you need direct scrape-engine control for discovery/detail/availability/quote scrape modes.

Adapter selection:

- `--adapter-key <key>`
- Positional `<adapter>`

High-value engine flags:

- Targeting:
  - `--target-detail-url <url>`
  - `--target-detail-urls-file <path>`
  - `--target-refresh-known`
  - `--run-discover-only`
  - `--target-max-listings <n>`
- Modes:
  - `--run-mode <detail|avail|quote|detail,avail|...>`
  - `--run-refresh-mode <full|dynamic|static>`
- Throughput:
  - `--detail-fetch-concurrency <n>`
  - `--detail-fetch-delay-ms <n>`
  - `--detail-timeout-ms <n>`
  - `--detail-retry-attempts <n>`
  - `--detail-retry-delay-ms <n>`
- Freshness controls:
  - `--skip-existing-details`
  - `--skip-fresh-details`
  - `--fresh-hours <n>`
- Availability/quote windows:
  - `--avail-horizon-days <n>`
  - `--avail-max-calendar-months <n>`
  - `--quote-window-days <n>`
  - `--quote-sample-step-days <n>`
  - `--quote-nights <n>`
  - `--quote-max-queries <n>`
  - `--quote-anchor-date <YYYY-MM-DD>`

Example:

```bash
npm run managers:scrape:adapter:engine -- --adapter-key funvacay30a --target-refresh-known --run-mode detail,avail
```

## 3) Runtime Quote Capture Runner

- Package command: `npm run pricing:quote:adapter -- --adapter-key <key> [flags]`
- Wrapper: `src/lib/scripts/run-adapter-quote.ts`
- Core runtime runner: `src/lib/pricing/quotes/shared/runtime-adapter-quote-runner.ts`
- Use when: you want canonical quote sidecars in `details/quotes` driven by `details/index.json`.

Common flags:

- Selection:
  - `--listing-id <id>`
  - `--max-listings <n>`
  - `--all-listings`
- Window and occupancy:
  - `--weeks <n>`
  - `--nights <n>`
- Throughput and retries:
  - `--listing-concurrency <n>`
  - `--quote-concurrency <n>`
  - `--quote-timeout-ms <ms>`
  - `--quote-max-attempts <n>`
- Freshness/backfill toggles:
  - `--skip-fresh-quotes`
  - `--fresh-hours <n>`
  - `--backfill-only`
  - `--backfill-window-hours <n>`
  - `--dry-run`

Notes:

- Scope guard: adapters in quote-scoped mode require one of `--listing-id`, `--max-listings`, or `--all-listings`.
- Backfill/freshness intent is based on quote sidecar `captured_at` and detail JSON `fetched_at`.

Example (analyze-ish run without forcing all listings):

```bash
npm run pricing:quote:adapter -- --adapter-key funvacay30a --max-listings 20 --skip-fresh-quotes --fresh-hours 24
```

## 4) Quote Sidecar Validator

- Package command: `npm run pricing:validate:quotes -- --adapter-key <key> [flags]`
- Wrapper: `src/lib/scripts/run-quote-validation.ts`
- Core implementation: `src/lib/pricing/validation/validate-adapter-quote-sidecars.ts`
- Use when: validate quote sidecar contract quality for selected active listings.

Flags:

- `--adapter-key <key>`
- `--listing-id <id>`
- `--max-listings <n>`
- `--allow-null-pricing-fields`
- `--summary-only`

Example:

```bash
npm run pricing:validate:quotes -- --adapter-key funvacay30a --summary-only
```

## 5) Pricing Cache Builder

- Package command: `npm run pricing:cache:adapter -- --adapter-key <key> [flags]`
- Wrapper: `src/lib/scripts/run-pricing-cache.ts`
- Core implementation: `src/lib/pricing/cache/build-listing-pricing-cache.ts`
- Use when: produce pricing sidecars in `details/pricing` from detail + quote artifacts.

Flags:

- `--adapter-key <key>`
- `--weeks <n>`
- `--from-date <YYYY-MM-DD>`
- `--listing-id <id>`
- `--max-listings <n>`
- `--dry-run`

Example:

```bash
npm run pricing:cache:adapter -- --adapter-key funvacay30a --weeks 24 --max-listings 50
```

## 6) Scrape Filename/Alignment Validator

- Package command: `npm run pricing:validate:scrape-filenames -- --adapter-key <key> [flags]`
- Wrapper: `src/lib/scripts/run-scrape-filename-validation.ts`
- Core implementation: `src/lib/pricing/validation/validate-scrape-filename-alignment.ts`
- Use when: verify detail/json/html/quote/pricing artifacts are aligned and availability/location basics are sane.

Flags:

- `--adapter-key <key>`
- `--max-listings <n>`

Example:

```bash
npm run pricing:validate:scrape-filenames -- --adapter-key funvacay30a
```

## 7) Ad-Hoc Quote Latency Runner

- Package command: `npm run pricing:latency:adhoc -- [flags]`
- Core implementation: `src/lib/scripts/run-ad-hoc-quote-latency.ts`
- Use when: benchmark runtime quote latency and run spot checks.

Flags:

- Adapter selection:
  - `--adapters <k1,k2|all>`
  - `--adapter-key <key>`
- Sampling:
  - `--sample-listings <n>`
  - `--repeats <n>`
  - `--min-available-observations <n>`
- Occupancy/date controls:
  - `--adults <n>`
  - `--children <n>`
  - `--listing-id <id>`
  - `--start-date <YYYY-MM-DD>`
  - `--end-date <YYYY-MM-DD>`
  - `--random-single`
- Output/behavior:
  - `--include-booking-fetch`
  - `--no-continue-on-error`
  - `--summary-only`
  - `--json`

Operator shorthand:

```bash
npm run pricing:latency:adhoc -- --adapter-key <adapterKey> --random-single
```

## 8) Fast Operator Recipes

Full scrape + scrape validator:

```bash
npm run managers:scrape:funvacay30a
npm run pricing:validate:scrape-filenames -- --adapter-key funvacay30a
```

Quote refresh candidate pass with freshness skip:

```bash
npm run pricing:quote:adapter -- --adapter-key funvacay30a --all-listings --skip-fresh-quotes --fresh-hours 24
```

## 9) Listings Domain Operations

Use when operating canonical listings, AI enrichment workflows, and duplicate suppression policy.

Commands:

- Duplicate analysis and reporting:
  - `npm run listings:duplicates:analyze:postgres:local -- [flags]`
- Pending enrichment processing:
  - `npm run listings:enrichment:pending:postgres:local -- [flags]`
- Enrichment apply:
  - `npm run listings:enrichment:apply:postgres:local -- [flags]`
- Enrichment source coverage:
  - `npm run listings:enrichment:coverage:postgres:local -- [flags]`

Exclusion remap flags on duplicate analysis runner:

- `--sync-exclusions`
- `--apply-exclusions`
- `--sync-adapter-key <key>`
- `--exclude-confidence-threshold <0..1>`
- `--no-require-houselike`

Important:

- Exclusion sync touches only `listing_source_link` rows in scoped adapter set.
- In sync mode, flags are reconciled both ways (`true` and `false`) to prevent stale state leakage.
- Run dry-run first (omit `--apply-exclusions`) before applying writes.

Quote validation + cache build:

```bash
npm run pricing:validate:quotes -- --adapter-key funvacay30a
npm run pricing:cache:adapter -- --adapter-key funvacay30a --weeks 24
```
