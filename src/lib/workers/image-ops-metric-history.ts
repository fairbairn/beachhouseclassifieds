export type MetricHistoryPoint = {
  atMs: number;
  value: number;
};

export type MetricHistorySeries = {
  points: MetricHistoryPoint[];
  byAtMs: Record<number, number>;
};

export type MetricHistoryTable = Record<string, MetricHistorySeries>;

export type MetricWindowStats = {
  count: number;
  low: number;
  high: number;
  avg: number;
  latest: number;
};

export function appendMetricHistory(input: {
  table: MetricHistoryTable;
  metricId: string;
  atMs: number;
  value: number;
  maxPoints: number;
}): void {
  const normalizedAtMs = Number.isFinite(input.atMs)
    ? Math.max(0, Math.floor(input.atMs))
    : 0;
  const normalizedValue = Number.isFinite(input.value)
    ? Number(input.value)
    : 0;
  const series =
    input.table[input.metricId] ??
    ({ points: [], byAtMs: {} } satisfies MetricHistorySeries);

  const existingIndex = series.byAtMs[normalizedAtMs];
  if (existingIndex !== undefined) {
    series.points[existingIndex] = {
      atMs: normalizedAtMs,
      value: normalizedValue,
    };
    input.table[input.metricId] = series;
    return;
  }

  const points = series.points;
  const lastAtMs = points[points.length - 1]?.atMs;
  if (lastAtMs === undefined || normalizedAtMs > lastAtMs) {
    points.push({ atMs: normalizedAtMs, value: normalizedValue });
    series.byAtMs[normalizedAtMs] = points.length - 1;
  } else {
    let left = 0;
    let right = points.length;
    while (left < right) {
      const mid = Math.floor((left + right) / 2);
      const atMs = points[mid]?.atMs ?? 0;
      if (atMs < normalizedAtMs) {
        left = mid + 1;
      } else {
        right = mid;
      }
    }
    points.splice(left, 0, { atMs: normalizedAtMs, value: normalizedValue });
    for (let index = left; index < points.length; index += 1) {
      const atMs = points[index]?.atMs;
      if (atMs !== undefined) {
        series.byAtMs[atMs] = index;
      }
    }
  }

  if (points.length > input.maxPoints) {
    const removeCount = points.length - input.maxPoints;
    const removed = points.splice(0, removeCount);
    for (const point of removed) {
      delete series.byAtMs[point.atMs];
    }
    for (let index = 0; index < points.length; index += 1) {
      const atMs = points[index]?.atMs;
      if (atMs !== undefined) {
        series.byAtMs[atMs] = index;
      }
    }
  }

  input.table[input.metricId] = series;
}

export function metricWindowValues(input: {
  table: MetricHistoryTable;
  metricId: string;
  nowMs: number;
  windowMs: number;
}): number[] {
  const series = input.table[input.metricId]?.points ?? [];
  if (series.length <= 0) {
    return [];
  }

  const minAtMs = input.nowMs - Math.max(1, input.windowMs);
  return series
    .filter((point) => point.atMs >= minAtMs)
    .map((point) => (Number.isFinite(point.value) ? point.value : 0));
}

export function metricWindowStats(input: {
  table: MetricHistoryTable;
  metricId: string;
  nowMs: number;
  windowMs: number;
}): MetricWindowStats {
  const values = metricWindowValues(input);
  if (values.length === 0) {
    return {
      count: 0,
      low: 0,
      high: 0,
      avg: 0,
      latest: 0,
    };
  }

  let low = values[0] ?? 0;
  let high = values[0] ?? 0;
  let sum = 0;
  for (const value of values) {
    if (value < low) {
      low = value;
    }
    if (value > high) {
      high = value;
    }
    sum += value;
  }

  return {
    count: values.length,
    low,
    high,
    avg: sum / values.length,
    latest: values[values.length - 1] ?? 0,
  };
}

function resampleSeriesToCount(
  values: number[],
  targetCount: number,
): number[] {
  if (values.length === 0) {
    return [];
  }
  const boundedTarget = Math.max(1, targetCount);
  if (values.length === boundedTarget) {
    return values;
  }
  if (values.length === 1) {
    return Array.from({ length: boundedTarget }, () => values[0] ?? 0);
  }

  const output: number[] = [];
  const sourceLastIndex = values.length - 1;
  const targetLastIndex = boundedTarget - 1;

  for (let index = 0; index < boundedTarget; index += 1) {
    const ratio = targetLastIndex === 0 ? 0 : index / targetLastIndex;
    const sourceIndex = ratio * sourceLastIndex;
    const leftIndex = Math.floor(sourceIndex);
    const rightIndex = Math.min(sourceLastIndex, Math.ceil(sourceIndex));
    const left = values[leftIndex] ?? 0;
    const right = values[rightIndex] ?? left;
    if (leftIndex === rightIndex) {
      output.push(left);
      continue;
    }
    const blend = sourceIndex - leftIndex;
    output.push(left + (right - left) * blend);
  }

  return output;
}

export function metricWindowInterpolated(input: {
  table: MetricHistoryTable;
  metricId: string;
  nowMs: number;
  windowMs: number;
  targetPoints: number;
}): number[] {
  const values = metricWindowValues(input);
  if (values.length <= 0) {
    return [];
  }

  const boundedTarget = Math.max(1, input.targetPoints);
  if (values.length === boundedTarget) {
    return values;
  }
  return resampleSeriesToCount(values, boundedTarget);
}
