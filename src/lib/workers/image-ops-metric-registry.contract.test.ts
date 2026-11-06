import { describe, expect, it } from "vitest";

import {
  IMAGE_IMAGE_PERFORMANCE_SLICE_METRIC_SLUGS,
  IMAGE_JOB_SLICE_METRIC_SLUGS,
  IMAGE_SLICE_METRIC_REGISTRY,
} from "@/lib/workers/image-metrics-registry";
import {
  OPS_SNAPSHOT_TREND_METRIC_REGISTRY,
  OPS_TREND_METRIC_REGISTRY,
} from "@/lib/workers/image-ops-control-module";

function duplicateValues(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
      continue;
    }
    seen.add(value);
  }
  return [...duplicates].sort((left, right) => left.localeCompare(right));
}

describe("image ops metric registries", () => {
  it("keeps runner trend metric names and keys unique", () => {
    const names = OPS_TREND_METRIC_REGISTRY.map((metric) => metric.name);
    const keys = OPS_TREND_METRIC_REGISTRY.map((metric) => metric.key);

    expect(duplicateValues(names)).toEqual([]);
    expect(duplicateValues(keys)).toEqual([]);
  });

  it("keeps snapshot trend metric names and keys unique", () => {
    const names = OPS_SNAPSHOT_TREND_METRIC_REGISTRY.map(
      (metric) => metric.name,
    );
    const keys = OPS_SNAPSHOT_TREND_METRIC_REGISTRY.map((metric) => metric.key);

    expect(duplicateValues(names)).toEqual([]);
    expect(duplicateValues(keys)).toEqual([]);
  });

  it("derives slice slugs from the single slice registry", () => {
    const expectedImageSlugs = IMAGE_SLICE_METRIC_REGISTRY.filter(
      (metric) => metric.group === "images",
    ).map((metric) => metric.slug);
    const expectedJobSlugs = IMAGE_SLICE_METRIC_REGISTRY.filter(
      (metric) => metric.group === "jobs",
    ).map((metric) => metric.slug);

    expect(IMAGE_IMAGE_PERFORMANCE_SLICE_METRIC_SLUGS).toEqual(
      expectedImageSlugs,
    );
    expect(IMAGE_JOB_SLICE_METRIC_SLUGS).toEqual(expectedJobSlugs);
    expect(duplicateValues(expectedImageSlugs)).toEqual([]);
    expect(duplicateValues(expectedJobSlugs)).toEqual([]);
  });
});
