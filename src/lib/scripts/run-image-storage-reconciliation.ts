import "@/core/tooling/env/load-env-profile";

import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import chalk from "chalk";
import Table from "cli-table3";
import { Pool } from "pg";

type CliOptions = {
  sampleLimit: number;
  prefixDepth: number;
  prefixLimit: number;
  format: "pretty" | "json" | "both";
};

type ListingSourceImageRow = {
  id: string;
  status: string;
  site_image: string | null;
  error_payload: unknown;
};

type StatusBucket = {
  rows: number;
  without_site_image: number;
  with_site_image: number;
  with_site_image_present_on_s3: number;
  with_site_image_missing_on_s3: number;
};

type ReconciliationReport = {
  generated_at: string;
  options: CliOptions;
  bucket: {
    name: string;
    endpoint: string;
    file_count: number;
    total_file_bytes: number;
    total_file_gib: number;
  };
  db: {
    row_count: number;
    rows_with_non_empty_site_image: number;
    unique_non_empty_site_image_keys: number;
  };
  reconciliation: {
    definitive_completion_gap_count: number;
    processed_site_rows: number;
    processed_site_present_on_s3_rows: number;
    processed_site_missing_on_s3_rows: number;
    processed_site_without_site_image_rows: number;
    processed_site_with_stored_status_not_uploaded_rows: number;
    non_processed_rows: number;
    non_processed_rows_with_present_s3_object: number;
    matched_unique_db_keys_on_s3: number;
    missing_unique_db_keys_on_s3: number;
    unreferenced_s3_files_not_in_db: number;
    referenced_s3_file_bytes: number;
    referenced_s3_file_gib: number;
    unreferenced_s3_file_bytes: number;
    unreferenced_s3_file_gib: number;
  };
  status_matrix: Record<string, StatusBucket>;
  grouped_prefixes: {
    missing_db_keys_on_s3: Array<{ prefix: string; count: number }>;
    unreferenced_s3_keys: Array<{ prefix: string; count: number }>;
  };
  samples: {
    processed_site_missing_s3_rows: Array<{
      id: string;
      status: string;
      site_image_key: string;
      stored_status_on_s3: string | null;
    }>;
    processed_site_missing_site_image_rows: Array<{
      id: string;
      status: string;
    }>;
    non_processed_but_present_s3_rows: Array<{
      id: string;
      status: string;
      site_image_key: string;
      stored_status_on_s3: string | null;
    }>;
    missing_unique_db_keys_on_s3: string[];
    unreferenced_s3_keys_not_in_db: string[];
    duplicated_db_site_image_keys: Array<{ key: string; row_count: number }>;
  };
};

function usage(): string {
  return [
    "Usage:",
    "  npm run images:storage:reconcile -- [--format pretty|json|both] [--sample-limit <n>] [--prefix-depth <n>] [--prefix-limit <n>]",
    "",
    "Options:",
    "  --format <mode>     Output mode: pretty, json, both (default pretty)",
    "  --sample-limit <n>  Number of mismatch samples to print (default 25)",
    "  --prefix-depth <n>  Prefix depth for grouped key counts (default 2)",
    "  --prefix-limit <n>  Max grouped prefixes returned (default 25)",
  ].join("\n");
}

function parsePositiveInt(
  rawValue: string | undefined,
  fallback: number,
): number {
  const parsed = Number.parseInt(String(rawValue || "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseArgs(argv: string[]): CliOptions {
  const values = new Map<string, string>();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      continue;
    }

    if (token === "--help" || token === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }

    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      values.set(key, next);
      i += 1;
      continue;
    }
  }

  const formatRaw = (values.get("format") || "pretty").trim().toLowerCase();
  const format =
    formatRaw === "json" || formatRaw === "both" || formatRaw === "pretty"
      ? formatRaw
      : "pretty";

  return {
    sampleLimit: parsePositiveInt(values.get("sample-limit"), 25),
    prefixDepth: parsePositiveInt(values.get("prefix-depth"), 2),
    prefixLimit: parsePositiveInt(values.get("prefix-limit"), 25),
    format,
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim() || "";
  if (!value) {
    throw new Error(`Missing ${name} in environment`);
  }
  return value;
}

function optionalEnv(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : fallback;
}

function normalizeSiteImageKey(siteImage: string, bucket: string): string {
  const raw = String(siteImage || "").trim();
  if (!raw) {
    return "";
  }

  let key = raw;
  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    try {
      const url = new URL(raw);
      key = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    } catch {
      key = raw;
    }
  }

  if (key.startsWith(`${bucket}/`)) {
    key = key.slice(bucket.length + 1);
  }

  return key;
}

function topPrefixCounts(
  keys: string[],
  depth: number,
  limit: number,
): Array<{ prefix: string; count: number }> {
  const counts = new Map<string, number>();
  for (const key of keys) {
    const parts = String(key)
      .split("/")
      .filter((part) => part.length > 0);
    const prefix = parts.slice(0, depth).join("/") || "<root>";
    counts.set(prefix, (counts.get(prefix) || 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([prefix, count]) => ({ prefix, count }));
}

function toGiB(bytes: number): number {
  return Number((bytes / (1024 * 1024 * 1024)).toFixed(3));
}

function storedStatusFromPayload(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const objectValue = value as Record<string, unknown>;
  const candidate = objectValue.stored_status_on_s3;
  if (typeof candidate === "string" && candidate.trim().length > 0) {
    return candidate.trim();
  }

  return null;
}

async function listAllBucketFiles(
  s3: S3Client,
  bucket: string,
): Promise<Array<{ key: string; size: number }>> {
  const results: Array<{ key: string; size: number }> = [];
  let continuationToken: string | undefined;

  while (true) {
    const response = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      }),
    );

    for (const object of response.Contents || []) {
      const key = String(object.Key || "");
      if (!key || key.endsWith("/")) {
        continue;
      }
      results.push({ key, size: Number(object.Size || 0) });
    }

    if (!response.IsTruncated) {
      break;
    }

    continuationToken = response.NextContinuationToken;
  }

  return results;
}

function printPretty(report: ReconciliationReport): void {
  const rec = report.reconciliation;
  const hasDefinitiveGap = rec.definitive_completion_gap_count > 0;

  process.stdout.write(
    `\n${chalk.bold.cyan("Image Storage Reconciliation")}\n`,
  );
  process.stdout.write(`${chalk.gray(`Generated: ${report.generated_at}`)}\n`);
  process.stdout.write(`${chalk.gray(`Bucket: ${report.bucket.name}`)}\n\n`);

  const summaryTable = new Table({
    head: [chalk.bold("Signal"), chalk.bold("Value")],
    style: { head: [], border: [] },
  });
  summaryTable.push(
    [
      "Definitive completion",
      hasDefinitiveGap ? chalk.red("FAIL") : chalk.green("PASS"),
    ],
    ["processed_site gaps", String(rec.definitive_completion_gap_count)],
    ["bucket files", String(report.bucket.file_count)],
    ["bucket size (GiB)", String(report.bucket.total_file_gib)],
    ["db rows", String(report.db.row_count)],
    [
      "db unique image keys",
      String(report.db.unique_non_empty_site_image_keys),
    ],
  );
  process.stdout.write(`${summaryTable.toString()}\n\n`);

  const mismatchTable = new Table({
    head: [chalk.bold("Mismatch Type"), chalk.bold("Count")],
    style: { head: [], border: [] },
  });
  mismatchTable.push(
    [
      "processed_site missing on S3",
      chalk.red(String(rec.processed_site_missing_on_s3_rows)),
    ],
    [
      "processed_site missing site_image",
      chalk.red(String(rec.processed_site_without_site_image_rows)),
    ],
    [
      "processed_site stored_status != uploaded",
      chalk.yellow(
        String(rec.processed_site_with_stored_status_not_uploaded_rows),
      ),
    ],
    [
      "non-processed rows with present S3 object",
      chalk.yellow(String(rec.non_processed_rows_with_present_s3_object)),
    ],
    [
      "missing unique DB keys on S3",
      chalk.red(String(rec.missing_unique_db_keys_on_s3)),
    ],
    [
      "unreferenced S3 files not in DB",
      chalk.yellow(String(rec.unreferenced_s3_files_not_in_db)),
    ],
  );
  process.stdout.write(`${mismatchTable.toString()}\n\n`);

  const sortedStatuses = Object.entries(report.status_matrix).sort(
    (a, b) => b[1].rows - a[1].rows,
  );

  const statusTable = new Table({
    head: [
      chalk.bold("Status"),
      chalk.bold("Rows"),
      chalk.bold("With Key"),
      chalk.bold("Present on S3"),
      chalk.bold("Missing on S3"),
      chalk.bold("Without Key"),
    ],
    style: { head: [], border: [] },
  });
  for (const [status, bucket] of sortedStatuses.slice(0, 12)) {
    const missing = bucket.with_site_image_missing_on_s3;
    statusTable.push([
      chalk.cyan(status),
      String(bucket.rows),
      String(bucket.with_site_image),
      String(bucket.with_site_image_present_on_s3),
      missing > 0 ? chalk.red(String(missing)) : chalk.green(String(missing)),
      String(bucket.without_site_image),
    ]);
  }
  process.stdout.write(`${statusTable.toString()}\n`);

  const sampleRows = report.samples.processed_site_missing_s3_rows;
  if (sampleRows.length > 0) {
    const sampleTable = new Table({
      head: [
        chalk.bold("id"),
        chalk.bold("site_image_key"),
        chalk.bold("stored_status_on_s3"),
      ],
      style: { head: [], border: [] },
    });
    for (const row of sampleRows.slice(0, 10)) {
      sampleTable.push([
        row.id,
        row.site_image_key,
        row.stored_status_on_s3 || "null",
      ]);
    }
    process.stdout.write(
      `\n${chalk.bold.red("processed_site rows missing on S3 (sample)")}\n`,
    );
    process.stdout.write(`${sampleTable.toString()}\n`);
  }

  const misplacedRows = report.samples.non_processed_but_present_s3_rows;
  if (misplacedRows.length > 0) {
    const nonProcessedTable = new Table({
      head: [
        chalk.bold("id"),
        chalk.bold("status"),
        chalk.bold("site_image_key"),
      ],
      style: { head: [], border: [] },
    });
    for (const row of misplacedRows.slice(0, 10)) {
      nonProcessedTable.push([row.id, row.status, row.site_image_key]);
    }
    process.stdout.write(
      `\n${chalk.bold.yellow("non-processed rows with present S3 object (sample)")}\n`,
    );
    process.stdout.write(`${nonProcessedTable.toString()}\n`);
  }

  process.stdout.write("\n");
}

async function buildReport(options: CliOptions): Promise<ReconciliationReport> {
  const bucket = optionalEnv("BUNNY_STORAGE_BUCKET", "beach");
  const endpoint = optionalEnv(
    "BUNNY_STORAGE_ENDPOINT",
    "https://ny-s3.storage.bunnycdn.com",
  );
  const region = optionalEnv("BUNNY_STORAGE_REGION", "ny");
  const accessKeyId = optionalEnv("BUNNY_STORAGE_ACCESS_KEY_ID", "beach");
  const secretAccessKey = requiredEnv("BUNNY_STORAGE_SECRET_ACCESS_KEY");
  const databaseUrl = requiredEnv("DATABASE_URL");

  const s3 = new S3Client({
    endpoint,
    region,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });

  const pool = new Pool({ connectionString: databaseUrl, max: 3 });

  try {
    const bucketFiles = await listAllBucketFiles(s3, bucket);
    const bucketKeySet = new Set(bucketFiles.map((entry) => entry.key));

    const rowResult = await pool.query<ListingSourceImageRow>(`
      select id, status, site_image, error_payload
      from listing_source_image
    `);
    const rows = rowResult.rows;

    const statusMatrix: Record<string, StatusBucket> = {};

    const dbAllKeys: string[] = [];
    const processedSiteMissingObjectRows: ReconciliationReport["samples"]["processed_site_missing_s3_rows"] =
      [];
    const processedSiteMissingKeyRows: ReconciliationReport["samples"]["processed_site_missing_site_image_rows"] =
      [];
    const nonProcessedButPresentRows: ReconciliationReport["samples"]["non_processed_but_present_s3_rows"] =
      [];

    let processedSiteRows = 0;
    let processedSitePresentOnS3Rows = 0;
    let processedSiteMissingOnS3Rows = 0;
    let processedSiteWithoutKeyRows = 0;
    let processedSiteStoredStatusNotUploadedRows = 0;

    let nonProcessedRows = 0;
    let nonProcessedWithPresentKeyRows = 0;

    for (const row of rows) {
      const status = String(row.status || "unknown");
      const normalizedKey = normalizeSiteImageKey(
        String(row.site_image || ""),
        bucket,
      );
      const hasSiteImageKey = normalizedKey.length > 0;
      const existsOnS3 = hasSiteImageKey
        ? bucketKeySet.has(normalizedKey)
        : false;
      const storedStatus = storedStatusFromPayload(row.error_payload);

      if (!statusMatrix[status]) {
        statusMatrix[status] = {
          rows: 0,
          without_site_image: 0,
          with_site_image: 0,
          with_site_image_present_on_s3: 0,
          with_site_image_missing_on_s3: 0,
        };
      }

      const statusBucket = statusMatrix[status];
      statusBucket.rows += 1;

      if (!hasSiteImageKey) {
        statusBucket.without_site_image += 1;
      } else {
        statusBucket.with_site_image += 1;
        dbAllKeys.push(normalizedKey);
        if (existsOnS3) {
          statusBucket.with_site_image_present_on_s3 += 1;
        } else {
          statusBucket.with_site_image_missing_on_s3 += 1;
        }
      }

      if (status === "processed_site") {
        processedSiteRows += 1;

        if (storedStatus && storedStatus !== "uploaded") {
          processedSiteStoredStatusNotUploadedRows += 1;
        }

        if (!hasSiteImageKey) {
          processedSiteWithoutKeyRows += 1;
          processedSiteMissingKeyRows.push({ id: String(row.id), status });
          continue;
        }

        if (existsOnS3) {
          processedSitePresentOnS3Rows += 1;
        } else {
          processedSiteMissingOnS3Rows += 1;
          processedSiteMissingObjectRows.push({
            id: String(row.id),
            status,
            site_image_key: normalizedKey,
            stored_status_on_s3: storedStatus,
          });
        }
        continue;
      }

      nonProcessedRows += 1;
      if (hasSiteImageKey && existsOnS3) {
        nonProcessedWithPresentKeyRows += 1;
        nonProcessedButPresentRows.push({
          id: String(row.id),
          status,
          site_image_key: normalizedKey,
          stored_status_on_s3: storedStatus,
        });
      }
    }

    const dbUniqueKeys = [...new Set(dbAllKeys)];
    const dbUniqueKeySet = new Set(dbUniqueKeys);

    const missingDbUniqueKeysOnS3 = dbUniqueKeys.filter(
      (key) => !bucketKeySet.has(key),
    );
    const unreferencedS3Keys = bucketFiles
      .filter((entry) => !dbUniqueKeySet.has(entry.key))
      .map((entry) => entry.key);

    const referencedS3Bytes = bucketFiles
      .filter((entry) => dbUniqueKeySet.has(entry.key))
      .reduce((sum, entry) => sum + entry.size, 0);
    const unreferencedS3Bytes = bucketFiles
      .filter((entry) => !dbUniqueKeySet.has(entry.key))
      .reduce((sum, entry) => sum + entry.size, 0);

    const duplicatedDbKeys = Object.entries(
      dbAllKeys.reduce<Record<string, number>>((acc, key) => {
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {}),
    )
      .filter(([, count]) => count > 1)
      .sort((a, b) => b[1] - a[1])
      .slice(0, options.sampleLimit)
      .map(([key, row_count]) => ({ key, row_count }));

    return {
      generated_at: new Date().toISOString(),
      options,
      bucket: {
        name: bucket,
        endpoint,
        file_count: bucketFiles.length,
        total_file_bytes: referencedS3Bytes + unreferencedS3Bytes,
        total_file_gib: toGiB(referencedS3Bytes + unreferencedS3Bytes),
      },
      db: {
        row_count: rows.length,
        rows_with_non_empty_site_image: dbAllKeys.length,
        unique_non_empty_site_image_keys: dbUniqueKeys.length,
      },
      reconciliation: {
        definitive_completion_gap_count:
          processedSiteMissingOnS3Rows + processedSiteWithoutKeyRows,
        processed_site_rows: processedSiteRows,
        processed_site_present_on_s3_rows: processedSitePresentOnS3Rows,
        processed_site_missing_on_s3_rows: processedSiteMissingOnS3Rows,
        processed_site_without_site_image_rows: processedSiteWithoutKeyRows,
        processed_site_with_stored_status_not_uploaded_rows:
          processedSiteStoredStatusNotUploadedRows,
        non_processed_rows: nonProcessedRows,
        non_processed_rows_with_present_s3_object:
          nonProcessedWithPresentKeyRows,
        matched_unique_db_keys_on_s3:
          dbUniqueKeys.length - missingDbUniqueKeysOnS3.length,
        missing_unique_db_keys_on_s3: missingDbUniqueKeysOnS3.length,
        unreferenced_s3_files_not_in_db: unreferencedS3Keys.length,
        referenced_s3_file_bytes: referencedS3Bytes,
        referenced_s3_file_gib: toGiB(referencedS3Bytes),
        unreferenced_s3_file_bytes: unreferencedS3Bytes,
        unreferenced_s3_file_gib: toGiB(unreferencedS3Bytes),
      },
      status_matrix: statusMatrix,
      grouped_prefixes: {
        missing_db_keys_on_s3: topPrefixCounts(
          missingDbUniqueKeysOnS3,
          options.prefixDepth,
          options.prefixLimit,
        ),
        unreferenced_s3_keys: topPrefixCounts(
          unreferencedS3Keys,
          options.prefixDepth,
          options.prefixLimit,
        ),
      },
      samples: {
        processed_site_missing_s3_rows: processedSiteMissingObjectRows.slice(
          0,
          options.sampleLimit,
        ),
        processed_site_missing_site_image_rows:
          processedSiteMissingKeyRows.slice(0, options.sampleLimit),
        non_processed_but_present_s3_rows: nonProcessedButPresentRows.slice(
          0,
          options.sampleLimit,
        ),
        missing_unique_db_keys_on_s3: missingDbUniqueKeysOnS3.slice(
          0,
          options.sampleLimit,
        ),
        unreferenced_s3_keys_not_in_db: unreferencedS3Keys.slice(
          0,
          options.sampleLimit,
        ),
        duplicated_db_site_image_keys: duplicatedDbKeys,
      },
    };
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const report = await buildReport(options);

  if (options.format === "pretty" || options.format === "both") {
    printPretty(report);
  }
  if (options.format === "json" || options.format === "both") {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `${chalk.red("image storage reconciliation failed")}: ${message}\n`,
  );
  process.exit(1);
});
