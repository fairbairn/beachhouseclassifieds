# Rates Conformity Rollout Matrix

Last updated: 2026-03-28T19:40:00Z

This matrix maps each adapter to the data needed to satisfy [docs/rates-conformity-contract.md](docs/rates-conformity-contract.md).

## Legend

- `Target Daily Mode`:
  - `listing_daily`: per-day rates expected from listing scrape/API
  - `quote_window_avg`: average nightly from quote totals
  - `assumptions_only`: no deterministic quote yet, use assumptions fallback
- `Handoff`:
  - `quoted_url`: URL returned from quote payload
  - `template_url`: deterministic URL template
  - `detail_fallback`: link out to listing detail until checkout signature confirmed

## Adapter Matrix

| Adapter                 | Platform Family | API Quote Signal | API Availability Signal | Target Daily Mode | Handoff         | Must Capture For Rates Ready                                                   |
| ----------------------- | --------------- | ---------------- | ----------------------- | ----------------- | --------------- | ------------------------------------------------------------------------------ |
| 360blue                 | custom_hybrid   | yes              | yes                     | quote_window_avg  | template_url    | finalize quote-to-daily reconstruction + store checkout URL signature          |
| keyco30a                | custom_hybrid   | yes              | yes                     | quote_window_avg  | template_url    | stabilize pricing-context parser + persist handoff mapping                     |
| homeownerscollection30a | track_bluetent  | yes              | yes                     | quote_window_avg  | template_url    | map `/rescms/ajax/item/pricing/simple` response to normalized totals           |
| 30aescapes              | track_bluetent  | yes              | yes                     | quote_window_avg  | quoted_url      | persist `/rentals/ajax/get-pdp-rates.cfm` + `/rentals/book-now.cfm` signatures |
| royaldestinations       | track_bluetent  | yes              | yes                     | quote_window_avg  | template_url    | deterministic request shaping + quote parser                                   |
| realjoy30a              | track_bluetent  | no               | no                      | assumptions_only  | detail_fallback | discover quote endpoint + checkout handoff signature                           |
| benchmark30a            | track_bluetent  | yes              | yes                     | quote_window_avg  | template_url    | normalize quote response fields and assumptions seeding                        |
| 30avacay                | track_bluetent  | no               | no                      | assumptions_only  | detail_fallback | capture booking flow XHR + derive quote/handoff signatures                     |
| oceanreef30a            | custom_hybrid   | no               | no                      | assumptions_only  | detail_fallback | identify deterministic quote endpoint and parser                               |
| exclusive30a            | custom_hybrid   | no               | no                      | assumptions_only  | detail_fallback | identify deterministic quote endpoint and parser                               |
| sandpiper30a            | track_bluetent  | no               | no                      | assumptions_only  | detail_fallback | capture Track/Bluetent quote + handoff signatures                              |
| 30aluxury               | custom_hybrid   | no               | no                      | assumptions_only  | detail_fallback | discover quote endpoint and required params                                    |
| dunevr30a               | streamline      | yes              | yes                     | listing_daily     | template_url    | validate current rates path against conformity contract                        |
| stayon30a               | streamline      | no               | yes                     | assumptions_only  | detail_fallback | probe `GetPreReservationPrice` and checkout URL signature                      |
| sandersbeach30a         | track_bluetent  | no               | no                      | assumptions_only  | detail_fallback | discover quote endpoint + handoff URL template                                 |
| oversee30a              | custom_hybrid   | no               | yes                     | assumptions_only  | detail_fallback | identify quote-capable endpoint and normalization rules                        |
| fivestar30a             | custom_hybrid   | no               | no                      | assumptions_only  | detail_fallback | capture quote/checkout flow + assumptions samples                              |
| panhandle30a            | track_bluetent  | no               | no                      | assumptions_only  | detail_fallback | discover quote endpoint and URL signature                                      |
| scenicstays30a          | streamline      | no               | yes                     | listing_daily     | template_url    | add explicit quote fallback policy and assumptions refresh                     |
| localvr30a              | guesty          | no               | no                      | assumptions_only  | detail_fallback | probe Guesty quote endpoints + handoff signature mapping                       |
| funvacay30a             | track_bluetent  | yes              | no                      | quote_window_avg  | template_url    | normalize quote-only path and assumptions blending                             |
| stayat30a               | track_bluetent  | no               | no                      | assumptions_only  | detail_fallback | discover quote endpoint + checkout URL signature                               |
| grayt30a                | track_bluetent  | no               | no                      | assumptions_only  | detail_fallback | discover quote endpoint + checkout URL signature                               |
| coastproperties30a      | streamline      | no               | yes                     | listing_daily     | template_url    | add assumptions samples + handoff signature validation                         |
| 30abeach                | streamline      | yes              | yes                     | listing_daily     | template_url    | verify quote parser outputs + assumptions drift policy                         |
| beachblue               | custom_hybrid   | no               | no                      | assumptions_only  | detail_fallback | identify quote endpoint and checkout URL signature                             |
| luxe30a                 | guesty          | no               | no                      | assumptions_only  | detail_fallback | probe Guesty quote/handoff support and assumptions seed                        |

## Required Artifact Checklist (Per Adapter)

1. `pricing-profile.json` with capabilities, quote signature, handoff signature, and estimation policy.
2. `pricing-assumptions.json` with at least 3 samples.
3. At least one probe report proving signature validity or explicit unsupported status.
4. Confidence policy for UX output (`high`, `medium`, `low`) based on data path used.

## Execution Sequence

1. Complete adapters already showing quote signal (`in_progress` cohort in campaign).
2. For no-quote adapters, perform booking-flow XHR discovery and handoff signature capture.
3. Seed assumptions for every adapter, even where quote exists (fallback resilience).
4. Add `Rates Ready` gate to release checklist once profile + assumptions + probe evidence are present.
