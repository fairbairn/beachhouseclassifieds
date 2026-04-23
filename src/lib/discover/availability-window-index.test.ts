import { describe, expect, it } from "vitest";

import {
  AVAILABILITY_WINDOW_DAYS_LIMIT,
  availabilityStatusCodeNightAvailability,
  buildAvailabilityStartIndex,
  buildAvailabilityWindowQuery,
  computeRunLengths,
  dayIntFromIsoDateString,
  validateAvailabilityWindowInput,
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

  it("coerces stay nights down when window is shorter than stay", () => {
    const query = buildAvailabilityWindowQuery({
      windowStartDayInt: 20260610,
      windowEndDayInt: 20260613,
      stayNights: 7,
    });

    expect(query.fieldName).toBe("avail_3");
    expect(query.startMin).toBe(20260610);
    expect(query.startMax).toBe(20260610);
    expect(query.filterExpression).toBe(
      "avail_3 >= 20260610 AND avail_3 <= 20260610",
    );
  });

  it("returns impossible filter when window allows zero nights", () => {
    const query = buildAvailabilityWindowQuery({
      windowStartDayInt: 20260610,
      windowEndDayInt: 20260610,
      stayNights: 1,
    });

    expect(query.filterExpression).toBe("__never__ = true");
  });

  it("handles cross-month date windows using calendar arithmetic", () => {
    const query = buildAvailabilityWindowQuery({
      windowStartDayInt: 20260628,
      windowEndDayInt: 20260703,
      stayNights: 5,
    });

    expect(query.fieldName).toBe("avail_5");
    expect(query.startMin).toBe(20260628);
    expect(query.startMax).toBe(20260628);
    expect(query.filterExpression).toBe(
      "avail_5 >= 20260628 AND avail_5 <= 20260628",
    );
  });
});

describe("dayIntFromIsoDateString", () => {
  it("parses valid ISO date strings", () => {
    expect(dayIntFromIsoDateString("2026-06-01")).toBe(20260601);
  });

  it("returns null for invalid date strings", () => {
    expect(dayIntFromIsoDateString("2026-13-01")).toBeNull();
    expect(dayIntFromIsoDateString("06/01/2026")).toBeNull();
  });
});

describe("validateAvailabilityWindowInput", () => {
  it("accepts valid 60-day bounded windows", () => {
    const result = validateAvailabilityWindowInput({
      windowStartDayInt: 20260601,
      windowEndDayInt: 20260730,
      stayNights: 7,
    });

    expect(result.isValid).toBe(true);
    expect(result.fieldErrors).toEqual({});
  });

  it("rejects windows larger than the configured day limit", () => {
    const result = validateAvailabilityWindowInput({
      windowStartDayInt: 20260601,
      windowEndDayInt: 20260801,
      stayNights: 7,
      maxWindowDays: AVAILABILITY_WINDOW_DAYS_LIMIT,
    });

    expect(result.isValid).toBe(false);
    expect(result.fieldErrors.availabilityWindow?.[0]).toContain("60 days");
  });

  it("rejects stay nights greater than 30", () => {
    const result = validateAvailabilityWindowInput({
      windowStartDayInt: 20260601,
      windowEndDayInt: 20260630,
      stayNights: 31,
    });

    expect(result.isValid).toBe(false);
    expect(result.fieldErrors.stayNights?.[0]).toContain("30");
  });
});

describe("availabilityStatusCodeNightAvailability", () => {
  it("treats only I and A as available nights", () => {
    expect(availabilityStatusCodeNightAvailability("I")).toBe(true);
    expect(availabilityStatusCodeNightAvailability("A")).toBe(true);
  });

  it("treats O, U, and X as unavailable nights", () => {
    expect(availabilityStatusCodeNightAvailability("O")).toBe(false);
    expect(availabilityStatusCodeNightAvailability("U")).toBe(false);
    expect(availabilityStatusCodeNightAvailability("X")).toBe(false);
  });

  it("returns null for empty or unknown status codes", () => {
    expect(availabilityStatusCodeNightAvailability("AI")).toBeNull();
    expect(availabilityStatusCodeNightAvailability("IA")).toBeNull();
    expect(availabilityStatusCodeNightAvailability(" ")).toBeNull();
    expect(availabilityStatusCodeNightAvailability("ZZ")).toBeNull();
    expect(availabilityStatusCodeNightAvailability(null)).toBeNull();
    expect(availabilityStatusCodeNightAvailability(undefined)).toBeNull();
  });
});
