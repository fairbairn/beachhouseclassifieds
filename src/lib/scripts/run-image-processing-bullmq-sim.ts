import "@/core/tooling/env/load-env-profile";
import { QueueEvents, type JobProgress } from "bullmq";
import { randomUUID } from "node:crypto";
import {
  IMAGE_QUEUE_NAME,
  createImageQueue,
  createRedisConnection,
} from "../../workers/image-queue";

type Args = {
  sourceImageUrl: string;
  workId: string;
  dryRun: boolean;
  wait: boolean;
  json: boolean;
  uploadPrefix?: string;
  fetchTimeoutMs?: number;
  fetchRetryCount?: number;
  sleepSecondsPerItem?: number;
  verboseLogs: boolean;
};

function usage(): string {
  return [
    "Usage:",
    "  npm run workers:image:enqueue:sim -- --source-image-url <url> [--work-id <id>] [--wait] [--dry-run true|false]",
    "",
    "Options:",
    "  --source-image-url    Required for URL mode simulation",
    "  --work-id             Optional custom work ID",
    "  --wait                Wait for completion and print final result",
    "  --dry-run             Defaults to true",
    "  --upload-prefix       Defaults to v1",
    "  --fetch-timeout-ms    Optional source fetch timeout",
    "  --fetch-retry-count   Optional source fetch retries",
    "  --sleep-seconds-per-item Optional per-item delay",
    "  --verbose-logs        Print task-level logs from worker",
    "  --json                Emit formatted JSON events",
  ].join("\n");
}

function printEvent(jsonMode: boolean, payload: Record<string, unknown>): void {
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  const event = String(payload.event || "");
  if (event === "queued") {
    process.stdout.write(
      `[enqueue] queued queue=${String(payload.queue || "-")} jobId=${String(payload.jobId || "-")} workId=${String(payload.workId || "-")} dryRun=${String(payload.dryRun || false)}\n`,
    );
    return;
  }

  if (event === "waiting") {
    process.stdout.write(
      `[enqueue] waiting jobId=${String(payload.jobId || "-")} timeoutMs=${String(payload.timeoutMs || "-")}\n`,
    );
    return;
  }

  if (event === "progress_number") {
    process.stdout.write(
      `[enqueue] progress jobId=${String(payload.jobId || "-")} value=${String(payload.value || "-")}\n`,
    );
    return;
  }

  if (event === "progress") {
    process.stdout.write(
      `[enqueue] progress jobId=${String(payload.jobId || "-")} current=${String(payload.current || 0)}/${String(payload.total || 0)} queued=${String(payload.queued || 0)} active=${String(payload.active || 0)} ok=${String(payload.succeeded || 0)} fail=${String(payload.failed || 0)} event=${String(payload.progressEvent || "unknown")} workId=${String(payload.lastWorkId || "-")} error=${String(payload.lastErrorCode || "-")}\n`,
    );
    return;
  }

  if (event === "completed") {
    process.stdout.write(
      `[enqueue] completed jobId=${String(payload.jobId || "-")} return=${JSON.stringify(payload.returnValue)}\n`,
    );
  }
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no") {
    return false;
  }
  return fallback;
}

function parseOptionalInt(value: string | undefined): number | undefined {
  if (!value || !value.trim()) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return parsed;
}

function parseArgs(argv: string[]): Args {
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
    } else {
      flags.add(key);
    }
  }

  const sourceImageUrl = values.get("source-image-url")?.trim() || "";
  if (!sourceImageUrl) {
    throw new Error(`Missing --source-image-url\n\n${usage()}`);
  }

  return {
    sourceImageUrl,
    workId:
      values.get("work-id")?.trim() ||
      `sim-${new Date().toISOString().replace(/[.:]/g, "-")}`,
    dryRun: parseBoolean(values.get("dry-run"), true),
    wait: flags.has("wait"),
    json: flags.has("json"),
    uploadPrefix: values.get("upload-prefix")?.trim(),
    fetchTimeoutMs: parseOptionalInt(values.get("fetch-timeout-ms")),
    fetchRetryCount: parseOptionalInt(values.get("fetch-retry-count")),
    sleepSecondsPerItem: parseOptionalInt(values.get("sleep-seconds-per-item")),
    verboseLogs: flags.has("verbose-logs"),
  };
}

async function waitForJobCompletion(params: {
  jobId: string;
  timeoutMs: number;
  json: boolean;
}): Promise<void> {
  const connection = createRedisConnection();
  const events = new QueueEvents(IMAGE_QUEUE_NAME, { connection });
  await events.waitUntilReady();

  printEvent(params.json, {
    event: "waiting",
    jobId: params.jobId,
    timeoutMs: params.timeoutMs,
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`wait timeout reached for jobId=${params.jobId}`));
      }, params.timeoutMs);

      const cleanup = (): void => {
        clearTimeout(timeout);
        events.off("progress", onProgress);
        events.off("completed", onCompleted);
        events.off("failed", onFailed);
      };

      const onProgress = (event: {
        jobId: string;
        data: JobProgress;
      }): void => {
        if (event.jobId !== params.jobId) {
          return;
        }

        if (typeof event.data === "number") {
          printEvent(params.json, {
            event: "progress_number",
            jobId: event.jobId,
            value: event.data,
          });
          return;
        }

        if (!event.data || typeof event.data !== "object") {
          return;
        }

        const data = event.data as {
          current?: number;
          total?: number;
          queued?: number;
          active?: number;
          succeeded?: number;
          failed?: number;
          event?: string;
          last_work_id?: string | null;
          last_error_code?: string | null;
        };

        printEvent(params.json, {
          event: "progress",
          jobId: event.jobId,
          current: data.current ?? 0,
          total: data.total ?? 0,
          queued: data.queued ?? 0,
          active: data.active ?? 0,
          succeeded: data.succeeded ?? 0,
          failed: data.failed ?? 0,
          progressEvent: data.event ?? "unknown",
          lastWorkId: data.last_work_id ?? null,
          lastErrorCode: data.last_error_code ?? null,
        });
      };

      const onCompleted = (event: {
        jobId: string;
        returnvalue: unknown;
      }): void => {
        if (event.jobId !== params.jobId) {
          return;
        }
        cleanup();
        printEvent(params.json, {
          event: "completed",
          jobId: event.jobId,
          returnValue: event.returnvalue,
        });
        resolve();
      };

      const onFailed = (event: {
        jobId: string;
        failedReason: string;
      }): void => {
        if (event.jobId !== params.jobId) {
          return;
        }
        cleanup();
        reject(new Error(`job failed: ${event.failedReason}`));
      };

      events.on("progress", onProgress);
      events.on("completed", onCompleted);
      events.on("failed", onFailed);
    });
  } finally {
    await events.close();
    await connection.quit();
  }
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const queue = createImageQueue();

  try {
    const operationId = `sim-op-${new Date().toISOString().replace(/[.:]/g, "-")}`;
    const batchId = `sim-batch-${randomUUID().slice(0, 8)}`;

    const job = await queue.add("process-image", {
      operationId,
      batchId,
      batchIndex: 0,
      batchCount: 1,
      workId: args.workId,
      sourceType: "url",
      sourceImageUrl: args.sourceImageUrl,
      dryRun: args.dryRun,
      uploadPrefix: args.uploadPrefix,
      fetchTimeoutMs: args.fetchTimeoutMs,
      fetchRetryCount: args.fetchRetryCount,
      sleepSecondsPerItem: args.sleepSecondsPerItem,
      verboseLogs: args.verboseLogs,
    });

    printEvent(args.json, {
      event: "queued",
      queue: IMAGE_QUEUE_NAME,
      jobId: String(job.id),
      workId: args.workId,
      dryRun: args.dryRun,
    });

    if (args.wait) {
      await waitForJobCompletion({
        jobId: String(job.id),
        timeoutMs: 120_000,
        json: args.json,
      });
    }
  } finally {
    await queue.close();
  }
}

run().catch((error) => {
  process.stderr.write(
    `[enqueue] fatal error=${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
