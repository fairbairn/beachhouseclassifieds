# Central Runner and Modular Adapters

This document explains how we use central runner patterns with adapter-specific modules.

## Architectural Goal

Keep shared orchestration generic and reusable while isolating source-specific parsing and request signatures in adapter modules.

## Shared Responsibilities (Runner Layer)

Central/shared execution commonly provides:

- Concurrency orchestration.
- Retry/backoff execution wrappers.
- Min-gap pacing gates.
- Throughput/performance tracking.
- Structured progress logging.

This reduces duplication and keeps runtime behavior consistent across adapters.

## Adapter Responsibilities

Adapters and adapter-scoped modules own:

- URL and endpoint signatures.
- Request body construction.
- HTML/JSON parsing quirks.
- Availability/quote semantics from provider responses.

## Why This Split Works

Benefits:

- Less repeated error-prone plumbing per adapter.
- Faster extension to new adapters/platform families.
- Easier targeted fixes without side effects across system.
- Better reliability tuning in one place.

## Operational Pattern

1. Runner selects adapter scope.
2. Shared executor handles pacing/retries/concurrency.
3. Adapter module performs provider-specific extraction.
4. Results are normalized into shared contracts.

This pattern is used across scraping, quote capture, and handoff validation flows.
