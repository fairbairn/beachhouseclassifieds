import "@/core/tooling/env/load-env-profile";

import IORedis from "ioredis";

import {
  DEFAULT_LOCAL_REDIS_URL,
  createImageQueue,
} from "@/workers/image-queue";

type Args = {
  sourceRedisUrl: string;
  targetRedisUrl: string;
  limit: number;
  includeFailed: boolean;
  resetTarget: boolean;
  allowTargetDb0: boolean;
};

type ScoredEntry = {
  member: string;
  score: number;
};

function usage(): string {
  return [
    "Seed test Redis with real BullMQ image job data.",
    "",
    "Usage:",
    "  npm run workers:image:ops:metrics:seed -- [options]",
    "",
    "Options:",
    "  --source-redis-url <url>   Source Redis (default redis://127.0.0.1:6379/0)",
    "  --target-redis-url <url>   Target Redis (default redis://127.0.0.1:6379/1)",
    "  --limit <n>                Max completed/failed entries to copy (default 2000)",
    "  --include-failed <bool>    Copy failed zset entries (default true)",
    "  --reset-target <bool>      Flush target DB before copy (default true)",
    "  --allow-target-db0 <bool>  Allow DB0 target writes (default false)",
  ].join("\n");
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (!raw) {
    return fallback;
  }
  const value = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(value)) {
    return false;
  }
  return fallback;
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
    targetRedisUrl:
      values.get("target-redis-url")?.trim() || `${DEFAULT_LOCAL_REDIS_URL}/1`,
    limit: parsePositiveInt(values.get("limit"), 2000),
    includeFailed: parseBool(values.get("include-failed"), true),
    resetTarget: parseBool(values.get("reset-target"), true),
    allowTargetDb0: parseBool(values.get("allow-target-db0"), false),
  };
}

function redisDbIndex(redisUrl: string): number {
  const parsed = new URL(redisUrl);
  const path = parsed.pathname.trim();
  if (!path || path === "/") {
    return 0;
  }
  const dbRaw = path.startsWith("/") ? path.slice(1) : path;
  const db = Number(dbRaw);
  if (!Number.isFinite(db) || db < 0) {
    throw new Error(`invalid redis DB index in URL: ${redisUrl}`);
  }
  return db;
}

function parseScoredEntries(raw: string[]): ScoredEntry[] {
  const entries: ScoredEntry[] = [];
  for (let index = 0; index + 1 < raw.length; index += 2) {
    const member = String(raw[index] || "");
    const score = Number(raw[index + 1]);
    if (!member || !Number.isFinite(score)) {
      continue;
    }
    entries.push({ member, score });
  }
  entries.reverse();
  return entries;
}

async function readScoredEntries(input: {
  redis: IORedis;
  key: string;
  limit: number;
}): Promise<ScoredEntry[]> {
  const raw = await input.redis.zrevrangebyscore(
    input.key,
    "+inf",
    "-inf",
    "WITHSCORES",
    "LIMIT",
    "0",
    String(Math.max(1, input.limit)),
  );
  return parseScoredEntries(Array.isArray(raw) ? raw : []);
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const sourceDb = redisDbIndex(args.sourceRedisUrl);
  const targetDb = redisDbIndex(args.targetRedisUrl);
  if (targetDb === 0 && !args.allowTargetDb0) {
    throw new Error(
      "refusing to write to target Redis DB 0; set --allow-target-db0 true to override",
    );
  }

  const sourceRedis = new IORedis(args.sourceRedisUrl, {
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
  });
  const targetRedis = new IORedis(args.targetRedisUrl, {
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
  });

  const sourceQueue = createImageQueue(sourceRedis);
  const targetQueue = createImageQueue(targetRedis);

  try {
    await Promise.all([sourceRedis.ping(), targetRedis.ping()]);

    if (args.resetTarget) {
      await targetRedis.flushdb();
    }

    const sourceCompletedKey = sourceQueue.toKey("completed");
    const sourceFailedKey = sourceQueue.toKey("failed");
    const targetCompletedKey = targetQueue.toKey("completed");
    const targetFailedKey = targetQueue.toKey("failed");

    const completedEntries = await readScoredEntries({
      redis: sourceRedis,
      key: sourceCompletedKey,
      limit: args.limit,
    });

    const payloadRead = sourceRedis.pipeline();
    for (const entry of completedEntries) {
      payloadRead.hget(sourceQueue.toKey(entry.member), "returnvalue");
    }
    const payloadRows = await payloadRead.exec();

    const write = targetRedis.pipeline();
    let copiedCompleted = 0;
    let copiedReturnvalues = 0;

    for (let index = 0; index < completedEntries.length; index += 1) {
      const entry = completedEntries[index];
      write.zadd(targetCompletedKey, entry.score, entry.member);
      copiedCompleted += 1;

      const payloadRow = payloadRows?.[index];
      const payload =
        payloadRow && payloadRow[0] === null
          ? (payloadRow[1] as string | null)
          : null;
      if (payload && payload.trim()) {
        write.hset(targetQueue.toKey(entry.member), "returnvalue", payload);
        copiedReturnvalues += 1;
      }
    }

    let copiedFailed = 0;
    if (args.includeFailed) {
      const failedEntries = await readScoredEntries({
        redis: sourceRedis,
        key: sourceFailedKey,
        limit: args.limit,
      });
      for (const entry of failedEntries) {
        write.zadd(targetFailedKey, entry.score, entry.member);
        copiedFailed += 1;
      }
    }

    await write.exec();

    process.stdout.write(
      [
        "seed complete",
        `source_db=${sourceDb}`,
        `target_db=${targetDb}`,
        `copied_completed=${copiedCompleted}`,
        `copied_returnvalues=${copiedReturnvalues}`,
        `copied_failed=${copiedFailed}`,
        `limit=${args.limit}`,
        `reset_target=${String(args.resetTarget)}`,
      ].join(" ") + "\n",
    );
  } finally {
    await sourceQueue.close().catch(() => undefined);
    await targetQueue.close().catch(() => undefined);
    await sourceRedis.quit().catch(() => undefined);
    await targetRedis.quit().catch(() => undefined);
  }
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`workers:image:ops:metrics:seed failed: ${message}\n`);
  process.exit(1);
});
