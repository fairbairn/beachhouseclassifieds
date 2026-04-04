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

## Output

Pricing outputs are stored under each adapter pricing directory:

- Per-listing pricing JSON files.

Pricing parity for readiness is defined as:

- Pricing Records count equals Files count for the adapter.

Tracked in:

- [Adapter Conformance Status](./adapter-conformance-status.md)

## Why This Matters

The cache builder is the bridge between sparse quote observations and stable serving-time pricing data, while preserving traceability back to observed totals.
