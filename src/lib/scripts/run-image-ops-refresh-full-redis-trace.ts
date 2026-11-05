import "@/core/tooling/env/load-env-profile";

import Redis, { type Command } from "ioredis";

import {
  configureRedisTarget,
  type RedisTarget,
} from "../../workers/image-queue";
import { runOpsOneShotPipeline } from "../workers/image-ops-control-module";

type CliArgs = {
  appName: string;
  redisTarget: RedisTarget;
  sampleLimit: number;
};

type CommandTrace = {
  index: number;
  command: string;
  requestBytes: number;
  responseBytes: number;
  elapsedMs: number;
  error: string | null;
};

type CommandSummary = {
  count: number;
  requestBytes: number;
  responseBytes: number;
  elapsedMs: number;
};

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

function parseArgs(argv: string[]): CliArgs {
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] || "";
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      options.set(key, "true");
      continue;
    }
    options.set(key, next);
    index += 1;
  }

  return {
    appName: options.get("app")?.trim() || "beachhouseclassifieds-image-worker",
    redisTarget:
      (options.get("redis-target") as RedisTarget | undefined) || "cloud",
    sampleLimit: parsePositiveInt(options.get("sample-limit"), 60),
  };
}

function byteLen(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function roughPayloadBytes(value: unknown): number {
  if (value === null || value === undefined) {
    return 0;
  }
  if (typeof value === "string") {
    return byteLen(value);
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return byteLen(String(value));
  }
  if (typeof value === "boolean") {
    return value ? 1 : 1;
  }
  if (Buffer.isBuffer(value)) {
    return value.length;
  }
  if (Array.isArray(value)) {
    return value.reduce((sum, entry) => sum + roughPayloadBytes(entry), 0);
  }
  try {
    return byteLen(JSON.stringify(value));
  } catch {
    return byteLen(String(value));
  }
}

function requestBytesForCommand(commandName: string, args: unknown[]): number {
  let bytes = byteLen(commandName);
  for (const arg of args) {
    bytes += 1;
    bytes += byteLen(String(arg));
  }
  return bytes;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const redisSelection = configureRedisTarget(args.redisTarget);

  process.stdout.write(
    `[trace] start app=${args.appName} redis_target=${redisSelection.target} sample_limit=${args.sampleLimit}\n`,
  );

  const traces: CommandTrace[] = [];
  const summary = new Map<string, CommandSummary>();
  let sequence = 0;

  const originalSendCommand = Redis.prototype.sendCommand;
  Redis.prototype.sendCommand = function patchedSendCommand(
    this: Redis,
    command: Command,
    stream?: unknown,
  ) {
    const commandName = String(command?.name || "unknown").toUpperCase();
    const commandArgs = Array.isArray(command?.args) ? command.args : [];
    const reqBytes = requestBytesForCommand(commandName, commandArgs);
    const commandPreview = `${commandName} ${commandArgs
      .map((entry) => String(entry))
      .join(" ")}`;
    const startedAtMs = Date.now();

    return originalSendCommand
      .call(this, command, stream as never)
      .then((reply) => {
        const resBytes = roughPayloadBytes(reply);
        const elapsedMs = Math.max(0, Date.now() - startedAtMs);
        traces.push({
          index: sequence,
          command: commandPreview,
          requestBytes: reqBytes,
          responseBytes: resBytes,
          elapsedMs,
          error: null,
        });
        sequence += 1;

        const agg = summary.get(commandName) || {
          count: 0,
          requestBytes: 0,
          responseBytes: 0,
          elapsedMs: 0,
        };
        agg.count += 1;
        agg.requestBytes += reqBytes;
        agg.responseBytes += resBytes;
        agg.elapsedMs += elapsedMs;
        summary.set(commandName, agg);

        return reply;
      })
      .catch((error: unknown) => {
        const elapsedMs = Math.max(0, Date.now() - startedAtMs);
        const message = error instanceof Error ? error.message : String(error);
        traces.push({
          index: sequence,
          command: commandPreview,
          requestBytes: reqBytes,
          responseBytes: 0,
          elapsedMs,
          error: message,
        });
        sequence += 1;

        const agg = summary.get(commandName) || {
          count: 0,
          requestBytes: 0,
          responseBytes: 0,
          elapsedMs: 0,
        };
        agg.count += 1;
        agg.requestBytes += reqBytes;
        agg.elapsedMs += elapsedMs;
        summary.set(commandName, agg);

        throw error;
      });
  };

  try {
    const startedAtMs = Date.now();
    const result = await runOpsOneShotPipeline({
      appName: args.appName,
      timeoutMs: 10_000,
      includeFly: false,
      includeTrendProjection: true,
      includeRecentJobs15m: true,
      includeRecentJobs24h: true,
      includePerformanceRollups: true,
      reconcileBullmqStatus: true,
    });

    const elapsedMs = Date.now() - startedAtMs;
    const totals = traces.reduce(
      (acc, trace) => {
        acc.requestBytes += trace.requestBytes;
        acc.responseBytes += trace.responseBytes;
        return acc;
      },
      { requestBytes: 0, responseBytes: 0 },
    );

    process.stdout.write(
      `[trace] refresh_done elapsed_ms=${elapsedMs} backlog=${result.snapshot.queue?.backlog ?? 0} status_reconciled=${result.statusReconciled}\n`,
    );
    process.stdout.write(
      `[trace] totals request_bytes=${totals.requestBytes} response_bytes=${totals.responseBytes} command_count=${traces.length}\n`,
    );

    const summaryRows = Array.from(summary.entries())
      .map(([command, value]) => ({ command, ...value }))
      .sort((a, b) => b.responseBytes - a.responseBytes);

    process.stdout.write(
      "[trace] command_summary (sorted by response bytes)\n",
    );
    for (const row of summaryRows) {
      process.stdout.write(
        `[trace] ${row.command} count=${row.count} request_bytes=${row.requestBytes} response_bytes=${row.responseBytes} elapsed_ms=${row.elapsedMs}\n`,
      );
    }

    const sampled = traces
      .slice()
      .sort((a, b) => b.responseBytes - a.responseBytes)
      .slice(0, args.sampleLimit);
    process.stdout.write(
      `[trace] top_commands sample_count=${sampled.length} (sorted by response bytes)\n`,
    );
    for (const row of sampled) {
      process.stdout.write(
        `[trace] #${row.index} request_bytes=${row.requestBytes} response_bytes=${row.responseBytes} elapsed_ms=${row.elapsedMs} error=${row.error || "none"} cmd=${row.command}\n`,
      );
    }
  } finally {
    Redis.prototype.sendCommand = originalSendCommand;
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[trace] failed: ${message}\n`);
    process.exit(1);
  });
