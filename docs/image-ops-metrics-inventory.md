# Image Ops Metrics Inventory

This document is the current source-of-truth inventory of metrics, settings, and observable variables used by the Image Ops runtime and shown in HQTUI Screen 5.

## Live-Slice Policy (Current)

This section is the current operational policy and takes precedence for Screen 5 and pruning work.

1. Screen 5 should prioritize live metric values.
2. Rollups are slices/aggregates of metrics and are not primary for live observability.
3. Grouping should be domain-first and operator-friendly.

### Required Logical Groups

1. db
2. redis
3. fly
4. jobs
5. images
6. queue
7. settings
8. variables

### Group Intent

1. db: database progress and completeness.
2. redis: Redis wire I/O and latency telemetry (local, aggregate, per-instance).
3. fly: machine/worker runtime topology and infra freshness.
4. jobs: runner pipeline/job lifecycle counters and job-state control signals.
5. images: image-level throughput and per-image latency counters.
6. queue: queue depth and queue state counters.
7. settings: operator-controlled runtime knobs.
8. variables: meta-state, ownership, errors, and diagnostics.

### Live-Only Rule For Screen 5

1. Prefer current/live values for each metric family.
2. Do not rely on rollup windows as the primary metric view.
3. If a metric exists as both live and rollup, live is canonical for Screen 5.

### Rollup Handling

1. Rollups are still tracked by runtime, but they are secondary for Screen 5.
2. Rollups should be treated as optional analytical context, not core live observability.
3. Pruning and grouping decisions should be made against live metrics first.

## Canonical Sources

1. src/lib/workers/image-runner-control.ts
2. src/lib/workers/image-ops-control-module.ts
3. src/lib/scripts/run-image-ops-hqtui.ts

## Runtime Settings Tracked

From RunnerControlSettings:

1. desiredMode
2. enqueueEnabled
3. requireWorkersForEnqueue
4. minWorkersToEnqueue
5. maxQueueBacklog
6. refillLowWatermark
7. refillTargetBacklog
8. maxClaimPerCycle
9. flushIntervalMs
10. harvestEnabled

## Infra Snapshot Tracked

From RunnerInfraSnapshot:

1. workersRunning
2. source
3. updatedAt

## Runner Status Metrics Tracked

From RunnerStatusSnapshot:

1. operationId
2. mode
3. desiredMode
4. gateReason
5. workersRunning
6. claimedCount
7. queuedCount
8. completedJobs
9. failedJobs
10. processedItems
11. failedItems
12. queueWaiting
13. queueActive
14. queueCompleted
15. queueFailed
16. queueDelayed
17. queuePaused
18. queueBacklog
19. lastFlushAt
20. flushBatchCount
21. pendingSuccessBuffer
22. pendingErrorBuffer
23. throughputImagesPerMinute
24. avgFetchMs
25. avgTransformMs
26. avgUploadMs
27. avgEndToEndMs
28. updatedAt

## Trend Metric Registry (Runner)

From OPS_TREND_METRIC_REGISTRY:

1. workersRunning
2. claimedCount
3. queuedCount
4. completedJobs
5. failedJobs
6. processedItems
7. failedItems
8. queueWaiting
9. queueActive
10. queueCompleted
11. queueFailed
12. queueDelayed
13. queuePaused
14. queueBacklog
15. flushBatchCount
16. pendingSuccessBuffer
17. pendingErrorBuffer
18. throughputImagesPerMinute
19. avgFetchMs
20. avgTransformMs
21. avgUploadMs
22. avgEndToEndMs

## Trend Metric Registry (Snapshot)

From OPS_SNAPSHOT_TREND_METRIC_REGISTRY:

1. errorsCount
2. machinesTotal
3. workersRunningLive
4. queueWaitingLive
5. queueActiveLive
6. queueDelayedLive
7. queuePausedLive
8. queueCompletedLive
9. queueFailedLive
10. queueBacklogLive
11. statusProcessedItems
12. statusFailedItems
13. statusCompletedJobs
14. statusFailedJobs
15. statusPendingSuccessBuffer
16. statusPendingErrorBuffer
17. statusFlushBatchCount
18. settingsFlushIntervalMs
19. settingsMaxQueueBacklog
20. settingsRefillLowWatermark
21. settingsRefillTargetBacklog
22. settingsMaxClaimPerCycle
23. dbProcessed
24. dbPending
25. dbTotal
26. dbProgressPct
27. redisWireKbpsAggregate
28. redisIngressKbpsAggregate
29. redisEgressKbpsAggregate
30. redisIngressReadsAggregate
31. redisEgressWritesAggregate
32. rxLatencyAggregate
33. txLatencyAggregate

## Redis Local IO Metrics Tracked

From OpsRedisIoStats:

1. redisEgressBytes
2. redisIngressBytes
3. redisWireBytes
4. redisIngressReads
5. redisEgressWrites
6. windowSeconds
7. redisEgressKbps
8. redisIngressKbps
9. redisWireKbps
10. redisIngressKbPerRead
11. rxLatencyMs
12. txLatencyMs
13. lastReadAt
14. lastWriteAt

## Redis Aggregate IO Metrics Tracked

From OpsRedisIoAggregateStats:

1. sampledAt
2. activeInstances
3. redisEgressBytes
4. redisIngressBytes
5. redisIngressReads
6. redisEgressWrites
7. redisEgressKbps
8. redisIngressKbps
9. redisWireKbps
10. rxLatencyMs
11. txLatencyMs

## Redis Per-Instance IO Metrics Tracked

From OpsRedisIoInstanceStats:

1. instanceId
2. pid
3. startedAt
4. updatedAt
5. windowSeconds
6. redisEgressBytes
7. redisIngressBytes
8. redisIngressReads
9. redisEgressWrites
10. redisEgressKbps
11. redisIngressKbps
12. redisWireKbps
13. rxLatencyMs
14. txLatencyMs

## Performance Rollup Metrics Tracked (Non-Primary)

Rollups are still tracked internally, but they are not part of the primary live metric view for Screen 5.

1. Treat rollups as optional analytical context.
2. Do not mix rollup fields into the live base metric catalog.

## Screen 5 Rendered Namespaces

Screen 5 now renders all namespaces below explicitly.

1. trackedRows (module/error/flow variables)
2. settingsRows
3. statusRows
4. infraRows
5. queueRows
6. dbRows
7. metricSystemRows
8. redisRows (local + aggregate)
9. redisInstanceRows (all fields per instance index)
10. collectorRows
11. snapshotMetricRows using base metric names
12. runnerMetricRows using base metric names

## Screen 5 Labeling Rules

1. Metric identity is the base metric name.
2. Slice/window/stat are query dimensions, not alternate metric names.
3. Per-instance Redis fields are labeled redis_instance_<index>_<field_name>.
4. Screen 5 is live-value oriented and should avoid rollup-derived labels.

## Notes

1. Screen 5 no longer de-duplicates by plain label between snapshot and runner registries.
2. This inventory reflects the current implementation after the latest Screen 5 expansion.
