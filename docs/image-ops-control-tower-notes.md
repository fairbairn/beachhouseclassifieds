# Image Ops Control Tower Notes

Status: exploratory (interaction-first)
Last updated: 2026-11-06

## Why This Exists

Keep a living record of control-tower and HQTUI decisions while we iterate through real operator interaction.

The goal is to start with practical behavior, gather feedback from live usage, and only harden patterns after they prove useful.

## Baseline We Can Operate Today

1. Runner control/settings/state are Redis-backed through image:runner:control:\* keys.
2. Runner supports gate-aware modes and status publishing.
3. Control CLI supports dashboard, fly scaling, start-run, drain-and-scale-down, control-show, and control-set.
4. HQTUI supports Summary, Queues, and Workers screens plus live throughput and queue fill telemetry.

## Parked Ideas (Annotated, Not Committed)

1. Multi-pane views beyond current 3 screens:

- writeback durability screen
- queue policy tuning screen
- incident-focused error drilldown screen

2. Adaptive refill controller evolution:

- strict ceiling behavior at max_queue_backlog
- low-watermark trigger for refill
- target-backlog top-up with per-cycle caps
- dynamic pacing based on observed worker drain

3. Operator workflow polish:

- safe presets (conservative, balanced, aggressive)
- command shortcuts for common transitions
- richer guardrails for risky control changes

## Unknowns To Validate Through Interaction

1. Which screen operators stay on most during active runs.
2. Whether ips/ipm and fill/drain are sufficient or if we need additional pace signals.
3. How quickly queue policy changes should take effect without causing oscillation.
4. Which thresholds are stable across low/medium/high worker counts.
5. Whether manual control-set loops are adequate or need guided auto-tuning.

## Live Feedback Loop (Default)

1. Keep runner active in one terminal.
2. Use CLI or HQTUI in a separate terminal for controls and observation.
3. Change one setting at a time and observe at least several polling windows.
4. Record outcomes as: context, change, result, follow-up.
5. Promote only repeated wins into defaults.

## Next Small Steps

1. Capture one short run log per worker tier (for example 2, 5, 10 workers) with current queue settings.
2. Identify first oscillation or starvation pattern and annotate root cause.
3. Decide whether next implementation step is UI visibility or refill algorithm behavior.

## Overnight Long-Run Posture (Current)

1. Keep runner in continuous mode with periodic status checks rather than frequent control changes.
2. Monitor completion pace from event-sum throughput and processed-item windows.
3. Prefer interpreting queue pending/active as occupancy and completed/failed as event totals.
4. If run appears stalled, first verify progress events and reconcile counts before treating it as a hard failure.
5. For throughput regressions, separate workload shape effects (large source dimensions) from infrastructure contention effects.
