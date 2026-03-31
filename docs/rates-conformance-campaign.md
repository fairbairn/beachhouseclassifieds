# Rates Conformance Campaign

Last generated: 2026-03-29T00:42:00Z

This campaign orders adapters by listing count (high to low) and defines a concrete rate extraction reinvestigation path per adapter.

Canonical conformity references:

- [docs/rates-conformity-contract.md](rates-conformity-contract.md)
- [docs/rates-conformity-rollout-matrix.md](rates-conformity-rollout-matrix.md)

## Goal

Prepare all adapters for rates-required conformance by completing adapter-level pricing contracts (quote + assumptions + handoff), with listing-level daily rates treated as preferred but secondary.

## Priority Queue (High Listing Count to Low)

| Rank | Adapter                 | Files | Rates | Gap | Status      | API Rates Signal | API Availability Signal | API Quote Signal | Platform Family | Reinvestigation Method                                                                                                                                                                                                                                    |
| ---: | ----------------------- | ----: | ----: | --: | ----------- | ---------------- | ----------------------- | ---------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|    1 | 360blue                 |   592 |     0 | 592 | in_progress | no               | yes                     | yes              | custom_hybrid   | Pricing runtime path is now validated: assumptions 3/3, listing daily cache regenerated for all 592 details, and direct API quote fast path verified. Remaining gap: handoff signature proof for full Rates Ready.                                        |
|    2 | keyco30a                |   381 |    11 | 370 | in_progress | no               | yes                     | yes              | custom_hybrid   | Next active adapter. Pricing cache parity is complete (381/381), but nightly rates remain sparse (11/381). Next: stabilize nightly extraction path and close remaining rates gap.                                                                         |
|    3 | homeownerscollection30a |   208 |   207 |   1 | in_progress | yes              | yes                     | yes              | track_bluetent  | Dynamic refresh + 24-week pricing cache completed (206 pulls, 0 failures). Remaining work: close final 1-listing nightly-rate gap and capture handoff signature proof for full rates-ready closure.                                                       |
|    4 | 30aescapes              |   169 |   169 |   0 | complete    | yes              | yes                     | yes              | track_bluetent  | Dynamic refresh now fills 168-day `normalized_rates.days` and `rates_raw.observations` for all 169 listings via direct quote API (`/rentals/ajax/get-pdp-rates.cfm`). Assumptions sample depth remains 1 and should be increased for readiness hardening. |
|    5 | royaldestinations       |   143 |     0 | 143 | in_progress | no               | yes                     | yes              | track_bluetent  | `rcItemAvailForm` exposes `/rescms/ajax/item/pricing/simple`; wire deterministic quote requests and map returned nightly components into normalized_rates.                                                                                                |
|    6 | realjoy30a              |   140 |     0 | 140 | in_progress | no               | no                      | no               | track_bluetent  | Track-hosted `/bookingEngine/*` stack confirmed; capture booking CTA/date-change network to identify quote endpoint and extract fee/tax line items.                                                                                                       |
|    7 | benchmark30a            |   128 |     0 | 128 | in_progress | no               | yes                     | yes              | track_bluetent  | `rcItemAvailForm` exposes `/rescms/ajax/item/pricing/simple`; wire deterministic quote requests and map returned nightly components into normalized_rates.                                                                                                |
|    8 | 30avacay                |   115 |     0 | 115 | needs_rates | no               | no                      | no               | track_bluetent  | Probe Track/Bluetent router and booking endpoints for daily or season rates; fallback to DOM rates table if API unavailable.                                                                                                                              |
|    9 | oceanreef30a            |   111 |     0 | 111 | needs_rates | no               | no                      | no               | custom_hybrid   | Capture detail-page network traffic during date interactions, identify deterministic rate endpoint, then implement parser with diagnostics.                                                                                                               |
|   10 | exclusive30a            |   106 |     0 | 106 | in_progress | no               | no                      | yes              | custom_hybrid   | `/quote` contract is now integrated and validated end-to-end (106/106 quote sidecars + pricing cache + validator pass). Remaining gap: identify deterministic daily-rates API for `normalized_rates` parity.                                              |
|   11 | sandpiper30a            |   106 |     0 | 106 | needs_rates | no               | no                      | no               | track_bluetent  | Probe Track/Bluetent router and booking endpoints for daily or season rates; fallback to DOM rates table if API unavailable.                                                                                                                              |
|   12 | 30aluxury               |   105 |     0 | 105 | needs_rates | no               | no                      | no               | custom_hybrid   | Capture detail-page network traffic during date interactions, identify deterministic rate endpoint, then implement parser with diagnostics.                                                                                                               |
|   13 | dunevr30a               |    85 |    85 |   0 | complete    | yes              | yes                     | yes              | streamline      | Probe wp-admin streamline methods first (GetPropertyRates or GetPropertyRatesRawData), then map response days to normalized_rates.                                                                                                                        |
|   14 | stayon30a               |    78 |     0 |  78 | needs_rates | no               | yes                     | no               | streamline      | Probe wp-admin streamline methods first (GetPropertyRates or GetPropertyRatesRawData), then map response days to normalized_rates.                                                                                                                        |
|   15 | sandersbeach30a         |    73 |     0 |  73 | needs_rates | no               | no                      | no               | track_bluetent  | Probe Track/Bluetent router and booking endpoints for daily or season rates; fallback to DOM rates table if API unavailable.                                                                                                                              |
|   16 | oversee30a              |    67 |     0 |  67 | needs_rates | no               | yes                     | no               | custom_hybrid   | Capture detail-page network traffic during date interactions, identify deterministic rate endpoint, then implement parser with diagnostics.                                                                                                               |
|   17 | fivestar30a             |    62 |    62 |   0 | complete    | no               | no                      | no               | custom_hybrid   | Capture detail-page network traffic during date interactions, identify deterministic rate endpoint, then implement parser with diagnostics.                                                                                                               |
|   18 | panhandle30a            |    51 |     0 |  51 | needs_rates | no               | no                      | no               | track_bluetent  | Probe Track/Bluetent router and booking endpoints for daily or season rates; fallback to DOM rates table if API unavailable.                                                                                                                              |
|   19 | scenicstays30a          |    44 |    44 |   0 | complete    | yes              | yes                     | no               | streamline      | Probe wp-admin streamline methods first (GetPropertyRates or GetPropertyRatesRawData), then map response days to normalized_rates.                                                                                                                        |
|   20 | localvr30a              |    42 |     0 |  42 | needs_rates | no               | no                      | no               | guesty          | Probe Guesty property/quote endpoints for nightly pricing payloads; align date windows with normalized_availability horizon.                                                                                                                              |
|   21 | funvacay30a             |    40 |     0 |  40 | needs_rates | no               | no                      | yes              | track_bluetent  | Probe Track/Bluetent router and booking endpoints for daily or season rates; fallback to DOM rates table if API unavailable.                                                                                                                              |
|   22 | stayat30a               |    37 |     0 |  37 | needs_rates | no               | no                      | no               | track_bluetent  | Probe Track/Bluetent router and booking endpoints for daily or season rates; fallback to DOM rates table if API unavailable.                                                                                                                              |
|   23 | grayt30a                |    35 |     0 |  35 | needs_rates | no               | no                      | no               | track_bluetent  | Probe Track/Bluetent router and booking endpoints for daily or season rates; fallback to DOM rates table if API unavailable.                                                                                                                              |
|   24 | coastproperties30a      |    30 |    30 |   0 | complete    | yes              | yes                     | no               | streamline      | Probe wp-admin streamline methods first (GetPropertyRates or GetPropertyRatesRawData), then map response days to normalized_rates.                                                                                                                        |
|   25 | 30abeach                |    17 |    17 |   0 | complete    | yes              | yes                     | yes              | streamline      | Probe wp-admin streamline methods first (GetPropertyRates or GetPropertyRatesRawData), then map response days to normalized_rates.                                                                                                                        |
|   26 | beachblue               |    16 |     0 |  16 | needs_rates | no               | no                      | no               | custom_hybrid   | Capture detail-page network traffic during date interactions, identify deterministic rate endpoint, then implement parser with diagnostics.                                                                                                               |
|   27 | luxe30a                 |    12 |     0 |  12 | needs_rates | no               | no                      | no               | guesty          | Probe Guesty property/quote endpoints for nightly pricing payloads; align date windows with normalized_availability horizon.                                                                                                                              |

## Immediate Execution Wave (Top 10 Pending by Listing Count)

1. keyco30a (381 files, gap 370) - next active target: stabilize nightly extraction path from current sparse rates and close the remaining rates gap.
2. homeownerscollection30a (208 files, gap 1) - close final nightly-rate outlier and finalize handoff signature proof.
3. royaldestinations (143 files, gap 143) - implement deterministic quote request shaping against `/rescms/ajax/item/pricing/simple` and normalize nightly components.
4. realjoy30a (140 files, gap 140) - capture booking/date-change XHR payloads for quote + fee/tax extraction.
5. benchmark30a (128 files, gap 128) - implement deterministic quote request shaping against `/rescms/ajax/item/pricing/simple` and normalize nightly components.
6. 30avacay (115 files, gap 115) - probe Track/Bluetent router and booking endpoints for daily or season rates.
7. oceanreef30a (111 files, gap 111) - capture date-interaction network traffic, identify deterministic rate endpoint, then implement parser with diagnostics.
8. exclusive30a (106 files, gap 106) - quote + pricing cache lifecycle is complete; next pass is optional daily-rates API discovery to close nightly-rate gap.
9. sandpiper30a (106 files, gap 106) - probe Track/Bluetent router and booking endpoints for daily or season rates.
10. 30aluxury (105 files, gap 105) - capture detail-page network traffic during date interactions, identify deterministic rate endpoint, then implement parser with diagnostics.

## Conformity Progress Since Last Pass

- 360blue conformity structure created and seeded from direct-detail quote evidence:
  - `src/lib/data/external-sources/360blue/pricing-profile.json`
  - `src/lib/data/external-sources/360blue/pricing-assumptions.json` (3 checkout samples via recorder)
- 360blue pricing cache regenerated for all listing details:
  - `src/lib/data/external-sources/360blue/details/pricing/*.json` (592 files)
  - `src/lib/data/external-sources/360blue/details/pricing/index.json`
- 360blue real-time quote fast path verified:
  - Direct API succeeds with non-empty `user-agent` header and averages ~534ms in local probes.
  - Browser bootstrap fallback remains available for blocked statuses.
- keyco30a conformity structure created and seeded:
  - `src/lib/data/external-sources/keyco30a/pricing-profile.json`
  - `src/lib/data/external-sources/keyco30a/pricing-assumptions.json` (1 checkout sample via recorder)
- homeownerscollection30a dynamic runtime + cache refresh completed across known set:
  - Dynamic refresh run: selected 208, pulled 206, skipped fresh 2, failed 0
  - 24-week pricing cache generated for all 208 listings under `details/pricing/*.json`
  - Ad-hoc quote fast path verified with buy-page charge parsing and latency telemetry
- 30aescapes now has both required adapter pricing artifacts:
  - `src/lib/data/external-sources/30aescapes/pricing-profile.json`
  - `src/lib/data/external-sources/30aescapes/pricing-assumptions.json`
- Quote contract persisted from probe evidence:
  - `POST /rentals/ajax/get-pdp-rates.cfm` with `details-datepicker` form payload
  - Checkout handoff URL signature via `/rentals/book-now.cfm?propertyid=...&strcheckin=...&strcheckout=...`
- 30aescapes dynamic refresh completed across known set:
  - Run summary: selected 169, pulled 168, skipped fresh 1, failed 0
  - Coverage after refresh audit: normalized rates 169/169, rates raw observations 169/169
  - Listing pricing cache generated for all 169 listings under `details/pricing/*.json` plus `details/pricing/index.json`
  - Current readiness hardening gap: assumptions sample depth remains 1

## Campaign Summary

- Adapters total: 27
- Pending rates coverage: 21
- Already complete for rates: 6
- Total missing listing-level rates rows: 2368

## Operational Notes

- Rebuild this report after each adapter rates rollout and matrix refresh.
- Keep rates extraction diagnostics in provider-specific raw blocks while normalizing into normalized_rates.days.
- Prioritize deterministic provider endpoints before DOM rate scraping fallbacks.
- For adapters with unclear pricing sources, run manual detail-page booking flow (valid date selection + booking CTA) and inspect submit-time XHR/fetch traffic to discover quote/rate endpoints before committing to DOM-only extraction.

## Key Learnings (This Pass)

- A non-empty `user-agent` header materially improves direct API quote success and should be standard for direct quote tests.
- Keep pricing profile metadata adapter-level; keep daily pricing caches listing-level under each adapter details tree.
- For runtime speed, prefer direct quote API fast path and fall back to browser bootstrap only when blocked.
