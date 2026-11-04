# Redis Metrics Key Convention

This project stores image ops metrics under a short, module-owned namespace:

- Prefix: `image:ops:metrics`

## Segment Schema

All keys use explicit semantic segments:

- `image`: domain
- `ops`: subsystem
- `metrics`: data class
- `trend|slice`: storage family
- additional segments: scope + metric + artifact

## Operating Model

- Trend all metric signals as time series.
- Snapshot/slice only selected operational views.
- Pull data with Redis pipelines for grouped reads/writes.

## Terminology

- Worker job: one BullMQ job execution unit.
- Image item: one processed image result inside a job `items[]` payload.
- Image performance metrics: `fetch_ms`, `transform_ms`, `upload_ms`, `end_to_end_ms`, bytes fields.

Behavioral expectation:

- Default/modern path: one worker job contains one image item.
- Legacy compatibility path: one worker job may contain multiple image items.
- Trend storage must remain item-granular regardless of job shape.

## Trend Keys

Trend series keys are zsets with one metric sample per member:

- Pattern: `image:ops:metrics:trend:<scope>:<metric>`
- Redis type: `zset`
- Scopes:
  - `runtime`: module runtime counters/latencies
  - `snapshot`: module snapshot/read-model values for consumers

Latest semantics for trend series are derived from zset tail:

- Rule: latest is the newest zset member by score/time
- No duplicate `:latest` cache key is written for runtime/snapshot trend series

## Raw Job Trend Keys

Raw per-job/per-item trend storage:

- Id index: `image:ops:metrics:trend:raw:jobs:<metric>:ids`
  - Redis type: `zset`
- Value map: `image:ops:metrics:trend:raw:jobs:<metric>:values`
  - Redis type: `hash`
- Latest cache: `image:ops:metrics:trend:raw:jobs:<metric>:latest`
  - Redis type: `string`
- Cursor: `image:ops:metrics:trend:raw:jobs:cursor:completed_at_ms`
  - Redis type: `string`

## Window Slice Keys

Window rollups are hash snapshots:

- Pattern: `image:ops:metrics:slice:window:performance:rollups`
- Redis type: `hash`

## Pipeline Pulls

- Latest for runtime/snapshot trend metrics: `ZREVRANGE <series> 0 0 WITHSCORES`
- Recent trend samples: `ZRANGEBYSCORE` / `ZREVRANGE` on canonical trend zsets
- Raw job trend values: pipeline `ZRANGE*` ids + `HMGET` values

## Naming Rules

- Metric slugs are lowercase snake_case.
- Key builders enforce slug format.
- Consumer identity (runner/cli) is not encoded in metric key scopes.
- Keep one canonical key family per signal; avoid duplicate storage paths.
