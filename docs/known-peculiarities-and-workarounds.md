# Known Peculiarities and Workarounds

This document captures notable runtime and parsing issues encountered so far, with the workaround strategy used to keep progress moving.

## Realjoy Latency and Delayed Rendering

Observed:

- Intermittent slow responses/timeouts on handoff and render paths.
- Some totals represented in attributes/render patterns that require adapter-aware parsing.

Workarounds used:

- Conservative retry/backoff with paced concurrency.
- Direct extraction path plus rendered parity sampling.
- Targeted listing/window rechecks for transient failures.

## 30aescapes Quote/Handoff Reliability

Observed:

- Retry-sensitive quote/handoff windows and occasional unstable runs under heavy load.

Workarounds used:

- Observation-level retries and bounded backoff.
- Targeted remediation scripts for failed windows instead of full reruns.
- Strict sequencing: quote refresh, quote validate, handoff validate, then cache/docs.

## LocalVR (Guesty/Next) Availability Extraction

Observed:

- Availability data is present in Next flight payloads as escaped `availabilityInfo` arrays, not always as plain inline JSON.
- Calendar UI data is rendered only after activating check-in controls, and DOM-only traversal is more fragile across UI changes.
- Residual empty-availability cases correlated with `Oops` detail shells during fetch windows.

Workarounds used:

- Treat `availabilityInfo` payload parsing as primary extraction path (`date`, `status`, `minNights`, `cta`, `ctd`).
- Keep fallback chain: legacy inline parsing, then interactive DOM calendar sweep as last resort.
- Re-run targeted direct-detail pulls for non-`Oops` empty-day outliers before treating as parser failures.
- Maintain live progress output for verification and adapter-wide refresh runs to surface stalled or slow listings quickly.

## LocalVR (Guesty/Next) Quote Runtime and Challenge Behavior

Observed:

- Provider flow is effectively mixed-mode: initial page/session bootstrapping via browser, then quote attempts via API endpoint calls.
- Security/challenge posture can vary per request window (intermittent challenge surfaces and request-level anti-bot behavior).
- Some listings return persistent quote `HTTP 400` across sampled windows while still exposing valid detail and availability artifacts.
- Two LocalVR listings are currently known to produce quote sidecars with zero observations despite repeated attempts:
  - `blue-bird-beach-gulf-view-pool-6779f90068c10f0010a4aba2`
  - `shore-me-the-way-close-to-beach-bikes-6779f9e8a238c10011093d23`

Workarounds used:

- CloakBrowser-backed runtime path for quote capture was adopted for LocalVR due repeatable anti-bot friction in default browser paths.
- Keep profile lifecycle explicit (pre/post cleanup) to limit stale-session contamination between runs.
- Run full-pass quote capture with explicit scope (`--all-listings`) and then resume interrupted runs with freshness skip (`--skip-fresh-quotes --fresh-hours 24`).
- Treat persistent `HTTP 400` windows as unavailable outcomes at runtime, but track validator behavior separately because zero-observation sidecars still fail strict quote-sidecar validation.
- Use adapter-suite validation after quote/cache passes to surface these residual sidecar-contract edge cases immediately.

## exclusive30a Checkout Cookie Gate

Observed:

- `booking/review` checkout routes rely on destination-site session state (`bc_session`).
- Deep-linking users directly from an external domain can return 404 when required cookies were not seeded on `exclusive30a.com`.

Workarounds used:

- Keep quote runtime generation and quote validation active for pricing intelligence.
- Treat detail-page redirect as the supported production handoff path for user flows.
- Track this adapter as checkout-cookie-gated until provider-side handoff/session bootstrap support is available.

## General Multi-Adapter Challenges

Observed:

- Platform-specific payload differences.
- Inconsistent unavailable signaling.
- Varying endpoint stability and rate limits.

Workarounds used:

- Central shared runtime for pacing/retry/logging.
- Adapter-specific extraction modules for quirks.
- Precision reruns and narrow-scope fixes to avoid collateral churn.

## Discover Beach Area Null Coding (Open Follow-Up)

Observed:

- A subset of listings have `beach_area_name` as null while city/state fields still suggest recognizable 30A-adjacent beach names (for example Inlet Beach, Santa Rosa Beach, Rosemary Beach).
- Current facet counting intentionally avoids inferring new beach codes from city/state in-query to prevent facet options that may not round-trip cleanly through code-based filters.

Current decision:

- Do not coalesce city/state to beach area facet codes at query time for now.
- Keep current facet behavior deterministic and aligned to persisted canonical codes.

Follow-up proposal:

- Improve ingest fallback logic so `beach_area_name` is coded at ingest time when confidence is sufficient.
- Revisit this after defining explicit confidence/eligibility rules and validating that facet filters remain fully reversible to listing queries.

## Discover Google Maps JS Console Notices

Observed in client console:

- `A Map's preregistered map type may not apply all custom styles when a mapId is present...`
- `As of version 3.62, ... satellite and hybrid map types will no longer automatically switch to 45° Imagery ...`

Current interpretation:

- Discover map currently uses `mapId` plus zoom-driven map-type switching (`roadmap` / `satellite`).
- With `mapId` present, default map-type style behavior is cloud-controlled for default types; this is expected platform behavior, not a runtime failure.
- The 45° imagery notice is a deprecation notice; current Discover UX does not rely on automatic 45° tilt imagery behavior.

Current decision:

- No immediate code change is required solely for these notices.
- Revisit only if visual styling expectations diverge from configured cloud map styles, or if future UX introduces explicit tilt/45° requirements.

## Why This Doc Exists

This is an operator memory aid to avoid rediscovering old failure modes and to accelerate future adapter hardening.
