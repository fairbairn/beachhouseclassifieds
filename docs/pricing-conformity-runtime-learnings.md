# Pricing Conformity Runtime Learnings

Last updated: 2026-04-12T16:55:00Z

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

## Royaldestinations (Completed Runtime Pass)

- Unified runtime executed full quote capture across all listings with `--quote-concurrency 4` and `--quote-all-listings`.
- Quote sampling completed for 143 listings over a 24-week horizon.
- Pricing cache fulfillment completed for 143 listings.
- Quote sidecar conformity validation passed: `validated=143`, `failed=0`.

## LocalVR30A (Runtime Migration Learnings)

- Runtime quote flow is mixed transport:
  - browser/session bootstrap for provider state,
  - API quote submission/retrieval for pricing observations.
- LocalVR challenge posture is request-sensitive and can present intermittent anti-bot/challenge friction.
- CloakBrowser-backed runtime path improved quote execution stability versus default browser-only behavior in this adapter context.
- Operational sequence that worked reliably:
  - `npm run pricing:quote:adapter -- --adapter-key localvr30a --all-listings`
  - `npm run pricing:cache:adapter -- --adapter-key localvr30a`
  - `npm run pricing:validate:adapter-suite -- --adapter-key localvr30a`
- Resume pattern for interrupted long quote runs:
  - `npm run pricing:quote:adapter -- --adapter-key localvr30a --all-listings --skip-fresh-quotes --fresh-hours 24`
- Current known quote-sidecar validator edge case:
  - two listings repeatedly return quote `HTTP 400` across sampled windows and flush sidecars with `observations=[]`, which fails strict quote validator requirements (`invalid_observation_count` / `missing_observations`).
  - listing IDs:
    - `blue-bird-beach-gulf-view-pool-6779f90068c10f0010a4aba2`
    - `shore-me-the-way-close-to-beach-bikes-6779f9e8a238c10011093d23`

## FunVacay Remediation Learnings (2026-04-12)

- Capacity profile extraction can fail when adapters rely only on a single widget label path.
  - Action: always include fallback parsing from rendered summary blocks (for example `rc-lodging-beds`, `rc-lodging-baths`, `rc-lodging-occ`) and label-aware text parsing.
- Bath parsing must tolerate half-bath formatting variants (`HF Bath`, `half`, `1/2`) and not silently drop values.
- Gallery extraction should accept only listing-image host/path patterns and actively reject known non-gallery assets.
  - Example rogue class: site logos and static theme images (for example `ngt_logo`).
- Validator warnings should be used to force early detection:
  - all-nullish `property_profile` capacity trio (`beds`, `baths`, `sleeps`),
  - out-of-pattern image URL groups inside a listing's image batch.

### Cross-Adapter Quality Checklist

1. Geospatial first: ensure `latitude` and `longitude` are populated for every listing whenever source provides coordinates.
2. Capacity parity: maximize population of `beds`, `baths`, and `sleeps` via all credible extraction paths.
3. Media hygiene: keep `image_urls` pattern-consistent and purge rogue/static references.
4. Sanity thresholds: keep image-count and pattern anomaly checks enabled to identify adapter regressions quickly.
