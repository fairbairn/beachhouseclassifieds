import "@/core/tooling/env/load-env-profile";

import Redis, { type Command } from "ioredis";

import {
  configureRedisTarget,
  createRedisConnection,
  type RedisTarget,
} from "../../workers/image-queue";
import {
  IMAGE_GROUP_QUEUE,
  imageMetricTrendKey,
} from "../workers/image-metrics-redis-keys";
import {
  readOpsSnapshotTrendRowsSince,
  runOpsOneShotPerformanceRefresh,
} from "../workers/image-ops-control-module";

type CliArgs = {
  redisTarget: RedisTarget;
  operation: "refresh" | "lua" | "both" | "check24h";
  sinceAtMsExclusive: number;
  limitPerMetric: number;
  iterations: number;
  intervalMs: number;
  luaWarmup: boolean;
  includeTraceRows: boolean;
  metricSlug: string;
  windowHours: number;
};

type CommandTrace = {
  operation: "refresh" | "lua" | "other";
  index: number;
  commandName: string;
  commandPreview: string;
  requestBytes: number;
  responseBytes: number;
  elapsedMs: number;
  error: string | null;
};

type Aggregated = {
  count: number;
  requestBytes: number;
  responseBytes: number;
  elapsedMs: number;
  maxElapsedMs: number;
};

type OperationTelemetry = {
  elapsedMs: number;
  commandCount: number;
  requestBytes: number;
  responseBytes: number;
  byCommand: Record<string, Aggregated>;
  traces: CommandTrace[];
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

  const operationRaw = String(options.get("operation") || "both")
    .trim()
    .toLowerCase();
  const operation =
    operationRaw === "refresh" ||
    operationRaw === "lua" ||
    operationRaw === "check24h"
      ? operationRaw
      : "both";

  const windowHours = Math.max(
    1,
    Math.min(24 * 30, parsePositiveInt(options.get("window-hours"), 24)),
  );

  return {
    redisTarget:
      (options.get("redis-target") as RedisTarget | undefined) || "cloud",
    operation,
    sinceAtMsExclusive: parsePositiveInt(
      options.get("since-at-ms-exclusive"),
      Math.max(0, Date.now() - 60_000),
    ),
    limitPerMetric: Math.max(
      1,
      Math.min(10_000, parsePositiveInt(options.get("limit-per-metric"), 20)),
    ),
    iterations: Math.max(
      1,
      Math.min(100, parsePositiveInt(options.get("iterations"), 1)),
    ),
    intervalMs: Math.max(
      0,
      Math.min(60_000, parsePositiveInt(options.get("interval-ms"), 5000)),
    ),
    luaWarmup: !String(options.get("lua-warmup") || "true")
      .trim()
      .toLowerCase()
      .startsWith("f"),
    includeTraceRows: String(options.get("trace-rows") || "false")
      .trim()
      .toLowerCase()
      .startsWith("t"),
    metricSlug:
      String(options.get("metric-slug") || "queue_backlog_live").trim() ||
      "queue_backlog_live",
    windowHours,
  };
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

function latestAtMsFromRows(
  rowsByMetric: Record<string, Array<{ atMs: number }>>,
): number {
  let maxAtMs = 0;
  for (const rows of Object.values(rowsByMetric)) {
    for (const row of rows || []) {
      if (Number.isFinite(row.atMs) && row.atMs > maxAtMs) {
        maxAtMs = row.atMs;
      }
    }
  }
  return maxAtMs;
}

function byteLen(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function respBulkStringBytes(value: string): number {
  return byteLen(`$${byteLen(value)}\r\n`) + byteLen(value) + 2;
}

function roughPayloadBytes(value: unknown): number {
  if (value === null || value === undefined) {
    return byteLen("$-1\r\n");
  }
  if (typeof value === "string") {
    return respBulkStringBytes(value);
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return byteLen(`:${String(value)}\r\n`);
  }
  if (typeof value === "boolean") {
    return byteLen(`:${value ? "1" : "0"}\r\n`);
  }
  if (Buffer.isBuffer(value)) {
    return byteLen(`$${value.length}\r\n`) + value.length + 2;
  }
  if (Array.isArray(value)) {
    let bytes = byteLen(`*${value.length}\r\n`);
    for (const entry of value) {
      bytes += roughPayloadBytes(entry);
    }
    return bytes;
  }
  try {
    const serialized = JSON.stringify(value);
    return respBulkStringBytes(serialized);
  } catch {
    return respBulkStringBytes(String(value));
  }
}

function requestBytesForCommand(commandName: string, args: unknown[]): number {
  const parts = [commandName, ...args.map((arg) => String(arg))];
  let bytes = byteLen(`*${parts.length}\r\n`);
  for (const arg of args) {
    const token = String(arg);
    bytes += byteLen(`$${byteLen(token)}\r\n`);
    bytes += byteLen(token);
    bytes += 2;
  }
  bytes += byteLen(`$${byteLen(commandName)}\r\n`);
  bytes += byteLen(commandName) + 2;
  return bytes;
}

function aggregateByCommand(
  traces: CommandTrace[],
): Record<string, Aggregated> {
  const out: Record<string, Aggregated> = {};
  for (const trace of traces) {
    const key = trace.commandName;
    const current = out[key] || {
      count: 0,
      requestBytes: 0,
      responseBytes: 0,
      elapsedMs: 0,
      maxElapsedMs: 0,
    };
    current.count += 1;
    current.requestBytes += trace.requestBytes;
    current.responseBytes += trace.responseBytes;
    current.elapsedMs += trace.elapsedMs;
    current.maxElapsedMs = Math.max(current.maxElapsedMs, trace.elapsedMs);
    out[key] = current;
  }
  return out;
}

function summarizeOperation(
  traces: CommandTrace[],
  elapsedMs: number,
): OperationTelemetry {
  const requestBytes = traces.reduce((sum, row) => sum + row.requestBytes, 0);
  const responseBytes = traces.reduce((sum, row) => sum + row.responseBytes, 0);

  return {
    elapsedMs,
    commandCount: traces.length,
    requestBytes,
    responseBytes,
    byCommand: aggregateByCommand(traces),
    traces,
  };
}

function filterByCommands(
  traces: CommandTrace[],
  commands: Set<string>,
): CommandTrace[] {
  return traces.filter((trace) => commands.has(trace.commandName));
}

function filterExcludingCommands(
  traces: CommandTrace[],
  commands: Set<string>,
): CommandTrace[] {
  return traces.filter((trace) => !commands.has(trace.commandName));
}

function printOperation(prefix: string, telemetry: OperationTelemetry): void {
  process.stdout.write(
    `[harness] ${prefix} elapsed_ms=${telemetry.elapsedMs} command_count=${telemetry.commandCount} request_bytes=${telemetry.requestBytes} response_bytes=${telemetry.responseBytes}\n`,
  );

  const rows = Object.entries(telemetry.byCommand)
    .map(([command, value]) => ({ command, ...value }))
    .sort((a, b) => b.responseBytes - a.responseBytes);

  for (const row of rows) {
    const avgElapsedMs =
      row.count > 0 ? Number((row.elapsedMs / row.count).toFixed(3)) : 0;
    process.stdout.write(
      `[harness] ${prefix} cmd=${row.command} count=${row.count} request_bytes=${row.requestBytes} response_bytes=${row.responseBytes} elapsed_ms_sum=${row.elapsedMs} elapsed_ms_avg=${avgElapsedMs} elapsed_ms_max=${row.maxElapsedMs}\n`,
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const redisSelection = configureRedisTarget(args.redisTarget);

  process.stdout.write(
    `[harness] start redis_target=${redisSelection.target} operation=${args.operation} since_at_ms_exclusive=${args.sinceAtMsExclusive} limit_per_metric=${args.limitPerMetric} iterations=${args.iterations} interval_ms=${args.intervalMs} lua_warmup=${args.luaWarmup} metric_slug=${args.metricSlug} window_hours=${args.windowHours}\n`,
  );

  const traces: CommandTrace[] = [];
  let commandIndex = 0;
  let currentOperation: "refresh" | "lua" | "other" = "other";

  const originalSendCommand = Redis.prototype.sendCommand;
  Redis.prototype.sendCommand = function patchedSendCommand(
    this: Redis,
    command: Command,
    stream?: unknown,
  ) {
    const commandName = String(command?.name || "unknown").toUpperCase();
    const commandArgs = Array.isArray(command?.args) ? command.args : [];
    const requestBytes = requestBytesForCommand(commandName, commandArgs);
    const startedAtMs = Date.now();

    return originalSendCommand
      .call(this, command, stream as never)
      .then((reply) => {
        traces.push({
          operation: currentOperation,
          index: commandIndex,
          commandName,
          commandPreview: `${commandName} ${commandArgs.map((arg) => String(arg)).join(" ")}`,
          requestBytes,
          responseBytes: roughPayloadBytes(reply),
          elapsedMs: Math.max(0, Date.now() - startedAtMs),
          error: null,
        });
        commandIndex += 1;
        return reply;
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        traces.push({
          operation: currentOperation,
          index: commandIndex,
          commandName,
          commandPreview: `${commandName} ${commandArgs.map((arg) => String(arg)).join(" ")}`,
          requestBytes,
          responseBytes: 0,
          elapsedMs: Math.max(0, Date.now() - startedAtMs),
          error: message,
        });
        commandIndex += 1;
        throw error;
      });
  };

  try {
    let refreshTelemetry: OperationTelemetry | null = null;
    let luaTelemetry: OperationTelemetry | null = null;
    const redis = createRedisConnection();

    // Establish/authenticate connection outside measured windows.
    currentOperation = "other";
    await redis.ping();

    if (args.operation === "check24h") {
      const key = imageMetricTrendKey(IMAGE_GROUP_QUEUE, args.metricSlug);
      const nowMs = Date.now();
      const windowMs = args.windowHours * 60 * 60 * 1000;
      const minAtMs = nowMs - windowMs;

      const total = await redis.zcard(key);
      const withinWindow = await redis.zcount(key, String(minAtMs), "+inf");
      const newest = await redis.zrevrangebyscore(
        key,
        "+inf",
        "-inf",
        "WITHSCORES",
        "LIMIT",
        0,
        1,
      );
      const oldestWithinWindow = await redis.zrangebyscore(
        key,
        String(minAtMs),
        "+inf",
        "WITHSCORES",
        "LIMIT",
        0,
        1,
      );

      process.stdout.write(
        `[harness] check24h key=${key} now_ms=${nowMs} min_at_ms=${minAtMs} window_hours=${args.windowHours} total=${total} within_window=${withinWindow}\n`,
      );
      process.stdout.write(
        `[harness] check24h newest=${JSON.stringify(newest)} oldest_within_window=${JSON.stringify(oldestWithinWindow)}\n`,
      );

      await redis.quit().catch(() => undefined);
      return;
    }

    if (args.operation === "lua" || args.operation === "both") {
      const startIndex = traces.length;
      const startedAtMs = Date.now();
      if (args.luaWarmup) {
        currentOperation = "other";
        await runOpsOneShotPerformanceRefresh({ redis }).catch(() => undefined);
      }

      currentOperation = "lua";
      const luaResult = await runOpsOneShotPerformanceRefresh({ redis });
      currentOperation = "other";

      const operationTraces = traces.slice(startIndex);
      luaTelemetry = summarizeOperation(
        operationTraces,
        Math.max(0, Date.now() - startedAtMs),
      );

      const coreCommands = new Set(["EVALSHA"]);
      const coreTraces = filterByCommands(operationTraces, coreCommands);
      const overheadTraces = filterExcludingCommands(
        operationTraces,
        coreCommands,
      );
      const coreTelemetry = summarizeOperation(
        coreTraces,
        luaTelemetry.elapsedMs,
      );
      const overheadTelemetry = summarizeOperation(
        overheadTraces,
        luaTelemetry.elapsedMs,
      );

      process.stdout.write(
        `[harness] lua rollup_computed_at=${luaResult.rollups.rollup15m.computedAt}\n`,
      );
      process.stdout.write(
        `[harness] lua core_evalsha round_trips=1 command_count=${coreTelemetry.commandCount} request_bytes=${coreTelemetry.requestBytes} response_bytes=${coreTelemetry.responseBytes} step_latency_ms=${coreTelemetry.elapsedMs}\n`,
      );
      process.stdout.write(
        `[harness] lua overhead command_count=${overheadTelemetry.commandCount} request_bytes=${overheadTelemetry.requestBytes} response_bytes=${overheadTelemetry.responseBytes}\n`,
      );
      printOperation("lua overall", luaTelemetry);
    }

    if (args.operation === "refresh" || args.operation === "both") {
      const refreshIterations =
        args.operation === "refresh" ? args.iterations : 1;
      let sinceAtMsExclusive = args.sinceAtMsExclusive;

      const coreLatencySamples: number[] = [];
      const coreRequestByteSamples: number[] = [];
      const coreResponseByteSamples: number[] = [];
      const coreCommandCountSamples: number[] = [];
      const overallLatencySamples: number[] = [];

      for (let runIndex = 1; runIndex <= refreshIterations; runIndex += 1) {
        const startIndex = traces.length;
        const startedAtMs = Date.now();
        currentOperation = "refresh";
        const refreshRows = await readOpsSnapshotTrendRowsSince({
          sinceAtMsExclusive,
          limitPerMetric: args.limitPerMetric,
          redis,
        });
        currentOperation = "other";

        const latestAtMs = latestAtMsFromRows(refreshRows);
        if (latestAtMs > sinceAtMsExclusive) {
          sinceAtMsExclusive = latestAtMs;
        }

        const operationTraces = traces.slice(startIndex);
        refreshTelemetry = summarizeOperation(
          operationTraces,
          Math.max(0, Date.now() - startedAtMs),
        );

        const coreCommands = new Set(["ZRANGEBYSCORE"]);
        const coreTraces = filterByCommands(operationTraces, coreCommands);
        const overheadTraces = filterExcludingCommands(
          operationTraces,
          coreCommands,
        );

        const pipelineTelemetry = summarizeOperation(
          coreTraces,
          refreshTelemetry.elapsedMs,
        );
        const overheadTelemetry = summarizeOperation(
          overheadTraces,
          refreshTelemetry.elapsedMs,
        );

        coreLatencySamples.push(pipelineTelemetry.elapsedMs);
        coreRequestByteSamples.push(pipelineTelemetry.requestBytes);
        coreResponseByteSamples.push(pipelineTelemetry.responseBytes);
        coreCommandCountSamples.push(pipelineTelemetry.commandCount);
        overallLatencySamples.push(refreshTelemetry.elapsedMs);

        const metricCount = Object.keys(refreshRows).length;
        process.stdout.write(
          `[harness] refresh run=${runIndex}/${refreshIterations} rows_by_metric=${metricCount} since_at_ms_exclusive=${sinceAtMsExclusive}\n`,
        );
        process.stdout.write(
          `[harness] refresh core_pipeline run=${runIndex}/${refreshIterations} round_trips=1 command_count=${pipelineTelemetry.commandCount} request_bytes=${pipelineTelemetry.requestBytes} response_bytes=${pipelineTelemetry.responseBytes} step_latency_ms=${pipelineTelemetry.elapsedMs}\n`,
        );
        process.stdout.write(
          `[harness] refresh overhead run=${runIndex}/${refreshIterations} command_count=${overheadTelemetry.commandCount} request_bytes=${overheadTelemetry.requestBytes} response_bytes=${overheadTelemetry.responseBytes}\n`,
        );
        printOperation(
          `refresh overall run=${runIndex}/${refreshIterations}`,
          refreshTelemetry,
        );

        if (runIndex < refreshIterations && args.intervalMs > 0) {
          await sleepMs(args.intervalMs);
        }
      }

      const avg = (values: number[]): number => {
        if (values.length === 0) {
          return 0;
        }
        return Number(
          (
            values.reduce((sum, value) => sum + value, 0) / values.length
          ).toFixed(3),
        );
      };

      process.stdout.write(
        `[harness] refresh avg runs=${refreshIterations} core_command_count_avg=${avg(coreCommandCountSamples)} core_request_bytes_avg=${avg(coreRequestByteSamples)} core_response_bytes_avg=${avg(coreResponseByteSamples)} core_step_latency_ms_avg=${avg(coreLatencySamples)} overall_latency_ms_avg=${avg(overallLatencySamples)}\n`,
      );
    }

    if (args.includeTraceRows) {
      process.stdout.write(`[harness] trace_rows count=${traces.length}\n`);
      for (const row of traces) {
        process.stdout.write(
          `[harness] trace #${row.index} op=${row.operation} cmd=${row.commandName} request_bytes=${row.requestBytes} response_bytes=${row.responseBytes} elapsed_ms=${row.elapsedMs} error=${row.error || "none"} ${row.commandPreview}\n`,
        );
      }
    }

    const refreshSummary =
      refreshTelemetry ||
      ({
        commandCount: 0,
        requestBytes: 0,
        responseBytes: 0,
        elapsedMs: 0,
      } as const);
    const luaSummary =
      luaTelemetry ||
      ({
        commandCount: 0,
        requestBytes: 0,
        responseBytes: 0,
        elapsedMs: 0,
      } as const);
    process.stdout.write(
      `[harness] done refresh_elapsed_ms=${refreshSummary.elapsedMs} refresh_command_count=${refreshSummary.commandCount} lua_elapsed_ms=${luaSummary.elapsedMs} lua_command_count=${luaSummary.commandCount}\n`,
    );

    await redis.quit().catch(() => undefined);
  } finally {
    Redis.prototype.sendCommand = originalSendCommand;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[harness] failed: ${message}\n`);
  process.exit(1);
});
