import { describe, expect, it } from "vitest";

import {
  buildAvailabilityStartIndex,
  buildAvailabilityWindowQuery,
  computeRunLengths,
} from "@/lib/discover/availability-window-index";

describe("computeRunLengths", () => {
  it("computes consecutive run lengths from each day", () => {
    const flags: Array<0 | 1> = [1, 1, 1, 1, 0, 1, 1];
    expect(computeRunLengths(flags)).toEqual([4, 3, 2, 1, 0, 2, 1]);
  });
});

describe("buildAvailabilityStartIndex", () => {
  it("builds avail_N fields with valid start dates", () => {
    const dayInts = [20260601, 20260602, 20260603, 20260604, 20260605];
    const availabilityFlags: Array<0 | 1> = [1, 1, 1, 0, 1];

    const result = buildAvailabilityStartIndex({
      dayInts,
      availabilityFlags,
      maxStayNights: 4,
    });

    expect(result.avail_1).toEqual([20260601, 20260602, 20260603, 20260605]);
    expect(result.avail_2).toEqual([20260601, 20260602]);
    expect(result.avail_3).toEqual([20260601]);
    expect(result.avail_4).toEqual([]);
  });
});

describe("buildAvailabilityWindowQuery", () => {
  it("creates a range filter for valid start dates", () => {
    const query = buildAvailabilityWindowQuery({
      windowStartDayInt: 20260601,
      windowEndDayInt: 20260610,
      stayNights: 3,
    });

    expect(query.fieldName).toBe("avail_3");
    expect(query.startMin).toBe(20260601);
    expect(query.startMax).toBe(20260607);
    expect(query.filterExpression).toBe(
      "avail_3 >= 20260601 AND avail_3 <= 20260607",
    );
  });

  it("returns impossible filter when window is shorter than stay", () => {
    const query = buildAvailabilityWindowQuery({
      windowStartDayInt: 20260610,
      windowEndDayInt: 20260611,
      stayNights: 3,
    });

    expect(query.filterExpression).toBe("__never__ = true");
  });
});
