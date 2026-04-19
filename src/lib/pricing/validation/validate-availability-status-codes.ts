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
  status_code?: unknown;
  is_available_for_checkin?: unknown;
  is_available_for_checkout?: unknown;
  is_checkin_allowed?: unknown;
  is_checkout_allowed?: unknown;
};

type DetailRecord = {
  normalized_availability?: {
    days?: AvailabilityDayRecord[];
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
  | "missing_status_code"
  | "non_canonical_status_code"
  | "missing_checkin_boolean"
  | "missing_checkout_boolean"
  | "missing_turn_day_status";

type ValidationIssue = {
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

function pushIssue(
  issues: ValidationIssue[],
  code: ValidationIssueCode,
  message: string,
): void {
  issues.push({ code, message });
}

function printIssues(issues: ValidationIssue[]): void {
  for (const issue of issues.slice(0, 80)) {
    console.error(
      `${chalk.red("-")} ${chalk.yellow(`[${issue.code}]`)} ${issue.message}`,
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
        "missing_normalized_availability_days",
        `${fileName}: normalized_availability.days is missing or empty`,
      );
      continue;
    }

    filesWithAvailability += 1;
    let hasTurnDayHint = false;
    let hasTurnDayStatus = false;

    for (let index = 0; index < days.length; index += 1) {
      const day = days[index] ?? {};
      const label = `${fileName} day#${index + 1}`;
      const canonicalStatus = toCanonicalStatusCode(day.status_code);

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

    const ratesDays = parsed.normalized_rates?.days;
    if (Array.isArray(ratesDays)) {
      for (const rateDay of ratesDays) {
        const code = normalizeChangeoverCode(rateDay?.changeover_code);
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

  if (summary.issues.length > 0) {
    console.error(chalk.red("Availability status validator failed."));
    console.error(formatSummaryLine(summary));
    printIssues(summary.issues);
    return 1;
  }

  console.log(chalk.green("Availability status validator passed."));
  console.log(formatSummaryLine(summary));
  return 0;
}
