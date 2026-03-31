# Rates Conformity Rollout Matrix

Last updated: 2026-03-30T14:38:30Z

This matrix maps each adapter to the data needed to satisfy [rates-conformity-contract.md](./rates-conformity-contract.md).

## Legend

- `Target Daily Mode`:
  - `listing_daily`: per-day rates expected from listing scrape/API
  - `quote_window_avg`: average nightly from quote totals
  - `assumptions_only`: no deterministic quote yet, use assumptions fallback
- `Handoff`:
  - `quoted_url`: URL returned from quote payload
  - `template_url`: deterministic URL template
  - `detail_fallback`: link out to listing detail until checkout signature confirmed
- `Rates Ready`:
  - `none`: profile/assumptions/runtime readiness not yet established
  - `seeded`: profile + initial assumptions/probe evidence exist, but not yet ready
  - `ready`: adapter satisfies the full rates conformity contract
- `Pricing`:
  - `[x]`: adapter has valid pricing profile metadata, listing rate cache generated, and real-time quote retrieval validated
  - `[ ]`: one or more of those pricing requirements are still missing

## Adapter Matrix

| Adapter                 | Platform Family | API Quote Signal | API Availability Signal | Target Daily Mode | Handoff         | Rates Ready | Pricing | Must Capture For Rates Ready                                                                                                                           |
| ----------------------- | --------------- | ---------------- | ----------------------- | ----------------- | --------------- | ----------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 360blue                 | custom_hybrid   | yes              | yes                     | quote_window_avg  | template_url    | seeded      | [x]     | pricing profile + assumptions + 24-week listing cache + direct API quote path validated; capture probe-backed handoff URL signature for full readiness |
| keyco30a                | custom_hybrid   | yes              | yes                     | quote_window_avg  | template_url    | seeded      | [x]     | pricing cache + quote validators now passing (381/381); finalize handoff signature proof and increase assumptions sample depth                         |
| homeownerscollection30a | track_bluetent  | yes              | yes                     | quote_window_avg  | template_url    | seeded      | [x]     | pricing profile + 24-week listing cache now at full nightly parity; expand canonical quote sidecar coverage and handoff signature proof                |
| 30aescapes              | track_bluetent  | yes              | yes                     | quote_window_avg  | quoted_url      | seeded      | [x]     | quote/pricing conformity passing (169/169); increase assumptions sample minimum and preserve runtime quote-output mapping stability                    |
| royaldestinations       | track_bluetent  | yes              | yes                     | quote_window_avg  | template_url    | seeded      | [x]     | full quote + pricing runtime pass complete (143/143); finalize assumptions sample depth and handoff signature proof for `ready`                        |
| realjoy30a              | track_bluetent  | yes              | no                      | quote_window_avg  | template_url    | none        | [ ]     | run full-all-listings quote capture + validator + pricing cache; then record assumptions sample set                                                    |
| benchmark30a            | track_bluetent  | yes              | yes                     | quote_window_avg  | template_url    | seeded      | [x]     | full quote + pricing runtime pass complete (128/128); finalize assumptions sample depth and handoff signature proof for `ready`                        |
| 30avacay                | track_bluetent  | no               | no                      | assumptions_only  | detail_fallback | none        | [ ]     | capture booking flow XHR + derive quote/handoff signatures                                                                                             |
| oceanreef30a            | custom_hybrid   | no               | no                      | assumptions_only  | detail_fallback | none        | [ ]     | identify deterministic quote endpoint and parser                                                                                                       |
| exclusive30a            | custom_hybrid   | yes              | no                      | quote_window_avg  | quoted_url      | seeded      | [x]     | full quote + pricing runtime pass complete (106/106); next tighten assumptions sample depth and optionally add deterministic daily-rates endpoint      |
| sandpiper30a            | track_bluetent  | no               | no                      | assumptions_only  | detail_fallback | none        | [ ]     | capture Track/Bluetent quote + handoff signatures                                                                                                      |
| 30aluxury               | custom_hybrid   | no               | no                      | assumptions_only  | detail_fallback | none        | [ ]     | discover quote endpoint and required params                                                                                                            |
| dunevr30a               | streamline      | yes              | yes                     | listing_daily     | template_url    | seeded      | [x]     | full quote + pricing runtime pass complete (85/85); finalize assumptions sample depth and checkout handoff signature proof for `ready`                 |
| stayon30a               | streamline      | no               | yes                     | assumptions_only  | detail_fallback | none        | [ ]     | probe `GetPreReservationPrice` and checkout URL signature                                                                                              |
| sandersbeach30a         | track_bluetent  | no               | no                      | assumptions_only  | detail_fallback | none        | [ ]     | discover quote endpoint + handoff URL template                                                                                                         |
| oversee30a              | custom_hybrid   | no               | yes                     | assumptions_only  | detail_fallback | none        | [ ]     | identify quote-capable endpoint and normalization rules                                                                                                |
| fivestar30a             | custom_hybrid   | no               | no                      | assumptions_only  | detail_fallback | none        | [ ]     | capture quote/checkout flow + assumptions samples                                                                                                      |
| panhandle30a            | track_bluetent  | no               | no                      | assumptions_only  | detail_fallback | none        | [ ]     | discover quote endpoint and URL signature                                                                                                              |
| scenicstays30a          | streamline      | no               | yes                     | listing_daily     | template_url    | none        | [ ]     | add explicit quote fallback policy and assumptions refresh                                                                                             |
| localvr30a              | guesty          | no               | no                      | assumptions_only  | detail_fallback | none        | [ ]     | probe Guesty quote endpoints + handoff signature mapping                                                                                               |
| funvacay30a             | track_bluetent  | yes              | no                      | quote_window_avg  | template_url    | none        | [ ]     | normalize quote-only path and assumptions blending                                                                                                     |
| stayat30a               | track_bluetent  | no               | no                      | assumptions_only  | detail_fallback | none        | [ ]     | discover quote endpoint + checkout URL signature                                                                                                       |
| grayt30a                | track_bluetent  | no               | no                      | assumptions_only  | detail_fallback | none        | [ ]     | discover quote endpoint + checkout URL signature                                                                                                       |
| coastproperties30a      | streamline      | no               | yes                     | listing_daily     | template_url    | none        | [ ]     | add assumptions samples + handoff signature validation                                                                                                 |
| 30abeach                | streamline      | yes              | yes                     | listing_daily     | template_url    | seeded      | [x]     | quote validator passing (17/17) + pricing cache parity complete; expand assumptions sample depth for long-term drift control                           |
| beachblue               | custom_hybrid   | no               | no                      | assumptions_only  | detail_fallback | none        | [ ]     | identify quote endpoint and checkout URL signature                                                                                                     |
| luxe30a                 | guesty          | no               | no                      | assumptions_only  | detail_fallback | none        | [ ]     | probe Guesty quote/handoff support and assumptions seed                                                                                                |

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
