import { describe, expect, it } from "vitest";

import {
  nextBullmqLastProcessedJobId,
  parseNumericBullmqJobId,
  shouldIncludeBullmqPolledRow,
} from "./bullmq-polling-cursor";

describe("bullmq polling cursor helpers", () => {
  it("parses numeric job ids", () => {
    expect(parseNumericBullmqJobId("42")).toBe(42);
    expect(parseNumericBullmqJobId(" 7 ")).toBe(7);
    expect(parseNumericBullmqJobId("abc")).toBeNull();
    expect(parseNumericBullmqJobId("0")).toBeNull();
  });

  it("skips same-score rows at or below cursor job id", () => {
    const cursor = { atMs: 1000, jobId: "120" };

    expect(
      shouldIncludeBullmqPolledRow({
        row: { jobId: "119", atMs: 1000 },
        cursor,
        minJobIdExclusive: 0,
      }),
    ).toBe(false);

    expect(
      shouldIncludeBullmqPolledRow({
        row: { jobId: "120", atMs: 1000 },
        cursor,
        minJobIdExclusive: 0,
      }),
    ).toBe(false);

    expect(
      shouldIncludeBullmqPolledRow({
        row: { jobId: "121", atMs: 1000 },
        cursor,
        minJobIdExclusive: 0,
      }),
    ).toBe(true);
  });

  it("uses minJobIdExclusive to avoid repulling already processed numeric jobs", () => {
    const cursor = { atMs: 1000, jobId: "" };

    expect(
      shouldIncludeBullmqPolledRow({
        row: { jobId: "500", atMs: 1001 },
        cursor,
        minJobIdExclusive: 500,
      }),
    ).toBe(false);

    expect(
      shouldIncludeBullmqPolledRow({
        row: { jobId: "501", atMs: 1001 },
        cursor,
        minJobIdExclusive: 500,
      }),
    ).toBe(true);
  });

  it("advances last processed id only for valid numeric job ids", () => {
    let last = 500;
    last = nextBullmqLastProcessedJobId({ previous: last, jobId: "499" });
    expect(last).toBe(500);

    last = nextBullmqLastProcessedJobId({ previous: last, jobId: "abc" });
    expect(last).toBe(500);

    last = nextBullmqLastProcessedJobId({ previous: last, jobId: "505" });
    expect(last).toBe(505);
  });

  it("keeps only unseen numeric job ids across consecutive poll cycles", () => {
    const cursor = { atMs: 1000, jobId: "" };
    let lastProcessed = 0;

    const firstPollRows = [
      { jobId: "101", atMs: 1000 },
      { jobId: "102", atMs: 1001 },
      { jobId: "103", atMs: 1002 },
    ];
    const firstPipelineIds = firstPollRows
      .filter((row) =>
        shouldIncludeBullmqPolledRow({
          row,
          cursor,
          minJobIdExclusive: lastProcessed,
        }),
      )
      .map((row) => row.jobId);

    expect(firstPipelineIds).toEqual(["101", "102", "103"]);

    for (const jobId of firstPipelineIds) {
      lastProcessed = nextBullmqLastProcessedJobId({
        previous: lastProcessed,
        jobId,
      });
    }
    expect(lastProcessed).toBe(103);

    const secondPollRows = [
      { jobId: "102", atMs: 1003 },
      { jobId: "103", atMs: 1003 },
      { jobId: "104", atMs: 1003 },
      { jobId: "105", atMs: 1004 },
    ];
    const secondPipelineIds = secondPollRows
      .filter((row) =>
        shouldIncludeBullmqPolledRow({
          row,
          cursor,
          minJobIdExclusive: lastProcessed,
        }),
      )
      .map((row) => row.jobId);

    expect(secondPipelineIds).toEqual(["104", "105"]);
  });
});
