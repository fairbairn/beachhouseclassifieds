import { Chalk } from "chalk";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  canonicalizeExternalListingId,
  externalListingIdFromDetailUrl,
} from "@/lib/pricing/shared/external-listing-id";

const chalk = new Chalk({ level: 1 });

type CliOptions = {
  adapterKey: string;
  maxListings: number | null;
};

type DetailRecord = {
  external_listing_id?: unknown;
  detail_url?: unknown;
  property_profile?: {
    beds?: unknown;
    baths?: unknown;
    sleeps?: unknown;
  };
  media_gallery?: {
    image_urls?: unknown;
  };
  normalized_availability?: {
    days?: Array<{
      date?: unknown;
      status_code?: unknown;
      booking_day_state?: unknown;
    }>;
  };
  location?: {
    address?: unknown;
    directions_daddr?: unknown;
    latitude?: unknown;
    longitude?: unknown;
  };
  address?: unknown;
  latitude?: unknown;
  longitude?: unknown;
};

type IndexRecord = {
  external_listing_id?: unknown;
  detail_url?: unknown;
};

type ValidationIssueCode =
  | "invalid_json"
  | "invalid_index_json"
  | "missing_index_entry_identifier"
  | "missing_index_entry_json"
  | "missing_external_listing_id"
  | "missing_detail_url"
  | "missing_location_signal"
  | "missing_availability_days"
  | "all_days_unknown"
  | "detail_url_identifier_invalid"
  | "external_id_not_from_detail_url"
  | "json_filename_mismatch"
  | "duplicate_primary_external_id";

type ValidationIssue = {
  code: ValidationIssueCode;
  message: string;
};

type ValidationWarningCode =
  | "missing_lat_lon_with_address"
  | "orphan_artifact"
  | "null_property_profile_capacity"
  | "image_url_pattern_outlier";

type ValidationWarning = {
  code: ValidationWarningCode;
  message: string;
};

function parseArgs(argv: string[]): CliOptions {
  let adapterKey = "360blue";
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

  return { adapterKey, maxListings };
}

function normalizeFileBase(name: string, extension: string): string {
  return name.endsWith(extension) ? name.slice(0, -extension.length) : name;
}

async function listFiles(
  dir: string,
  extension: string,
  excludeNames: Set<string> = new Set(),
): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(extension) &&
        !excludeNames.has(entry.name),
    )
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function printIssues(issues: ValidationIssue[]): void {
  for (const issue of issues.slice(0, 60)) {
    console.error(
      `${chalk.red("-")} ${chalk.yellow(`[${issue.code}]`)} ${issue.message}`,
    );
  }

  if (issues.length > 60) {
    console.error(chalk.yellow(`... ${issues.length - 60} more issue(s)`));
  }
}

function printWarnings(warnings: ValidationWarning[]): void {
  for (const warning of warnings.slice(0, 60)) {
    console.error(
      `${chalk.yellow("-")} ${chalk.yellow(`[${warning.code}]`)} ${warning.message}`,
    );
  }

  if (warnings.length > 60) {
    console.error(chalk.yellow(`... ${warnings.length - 60} more warning(s)`));
  }
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function hasValidLatLon(record: DetailRecord): boolean {
  const latCandidates = [record.latitude, record.location?.latitude]
    .map(toFiniteNumber)
    .filter((value): value is number => value !== null);
  const lonCandidates = [record.longitude, record.location?.longitude]
    .map(toFiniteNumber)
    .filter((value): value is number => value !== null);

  return (
    latCandidates.some((value) => value >= -90 && value <= 90) &&
    lonCandidates.some((value) => value >= -180 && value <= 180)
  );
}

function isCredibleAddress(value: string): boolean {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length < 8 || normalized.length > 220) {
    return false;
  }

  // Exclude non-address labels that commonly appear in UI tags.
  if (normalized.includes("|")) {
    return false;
  }

  const hasLetters = /[a-z]/i.test(normalized);
  if (!hasLetters) {
    return false;
  }

  if (/\d/.test(normalized)) {
    return true;
  }

  if (/,[\s]*[A-Za-z .'-]+,[\s]*[A-Z]{2}\b/.test(normalized)) {
    return true;
  }

  if (
    /\b(?:st|street|rd|road|ave|avenue|blvd|boulevard|ln|lane|dr|drive|way|ct|court|cir|circle|trl|trail|hwy|highway|pkwy|parkway)\b/i.test(
      normalized,
    )
  ) {
    return true;
  }

  return false;
}

function hasCredibleAddress(record: DetailRecord): boolean {
  const candidates = [
    record.location?.address,
    record.location?.directions_daddr,
    record.address,
  ]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => value.length > 0);

  return candidates.some((value) => isCredibleAddress(value));
}

function isNullishNumericField(value: unknown): boolean {
  if (value === null || value === undefined) {
    return true;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "" || normalized === "null" || normalized === "n/a";
  }

  return false;
}

function getImageUrlPatternSignature(value: string): string | null {
  try {
    const parsed = new URL(value);
    const segments = parsed.pathname
      .split("/")
      .filter(Boolean)
      .slice(0, 2)
      .join("/");
    return `${parsed.origin}/${segments}`;
  } catch {
    return null;
  }
}

function getImageUrlPatternOutliers(imageUrls: string[]): {
  baselinePattern: string | null;
  outliers: string[];
} {
  if (imageUrls.length < 2) {
    return { baselinePattern: null, outliers: [] };
  }

  const patternCount = new Map<string, number>();
  const urlPatterns: Array<{ url: string; pattern: string | null }> = [];

  for (const url of imageUrls) {
    const pattern = getImageUrlPatternSignature(url);
    urlPatterns.push({ url, pattern });
    if (!pattern) {
      continue;
    }
    patternCount.set(pattern, (patternCount.get(pattern) ?? 0) + 1);
  }

  if (patternCount.size === 0) {
    return { baselinePattern: null, outliers: [] };
  }

  let baselinePattern: string | null = null;
  let baselineCount = 0;
  for (const [pattern, count] of patternCount.entries()) {
    if (count > baselineCount) {
      baselinePattern = pattern;
      baselineCount = count;
    }
  }

  if (!baselinePattern) {
    return { baselinePattern: null, outliers: [] };
  }

  const outliers = urlPatterns
    .filter((entry) => entry.pattern !== baselinePattern)
    .map((entry) => entry.url);

  return { baselinePattern, outliers };
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function getAvailabilityStats(record: DetailRecord): {
  hasDays: boolean;
  totalDays: number;
  unavailableDays: number;
  unknownDays: number;
} {
  const rawDays = record.normalized_availability?.days;
  if (!Array.isArray(rawDays) || rawDays.length === 0) {
    return { hasDays: false, totalDays: 0, unavailableDays: 0, unknownDays: 0 };
  }

  const validDays = rawDays.filter((day) => {
    if (!day || typeof day !== "object") {
      return false;
    }

    const dateValue = typeof day.date === "string" ? day.date.trim() : "";
    return dateValue.length > 0 && isIsoDate(dateValue);
  });

  if (validDays.length === 0) {
    return { hasDays: false, totalDays: 0, unavailableDays: 0, unknownDays: 0 };
  }

  const unavailableDays = validDays.filter((day) => {
    const statusCode =
      typeof day.status_code === "string"
        ? day.status_code.trim().toUpperCase()
        : "";
    const bookingState =
      typeof day.booking_day_state === "string"
        ? day.booking_day_state.trim().toLowerCase()
        : "";

    return statusCode === "U" || bookingState === "blocked";
  }).length;

  const unknownDays = validDays.filter((day) => {
    const statusCode =
      typeof day.status_code === "string"
        ? day.status_code.trim().toUpperCase()
        : "";
    const bookingState =
      typeof day.booking_day_state === "string"
        ? day.booking_day_state.trim().toLowerCase()
        : "";

    return statusCode === "X" || bookingState === "unknown";
  }).length;

  return {
    hasDays: true,
    totalDays: validDays.length,
    unavailableDays,
    unknownDays,
  };
}

function externalIdMatchesDetailIdentifier(
  canonicalExternalId: string,
  detailIdentifier: string,
): boolean {
  if (canonicalExternalId === detailIdentifier) {
    return true;
  }

  // Some providers encode canonical IDs as slug-id while detail URLs expose
  // only the numeric identifier.
  return canonicalExternalId.endsWith(`-${detailIdentifier}`);
}

export async function runValidateScrapeFilenameAlignmentCli(
  argv: string[] = process.argv.slice(2),
): Promise<number> {
  const options = parseArgs(argv);
  const root = process.cwd();
  const detailsRoot = resolve(
    root,
    "src",
    "lib",
    "data",
    "external-sources",
    options.adapterKey,
    "details",
  );

  const jsonDir = resolve(detailsRoot, "json");
  const htmlDir = resolve(detailsRoot, "html");
  const quotesDir = resolve(detailsRoot, "quotes");
  const pricingDir = resolve(detailsRoot, "pricing");

  const issues: ValidationIssue[] = [];
  const warnings: ValidationWarning[] = [];

  let jsonFiles: string[];
  try {
    jsonFiles = await listFiles(jsonDir, ".json", new Set(["index.json"]));
  } catch {
    console.error(
      `Missing details/json directory for adapter=${options.adapterKey}. Expected: ${jsonDir}`,
    );
    return 1;
  }

  if (jsonFiles.length === 0) {
    console.error(
      `No primary extraction files found for adapter=${options.adapterKey} under details/json.`,
    );
    return 1;
  }

  const jsonFileByCanonicalId = new Map<string, string>();
  for (const fileName of jsonFiles) {
    const fileBase = normalizeFileBase(fileName, ".json");
    const canonicalFileBase = canonicalizeExternalListingId(fileBase);
    if (!jsonFileByCanonicalId.has(canonicalFileBase)) {
      jsonFileByCanonicalId.set(canonicalFileBase, fileName);
    }
  }

  const indexPath = resolve(detailsRoot, "index.json");
  let indexRecords: IndexRecord[];
  try {
    const raw = await readFile(indexPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      issues.push({
        code: "invalid_index_json",
        message: `details/index.json must be a JSON array for adapter=${options.adapterKey}`,
      });
      indexRecords = [];
    } else {
      indexRecords = parsed as IndexRecord[];
    }
  } catch (error: unknown) {
    issues.push({
      code: "invalid_index_json",
      message:
        `Unable to read details/index.json for adapter=${options.adapterKey} ` +
        `(${error instanceof Error ? error.message : String(error)})`,
    });
    indexRecords = [];
  }

  if (indexRecords.length === 0) {
    console.error(
      `No canonical index entries found for adapter=${options.adapterKey} under details/index.json.`,
    );
    if (issues.length > 0) {
      printIssues(issues);
    }
    return 1;
  }

  const selectedIndexRecords =
    options.maxListings === null
      ? indexRecords
      : indexRecords.slice(0, options.maxListings);

  const primaryIds = new Set<string>();
  const primaryIdToFile = new Map<string, string>();

  for (const indexRecord of selectedIndexRecords) {
    const indexExternalId =
      typeof indexRecord.external_listing_id === "string"
        ? indexRecord.external_listing_id.trim()
        : "";
    const indexDetailUrl =
      typeof indexRecord.detail_url === "string"
        ? indexRecord.detail_url.trim()
        : "";

    const canonicalIndexExternalId = indexExternalId
      ? canonicalizeExternalListingId(indexExternalId)
      : "";
    const canonicalFromDetailUrl = indexDetailUrl
      ? externalListingIdFromDetailUrl(indexDetailUrl)
      : "";
    const canonicalIndexId = canonicalIndexExternalId || canonicalFromDetailUrl;

    if (!canonicalIndexId) {
      issues.push({
        code: "missing_index_entry_identifier",
        message:
          `details/index.json entry is missing both usable external_listing_id ` +
          `and detail_url identifier (external_listing_id='${indexExternalId}', detail_url='${indexDetailUrl}')`,
      });
      continue;
    }

    const fileName = jsonFileByCanonicalId.get(canonicalIndexId);
    if (!fileName) {
      issues.push({
        code: "missing_index_entry_json",
        message:
          `details/index.json references external_listing_id='${canonicalIndexId}' ` +
          `but details/json/${canonicalIndexId}.json was not found`,
      });
      primaryIds.add(canonicalIndexId);
      continue;
    }

    const filePath = resolve(jsonDir, fileName);
    const fileBase = normalizeFileBase(fileName, ".json");

    let parsed: DetailRecord;
    try {
      parsed = JSON.parse(await readFile(filePath, "utf8")) as DetailRecord;
    } catch (error: unknown) {
      issues.push({
        code: "invalid_json",
        message: `details/json/${fileName} is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
      });
      continue;
    }

    const externalListingId =
      typeof parsed.external_listing_id === "string"
        ? parsed.external_listing_id.trim()
        : "";
    const detailUrl =
      typeof parsed.detail_url === "string" ? parsed.detail_url.trim() : "";

    if (!externalListingId) {
      issues.push({
        code: "missing_external_listing_id",
        message: `details/json/${fileName} is missing external_listing_id`,
      });
      continue;
    }

    if (!detailUrl) {
      issues.push({
        code: "missing_detail_url",
        message: `details/json/${fileName} is missing detail_url`,
      });
      continue;
    }

    const hasLatLon = hasValidLatLon(parsed);
    const hasAddress = hasCredibleAddress(parsed);

    if (!hasLatLon && hasAddress) {
      warnings.push({
        code: "missing_lat_lon_with_address",
        message:
          `details/json/${fileName} is missing latitude/longitude but has ` +
          `a credible address; investigate adapter-specific coordinate extraction`,
      });
    }

    if (!hasLatLon && !hasAddress) {
      issues.push({
        code: "missing_location_signal",
        message:
          `details/json/${fileName} must include valid latitude/longitude ` +
          `or a credible address fallback`,
      });
    }

    const profile = parsed.property_profile;
    const profileBeds = profile?.beds;
    const profileBaths = profile?.baths;
    const profileSleeps = profile?.sleeps;
    if (
      isNullishNumericField(profileBeds) &&
      isNullishNumericField(profileBaths) &&
      isNullishNumericField(profileSleeps)
    ) {
      warnings.push({
        code: "null_property_profile_capacity",
        message:
          `details/json/${fileName} has property_profile beds/baths/sleeps all nullish; ` +
          `verify adapter extraction for occupancy and bed/bath summary`,
      });
    }

    const imageUrlsRaw = parsed.media_gallery?.image_urls;
    if (Array.isArray(imageUrlsRaw)) {
      const imageUrls = imageUrlsRaw
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean);
      const patternCheck = getImageUrlPatternOutliers(imageUrls);
      if (patternCheck.outliers.length > 0 && patternCheck.baselinePattern) {
        const sample = patternCheck.outliers.slice(0, 3).join(", ");
        warnings.push({
          code: "image_url_pattern_outlier",
          message:
            `details/json/${fileName} has ${patternCheck.outliers.length} image_urls ` +
            `outside baseline pattern '${patternCheck.baselinePattern}'` +
            (sample ? ` (sample: ${sample})` : ""),
        });
      }
    }

    const availability = getAvailabilityStats(parsed);
    if (!availability.hasDays) {
      issues.push({
        code: "missing_availability_days",
        message:
          `details/json/${fileName} must include normalized_availability.days ` +
          `with valid ISO dates`,
      });
    } else if (availability.unknownDays === availability.totalDays) {
      issues.push({
        code: "all_days_unknown",
        message:
          `details/json/${fileName} availability is 100% unknown/X ` +
          `(${availability.unknownDays}/${availability.totalDays} days), ` +
          `which indicates a likely calendar scrape failure`,
      });
    }

    const expectedFromDetailUrl = externalListingIdFromDetailUrl(detailUrl);
    if (!expectedFromDetailUrl) {
      issues.push({
        code: "detail_url_identifier_invalid",
        message: `details/json/${fileName} has detail_url without a usable identifier (${detailUrl})`,
      });
      continue;
    }

    const canonicalExternalListingId =
      canonicalizeExternalListingId(externalListingId);
    const canonicalFileBase = canonicalizeExternalListingId(fileBase);

    if (
      !externalIdMatchesDetailIdentifier(
        canonicalExternalListingId,
        expectedFromDetailUrl,
      )
    ) {
      issues.push({
        code: "external_id_not_from_detail_url",
        message: `details/json/${fileName} external_listing_id='${externalListingId}' canonical='${canonicalExternalListingId}' but detail_url canonical identifier='${expectedFromDetailUrl}'`,
      });
    }

    if (canonicalFileBase !== canonicalExternalListingId) {
      issues.push({
        code: "json_filename_mismatch",
        message: `details/json/${fileName} filename id='${fileBase}' canonical='${canonicalFileBase}' but external_listing_id='${externalListingId}' canonical='${canonicalExternalListingId}'`,
      });
    }

    const existing = primaryIdToFile.get(canonicalExternalListingId);
    if (existing && existing !== fileName) {
      issues.push({
        code: "duplicate_primary_external_id",
        message: `duplicate canonical external_listing_id='${canonicalExternalListingId}' in details/json/${existing} and details/json/${fileName}`,
      });
    } else {
      primaryIdToFile.set(canonicalExternalListingId, fileName);
    }

    primaryIds.add(canonicalIndexId);
  }

  const artifactChecks: Array<{
    dir: string;
    ext: string;
    label: string;
    exclude?: Set<string>;
  }> = [
    { dir: htmlDir, ext: ".html", label: "html" },
    {
      dir: jsonDir,
      ext: ".json",
      label: "json",
      exclude: new Set(["index.json"]),
    },
    { dir: quotesDir, ext: ".json", label: "quotes" },
    {
      dir: pricingDir,
      ext: ".json",
      label: "pricing",
      exclude: new Set(["index.json"]),
    },
  ];

  for (const artifact of artifactChecks) {
    let files: string[];
    try {
      files = await listFiles(artifact.dir, artifact.ext, artifact.exclude);
    } catch {
      // Some phases generate only a subset of artifacts (e.g. scrape without quote/pricing).
      // Missing directories are treated as "not generated yet", not a contract violation.
      continue;
    }

    for (const fileName of files) {
      const fileBase = normalizeFileBase(fileName, artifact.ext);
      const canonicalFileBase = canonicalizeExternalListingId(fileBase);
      if (!primaryIds.has(canonicalFileBase)) {
        warnings.push({
          code: "orphan_artifact",
          message: `details/${artifact.label}/${fileName} has no matching canonical index external_listing_id`,
        });
      }
    }
  }

  if (issues.length > 0) {
    console.error(
      chalk.red(
        `Scrape filename validator failed for adapter=${options.adapterKey} primary_checked=${selectedIndexRecords.length} issues=${issues.length} warnings=${warnings.length}`,
      ),
    );
    printIssues(issues);
    if (warnings.length > 0) {
      console.error(chalk.yellow("Warnings:"));
      printWarnings(warnings);
    }
    return 1;
  }

  console.log(
    chalk.green(
      `Scrape filename validator passed for adapter=${options.adapterKey} primary_checked=${selectedIndexRecords.length} issues=0 warnings=${warnings.length}`,
    ),
  );
  if (warnings.length > 0) {
    printWarnings(warnings);
  }
  return 0;
}

let exiting = false;
process.on("SIGINT", () => {
  if (exiting) {
    process.exit(130);
  }
  exiting = true;
  process.stderr.write("Operation cancelled by user.\n");
  process.exit(130);
});

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runValidateScrapeFilenameAlignmentCli()
    .then((code) => {
      process.exit(code);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Scrape filename validator failed: ${message}\n`);
      process.exit(1);
    });
}
