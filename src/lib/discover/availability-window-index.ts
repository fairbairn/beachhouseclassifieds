export const DEFAULT_MAX_STAY_NIGHTS = 28;

export type AvailabilityWindowInput = {
  dayInts: number[];
  availabilityFlags: Array<0 | 1>;
  maxStayNights?: number;
};

export type AvailabilityIndexDocument = {
  [fieldName: string]: number[];
};

export type AvailabilityWindowQueryInput = {
  windowStartDayInt: number;
  windowEndDayInt: number;
  stayNights: number;
  fieldPrefix?: string;
};

export type AvailabilityWindowQuery = {
  fieldName: string;
  startMin: number;
  startMax: number;
  filterExpression: string;
};

function assertFinitePositiveInteger(value: number, fieldName: string): void {
  if (!Number.isFinite(value) || value < 1 || Math.floor(value) !== value) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
}

function normalizeMaxStayNights(value?: number): number {
  if (typeof value !== "number") {
    return DEFAULT_MAX_STAY_NIGHTS;
  }

  assertFinitePositiveInteger(value, "maxStayNights");
  return value;
}

export function computeRunLengths(availabilityFlags: Array<0 | 1>): number[] {
  const runLengths = new Array<number>(availabilityFlags.length).fill(0);

  for (let index = availabilityFlags.length - 1; index >= 0; index -= 1) {
    if (availabilityFlags[index] === 1) {
      runLengths[index] = 1 + (runLengths[index + 1] ?? 0);
    }
  }

  return runLengths;
}

export function buildAvailabilityStartIndex(
  input: AvailabilityWindowInput,
): AvailabilityIndexDocument {
  if (input.dayInts.length !== input.availabilityFlags.length) {
    throw new Error("dayInts and availabilityFlags must have identical length");
  }

  const maxStayNights = normalizeMaxStayNights(input.maxStayNights);
  const runLengths = computeRunLengths(input.availabilityFlags);
  const out: AvailabilityIndexDocument = {};

  for (let nights = 1; nights <= maxStayNights; nights += 1) {
    out[`avail_${nights}`] = [];
  }

  for (let dayIndex = 0; dayIndex < input.dayInts.length; dayIndex += 1) {
    const dayInt = input.dayInts[dayIndex];
    const maxNightsAtDay = Math.min(runLengths[dayIndex] ?? 0, maxStayNights);

    if (!Number.isFinite(dayInt)) {
      throw new Error(`dayInts[${dayIndex}] must be a finite number`);
    }

    for (let nights = 1; nights <= maxNightsAtDay; nights += 1) {
      out[`avail_${nights}`].push(dayInt);
    }
  }

  return out;
}

function toFieldName(stayNights: number, fieldPrefix = "avail_"): string {
  assertFinitePositiveInteger(stayNights, "stayNights");
  if (typeof fieldPrefix !== "string" || fieldPrefix.length === 0) {
    throw new Error("fieldPrefix must be a non-empty string");
  }

  return `${fieldPrefix}${stayNights}`;
}

export function buildAvailabilityWindowQuery(
  input: AvailabilityWindowQueryInput,
): AvailabilityWindowQuery {
  assertFinitePositiveInteger(input.windowStartDayInt, "windowStartDayInt");
  assertFinitePositiveInteger(input.windowEndDayInt, "windowEndDayInt");
  assertFinitePositiveInteger(input.stayNights, "stayNights");

  const startMin = input.windowStartDayInt;
  const startMax = input.windowEndDayInt - input.stayNights;
  const fieldName = toFieldName(input.stayNights, input.fieldPrefix);

  if (startMax < startMin) {
    return {
      fieldName,
      startMin,
      startMax,
      // Impossible range: caller can short-circuit query execution.
      filterExpression: "__never__ = true",
    };
  }

  return {
    fieldName,
    startMin,
    startMax,
    filterExpression: `${fieldName} >= ${startMin} AND ${fieldName} <= ${startMax}`,
  };
}
