# Pricing Cache Builder

This document explains how pricing cache generation works, what data it uses, and where interpolation is applied.

## Purpose

The pricing cache builder creates per-listing pricing records that can be used for serving, comparisons, and conformance gates.

It combines:

- Observed quote windows.
- Existing normalized rates.
- Assumption snapshots where needed.

## Inputs

Primary inputs are:

- Canonical detail JSON for each listing.
- Quote sidecar observations for quote-capable adapters.
- Adapter assumptions/profile metadata where applicable.

## Builder Flow

1. Read listing scope and source records.
2. Gather quote observations for target windows.
3. Compute normalized per-day rates from observed windows where possible.
4. Fill gaps from deterministic existing rates when available.
5. Apply bounded interpolation/derivation for missing windows.
6. Write per-listing pricing JSON records.

## Interpolation and Derivation

Interpolation is used as a controlled fallback, not as a replacement for observed data.

General policy:

- Prefer observed quote-derived values first.
- Use deterministic existing daily rates second.
- Use conservative derived defaults last.
- Keep unavailable windows explicit rather than inventing availability.

## Provenance and Quality Model (Current)

Pricing rows now carry explicit provenance metadata so derived values are distinguishable from quote-grounded values.

Day-level provenance signals include:

- `value_origin`
- `quote_anchor_scope`
- `has_any_quote_observations`
- `nearest_quote_observation_distance_days`

Monthly summary quality/state now includes:

- `pricing_status` (`grounded`, `estimated`, `no_truth`, `not_available`)
- `recommended_usable_for_ux`
- quote-foundation and availability booleans
- `contrived_day_ratio`
- `quality_band`

These fields are persisted and propagated through ingest, monthly summary refresh, and discover search sync.

## Runtime Storage and Propagation

Current runtime flow for quality metadata:

1. Pricing cache build writes day-level provenance.
2. Sidecar ingest stores provenance in `listing_source_pricing`.
3. Summary refresh computes monthly `pricing_status` and usability fields in `listing_pricing_summary`.
4. Discover query/document sync carries status into search/read models.

This allows UX and sort/query behavior to rely on explicit pricing quality tiers instead of inferring from totals alone.

## Output

Pricing outputs are stored under each adapter pricing directory:

- Per-listing pricing JSON files.

Pricing parity for readiness is defined as:

- Pricing Records count equals Files count for the adapter.

Tracked in:

- [Adapter Conformance Status](./adapter-conformance-status.md)

## Why This Matters

The cache builder is the bridge between sparse quote observations and stable serving-time pricing data, while preserving traceability back to observed totals.
