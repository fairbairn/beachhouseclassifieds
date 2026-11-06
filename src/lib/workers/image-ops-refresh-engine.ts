import type { TrendRow, TrendRowsByMetric } from "./image-ops-shared-state";

export type TrendCursorByMetric = Record<string, number>;

export function buildSinceCursorMap(input: {
  metricNames: string[];
  lastAtMsByMetric: TrendCursorByMetric;
}): TrendCursorByMetric {
  const output: TrendCursorByMetric = {};
  for (const metricName of input.metricNames) {
    output[metricName] = Math.max(
      0,
      Math.floor(input.lastAtMsByMetric[metricName] ?? 0),
    );
  }
  return output;
}

export function mergeTrendRowsByMetric(input: {
  existing: TrendRowsByMetric;
  incoming: TrendRowsByMetric;
  lastAtMsByMetric: TrendCursorByMetric;
  maxPoints: number;
}): {
  rowsByMetric: TrendRowsByMetric;
  lastAtMsByMetric: TrendCursorByMetric;
  globalLastAtMs: number;
  changed: boolean;
} {
  const maxPoints = Math.max(1, Math.floor(input.maxPoints));
  const rowsByMetric: TrendRowsByMetric = { ...input.existing };
  const nextLastAtMsByMetric: TrendCursorByMetric = {
    ...input.lastAtMsByMetric,
  };

  let globalLastAtMs = 0;
  let changed = false;

  for (const [metricName, incomingRows] of Object.entries(input.incoming)) {
    const existingRows = rowsByMetric[metricName] ?? [];
    const lastAtMs = Math.max(
      nextLastAtMsByMetric[metricName] ?? 0,
      existingRows[existingRows.length - 1]?.atMs ?? 0,
    );

    const freshRows = (incomingRows ?? []).filter(
      (row) => Number.isFinite(row.atMs) && row.atMs > lastAtMs,
    );
    if (freshRows.length <= 0) {
      globalLastAtMs = Math.max(globalLastAtMs, lastAtMs);
      continue;
    }

    const merged = [...existingRows, ...freshRows].sort(
      (left: TrendRow, right: TrendRow) => left.atMs - right.atMs,
    );
    rowsByMetric[metricName] =
      merged.length > maxPoints
        ? merged.slice(merged.length - maxPoints)
        : merged;

    const metricLastAtMs =
      rowsByMetric[metricName][rowsByMetric[metricName].length - 1]?.atMs;
    nextLastAtMsByMetric[metricName] = Number.isFinite(metricLastAtMs)
      ? Number(metricLastAtMs)
      : lastAtMs;

    globalLastAtMs = Math.max(
      globalLastAtMs,
      nextLastAtMsByMetric[metricName] ?? 0,
    );
    changed = true;
  }

  for (const [metricName, atMs] of Object.entries(nextLastAtMsByMetric)) {
    globalLastAtMs = Math.max(globalLastAtMs, Number(atMs || 0));
    if (!rowsByMetric[metricName]) {
      rowsByMetric[metricName] = [];
    }
  }

  return {
    rowsByMetric,
    lastAtMsByMetric: nextLastAtMsByMetric,
    globalLastAtMs,
    changed,
  };
}
