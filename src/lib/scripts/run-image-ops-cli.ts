import "@/core/tooling/env/load-env-profile";

import { createInterface } from "node:readline/promises";

import chalk from "chalk";
import Table from "cli-table3";

import {
  configureRedisTarget,
  type RedisTarget,
} from "../../workers/image-queue";
import {
  clearOpsQueueIfPaused,
  createOpsUiStateWatcher,
  maybePurgeForDesiredMode,
  OPS_UI_METRIC_LABELS,
  pauseOpsSystemFlow,
  readOpsControlSettings,
  readOpsControlSnapshot,
  readOpsFlyAppSnapshot,
  readOpsQueuePausedState,
  readOpsQueueSnapshot,
  readOpsRedisIoStats,
  refreshOpsInfraFromFly,
  resetOpsRedisIoStats,
  resumeOpsSystemFlow,
  scaleOpsWorkers,
  setOpsDesiredModeWithQueueAction,
  updateOpsControlSettings,
  writeOpsControlSettings,
  type OpsRedisIoAggregateStats,
  type OpsRedisIoStats,
  type OpsUiSnapshot,
  type OpsUiStateWatcher,
} from "../workers/image-ops-control-module";
import { deriveOpsTelemetry } from "../workers/image-ops-state-machine";
import {
  type RunnerControlSettings,
  type RunnerDesiredMode,
  type RunnerInfraSnapshot,
  type RunnerStatusSnapshot,
} from "../workers/image-runner-control";

const DEFAULT_APP = "beachhouseclassifieds-image-worker";
const STARTUP_SNAPSHOT_TIMEOUT_MS = 1500;
const UI_LABELS = OPS_UI_METRIC_LABELS;

type Command =
  | "dashboard"
  | "telemetry-dump"
  | "fly-scale"
  | "fly-stop-all"
  | "fly-status"
  | "start-run"
  | "drain-and-scale-down"
  | "control-show"
  | "control-set"
  | "pause-system"
  | "resume-system"
  | "clear-queue"
  | "redis-io-reset"
  | "help";

type ParsedArgs = {
  command: Command;
  options: Map<string, string>;
  flags: Set<string>;
};

type QueueCounts = NonNullable<OpsUiSnapshot["queue"]>;

type DashboardSample = {
  atMs: number;
  queueBacklog: number;
  queueActive: number;
  processedItems: number;
  failedItems: number;
  totalMachines: number;
  runnerUpdatedAt: string | null;
};

type DashboardSnapshot = {
  machines: OpsUiSnapshot["machines"];
  queue: QueueCounts | null;
  recentJobs15m: OpsUiSnapshot["recentJobs15m"];
  recentJobs24h: OpsUiSnapshot["recentJobs24h"];
  queuePaused?: boolean | null;
  db: OpsUiSnapshot["db"];
  settings: RunnerControlSettings | null;
  infra: RunnerInfraSnapshot | null;
  status: RunnerStatusSnapshot | null;
  redisIoAggregate?: OpsRedisIoAggregateStats;
  redisIoInstances?: OpsUiSnapshot["redisIoInstances"];
  projections: OpsUiSnapshot["projections"];
  errors: OpsUiSnapshot["errors"];
};

type TopUiState = {
  running: boolean;
  showHelp: boolean;
  intervalSeconds: number;
  notice: string;
  samples: DashboardSample[];
  isPrompting: boolean;
};

function usage(): string {
  return [
    "Image Ops Control Tower",
    "",
    "Usage:",
    "  (global) add --redis-target local|cloud to any command (default local; cloud uses FLY_REDIS)",
    "  npm run workers:image:ops -- dashboard [--watch] [--top] [--interval-seconds 1] [--app <flyApp>]",
    "  npm run workers:image:ops -- telemetry-dump [--app <flyApp>]",
    "      top watch keys: q quit, h help, s settings, : command, + slower, - faster, r reset trends",
    "  npm run workers:image:ops -- fly-scale --count <n> [--app <flyApp>]",
    "  npm run workers:image:ops -- fly-stop-all [--app <flyApp>]",
    "  npm run workers:image:ops -- fly-status [--app <flyApp>]",
    "  npm run workers:image:ops -- start-run --count <n> [--app <flyApp>]",
    "  npm run workers:image:ops -- drain-and-scale-down [--timeout-seconds 900] [--poll-seconds 5] [--app <flyApp>]",
    "  npm run workers:image:ops -- control-show",
    "  npm run workers:image:ops -- control-set [--desired-mode run|idle|drain|stop] [--enqueue-enabled true|false] [--require-workers-for-enqueue true|false] [--min-workers-to-enqueue <n>] [--flush-interval-ms <n>] [--harvest-enabled true|false]",
    "  npm run workers:image:ops -- control-set [--desired-mode run|idle|drain|stop] [--enqueue-enabled true|false] [--require-workers-for-enqueue true|false] [--min-workers-to-enqueue <n>] [--max-queue-backlog <n>] [--refill-low-watermark <n>] [--refill-target-backlog <n>] [--max-claim-per-cycle <n>] [--flush-interval-ms <n>] [--harvest-enabled true|false]",
    "  npm run workers:image:ops -- pause-system",
    "  npm run workers:image:ops -- resume-system",
    "  npm run workers:image:ops -- clear-queue",
    "  npm run workers:image:ops -- redis-io-reset",
  ].join("\n");
}

function parseRedisTargetOption(options: Map<string, string>): RedisTarget {
  const raw = options.get("redis-target")?.trim().toLowerCase();
  if (!raw) {
    return "local";
  }
  if (raw === "local" || raw === "cloud") {
    return raw;
  }
  throw new Error(
    `invalid --redis-target: ${options.get("redis-target")}. Use local or cloud.`,
  );
}

function parseArgs(argv: string[]): ParsedArgs {
  const raw = (argv[0] || "help").trim().toLowerCase();
  const command: Command =
    raw === "dashboard" ||
    raw === "telemetry-dump" ||
    raw === "fly-scale" ||
    raw === "fly-stop-all" ||
    raw === "fly-status" ||
    raw === "start-run" ||
    raw === "drain-and-scale-down" ||
    raw === "control-show" ||
    raw === "control-set" ||
    raw === "pause-system" ||
    raw === "resume-system" ||
    raw === "clear-queue" ||
    raw === "redis-io-reset"
      ? raw
      : "help";

  const options = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      options.set(key, next);
      i += 1;
      continue;
    }
    flags.add(key);
  }

  return { command, options, flags };
}

function appName(options: Map<string, string>): string {
  return options.get("app")?.trim() || DEFAULT_APP;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(raw || "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseNonNegativeInt(
  raw: string | undefined,
  fallback: number,
): number {
  const parsed = Number.parseInt(String(raw || "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function parseBoolean(raw: string | undefined): boolean | null {
  if (!raw) {
    return null;
  }
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return null;
}

function clearScreen(): void {
  process.stdout.write("\x1Bc");
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function fixedOne(value: number): string {
  return (Math.round(value * 10) / 10).toFixed(1);
}

function fixedTwo(value: number): string {
  return (Math.round(value * 100) / 100).toFixed(2);
}

function formatMaybeNumber(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "n/a";
  }
  return fixedTwo(value);
}

function deriveWindowPerformance(window: OpsUiSnapshot["recentJobs24h"]): {
  completedJobs: number;
  failedJobs: number;
  processedItems: number;
  failedItems: number;
  ips: number;
  ipm: number;
  secPerImage: number | null;
  avgFetchMs: number;
  avgTransformMs: number;
  avgUploadMs: number;
  avgEndToEndMs: number;
} | null {
  if (!window) {
    return null;
  }

  const completedJobs = Math.max(0, Number(window.completedJobs || 0));
  const failedJobs = Math.max(0, Number(window.failedJobs || 0));
  const processedItems = Math.max(0, Number(window.processedItems || 0));
  const failedItems = Math.max(0, Number(window.failedItems || 0));
  const windowSeconds = Math.max(1, Number(window.windowMs || 0) / 1000);
  const ips = processedItems / windowSeconds;
  const ipm = ips * 60;
  const secPerImage = ips > 0 ? 1 / ips : null;

  return {
    completedJobs,
    failedJobs,
    processedItems,
    failedItems,
    ips,
    ipm,
    secPerImage,
    avgFetchMs: Math.max(0, Number(window.avgFetchMs || 0)),
    avgTransformMs: Math.max(0, Number(window.avgTransformMs || 0)),
    avgUploadMs: Math.max(0, Number(window.avgUploadMs || 0)),
    avgEndToEndMs: Math.max(0, Number(window.avgEndToEndMs || 0)),
  };
}

function formatBitrateFromKbps(kbps: number): string {
  const safeKbps = Number.isFinite(kbps) && kbps > 0 ? kbps : 0;
  const bps = safeKbps * 1000;
  if (bps < 1000) {
    return `${bps.toFixed(1)} bps`;
  }
  if (bps < 1_000_000) {
    return `${(bps / 1000).toFixed(1)} Kbps`;
  }
  return `${(bps / 1_000_000).toFixed(2)} Mbps`;
}

function takeTail<T>(values: T[], max: number): T[] {
  if (values.length <= max) {
    return values;
  }
  return values.slice(values.length - max);
}

function renderTrend(values: number[], width = 36): string {
  const symbols = ".:-=+*#%@";
  if (values.length === 0) {
    return "-";
  }

  const clipped = takeTail(values, width);
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of clipped) {
    min = Math.min(min, value);
    max = Math.max(max, value);
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return "-";
  }

  if (max <= min) {
    return "=".repeat(clipped.length);
  }

  return clipped
    .map((value) => {
      const ratio = clamp((value - min) / (max - min), 0, 1);
      const index = Math.floor(ratio * (symbols.length - 1));
      return symbols[index];
    })
    .join("");
}

function shortError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function fetchQueueCounts(): Promise<QueueCounts> {
  return readOpsQueueSnapshot();
}

async function fetchControlSnapshot(): Promise<{
  settings: RunnerControlSettings;
  infra: RunnerInfraSnapshot | null;
  status: RunnerStatusSnapshot | null;
}> {
  return readOpsControlSnapshot();
}

async function gatherDashboardSnapshot(
  app: string,
  input?: {
    snapshotTimeoutMs?: number;
    waitForStateMs?: number;
  },
): Promise<DashboardSnapshot> {
  const snapshotTimeoutMs = Math.max(
    1000,
    input?.snapshotTimeoutMs ?? STARTUP_SNAPSHOT_TIMEOUT_MS,
  );
  const waitForStateMs = Math.max(500, input?.waitForStateMs ?? 1500);

  const watcher = await createOpsUiStateWatcher({
    appName: app,
    snapshotTimeoutMs,
    skipInitialRefresh: false,
    profile: "cli",
  });
  try {
    const snapshot = watcher.getSnapshot();
    if (snapshot) {
      return snapshot;
    }
    await watcher.waitForState(waitForStateMs);
    const next = watcher.getSnapshot();
    if (!next) {
      throw new Error("module state snapshot unavailable");
    }
    return next;
  } finally {
    await watcher.close();
  }
}

function emptyRedisAggregate(): OpsRedisIoAggregateStats {
  return {
    sampledAt: new Date().toISOString(),
    activeInstances: 0,
    redisEgressBytes: 0,
    redisIngressBytes: 0,
    redisIngressReads: 0,
    redisEgressWrites: 0,
    redisEgressKbps: 0,
    redisIngressKbps: 0,
    redisWireKbps: 0,
    rxLatencyMs: 0,
    txLatencyMs: 0,
  };
}

function renderSnapshotDashboard(params: {
  app: string;
  watch: boolean;
  intervalSeconds: number;
  snapshot: DashboardSnapshot;
}): void {
  const { app, watch, intervalSeconds, snapshot } = params;
  const telemetry = deriveOpsTelemetry({
    settings: snapshot.settings,
    infra: snapshot.infra,
    status: snapshot.status,
    queue: snapshot.queue,
    errors: snapshot.errors,
  });
  const aggregate = snapshot.redisIoAggregate || emptyRedisAggregate();

  process.stdout.write(chalk.bold.cyan("Image Control Tower\n"));
  process.stdout.write(
    chalk.gray(`${new Date().toISOString()} app=${app}\n\n`),
  );
  process.stdout.write(
    chalk.gray(
      `watch=${watch} interval=${intervalSeconds}s source=module-state\n\n`,
    ),
  );
  process.stdout.write(
    `queue backlog=${snapshot.queue?.backlog ?? 0} waiting=${snapshot.queue?.waiting ?? 0} ${UI_LABELS.queue.active}=${snapshot.queue?.active ?? 0} delayed=${snapshot.queue?.delayed ?? 0} paused=${snapshot.queue?.paused ?? 0} queue_paused=${snapshot.queuePaused === null || snapshot.queuePaused === undefined ? "unknown" : String(snapshot.queuePaused)}\n`,
  );
  const perf15m = deriveWindowPerformance(snapshot.recentJobs15m);
  const perf24h = deriveWindowPerformance(snapshot.recentJobs24h);
  process.stdout.write(
    `perf_15m ${UI_LABELS.image.ipm}=${formatMaybeNumber(perf15m?.ipm ?? null)} ${UI_LABELS.image.ips}=${formatMaybeNumber(perf15m?.ips ?? null)} sec_per_image=${formatMaybeNumber(perf15m?.secPerImage ?? null)} jobs=${perf15m?.completedJobs ?? 0}/${perf15m?.failedJobs ?? 0} ${UI_LABELS.image.avgFetchMs}=${perf15m?.avgFetchMs ?? 0} ${UI_LABELS.image.avgTransformMs}=${perf15m?.avgTransformMs ?? 0} ${UI_LABELS.image.avgUploadMs}=${perf15m?.avgUploadMs ?? 0} avg_end_to_end_ms=${perf15m?.avgEndToEndMs ?? 0}\n`,
  );
  process.stdout.write(
    `perf_24h ${UI_LABELS.image.ipm}=${formatMaybeNumber(perf24h?.ipm ?? null)} ${UI_LABELS.image.ips}=${formatMaybeNumber(perf24h?.ips ?? null)} sec_per_image=${formatMaybeNumber(perf24h?.secPerImage ?? null)} jobs=${perf24h?.completedJobs ?? 0}/${perf24h?.failedJobs ?? 0} ${UI_LABELS.image.avgFetchMs}=${perf24h?.avgFetchMs ?? 0} ${UI_LABELS.image.avgTransformMs}=${perf24h?.avgTransformMs ?? 0} ${UI_LABELS.image.avgUploadMs}=${perf24h?.avgUploadMs ?? 0} avg_end_to_end_ms=${perf24h?.avgEndToEndMs ?? 0}\n`,
  );
  process.stdout.write(
    `runner mode=${snapshot.status?.mode || "n/a"} desired_mode=${snapshot.settings?.desiredMode || "n/a"} gate=${telemetry.liveGate} workers_running=${telemetry.liveWorkersRunning}\n`,
  );
  process.stdout.write(
    `db processed=${snapshot.db?.processed ?? 0} pending=${snapshot.db?.pending ?? 0} total=${snapshot.db?.total ?? 0} progress_pct=${(snapshot.db?.pct ?? 0).toFixed(2)}\n`,
  );
  process.stdout.write(
    `redis_io aggregate wire=${formatBitrateFromKbps(aggregate.redisWireKbps)} rx=${formatBitrateFromKbps(aggregate.redisIngressKbps)} tx=${formatBitrateFromKbps(aggregate.redisEgressKbps)} instances=${aggregate.activeInstances} reads=${aggregate.redisIngressReads} writes=${aggregate.redisEgressWrites} rx_latency=${aggregate.rxLatencyMs}ms tx_latency=${aggregate.txLatencyMs}ms\n`,
  );
}

async function panelFly(app: string): Promise<void> {
  const snapshot = await readOpsFlyAppSnapshot(app);
  const machines = snapshot.machines;
  const byState = new Map<string, number>();
  const activeStates = new Set([
    "started",
    "starting",
    "stopping",
    "restarting",
    "created",
    "suspended",
  ]);
  const activeMachines = machines.filter((machine) =>
    activeStates.has(String(machine.state || "").toLowerCase()),
  );
  const destroyedMachines = machines.filter(
    (machine) => String(machine.state || "").toLowerCase() === "destroyed",
  );
  for (const machine of machines) {
    const state = String(machine.state || "unknown").toLowerCase();
    byState.set(state, (byState.get(state) || 0) + 1);
  }

  const table = new Table({
    head: ["Fly State", "Count"],
    style: { head: ["cyan"] },
  });
  for (const [state, count] of [...byState.entries()].sort(
    (a, b) => b[1] - a[1],
  )) {
    table.push([state, count]);
  }

  process.stdout.write(
    chalk.cyan(`Fly App: ${snapshot.appName} app_id=${snapshot.appId}\n`),
  );
  process.stdout.write(`${table.toString()}\n`);
  process.stdout.write(
    chalk.gray(
      `total_machines=${machines.length} active_machines=${activeMachines.length} destroyed_machines=${destroyedMachines.length}\n`,
    ),
  );

  const machineTable = new Table({
    head: ["Machine ID", "Name", "State", "Region"],
    style: { head: ["cyan"] },
  });
  for (const machine of machines) {
    machineTable.push([
      machine.id || "-",
      machine.name || "-",
      machine.state || "unknown",
      machine.region || "-",
    ]);
  }
  process.stdout.write(`${machineTable.toString()}\n`);
}

async function panelControl(): Promise<void> {
  const { settings, infra, status } = await fetchControlSnapshot();
  let liveQueue: QueueCounts | null = null;
  let liveQueueError: string | null = null;
  let queueGloballyPaused: boolean | null = null;
  let queuePauseError: string | null = null;
  try {
    liveQueue = await fetchQueueCounts();
  } catch (error) {
    liveQueueError = shortError(error);
  }
  try {
    queueGloballyPaused = await readOpsQueuePausedState();
  } catch (error) {
    queuePauseError = shortError(error);
  }

  const settingsTable = new Table({
    head: ["Control Setting", "Value"],
    style: { head: ["cyan"] },
  });
  settingsTable.push(
    ["desired_mode", settings.desiredMode],
    ["enqueue_enabled", settings.enqueueEnabled],
    ["require_workers_for_enqueue", settings.requireWorkersForEnqueue],
    ["min_workers_to_enqueue", settings.minWorkersToEnqueue],
    ["max_queue_backlog", settings.maxQueueBacklog],
    ["refill_low_watermark", settings.refillLowWatermark],
    ["refill_target_backlog", settings.refillTargetBacklog],
    ["max_claim_per_cycle", settings.maxClaimPerCycle],
    ["flush_interval_ms", settings.flushIntervalMs],
    ["harvest_enabled", settings.harvestEnabled],
    [
      "queue_globally_paused",
      queueGloballyPaused === null ? "unknown" : queueGloballyPaused,
    ],
  );
  process.stdout.write(`${settingsTable.toString()}\n`);

  const infraTable = new Table({
    head: ["Infra Signal", "Value"],
    style: { head: ["cyan"] },
  });
  infraTable.push(
    ["workers_running", infra?.workersRunning ?? 0],
    ["source", infra?.source ?? "none"],
    ["updated_at", infra?.updatedAt ?? "-"],
  );
  process.stdout.write(`${infraTable.toString()}\n`);

  const queueTable = new Table({
    head: ["Queue Source", "Waiting", "Active", "Delayed", "Backlog"],
    style: { head: ["cyan"] },
  });
  queueTable.push([
    "live",
    liveQueue?.waiting ?? "n/a",
    liveQueue?.active ?? "n/a",
    liveQueue?.delayed ?? "n/a",
    liveQueue?.backlog ?? "n/a",
  ]);
  process.stdout.write(`${queueTable.toString()}\n`);
  if (liveQueueError) {
    process.stdout.write(
      chalk.yellow(`live queue unavailable: ${liveQueueError}\n`),
    );
  }
  if (queuePauseError) {
    process.stdout.write(
      chalk.yellow(`queue pause state unavailable: ${queuePauseError}\n`),
    );
  }

  if (!status) {
    process.stdout.write(
      chalk.yellow("No runner status has been published yet\n"),
    );
    return;
  }

  const statusTable = new Table({
    head: ["Runner Snapshot Metric", "Value"],
    style: { head: ["cyan"] },
  });
  const gateState = status.gateReason === "gate=open" ? "open" : "blocked";
  statusTable.push(
    ["snapshot_operation_id", status.operationId],
    ["snapshot_mode", status.mode],
    ["snapshot_desired_mode", status.desiredMode],
    ["snapshot_gate_state", gateState],
    ["snapshot_gate_reason", status.gateReason || "-"],
    ["snapshot_workers_running", status.workersRunning],
    ["snapshot_claimed_count", status.claimedCount],
    ["snapshot_queued_count", status.queuedCount],
    ["snapshot_completed_jobs", status.completedJobs],
    ["snapshot_failed_jobs", status.failedJobs],
    ["snapshot_processed_items", status.processedItems],
    ["snapshot_failed_items", status.failedItems],
    ["snapshot_queue_waiting", status.queueWaiting],
    ["snapshot_queue_active", status.queueActive],
    ["snapshot_queue_completed", status.queueCompleted],
    ["snapshot_queue_failed", status.queueFailed],
    ["snapshot_queue_delayed", status.queueDelayed],
    ["snapshot_queue_paused", status.queuePaused],
    ["snapshot_queue_backlog", status.queueBacklog],
    ["snapshot_pending_success_buffer", status.pendingSuccessBuffer],
    ["snapshot_pending_error_buffer", status.pendingErrorBuffer],
    ["snapshot_last_flush_at", status.lastFlushAt || "-"],
    ["snapshot_updated_at", status.updatedAt],
  );
  process.stdout.write(`${statusTable.toString()}\n`);

  const telemetry = deriveOpsTelemetry({
    settings,
    infra,
    status,
    queue: liveQueue,
    errors: {},
  });
  if (
    telemetry.runnerStaleSeconds !== null &&
    telemetry.runnerStaleSeconds > 30
  ) {
    process.stdout.write(
      chalk.yellow(
        `runner status is stale: age_ms=${telemetry.runnerStaleSeconds * 1000}\n`,
      ),
    );
  }
  if (telemetry.backlogMismatch) {
    process.stdout.write(
      chalk.yellow(
        `queue mismatch: live_backlog=${liveQueue.backlog} status_backlog=${status.queueBacklog}\n`,
      ),
    );
  }
}

async function runTelemetryDump(args: ParsedArgs): Promise<void> {
  const app = appName(args.options);
  const snapshot = await gatherDashboardSnapshot(app, {
    snapshotTimeoutMs: 8000,
    waitForStateMs: 8000,
  });
  const telemetry = deriveOpsTelemetry({
    settings: snapshot.settings,
    infra: snapshot.infra,
    status: snapshot.status,
    queue: snapshot.queue,
    errors: snapshot.errors,
  });

  const payload = {
    generatedAt: new Date().toISOString(),
    app,
    sources: {
      settings: snapshot.settings,
      infra: snapshot.infra,
      status: snapshot.status,
      queue: snapshot.queue,
      recentJobs15m: snapshot.recentJobs15m,
      recentJobs24h: snapshot.recentJobs24h,
      db: snapshot.db,
      errors: snapshot.errors,
    },
    derived: telemetry,
  };

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function renderTopLikeDashboard(params: {
  app: string;
  watch: boolean;
  ui: TopUiState;
  snapshot: DashboardSnapshot;
  redisIo: OpsRedisIoStats;
  redisIoAggregate: OpsRedisIoAggregateStats;
}): void {
  const { app, watch, ui, snapshot, redisIo, redisIoAggregate } = params;
  const { intervalSeconds } = ui;
  const byState = new Map<string, number>();
  for (const machine of snapshot.machines || []) {
    const state = String(machine.state || "unknown").toLowerCase();
    byState.set(state, (byState.get(state) || 0) + 1);
  }

  const status = snapshot.status;
  const projection = snapshot.projections;
  const ratePerMin = projection.headline.ipmAvg30;

  const backlogTrend = renderTrend(projection.queueBacklogTrendSmoothed);
  const processedTrend = renderTrend(projection.processedItemsTrend);
  const failedTrend = renderTrend(projection.failedItemsTrend);

  const machineStates = [...byState.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([stateName, count]) => `${stateName}:${count}`)
    .join(" ");

  process.stdout.write(chalk.bold.cyan("Image Control Tower (top mode)\n"));
  process.stdout.write(chalk.gray(`${new Date().toISOString()}\n`));
  process.stdout.write(
    chalk.gray(
      `watch=${watch} interval=${intervalSeconds}s samples=${projection.sampleCount || samples.length} app=${app}\n\n`,
    ),
  );
  process.stdout.write(
    chalk.gray(
      `redis_io aggregate: wire=${formatBitrateFromKbps(redisIoAggregate.redisWireKbps)} rx=${formatBitrateFromKbps(redisIoAggregate.redisIngressKbps)} tx=${formatBitrateFromKbps(redisIoAggregate.redisEgressKbps)} instances=${redisIoAggregate.activeInstances} reads=${redisIoAggregate.redisIngressReads} writes=${redisIoAggregate.redisEgressWrites} rx_latency=${redisIoAggregate.rxLatencyMs}ms tx_latency=${redisIoAggregate.txLatencyMs}ms\n` +
        `redis_io local: wire=${formatBitrateFromKbps(redisIo.redisWireKbps)} rx=${formatBitrateFromKbps(redisIo.redisIngressKbps)} tx=${formatBitrateFromKbps(redisIo.redisEgressKbps)} reads=${redisIo.redisIngressReads} writes=${redisIo.redisEgressWrites} rx_latency=${redisIo.rxLatencyMs}ms tx_latency=${redisIo.txLatencyMs}ms last_read_at=${redisIo.lastReadAt || "-"}\n\n`,
    ),
  );

  if (ui.notice) {
    process.stdout.write(chalk.yellow(`notice: ${ui.notice}\n\n`));
  }

  if (ui.showHelp) {
    process.stdout.write(
      chalk.gray(
        "keys: q quit | h toggle-help | s settings prompt | : command prompt | + slower refresh | - faster refresh | r reset trends\n",
      ),
    );
    process.stdout.write(
      chalk.gray(
        "cmd: 5 | scale 5 | run|idle|drain|stop | pause | resume | set flush 15000 | set harvest on/off\n\n",
      ),
    );
  }

  process.stdout.write(chalk.bold("Settings\n"));
  if (!snapshot.settings) {
    process.stdout.write(
      `unavailable (${snapshot.errors.control || "control source unreachable"})\n\n`,
    );
  } else {
    process.stdout.write(
      `desired_mode=${snapshot.settings.desiredMode} enqueue_enabled=${snapshot.settings.enqueueEnabled} workers_gate=${snapshot.settings.requireWorkersForEnqueue} min_workers=${snapshot.settings.minWorkersToEnqueue} max_backlog=${snapshot.settings.maxQueueBacklog} refill_low=${snapshot.settings.refillLowWatermark} refill_target=${snapshot.settings.refillTargetBacklog} max_claim_cycle=${snapshot.settings.maxClaimPerCycle} flush_interval_ms=${snapshot.settings.flushIntervalMs} harvest_enabled=${snapshot.settings.harvestEnabled}\n\n`,
    );
  }

  process.stdout.write(chalk.bold("Infra\n"));
  if (!snapshot.machines) {
    process.stdout.write(
      `machines unavailable (${snapshot.errors.fly || "no response"})\n`,
    );
  } else {
    process.stdout.write(
      `machines_total=${snapshot.machines.length} ${machineStates || "states=none"}\n`,
    );
  }

  if (!snapshot.queue) {
    process.stdout.write(
      `queue unavailable (${snapshot.errors.queue || "no response"})\n`,
    );
  } else {
    process.stdout.write(
      `queue waiting=${snapshot.queue.waiting} ${UI_LABELS.queue.active}=${snapshot.queue.active} delayed=${snapshot.queue.delayed} paused=${snapshot.queue.paused} backlog=${snapshot.queue.backlog}\n`,
    );
    process.stdout.write(
      `queue totals ${UI_LABELS.queue.completed}=${snapshot.queue.completed} ${UI_LABELS.queue.failed}=${snapshot.queue.failed}\n`,
    );
    process.stdout.write(`queue backlog trend  ${backlogTrend}\n`);
  }
  process.stdout.write("\n");

  process.stdout.write(chalk.bold("Progress\n"));
  if (!status) {
    process.stdout.write("runner_status=none\n");
  } else {
    const gateState = status.gateReason === "gate=open" ? "open" : "blocked";
    process.stdout.write(
      `operation=${status.operationId} mode=${status.mode} updated_at=${status.updatedAt}\n`,
    );
    process.stdout.write(
      `desired_mode=${status.desiredMode} gate_state=${gateState} workers_running=${status.workersRunning} gate_reason=${status.gateReason || "-"}\n`,
    );
    process.stdout.write(
      `jobs ${UI_LABELS.queue.completed}=${status.completedJobs} ${UI_LABELS.queue.failed}=${status.failedJobs} queued=${status.queuedCount} claimed=${status.claimedCount}\n`,
    );
    process.stdout.write(
      `items ${UI_LABELS.image.processed}=${status.processedItems} ${UI_LABELS.image.failed}=${status.failedItems} rate=${fixedOne(ratePerMin)} images/min smoothed=${fixedOne(projection.headline.ipsSmoothedNow * 60)} avg30=${fixedOne(projection.headline.ipmAvg30)}\n`,
    );
    process.stdout.write(
      `buffers success=${status.pendingSuccessBuffer} error=${status.pendingErrorBuffer} flush_batches=${status.flushBatchCount} last_flush_at=${status.lastFlushAt || "-"}\n`,
    );
  }
  process.stdout.write(`items processed trend ${processedTrend}\n`);
  process.stdout.write(`items failed trend    ${failedTrend}\n\n`);

  process.stdout.write(chalk.bold("Database\n"));
  if (!snapshot.db) {
    if (snapshot.errors.db) {
      process.stdout.write(`db unavailable (${snapshot.errors.db})\n`);
    } else {
      process.stdout.write("DATABASE_URL missing; db panel unavailable\n");
    }
  } else {
    process.stdout.write(
      `processed=${snapshot.db.processed} pending=${snapshot.db.pending} failed=${snapshot.db.failed} total=${snapshot.db.total} progress=${snapshot.db.pct.toFixed(2)}%\n`,
    );
  }
}

async function promptTopSettings(ui: TopUiState): Promise<void> {
  const current = await readOpsControlSettings();
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    process.stdout.write("\n");
    const flushRaw = await rl.question(
      `flush_interval_ms [${current.flushIntervalMs}]: `,
    );
    const harvestRaw = await rl.question(
      `harvest_enabled true|false [${current.harvestEnabled}]: `,
    );

    const next: RunnerControlSettings = {
      ...current,
      flushIntervalMs: flushRaw.trim()
        ? Math.max(
            1000,
            Math.min(
              60000,
              parsePositiveInt(flushRaw, current.flushIntervalMs),
            ),
          )
        : current.flushIntervalMs,
      harvestEnabled: harvestRaw.trim()
        ? (parseBoolean(harvestRaw) ?? current.harvestEnabled)
        : current.harvestEnabled,
    };

    await writeOpsControlSettings(next);
    ui.notice = `settings updated: flush_interval_ms=${next.flushIntervalMs} harvest_enabled=${next.harvestEnabled}`;
  } finally {
    rl.close();
  }
}

async function promptTopCommand(ui: TopUiState, app: string): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    process.stdout.write("\n");
    const raw = (await rl.question("command (? for help): ")).trim();
    const lower = raw.toLowerCase();

    if (!raw) {
      ui.notice = "command cancelled";
      return;
    }

    if (lower === "?" || lower === "help") {
      ui.notice =
        "commands: 5 | scale 5 | run|idle|drain|stop | pause | resume | clear | set flush 15000 | set harvest on/off";
      return;
    }

    if (/^\d+$/.test(lower)) {
      const count = parsePositiveInt(lower, -1);
      if (count < 0) {
        ui.notice = `invalid worker count: ${raw}`;
        return;
      }
      await scaleOpsWorkers(app, count);
      await publishInfraSnapshotFromFly(app);
      ui.notice = `scaled workers to ${count}`;
      return;
    }

    if (
      lower.startsWith("scale ") ||
      lower.startsWith("workers ") ||
      lower.startsWith("w ")
    ) {
      const countRaw = lower
        .replace(/^scale\s+/, "")
        .replace(/^workers\s+/, "")
        .replace(/^w\s+/, "")
        .trim();
      const count = parsePositiveInt(countRaw, -1);
      if (count < 0) {
        ui.notice = `invalid worker count: ${countRaw}`;
        return;
      }
      await scaleOpsWorkers(app, count);
      await publishInfraSnapshotFromFly(app);
      ui.notice = `scaled workers to ${count}`;
      return;
    }

    if (
      lower === "run" ||
      lower === "idle" ||
      lower === "drain" ||
      lower === "stop"
    ) {
      const next = await setDesiredMode(lower as RunnerDesiredMode);
      ui.notice = `desired_mode=${next.desiredMode}`;
      return;
    }

    if (lower === "pause") {
      const result = await pauseOpsSystemFlow();
      ui.notice = `system paused: desired_mode=${result.settings.desiredMode} enqueue_enabled=${result.settings.enqueueEnabled} queue_paused=${result.queuePaused}`;
      return;
    }

    if (lower === "resume") {
      const result = await resumeOpsSystemFlow();
      ui.notice = `system resumed: desired_mode=${result.settings.desiredMode} enqueue_enabled=${result.settings.enqueueEnabled} queue_paused=${result.queuePaused}`;
      return;
    }

    if (lower === "clear" || lower === "clear-queue") {
      const result = await clearOpsQueueIfPaused();
      ui.notice =
        `queue cleared: queue_paused=${result.queuePaused} ` +
        `purged=${result.purge.removed} waiting=${result.purge.remainingWaiting} ` +
        `delayed=${result.purge.remainingDelayed} paused=${result.purge.remainingPaused} active=${result.purge.remainingActive}`;
      return;
    }

    if (lower.startsWith("set flush ")) {
      const flushRaw = lower.replace("set flush ", "").trim();
      const flushMs = parsePositiveInt(flushRaw, -1);
      if (flushMs <= 0) {
        ui.notice = `invalid flush ms: ${flushRaw}`;
        return;
      }

      const next = await updateOpsControlSettings((current) => ({
        ...current,
        flushIntervalMs: Math.max(1000, Math.min(60000, flushMs)),
      }));
      ui.notice = `flush_interval_ms=${next.flushIntervalMs}`;
      return;
    }

    if (lower === "set harvest on" || lower === "set harvest off") {
      const enabled = lower.endsWith("on");
      const next = await updateOpsControlSettings((current) => ({
        ...current,
        harvestEnabled: enabled,
      }));
      ui.notice = `harvest_enabled=${next.harvestEnabled}`;
      return;
    }

    ui.notice = `unknown command: ${raw} (type ?)`;
  } finally {
    rl.close();
  }
}

function installTopKeyControls(ui: TopUiState, app: string): () => void {
  if (!process.stdin.isTTY) {
    ui.notice = "stdin is not a TTY; keyboard controls disabled";
    return () => undefined;
  }

  process.stdin.setRawMode(true);
  process.stdin.resume();

  const onData = (data: Buffer): void => {
    const key = data.toString("utf8");

    if (ui.isPrompting) {
      return;
    }

    if (key === "\u0003" || key === "q") {
      ui.running = false;
      ui.notice = "exiting top dashboard";
      return;
    }

    if (key === "h") {
      ui.showHelp = !ui.showHelp;
      return;
    }

    if (key === "r") {
      ui.samples.splice(0, ui.samples.length);
      ui.notice = "trend history reset";
      return;
    }

    if (key === "+") {
      ui.intervalSeconds = Math.min(30, ui.intervalSeconds + 1);
      ui.notice = `refresh interval ${ui.intervalSeconds}s`;
      return;
    }

    if (key === "-") {
      ui.intervalSeconds = Math.max(1, ui.intervalSeconds - 1);
      ui.notice = `refresh interval ${ui.intervalSeconds}s`;
      return;
    }

    if (key === "s") {
      ui.isPrompting = true;
      process.stdin.setRawMode(false);
      void promptTopSettings(ui)
        .catch((error: unknown) => {
          ui.notice = `settings update failed: ${shortError(error)}`;
        })
        .finally(() => {
          if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
          }
          ui.isPrompting = false;
        });
      return;
    }

    if (key === ":") {
      ui.isPrompting = true;
      process.stdin.setRawMode(false);
      void promptTopCommand(ui, app)
        .catch((error: unknown) => {
          ui.notice = `command failed: ${shortError(error)}`;
        })
        .finally(() => {
          if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
          }
          ui.isPrompting = false;
        });
    }
  };

  process.stdin.on("data", onData);

  return () => {
    process.stdin.off("data", onData);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
  };
}

async function runDashboard(args: ParsedArgs): Promise<void> {
  const watch = args.flags.has("watch");
  const topMode = args.flags.has("top");
  const intervalSeconds = parsePositiveInt(
    args.options.get("interval-seconds"),
    1,
  );
  const app = appName(args.options);
  const ui: TopUiState = {
    running: true,
    showHelp: false,
    intervalSeconds,
    notice: "",
    samples: [],
    isPrompting: false,
  };

  let teardownTopKeys = (): void => undefined;
  const uiStateWatcher: OpsUiStateWatcher = await createOpsUiStateWatcher({
    appName: app,
    snapshotTimeoutMs: 6000,
    minRefreshIntervalMs: 1000,
    fallbackRefreshIntervalMs: 5000,
    skipInitialRefresh: false,
    profile: "cli",
  });
  let stopSignalListener = (): void => undefined;
  if (watch && topMode) {
    teardownTopKeys = installTopKeyControls(ui, app);
  }
  ui.notice = "module state watcher connected";

  try {
    let shouldRefresh = true;
    let lastSeenStateVersion = uiStateWatcher.getStateVersion();
    stopSignalListener = uiStateWatcher.onStateChange(() => {
      shouldRefresh = true;
    });

    while (ui.running) {
      if (!shouldRefresh) {
        if (!watch) {
          ui.running = false;
          continue;
        }

        const waitMs = Math.max(1, ui.intervalSeconds) * 1000;
        if (uiStateWatcher.hasStateChangedSince(lastSeenStateVersion)) {
          shouldRefresh = true;
          continue;
        }
        await uiStateWatcher.waitForState(waitMs);
        shouldRefresh = true;
        continue;
      }

      shouldRefresh = false;
      clearScreen();
      const snapshot = uiStateWatcher.getSnapshot();
      if (!snapshot) {
        ui.notice = "waiting for module state snapshot";
        await uiStateWatcher.waitForState(
          Math.max(1, ui.intervalSeconds) * 1000,
        );
        shouldRefresh = true;
        continue;
      }
      lastSeenStateVersion = uiStateWatcher.getStateVersion();

      if (topMode) {
        ui.samples.push({
          atMs: Date.now(),
          queueBacklog: snapshot.queue?.backlog || 0,
          queueActive: snapshot.queue?.active || 0,
          processedItems: snapshot.status?.processedItems || 0,
          failedItems: snapshot.status?.failedItems || 0,
          totalMachines: snapshot.machines?.length || 0,
          runnerUpdatedAt: snapshot.status?.updatedAt || null,
        });
        const recentSamples = takeTail(ui.samples, 60);
        ui.samples.splice(0, ui.samples.length, ...recentSamples);
        renderTopLikeDashboard({
          app,
          watch,
          ui,
          snapshot,
          redisIo: readOpsRedisIoStats(),
          redisIoAggregate: snapshot.redisIoAggregate || emptyRedisAggregate(),
        });
      } else {
        renderSnapshotDashboard({
          app,
          watch,
          intervalSeconds: ui.intervalSeconds,
          snapshot,
        });
      }

      if (!watch) {
        ui.running = false;
        continue;
      }

      if (uiStateWatcher.hasStateChangedSince(lastSeenStateVersion)) {
        shouldRefresh = true;
        continue;
      }
      await uiStateWatcher.waitForState(Math.max(1, ui.intervalSeconds) * 1000);
      shouldRefresh = true;
    }
  } finally {
    stopSignalListener();
    await uiStateWatcher.close();
    teardownTopKeys();
  }
}

async function runFlyScale(args: ParsedArgs): Promise<void> {
  const countRaw = args.options.get("count");
  if (!countRaw) {
    throw new Error("Missing --count for fly-scale");
  }
  const count = parseNonNegativeInt(countRaw, -1);
  if (count < 0) {
    throw new Error(`Invalid --count: ${countRaw}`);
  }

  const app = appName(args.options);
  let zeroPolicyApplied = false;
  if (count === 0) {
    await updateOpsControlSettings((current) => ({
      ...current,
      desiredMode: "stop",
      enqueueEnabled: false,
      requireWorkersForEnqueue: false,
      minWorkersToEnqueue: 0,
    }));
    zeroPolicyApplied = true;
  }

  await scaleOpsWorkers(app, count);
  process.stdout.write(
    `${chalk.green("fly-scale complete")} workers_target=${count}\n`,
  );
  if (zeroPolicyApplied) {
    process.stdout.write(
      chalk.gray(
        "applied zero policy desired_mode=stop enqueue_enabled=false require_workers_for_enqueue=false min_workers_to_enqueue=0\n",
      ),
    );
  }
  await publishInfraSnapshotFromFly(app);
}

async function runFlyStopAll(args: ParsedArgs): Promise<void> {
  const app = appName(args.options);
  await updateOpsControlSettings((current) => ({
    ...current,
    desiredMode: "stop",
    enqueueEnabled: false,
    requireWorkersForEnqueue: false,
    minWorkersToEnqueue: 0,
  }));
  await scaleOpsWorkers(app, 0);
  process.stdout.write(
    `${chalk.green("fly-stop-all complete")} workers_target=0\n`,
  );
  process.stdout.write(
    chalk.gray(
      "applied zero policy desired_mode=stop enqueue_enabled=false require_workers_for_enqueue=false min_workers_to_enqueue=0\n",
    ),
  );
  await publishInfraSnapshotFromFly(app);
}

async function setDesiredMode(
  mode: RunnerDesiredMode,
): Promise<RunnerControlSettings> {
  const result = await setOpsDesiredModeWithQueueAction(mode);
  return result.settings;
}

async function runStartRun(args: ParsedArgs): Promise<void> {
  const countRaw = args.options.get("count");
  if (!countRaw) {
    throw new Error("Missing --count for start-run");
  }
  const count = parsePositiveInt(countRaw, -1);
  if (count < 0) {
    throw new Error(`Invalid --count: ${countRaw}`);
  }

  const app = appName(args.options);
  await updateOpsControlSettings((current) => ({
    ...current,
    desiredMode: "run",
    enqueueEnabled: true,
    requireWorkersForEnqueue: true,
    minWorkersToEnqueue: Math.max(1, current.minWorkersToEnqueue || 0),
  }));
  await scaleOpsWorkers(app, count);
  await publishInfraSnapshotFromFly(app);

  const next = await setDesiredMode("run");
  process.stdout.write(
    `${chalk.green("start-run complete")} workers_target=${count} desired_mode=${next.desiredMode} enqueue_enabled=true require_workers_for_enqueue=true min_workers_to_enqueue>=1\n`,
  );
}

async function waitForQueueDrain(params: {
  timeoutSeconds: number;
  pollSeconds: number;
}): Promise<void> {
  const startedAt = Date.now();
  const timeoutMs = Math.max(1, params.timeoutSeconds) * 1000;
  const pollMs = Math.max(1, params.pollSeconds) * 1000;

  while (true) {
    const counts = await fetchQueueCounts();
    process.stdout.write(
      `drain-check waiting=${counts.waiting} active=${counts.active} delayed=${counts.delayed} paused=${counts.paused} backlog=${counts.backlog}\n`,
    );

    if (counts.waiting + counts.active + counts.delayed + counts.paused === 0) {
      return;
    }

    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(
        `drain timeout after ${params.timeoutSeconds}s waiting=${counts.waiting} active=${counts.active} delayed=${counts.delayed} paused=${counts.paused}`,
      );
    }

    await sleep(pollMs);
  }
}

async function purgePendingQueueJobs(): Promise<{
  removed: number;
  remainingWaiting: number;
  remainingDelayed: number;
  remainingActive: number;
  remainingPaused: number;
}> {
  const purge = await maybePurgeForDesiredMode({ desiredMode: "stop" });
  return (
    purge || {
      removed: 0,
      remainingWaiting: 0,
      remainingDelayed: 0,
      remainingActive: 0,
      remainingPaused: 0,
    }
  );
}

async function runDrainAndScaleDown(args: ParsedArgs): Promise<void> {
  const app = appName(args.options);
  const timeoutSeconds = parsePositiveInt(
    args.options.get("timeout-seconds"),
    900,
  );
  const pollSeconds = parsePositiveInt(args.options.get("poll-seconds"), 5);

  const drainSettings = await setDesiredMode("drain");
  process.stdout.write(
    `${chalk.cyan("drain requested")} desired_mode=${drainSettings.desiredMode}\n`,
  );

  const preDrainInfra = await fetchControlSnapshot();
  const preDrainQueue = await fetchQueueCounts();
  if (
    (preDrainInfra.infra?.workersRunning ?? 0) <= 0 &&
    preDrainQueue.backlog > 0
  ) {
    const purge = await purgePendingQueueJobs();
    process.stdout.write(
      `${chalk.yellow("no workers running; purged pending queue before drain wait")} purged=${purge.removed} waiting=${purge.remainingWaiting} delayed=${purge.remainingDelayed} paused=${purge.remainingPaused} active=${purge.remainingActive}\n`,
    );
  }

  await waitForQueueDrain({ timeoutSeconds, pollSeconds });

  await scaleOpsWorkers(app, 0);
  await publishInfraSnapshotFromFly(app);

  const idleSettings = await setDesiredMode("idle");
  process.stdout.write(
    `${chalk.green("drain-and-scale-down complete")} desired_mode=${idleSettings.desiredMode}\n`,
  );
}

function parseDesiredMode(raw: string | undefined): RunnerDesiredMode | null {
  if (!raw) {
    return null;
  }
  const normalized = raw.trim().toLowerCase();
  if (
    normalized === "run" ||
    normalized === "idle" ||
    normalized === "drain" ||
    normalized === "stop"
  ) {
    return normalized;
  }
  return null;
}

async function publishInfraSnapshotFromFly(app: string): Promise<void> {
  await refreshOpsInfraFromFly(app);
}

async function runControlSet(args: ParsedArgs): Promise<void> {
  const desiredModeRaw = args.options.get("desired-mode");
  const enqueueEnabledRaw = args.options.get("enqueue-enabled");
  const requireWorkersRaw = args.options.get("require-workers-for-enqueue");
  const minWorkersRaw = args.options.get("min-workers-to-enqueue");
  const maxQueueBacklogRaw = args.options.get("max-queue-backlog");
  const refillLowWatermarkRaw = args.options.get("refill-low-watermark");
  const refillTargetBacklogRaw = args.options.get("refill-target-backlog");
  const maxClaimPerCycleRaw = args.options.get("max-claim-per-cycle");
  const flushIntervalRaw = args.options.get("flush-interval-ms");
  const harvestEnabledRaw = args.options.get("harvest-enabled");
  if (
    desiredModeRaw === undefined &&
    enqueueEnabledRaw === undefined &&
    requireWorkersRaw === undefined &&
    minWorkersRaw === undefined &&
    maxQueueBacklogRaw === undefined &&
    refillLowWatermarkRaw === undefined &&
    refillTargetBacklogRaw === undefined &&
    maxClaimPerCycleRaw === undefined &&
    !flushIntervalRaw &&
    harvestEnabledRaw === undefined
  ) {
    throw new Error("control-set requires at least one setting flag");
  }

  try {
    const current = await readOpsControlSettings();
    const desiredMode = parseDesiredMode(desiredModeRaw);
    if (desiredModeRaw !== undefined && !desiredMode) {
      throw new Error(`invalid --desired-mode: ${desiredModeRaw}`);
    }
    const next = {
      desiredMode: desiredMode || current.desiredMode,
      enqueueEnabled:
        enqueueEnabledRaw === undefined
          ? current.enqueueEnabled
          : (parseBoolean(enqueueEnabledRaw) ?? current.enqueueEnabled),
      requireWorkersForEnqueue:
        requireWorkersRaw === undefined
          ? current.requireWorkersForEnqueue
          : (parseBoolean(requireWorkersRaw) ??
            current.requireWorkersForEnqueue),
      minWorkersToEnqueue:
        minWorkersRaw === undefined
          ? current.minWorkersToEnqueue
          : Math.max(
              0,
              Math.min(
                200,
                parseNonNegativeInt(minWorkersRaw, current.minWorkersToEnqueue),
              ),
            ),
      maxQueueBacklog:
        maxQueueBacklogRaw === undefined
          ? current.maxQueueBacklog
          : Math.max(
              10,
              Math.min(
                100_000,
                parseNonNegativeInt(
                  maxQueueBacklogRaw,
                  current.maxQueueBacklog,
                ),
              ),
            ),
      refillLowWatermark:
        refillLowWatermarkRaw === undefined
          ? current.refillLowWatermark
          : Math.max(
              1,
              Math.min(
                100_000,
                parseNonNegativeInt(
                  refillLowWatermarkRaw,
                  current.refillLowWatermark,
                ),
              ),
            ),
      refillTargetBacklog:
        refillTargetBacklogRaw === undefined
          ? current.refillTargetBacklog
          : Math.max(
              1,
              Math.min(
                100_000,
                parseNonNegativeInt(
                  refillTargetBacklogRaw,
                  current.refillTargetBacklog,
                ),
              ),
            ),
      maxClaimPerCycle:
        maxClaimPerCycleRaw === undefined
          ? current.maxClaimPerCycle
          : Math.max(
              1,
              Math.min(
                10_000,
                parseNonNegativeInt(
                  maxClaimPerCycleRaw,
                  current.maxClaimPerCycle,
                ),
              ),
            ),
      flushIntervalMs: flushIntervalRaw
        ? Math.max(
            1000,
            Math.min(
              60000,
              parsePositiveInt(flushIntervalRaw, current.flushIntervalMs),
            ),
          )
        : current.flushIntervalMs,
      harvestEnabled:
        harvestEnabledRaw === undefined
          ? current.harvestEnabled
          : (parseBoolean(harvestEnabledRaw) ?? current.harvestEnabled),
    };

    if (next.refillTargetBacklog > next.maxQueueBacklog) {
      next.refillTargetBacklog = next.maxQueueBacklog;
    }
    if (next.refillLowWatermark > next.refillTargetBacklog) {
      next.refillLowWatermark = next.refillTargetBacklog;
    }

    await writeOpsControlSettings(next);
    if (desiredMode === "stop") {
      const purge = await maybePurgeForDesiredMode({ desiredMode });
      process.stdout.write(
        `${chalk.green("control settings updated")} desired_mode=${next.desiredMode} enqueue_enabled=${next.enqueueEnabled} require_workers_for_enqueue=${next.requireWorkersForEnqueue} min_workers_to_enqueue=${next.minWorkersToEnqueue} max_queue_backlog=${next.maxQueueBacklog} refill_low_watermark=${next.refillLowWatermark} refill_target_backlog=${next.refillTargetBacklog} max_claim_per_cycle=${next.maxClaimPerCycle} flush_interval_ms=${next.flushIntervalMs} harvest_enabled=${next.harvestEnabled} purged=${purge?.removed ?? 0} waiting=${purge?.remainingWaiting ?? 0} delayed=${purge?.remainingDelayed ?? 0} paused=${purge?.remainingPaused ?? 0} active=${purge?.remainingActive ?? 0}\n`,
      );
      return;
    }

    if (desiredMode === "drain") {
      const [snapshot, queue] = await Promise.all([
        readOpsControlSnapshot(),
        fetchQueueCounts(),
      ]);
      const purge = await maybePurgeForDesiredMode({
        desiredMode,
        queue,
        infra: snapshot.infra,
      });
      if (purge) {
        process.stdout.write(
          `${chalk.green("control settings updated")} desired_mode=${next.desiredMode} enqueue_enabled=${next.enqueueEnabled} require_workers_for_enqueue=${next.requireWorkersForEnqueue} min_workers_to_enqueue=${next.minWorkersToEnqueue} max_queue_backlog=${next.maxQueueBacklog} refill_low_watermark=${next.refillLowWatermark} refill_target_backlog=${next.refillTargetBacklog} max_claim_per_cycle=${next.maxClaimPerCycle} flush_interval_ms=${next.flushIntervalMs} harvest_enabled=${next.harvestEnabled} purged=${purge.removed} waiting=${purge.remainingWaiting} delayed=${purge.remainingDelayed} paused=${purge.remainingPaused} active=${purge.remainingActive}\n`,
        );
        return;
      }
    }

    process.stdout.write(
      `${chalk.green("control settings updated")} desired_mode=${next.desiredMode} enqueue_enabled=${next.enqueueEnabled} require_workers_for_enqueue=${next.requireWorkersForEnqueue} min_workers_to_enqueue=${next.minWorkersToEnqueue} max_queue_backlog=${next.maxQueueBacklog} refill_low_watermark=${next.refillLowWatermark} refill_target_backlog=${next.refillTargetBacklog} max_claim_per_cycle=${next.maxClaimPerCycle} flush_interval_ms=${next.flushIntervalMs} harvest_enabled=${next.harvestEnabled}\n`,
    );
  } finally {
    // no-op
  }
}

async function runPauseSystem(): Promise<void> {
  const result = await pauseOpsSystemFlow();
  process.stdout.write(
    `${chalk.green("pause-system complete")} desired_mode=${result.settings.desiredMode} enqueue_enabled=${result.settings.enqueueEnabled} queue_paused=${result.queuePaused}\n`,
  );
}

async function runResumeSystem(): Promise<void> {
  const result = await resumeOpsSystemFlow();
  process.stdout.write(
    `${chalk.green("resume-system complete")} desired_mode=${result.settings.desiredMode} enqueue_enabled=${result.settings.enqueueEnabled} queue_paused=${result.queuePaused}\n`,
  );
}

async function runClearQueue(): Promise<void> {
  const result = await clearOpsQueueIfPaused();
  process.stdout.write(
    `${chalk.green("clear-queue complete")} queue_paused=${result.queuePaused} purged=${result.purge.removed} waiting=${result.purge.remainingWaiting} delayed=${result.purge.remainingDelayed} paused=${result.purge.remainingPaused} active=${result.purge.remainingActive}\n`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const redisTarget = parseRedisTargetOption(args.options);
  const redisSelection = configureRedisTarget(redisTarget);
  process.stdout.write(
    `${chalk.gray("redis target")} target=${redisSelection.target} endpoint=${redisSelection.endpoint}\n`,
  );
  switch (args.command) {
    case "dashboard":
      await runDashboard(args);
      return;
    case "telemetry-dump":
      await runTelemetryDump(args);
      return;
    case "fly-scale":
      await runFlyScale(args);
      return;
    case "fly-stop-all":
      await runFlyStopAll(args);
      return;
    case "fly-status":
      await publishInfraSnapshotFromFly(appName(args.options));
      await panelFly(appName(args.options));
      return;
    case "start-run":
      await runStartRun(args);
      return;
    case "drain-and-scale-down":
      await runDrainAndScaleDown(args);
      return;
    case "control-show":
      await panelControl();
      return;
    case "control-set":
      await runControlSet(args);
      return;
    case "pause-system":
      await runPauseSystem();
      return;
    case "resume-system":
      await runResumeSystem();
      return;
    case "clear-queue":
      await runClearQueue();
      return;
    case "redis-io-reset":
      resetOpsRedisIoStats();
      process.stdout.write(
        `${chalk.green("redis io counters reset")} window_seconds=0 reads=0 bytes=0\n`,
      );
      return;
    case "help":
    default:
      process.stdout.write(`${usage()}\n`);
      return;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${chalk.red("image ops cli failed")}: ${message}\n`);
  process.exit(1);
});
