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
};

type ValidationIssueCode =
  | "invalid_json"
  | "missing_external_listing_id"
  | "missing_detail_url"
  | "detail_url_identifier_invalid"
  | "external_id_not_from_detail_url"
  | "json_filename_mismatch"
  | "duplicate_primary_external_id"
  | "orphan_artifact";

type ValidationIssue = {
  code: ValidationIssueCode;
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

  let primaryFiles: string[];
  try {
    primaryFiles = await listFiles(jsonDir, ".json", new Set(["index.json"]));
  } catch {
    console.error(
      `Missing details/json directory for adapter=${options.adapterKey}. Expected: ${jsonDir}`,
    );
    return 1;
  }

  if (primaryFiles.length === 0) {
    console.error(
      `No primary extraction files found for adapter=${options.adapterKey} under details/json.`,
    );
    return 1;
  }

  const selectedPrimaryFiles =
    options.maxListings === null
      ? primaryFiles
      : primaryFiles.slice(0, options.maxListings);

  const primaryIds = new Set<string>();
  const primaryIdToFile = new Map<string, string>();

  for (const fileName of selectedPrimaryFiles) {
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

    if (canonicalExternalListingId !== expectedFromDetailUrl) {
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

    primaryIds.add(canonicalExternalListingId);
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
        issues.push({
          code: "orphan_artifact",
          message: `details/${artifact.label}/${fileName} has no matching primary extraction external_listing_id`,
        });
      }
    }
  }

  if (issues.length > 0) {
    console.error(
      chalk.red(
        `Scrape filename validator failed for adapter=${options.adapterKey} primary_checked=${selectedPrimaryFiles.length} issues=${issues.length}`,
      ),
    );
    printIssues(issues);
    return 1;
  }

  console.log(
    chalk.green(
      `Scrape filename validator passed for adapter=${options.adapterKey} primary_checked=${selectedPrimaryFiles.length} issues=0`,
    ),
  );
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
