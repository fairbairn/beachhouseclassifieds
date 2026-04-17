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

## Why This Doc Exists

This is an operator memory aid to avoid rediscovering old failure modes and to accelerate future adapter hardening.
