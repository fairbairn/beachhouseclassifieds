# Rates Conformance Campaign

Last generated: 2026-04-02T14:35:00Z

This campaign orders adapters by listing count (high to low) and defines a concrete rate extraction reinvestigation path per adapter.

## Goal

Prepare all adapters for upcoming rates-required conformance by closing normalized_rates coverage gaps, starting with the highest listing-volume adapters.

## Priority Queue (High Listing Count to Low)

| Rank | Adapter                 | Files | Rates | Gap | Status      | API Rates Signal | API Availability Signal | API Quote Signal | Platform Family | Reinvestigation Method                                                                                                                            |
| ---: | ----------------------- | ----: | ----: | --: | ----------- | ---------------- | ----------------------- | ---------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
|    1 | 360blue                 |   592 |   592 |   0 | complete    | no               | yes                     | yes              | custom_hybrid   | Capture detail-page network traffic during date interactions, identify deterministic rate endpoint, then implement parser with diagnostics.       |
|    2 | keyco30a                |   381 |   381 |   0 | complete    | no               | no                      | no               | custom_hybrid   | Capture detail-page network traffic during date interactions, identify deterministic rate endpoint, then implement parser with diagnostics.       |
|    3 | homeownerscollection30a |   208 |   208 |   0 | complete    | no               | no                      | no               | custom_hybrid   | Capture detail-page network traffic during date interactions, identify deterministic rate endpoint, then implement parser with diagnostics.       |
|    4 | 30aescapes              |   169 |   169 |   0 | complete    | no               | no                      | no               | custom_hybrid   | Capture detail-page network traffic during date interactions, identify deterministic rate endpoint, then implement parser with diagnostics.       |
|    5 | royaldestinations       |   143 |     0 | 143 | needs_rates | no               | no                      | no               | track_bluetent  | Probe Track/Bluetent router and booking endpoints for daily or season rates; fallback to DOM rates table if API unavailable.                      |
|    6 | realjoy30a              |   140 |     0 | 140 | needs_rates | no               | no                      | no               | custom_hybrid   | Capture detail-page network traffic during date interactions, identify deterministic rate endpoint, then implement parser with diagnostics.       |
|    7 | benchmark30a            |   128 |     0 | 128 | needs_rates | no               | no                      | no               | custom_hybrid   | Capture detail-page network traffic during date interactions, identify deterministic rate endpoint, then implement parser with diagnostics.       |
|    8 | 30avacay                |   115 |     0 | 115 | needs_rates | no               | no                      | no               | track_bluetent  | Probe Track/Bluetent router and booking endpoints for daily or season rates; fallback to DOM rates table if API unavailable.                      |
|    9 | oceanreef30a            |   112 |     0 | 112 | needs_rates | no               | no                      | yes              | custom_hybrid   | Capture detail-page network traffic during date interactions, identify deterministic rate endpoint, then implement parser with diagnostics.       |
|   10 | exclusive30a            |   106 |     0 | 106 | needs_rates | no               | no                      | no               | custom_hybrid   | Capture detail-page network traffic during date interactions, identify deterministic rate endpoint, then implement parser with diagnostics.       |
|   11 | sandpiper30a            |   106 |     0 | 106 | needs_rates | no               | no                      | yes              | track_bluetent  | Quote runtime + handoff alignment are complete; next isolate deterministic Track/Bluetent listing-level rates path to close normalized_rates gap. |
|   12 | 30aluxury               |   105 |     0 | 105 | needs_rates | no               | no                      | no               | custom_hybrid   | Capture detail-page network traffic during date interactions, identify deterministic rate endpoint, then implement parser with diagnostics.       |
|   13 | dunevr30a               |    85 |    85 |   0 | complete    | yes              | yes                     | yes              | streamline      | Probe wp-admin streamline methods first (GetPropertyRates or GetPropertyRatesRawData), then map response days to normalized_rates.                |
|   14 | stayon30a               |    78 |     0 |  78 | needs_rates | no               | yes                     | no               | streamline      | Probe wp-admin streamline methods first (GetPropertyRates or GetPropertyRatesRawData), then map response days to normalized_rates.                |
|   15 | sandersbeach30a         |    74 |     0 |  74 | needs_rates | no               | no                      | yes              | streamline      | Quote runtime + handoff alignment are complete; next probe Streamline listing-rates methods to close normalized_rates gap.                        |
|   16 | oversee30a              |    67 |     0 |  67 | needs_rates | no               | yes                     | no               | custom_hybrid   | Capture detail-page network traffic during date interactions, identify deterministic rate endpoint, then implement parser with diagnostics.       |
|   17 | fivestar30a             |    62 |    62 |   0 | complete    | no               | no                      | no               | custom_hybrid   | Capture detail-page network traffic during date interactions, identify deterministic rate endpoint, then implement parser with diagnostics.       |
|   18 | panhandle30a            |    51 |     0 |  51 | needs_rates | no               | no                      | yes              | track_bluetent  | Probe Track/Bluetent router and booking endpoints for daily or season rates; fallback to DOM rates table if API unavailable.                      |
|   19 | scenicstays30a          |    44 |    44 |   0 | complete    | yes              | yes                     | no               | streamline      | Probe wp-admin streamline methods first (GetPropertyRates or GetPropertyRatesRawData), then map response days to normalized_rates.                |
|   20 | localvr30a              |    42 |     0 |  42 | needs_rates | no               | no                      | no               | guesty          | Probe Guesty property/quote endpoints for nightly pricing payloads; align date windows with normalized_availability horizon.                      |
|   21 | funvacay30a             |    40 |     0 |  40 | needs_rates | no               | no                      | yes              | track_bluetent  | Probe Track/Bluetent router and booking endpoints for daily or season rates; fallback to DOM rates table if API unavailable.                      |
|   22 | stayat30a               |    37 |     0 |  37 | needs_rates | no               | no                      | no               | track_bluetent  | Probe Track/Bluetent router and booking endpoints for daily or season rates; fallback to DOM rates table if API unavailable.                      |
|   23 | grayt30a                |    35 |     0 |  35 | needs_rates | no               | no                      | no               | track_bluetent  | Probe Track/Bluetent router and booking endpoints for daily or season rates; fallback to DOM rates table if API unavailable.                      |
|   24 | coastproperties30a      |    30 |    30 |   0 | complete    | yes              | yes                     | no               | streamline      | Probe wp-admin streamline methods first (GetPropertyRates or GetPropertyRatesRawData), then map response days to normalized_rates.                |
|   25 | 30abeach                |    17 |    17 |   0 | complete    | yes              | yes                     | yes              | streamline      | Probe wp-admin streamline methods first (GetPropertyRates or GetPropertyRatesRawData), then map response days to normalized_rates.                |
|   26 | beachblue               |    16 |     0 |  16 | needs_rates | no               | no                      | no               | custom_hybrid   | Capture detail-page network traffic during date interactions, identify deterministic rate endpoint, then implement parser with diagnostics.       |
|   27 | luxe30a                 |    12 |     0 |  12 | needs_rates | no               | no                      | no               | guesty          | Probe Guesty property/quote endpoints for nightly pricing payloads; align date windows with normalized_availability horizon.                      |

## Immediate Execution Wave (Top 10 Pending by Listing Count)

1. royaldestinations (143 files, gap 143) - Probe Track/Bluetent router and booking endpoints for daily or season rates; fallback to DOM rates table if API unavailable.
2. realjoy30a (140 files, gap 140) - Capture detail-page network traffic during date interactions, identify deterministic rate endpoint, then implement parser with diagnostics.
3. benchmark30a (128 files, gap 128) - Capture detail-page network traffic during date interactions, identify deterministic rate endpoint, then implement parser with diagnostics.
4. 30avacay (115 files, gap 115) - Probe Track/Bluetent router and booking endpoints for daily or season rates; fallback to DOM rates table if API unavailable.
5. oceanreef30a (112 files, gap 112) - Capture detail-page network traffic during date interactions, identify deterministic rate endpoint, then implement parser with diagnostics.
6. exclusive30a (106 files, gap 106) - Capture detail-page network traffic during date interactions, identify deterministic rate endpoint, then implement parser with diagnostics.
7. sandpiper30a (106 files, gap 106) - Probe Track/Bluetent router and booking endpoints for daily or season rates; fallback to DOM rates table if API unavailable.
8. 30aluxury (105 files, gap 105) - Capture detail-page network traffic during date interactions, identify deterministic rate endpoint, then implement parser with diagnostics.
9. stayon30a (78 files, gap 78) - Probe wp-admin streamline methods first (GetPropertyRates or GetPropertyRatesRawData), then map response days to normalized_rates.
10. sandersbeach30a (74 files, gap 74) - Quote and handoff validations are complete; next probe Streamline methods for listing-level rates.

## Campaign Summary

- Adapters total: 27
- Pending rates coverage: 18
- Already complete for rates: 9
- Total missing listing-level rates rows: 1407

## Operational Notes

- Rebuild this report after each adapter rates rollout and matrix refresh.
- Keep rates extraction diagnostics in provider-specific raw blocks while normalizing into normalized_rates.days.
- Prioritize deterministic provider endpoints before DOM rate scraping fallbacks.
