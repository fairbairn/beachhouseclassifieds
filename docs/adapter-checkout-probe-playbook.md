# Adapter Checkout Probe Playbook

This playbook standardizes how every adapter captures final checkout pricing (base + taxes + fees + total) from one representative listing.

## Why This Exists

Daily scraping may only provide availability and base-rate signals. We need adapter-level checkout assumptions to estimate all-in totals in product UX.

## Required Output Contract

Each successful probe must emit one sample JSON matching this shape:

```json
{
  "source_listing_id": "example-id",
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

Then record into assumptions store:

```bash
npm run pricing:assumptions:record -- --adapter-key <adapterKey> --input-file <sample-json>
```

## Canonical Traversal Pattern

Most adapters follow this flow:

1. Open detail page.
2. Set check-in date (Sunday).
3. Set check-out date (Saturday, 6 nights).
4. Set default guest mix (1 adult unless product needs another baseline).
5. Trigger first CTA (`Select Dates`, `Get Quote`, `Book`, `Reserve`).
6. Wait for pricing summary state.
7. Trigger second CTA to checkout/reservation page.
8. Capture full pricing lines and totals.

## Platform Family Notes

- `track_bluetent`: Often has booking context + quote totals in API before final page.
- `streamline`: `GetPreReservationPrice` and related methods may contain fee/tax breakout.
- `custom_hybrid` / Next.js: frequently requires booking context attach/update before pricing context reflects availability and totals.
- `guesty`: fee/tax details may appear in quote payload or checkout summary endpoint.

## Probe Quality Rules

1. Prefer deterministic API captures over brittle DOM parsing when both are available.
2. Preserve raw response snippets (or key totals) in probe report for auditability.
3. Record failures with reason (`blocked_by_validation`, `requires_identity_step`, `anti_bot`, etc.).
4. Store at least 3 samples per adapter before treating assumptions as stable.

## Refresh Cadence

1. Initial onboarding: 3-5 samples per adapter.
2. Daily drift check: optional 1 sample on high-volume adapters.
3. Monthly reseed: refresh assumptions for all adapters.

## Consumer Behavior

Pricing engine should consume adapter assumptions to estimate all-in total from base-rate only scenarios:

$$
\text{estimated\_all\_in} \approx \text{base\_total} \times \left(1 + \overline{fee\_pct\_of\_base} + \overline{tax\_pct\_of\_base}\right)
$$

Also expose confidence fields from assumption sample count and recency.
