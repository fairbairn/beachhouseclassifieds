import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { Queue } from "bullmq";
import IORedis from "ioredis";

export const IMAGE_QUEUE_NAME = "image-processing";
export const DEFAULT_LOCAL_REDIS_URL = "redis://127.0.0.1:6379";

export type RedisTarget = "local" | "cloud";

let cachedFlyRedisFromEnvLocal: string | null | undefined;

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

export function resolveRedisUrlForTarget(target: RedisTarget): string {
  if (target === "local") {
    return DEFAULT_LOCAL_REDIS_URL;
  }

  const cloudRedisUrl =
    process.env.FLY_REDIS?.trim() || readFlyRedisFromEnvLocal();
  if (!cloudRedisUrl) {
    throw new Error(
      "Missing FLY_REDIS for --redis-target cloud. Set FLY_REDIS in .env.local.",
    );
  }

  return cloudRedisUrl;
}

function readFlyRedisFromEnvLocal(): string | null {
  if (cachedFlyRedisFromEnvLocal !== undefined) {
    return cachedFlyRedisFromEnvLocal;
  }

  try {
    const filePath = resolve(process.cwd(), ".env.local");
    const raw = readFileSync(filePath, "utf8");
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      if (!trimmed.startsWith("FLY_REDIS=")) {
        continue;
      }

      const valueRaw = trimmed.slice("FLY_REDIS=".length).trim();
      const unquoted =
        (valueRaw.startsWith('"') && valueRaw.endsWith('"')) ||
        (valueRaw.startsWith("'") && valueRaw.endsWith("'"))
          ? valueRaw.slice(1, -1)
          : valueRaw;
      cachedFlyRedisFromEnvLocal = unquoted || null;
      return cachedFlyRedisFromEnvLocal;
    }
  } catch {
    // Ignore missing/unreadable .env.local and rely on env vars.
  }

  cachedFlyRedisFromEnvLocal = null;
  return cachedFlyRedisFromEnvLocal;
}

export function configureRedisTarget(target: RedisTarget): {
  target: RedisTarget;
  redisUrl: string;
  endpoint: string;
} {
  const redisUrl = resolveRedisUrlForTarget(target);
  process.env.REDIS_URL = redisUrl;
  return {
    target,
    redisUrl,
    endpoint: formatRedisEndpointForLogs(redisUrl),
  };
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
