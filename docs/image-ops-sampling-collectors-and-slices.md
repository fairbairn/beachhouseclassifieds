# Image Ops Sampling, Collectors, Slices, and Timing

Status: active
Last updated: 2026-11-05

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
