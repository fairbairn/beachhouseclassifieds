# Pricing Conformity Runtime Learnings

Last updated: 2026-03-28T20:25:00Z

## 360blue (Completed Learnings)

- Direct quote endpoint: `GET /api/nrbe/reservation-quotes.json` with `unitId`, `arrivalDate`, `departureDate`, `adults`, `children`.
- Direct quote calls fail with `406` when `user-agent` is empty/missing.
- Direct quote calls succeed when `user-agent` is present; recommended to also set `accept`, `referer`, and `x-requested-with`.
- Observed local direct quote latency is roughly ~0.5s average.
- Browser bootstrap plus quote call is slower end-to-end (~2.0s average) and should be fallback only.
- For tested windows, quote payload exposes `subTotal`, `taxes`, and `total` with no separate fee-line fields.
- Keep pricing assumptions and quote contract adapter-level, and keep 24-week daily rate cache listing-level under `details/pricing`.

## Standard Practice For Future Adapters

- Always send a non-empty `user-agent` for any direct quote API probe or production fast-path quote call.
- Prefer direct API quote fast path first; fallback to browser bootstrap/session on blocked statuses (`403`, `406`, `429`).
- Store retrieval guidance in adapter `pricing-profile.json` under quote retrieval hints so runtime behavior is deterministic.
- Mark matrix `Pricing` as complete only when all are true:
  - valid pricing profile metadata,
  - listing daily rate cache generated,
  - real-time quote path validated.
