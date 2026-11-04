import { Queue } from "bullmq";
import IORedis from "ioredis";

export const IMAGE_QUEUE_NAME = "image-processing";
export const DEFAULT_LOCAL_REDIS_URL = "redis://127.0.0.1:6379";

export type ImageProcessingQueueJob = {
  operationId: string;
  batchId: string;
  batchIndex: number;
  batchCount: number;
  workId: string;
  sourceType?: "url" | "s3";
  sourceImageUrl?: string;
  sourceS3Key?: string;
  sourceS3Bucket?: string;
  fetchTimeoutMs?: number;
  fetchRetryCount?: number;
  sleepSecondsPerItem?: number;
  dryRun?: boolean;
  uploadPrefix?: string;
  verboseLogs?: boolean;
};

export function resolveRedisUrl(): string {
  return process.env.REDIS_URL?.trim() || DEFAULT_LOCAL_REDIS_URL;
}

export function formatRedisEndpointForLogs(
  redisUrl = resolveRedisUrl(),
): string {
  try {
    const parsed = new URL(redisUrl);
    const scheme = parsed.protocol || "redis:";
    const host = parsed.hostname || "unknown-host";
    const isIpv6 = host.includes(":") && !host.startsWith("[");
    const displayHost = isIpv6 ? `[${host}]` : host;
    const port = parsed.port || "6379";
    const dbPath =
      parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : "";
    return `${scheme}//${displayHost}:${port}${dbPath}`;
  } catch {
    return "invalid-redis-url";
  }
}

export function createRedisConnection(): IORedis {
  return new IORedis(resolveRedisUrl(), {
    maxRetriesPerRequest: null,
    // Managed/proxy Redis endpoints can block or delay INFO-based ready checks.
    // Disabling ready-check keeps connect+PING behavior consistent with redis-cli.
    enableReadyCheck: false,
    connectTimeout: 5000,
  });
}

export function createImageQueue(
  connection?: IORedis,
): Queue<ImageProcessingQueueJob> {
  const redis = connection ?? createRedisConnection();
  return new Queue<ImageProcessingQueueJob>(IMAGE_QUEUE_NAME, {
    connection: redis,
    defaultJobOptions: {
      removeOnComplete: 200,
      removeOnFail: 500,
      attempts: 1,
    },
  });
}
