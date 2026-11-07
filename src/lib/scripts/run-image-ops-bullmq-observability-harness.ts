import "@/core/tooling/env/load-env-profile";

import { Job, QueueEvents, type JobProgress } from "bullmq";
import { randomUUID } from "node:crypto";

import {
  IMAGE_QUEUE_NAME,
  configureRedisTarget,
  createImageQueue,
  createRedisConnection,
  type ImageProcessingQueueJob,
  type RedisTarget,
} from "../../workers/image-queue";

type Args = {
  redisTarget: RedisTarget;
  observeMs: number;
  sampleIntervalMs: number;
  seedLimit: number;
  jobRetentionCount: number;
  enqueueSimJob: boolean;
  sourceImageUrl: string;
  workId: string;
  dryRun: boolean;
  json: boolean;
};

type QueueDepthSnapshot = {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: number;
  backlog: number;
};

type JobReadSummary = {
  id: string;
  state: string;
  timestampMs: number;
  processedOnMs: number | null;
  finishedOnMs: number | null;
  returnShape: {
    processedCount: number;
    failedCount: number;
    hasItemsArray: boolean;
    itemsLength: number;
    hasErrorsArray: boolean;
    errorsLength: number;
    completedAtMs: number | null;
    elapsedMs: number | null;
  } | null;
};

function usage(): string {
  return [
    "BullMQ observability harness for image queue event data vs request data.",
    "",
    "Usage:",
    "  npm run workers:image:ops:bullmq:harness -- [options]",
    "",
    "Options:",
    "  --redis-target <local|cloud>    Redis target (default local)",
    "  --observe-ms <n>                Observation duration in ms (default 60000)",
    "  --sample-interval-ms <n>        Interval for request-based queue depth snapshots (default 1000)",
    "  --seed-limit <n>                Number of recent completed/failed jobs to inspect at startup (default 50)",
    "  --job-retention-count <n>       removeOnComplete/removeOnFail retention for simulated jobs (default 1000)",
    "  --enqueue-sim-job <bool>        Enqueue a test image job to force event traffic (default false)",
    "  --source-image-url <url>        URL for simulated job (required when enqueue enabled)",
    "  --work-id <id>                  Work id for simulated job (default auto)",
    "  --dry-run <bool>                Simulated job dry-run flag (default true)",
    "  --json                          Emit newline-delimited JSON events",
    "  --help                          Show help",
  ].join("\n");
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw || !raw.trim()) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  const flags = new Set<string>();

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
    flags.add(key);
  }

  if (flags.has("help") || flags.has("h")) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }

  const redisTargetRaw = (values.get("redis-target") || "local").trim();
  const redisTarget: RedisTarget =
    redisTargetRaw === "cloud" ? "cloud" : "local";

  const enqueueSimJob = parseBoolean(values.get("enqueue-sim-job"), false);
  const sourceImageUrl = (values.get("source-image-url") || "").trim();
  if (enqueueSimJob && !sourceImageUrl) {
    throw new Error(
      "Missing --source-image-url when --enqueue-sim-job true\n\n" + usage(),
    );
  }

  return {
    redisTarget,
    observeMs: parsePositiveInt(values.get("observe-ms"), 60_000),
    sampleIntervalMs: parsePositiveInt(values.get("sample-interval-ms"), 1_000),
    seedLimit: parsePositiveInt(values.get("seed-limit"), 50),
    jobRetentionCount: parsePositiveInt(
      values.get("job-retention-count"),
      1_000,
    ),
    enqueueSimJob,
    sourceImageUrl,
    workId:
      (values.get("work-id") || "").trim() ||
      `obs-${new Date().toISOString().replace(/[.:]/g, "-")}`,
    dryRun: parseBoolean(values.get("dry-run"), true),
    json: flags.has("json"),
  };
}

function safeJsonParse(input: unknown): unknown {
  if (typeof input === "string") {
    try {
      return JSON.parse(input);
    } catch {
      return null;
    }
  }
  if (input && typeof input === "object") {
    return input;
  }
  return null;
}

function readReturnShape(
  returnValueRaw: unknown,
): JobReadSummary["returnShape"] {
  const payload = safeJsonParse(returnValueRaw);
  if (!payload || Array.isArray(payload) || typeof payload !== "object") {
    return null;
  }

  const typed = payload as Record<string, unknown>;
  const items = Array.isArray(typed.items) ? typed.items : [];
  const errors = Array.isArray(typed.errors) ? typed.errors : [];
  const completedAtIso =
    typeof typed.completed_at === "string" ? typed.completed_at : null;
  const completedAtMs = completedAtIso ? Date.parse(completedAtIso) : NaN;

  return {
    processedCount: Math.max(
      0,
      Math.floor(Number(typed.processed_count ?? typed.processed) || 0),
    ),
    failedCount: Math.max(
      0,
      Math.floor(Number(typed.failed_count ?? typed.failed) || 0),
    ),
    hasItemsArray: Array.isArray(typed.items),
    itemsLength: items.length,
    hasErrorsArray: Array.isArray(typed.errors),
    errorsLength: errors.length,
    completedAtMs: Number.isFinite(completedAtMs) ? completedAtMs : null,
    elapsedMs: Number.isFinite(Number(typed.elapsed_ms))
      ? Number(typed.elapsed_ms)
      : null,
  };
}

function printEvent(json: boolean, payload: Record<string, unknown>): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }

  const type = String(payload.type || "event");
  if (type === "queue-depth") {
    process.stdout.write(
      `[harness] queue-depth source=${String(payload.source || "poll")} waiting=${String(payload.waiting || 0)} active=${String(payload.active || 0)} completed=${String(payload.completed || 0)} failed=${String(payload.failed || 0)} delayed=${String(payload.delayed || 0)} paused=${String(payload.paused || 0)} backlog=${String(payload.backlog || 0)}\n`,
    );
    return;
  }

  if (type === "seed") {
    process.stdout.write(
      `[harness] seed completed=${String(payload.completedJobs || 0)} failed=${String(payload.failedJobs || 0)} limit=${String(payload.limit || 0)}\n`,
    );
    return;
  }

  if (type === "event-observation") {
    process.stdout.write(
      `[harness] event=${String(payload.eventName || "unknown")} job=${String(payload.jobId || "-")} finished_ms=${String(payload.finishedOnMs ?? "-")} processed=${String(payload.processedCount ?? "-")} failed_items=${String(payload.failedCount ?? "-")} queue_backlog=${String(payload.backlog ?? "-")}\n`,
    );
    return;
  }

  if (type === "sim-job") {
    process.stdout.write(
      `[harness] sim-job queued jobId=${String(payload.jobId || "-")} workId=${String(payload.workId || "-")} dryRun=${String(payload.dryRun || false)}\n`,
    );
    return;
  }

  if (type === "summary") {
    process.stdout.write(
      `[harness] summary events=${String(payload.eventCount || 0)} completedEvents=${String(payload.completedEvents || 0)} failedEvents=${String(payload.failedEvents || 0)} sampledDepthPoints=${String(payload.depthPoints || 0)}\n`,
    );
    return;
  }

  process.stdout.write(`[harness] ${JSON.stringify(payload)}\n`);
}

async function readQueueDepth(
  queue: ReturnType<typeof createImageQueue>,
): Promise<QueueDepthSnapshot> {
  const counts = await queue.getJobCounts(
    "waiting",
    "active",
    "completed",
    "failed",
    "delayed",
    "paused",
  );
  const waiting = Math.max(0, Number(counts.waiting || 0));
  const active = Math.max(0, Number(counts.active || 0));
  const delayed = Math.max(0, Number(counts.delayed || 0));
  const paused = Math.max(0, Number(counts.paused || 0));
  return {
    waiting,
    active,
    completed: Math.max(0, Number(counts.completed || 0)),
    failed: Math.max(0, Number(counts.failed || 0)),
    delayed,
    paused,
    backlog: waiting + active + delayed + paused,
  };
}

async function readJobSummary(
  queue: ReturnType<typeof createImageQueue>,
  jobId: string,
): Promise<JobReadSummary | null> {
  const job = await Job.fromId(queue, jobId);
  if (!job) {
    return null;
  }

  const state = await job.getState();
  return {
    id: String(job.id),
    state,
    timestampMs: Number(job.timestamp || 0),
    processedOnMs: Number.isFinite(Number(job.processedOn))
      ? Number(job.processedOn)
      : null,
    finishedOnMs: Number.isFinite(Number(job.finishedOn))
      ? Number(job.finishedOn)
      : null,
    returnShape: readReturnShape(job.returnvalue),
  };
}

async function emitSeedInspection(input: {
  queue: ReturnType<typeof createImageQueue>;
  limit: number;
  json: boolean;
}): Promise<void> {
  const [completedJobs, failedJobs] = await Promise.all([
    input.queue.getJobs(["completed"], 0, Math.max(0, input.limit - 1), true),
    input.queue.getJobs(["failed"], 0, Math.max(0, input.limit - 1), true),
  ]);

  const summarize = async (jobs: Array<Job<ImageProcessingQueueJob>>) => {
    const summaries: JobReadSummary[] = [];
    for (const job of jobs) {
      const summary = await readJobSummary(input.queue, String(job.id));
      if (summary) {
        summaries.push(summary);
      }
    }
    return summaries;
  };

  const [completedSummaries, failedSummaries] = await Promise.all([
    summarize(completedJobs),
    summarize(failedJobs),
  ]);

  printEvent(input.json, {
    type: "seed",
    at: new Date().toISOString(),
    limit: input.limit,
    completedJobs: completedSummaries.length,
    failedJobs: failedSummaries.length,
    completedSample: completedSummaries.slice(-5),
    failedSample: failedSummaries.slice(-5),
  });
}

async function enqueueSimulatedJob(input: {
  args: Args;
  queue: ReturnType<typeof createImageQueue>;
}): Promise<string> {
  const operationId = `obs-op-${new Date().toISOString().replace(/[.:]/g, "-")}`;
  const batchId = `obs-batch-${randomUUID().slice(0, 8)}`;
  const job = await input.queue.add(
    "process-image",
    {
      operationId,
      batchId,
      batchIndex: 0,
      batchCount: 1,
      workId: input.args.workId,
      sourceType: "url",
      sourceImageUrl: input.args.sourceImageUrl,
      dryRun: input.args.dryRun,
      uploadPrefix: "v1",
    },
    {
      // Match runner enqueue behavior so completed/failed depth trends stay comparable.
      removeOnComplete: Math.max(1, input.args.jobRetentionCount),
      removeOnFail: Math.max(1, input.args.jobRetentionCount),
    },
  );

  printEvent(input.args.json, {
    type: "sim-job",
    at: new Date().toISOString(),
    queue: IMAGE_QUEUE_NAME,
    jobId: String(job.id),
    workId: input.args.workId,
    dryRun: input.args.dryRun,
  });

  return String(job.id);
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const target = configureRedisTarget(args.redisTarget);
  const queue = createImageQueue();
  const eventsConnection = createRedisConnection();
  const queueEvents = new QueueEvents(IMAGE_QUEUE_NAME, {
    connection: eventsConnection,
  });
  await queueEvents.waitUntilReady();

  let timer: NodeJS.Timeout | null = null;
  let eventCount = 0;
  let completedEvents = 0;
  let failedEvents = 0;
  let depthPoints = 0;

  printEvent(args.json, {
    type: "start",
    at: new Date().toISOString(),
    queue: IMAGE_QUEUE_NAME,
    redisTarget: target.target,
    redisEndpoint: target.endpoint,
    observeMs: args.observeMs,
    sampleIntervalMs: args.sampleIntervalMs,
    jobRetentionCount: args.jobRetentionCount,
  });

  try {
    await emitSeedInspection({ queue, limit: args.seedLimit, json: args.json });

    const initialDepth = await readQueueDepth(queue);
    depthPoints += 1;
    printEvent(args.json, {
      type: "queue-depth",
      at: new Date().toISOString(),
      source: "initial",
      ...initialDepth,
    });

    const onEvent = async (
      eventName: string,
      event: { jobId?: string; data?: JobProgress; returnvalue?: unknown },
    ): Promise<void> => {
      eventCount += 1;
      const atIso = new Date().toISOString();
      const jobId = String(event.jobId || "");
      const summary = jobId ? await readJobSummary(queue, jobId) : null;
      const depth = await readQueueDepth(queue);
      depthPoints += 1;

      if (eventName === "completed") {
        completedEvents += 1;
      }
      if (eventName === "failed") {
        failedEvents += 1;
      }

      printEvent(args.json, {
        type: "event-observation",
        at: atIso,
        eventName,
        jobId: jobId || null,
        eventReturnShape: readReturnShape(event.returnvalue),
        jobSummary: summary,
        processedCount: summary?.returnShape?.processedCount ?? null,
        failedCount: summary?.returnShape?.failedCount ?? null,
        finishedOnMs: summary?.finishedOnMs ?? null,
        ...depth,
      });
    };

    queueEvents.on("waiting", (event) => {
      void onEvent("waiting", event as { jobId?: string });
    });
    queueEvents.on("active", (event) => {
      void onEvent("active", event as { jobId?: string });
    });
    queueEvents.on("progress", (event) => {
      void onEvent("progress", event as { jobId?: string; data?: JobProgress });
    });
    queueEvents.on("completed", (event) => {
      void onEvent(
        "completed",
        event as { jobId?: string; returnvalue?: unknown },
      );
    });
    queueEvents.on("failed", (event) => {
      void onEvent("failed", event as { jobId?: string });
    });
    queueEvents.on("delayed", (event) => {
      void onEvent("delayed", event as { jobId?: string });
    });

    timer = setInterval(
      () => {
        void (async () => {
          const depth = await readQueueDepth(queue);
          depthPoints += 1;
          printEvent(args.json, {
            type: "queue-depth",
            at: new Date().toISOString(),
            source: "poll",
            ...depth,
          });
        })();
      },
      Math.max(100, args.sampleIntervalMs),
    );

    if (args.enqueueSimJob) {
      await enqueueSimulatedJob({ args, queue });
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.max(1000, args.observeMs));
    });

    const finalDepth = await readQueueDepth(queue);
    depthPoints += 1;
    printEvent(args.json, {
      type: "queue-depth",
      at: new Date().toISOString(),
      source: "final",
      ...finalDepth,
    });

    printEvent(args.json, {
      type: "summary",
      at: new Date().toISOString(),
      eventCount,
      completedEvents,
      failedEvents,
      depthPoints,
    });
  } finally {
    if (timer) {
      clearInterval(timer);
    }
    await queueEvents.close().catch(() => undefined);
    await eventsConnection.quit().catch(() => undefined);
    await queue.close().catch(() => undefined);
  }
}

run().catch((error) => {
  process.stderr.write(
    `[harness] fatal error=${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
