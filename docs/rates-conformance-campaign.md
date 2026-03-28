# Rates Conformance Campaign

Last generated: 2026-03-28T19:12:40Z

This campaign orders adapters by listing count (high to low) and defines a concrete rate extraction reinvestigation path per adapter.

Canonical conformity references:

- [docs/rates-conformity-contract.md](rates-conformity-contract.md)
- [docs/rates-conformity-rollout-matrix.md](rates-conformity-rollout-matrix.md)

## Goal

Prepare all adapters for rates-required conformance by completing adapter-level pricing contracts (quote + assumptions + handoff), with listing-level daily rates treated as preferred but secondary.

## Priority Queue (High Listing Count to Low)

| Rank | Adapter                 | Files | Rates | Gap | Status      | API Rates Signal | API Availability Signal | API Quote Signal | Platform Family | Reinvestigation Method                                                                                                                                                                                                              |
| ---: | ----------------------- | ----: | ----: | --: | ----------- | ---------------- | ----------------------- | ---------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|    1 | 360blue                 |   592 |     0 | 592 | in_progress | no               | yes                     | yes              | custom_hybrid   | Availability and quote endpoints are integrated; continue hardening per-day rate reconstruction and bridge-ready quote/availability request contract.                                                                               |
|    2 | keyco30a                |   380 |     0 | 380 | in_progress | no               | yes                     | yes              | custom_hybrid   | Confirmed `/api/listing/{listingId}/pricing-context` for date-window availability and quote totals; next implement parser diagnostics and normalized rates mapping.                                                                 |
|    3 | homeownerscollection30a |   208 |     0 | 208 | in_progress | no               | yes                     | yes              | track_bluetent  | `rcItemAvailForm` exposes `/rescms/ajax/item/pricing/simple`; wire deterministic quote requests and map returned nightly components into normalized_rates.                                                                          |
|    4 | 30aescapes              |   169 |     0 | 169 | in_progress | no               | yes                     | yes              | track_bluetent  | Confirmed `POST /rentals/ajax/get-pdp-rates.cfm` with `formtype=details-datepicker`; response contains rent/taxes/`.pdp-quote-total` and `/rentals/book-now.cfm` handoff URL. Next map quote totals into normalized rates fallback. |
|    5 | royaldestinations       |   143 |     0 | 143 | in_progress | no               | yes                     | yes              | track_bluetent  | `rcItemAvailForm` exposes `/rescms/ajax/item/pricing/simple`; wire deterministic quote requests and map returned nightly components into normalized_rates.                                                                          |
|    6 | realjoy30a              |   140 |     0 | 140 | in_progress | no               | no                      | no               | track_bluetent  | Track-hosted `/bookingEngine/*` stack confirmed; capture booking CTA/date-change network to identify quote endpoint and extract fee/tax line items.                                                                                 |
|    7 | benchmark30a            |   128 |     0 | 128 | in_progress | no               | yes                     | yes              | track_bluetent  | `rcItemAvailForm` exposes `/rescms/ajax/item/pricing/simple`; wire deterministic quote requests and map returned nightly components into normalized_rates.                                                                          |
|    8 | 30avacay                |   115 |     0 | 115 | needs_rates | no               | no                      | no               | track_bluetent  | Probe Track/Bluetent router and booking endpoints for daily or season rates; fallback to DOM rates table if API unavailable.                                                                                                        |
|    9 | oceanreef30a            |   111 |     0 | 111 | needs_rates | no               | no                      | no               | custom_hybrid   | Capture detail-page network traffic during date interactions, identify deterministic rate endpoint, then implement parser with diagnostics.                                                                                         |
|   10 | exclusive30a            |   106 |     0 | 106 | needs_rates | no               | no                      | no               | custom_hybrid   | Capture detail-page network traffic during date interactions, identify deterministic rate endpoint, then implement parser with diagnostics.                                                                                         |
|   11 | sandpiper30a            |   106 |     0 | 106 | needs_rates | no               | no                      | no               | track_bluetent  | Probe Track/Bluetent router and booking endpoints for daily or season rates; fallback to DOM rates table if API unavailable.                                                                                                        |
|   12 | 30aluxury               |   105 |     0 | 105 | needs_rates | no               | no                      | no               | custom_hybrid   | Capture detail-page network traffic during date interactions, identify deterministic rate endpoint, then implement parser with diagnostics.                                                                                         |
|   13 | dunevr30a               |    85 |    85 |   0 | complete    | yes              | yes                     | yes              | streamline      | Probe wp-admin streamline methods first (GetPropertyRates or GetPropertyRatesRawData), then map response days to normalized_rates.                                                                                                  |
|   14 | stayon30a               |    78 |     0 |  78 | needs_rates | no               | yes                     | no               | streamline      | Probe wp-admin streamline methods first (GetPropertyRates or GetPropertyRatesRawData), then map response days to normalized_rates.                                                                                                  |
|   15 | sandersbeach30a         |    73 |     0 |  73 | needs_rates | no               | no                      | no               | track_bluetent  | Probe Track/Bluetent router and booking endpoints for daily or season rates; fallback to DOM rates table if API unavailable.                                                                                                        |
|   16 | oversee30a              |    67 |     0 |  67 | needs_rates | no               | yes                     | no               | custom_hybrid   | Capture detail-page network traffic during date interactions, identify deterministic rate endpoint, then implement parser with diagnostics.                                                                                         |
|   17 | fivestar30a             |    62 |    62 |   0 | complete    | no               | no                      | no               | custom_hybrid   | Capture detail-page network traffic during date interactions, identify deterministic rate endpoint, then implement parser with diagnostics.                                                                                         |
|   18 | panhandle30a            |    51 |     0 |  51 | needs_rates | no               | no                      | no               | track_bluetent  | Probe Track/Bluetent router and booking endpoints for daily or season rates; fallback to DOM rates table if API unavailable.                                                                                                        |
|   19 | scenicstays30a          |    44 |    44 |   0 | complete    | yes              | yes                     | no               | streamline      | Probe wp-admin streamline methods first (GetPropertyRates or GetPropertyRatesRawData), then map response days to normalized_rates.                                                                                                  |
|   20 | localvr30a              |    42 |     0 |  42 | needs_rates | no               | no                      | no               | guesty          | Probe Guesty property/quote endpoints for nightly pricing payloads; align date windows with normalized_availability horizon.                                                                                                        |
|   21 | funvacay30a             |    40 |     0 |  40 | needs_rates | no               | no                      | yes              | track_bluetent  | Probe Track/Bluetent router and booking endpoints for daily or season rates; fallback to DOM rates table if API unavailable.                                                                                                        |
|   22 | stayat30a               |    37 |     0 |  37 | needs_rates | no               | no                      | no               | track_bluetent  | Probe Track/Bluetent router and booking endpoints for daily or season rates; fallback to DOM rates table if API unavailable.                                                                                                        |
|   23 | grayt30a                |    35 |     0 |  35 | needs_rates | no               | no                      | no               | track_bluetent  | Probe Track/Bluetent router and booking endpoints for daily or season rates; fallback to DOM rates table if API unavailable.                                                                                                        |
|   24 | coastproperties30a      |    30 |    30 |   0 | complete    | yes              | yes                     | no               | streamline      | Probe wp-admin streamline methods first (GetPropertyRates or GetPropertyRatesRawData), then map response days to normalized_rates.                                                                                                  |
|   25 | 30abeach                |    17 |    17 |   0 | complete    | yes              | yes                     | yes              | streamline      | Probe wp-admin streamline methods first (GetPropertyRates or GetPropertyRatesRawData), then map response days to normalized_rates.                                                                                                  |
|   26 | beachblue               |    16 |     0 |  16 | needs_rates | no               | no                      | no               | custom_hybrid   | Capture detail-page network traffic during date interactions, identify deterministic rate endpoint, then implement parser with diagnostics.                                                                                         |
|   27 | luxe30a                 |    12 |     0 |  12 | needs_rates | no               | no                      | no               | guesty          | Probe Guesty property/quote endpoints for nightly pricing payloads; align date windows with normalized_availability horizon.                                                                                                        |

## Immediate Execution Wave (Top 10 Pending by Listing Count)

1. 360blue (592 files, gap 592) - Availability and quote endpoints are integrated; continue hardening per-day rate reconstruction and bridge-ready quote/availability request contract.
2. keyco30a (380 files, gap 380) - Confirmed `/api/listing/{listingId}/pricing-context` for date-window availability and quote totals; next implement parser diagnostics and normalized rates mapping.
3. homeownerscollection30a (208 files, gap 208) - `rcItemAvailForm` already exposes `/rescms/ajax/item/pricing/simple`; implement deterministic quote request shaping + nightly normalization.
4. 30aescapes (169 files, gap 169) - Quote endpoint is now confirmed (`/rentals/ajax/get-pdp-rates.cfm`); implement deterministic request shaping and normalized rates fallback using rent/tax/total payload blocks.
5. royaldestinations (143 files, gap 143) - `rcItemAvailForm` already exposes `/rescms/ajax/item/pricing/simple`; implement deterministic quote request shaping + nightly normalization.
6. realjoy30a (140 files, gap 140) - Track `/bookingEngine/*` stack is confirmed; next capture booking/date-change XHR payloads for quote + fee/tax extraction.
7. benchmark30a (128 files, gap 128) - `rcItemAvailForm` already exposes `/rescms/ajax/item/pricing/simple`; implement deterministic quote request shaping + nightly normalization.
8. 30avacay (115 files, gap 115) - Probe Track/Bluetent router and booking endpoints for daily or season rates; fallback to DOM rates table if API unavailable.
9. oceanreef30a (111 files, gap 111) - Capture detail-page network traffic during date interactions, identify deterministic rate endpoint, then implement parser with diagnostics.
10. exclusive30a (106 files, gap 106) - Capture detail-page network traffic during date interactions, identify deterministic rate endpoint, then implement parser with diagnostics.

## Campaign Summary

- Adapters total: 27
- Pending rates coverage: 22
- Already complete for rates: 5
- Total missing listing-level rates rows: 2754

## Operational Notes

- Rebuild this report after each adapter rates rollout and matrix refresh.
- Keep rates extraction diagnostics in provider-specific raw blocks while normalizing into normalized_rates.days.
- Prioritize deterministic provider endpoints before DOM rate scraping fallbacks.
- For adapters with unclear pricing sources, run manual detail-page booking flow (valid date selection + booking CTA) and inspect submit-time XHR/fetch traffic to discover quote/rate endpoints before committing to DOM-only extraction.
