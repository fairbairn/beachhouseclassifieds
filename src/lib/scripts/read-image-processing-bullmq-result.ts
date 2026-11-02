import "@/core/tooling/env/load-env-profile";
import { Job } from "bullmq";
import { IMAGE_QUEUE_NAME, createImageQueue } from "../../workers/image-queue";

type Args = {
  jobId?: string;
  workId?: string;
  limit: number;
  json: boolean;
};

type ReadResult = {
  queue: string;
  jobId: string;
  name: string;
  state: string;
  attemptsMade: number;
  timestamp: number;
  processedOn: number | null;
  finishedOn: number | null;
  failedReason: string | null;
  progress: unknown;
  data: unknown;
  returnValue: unknown;
  stacktrace: string[];
};

function usage(): string {
  return [
    "Usage:",
    "  npm run workers:image:result -- --job-id <id>",
    "  npm run workers:image:result -- --work-id <workId> [--limit 500]",
    "",
    "Options:",
    "  --job-id   Retrieve one job by BullMQ job id",
    "  --work-id  Search recent jobs for matching data.workId",
    "  --limit    Search window for --work-id (default 500)",
    "  --json     Emit formatted JSON only",
  ].join("\n");
}

function parseOptionalInt(value: string | undefined, fallback: number): number {
  if (!value || !value.trim()) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
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

  const jobId = values.get("job-id")?.trim();
  const workId = values.get("work-id")?.trim();

  if (!jobId && !workId) {
    throw new Error(`Missing required --job-id or --work-id\n\n${usage()}`);
  }

  return {
    jobId,
    workId,
    limit: parseOptionalInt(values.get("limit"), 500),
    json: flags.has("json"),
  };
}

async function resolveJobByWorkId(
  workId: string,
  limit: number,
): Promise<Job | null> {
  const queue = createImageQueue();
  try {
    const jobs = await queue.getJobs(
      ["active", "waiting", "completed", "failed", "delayed", "paused"],
      0,
      Math.max(0, limit - 1),
      true,
    );

    for (const job of jobs) {
      const data = (job.data || {}) as { workId?: unknown };
      if (typeof data.workId === "string" && data.workId === workId) {
        return job;
      }
    }

    return null;
  } finally {
    await queue.close();
  }
}

async function resolveJobById(jobId: string): Promise<Job | null> {
  const queue = createImageQueue();
  try {
    return await Job.fromId(queue, jobId);
  } finally {
    await queue.close();
  }
}

async function toReadResult(job: Job): Promise<ReadResult> {
  const state = await job.getState();
  return {
    queue: IMAGE_QUEUE_NAME,
    jobId: String(job.id),
    name: job.name,
    state,
    attemptsMade: job.attemptsMade,
    timestamp: job.timestamp,
    processedOn: job.processedOn ?? null,
    finishedOn: job.finishedOn ?? null,
    failedReason: job.failedReason || null,
    progress: job.progress,
    data: job.data,
    returnValue: job.returnvalue,
    stacktrace: job.stacktrace,
  };
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let job: Job | null = null;

  if (args.jobId) {
    job = await resolveJobById(args.jobId);
  }

  if (!job && args.workId) {
    job = await resolveJobByWorkId(args.workId, args.limit);
  }

  if (!job) {
    if (args.json) {
      process.stderr.write(
        `${JSON.stringify(
          {
            event: "not_found",
            queue: IMAGE_QUEUE_NAME,
            jobId: args.jobId || null,
            workId: args.workId || null,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      process.stderr.write(
        `[result] no matching job found queue=${IMAGE_QUEUE_NAME} jobId=${args.jobId || "-"} workId=${args.workId || "-"}\n`,
      );
    }
    process.exit(1);
    return;
  }

  const summary = await toReadResult(job);
  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          event: "found",
          ...summary,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(
      `[result] found queue=${summary.queue} jobId=${summary.jobId} state=${summary.state}\n`,
    );
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  }
}

run().catch((error) => {
  process.stderr.write(
    `[result] fatal error=${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
