# Quote Modules and Platform Strategy

This document explains quote modules, their purpose, and how behavior differs by target platform family.

## Why Quote Modules Exist

Detail pages alone are often insufficient for accurate all-in pricing. Quote modules retrieve pre-reservation totals for specific date windows so we can:

- Produce sidecar quote observations.
- Derive trusted nightly and all-in values.
- Validate checkout handoff totals.
- Build stronger pricing caches and readiness confidence.

## Output Artifact

Quote modules write canonical sidecars under adapter quote folders.

Each sidecar contains:

- Adapter/listing identity.
- Capture timestamp.
- Window policy (cadence, sample step, nights, max queries).
- Observations with base/taxes/fees/grand totals.
- Handoff URL when available.

## Platform-Family Behavior

Quote paths vary by stack, so modules use adapter-specific strategies.

1. Track/Bluetent-style

- Often supports quote-like HTML endpoints and handoff signatures.
- May return totals in HTML snippets requiring robust parsing.
- Windowing often uses weekly cadence and explicit unavailable recording.

2. Streamline-style

- Often exposes AJAX endpoints for pre-reservation price methods.
- Request payload shape and occupancy params matter.
- Handoff may be template-driven after signature validation.

3. Custom hybrid platforms

- May require detail-page priming plus endpoint calls.
- Total fields can appear in multiple variants and need reconciliation.
- Retry and pacing are critical due to anti-bot/latency behavior.

## Realjoy Example Pattern

Realjoy quote/handoff parity uses:

- Direct quote endpoint behavior for quote payload extraction.
- Handoff URL validation against expected totals.
- Parsing logic that handles values rendered in data attributes and split cents formatting.

## Failure Handling

Quote modules are designed to record explicit outcomes instead of silently fabricating success.

Common handled outcomes:

- quote_available false with structured reason.
- request/transport failures after bounded retries.
- unavailable windows recorded without shifting dates.

## Relationship to Downstream Stages

Quote modules feed:

- [Quote Validator](./quote-validator.md)
- [Handoff Validator](./handoff-validator.md)
- [Pricing Cache Builder](./pricing-cache-builder.md)
