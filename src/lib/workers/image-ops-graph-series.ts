export function hasPositiveSignal(values: number[]): boolean {
  for (const value of values) {
    if (Number.isFinite(value) && value > 0) {
      return true;
    }
  }
  return false;
}

export function sanitizeNonNegativeSeries(values: number[]): number[] {
  return values.map((value) => {
    if (!Number.isFinite(value)) {
      return 0;
    }
    return Math.max(0, Number(value));
  });
}

function upsampleLinear(values: number[], targetPoints: number): number[] {
  const target = Math.max(1, Math.floor(targetPoints));
  if (values.length === 0) {
    return Array.from({ length: target }, () => 0);
  }
  if (values.length === 1) {
    return Array.from({ length: target }, () => values[0] || 0);
  }
  if (values.length === target) {
    return values;
  }

  const lastIndex = values.length - 1;
  return Array.from({ length: target }, (_, index) => {
    const ratio = target === 1 ? 0 : index / (target - 1);
    const source = ratio * lastIndex;
    const sourceLow = Math.floor(source);
    const sourceHigh = Math.min(lastIndex, Math.ceil(source));
    if (sourceHigh === sourceLow) {
      return values[sourceLow] || 0;
    }
    const low = values[sourceLow] || 0;
    const high = values[sourceHigh] || 0;
    const mix = source - sourceLow;
    return low + (high - low) * mix;
  });
}

function downsamplePeakHold(values: number[], targetPoints: number): number[] {
  const target = Math.max(1, Math.floor(targetPoints));
  if (values.length <= target) {
    return values;
  }

  const output: number[] = [];
  const sourceCount = values.length;

  for (let index = 0; index < target; index += 1) {
    const start = Math.floor((index * sourceCount) / target);
    const endExclusive = Math.max(
      start + 1,
      Math.floor(((index + 1) * sourceCount) / target),
    );

    let bucketMax = 0;
    for (
      let bucketIndex = start;
      bucketIndex < endExclusive;
      bucketIndex += 1
    ) {
      const value = values[bucketIndex] || 0;
      if (value > bucketMax) {
        bucketMax = value;
      }
    }
    output.push(bucketMax);
  }

  return output;
}

export function resampleSeriesForChart(input: {
  values: number[];
  targetPoints: number;
  maxPoints?: number;
}): number[] {
  const sanitized = sanitizeNonNegativeSeries(input.values);
  const target = Math.max(1, Math.floor(input.targetPoints));
  const boundedTarget = Math.max(
    1,
    Math.floor(
      input.maxPoints !== undefined
        ? Math.min(target, input.maxPoints)
        : target,
    ),
  );

  if (sanitized.length === 0) {
    return Array.from({ length: boundedTarget }, () => 0);
  }
  if (sanitized.length > boundedTarget) {
    return downsamplePeakHold(sanitized, boundedTarget);
  }
  if (sanitized.length < boundedTarget) {
    return upsampleLinear(sanitized, boundedTarget);
  }
  return sanitized;
}

export function rollingSeriesForChart(input: {
  values: number[];
  targetPoints: number;
  maxPoints?: number;
  fallbackValue?: number;
}): number[] {
  const target = Math.max(1, Math.floor(input.targetPoints));
  const boundedTarget = Math.max(
    1,
    Math.floor(
      input.maxPoints !== undefined
        ? Math.min(target, input.maxPoints)
        : target,
    ),
  );

  const sanitized = sanitizeNonNegativeSeries(input.values);
  if (sanitized.length <= 0) {
    const fallback =
      Number.isFinite(input.fallbackValue) && (input.fallbackValue || 0) > 0
        ? Number(input.fallbackValue)
        : 0;
    return Array.from({ length: boundedTarget }, () => fallback);
  }

  const tail =
    sanitized.length > boundedTarget
      ? sanitized.slice(sanitized.length - boundedTarget)
      : sanitized;

  if (tail.length === boundedTarget) {
    return tail;
  }

  return [
    ...Array.from({ length: boundedTarget - tail.length }, () => 0),
    ...tail,
  ];
}

export function selectDisplaySeries(input: {
  primary: number[];
  secondary: number[];
  fallback: number[];
  targetPoints: number;
  maxPoints?: number;
}): number[] {
  const source = hasPositiveSignal(input.primary)
    ? input.primary
    : hasPositiveSignal(input.secondary)
      ? input.secondary
      : input.fallback;

  return resampleSeriesForChart({
    values: source,
    targetPoints: input.targetPoints,
    maxPoints: input.maxPoints,
  });
}

export function chartMaxFromSeries(input: {
  seriesList: number[][];
  percentile?: number;
  minMax?: number;
}): number {
  const minMax = Math.max(1, input.minMax ?? 1);
  const percentile = Math.min(1, Math.max(0.5, input.percentile ?? 0.98));

  const allValues = input.seriesList
    .flatMap((series) => sanitizeNonNegativeSeries(series))
    .filter((value) => Number.isFinite(value) && value >= 0);

  if (allValues.length <= 0) {
    return minMax;
  }

  const sorted = [...allValues].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((sorted.length - 1) * percentile)),
  );
  const pValue = sorted[index] ?? minMax;
  return Math.max(minMax, pValue);
}
