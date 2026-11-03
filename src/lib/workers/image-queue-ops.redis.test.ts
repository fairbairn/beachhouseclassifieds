import { Queue, QueueEvents, Worker } from "bullmq";
import IORedis from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  purgePendingImageQueueJobs,
  readImageQueueCounts,
} from "@/lib/workers/image-queue-ops";
import { IMAGE_QUEUE_NAME } from "@/workers/image-queue";

const RUN_REDIS_TESTS = process.env.IMAGE_OPS_REDIS_INTEGRATION === "1";
const describeRedis = RUN_REDIS_TESTS ? describe : describe.skip;

const redisUrl =
  process.env.IMAGE_OPS_TEST_REDIS_URL?.trim() || "redis://127.0.0.1:6379/15";

describeRedis("image-queue-ops redis integration", () => {
  let queue: Queue;
  let admin: IORedis;
  let previousRedisUrl: string | undefined;

  const clearQueue = async (): Promise<void> => {
    try {
      await queue.obliterate({ force: true });
    } catch {
      await queue.drain(true);
      await queue.clean(0, 10_000, "completed");
      await queue.clean(0, 10_000, "failed");
      await queue.clean(0, 10_000, "wait");
      await queue.clean(0, 10_000, "delayed");
    }
  };

  beforeAll(async () => {
    previousRedisUrl = process.env.REDIS_URL;
    process.env.REDIS_URL = redisUrl;

    admin = new IORedis(redisUrl, {
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
    });
    await admin.ping();

    queue = new Queue(IMAGE_QUEUE_NAME, {
      connection: admin,
    });
  });

  beforeEach(async () => {
    await clearQueue();
    await queue.resume();
  });

  afterAll(async () => {
    await clearQueue();
    await queue.close();
    await admin.quit();
    if (previousRedisUrl === undefined) {
      delete process.env.REDIS_URL;
    } else {
      process.env.REDIS_URL = previousRedisUrl;
    }
  });

  it("reads waiting/delayed and computes backlog from shared queue module", async () => {
    await queue.resume();
    await queue.add("waiting-job", { test: "waiting" });
    await queue.add("delayed-job", { test: "delayed" }, { delay: 60_000 });

    const counts = await readImageQueueCounts();

    expect(counts.waiting).toBeGreaterThanOrEqual(1);
    expect(counts.delayed).toBeGreaterThanOrEqual(1);
    expect(counts.backlog).toBe(
      counts.waiting + counts.active + counts.delayed + counts.paused,
    );
  });

  it("reads paused count and includes it in backlog", async () => {
    await queue.pause();
    await queue.add("paused-job", { test: "paused" });

    const counts = await readImageQueueCounts();

    expect(counts.paused).toBeGreaterThanOrEqual(0);
    expect(counts.backlog).toBe(
      counts.waiting + counts.active + counts.delayed + counts.paused,
    );
  });

  it("reads completed and failed counters", async () => {
    const workerConnection = new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
    const eventsConnection = new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });

    const worker = new Worker(
      IMAGE_QUEUE_NAME,
      async (job) => {
        if ((job.data as { fail?: boolean }).fail) {
          throw new Error("forced failure");
        }
        return { ok: true };
      },
      { connection: workerConnection },
    );

    const queueEvents = new QueueEvents(IMAGE_QUEUE_NAME, {
      connection: eventsConnection,
    });

    await queueEvents.waitUntilReady();

    try {
      const successJob = await queue.add("success-job", { fail: false });
      const failedJob = await queue.add("failed-job", { fail: true });

      await successJob.waitUntilFinished(queueEvents);
      await expect(failedJob.waitUntilFinished(queueEvents)).rejects.toThrow();

      const counts = await readImageQueueCounts();
      expect(counts.completed).toBeGreaterThanOrEqual(1);
      expect(counts.failed).toBeGreaterThanOrEqual(1);
    } finally {
      await worker.close();
      await queueEvents.close();
      await workerConnection.quit();
      await eventsConnection.quit();
    }
  });

  it("purges waiting/delayed/paused and reports remaining counters", async () => {
    await queue.resume();
    await queue.add("waiting-a", { type: "waiting" });
    await queue.add("delayed-a", { type: "delayed" }, { delay: 120_000 });
    await queue.pause();
    await queue.add("paused-a", { type: "paused" });

    const result = await purgePendingImageQueueJobs();

    expect(result.removed).toBeGreaterThanOrEqual(3);
    expect(result.remainingWaiting).toBe(0);
    expect(result.remainingDelayed).toBe(0);
    expect(result.remainingPaused).toBe(0);
    expect(result.remainingActive).toBeGreaterThanOrEqual(0);
  });
});
