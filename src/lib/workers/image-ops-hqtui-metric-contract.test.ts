import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  OPS_SNAPSHOT_TREND_METRIC_REGISTRY,
  OPS_TREND_METRIC_REGISTRY,
} from "@/lib/workers/image-ops-control-module";

const HQTUI_PATH = resolve(
  process.cwd(),
  "src/lib/scripts/run-image-ops-hqtui.ts",
);

function collectMetricRefs(source: string, pattern: RegExp): string[] {
  const refs = new Set<string>();
  for (const match of source.matchAll(pattern)) {
    const name = String(match[1] || "").trim();
    if (name) {
      refs.add(name);
    }
  }
  return [...refs].sort((left, right) => left.localeCompare(right));
}

describe("image ops hqtui metric contracts", () => {
  it("keeps direct snapshot metric references aligned with snapshot registry", async () => {
    const source = await readFile(HQTUI_PATH, "utf8");
    const snapshotRegistryNames = new Set(
      OPS_SNAPSHOT_TREND_METRIC_REGISTRY.map((metric) => metric.name),
    );

    const directSnapshotRefs = collectMetricRefs(
      source,
      /state\.snapshotTrendLatestByName\.([A-Za-z0-9_]+)/g,
    );
    const validateSnapshotLiteralRefs = collectMetricRefs(
      source,
      /validateSnapshotMetricId\("snapshot\.([A-Za-z0-9_]+)"\)/g,
    );
    const trendRowsMetricRefs = collectMetricRefs(
      source,
      /trendRowsByMetric\?\.([A-Za-z0-9_]+)/g,
    );

    const allSnapshotRefs = [
      ...directSnapshotRefs,
      ...validateSnapshotLiteralRefs,
      ...trendRowsMetricRefs,
    ];

    const invalid = [...new Set(allSnapshotRefs)].filter(
      (name) => !snapshotRegistryNames.has(name),
    );

    expect(invalid).toEqual([]);
  });

  it("keeps direct runner metric references aligned with runner registry", async () => {
    const source = await readFile(HQTUI_PATH, "utf8");
    const runnerRegistryNames = new Set(
      OPS_TREND_METRIC_REGISTRY.map((metric) => metric.name),
    );

    const directRunnerRefs = collectMetricRefs(
      source,
      /state\.runnerTrendLatestByName\.([A-Za-z0-9_]+)/g,
    );
    const validateRunnerLiteralRefs = collectMetricRefs(
      source,
      /validateRunnerMetricId\("runner\.([A-Za-z0-9_]+)"\)/g,
    );

    const allRunnerRefs = [...directRunnerRefs, ...validateRunnerLiteralRefs];
    const invalid = [...new Set(allRunnerRefs)].filter(
      (name) => !runnerRegistryNames.has(name),
    );

    expect(invalid).toEqual([]);
  });
});
