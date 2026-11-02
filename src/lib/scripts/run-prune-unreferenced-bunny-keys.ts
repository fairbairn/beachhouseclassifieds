import "@/core/tooling/env/load-env-profile";

import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { Pool } from "pg";

type CliOptions = {
  apply: boolean;
  sampleLimit: number;
};

type BucketObject = {
  key: string;
  size: number;
};

type DeletionStats = {
  deletedCount: number;
  errorCount: number;
};

function usage(): string {
  return [
    "Usage:",
    "  npm run images:storage:prune-unreferenced -- [--apply] [--sample-limit <n>]",
    "",
    "Options:",
    "  --apply             Delete unreferenced Bunny S3 files (default is dry-run)",
    "  --sample-limit <n>  Number of sample keys to print (default 20)",
  ].join("\n");
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value || "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseArgs(argv: string[]): CliOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      values.set(key, next);
      i += 1;
      continue;
    }

    flags.add(key);
  }

  return {
    apply: flags.has("apply"),
    sampleLimit: parsePositiveInt(values.get("sample-limit"), 20),
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
  const raw = siteImage.trim();
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

async function listAllBucketFiles(
  s3: S3Client,
  bucket: string,
): Promise<BucketObject[]> {
  const results: BucketObject[] = [];
  let continuationToken: string | undefined;

  while (true) {
    const response = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      }),
    );

    for (const object of response.Contents ?? []) {
      const key = String(object.Key || "");
      if (!key || key.endsWith("/")) {
        continue;
      }

      results.push({
        key,
        size: Number(object.Size || 0),
      });
    }

    if (!response.IsTruncated) {
      break;
    }

    continuationToken = response.NextContinuationToken;
  }

  return results;
}

async function fetchReferencedKeySet(
  pool: Pool,
  bucket: string,
): Promise<Set<string>> {
  const query = `
    select site_image
    from listing_source_image
    where site_image is not null
      and btrim(site_image) <> ''
  `;

  const { rows } = await pool.query<{ site_image: string }>(query);
  const keys = rows
    .map((row) => normalizeSiteImageKey(String(row.site_image || ""), bucket))
    .filter(Boolean);

  return new Set(keys);
}

async function deleteKeys(
  s3: S3Client,
  bucket: string,
  keys: string[],
): Promise<DeletionStats> {
  const batchSize = 1000;
  let deletedCount = 0;
  let errorCount = 0;

  for (let i = 0; i < keys.length; i += batchSize) {
    const chunk = keys.slice(i, i + batchSize);
    const response = await s3.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: {
          Objects: chunk.map((key) => ({ Key: key })),
          Quiet: false,
        },
      }),
    );

    deletedCount += (response.Deleted || []).length;
    errorCount += (response.Errors || []).length;
  }

  return { deletedCount, errorCount };
}

async function run(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));

  const secretAccessKey = requiredEnv("BUNNY_STORAGE_SECRET_ACCESS_KEY");
  const databaseUrl = requiredEnv("DATABASE_URL");
  const endpoint = optionalEnv(
    "BUNNY_STORAGE_ENDPOINT",
    "https://ny-s3.storage.bunnycdn.com",
  );
  const bucket = optionalEnv("BUNNY_STORAGE_BUCKET", "beach");
  const accessKeyId = optionalEnv("BUNNY_STORAGE_ACCESS_KEY_ID", "beach");
  const region = optionalEnv("BUNNY_STORAGE_REGION", "ny");

  const s3 = new S3Client({
    endpoint,
    region,
    forcePathStyle: true,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });

  const pool = new Pool({ connectionString: databaseUrl });

  try {
    const [bucketFiles, referencedKeys] = await Promise.all([
      listAllBucketFiles(s3, bucket),
      fetchReferencedKeySet(pool, bucket),
    ]);

    const unreferenced = bucketFiles.filter(
      (entry) => !referencedKeys.has(entry.key),
    );
    const unreferencedKeys = unreferenced.map((entry) => entry.key);
    const unreferencedBytes = unreferenced.reduce(
      (total, entry) => total + entry.size,
      0,
    );

    const summary: Record<string, unknown> = {
      mode: options.apply ? "apply" : "dry-run",
      bucket,
      bucket_file_count: bucketFiles.length,
      db_referenced_unique_keys: referencedKeys.size,
      unreferenced_file_count: unreferencedKeys.length,
      unreferenced_file_bytes: unreferencedBytes,
      unreferenced_file_gib: Number(
        (unreferencedBytes / (1024 * 1024 * 1024)).toFixed(3),
      ),
      sample_unreferenced_keys: unreferencedKeys.slice(0, options.sampleLimit),
    };

    if (!options.apply) {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      return 0;
    }

    if (unreferencedKeys.length === 0) {
      process.stdout.write(
        `${JSON.stringify(
          {
            ...summary,
            deleted_count: 0,
            delete_error_count: 0,
          },
          null,
          2,
        )}\n`,
      );
      return 0;
    }

    // Deletion only targets keys that are not referenced by listing_source_image.site_image.
    const deletion = await deleteKeys(s3, bucket, unreferencedKeys);
    process.stdout.write(
      `${JSON.stringify(
        {
          ...summary,
          deleted_count: deletion.deletedCount,
          delete_error_count: deletion.errorCount,
        },
        null,
        2,
      )}\n`,
    );

    if (deletion.errorCount > 0) {
      return 1;
    }

    return 0;
  } finally {
    await pool.end();
  }
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

run()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Prune unreferenced Bunny keys failed: ${message}\n`);
    process.stderr.write(`\n${usage()}\n`);
    process.exit(1);
  });
