# Image Ops CLI and HQTUI Integration

Status: active
Last updated: 2026-11-05

## Scope

This page describes how CLI and HQTUI consume module state and metric registries.

## Integration Principle

1. CLI and HQTUI call module APIs.
2. UI should not own ad hoc metric definitions.
3. Metric references in UI must map to registry names.

## Entry Points

1. CLI script: src/lib/scripts/run-image-ops-cli.ts
2. HQTUI script: src/lib/scripts/run-image-ops-hqtui.ts
3. Module watcher: createOpsUiStateWatcher

## Runtime Read Path

1. UI triggers refresh through watcher refreshNow or waits for watcher state update.
2. UI receives snapshot, trend rows, and projections from module.
3. Screen graphs and panels derive from module-managed series and rollups.

## Validation and Guardrails

1. HQTUI metric contract tests verify runner and snapshot metric references map to registries.
2. Invalid metric references should surface as explicit errors, not silent fallback behavior.
3. Queue and IPS trend rendering should use module-provided state paths to avoid stale local-only history.

## Screen Behavior Notes

1. Summary and processing screens use live and rollup values from module snapshot.
2. Queue trend charts should rely on module metric-state series for consistent updates.
3. Observability screen uses registry-backed metric groups and validation paths.
