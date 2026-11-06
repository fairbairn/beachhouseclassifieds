# Image Ops Module Interface Reference

Status: active
Last updated: 2026-11-05

## Scope

This page documents the module API surface that callers use instead of reading Redis directly.

Primary implementation:

1. src/lib/workers/image-ops-control-module.ts

## Interface Groups

### Registry and Contracts

1. OPS_TREND_METRIC_REGISTRY
2. OPS_SNAPSHOT_TREND_METRIC_REGISTRY
3. OPS_UI_METRIC_LABELS

### Metric Ingestion

1. ingestOpsMetricSamples
2. ingestOpsExternalSamples
3. writeOpsRunnerStatus
4. writeOpsSnapshotTrendMetrics

### Refresh and Watcher State

1. createOpsUiStateWatcher
2. requestOpsStateRefresh
3. createOpsStateUpdatesSubscriber

### Read APIs

1. readOpsUiSnapshot
2. readOpsSharedState
3. readOpsQueueSnapshot
4. readOpsControlSnapshot
5. readOpsTrendHistory
6. readOpsTrendProjection
7. readOpsSnapshotTrendRows
8. readOpsSnapshotTrendRowsSince
9. readOpsSnapshotTrendLatest
10. readOpsRunnerTrendLatest

### Runtime and Queue Control

1. readOpsControlSettings
2. writeOpsControlSettings
3. updateOpsControlSettings
4. setOpsQueuePaused
5. pauseOpsSystemFlow
6. resumeOpsSystemFlow
7. clearOpsQueueIfPaused
8. setOpsDesiredModeWithQueueAction

### One Shot Pipeline APIs

1. runOpsOneShotPerformanceRefresh
2. runOpsOneShotPipeline

### Infra and IO APIs

1. readOpsRedisPreflight
2. readOpsRedisIoStats
3. resetOpsRedisIoStats
4. readOpsRedisIoInstanceStats
5. readOpsRedisIoAggregateStats
6. readOpsRedisServerIoStats

## Caller Contract

1. Callers should read through module APIs, not ad hoc Redis key reads.
2. Callers should treat module snapshot fields as canonical for UI.
3. Callers should not bypass metric registries when sending samples.
4. Invalid metric keys should fail fast at ingestion.

## State Watcher Contract

createOpsUiStateWatcher returns an object with:

1. getSnapshot
2. refreshNow
3. waitForState
4. getStateVersion
5. hasStateChangedSince
6. onStateChange
7. close

This is the preferred long-lived integration point for CLI and HQTUI.
