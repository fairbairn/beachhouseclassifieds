# Image Ops Sampling, Collectors, Slices, and Timing

Status: active
Last updated: 2026-11-06

## Recent Metric Modifications (2026-11-06)

1. Status throughput semantics are event-sum based.
2. Throughput for a window is computed from count sums over the window duration, not from latest snapshots.
3. Queue gauge and counter families are split by behavior:
4. `queuePendingLive` and `queueActiveLive` are treated as gauge-like state.
5. `queueCompletedLive` and `queueFailedLive` are treated as counter-like event streams.
6. BullMQ historical seeding is bounded to the most recent 24 hours to reduce startup cost and stale history effects.
7. BullMQ seed/live writes use stable sample IDs for idempotent ingestion and collision resistance.
8. Latency status metrics (`avgFetchMs`, `avgTransformMs`, `avgUploadMs`, `avgEndToEndMs`) are derived from completed job payload item timings.
9. Mixed-source latency writes were intentionally avoided so one source owns these `_ms` metrics at a time.
10. Completion waiting moved to a progress-aware idle watchdog to avoid false runner aborts during long active cycles.

## Semantics Checklist (Operator Facing)

1. Counter/event windows: use `sum` as the canonical window value.
2. Throughput windows: derive IPS/IPM from summed processed events and window length.
3. Gauge/state windows: use `avg` and `latest` for occupancy interpretation.
4. Do not infer throughput from queue depth gauges.
5. Treat `_ms` latency fields as completed-work payload metrics, not queue state metrics.

## Ingestion Model

Ingestion entry point:

1. ingestOpsMetricSamples

Behavior:

1. Accepts metric samples with key, value, and timestamp.
2. Validates metric key is registry-defined.
3. Stages samples for flush.
4. Flushes to Redis trend zsets.

## Collector Model

Collector runner entry point:

1. runOpsCollectorsAndIngestSamples

Collector domains:

1. db
2. fly
3. redis
4. bullmq

Coverage mapping:

1. Snapshot registry metrics are mapped to collectors by name pattern and domain.
2. Collector sample generation is registry-driven, not manually enumerated per metric.

## Refresh Model

Watcher entry point:

1. createOpsUiStateWatcher

Refresh flow:

1. Pipeline reads trend rows by registry descriptors.
2. In-memory metric series update per metric.
3. Snapshot is rebuilt from trend memory.
4. Post-process computes rollups and slices.

## Slice Generation

Slices are generated from rollups and written to hash fields per window.

Windows:

1. 15s
2. 1m
3. 15m
4. 24h
5. deep

Storage:

1. Per metric slice hash.
2. Window fields w_15s, w_1m, w_15m, w_24h, w_deep.

## Timing Model

Important timing loops:

1. Sample flush interval for staged metric writes.
2. Watcher refresh minimum interval.
3. Post-process throttles for rollup/slice refresh.
4. UI refresh loop interval from CLI/HQTUI state.

Operational expectation:

1. UI consumers should observe stable periodic updates when sample input is active.
2. Rollup and slice freshness depends on ongoing sample writes plus post-process cadence.

## Data Semantics

1. Trend data is primary time series history.
2. Slices are derived window summaries.
3. Live values should prefer latest state where applicable.
4. Rollups are analytical windows and not a replacement for live state.
