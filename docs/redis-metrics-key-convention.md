# Redis Metrics Key Convention

This project stores image ops metrics under a short, module-owned namespace:

- Prefix: `image:ops:metrics`

## Segment Schema

All keys use explicit semantic segments:

- `image`: domain
- `ops`: subsystem
- `metrics`: data class
- `group`: source/relevance codeword (`jobs`, `queue`, `db`, `images`, `infra`)
- `metric`: snake_case metric slug
- `trend|slice`: storage family

## Operating Model

- Trend all metric signals as time series.
- Slices are derived from trend windows and stored as hash fields.
- Pull data with Redis pipelines for grouped reads/writes.

## Terminology

- Worker job: one BullMQ job execution unit.
- Image item: one processed image result inside a job `items[]` payload.
- Image performance metrics: `fetch_ms`, `transform_ms`, `upload_ms`, `end_to_end_ms`, bytes fields.

Behavioral expectation:

- Default/modern path: one worker job contains one image item.
- Legacy compatibility path: one worker job may contain multiple image items.
- Trend storage remains item-granular regardless of job shape.

## Group Taxonomy

- `infra`: machines, workers, redis/runtime infrastructure context.
- `db`: database-acquired counters/progress values only.
- `images`: image-processing performance metrics.
- `jobs`: BullMQ job lifecycle/status metrics.
- `queue`: queue depth/state metrics driving pickup/processing.

`db` group rule:

- Use `db` only for database-acquired counters/progress values.
- Do not place queue, runner-status, settings, or infra metrics under `db`.

## Trend Keys

Trend series keys are zsets:

- Pattern: `image:ops:metrics:<group>:<metric>:trend`
- Redis type: `zset`

Canonical trend payload (every trend member):

- `atMs` (number)
- `value` (number)
- `id` (string, optional)

Latest semantics for trend series are derived from zset tail:

- Rule: latest is the newest zset member by score/time.
- No duplicate `:latest` cache key is written for runtime/snapshot trend series.

## Raw Job Trend Keys

Raw per-job/per-item trend storage:

- Trend key: `image:ops:metrics:jobs:<metric>:trend`
  - Redis type: `zset`
  - Member payload: canonical trend payload (`atMs`, `value`, optional `id`)
- Cursor: `image:ops:metrics:jobs:cursor:completed_at_ms`
  - Redis type: `string`

## Slice Keys

Per-metric slice keys are hashes:

- Pattern: `image:ops:metrics:<group>:<metric>:slice`
- Redis type: `hash`
- Window fields: one field per configured window id (`w_15s`, `w_1m`, `w_15m`, `w_24h`, `w_deep`)

Canonical slice payload (every window field):

- `timestamp` (ISO string)
- `low` (number)
- `high` (number)
- `average` (number)
- `latest` (number)

## Pipeline Pulls

- Latest for runtime/snapshot trend metrics: `ZREVRANGE <series> 0 0 WITHSCORES`
- Recent trend samples: `ZRANGEBYSCORE` / `ZREVRANGE` on canonical trend zsets
- Raw job trend values: read and parse zset member payloads

## Naming Rules

- Metric slugs are lowercase snake_case.
- Key builders enforce slug format.
- Consumer identity (runner/cli) is not encoded in key scope names.
- Keep one canonical key family per signal; avoid duplicate storage paths.
