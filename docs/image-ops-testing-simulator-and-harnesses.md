# Image Ops Testing, Simulator, and Harnesses

Status: active
Last updated: 2026-11-05

## Scope

This page documents how tests and simulator enforce registry coverage and runtime contracts.

## Simulator

Main simulator:

1. src/lib/workers/image-ops-data-simulator.ts

Coverage behavior:

1. Per tick, emits samples for every runner metric registry item.
2. Per tick, emits samples for every snapshot metric registry item.
3. Pushes samples through ingestOpsMetricSamples.
4. Can optionally inject BullMQ samples for raw metric and rollup/slice realism.

## Test Categories

### Registry Contract Tests

1. src/lib/workers/image-ops-metric-registry.contract.test.ts
2. Enforces uniqueness and derived slice list contracts.

### Simulator Coverage Test

1. src/lib/workers/image-ops-data-simulator.registry-coverage.test.ts
2. Enforces that synthetic tick emission covers all registry keys.

### HQTUI Metric Contract Tests

1. src/lib/workers/image-ops-hqtui-metric-contract.test.ts
2. Enforces direct UI metric references remain registry-aligned.

### Redis Integration Metric Contracts

1. src/lib/workers/image-ops-metrics.redis.test.ts
2. Derives expected metric names from registries and verifies storage contracts.

### Shared Module and Refresh Engine

1. src/lib/workers/image-ops-shared-module.test.ts
2. src/lib/workers/image-ops-shared-module.redis.test.ts
3. src/lib/workers/image-ops-refresh-engine.test.ts
4. Validate history state, interpolation, slicing, and refresh mechanics.

## Harness Guidance

1. Add new metric in registry first.
2. Update simulator source values if metric depends on new status/snapshot field.
3. Run contract tests before integration tests.
4. Treat contract test failures as design drift, not optional noise.

## Recommended Validation Order

1. lint changed files
2. registry contract tests
3. simulator coverage test
4. HQTUI metric contract test
5. redis integration suites when environment is enabled
