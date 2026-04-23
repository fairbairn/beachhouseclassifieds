export const AVAILABILITY_WINDOW_DAYS_LIMIT = 60;
export const AVAILABILITY_QUERY_MAX_STAY_NIGHTS = 30;
export const DEFAULT_MAX_STAY_NIGHTS = AVAILABILITY_QUERY_MAX_STAY_NIGHTS;
export const AVAILABILITY_INDEX_DAYS = 75;
export const AVAILABILITY_INDEX_MAX_STAY_NIGHTS =
  AVAILABILITY_QUERY_MAX_STAY_NIGHTS;

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

export type AvailabilityWindowValidationInput = {
  windowStartDayInt?: number;
  windowEndDayInt?: number;
  stayNights?: number;
  maxWindowDays?: number;
  maxStayNights?: number;
};

export type AvailabilityWindowValidationResult = {
  isValid: boolean;
  fieldErrors: Record<string, string[]>;
};

export function availabilityStatusCodeNightAvailability(
  statusCode: string | null | undefined,
): boolean | null {
  if (typeof statusCode !== "string") {
    return null;
  }

  const normalized = statusCode.trim().toUpperCase();
  if (!normalized) {
    return null;
  }

  if (normalized === "X") {
    return false;
  }

  if (normalized === "U" || normalized === "O") {
    return false;
  }

  if (normalized === "A" || normalized === "I") {
    return true;
  }

  return null;
}

function assertFinitePositiveInteger(value: number, fieldName: string): void {
  if (!Number.isFinite(value) || value < 1 || Math.floor(value) !== value) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
}

function toUtcDateFromDayInt(dayInt: number): Date | null {
  if (!Number.isFinite(dayInt) || Math.floor(dayInt) !== dayInt) {
    return null;
  }

  const raw = String(dayInt);
  if (raw.length !== 8) {
    return null;
  }

  const year = Number(raw.slice(0, 4));
  const month = Number(raw.slice(4, 6));
  const day = Number(raw.slice(6, 8));

  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day)
  ) {
    return null;
  }

  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    return null;
  }

  return candidate;
}

export function isValidDayInt(dayInt: number): boolean {
  return toUtcDateFromDayInt(dayInt) !== null;
}

export function dayIntFromIsoDateString(value: string): number | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!match) {
    return null;
  }

  const dayInt = Number(`${match[1]}${match[2]}${match[3]}`);
  return isValidDayInt(dayInt) ? dayInt : null;
}

export function addDaysToDayInt(dayInt: number, deltaDays: number): number {
  if (!Number.isFinite(deltaDays) || Math.floor(deltaDays) !== deltaDays) {
    throw new Error("deltaDays must be an integer");
  }

  const base = toUtcDateFromDayInt(dayInt);
  if (!base) {
    throw new Error("dayInt must be a valid YYYYMMDD integer date");
  }

  const next = new Date(base);
  next.setUTCDate(next.getUTCDate() + deltaDays);

  const year = String(next.getUTCFullYear()).padStart(4, "0");
  const month = String(next.getUTCMonth() + 1).padStart(2, "0");
  const day = String(next.getUTCDate()).padStart(2, "0");

  return Number(`${year}${month}${day}`);
}

export function calendarDaySpanInclusive(
  startDayInt: number,
  endDayInt: number,
): number {
  const startDate = toUtcDateFromDayInt(startDayInt);
  const endDate = toUtcDateFromDayInt(endDayInt);
  if (!startDate || !endDate) {
    throw new Error("startDayInt and endDayInt must be valid YYYYMMDD dates");
  }

  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const deltaMs = endDate.getTime() - startDate.getTime();
  return Math.floor(deltaMs / MS_PER_DAY) + 1;
}

export function enumerateDayInts(startDayInt: number, days: number): number[] {
  assertFinitePositiveInteger(startDayInt, "startDayInt");
  assertFinitePositiveInteger(days, "days");
  if (!isValidDayInt(startDayInt)) {
    throw new Error("startDayInt must be a valid YYYYMMDD date");
  }

  const out: number[] = [];
  for (let index = 0; index < days; index += 1) {
    out.push(addDaysToDayInt(startDayInt, index));
  }
  return out;
}

export function validateAvailabilityWindowInput(
  input: AvailabilityWindowValidationInput,
): AvailabilityWindowValidationResult {
  const fieldErrors: Record<string, string[]> = {};
  const maxWindowDays =
    typeof input.maxWindowDays === "number"
      ? input.maxWindowDays
      : AVAILABILITY_WINDOW_DAYS_LIMIT;
  const maxStayNights =
    typeof input.maxStayNights === "number"
      ? input.maxStayNights
      : DEFAULT_MAX_STAY_NIGHTS;

  const hasAnyAvailabilityInput =
    input.windowStartDayInt !== undefined ||
    input.windowEndDayInt !== undefined ||
    input.stayNights !== undefined;

  if (!hasAnyAvailabilityInput) {
    return { isValid: true, fieldErrors };
  }

  if (input.windowStartDayInt === undefined) {
    fieldErrors.windowStartDayInt = [
      "windowStartDayInt is required when availability filtering is provided",
    ];
  } else if (!isValidDayInt(input.windowStartDayInt)) {
    fieldErrors.windowStartDayInt = [
      "windowStartDayInt must be a valid YYYYMMDD date",
    ];
  }

  if (input.windowEndDayInt === undefined) {
    fieldErrors.windowEndDayInt = [
      "windowEndDayInt is required when availability filtering is provided",
    ];
  } else if (!isValidDayInt(input.windowEndDayInt)) {
    fieldErrors.windowEndDayInt = [
      "windowEndDayInt must be a valid YYYYMMDD date",
    ];
  }

  if (input.stayNights === undefined) {
    fieldErrors.stayNights = [
      "stayNights is required when availability filtering is provided",
    ];
  } else if (
    !Number.isFinite(input.stayNights) ||
    input.stayNights < 1 ||
    Math.floor(input.stayNights) !== input.stayNights
  ) {
    fieldErrors.stayNights = ["stayNights must be a positive integer"];
  } else if (input.stayNights > maxStayNights) {
    fieldErrors.stayNights = [
      `stayNights must be less than or equal to ${maxStayNights}`,
    ];
  }

  if (
    input.windowStartDayInt !== undefined &&
    input.windowEndDayInt !== undefined &&
    isValidDayInt(input.windowStartDayInt) &&
    isValidDayInt(input.windowEndDayInt)
  ) {
    const spanDays = calendarDaySpanInclusive(
      input.windowStartDayInt,
      input.windowEndDayInt,
    );

    if (spanDays < 1) {
      fieldErrors.availabilityWindow = [
        "windowEndDayInt must be greater than or equal to windowStartDayInt",
      ];
    } else if (spanDays > maxWindowDays) {
      fieldErrors.availabilityWindow = [
        `availability window span must be less than or equal to ${maxWindowDays} days`,
      ];
    }
  }

  return {
    isValid: Object.keys(fieldErrors).length === 0,
    fieldErrors,
  };
}

function normalizeMaxStayNights(value?: number): number {
  if (typeof value !== "number") {
    return AVAILABILITY_INDEX_MAX_STAY_NIGHTS;
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

  const spanDaysInclusive = calendarDaySpanInclusive(
    input.windowStartDayInt,
    input.windowEndDayInt,
  );
  const maxPossibleStayNights = Math.max(0, spanDaysInclusive - 1);
  const effectiveStayNights = Math.min(input.stayNights, maxPossibleStayNights);
  const startMin = input.windowStartDayInt;
  const fieldName = toFieldName(
    Math.max(1, effectiveStayNights),
    input.fieldPrefix,
  );

  if (effectiveStayNights < 1) {
    return {
      fieldName,
      startMin,
      startMax: addDaysToDayInt(input.windowEndDayInt, -1),
      // Impossible range: caller can short-circuit query execution.
      filterExpression: "__never__ = true",
    };
  }

  const startMax = addDaysToDayInt(input.windowEndDayInt, -effectiveStayNights);

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
