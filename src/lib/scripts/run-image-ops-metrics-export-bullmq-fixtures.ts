import "@/core/tooling/env/load-env-profile";

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import IORedis from "ioredis";

import {
  DEFAULT_LOCAL_REDIS_URL,
  IMAGE_QUEUE_NAME,
  createImageQueue,
} from "@/workers/image-queue";

type Args = {
  sourceRedisUrl: string;
  outputFile: string;
  limit: number;
  scanLimit: number;
  minItemCount: number;
};

type CompletedRow = {
  jobId: string;
  finishedAtMs: number;
};

type FixtureEntry = {
  jobId: string;
  finishedAtMs: number;
  itemCount: number;
  returnvalue: string;
};

type FixtureFile = {
  queueName: string;
  exportedAt: string;
  sourceRedisUrl: string;
  criteria: {
    limit: number;
    scanLimit: number;
    minItemCount: number;
  };
  selectedCounts: {
    multiItem: number;
    singleItem: number;
  };
  entries: FixtureEntry[];
};

function usage(): string {
  return [
    "Export real Bull queue returnvalue snapshots for deterministic metrics tests.",
    "",
    "Usage:",
    "  npm run workers:image:ops:metrics:export -- [options]",
    "",
    "Options:",
    "  --source-redis-url <url>  Source Redis URL (default redis://127.0.0.1:6379/0)",
    "  --output-file <path>      Output JSON path (default .tmp/fixtures/image-ops-bullmq-snapshots.json)",
    "  --limit <n>               Number of snapshots to export (default 10)",
    "  --scan-limit <n>          Number of completed jobs to scan (default 400)",
    "  --min-item-count <n>      Prefer jobs with at least this many items (default 2)",
  ].join("\n");
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      values.set(key, next);
      index += 1;
      continue;
    }
    values.set(key, "true");
  }

  if (values.has("help") || values.has("h")) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }

  return {
    sourceRedisUrl:
      values.get("source-redis-url")?.trim() || `${DEFAULT_LOCAL_REDIS_URL}/0`,
    outputFile:
      values.get("output-file")?.trim() ||
      ".tmp/fixtures/image-ops-bullmq-snapshots.json",
    limit: parsePositiveInt(values.get("limit"), 10),
    scanLimit: parsePositiveInt(values.get("scan-limit"), 400),
    minItemCount: Math.max(
      1,
      parsePositiveInt(values.get("min-item-count"), 2),
    ),
  };
}

function parseCompletedRows(raw: string[]): CompletedRow[] {
  const rows: CompletedRow[] = [];
  for (let index = 0; index + 1 < raw.length; index += 2) {
    const jobId = String(raw[index] || "").trim();
    const finishedAtMs = Number(raw[index + 1]);
    if (!jobId || !Number.isFinite(finishedAtMs)) {
      continue;
    }
    rows.push({ jobId, finishedAtMs });
  }
  return rows;
}

function readItemCountFromReturnvalue(raw: string): number {
  try {
    const parsed = JSON.parse(raw) as {
      item_count?: unknown;
      items?: unknown;
      processed_count?: unknown;
    };

    const explicitItemCount = Number(parsed.item_count);
    if (Number.isFinite(explicitItemCount) && explicitItemCount > 0) {
      return Math.floor(explicitItemCount);
    }

    if (Array.isArray(parsed.items) && parsed.items.length > 0) {
      return parsed.items.length;
    }

    const processedCount = Number(parsed.processed_count);
    if (Number.isFinite(processedCount) && processedCount > 0) {
      return Math.floor(processedCount);
    }

    return 0;
  } catch {
    return 0;
  }
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const redis = new IORedis(args.sourceRedisUrl, {
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
  });
  const queue = createImageQueue(redis);

  try {
    await redis.ping();
    const completedKey = queue.toKey("completed");
    const rawRows = await redis.zrevrangebyscore(
      completedKey,
      "+inf",
      "-inf",
      "WITHSCORES",
      "LIMIT",
      "0",
      String(Math.max(1, args.scanLimit)),
    );

    const completedRows = parseCompletedRows(
      Array.isArray(rawRows) ? rawRows : [],
    );
    if (completedRows.length === 0) {
      throw new Error("No completed Bull jobs found to export.");
    }

    const readPipe = redis.pipeline();
    for (const row of completedRows) {
      readPipe.hget(queue.toKey(row.jobId), "returnvalue");
    }
    const payloadRows = await readPipe.exec();

    const candidates: FixtureEntry[] = [];
    for (let index = 0; index < completedRows.length; index += 1) {
      const payloadRow = payloadRows?.[index];
      const payload =
        payloadRow && payloadRow[0] === null
          ? (payloadRow[1] as string | null)
          : null;
      if (!payload || !payload.trim()) {
        continue;
      }

      const row = completedRows[index];
      candidates.push({
        jobId: row.jobId,
        finishedAtMs: row.finishedAtMs,
        itemCount: readItemCountFromReturnvalue(payload),
        returnvalue: payload,
      });
    }

    if (candidates.length === 0) {
      throw new Error(
        "Found completed jobs but none had returnvalue payloads.",
      );
    }

    const multiItem = candidates.filter(
      (entry) => entry.itemCount >= args.minItemCount,
    );
    const singleItem = candidates.filter(
      (entry) => entry.itemCount < args.minItemCount,
    );

    const selected = [...multiItem, ...singleItem].slice(
      0,
      Math.max(1, args.limit),
    );
    if (selected.length === 0) {
      throw new Error("No fixture snapshots selected.");
    }

    selected.sort((left, right) => left.finishedAtMs - right.finishedAtMs);

    const output: FixtureFile = {
      queueName: IMAGE_QUEUE_NAME,
      exportedAt: new Date().toISOString(),
      sourceRedisUrl: args.sourceRedisUrl,
      criteria: {
        limit: args.limit,
        scanLimit: args.scanLimit,
        minItemCount: args.minItemCount,
      },
      selectedCounts: {
        multiItem: selected.filter(
          (entry) => entry.itemCount >= args.minItemCount,
        ).length,
        singleItem: selected.filter(
          (entry) => entry.itemCount < args.minItemCount,
        ).length,
      },
      entries: selected,
    };

    const outputPath = resolve(process.cwd(), args.outputFile);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");

    process.stdout.write(
      [
        "bullmq fixture export complete",
        `output_file=${outputPath}`,
        `selected=${selected.length}`,
        `selected_multi_item=${output.selectedCounts.multiItem}`,
        `selected_single_item=${output.selectedCounts.singleItem}`,
        `scan_limit=${args.scanLimit}`,
      ].join(" ") + "\n",
    );
  } finally {
    await queue.close().catch(() => undefined);
    await redis.quit().catch(() => undefined);
  }
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`workers:image:ops:metrics:export failed: ${message}\n`);
  process.exit(1);
});
