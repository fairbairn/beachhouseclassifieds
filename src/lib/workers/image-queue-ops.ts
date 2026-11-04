import { Queue } from "bullmq";

import {
  IMAGE_QUEUE_NAME,
  createRedisConnection,
} from "../../workers/image-queue";

export type ImageQueueCounts = {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: number;
  backlog: number;
};

export async function readImageQueueCounts(): Promise<ImageQueueCounts> {
  const connection = createRedisConnection();
  const queue = new Queue(IMAGE_QUEUE_NAME, { connection });
  try {
    const counts = await queue.getJobCounts(
      "waiting",
      "active",
      "completed",
      "failed",
      "delayed",
    );
    const pausedJobs = await queue.getJobs(["paused"], 0, -1);
    const waiting = counts.waiting || 0;
    const active = counts.active || 0;
    const delayed = counts.delayed || 0;
    const paused = pausedJobs.length;

    return {
      waiting,
      active,
      completed: counts.completed || 0,
      failed: counts.failed || 0,
      delayed,
      paused,
      backlog: waiting + active + delayed + paused,
    };
  } finally {
    await queue.close().catch(() => undefined);
    await connection.quit().catch(() => undefined);
  }
}

export async function readImageQueueWorkersRunning(): Promise<number> {
  const connection = createRedisConnection();
  const queue = new Queue(IMAGE_QUEUE_NAME, { connection });
  try {
    const workers = await queue.getWorkers();
    return Array.isArray(workers) ? workers.length : 0;
  } finally {
    await queue.close().catch(() => undefined);
    await connection.quit().catch(() => undefined);
  }
}

export async function readImageQueuePausedState(): Promise<boolean> {
  const connection = createRedisConnection();
  const queue = new Queue(IMAGE_QUEUE_NAME, { connection });
  try {
    return await queue.isPaused();
  } finally {
    await queue.close().catch(() => undefined);
    await connection.quit().catch(() => undefined);
  }
}

export async function setImageQueuePaused(paused: boolean): Promise<boolean> {
  const connection = createRedisConnection();
  const queue = new Queue(IMAGE_QUEUE_NAME, { connection });
  try {
    if (paused) {
      await queue.pause();
    } else {
      await queue.resume();
    }
    return await queue.isPaused();
  } finally {
    await queue.close().catch(() => undefined);
    await connection.quit().catch(() => undefined);
  }
}

export async function purgePendingImageQueueJobs(): Promise<{
  removed: number;
  remainingWaiting: number;
  remainingDelayed: number;
  remainingActive: number;
  remainingPaused: number;
}> {
  const connection = createRedisConnection();
  const queue = new Queue(IMAGE_QUEUE_NAME, { connection });
  try {
    const jobs = await queue.getJobs(["waiting", "delayed", "paused"], 0, -1);
    const seenJobIds = new Set<string>();
    let removed = 0;

    for (const job of jobs) {
      const jobId = String(job.id || "");
      if (!jobId || seenJobIds.has(jobId)) {
        continue;
      }
      seenJobIds.add(jobId);
      try {
        await job.remove();
        removed += 1;
      } catch {
        // Ignore races where workers consume a job while purge is running.
      }
    }

    const counts = await queue.getJobCounts("waiting", "active", "delayed");
    const pausedJobs = await queue.getJobs(["paused"], 0, -1);
    return {
      removed,
      remainingWaiting: counts.waiting || 0,
      remainingDelayed: counts.delayed || 0,
      remainingActive: counts.active || 0,
      remainingPaused: pausedJobs.length,
    };
  } finally {
    await queue.close().catch(() => undefined);
    await connection.quit().catch(() => undefined);
  }
}
