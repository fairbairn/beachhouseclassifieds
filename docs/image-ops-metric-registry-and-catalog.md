# Image Ops Metric Registry and Catalog

Status: active
Last updated: 2026-11-05

## Scope

This page defines the metric registries that drive ingestion, refresh, slicing, and UI validation.

## Registry Sources

1. Runner trend registry: OPS_TREND_METRIC_REGISTRY in src/lib/workers/image-ops-control-module.ts
2. Snapshot trend registry: OPS_SNAPSHOT_TREND_METRIC_REGISTRY in src/lib/workers/image-ops-control-module.ts
3. Slice registry: IMAGE_SLICE_METRIC_REGISTRY in src/lib/workers/image-metrics-registry.ts
4. Raw job trend keys: imageJobMetricTrendKeys in src/lib/workers/image-job-metric-trends.ts

## Single Source of Truth Policy

1. Metric keys must be registry-defined.
2. Sample ingestion rejects keys not in registry.
3. Slice slug lists are derived from the slice registry.
4. Coverage tests derive expectations from registries, not hardcoded name arrays.

## Runner Trend Metrics

Current runner metric names include:

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

## Snapshot Trend Metrics

Current snapshot metric names include:

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
18. avgFetchMs
19. avgTransformMs
20. avgUploadMs
21. avgEndToEndMs
22. settingsFlushIntervalMs
23. settingsMaxQueueBacklog
24. settingsRefillLowWatermark
25. settingsRefillTargetBacklog
26. settingsMaxClaimPerCycle
27. dbProcessed
28. dbPending
29. dbTotal
30. dbProgressPct
31. redisWireKbpsAggregate
32. redisIngressKbpsAggregate
33. redisEgressKbpsAggregate
34. redisIngressReadsAggregate
35. redisEgressWritesAggregate
36. rxLatencyAggregate
37. txLatencyAggregate

## Slice Registry Model

IMAGE_SLICE_METRIC_REGISTRY is the canonical list with group assignment:

1. jobs group metrics
2. images group metrics

Derived outputs:

1. IMAGE_JOB_SLICE_METRIC_SLUGS
2. IMAGE_IMAGE_PERFORMANCE_SLICE_METRIC_SLUGS

## Governance Rules

1. Add metric to registry first.
2. Add value producer in status or snapshot source.
3. Validate with simulator coverage tests.
4. Validate with Vitest registry contract tests.
