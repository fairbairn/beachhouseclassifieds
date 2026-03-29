# Pricing Quote Sync Reference

This document captures the current 30aescapes pattern for keeping quote observations and listing pricing cache aligned.

## Goal

Use quote API observations as the best available pricing truth signals, then materialize a daily pricing surface that UX can use for fast pre-quote estimates.

## Source Of Truth Roles

1. Quote API windows where `quote_available=true`
2. Day-level normalized rates captured in listing detail JSON (when present)
3. Interpolation between known anchors
4. Assumptions/default anchor as last fallback

Meaning:

- Quote observations are acquisition signals and audit trail.
- Pricing cache is the serving layer for estimated daily and trip pricing in UX.
- Live quote API call remains checkout truth for exact final totals.

## Canonical Run Order

For lockstep sync, run these in one uninterrupted pass:

1. Pricing refresh (dynamic detail refresh, quote acquisition)
2. Pricing cache build

In this repo, the ordered orchestration is handled by:

- `npm run adapters:ops -- --adapters 30aescapes --pricing-refresh --pricing-cache --pricing-weeks 24`

The orchestrator executes pricing refresh before pricing cache for the selected adapter.

## Horizons And Alignment

- Quote sampling: 24 weeks (168 days)
- Pricing cache default: 24 weeks

Keep these equal so cache coverage matches quote observation coverage.

## 30aescapes Data Flow

### Quote Sidecar

- Path: `src/lib/data/external-sources/30aescapes/details/quotes/<listing>.json`
- Contains weekly observations, including unavailable windows for diagnostics.

Important behavior:

- Unavailable quote windows are preserved as observations.
- Only available quote windows are used as interpolation anchors.

### Detail JSON Normalized Rates

- Path: `src/lib/data/external-sources/30aescapes/details/json/<listing>.json`
- `normalized_rates.days[]` stores day-level rate surface used by cache build.

### Listing Pricing Cache

- Path: `src/lib/data/external-sources/30aescapes/details/pricing/<listing>.json`
- Daily records include:
  - `base_nightly`
  - `all_in_nightly`
  - `estimated_fees_nightly`
  - `estimated_taxes_nightly`
  - `source`
  - `confidence`

## Interpolation Policy

Daily cache seeding preference:

1. Quote-derived day anchors from `quote_available=true` observations
2. Real normalized day rates
3. Interpolation over missing days
4. Listing anchor/assumption fallback

This avoids treating unavailable quote rows as pricing truth while still retaining them for analysis.

## UX Serving Policy

For pre-quote UX estimates:

1. Read pricing cache daily rows for selected stay window
2. Sum/average to compute:
   - estimated base nightly
   - estimated all-in nightly
   - estimated trip total
   - estimated tax/fee contribution
3. Show source/confidence hints where possible

For final booking/checkout:

1. Call quote API for exact current totals
2. Replace estimate with quote-truth response

## Skew Risks And Guardrails

Main skew risk:

- Interrupted pipeline between dynamic refresh and cache build.

Guardrails:

1. Always run refresh + cache in one command.
2. Keep horizon weeks equal in both stages.
3. Compare `quotes.captured_at` and `pricing.generated_at` during spot checks.
4. Treat unavailable quote rows as estimate context only.

## Adapter Rollout Checklist

When extending this pattern to other adapters:

1. Ensure weekly quote sidecar exists and includes availability flag.
2. Ensure unavailable windows are not used as anchor seeds.
3. Ensure cache builder can consume quote anchors and day-level rates.
4. Ensure ops runner executes refresh before cache.
5. Validate one representative listing with week-level comparisons.
