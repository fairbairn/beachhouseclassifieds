import { Chalk } from "chalk";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const chalk = new Chalk({ level: 1 });

const CANONICAL_STATUS_CODES = new Set(["A", "U", "I", "O", "X"]);

type CliOptions = {
  adapterKey: string;
  maxListings: number | null;
};

type AvailabilityDayRecord = {
  date?: unknown;
  day_code?: unknown;
  status_code?: unknown;
  changeover_code?: unknown;
  is_available_for_checkin?: unknown;
  is_available_for_checkout?: unknown;
  is_checkin_allowed?: unknown;
  is_checkout_allowed?: unknown;
};

type DetailRecord = {
  normalized_availability?: {
    days?: AvailabilityDayRecord[];
    day_codes?: unknown;
    availability_source?: unknown;
    calendar_bounds?: {
      min_day_key?: unknown;
      max_day_key?: unknown;
    };
    has_calendar_widget?: unknown;
    booking_restrictions?: unknown;
    min_night_rules?: unknown;
  };
  availability_raw?: {
    observed_day_cell_count?: unknown;
    observed_status_classes?: unknown;
  };
  normalized_rates?: {
    days?: Array<{
      date?: unknown;
      changeover_code?: unknown;
    }>;
  };
};

type ValidationIssueCode =
  | "invalid_json"
  | "missing_normalized_availability_days"
  | "missing_required_availability_data"
  | "missing_day_code"
  | "non_canonical_day_code"
  | "inconsistent_day_code"
  | "missing_day_changeover_code"
  | "non_canonical_day_changeover_code"
  | "inconsistent_day_changeover_code"
  | "missing_status_code"
  | "non_canonical_status_code"
  | "missing_checkin_boolean"
  | "missing_checkout_boolean"
  | "uniform_day_codes_red_flag"
  | "uniform_status_code_red_flag"
  | "missing_turn_day_status"
  | "missing_checkout_turn_day_boundary"
  | "missing_checkin_turn_day_boundary"
  | "non_turn_changeover_code";
const TURN_DAY_CHANGEOVER_CODES = new Set(["", "I", "O", "C", "X"]);
const CANONICAL_DAY_CODES = new Set(["Y", "N"]);

function expectedDayChangeoverCode(statusCode: string): string {
  if (statusCode === "I") {
    return "I";
  }
  if (statusCode === "O") {
    return "O";
  }
  if (statusCode === "A") {
    return "C";
  }
  return "X";
}

type ValidationIssue = {
  severity: "error" | "warning";
  code: ValidationIssueCode;
  message: string;
};

type ValidationSummary = {
  adapterKey: string;
  filesScanned: number;
  filesWithAvailability: number;
  daysChecked: number;
  issues: ValidationIssue[];
};

function parseArgs(argv: string[]): CliOptions {
  let adapterKey: string | null = null;
  let maxListings: number | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    if (arg === "--adapter-key" && value) {
      adapterKey = value.trim().toLowerCase();
      index += 1;
      continue;
    }

    if (arg === "--max-listings" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        maxListings = Math.floor(parsed);
      }
      index += 1;
      continue;
    }
  }

  if (!adapterKey) {
    throw new Error("Missing required --adapter-key <adapterKey>");
  }

  return { adapterKey, maxListings };
}

async function listJsonFiles(dirPath: string): Promise<string[]> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

function toCanonicalStatusCode(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toUpperCase();
  return normalized.length === 0 ? null : normalized;
}

function resolveCheckinBoolean(day: AvailabilityDayRecord): unknown {
  if (typeof day.is_available_for_checkin === "boolean") {
    return day.is_available_for_checkin;
  }
  return day.is_checkin_allowed;
}

function resolveCheckoutBoolean(day: AvailabilityDayRecord): unknown {
  if (typeof day.is_available_for_checkout === "boolean") {
    return day.is_available_for_checkout;
  }
  return day.is_checkout_allowed;
}

function normalizeChangeoverCode(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().toUpperCase();
}

function parseIsoDate(value: unknown): Date | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return null;
  }

  const parsed = new Date(`${trimmed}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isDec31ToJan1Boundary(
  previousDay: AvailabilityDayRecord,
  currentDay: AvailabilityDayRecord,
): boolean {
  const previousDate = parseIsoDate(previousDay.date);
  const currentDate = parseIsoDate(currentDay.date);
  if (!previousDate || !currentDate) {
    return false;
  }

  const previousYear = previousDate.getUTCFullYear();
  const currentYear = currentDate.getUTCFullYear();

  return (
    previousDate.getUTCMonth() === 11 &&
    previousDate.getUTCDate() === 31 &&
    currentDate.getUTCMonth() === 0 &&
    currentDate.getUTCDate() === 1 &&
    currentYear === previousYear + 1
  );
}

function normalizeIsoDate(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
}

function resolveAvailabilitySource(
  value: unknown,
): "listing_calendar" | "widget_calendar" | "fallback_unavailable" | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  if (
    normalized === "listing_calendar" ||
    normalized === "widget_calendar" ||
    normalized === "fallback_unavailable"
  ) {
    return normalized;
  }
  return null;
}

function hasCorroboratingAvailabilitySignals(
  parsed: DetailRecord,
  days: AvailabilityDayRecord[],
): boolean {
  const normalized = parsed.normalized_availability;
  if (!normalized) {
    return false;
  }

  const hasCalendarWidget = normalized.has_calendar_widget === true;
  const hasBookingRestrictions =
    Array.isArray(normalized.booking_restrictions) &&
    normalized.booking_restrictions.length > 0;
  const hasMinNightRules =
    Array.isArray(normalized.min_night_rules) &&
    normalized.min_night_rules.length > 0;
  const hasDayLevelMinNights = days.some((day) => {
    if (typeof day?.min_nights_required !== "number") {
      return false;
    }
    return (
      Number.isFinite(day.min_nights_required) && day.min_nights_required > 0
    );
  });
  const observedDayCellCount =
    typeof parsed.availability_raw?.observed_day_cell_count === "number" &&
    Number.isFinite(parsed.availability_raw.observed_day_cell_count)
      ? parsed.availability_raw.observed_day_cell_count
      : 0;
  const hasObservedDayCells = observedDayCellCount > 0;
  const observedStatusClasses = Array.isArray(
    parsed.availability_raw?.observed_status_classes,
  )
    ? parsed.availability_raw?.observed_status_classes
    : [];
  const hasObservedStatusClasses = observedStatusClasses.some(
    (value) => typeof value === "string" && value.trim().length > 0,
  );

  return (
    hasCalendarWidget ||
    hasBookingRestrictions ||
    hasMinNightRules ||
    hasDayLevelMinNights ||
    hasObservedDayCells ||
    hasObservedStatusClasses
  );
}

function nextNonXStatus(
  days: AvailabilityDayRecord[],
  startIndex: number,
): { status: string; index: number } | null {
  for (let index = startIndex; index < days.length; index += 1) {
    const status = toCanonicalStatusCode(days[index]?.status_code);
    if (!status || status === "X") {
      continue;
    }
    return { status, index };
  }
  return null;
}

function pushIssue(
  issues: ValidationIssue[],
  code: ValidationIssueCode,
  message: string,
  severity: "error" | "warning" = "error",
): void {
  issues.push({ severity, code, message });
}

function printIssues(issues: ValidationIssue[]): void {
  for (const issue of issues.slice(0, 80)) {
    const severityLabel =
      issue.severity === "warning"
        ? chalk.yellow("[warning]")
        : chalk.red("[error]");
    console.error(
      `${chalk.red("-")} ${severityLabel} ${chalk.yellow(`[${issue.code}]`)} ${issue.message}`,
    );
  }

  if (issues.length > 80) {
    console.error(chalk.yellow(`... ${issues.length - 80} more issue(s)`));
  }
}

async function validateAdapterAvailabilityStatusCodes(
  options: CliOptions,
): Promise<ValidationSummary> {
  const detailsDir = path.resolve(
    "src/lib/data/external-sources",
    options.adapterKey,
    "details",
    "json",
  );

  const jsonFiles = await listJsonFiles(detailsDir);
  const selectedFiles =
    options.maxListings === null
      ? jsonFiles
      : jsonFiles.slice(0, options.maxListings);

  const issues: ValidationIssue[] = [];

  let filesWithAvailability = 0;
  let daysChecked = 0;

  for (const fileName of selectedFiles) {
    const filePath = path.join(detailsDir, fileName);

    let parsed: DetailRecord;
    try {
      parsed = JSON.parse(await readFile(filePath, "utf8")) as DetailRecord;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      pushIssue(
        issues,
        "invalid_json",
        `${fileName}: failed to parse JSON (${message})`,
      );
      continue;
    }

    const days = parsed.normalized_availability?.days;
    if (!Array.isArray(days) || days.length === 0) {
      pushIssue(
        issues,
        "missing_required_availability_data",
        `${fileName}: listing MUST include non-empty normalized_availability.days`,
      );
      pushIssue(
        issues,
        "missing_normalized_availability_days",
        `${fileName}: normalized_availability.days is missing or empty`,
      );
      continue;
    }

    const dayCodes =
      typeof parsed.normalized_availability?.day_codes === "string"
        ? parsed.normalized_availability.day_codes.trim().toUpperCase()
        : "";
    const availabilitySource = resolveAvailabilitySource(
      parsed.normalized_availability?.availability_source,
    );
    const hasCorroboratingSignals = hasCorroboratingAvailabilitySignals(
      parsed,
      days,
    );
    const shouldFlagUniformUnavailable =
      availabilitySource === "fallback_unavailable" ||
      (availabilitySource === null && !hasCorroboratingSignals);
    if (
      shouldFlagUniformUnavailable &&
      dayCodes.length > 0 &&
      /^U+$/.test(dayCodes)
    ) {
      pushIssue(
        issues,
        "uniform_day_codes_red_flag",
        `${fileName}: normalized_availability.day_codes is all 'U' across ${dayCodes.length} day(s); this is a red-flag availability signal`,
        "warning",
      );
    } else if (
      shouldFlagUniformUnavailable &&
      dayCodes.length > 0 &&
      /^X+$/.test(dayCodes)
    ) {
      pushIssue(
        issues,
        "uniform_day_codes_red_flag",
        `${fileName}: normalized_availability.day_codes is all 'X' across ${dayCodes.length} day(s); this is a red-flag availability signal`,
        "warning",
      );
    }

    const hasUsableAvailabilityDay = days.some((day) => {
      const date = typeof day?.date === "string" ? day.date.trim() : "";
      const status = toCanonicalStatusCode(day?.status_code);
      return /^\d{4}-\d{2}-\d{2}$/.test(date) && status !== null;
    });
    if (!hasUsableAvailabilityDay) {
      pushIssue(
        issues,
        "missing_required_availability_data",
        `${fileName}: listing MUST include at least one valid availability day with date + status_code`,
      );
    }

    filesWithAvailability += 1;
    let hasTurnDayHint = false;
    let hasTurnDayStatus = false;
    let missingDayCodeCount = 0;
    let nonCanonicalDayCodeCount = 0;
    let inconsistentDayCodeCount = 0;
    let missingDayChangeoverCount = 0;
    let nonCanonicalDayChangeoverCount = 0;
    let inconsistentDayChangeoverCount = 0;
    let canonicalStatusCount = 0;
    let statusUCount = 0;
    let statusXCount = 0;

    for (let index = 0; index < days.length; index += 1) {
      const day = days[index] ?? {};
      const label = `${fileName} day#${index + 1}`;
      const canonicalStatus = toCanonicalStatusCode(day.status_code);
      const dayCode =
        typeof day.day_code === "string"
          ? day.day_code.trim().toUpperCase()
          : "";
      const dayChangeoverCode = normalizeChangeoverCode(day.changeover_code);

      if (typeof day.day_code !== "string") {
        missingDayCodeCount += 1;
      } else if (!CANONICAL_DAY_CODES.has(dayCode)) {
        nonCanonicalDayCodeCount += 1;
      }

      if (typeof day.changeover_code !== "string") {
        missingDayChangeoverCount += 1;
      } else if (!TURN_DAY_CHANGEOVER_CODES.has(dayChangeoverCode)) {
        nonCanonicalDayChangeoverCount += 1;
      }

      if (canonicalStatus === null) {
        pushIssue(
          issues,
          "missing_status_code",
          `${label}: missing status_code`,
        );
      } else if (!CANONICAL_STATUS_CODES.has(canonicalStatus)) {
        pushIssue(
          issues,
          "non_canonical_status_code",
          `${label}: status_code='${canonicalStatus}' must be one of A/U/I/O/X`,
        );
      } else if (canonicalStatus === "I" || canonicalStatus === "O") {
        hasTurnDayStatus = true;
      }

      if (CANONICAL_STATUS_CODES.has(canonicalStatus ?? "")) {
        canonicalStatusCount += 1;
        if (canonicalStatus === "U") {
          statusUCount += 1;
        } else if (canonicalStatus === "X") {
          statusXCount += 1;
        }
      }

      if (
        CANONICAL_STATUS_CODES.has(canonicalStatus ?? "") &&
        typeof day.day_code === "string" &&
        CANONICAL_DAY_CODES.has(dayCode)
      ) {
        const expectedDayCode =
          canonicalStatus === "A" || canonicalStatus === "O" ? "Y" : "N";
        if (dayCode !== expectedDayCode) {
          inconsistentDayCodeCount += 1;
        }
      }

      if (
        CANONICAL_STATUS_CODES.has(canonicalStatus ?? "") &&
        typeof day.changeover_code === "string" &&
        dayChangeoverCode.length > 0 &&
        TURN_DAY_CHANGEOVER_CODES.has(dayChangeoverCode)
      ) {
        const expected = expectedDayChangeoverCode(canonicalStatus ?? "X");
        if (dayChangeoverCode !== expected) {
          inconsistentDayChangeoverCount += 1;
        }
      }

      if (typeof resolveCheckinBoolean(day) !== "boolean") {
        pushIssue(
          issues,
          "missing_checkin_boolean",
          `${label}: is_available_for_checkin must be boolean`,
        );
      }

      if (typeof resolveCheckoutBoolean(day) !== "boolean") {
        pushIssue(
          issues,
          "missing_checkout_boolean",
          `${label}: is_available_for_checkout must be boolean`,
        );
      }

      daysChecked += 1;
    }

    if (missingDayCodeCount > 0) {
      pushIssue(
        issues,
        "missing_day_code",
        `${fileName}: normalized_availability.days missing day_code on ${missingDayCodeCount} day(s)`,
        "error",
      );
    }

    if (nonCanonicalDayCodeCount > 0) {
      pushIssue(
        issues,
        "non_canonical_day_code",
        `${fileName}: normalized_availability.days has non-canonical day_code on ${nonCanonicalDayCodeCount} day(s) (expected Y/N)`,
        "warning",
      );
    }

    if (inconsistentDayCodeCount > 0) {
      pushIssue(
        issues,
        "inconsistent_day_code",
        `${fileName}: normalized_availability.days has ${inconsistentDayCodeCount} day(s) where day_code does not match status_code availability mapping`,
        "warning",
      );
    }

    if (missingDayChangeoverCount > 0) {
      pushIssue(
        issues,
        "missing_day_changeover_code",
        `${fileName}: normalized_availability.days missing changeover_code on ${missingDayChangeoverCount} day(s)`,
        "error",
      );
    }

    if (nonCanonicalDayChangeoverCount > 0) {
      pushIssue(
        issues,
        "non_canonical_day_changeover_code",
        `${fileName}: normalized_availability.days has non-canonical changeover_code on ${nonCanonicalDayChangeoverCount} day(s) (expected I/O/C/X or empty)`,
        "warning",
      );
    }

    if (inconsistentDayChangeoverCount > 0) {
      pushIssue(
        issues,
        "inconsistent_day_changeover_code",
        `${fileName}: normalized_availability.days has ${inconsistentDayChangeoverCount} day(s) where changeover_code does not match status_code mapping`,
        "warning",
      );
    }

    if (
      shouldFlagUniformUnavailable &&
      canonicalStatusCount > 0 &&
      statusUCount === canonicalStatusCount
    ) {
      pushIssue(
        issues,
        "uniform_status_code_red_flag",
        `${fileName}: normalized_availability.days status_code is all 'U' across ${canonicalStatusCount} day(s); this is a red-flag availability signal`,
        "warning",
      );
    } else if (
      shouldFlagUniformUnavailable &&
      canonicalStatusCount > 0 &&
      statusXCount === canonicalStatusCount
    ) {
      pushIssue(
        issues,
        "uniform_status_code_red_flag",
        `${fileName}: normalized_availability.days status_code is all 'X' across ${canonicalStatusCount} day(s); this is a red-flag availability signal`,
        "warning",
      );
    }

    const ratesDays = parsed.normalized_rates?.days;
    if (Array.isArray(ratesDays)) {
      for (const rateDay of ratesDays) {
        const code = normalizeChangeoverCode(rateDay?.changeover_code);
        if (!TURN_DAY_CHANGEOVER_CODES.has(code)) {
          pushIssue(
            issues,
            "non_turn_changeover_code",
            `${fileName}: normalized_rates.days changeover_code='${code}' is not a turn-day code (expected I/O/C/X or empty)`,
          );
        }
        if (code === "I" || code === "O") {
          hasTurnDayHint = true;
          break;
        }
      }
    }

    if (hasTurnDayHint && !hasTurnDayStatus) {
      pushIssue(
        issues,
        "missing_turn_day_status",
        `${fileName}: changeover hints include I/O but normalized_availability.days has no I/O status_code`,
      );
    }

    for (let index = 1; index < days.length; index += 1) {
      const previous = toCanonicalStatusCode(days[index - 1]?.status_code);
      const current = toCanonicalStatusCode(days[index]?.status_code);
      if (!previous || !current) {
        continue;
      }

      if (previous === "U" && current === "A") {
        pushIssue(
          issues,
          "missing_checkin_turn_day_boundary",
          `${fileName}: direct transition U->A at day#${index}->day#${index + 1} is missing explicit checkin boundary I`,
          "warning",
        );
        continue;
      }

      if (previous === "A" && current === "U") {
        const currentDate = normalizeIsoDate(days[index]?.date);
        const maxDayKey = normalizeIsoDate(
          parsed.normalized_availability?.calendar_bounds?.max_day_key,
        );
        if (currentDate && maxDayKey && currentDate > maxDayKey) {
          continue;
        }
        if (isDec31ToJan1Boundary(days[index - 1] ?? {}, days[index] ?? {})) {
          continue;
        }
        pushIssue(
          issues,
          "missing_checkout_turn_day_boundary",
          `${fileName}: direct transition A->U at day#${index}->day#${index + 1} is missing explicit checkout boundary O`,
          "warning",
        );
        continue;
      }

      if (previous === "U" && current === "X") {
        const next = nextNonXStatus(days, index + 1);
        if (next?.status === "A") {
          pushIssue(
            issues,
            "missing_checkin_turn_day_boundary",
            `${fileName}: transition U->X...->A at day#${index}->day#${next.index + 1} is missing explicit checkin boundary I`,
            "warning",
          );
        }
        continue;
      }

      if (previous === "A" && current === "X") {
        const next = nextNonXStatus(days, index + 1);
        if (next?.status === "U") {
          pushIssue(
            issues,
            "missing_checkout_turn_day_boundary",
            `${fileName}: transition A->X...->U at day#${index}->day#${next.index + 1} is missing explicit checkout boundary O`,
            "warning",
          );
        }
      }
    }
  }

  return {
    adapterKey: options.adapterKey,
    filesScanned: selectedFiles.length,
    filesWithAvailability,
    daysChecked,
    issues,
  };
}

function formatSummaryLine(summary: ValidationSummary): string {
  return [
    `files=${summary.filesScanned}`,
    `availability_files=${summary.filesWithAvailability}`,
    `days_checked=${summary.daysChecked}`,
    `issues=${summary.issues.length}`,
  ].join(" ");
}

export async function runValidateAvailabilityStatusCodesCli(
  argv: string[] = process.argv.slice(2),
): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Availability status validator failed: ${message}`);
    return 1;
  }

  const summary = await validateAdapterAvailabilityStatusCodes(options);
  const errorIssues = summary.issues.filter(
    (issue) => issue.severity === "error",
  );
  const warningIssues = summary.issues.filter(
    (issue) => issue.severity === "warning",
  );

  if (errorIssues.length > 0) {
    console.error(chalk.red("Availability status validator failed."));
    console.error(formatSummaryLine(summary));
    printIssues([...errorIssues, ...warningIssues]);
    return 1;
  }

  if (warningIssues.length > 0) {
    console.log(
      chalk.yellow("Availability status validator passed with warnings."),
    );
    console.log(formatSummaryLine(summary));
    printIssues(warningIssues);
    return 0;
  }

  console.log(chalk.green("Availability status validator passed."));
  console.log(formatSummaryLine(summary));
  return 0;
}
