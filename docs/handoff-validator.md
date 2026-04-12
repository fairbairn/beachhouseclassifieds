# Handoff Validator

This document explains the handoff validator purpose, how it works, and why it is critical for quote trust.

## Purpose

The handoff validator confirms that totals implied by quote sidecars are aligned with totals at booking handoff paths.

In short, it answers: does what we recorded as quote data match what checkout/handoff presents?

## Validation Modes

1. Direct endpoint parity

- Uses adapter-specific direct extraction when available.
- Compares extracted handoff total against observed grand total.

2. Rendered parity sample

- Uses browser rendering for customer-visible total extraction.
- Provides confidence for delayed or script-rendered handoff pages.

3. Detail-prefill parity

- Used for adapters where handoff URL intentionally lands on a detail page with prefilled dates, not a checkout page with visible totals.
- Validates deterministic handoff URL alignment (for example `start-date`, `end-date`, required identity params) and page reachability.
- Treats this as canonical parity when provider checkout flow requires additional in-page interaction before totals become visible.

## Runtime Behavior

The validator uses bounded, configurable controls:

- Concurrency limits.
- Min-gap pacing.
- Retry/backoff delay sets.
- Timeout controls.
- Progress channels with listing/window context.

This allows high throughput while reducing provider overload and transient failure noise.

## Common Failure Codes

Typical outcomes include:

- total_not_found
- request_error
- http_error
- grand_total_mismatch
- component_mismatch
- direct_status_error
- handoff_prefill_mismatch

These are designed for targeted remediation, not blind full reruns.

## Realjoy Notes

Realjoy has shown transient latency/timeouts in some windows. Current approach combines:

- Direct quote/handoff extraction path.
- Render-aware parser behavior.
- Conservative retries/pacing for slower periods.

## Readiness Role

Handoff validation is a required confidence gate for quote-capable adapters before moving to Ready in rollout tracking.
