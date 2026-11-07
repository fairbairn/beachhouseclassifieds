# BullMQ Observability and Collector Recommendations

Status: active
Last updated: 2026-11-06

## Recent Decisions (2026-11-06)

1. Counter windows and throughput now follow strict event-sum semantics.
2. Historical seed for completed-job-derived metrics is limited to the trailing 24h.
3. Seed and live writes use stable sample identifiers to support idempotent append behavior.
4. Completed/failed queue metrics are interpreted as counter/event series in slices.
5. Pending/active queue metrics remain gauge/state series in slices.
6. Completion wait behavior uses a progress-aware idle timeout, not a fixed wall-clock timeout.

## Latency Interpretation Update

1. `transform_elapsed_ms` in payload items is measured around Sharp execution and reflects wall time under runtime contention.
2. Large source dimensions materially increase transform cost, especially when combined with a high-quality transform profile.
3. Shared Fly CPU contention can inflate wall time substantially compared to single-item local runs.
4. Operationally, treat high `transform_ms` as a combination of workload shape (source size/profile) and scheduling contention, not as a metric pipeline defect.

## Why this exists

We need collector behavior based on observed BullMQ runtime facts, not assumptions.

This document captures what data BullMQ gives us in two modes:

1. Event-based observation (QueueEvents stream).
2. Request-based observation (queue counts, job lookup, recent completed/failed job scans).

It also provides recommendations for the module collector strategy.

## Harness command

Run the observability harness:

```bash
npm run workers:image:ops:bullmq:harness -- --redis-target cloud --observe-ms 30000 --sample-interval-ms 1000 --seed-limit 25
```

Optional forced event traffic:

```bash
npm run workers:image:ops:bullmq:harness -- --redis-target cloud --observe-ms 15000 --enqueue-sim-job true --source-image-url https://example.com/test.jpg
```

## What the harness captures

### Startup request-based seed inspection

At startup, the harness reads:

1. Recent completed jobs.
2. Recent failed jobs.
3. Job-level fields from request path:
   1. `timestamp`
   2. `processedOn`
   3. `finishedOn`
   4. `returnvalue` payload shape (`processed_count`, `failed_count`, item timing fields)

This tells us exactly what can be used for pre-seeding sample timelines.

### Reactive event-based observation

For each queue event (`waiting`, `active`, `progress`, `completed`, `failed`, `delayed`), the harness records:

1. Event name.
2. Event job id when present.
3. Immediate post-event `Job.fromId` read result.
4. Queue depth snapshot from `getJobCounts` at the same observation point.

This validates the event -> read job -> emit samples flow.

## Observed behavior (cloud run)

From harness output:

1. Completed events include stable job ids.
2. Post-event job reads consistently expose `finishedOn` and parsed return payload counts for completed jobs.
3. Queue depth snapshots react as jobs drain (`active` and `backlog` decline over time).
4. Progress events can occur before final job payload fields are fully available, so direct event payload alone is not enough for reliable counter samples.

## Critical interpretation for current metrics

### Counters

Counters now look correct because the right path is:

1. Pre-seed from historical jobs (timestamped samples).
2. On each completed/failed event, read job record and append counter samples at job completion timestamp.

### upload_ms at 0 is often expected in dry-run

When `--dry-run-cloud true` is used in the runner, uploads are intentionally skipped.

Code references:

1. `run-image-processing-bullmq.ts` documents `--dry-run-cloud` as skipping upload and DB final image writes.
2. `image-processing-task.ts` uses `dryRun` and only performs upload when not in dry-run mode.

So `upload_ms = 0` under dry-run can be valid and should not be treated as a collector defect by itself.

### transform_ms can be high while upload_ms is 0

This can happen when transform dominates work and upload is skipped (dry-run). If this needs stricter validation, compare against raw job item samples from `returnvalue.items[].transform_elapsed_ms` in harness seed output.

## Recommended collector strategy

### 1) Ownership split

Use BullMQ for:

1. Queue depth samples (`waiting`, `active`, `delayed`, `paused`, backlog).
2. Counter samples (`processed`, `completed`, `failed`) from job-completion timestamps.
3. Job-derived latency samples (`fetch`, `transform`, `upload`, `elapsed`) from completed job return payloads.

Use periodic collection only for:

1. Slow-changing non-event domains (DB completeness, fly infra, redis IO aggregates).

### 2) Pre-seed policy

At watcher boot:

1. Read recent completed and failed job sets.
2. Read completed job payloads in batch.
3. Reconstruct ordered sample timeline by `finishedAtMs`.
4. Write counter timeline points once.

### 3) Event reaction policy

On each completed/failed event:

1. Read the job by id.
2. Resolve sample timestamp from `finishedOn` (fallback to payload `completed_at`, then now).
3. Update counter ledger.
4. Append counter samples.
5. Read queue counts and append queue depth sample in same cycle.

### 4) Latency sample policy

For latency fields (`fetch_ms`, `transform_ms`, `upload_ms`, `elapsed_ms`):

1. Treat as completed-job payload derived.
2. Keep dry-run awareness flag in panel or metadata so `upload_ms=0` in dry-run is interpreted correctly.

### 5) Guardrails

1. Do not rely on progress-event payload for final counters.
2. Serialize event handling to avoid duplicate/out-of-order sample writes.
3. Keep dedupe by event key/job id for at-least-once event semantics.

## Practical runbook

1. Start workload runner.
2. Run harness for 30-60 seconds on same Redis target.
3. Confirm event counts and queue depth motion.
4. Confirm completed event -> job read has finished timestamp + counts.
5. Confirm panel values against harness-derived expectations, especially under dry-run vs non-dry-run.

## Files

1. Harness: `src/lib/scripts/run-image-ops-bullmq-observability-harness.ts`
2. NPM scripts: `package.json` (`workers:image:ops:bullmq:harness:raw`, `workers:image:ops:bullmq:harness`)
