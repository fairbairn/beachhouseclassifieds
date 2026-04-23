# Availability Window Indexing (High-Performance Spec)

## Objective

Design the fastest possible way to support this query:

- Given a date window `[A -> B]` and a stay length `N`, return properties that have at least one valid `N`-night stay starting within that window.

This specification focuses only on:

- create
- store
- query

availability data for high-performance filtering in Meilisearch.

## Core Model

Reduce the query to:

- Does a property have any valid start date for `N` nights within `[A -> B-N]`?

This is solved by precomputing all valid start dates for each stay length `N`.

## Data Representation

Per property document:

```json
{
  "id": "prop_123",
  "avail_1": [20260601, 20260602],
  "avail_2": [20260601],
  "...": [],
  "avail_28": []
}
```

Rules:

- `avail_N` is a flat integer array.
- Values are `YYYYMMDD` integers.
- Values represent valid arrival dates for `N`-night stays.
- No nested objects.
- No string dates.

## Precomputation Pipeline

Input per property:

- `availability[731]` where each day is `1` (available) or `0` (unavailable).

### Step 1: Run-Length Array

For each day `i`:

- `run[i] = consecutive available nights starting at i`

Example:

```text
availability: 1 1 1 1 0 1 1
run:          4 3 2 1 0 2 1
```

### Step 2: Valid Start Dates by Stay Length

For each day `i`:

- `max_nights = run[i]`
- for `n` in `1..min(max_nights, 28)`, append `date[i]` to `avail_n`

This produces complete start-date sets for each supported stay length.

### Step 3: Date Encoding

Convert dates:

- `YYYY-MM-DD -> YYYYMMDD`

Example:

- `2026-06-01 -> 20260601`

### Step 4: Field Assignment

Write arrays to:

- `avail_1` through `avail_28`

## Index Requirements (Meilisearch)

- Every `avail_N` field must be filterable.
- No nested availability structures should be indexed for this query path.

## Query Execution

Input:

- window: `[start_date -> end_date]`
- nights: `N`

### Step 1: Compute Valid Start Range

- `start_min = start_date`
- `start_max = end_date - N`

### Step 2: Apply Filter

Use range predicates against one field:

- `avail_N >= start_min AND avail_N <= start_max`

This returns properties that have at least one valid start date in-range for `N` nights.

## Performance Characteristics

- No runtime interval expansion.
- No per-query day-by-day iteration.
- No dynamic stay-feasibility scans at query time.

Query behavior is reduced to indexed numeric range filtering.

## Operational Notes

- Keep max supported stay length explicit (current target: 28 nights).
- Regenerate `avail_N` fields whenever source availability changes.
- Treat this availability index as derived data with deterministic rebuild semantics.
- Prefer batch ingestion/update jobs that can incrementally refresh changed properties.

## Summary

For fast wide-window availability search:

1. Precompute valid start dates for each stay length offline.
2. Store them as flat integer arrays (`avail_N`).
3. Query with direct range filters on the chosen `avail_N` field.

This converts availability matching into an index lookup instead of runtime computation.
