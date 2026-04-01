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
