# Adapter Pricing Assumptions

This workflow captures full checkout totals once per adapter (or a small sample), then stores rolling percentage assumptions to estimate all-in prices from base rates.

## Goal

For each adapter:

- Probe one listing through full checkout quote capture.
- Extract pricing breakout (`base`, `taxes`, fee lines, `grand_total`).
- Persist rolling assumptions in a stable file for product estimation and DB ingest.

## Storage Contract

Assumptions are stored at:

- `src/lib/data/external-sources/<adapterKey>/pricing-assumptions.json`

Each file contains:

- `assumptions.avg_fee_pct_of_base`
- `assumptions.avg_tax_pct_of_base`
- `assumptions.avg_non_base_pct_of_total`
- `assumptions.avg_all_in_multiplier`
- `assumptions.fee_lines[]` (per-line average amount and percent of base)
- `samples[]` (running sample history)

## Recorder CLI

Use:

- `npm run pricing:assumptions:record -- --adapter-key <adapterKey> --input-file <path-to-json>`

Input JSON shape:

```json
{
  "source_listing_id": "kakJQH2sH0",
  "currency": "USD",
  "check_in_date": "2026-04-19",
  "check_out_date": "2026-04-25",
  "nights": 6,
  "base_total": 3200,
  "taxes_total": 416,
  "fee_lines": [
    { "name": "Cleaning Fee", "amount": 350 },
    { "name": "Service Fee", "amount": 210 }
  ],
  "grand_total": 4176,
  "captured_at": "2026-03-28T18:00:00.000Z"
}
```

## Operational Cadence

Recommended cadence:

- Initial seed: capture 1-5 checkout samples per adapter.
- Daily monitor: optional light probe to detect drift.
- Monthly reseed: refresh adapter assumptions and append new samples.

## Estimation Formula

Given known base nightly average and stay length:

$$
\text{base\_total} = \text{avg\_nightly\_base} \times \text{nights}
$$

$$
\text{estimated\_all\_in} \approx \text{base\_total} \times
\left(1 + \overline{\text{fee\_pct\_of\_base}} + \overline{\text{tax\_pct\_of\_base}}\right)
$$

Use `avg_all_in_multiplier` when a single multiplier is preferred.
