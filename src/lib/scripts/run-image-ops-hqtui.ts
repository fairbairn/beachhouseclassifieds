import "@/core/tooling/env/load-env-profile";
import { createApp, type TextEditState } from "@profullstack/hqtui";

import {
  configureRedisTarget,
  type RedisTarget,
} from "../../workers/image-queue";
import {
  clearOpsQueueIfPaused,
  createOpsUiStateWatcher,
  OPS_SNAPSHOT_TREND_METRIC_REGISTRY,
  OPS_TREND_METRIC_REGISTRY,
  OPS_UI_METRIC_LABELS,
  pauseOpsSystemFlow,
  readOpsRedisIoStats,
  readOpsRedisPreflight,
  readOpsRedisServerIoStats,
  resetOpsRedisIoStats,
  resumeOpsSystemFlow,
  runOpsCollectorsAndIngestSamples,
  runOpsOneShotPipeline,
  scaleOpsWorkers,
  setOpsDesiredModeWithQueueAction,
  updateOpsControlSettings,
  type OpsMetricSystemSnapshot,
  type OpsRedisIoAggregateStats,
  type OpsRedisIoInstanceStats,
  type OpsRedisIoStats,
  type OpsRedisServerIoStats,
  type OpsSampleCollectorKey,
  type OpsTrendProjection,
  type OpsUiSnapshot,
} from "../workers/image-ops-control-module";
import {
  chartMaxFromSeries,
  rollingSeriesForChart,
  selectDisplaySeries,
} from "../workers/image-ops-graph-series";
import {
  createOpsMetricState,
  ingestTrendRows,
  metricGraphDataFromState,
  metricPointCountFromState,
  resetOpsMetricState,
  type OpsMetricState,
} from "../workers/image-ops-shared-state";
import {
  deriveOpsTelemetry,
  initialOpsMachineState,
  reduceOpsMachine,
  type OpsMachineState,
} from "../workers/image-ops-state-machine";
import { type ImageQueueCounts } from "../workers/image-queue-ops";
import {
  type RunnerControlSettings,
  type RunnerInfraSnapshot,
  type RunnerStatusSnapshot,
} from "../workers/image-runner-control";

const DEFAULT_APP = "beachhouseclassifieds-image-worker";
const STARTUP_SNAPSHOT_TIMEOUT_MS = 1500;
const DEFAULT_TREND_WINDOW_MINUTES = 5;
const LONG_TREND_WINDOW_MINUTES = 15;
const TREND_GRAPH_BUCKET_MS = 5000;
const LONG_IPS_DISPLAY_WIDTH_FACTOR = 3;
const LONG_IPS_DISPLAY_POINT_MAX = 240;
const QUEUE_24H_DISPLAY_POINT_MAX = 720;
const QUEUE_TREND_DISPLAY_POINT_MAX = 240;
const INFRA_REDIS_DISPLAY_POINT_MAX = 240;
const LIVE_SLICE_MAX_AGE_MS = 5_000;
const STARTUP_REDIS_PREFLIGHT_TIMEOUT_MS = 8_000;
const STARTUP_REDIS_PREFLIGHT_MAX_ATTEMPTS = 3;
const STARTUP_REDIS_PREFLIGHT_RETRY_DELAY_MS = 600;
const STARTUP_PIPELINE_TIMEOUT_MS = 10_000;
const METRIC_HISTORY_MAX_POINTS = 30_000;
const UI_LABELS = OPS_UI_METRIC_LABELS;

type QueueCounts = ImageQueueCounts;
type ChartTimingMode = "ordinal" | "interpolated";

type DashboardSnapshot = {
  at: OpsUiSnapshot["at"];
  machines: OpsUiSnapshot["machines"];
  queue: QueueCounts | null;
  recentJobs15m: OpsUiSnapshot["recentJobs15m"];
  recentJobs24h: OpsUiSnapshot["recentJobs24h"];
  performanceRollups: OpsUiSnapshot["performanceRollups"];
  queuePaused: boolean | null;
  db: OpsUiSnapshot["db"];
  settings: RunnerControlSettings | null;
  infra: RunnerInfraSnapshot | null;
  status: RunnerStatusSnapshot | null;
  metricSystem?: OpsMetricSystemSnapshot;
  redisIoAggregate?: OpsRedisIoAggregateStats;
  redisIoInstances?: OpsRedisIoInstanceStats[];
  trendRowsByMetric?: OpsUiSnapshot["trendRowsByMetric"];
  trendRowsLastAtMs?: number;
  projections: OpsTrendProjection;
  errors: OpsUiSnapshot["errors"];
};

const SNAPSHOT_METRIC_NAME_SET = new Set(
  OPS_SNAPSHOT_TREND_METRIC_REGISTRY.map((metric) => metric.name),
);

const RUNNER_METRIC_NAME_SET = new Set(
  OPS_TREND_METRIC_REGISTRY.map((metric) => metric.name),
);

type State = {
  appName: string;
  uiClockAt: string;
  intervalMs: number;
  trendWindowMs: number;
  running: boolean;
  polling: boolean;
  chartTimingMode: ChartTimingMode;
  showHelp: boolean;
  showCommandPalette: boolean;
  commandMenu: "base" | "mode" | "advanced";
  commandQuery: TextEditState;
  commandSelected: number;
  showValuePrompt: boolean;
  showClearConfirm: boolean;
  clearInFlight: boolean;
  showHaltConfirm: boolean;
  haltInFlight: boolean;
  valuePromptTitle: string;
  valuePromptHint: string;
  valuePromptAction: ValuePromptAction | null;
  valuePromptInput: TextEditState;
  notice: string;
  noticePinnedUntilMs: number;
  activeScreen:
    | "summary"
    | "infra"
    | "processing"
    | "queuejobs"
    | "observability";
  historyBacklog: number[];
  historyProcessed: number[];
  historyFailures: number[];
  historyIps: number[];
  historyIpsLong: number[];
  historyIps60m: number[];
  historyIps24h: number[];
  historyBacklogDeltaPerSec: number[];
  historyQueueWaiting: number[];
  historyQueueActive: number[];
  historyQueueDelayed: number[];
  historyQueuePaused: number[];
  historyQueueCompleted: number[];
  historyQueueFailed: number[];
  historyWorkersRunning: number[];
  historyPendingSuccess: number[];
  historyPendingError: number[];
  historyFlushBatches: number[];
  historyRedisKbps: number[];
  historyRedisReadsPerSec: number[];
  historyRedisAggregateKbps: number[];
  historyRedisAggregateRxKbps: number[];
  historyRedisAggregateTxKbps: number[];
  lastSampleAtMs: number | null;
  lastRedisSampleAtMs: number | null;
  lastRedisIngressBytes: number | null;
  lastRedisIngressReads: number | null;
  lastDbProcessed: number | null;
  lastBacklog: number | null;
  lastQueueCompleted: number | null;
  lastRunnerMode: string | null;
  lastLongTrendRefreshAtMs: number;
  queueGloballyPaused: boolean | null;
  metricState: OpsMetricState;
  machine: OpsMachineState;
  snapshot: DashboardSnapshot;
  redisIo: OpsRedisIoStats;
  redisIoAggregate: OpsRedisIoAggregateStats;
  redisIoInstances: OpsRedisIoInstanceStats[];
  snapshotTrendLatestByName: Record<string, number | null>;
  snapshotTrendLatestAtMsByName: Record<string, number | null>;
  runnerTrendLatestByName: Record<string, number | null>;
  runnerTrendLatestAtMsByName: Record<string, number | null>;
  collectorBootLatencyMs: Partial<Record<OpsSampleCollectorKey, number>>;
  collectorBootSamples: Partial<Record<OpsSampleCollectorKey, number>>;
  metricReferenceErrors: string[];
};

type MenuItem = {
  id: string;
  label: string;
  hint?: string;
  disabled?: boolean;
};

type ValuePromptAction =
  | "scaleWorkers"
  | "setIntervalSeconds"
  | "setFlushMs"
  | "setMaxBacklog"
  | "setRefillLow"
  | "setRefillTarget"
  | "setMaxClaimCycle"
  | "rawCommand";

const SCREEN_ORDER: Array<
  "summary" | "infra" | "processing" | "queuejobs" | "observability"
> = ["summary", "infra", "processing", "queuejobs", "observability"];

function nextScreen(
  screen: "summary" | "infra" | "processing" | "queuejobs" | "observability",
): "summary" | "infra" | "processing" | "queuejobs" | "observability" {
  const index = SCREEN_ORDER.indexOf(screen);
  const safeIndex = index < 0 ? 0 : index;
  const nextIndex = (safeIndex + 1) % SCREEN_ORDER.length;
  return SCREEN_ORDER[nextIndex];
}

function textState(value = ""): TextEditState {
  return { value, cursor: value.length };
}

type TextEditKeyEvent = {
  key: string;
  text?: string;
};

function insertText(state: TextEditState, text: string): TextEditState {
  if (!text) {
    return state;
  }
  const cursor = Math.max(0, Math.min(state.cursor, state.value.length));
  const nextValue =
    state.value.slice(0, cursor) + text + state.value.slice(cursor);
  return { value: nextValue, cursor: cursor + text.length };
}

function deleteLeft(state: TextEditState): TextEditState {
  const cursor = Math.max(0, Math.min(state.cursor, state.value.length));
  if (cursor <= 0) {
    return state;
  }
  const nextValue =
    state.value.slice(0, cursor - 1) + state.value.slice(cursor);
  return { value: nextValue, cursor: cursor - 1 };
}

function deleteRight(state: TextEditState): TextEditState {
  const cursor = Math.max(0, Math.min(state.cursor, state.value.length));
  if (cursor >= state.value.length) {
    return state;
  }
  const nextValue =
    state.value.slice(0, cursor) + state.value.slice(cursor + 1);
  return { value: nextValue, cursor };
}

function editText(
  state: TextEditState,
  event: TextEditKeyEvent,
): TextEditState | null {
  if (event.key === "left") {
    return { ...state, cursor: Math.max(0, state.cursor - 1) };
  }
  if (event.key === "right") {
    return { ...state, cursor: Math.min(state.value.length, state.cursor + 1) };
  }
  if (event.key === "home") {
    return { ...state, cursor: 0 };
  }
  if (event.key === "end") {
    return { ...state, cursor: state.value.length };
  }
  if (event.key === "backspace") {
    return deleteLeft(state);
  }
  if (event.key === "delete") {
    return deleteRight(state);
  }
  if (event.key === "escape" || event.key === "enter" || event.key === "tab") {
    return null;
  }

  const printable =
    typeof event.text === "string"
      ? event.text
      : event.key.length === 1
        ? event.key
        : "";
  if (!printable) {
    return null;
  }

  return insertText(state, printable);
}

const localClockFormatter = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: true,
  timeZoneName: "short",
});

function formatLocalClockAt(now: Date = new Date()): string {
  return localClockFormatter.format(now);
}

function shortInstance(instanceId: string): string {
  const parts = instanceId.split("-");
  const tail = parts[parts.length - 1] || instanceId;
  return tail.length <= 8 ? tail : tail.slice(0, 8);
}

function commandMenuItems(
  menu: "base" | "mode" | "advanced",
  queueGloballyPaused: boolean | null,
): MenuItem[] {
  if (menu === "mode") {
    return [
      { id: "mode:run", label: "Set Mode: run", hint: "enqueue + harvest" },
      { id: "mode:idle", label: "Set Mode: idle", hint: "pause enqueue" },
      { id: "mode:drain", label: "Set Mode: drain", hint: "drain backlog" },
      { id: "mode:stop", label: "Set Mode: stop", hint: "halt runner" },
      { id: "back", label: "Back", hint: "return to main menu" },
    ];
  }

  if (menu === "advanced") {
    return [
      {
        id: "prompt:max-backlog",
        label: "Set max backlog",
        hint: "target queue ceiling",
      },
      {
        id: "prompt:refill-low",
        label: "Set refill low watermark",
        hint: "refill trigger",
      },
      {
        id: "prompt:refill-target",
        label: "Set refill target backlog",
        hint: "refill destination",
      },
      {
        id: "prompt:max-claim-cycle",
        label: "Set max claim per cycle",
        hint: "claim batch size",
      },
      {
        id: "prompt:raw",
        label: "Run raw command",
        hint: "legacy parser fallback",
      },
      { id: "back", label: "Back", hint: "return to main menu" },
    ];
  }

  const isPaused = queueGloballyPaused === true;

  return [
    { id: "prompt:scale", label: "Scale workers", hint: "enter worker count" },
    {
      id: "menu:mode",
      label: "Set runner mode",
      hint: "run / idle / drain / stop",
    },
    {
      id: "action:pause-system",
      label: "Pause system flow",
      hint: isPaused ? "already paused" : "pause queue + disable enqueue",
      disabled: isPaused,
    },
    {
      id: "action:resume-system",
      label: "Resume system flow",
      hint: isPaused ? "resume queue + enable enqueue" : "already running",
      disabled: !isPaused,
    },
    {
      id: "action:clear-queue",
      label: "Clear pending queue",
      hint: isPaused ? "requires confirmation" : "pause required",
      disabled: !isPaused,
    },
    {
      id: "action:halt-all",
      label: "Stop It All",
      hint: "pause + clear + stop + scale 0",
    },
    { id: "toggle:harvest", label: "Toggle harvest", hint: "on/off" },
    {
      id: "prompt:flush",
      label: "Set flush interval (ms)",
      hint: "1000..60000",
    },
    { id: "prompt:interval", label: "Set poll interval (s)", hint: "1..30" },
    {
      id: "menu:advanced",
      label: "Advanced settings",
      hint: "queue policy + raw",
    },
    {
      id: "action:redis-io-reset",
      label: "Reset Redis I/O stats",
      hint: "clear kbps/read counters",
    },
    { id: "action:refresh", label: "Refresh now", hint: "pull live state" },
    { id: "action:help", label: "Show help", hint: "keyboard + commands" },
    { id: "action:quit", label: "Quit", hint: "exit dashboard" },
  ];
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(raw || "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseArgs(argv: string[]): {
  appName: string;
  intervalSeconds: number;
  chartTimingMode: ChartTimingMode;
  redisTarget: RedisTarget;
} {
  const options = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      options.set(key, next);
      i += 1;
    }
  }

  const chartTimingRaw = options.get("chart-timing")?.trim().toLowerCase();
  const chartTimingMode: ChartTimingMode =
    chartTimingRaw === "ordinal" ? "ordinal" : "interpolated";
  const redisTargetRaw = options.get("redis-target")?.trim().toLowerCase();
  const redisTarget: RedisTarget =
    !redisTargetRaw || redisTargetRaw === "local"
      ? "local"
      : redisTargetRaw === "cloud"
        ? "cloud"
        : (() => {
            throw new Error(
              `Invalid --redis-target: ${options.get("redis-target")}. Use local or cloud.`,
            );
          })();

  return {
    appName: options.get("app")?.trim() || DEFAULT_APP,
    intervalSeconds: parsePositiveInt(options.get("interval-seconds"), 5),
    chartTimingMode,
    redisTarget,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function trendPointLimitForWindow(trendWindowMs: number): number {
  const safeWindowMs = Math.max(60_000, trendWindowMs);
  return clamp(Math.round(safeWindowMs / TREND_GRAPH_BUCKET_MS), 60, 20_000);
}

function seriesMax(values: number[]): number {
  if (values.length <= 0) {
    return 0;
  }
  return Math.max(0, ...values);
}

function average(values: number[]): number {
  if (values.length <= 0) {
    return 0;
  }
  let total = 0;
  for (const value of values) {
    total += Number.isFinite(value) ? value : 0;
  }
  return total / values.length;
}

function pushHistory(values: number[], next: number, max = 120): number[] {
  values.push(next);
  if (values.length > max) {
    values.splice(0, values.length - max);
  }
  return values;
}

function validateSnapshotMetricId(metricId: string): string | null {
  if (!metricId.startsWith("snapshot.")) {
    return null;
  }
  const metricName = metricId.slice("snapshot.".length);
  if (!SNAPSHOT_METRIC_NAME_SET.has(metricName)) {
    return `invalid snapshot metric reference: ${metricId}`;
  }
  return null;
}

function validateRunnerMetricId(metricId: string): string | null {
  if (!metricId.startsWith("runner.")) {
    return null;
  }
  const metricName = metricId.slice("runner.".length);
  if (!RUNNER_METRIC_NAME_SET.has(metricName)) {
    return `invalid runner metric reference: ${metricId}`;
  }
  return null;
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

function formatRate(value: number, digits = 2): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0";
  }
  if (value < 0.01) {
    return "<0.01";
  }
  if (value < 0.1) {
    return value.toFixed(Math.max(digits, 3));
  }
  return value.toFixed(digits);
}

function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) {
    return "n/a";
  }
  if (seconds < 1) {
    return "<1s";
  }

  const totalSeconds = Math.floor(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${secs}s`;
  }
  return `${secs}s`;
}

function isSampleFresh(input: {
  sampledAtMs: number | null;
  nowMs: number;
  maxAgeMs: number;
}): boolean {
  const sampledAtMs = input.sampledAtMs;
  if (!Number.isFinite(sampledAtMs) || sampledAtMs === null) {
    return false;
  }
  return input.nowMs - sampledAtMs <= Math.max(1, input.maxAgeMs);
}

function tail(values: number[], count: number): number[] {
  if (values.length <= count) {
    return values;
  }
  return values.slice(values.length - count);
}

function normalizeTrendSeries(values: number[], count: number): number[] {
  const width = Math.max(1, count);
  const trimmed = tail(values, width);
  if (trimmed.length >= width) {
    return trimmed;
  }
  return [
    ...Array.from({ length: width - trimmed.length }, () => 0),
    ...trimmed,
  ];
}

function resampleSeriesToCount(values: number[], count: number): number[] {
  const width = Math.max(1, Math.floor(count));
  if (values.length <= 0) {
    return Array.from({ length: width }, () => 0);
  }
  if (values.length === 1) {
    return Array.from({ length: width }, () => values[0] || 0);
  }
  if (values.length === width) {
    return values;
  }

  const lastIndex = values.length - 1;
  return Array.from({ length: width }, (_, index) => {
    const ratio = width === 1 ? 0 : index / (width - 1);
    const source = ratio * lastIndex;
    const sourceLow = Math.floor(source);
    const sourceHigh = Math.min(lastIndex, Math.ceil(source));
    if (sourceHigh === sourceLow) {
      return values[sourceLow] || 0;
    }
    const low = values[sourceLow] || 0;
    const high = values[sourceHigh] || 0;
    const mix = source - sourceLow;
    return low + (high - low) * mix;
  });
}

async function updateRunnerSettings(
  updater: (current: RunnerControlSettings) => RunnerControlSettings,
): Promise<RunnerControlSettings> {
  return updateOpsControlSettings(updater);
}

async function scaleWorkers(appName: string, count: number): Promise<void> {
  await scaleOpsWorkers(appName, count);
}

function machineStateSummary(machines: OpsUiSnapshot["machines"]): string {
  if (!machines) {
    return "unknown";
  }
  if (machines.length === 0) {
    return "none";
  }

  const stateCounts = new Map<string, number>();
  for (const machine of machines) {
    const state = String(machine.state || "unknown").toLowerCase();
    stateCounts.set(state, (stateCounts.get(state) || 0) + 1);
  }

  return [...stateCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([state, count]) => `${state}:${count}`)
    .join(" ");
}

function shouldUseMachineNotice(state: State): boolean {
  return Date.now() >= state.noticePinnedUntilMs;
}

function shortBootError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function sleepMs(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, Math.max(1, ms));
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const redisSelection = configureRedisTarget(args.redisTarget);
  const initialIntervalMs = Math.max(1000, args.intervalSeconds * 1000);
  const initialTrendWindowMs = DEFAULT_TREND_WINDOW_MINUTES * 60 * 1000;
  const bootStartedAtNs = process.hrtime.bigint();
  const useBootColors = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  const color = {
    green: "\u001b[32m",
    red: "\u001b[31m",
    yellow: "\u001b[33m",
    dim: "\u001b[2m",
    reset: "\u001b[0m",
  };
  const colorize = (text: string, ansi: string): string =>
    useBootColors ? `${ansi}${text}${color.reset}` : text;
  let bootLastLogAtNs = bootStartedAtNs;
  const formatBootDeltaMs = (ms: number): string => {
    if (!Number.isFinite(ms) || ms < 0) {
      return "  n/a";
    }
    if (ms < 1) {
      return "  <1";
    }
    return String(Math.round(ms)).padStart(4, " ");
  };
  const formatIoDelta = (
    before: OpsRedisIoStats,
    after: OpsRedisIoStats,
  ): string => {
    const deltaReads = Math.max(
      0,
      after.redisIngressReads - before.redisIngressReads,
    );
    const deltaWrites = Math.max(
      0,
      after.redisEgressWrites - before.redisEgressWrites,
    );
    const deltaIngressBytes = Math.max(
      0,
      after.redisIngressBytes - before.redisIngressBytes,
    );
    const deltaEgressBytes = Math.max(
      0,
      after.redisEgressBytes - before.redisEgressBytes,
    );
    return `reads=${deltaReads} writes=${deltaWrites} ingress_bytes=${deltaIngressBytes} egress_bytes=${deltaEgressBytes}`;
  };
  const formatServerIoDelta = (
    before: OpsRedisServerIoStats | null,
    after: OpsRedisServerIoStats | null,
  ): string => {
    if (!before || !after) {
      return "server_io=unavailable";
    }
    const deltaIn = Math.max(
      0,
      after.serverNetInputBytes - before.serverNetInputBytes,
    );
    const deltaOut = Math.max(
      0,
      after.serverNetOutputBytes - before.serverNetOutputBytes,
    );
    const deltaCommands = Math.max(
      0,
      after.serverTotalCommandsProcessed - before.serverTotalCommandsProcessed,
    );
    return `server_in_bytes=${deltaIn} server_out_bytes=${deltaOut} server_commands=${deltaCommands}`;
  };
  const bootLog = (step: string, status: "pending" | "ok" | "fail") => {
    const nowNs = process.hrtime.bigint();
    const elapsedMs = Number(nowNs - bootStartedAtNs) / 1_000_000;
    const latencyMs = Number(nowNs - bootLastLogAtNs) / 1_000_000;
    bootLastLogAtNs = nowNs;
    const marker =
      status === "ok"
        ? colorize("✅", color.green)
        : status === "fail"
          ? colorize("❌", color.red)
          : colorize("⏳", color.yellow);
    const latencyLabel = colorize(
      `(+${formatBootDeltaMs(latencyMs)}ms)`,
      color.dim,
    );
    const elapsedLabel = colorize(
      `(${formatBootDeltaMs(elapsedMs).padStart(6, " ")}ms)`,
      color.dim,
    );
    process.stdout.write(`${marker} ${latencyLabel} ${elapsedLabel} ${step}\n`);
  };

  bootLog(
    `start image-ops hqtui app=${args.appName} redis_target=${redisSelection.target}`,
    "pending",
  );

  let redisPreflightError: unknown = null;
  let redisPreflight: Awaited<ReturnType<typeof readOpsRedisPreflight>> | null =
    null;
  for (
    let attempt = 1;
    attempt <= STARTUP_REDIS_PREFLIGHT_MAX_ATTEMPTS;
    attempt += 1
  ) {
    bootLog(
      `verify redis connectivity attempt ${attempt}/${STARTUP_REDIS_PREFLIGHT_MAX_ATTEMPTS}`,
      "pending",
    );
    try {
      redisPreflight = await readOpsRedisPreflight({
        timeoutMs: STARTUP_REDIS_PREFLIGHT_TIMEOUT_MS,
      });
      bootLog(
        `redis ready endpoint=${redisPreflight.endpoint} auth=${redisPreflight.authMode}`,
        "ok",
      );
      break;
    } catch (error) {
      redisPreflightError = error;
      bootLog(`redis check failed: ${shortBootError(error)}`, "fail");
      if (attempt < STARTUP_REDIS_PREFLIGHT_MAX_ATTEMPTS) {
        await sleepMs(STARTUP_REDIS_PREFLIGHT_RETRY_DELAY_MS);
      }
    }
  }
  if (!redisPreflight) {
    throw new Error(
      `startup aborted: redis preflight failed after ${STARTUP_REDIS_PREFLIGHT_MAX_ATTEMPTS} attempts (${shortBootError(redisPreflightError)})`,
    );
  }

  bootLog("probe metric role", "pending");
  const startupProbe = await runOpsOneShotPipeline({
    appName: args.appName,
    timeoutMs: STARTUP_PIPELINE_TIMEOUT_MS,
    includeFly: false,
    includeTrendProjection: false,
    includeRecentJobs15m: false,
    includeRecentJobs24h: false,
    includePerformanceRollups: false,
    reconcileBullmqStatus: false,
  });
  const metricRole = startupProbe.snapshot.metricSystem?.role || "master";
  bootLog(`metric role=${metricRole}`, "ok");

  const startupCollectors: OpsSampleCollectorKey[] = [
    "db",
    "fly",
    "redis",
    "bullmq",
  ];
  const collectorBootLatencyMs: Partial<Record<OpsSampleCollectorKey, number>> =
    {};
  const collectorBootSamples: Partial<Record<OpsSampleCollectorKey, number>> =
    {};
  let startupPipeline = startupProbe;
  if (metricRole === "master") {
    bootLog("resample collectors (parallel)", "pending");
    const collectorBatchStartedAtMs = Date.now();
    await Promise.all(
      startupCollectors.map(async (collector) => {
        const collectorStartedAtMs = Date.now();
        bootLog(`collector ${collector}: start`, "pending");
        const summary = await runOpsCollectorsAndIngestSamples({
          appName: args.appName,
          collectors: [collector],
        }).catch(() => []);
        const elapsedMs = Date.now() - collectorStartedAtMs;
        const entry = summary.find((item) => item.collector === collector);
        if (!entry) {
          collectorBootLatencyMs[collector] = elapsedMs;
          collectorBootSamples[collector] = 0;
          bootLog(
            `collector ${collector}: no samples (elapsed ${elapsedMs}ms)`,
            "fail",
          );
          return;
        }
        collectorBootLatencyMs[collector] = elapsedMs;
        collectorBootSamples[collector] = entry.sampleCount;
        bootLog(
          `collector ${collector}: samples=${entry.sampleCount} elapsed=${elapsedMs}ms`,
          "ok",
        );
      }),
    );
    const collectorBatchElapsedMs = Date.now() - collectorBatchStartedAtMs;
    const collectorLatencies = startupCollectors
      .map((collector) => ({
        collector,
        latencyMs: collectorBootLatencyMs[collector] ?? 0,
        samples: collectorBootSamples[collector] ?? 0,
      }))
      .sort((a, b) => b.latencyMs - a.latencyMs);
    const slowestCollector = collectorLatencies[0];
    const totalCollectorLatencyMs = collectorLatencies.reduce(
      (sum, entry) => sum + entry.latencyMs,
      0,
    );
    bootLog(
      `collector summary wall=${collectorBatchElapsedMs}ms cumulative=${totalCollectorLatencyMs}ms slowest=${slowestCollector?.collector || "n/a"}:${slowestCollector?.latencyMs || 0}ms`,
      "ok",
    );

    bootLog("state refresh kickoff now (no delay timer)", "pending");
    bootLog(
      "force post-processing slice build + state pipeline refresh",
      "pending",
    );
    const startupRefreshIoBefore = readOpsRedisIoStats();
    const startupRefreshServerIoBefore =
      await readOpsRedisServerIoStats().catch(() => null);
    const startupRefreshStartedAtMs = Date.now();
    startupPipeline = await runOpsOneShotPipeline({
      appName: args.appName,
      timeoutMs: STARTUP_PIPELINE_TIMEOUT_MS,
      includeFly: false,
      includeTrendProjection: true,
      includeRecentJobs15m: true,
      includeRecentJobs24h: true,
      includePerformanceRollups: true,
      reconcileBullmqStatus: true,
    });
    const startupRefreshElapsedMs = Date.now() - startupRefreshStartedAtMs;
    const startupRefreshIoAfter = readOpsRedisIoStats();
    const startupRefreshServerIoAfter = await readOpsRedisServerIoStats().catch(
      () => null,
    );
    bootLog(
      `state pipeline refreshed backlog=${startupPipeline.snapshot.queue?.backlog ?? 0} status_reconciled=${startupPipeline.statusReconciled} elapsed=${startupRefreshElapsedMs}ms ${formatIoDelta(startupRefreshIoBefore, startupRefreshIoAfter)} ${formatServerIoDelta(startupRefreshServerIoBefore, startupRefreshServerIoAfter)}`,
      "ok",
    );
  } else {
    bootLog("standby role: skipping collector + slice generation", "ok");
    bootLog("state refresh kickoff now (no delay timer)", "pending");
    bootLog("standby state refresh", "pending");
    const startupRefreshIoBefore = readOpsRedisIoStats();
    const startupRefreshServerIoBefore =
      await readOpsRedisServerIoStats().catch(() => null);
    const startupRefreshStartedAtMs = Date.now();
    startupPipeline = await runOpsOneShotPipeline({
      appName: args.appName,
      timeoutMs: STARTUP_PIPELINE_TIMEOUT_MS,
      includeFly: false,
      includeTrendProjection: true,
      includeRecentJobs15m: true,
      includeRecentJobs24h: true,
      includePerformanceRollups: true,
      reconcileBullmqStatus: false,
    });
    const startupRefreshElapsedMs = Date.now() - startupRefreshStartedAtMs;
    const startupRefreshIoAfter = readOpsRedisIoStats();
    const startupRefreshServerIoAfter = await readOpsRedisServerIoStats().catch(
      () => null,
    );
    bootLog(
      `standby refresh complete backlog=${startupPipeline.snapshot.queue?.backlog ?? 0} elapsed=${startupRefreshElapsedMs}ms ${formatIoDelta(startupRefreshIoBefore, startupRefreshIoAfter)} ${formatServerIoDelta(startupRefreshServerIoBefore, startupRefreshServerIoAfter)}`,
      "ok",
    );
  }

  bootLog("watcher init kickoff now (no delay timer)", "pending");
  bootLog("connect watcher", "pending");
  const watcherInitIoBefore = readOpsRedisIoStats();
  const watcherInitServerIoBefore = await readOpsRedisServerIoStats().catch(
    () => null,
  );
  const watcherInitStartedAtMs = Date.now();
  const uiStateWatcher = await createOpsUiStateWatcher({
    appName: args.appName,
    profile: "cli",
    snapshotTimeoutMs: STARTUP_SNAPSHOT_TIMEOUT_MS,
    minRefreshIntervalMs: Math.max(1000, initialIntervalMs),
    fallbackRefreshIntervalMs: initialIntervalMs,
    subscribeToSignals: true,
    enableCollectors: false,
    skipInitialRefresh: true,
    hydrateOnInit: false,
    waitForQueueEventsReadyOnInit: false,
    seedCollectorsOnInit: false,
    trendProjectionLimit: trendPointLimitForWindow(24 * 60 * 60 * 1000),
    trendSampleMode: "interpolated",
    trendSampleWindowMs: 24 * 60 * 60 * 1000,
    trendSampleMaxGapMs: Math.max(1000, initialIntervalMs * 3),
  });
  const watcherInitElapsedMs = Date.now() - watcherInitStartedAtMs;
  const watcherInitIoAfter = readOpsRedisIoStats();
  const watcherInitServerIoAfter = await readOpsRedisServerIoStats().catch(
    () => null,
  );
  bootLog(
    `watcher seeded and ready elapsed=${watcherInitElapsedMs}ms ${formatIoDelta(watcherInitIoBefore, watcherInitIoAfter)} ${formatServerIoDelta(watcherInitServerIoBefore, watcherInitServerIoAfter)}`,
    "ok",
  );
  resetOpsRedisIoStats();
  bootLog("redis local I/O counters reset (GUI baseline)", "ok");
  bootLog("opening GUI", "ok");

  const state: State = {
    appName: args.appName,
    uiClockAt: formatLocalClockAt(),
    intervalMs: initialIntervalMs,
    trendWindowMs: initialTrendWindowMs,
    running: true,
    polling: false,
    chartTimingMode: args.chartTimingMode,
    showHelp: false,
    showCommandPalette: false,
    commandMenu: "base",
    commandQuery: textState(),
    commandSelected: 0,
    showValuePrompt: false,
    showClearConfirm: false,
    clearInFlight: false,
    showHaltConfirm: false,
    haltInFlight: false,
    valuePromptTitle: "",
    valuePromptHint: "",
    valuePromptAction: null,
    valuePromptInput: textState(),
    notice: `ready redis target=${redisSelection.target} endpoint=${redisPreflight.endpoint} auth=${redisPreflight.authMode}`,
    noticePinnedUntilMs: 0,
    activeScreen: "summary",
    historyBacklog: [],
    historyProcessed: [],
    historyFailures: [],
    historyIps: [],
    historyIpsLong: [],
    historyIps60m: [],
    historyIps24h: [],
    historyBacklogDeltaPerSec: [],
    historyQueueWaiting: [],
    historyQueueActive: [],
    historyQueueDelayed: [],
    historyQueuePaused: [],
    historyQueueCompleted: [],
    historyQueueFailed: [],
    historyWorkersRunning: [],
    historyPendingSuccess: [],
    historyPendingError: [],
    historyFlushBatches: [],
    historyRedisKbps: [],
    historyRedisReadsPerSec: [],
    historyRedisAggregateKbps: [],
    historyRedisAggregateRxKbps: [],
    historyRedisAggregateTxKbps: [],
    lastSampleAtMs: null,
    lastRedisSampleAtMs: null,
    lastRedisIngressBytes: null,
    lastRedisIngressReads: null,
    lastDbProcessed: null,
    lastBacklog: null,
    lastQueueCompleted: null,
    lastRunnerMode: null,
    lastLongTrendRefreshAtMs: 0,
    queueGloballyPaused: null,
    metricState: createOpsMetricState({ maxPoints: METRIC_HISTORY_MAX_POINTS }),
    machine: initialOpsMachineState(),
    snapshot: {
      at: startupPipeline.snapshot.at,
      machines: startupPipeline.snapshot.machines,
      queue: startupPipeline.snapshot.queue,
      recentJobs15m: startupPipeline.snapshot.recentJobs15m,
      recentJobs24h: startupPipeline.snapshot.recentJobs24h,
      performanceRollups: startupPipeline.snapshot.performanceRollups,
      queuePaused: startupPipeline.snapshot.queuePaused ?? null,
      db: startupPipeline.snapshot.db,
      settings: startupPipeline.snapshot.settings,
      infra: startupPipeline.snapshot.infra,
      status: startupPipeline.snapshot.status,
      metricSystem: startupPipeline.snapshot.metricSystem,
      redisIoAggregate: startupPipeline.snapshot.redisIoAggregate,
      redisIoInstances: startupPipeline.snapshot.redisIoInstances,
      trendRowsByMetric: startupPipeline.snapshot.trendRowsByMetric,
      trendRowsLastAtMs: startupPipeline.snapshot.trendRowsLastAtMs,
      projections: startupPipeline.snapshot.projections,
      errors: startupPipeline.snapshot.errors,
    },
    redisIo: {
      redisEgressBytes: 0,
      redisIngressBytes: 0,
      redisWireBytes: 0,
      redisIngressReads: 0,
      redisEgressWrites: 0,
      windowSeconds: 1,
      redisEgressKbps: 0,
      redisIngressKbps: 0,
      redisWireKbps: 0,
      redisIngressKbPerRead: 0,
      rxLatencyMs: 0,
      txLatencyMs: 0,
      lastReadAt: null,
      lastWriteAt: null,
    },
    redisIoAggregate: {
      sampledAt:
        startupPipeline.snapshot.redisIoAggregate?.sampledAt ||
        new Date().toISOString(),
      activeInstances:
        startupPipeline.snapshot.redisIoAggregate?.activeInstances ?? 0,
      redisEgressBytes:
        startupPipeline.snapshot.redisIoAggregate?.redisEgressBytes ?? 0,
      redisIngressBytes:
        startupPipeline.snapshot.redisIoAggregate?.redisIngressBytes ?? 0,
      redisIngressReads:
        startupPipeline.snapshot.redisIoAggregate?.redisIngressReads ?? 0,
      redisEgressWrites:
        startupPipeline.snapshot.redisIoAggregate?.redisEgressWrites ?? 0,
      redisEgressKbps:
        startupPipeline.snapshot.redisIoAggregate?.redisEgressKbps ?? 0,
      redisIngressKbps:
        startupPipeline.snapshot.redisIoAggregate?.redisIngressKbps ?? 0,
      redisWireKbps:
        startupPipeline.snapshot.redisIoAggregate?.redisWireKbps ?? 0,
      rxLatencyMs: startupPipeline.snapshot.redisIoAggregate?.rxLatencyMs ?? 0,
      txLatencyMs: startupPipeline.snapshot.redisIoAggregate?.txLatencyMs ?? 0,
    },
    redisIoInstances: startupPipeline.snapshot.redisIoInstances ?? [],
    snapshotTrendLatestByName: {},
    snapshotTrendLatestAtMsByName: {},
    runnerTrendLatestByName: {},
    runnerTrendLatestAtMsByName: {},
    collectorBootLatencyMs,
    collectorBootSamples,
    metricReferenceErrors: [],
  };
  state.queueGloballyPaused = startupPipeline.snapshot.queuePaused ?? null;
  ingestTrendRows({
    state: state.metricState,
    trendRowsByMetric: state.snapshot.trendRowsByMetric,
  });

  const app = await createApp({
    alwaysRender: false,
    fps: 20,
    remoteFps: 12,
    quitKeys: [],
  });

  let explicitQuitRequested = false;

  app.on("exit", () => {
    state.running = false;
    if (explicitQuitRequested) {
      process.exit(0);
    }
  });

  let pollDelayTimer: ReturnType<typeof setTimeout> | null = null;
  let pollDelayResolve: (() => void) | null = null;
  const wakeRefreshLoop = (): void => {
    if (pollDelayTimer) {
      clearTimeout(pollDelayTimer);
      pollDelayTimer = null;
    }
    if (pollDelayResolve) {
      const resolve = pollDelayResolve;
      pollDelayResolve = null;
      resolve();
    }
  };
  const uiClockTimer = setInterval(() => {
    if (!state.running) {
      return;
    }
    state.uiClockAt = formatLocalClockAt();
    app.invalidate();
  }, 1000);

  const requestQuit = (): void => {
    if (!state.running) {
      return;
    }
    explicitQuitRequested = true;
    state.running = false;
    wakeRefreshLoop();
    app.quit();
  };

  const onSigint = (): void => {
    state.notice = "Use q to quit";
    app.invalidate();
  };
  process.on("SIGINT", onSigint);

  const refresh = async (): Promise<void> => {
    if (state.polling || !state.running) {
      return;
    }
    state.polling = true;
    try {
      const snapshot = await uiStateWatcher
        .refreshNow()
        .catch(() => uiStateWatcher.getSnapshot());
      if (!snapshot) {
        return;
      }
      const previous = state.snapshot;
      const merged: DashboardSnapshot = {
        ...snapshot,
        machines: snapshot.machines ?? previous.machines,
        queue: snapshot.queue ?? previous.queue,
        recentJobs15m: snapshot.recentJobs15m ?? previous.recentJobs15m,
        recentJobs24h: snapshot.recentJobs24h ?? previous.recentJobs24h,
        performanceRollups:
          snapshot.performanceRollups ?? previous.performanceRollups,
        queuePaused: snapshot.queuePaused ?? previous.queuePaused,
        db: snapshot.db ?? previous.db,
        settings: snapshot.settings ?? previous.settings,
        infra: snapshot.infra ?? previous.infra,
        status: snapshot.status ?? previous.status,
        metricSystem: snapshot.metricSystem ?? previous.metricSystem,
        redisIoAggregate:
          snapshot.redisIoAggregate ?? previous.redisIoAggregate,
        redisIoInstances:
          snapshot.redisIoInstances ?? previous.redisIoInstances,
        trendRowsByMetric:
          snapshot.trendRowsByMetric ?? previous.trendRowsByMetric,
        trendRowsLastAtMs:
          snapshot.trendRowsLastAtMs ?? previous.trendRowsLastAtMs,
        projections: snapshot.projections,
      };
      state.snapshot = merged;
      const historyMax = trendPointLimitForWindow(state.trendWindowMs);
      const queueHistoryMax = trendPointLimitForWindow(24 * 60 * 60 * 1000);
      const nowMs = Date.now();

      if (
        state.historyBacklog.length === 0 &&
        merged.projections.sampleCount > 0
      ) {
        state.historyBacklog = [
          ...merged.projections.queueBacklogTrendSmoothed.slice(-historyMax),
        ];
        state.historyProcessed = [
          ...merged.projections.processedItemsTrend.slice(-historyMax),
        ];
        state.historyFailures = [
          ...merged.projections.failedItemsTrend.slice(-historyMax),
        ];
      }

      state.metricState.maxPoints = Math.max(
        queueHistoryMax,
        METRIC_HISTORY_MAX_POINTS,
      );
      ingestTrendRows({
        state: state.metricState,
        trendRowsByMetric: merged.trendRowsByMetric,
      });

      const nextSnapshotTrendLatestByName: Record<string, number | null> = {};
      const nextSnapshotTrendLatestAtMsByName: Record<string, number | null> =
        {};
      for (const metric of OPS_SNAPSHOT_TREND_METRIC_REGISTRY) {
        const rows = merged.trendRowsByMetric?.[metric.name] ?? [];
        const latestRow = rows[rows.length - 1];
        nextSnapshotTrendLatestByName[metric.name] =
          latestRow && Number.isFinite(latestRow.value)
            ? Number(latestRow.value)
            : null;
        nextSnapshotTrendLatestAtMsByName[metric.name] =
          latestRow && Number.isFinite(latestRow.atMs)
            ? Number(latestRow.atMs)
            : null;
      }
      state.snapshotTrendLatestByName = nextSnapshotTrendLatestByName;
      state.snapshotTrendLatestAtMsByName = nextSnapshotTrendLatestAtMsByName;

      const nextRunnerTrendLatestByName: Record<string, number | null> = {};
      const nextRunnerTrendLatestAtMsByName: Record<string, number | null> = {};
      const statusAtMs = Number.isFinite(
        Date.parse(merged.status?.updatedAt || ""),
      )
        ? Date.parse(merged.status?.updatedAt || "")
        : Date.now();
      for (const metric of OPS_TREND_METRIC_REGISTRY) {
        const value = merged.status ? metric.getValue(merged.status) : null;
        nextRunnerTrendLatestByName[metric.name] =
          value !== null && Number.isFinite(value) ? Number(value) : null;
        nextRunnerTrendLatestAtMsByName[metric.name] =
          value !== null && Number.isFinite(value) ? statusAtMs : null;
      }
      state.runnerTrendLatestByName = nextRunnerTrendLatestByName;
      state.runnerTrendLatestAtMsByName = nextRunnerTrendLatestAtMsByName;

      const metricReferenceErrors: string[] = [];
      const trendRowsByMetric = merged.trendRowsByMetric ?? {};
      for (const [metricName, rows] of Object.entries(trendRowsByMetric)) {
        if (!SNAPSHOT_METRIC_NAME_SET.has(metricName)) {
          metricReferenceErrors.push(
            `unknown snapshot metric in state: snapshot.${metricName}`,
          );
          continue;
        }
        const metricId = `snapshot.${metricName}`;
        const metricRefError = validateSnapshotMetricId(metricId);
        if (metricRefError) {
          metricReferenceErrors.push(metricRefError);
          continue;
        }
        const seriesCount = metricPointCountFromState({
          state: state.metricState,
          metricId,
        });
        if ((rows?.length || 0) > 0 && seriesCount === 0) {
          metricReferenceErrors.push(
            `metric mapping mismatch: ${metricId} has snapshot rows but empty in-memory series`,
          );
        }
      }
      state.metricReferenceErrors = metricReferenceErrors;
      if (metricReferenceErrors.length > 0) {
        state.notice = `metric mapping error: ${metricReferenceErrors[0]}`;
      }

      const queueRowsInSnapshot =
        merged.trendRowsByMetric?.queueBacklogLive ?? [];
      const queueSeriesCount = metricPointCountFromState({
        state: state.metricState,
        metricId: "snapshot.queueBacklogLive",
      });
      if (queueRowsInSnapshot.length > 0 && queueSeriesCount === 0) {
        const message =
          "queueBacklogLive mismatch: snapshot rows exist but state metric series is empty";
        state.metricReferenceErrors = [...state.metricReferenceErrors, message];
        state.notice = `metric mapping error: ${message}`;
      }

      const runnerModeNow = merged.status?.mode ?? null;
      if (
        state.lastRunnerMode !== null &&
        runnerModeNow !== null &&
        state.lastRunnerMode !== runnerModeNow &&
        runnerModeNow !== "running"
      ) {
        state.historyIps = [];
      }
      state.lastRunnerMode = runnerModeNow;

      const currentBacklog = merged.queue?.backlog ?? 0;
      const currentProcessed =
        merged.status?.processedItems ?? merged.db?.processed ?? 0;
      const currentFailed =
        merged.status?.failedItems ?? merged.queue?.failed ?? 0;
      const currentCompleted =
        merged.status?.completedJobs ??
        merged.queue?.completed ??
        currentProcessed;

      pushHistory(state.historyBacklog, currentBacklog, historyMax);
      pushHistory(state.historyProcessed, currentProcessed, historyMax);
      pushHistory(state.historyFailures, currentFailed, historyMax);

      if (
        state.lastSampleAtMs !== null &&
        state.lastDbProcessed !== null &&
        state.lastBacklog !== null
      ) {
        const elapsedSeconds = Math.max(
          0.001,
          (nowMs - state.lastSampleAtMs) / 1000,
        );
        const completedDelta = Math.max(
          0,
          currentCompleted - (state.lastQueueCompleted ?? currentCompleted),
        );
        const ipsNow = completedDelta / elapsedSeconds;
        const backlogDeltaNow =
          (currentBacklog - state.lastBacklog) / elapsedSeconds;
        pushHistory(state.historyIps, Number(ipsNow.toFixed(3)), historyMax);
        pushHistory(
          state.historyBacklogDeltaPerSec,
          Number(backlogDeltaNow.toFixed(3)),
          historyMax,
        );
      } else {
        pushHistory(state.historyIps, 0, historyMax);
        pushHistory(state.historyBacklogDeltaPerSec, 0, historyMax);
      }

      state.lastSampleAtMs = nowMs;
      state.lastDbProcessed = currentProcessed;
      state.lastBacklog = currentBacklog;
      state.lastQueueCompleted = currentCompleted;

      pushHistory(
        state.historyQueueWaiting,
        merged.queue?.waiting ?? 0,
        historyMax,
      );
      pushHistory(
        state.historyQueueActive,
        merged.queue?.active ?? 0,
        historyMax,
      );
      pushHistory(
        state.historyQueueDelayed,
        merged.queue?.delayed ?? 0,
        historyMax,
      );
      pushHistory(
        state.historyQueuePaused,
        merged.queue?.paused ?? 0,
        historyMax,
      );
      pushHistory(
        state.historyQueueCompleted,
        merged.queue?.completed ?? 0,
        historyMax,
      );
      pushHistory(
        state.historyQueueFailed,
        merged.queue?.failed ?? 0,
        historyMax,
      );
      pushHistory(
        state.historyWorkersRunning,
        merged.infra?.workersRunning ?? merged.status?.workersRunning ?? 0,
        historyMax,
      );
      pushHistory(
        state.historyPendingSuccess,
        merged.status?.pendingSuccessBuffer ?? 0,
        historyMax,
      );
      pushHistory(
        state.historyPendingError,
        merged.status?.pendingErrorBuffer ?? 0,
        historyMax,
      );
      pushHistory(
        state.historyFlushBatches,
        merged.status?.flushBatchCount ?? 0,
        historyMax,
      );

      state.machine = reduceOpsMachine(state.machine, {
        type: "refresh_success",
        input: {
          settings: merged.settings,
          infra: merged.infra,
          status: merged.status,
          queue: merged.queue,
          errors: merged.errors,
        },
        nowMs,
      });
      state.redisIo = readOpsRedisIoStats();
      if (merged.redisIoAggregate) {
        state.redisIoAggregate = merged.redisIoAggregate;
      }
      state.redisIoInstances = merged.redisIoInstances ?? [];
      state.queueGloballyPaused = merged.queuePaused;

      if (state.lastRedisSampleAtMs !== null) {
        const elapsedSeconds = Math.max(
          0.001,
          (nowMs - state.lastRedisSampleAtMs) / 1000,
        );
        const prevBytes = state.lastRedisIngressBytes ?? 0;
        const prevReads = state.lastRedisIngressReads ?? 0;
        const deltaBytes = Math.max(
          0,
          state.redisIo.redisIngressBytes - prevBytes,
        );
        const deltaReads = Math.max(
          0,
          state.redisIo.redisIngressReads - prevReads,
        );
        pushHistory(
          state.historyRedisKbps,
          Number((deltaBytes / 1024 / elapsedSeconds).toFixed(3)),
          historyMax,
        );
        pushHistory(
          state.historyRedisReadsPerSec,
          Number((deltaReads / elapsedSeconds).toFixed(3)),
          historyMax,
        );
      } else {
        pushHistory(
          state.historyRedisKbps,
          state.redisIo.redisIngressKbps,
          historyMax,
        );
        pushHistory(
          state.historyRedisReadsPerSec,
          Number(
            (
              state.redisIo.redisIngressReads /
              Math.max(1, state.redisIo.windowSeconds)
            ).toFixed(3),
          ),
          historyMax,
        );
      }
      const latestIps = state.historyIps[state.historyIps.length - 1] || 0;
      pushHistory(state.historyIpsLong, latestIps, queueHistoryMax);
      pushHistory(
        state.historyIps60m,
        latestIps,
        trendPointLimitForWindow(60 * 60 * 1000),
      );
      pushHistory(
        state.historyIps24h,
        latestIps,
        trendPointLimitForWindow(24 * 60 * 60 * 1000),
      );
      state.lastLongTrendRefreshAtMs = nowMs;

      pushHistory(
        state.historyRedisAggregateKbps,
        state.redisIoAggregate.redisWireKbps,
        historyMax,
      );
      pushHistory(
        state.historyRedisAggregateRxKbps,
        state.redisIoAggregate.redisIngressKbps,
        historyMax,
      );
      pushHistory(
        state.historyRedisAggregateTxKbps,
        state.redisIoAggregate.redisEgressKbps,
        historyMax,
      );

      state.lastRedisSampleAtMs = nowMs;
      state.lastRedisIngressBytes = state.redisIo.redisIngressBytes;
      state.lastRedisIngressReads = state.redisIo.redisIngressReads;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.machine = reduceOpsMachine(state.machine, {
        type: "refresh_error",
        message,
        nowMs: Date.now(),
      });
      if (shouldUseMachineNotice(state)) {
        state.notice = `refresh error: ${message}`;
      }
    } finally {
      state.polling = false;
      app.invalidate();
    }
  };

  const applyQueueSetting = async (
    key:
      | "maxQueueBacklog"
      | "refillLowWatermark"
      | "refillTargetBacklog"
      | "maxClaimPerCycle",
    valueRaw: string,
    label: string,
  ): Promise<void> => {
    const value = parsePositiveInt(valueRaw, -1);
    if (value <= 0) {
      state.notice = `invalid ${label}: ${valueRaw}`;
      app.invalidate();
      return;
    }

    try {
      const next = await updateRunnerSettings((current) => {
        const updated: RunnerControlSettings = {
          ...current,
          [key]: Math.max(1, value),
        } as RunnerControlSettings;

        if (updated.maxQueueBacklog < 10) {
          updated.maxQueueBacklog = 10;
        }
        if (updated.maxClaimPerCycle < 1) {
          updated.maxClaimPerCycle = 1;
        }
        if (updated.refillTargetBacklog > updated.maxQueueBacklog) {
          updated.refillTargetBacklog = updated.maxQueueBacklog;
        }
        if (updated.refillLowWatermark > updated.refillTargetBacklog) {
          updated.refillLowWatermark = updated.refillTargetBacklog;
        }

        return updated;
      });

      state.notice = `${label}=${String(next[key])}`;
      await refresh();
    } catch (error) {
      state.notice =
        error instanceof Error
          ? `set ${label} failed: ${error.message}`
          : String(error);
      app.invalidate();
    }
  };

  const executeHaltAll = async (): Promise<void> => {
    if (state.haltInFlight) {
      return;
    }

    state.haltInFlight = true;
    state.notice = "halt-all: pausing queue and enqueue flow...";
    app.invalidate();

    try {
      const pauseResult = await pauseOpsSystemFlow();
      state.notice = "halt-all: clearing pending queue...";
      app.invalidate();

      const clearResult = await clearOpsQueueIfPaused();
      state.notice =
        "halt-all: stopping runner mode and scaling workers to 0...";
      app.invalidate();

      const stopResult = await setOpsDesiredModeWithQueueAction("stop");
      await scaleWorkers(state.appName, 0);

      const purge = stopResult.purge;
      state.notice =
        `halt complete desired_mode=${stopResult.settings.desiredMode} ` +
        `queue_paused=${pauseResult.queuePaused} workers_target=0 ` +
        `cleared=${clearResult.purge.removed}` +
        (purge
          ? ` stop_purge=${purge.removed} waiting=${purge.remainingWaiting} delayed=${purge.remainingDelayed} paused=${purge.remainingPaused} active=${purge.remainingActive}`
          : "");

      await refresh();
    } catch (error) {
      state.notice =
        error instanceof Error
          ? `halt failed: ${error.message}`
          : String(error);
      app.invalidate();
    } finally {
      state.haltInFlight = false;
    }
  };

  const executeClearQueue = async (): Promise<void> => {
    if (state.clearInFlight) {
      return;
    }

    state.clearInFlight = true;
    state.notice = "clear-queue: clearing pending queue...";
    app.invalidate();

    try {
      const result = await clearOpsQueueIfPaused();
      state.notice =
        `queue cleared purged=${result.purge.removed} ` +
        `waiting=${result.purge.remainingWaiting} ` +
        `delayed=${result.purge.remainingDelayed} ` +
        `paused=${result.purge.remainingPaused} active=${result.purge.remainingActive}`;
      await refresh();
    } catch (error) {
      state.notice =
        error instanceof Error
          ? `clear queue failed: ${error.message}`
          : String(error);
      app.invalidate();
    } finally {
      state.clearInFlight = false;
    }
  };

  const executePromptCommand = async (rawInput: string): Promise<void> => {
    const raw = rawInput.trim();
    if (!raw) {
      state.notice = "command cancelled";
      app.invalidate();
      return;
    }

    const lower = raw.toLowerCase();

    const applyDesiredMode = async (
      desiredMode: RunnerControlSettings["desiredMode"],
    ): Promise<void> => {
      try {
        const action = await setOpsDesiredModeWithQueueAction(desiredMode);
        const next = action.settings;
        if (action.purge) {
          const purge = action.purge;
          state.notice =
            `desired_mode=${next.desiredMode} ` +
            `purged=${purge.removed} ` +
            `waiting=${purge.remainingWaiting} ` +
            `delayed=${purge.remainingDelayed} ` +
            `paused=${purge.remainingPaused} ` +
            `active=${purge.remainingActive}`;
        } else {
          state.notice = `desired_mode=${next.desiredMode}`;
        }
        await refresh();
      } catch (error) {
        state.notice =
          error instanceof Error
            ? `set desired_mode failed: ${error.message}`
            : String(error);
        app.invalidate();
      }
    };

    const applyScaleCount = async (countRaw: string): Promise<void> => {
      const count = parsePositiveInt(countRaw, -1);
      if (count < 0) {
        state.notice = `invalid worker count: ${countRaw}`;
        app.invalidate();
        return;
      }
      try {
        await scaleWorkers(state.appName, count);
        state.notice = `scaled workers to ${count}`;
        await refresh();
      } catch (error) {
        state.notice =
          error instanceof Error
            ? `scale failed: ${error.message}`
            : String(error);
        app.invalidate();
      }
    };

    if (lower === "help") {
      state.showHelp = true;
      state.notice = "help opened";
      app.invalidate();
      return;
    }

    if (lower === "refresh") {
      state.notice = "manual refresh";
      app.invalidate();
      await refresh();
      return;
    }

    if (lower === "quit" || lower === "exit") {
      requestQuit();
      return;
    }

    if (
      lower === "run" ||
      lower === "idle" ||
      lower === "drain" ||
      lower === "stop"
    ) {
      await applyDesiredMode(lower);
      return;
    }

    if (lower === "pause" || lower === "pause-system") {
      if (state.queueGloballyPaused) {
        state.notice = "system already paused";
        app.invalidate();
        return;
      }
      try {
        const result = await pauseOpsSystemFlow();
        state.queueGloballyPaused = result.queuePaused;
        state.notice =
          `system paused desired_mode=${result.settings.desiredMode} ` +
          `enqueue_enabled=${result.settings.enqueueEnabled} queue_paused=${result.queuePaused}`;
        await refresh();
      } catch (error) {
        state.notice =
          error instanceof Error
            ? `pause failed: ${error.message}`
            : String(error);
        app.invalidate();
      }
      return;
    }

    if (lower === "resume" || lower === "resume-system") {
      if (state.queueGloballyPaused === false) {
        state.notice = "system already running";
        app.invalidate();
        return;
      }
      try {
        const result = await resumeOpsSystemFlow();
        state.queueGloballyPaused = result.queuePaused;
        state.notice =
          `system resumed desired_mode=${result.settings.desiredMode} ` +
          `enqueue_enabled=${result.settings.enqueueEnabled} queue_paused=${result.queuePaused}`;
        await refresh();
      } catch (error) {
        state.notice =
          error instanceof Error
            ? `resume failed: ${error.message}`
            : String(error);
        app.invalidate();
      }
      return;
    }

    if (lower === "clear" || lower === "clear-queue") {
      state.showClearConfirm = true;
      state.notice = "confirm clear-queue";
      app.invalidate();
      return;
    }

    if (lower === "halt" || lower === "halt-all" || lower === "stop-all") {
      state.showHaltConfirm = true;
      state.notice = "confirm halt-all";
      app.invalidate();
      return;
    }

    if (lower === "reset") {
      state.historyBacklog = [];
      state.historyProcessed = [];
      state.historyFailures = [];
      state.historyIps = [];
      state.historyIps60m = [];
      state.historyIps24h = [];
      state.historyBacklogDeltaPerSec = [];
      state.historyQueueWaiting = [];
      state.historyQueueActive = [];
      state.historyQueueDelayed = [];
      state.historyQueuePaused = [];
      state.historyQueueCompleted = [];
      state.historyQueueFailed = [];
      state.historyWorkersRunning = [];
      state.historyPendingSuccess = [];
      state.historyPendingError = [];
      state.historyFlushBatches = [];
      state.lastSampleAtMs = null;
      state.lastDbProcessed = null;
      state.lastBacklog = null;
      state.lastQueueCompleted = null;
      resetOpsMetricState(state.metricState);
      state.snapshotTrendLatestByName = {};
      state.snapshotTrendLatestAtMsByName = {};
      state.runnerTrendLatestByName = {};
      state.runnerTrendLatestAtMsByName = {};
      state.notice = "trends reset";
      app.invalidate();
      return;
    }

    if (lower.startsWith("set interval ")) {
      const secondsRaw = lower.replace("set interval ", "").trim();
      const seconds = parsePositiveInt(secondsRaw, -1);
      if (seconds <= 0) {
        state.notice = `invalid interval: ${secondsRaw}`;
      } else {
        state.intervalMs = clamp(seconds * 1000, 1000, 30000);
        state.notice = `interval updated to ${Math.round(state.intervalMs / 1000)}s`;
      }
      app.invalidate();
      return;
    }

    if (lower.startsWith("set flush ")) {
      const flushRaw = lower.replace("set flush ", "").trim();
      const flushMs = parsePositiveInt(flushRaw, -1);
      if (flushMs <= 0) {
        state.notice = `invalid flush ms: ${flushRaw}`;
        app.invalidate();
        return;
      }

      const bounded = clamp(flushMs, 1000, 60000);
      try {
        const next = await updateRunnerSettings((current) => ({
          ...current,
          flushIntervalMs: bounded,
        }));
        state.notice = `flush_interval_ms=${next.flushIntervalMs}`;
        await refresh();
      } catch (error) {
        state.notice =
          error instanceof Error
            ? `set flush failed: ${error.message}`
            : String(error);
        app.invalidate();
      }
      return;
    }

    if (lower === "set harvest on" || lower === "set harvest off") {
      const enabled = lower.endsWith("on");
      try {
        const next = await updateRunnerSettings((current) => ({
          ...current,
          harvestEnabled: enabled,
        }));
        state.notice = `harvest_enabled=${next.harvestEnabled}`;
        await refresh();
      } catch (error) {
        state.notice =
          error instanceof Error
            ? `set harvest failed: ${error.message}`
            : String(error);
        app.invalidate();
      }
      return;
    }

    if (lower.startsWith("set max-backlog ")) {
      const rawValue = lower.replace("set max-backlog ", "").trim();
      await applyQueueSetting("maxQueueBacklog", rawValue, "max_queue_backlog");
      return;
    }

    if (lower.startsWith("set refill-low ")) {
      const rawValue = lower.replace("set refill-low ", "").trim();
      await applyQueueSetting(
        "refillLowWatermark",
        rawValue,
        "refill_low_watermark",
      );
      return;
    }

    if (lower.startsWith("set refill-target ")) {
      const rawValue = lower.replace("set refill-target ", "").trim();
      await applyQueueSetting(
        "refillTargetBacklog",
        rawValue,
        "refill_target_backlog",
      );
      return;
    }

    if (lower.startsWith("set max-claim-cycle ")) {
      const rawValue = lower.replace("set max-claim-cycle ", "").trim();
      await applyQueueSetting(
        "maxClaimPerCycle",
        rawValue,
        "max_claim_per_cycle",
      );
      return;
    }

    if (/^\d+$/.test(lower)) {
      await applyScaleCount(lower);
      return;
    }

    if (lower.startsWith("scale ")) {
      const countRaw = lower.replace("scale ", "").trim();
      await applyScaleCount(countRaw);
      return;
    }

    if (lower.startsWith("workers ")) {
      const countRaw = lower.replace("workers ", "").trim();
      await applyScaleCount(countRaw);
      return;
    }

    if (lower.startsWith("w ")) {
      const countRaw = lower.replace("w ", "").trim();
      await applyScaleCount(countRaw);
      return;
    }

    state.notice = `unknown command: ${raw} (type help)`;
    app.invalidate();
  };

  const openCommandPalette = (menu: "base" | "mode" | "advanced"): void => {
    state.showValuePrompt = false;
    state.valuePromptAction = null;
    state.valuePromptInput = textState();
    state.showCommandPalette = true;
    state.commandMenu = menu;
    state.commandQuery = textState();
    state.commandSelected = 0;
    state.notice = menu === "base" ? "command menu" : `command menu (${menu})`;
    app.invalidate();
  };

  const openValuePrompt = (
    action: ValuePromptAction,
    title: string,
    hint: string,
    initialValue = "",
  ): void => {
    state.showCommandPalette = false;
    state.showValuePrompt = true;
    state.valuePromptAction = action;
    state.valuePromptTitle = title;
    state.valuePromptHint = hint;
    state.valuePromptInput = textState(initialValue);
    state.notice = `enter ${title.toLowerCase()}`;
    app.invalidate();
  };

  const executeValuePrompt = async (): Promise<void> => {
    const action = state.valuePromptAction;
    const value = state.valuePromptInput.value.trim();
    state.showValuePrompt = false;
    state.valuePromptAction = null;

    if (!action || !value) {
      state.notice = "command cancelled";
      app.invalidate();
      return;
    }

    if (action === "scaleWorkers") {
      await executePromptCommand(`scale ${value}`);
      return;
    }
    if (action === "setIntervalSeconds") {
      await executePromptCommand(`set interval ${value}`);
      return;
    }
    if (action === "setFlushMs") {
      await executePromptCommand(`set flush ${value}`);
      return;
    }
    if (action === "setMaxBacklog") {
      await executePromptCommand(`set max-backlog ${value}`);
      return;
    }
    if (action === "setRefillLow") {
      await executePromptCommand(`set refill-low ${value}`);
      return;
    }
    if (action === "setRefillTarget") {
      await executePromptCommand(`set refill-target ${value}`);
      return;
    }
    if (action === "setMaxClaimCycle") {
      await executePromptCommand(`set max-claim-cycle ${value}`);
      return;
    }
    if (action === "rawCommand") {
      await executePromptCommand(value);
    }
  };

  const applyMenuSelection = async (item: MenuItem): Promise<void> => {
    if (item.disabled) {
      state.notice = item.hint
        ? `unavailable: ${item.hint}`
        : "action unavailable";
      app.invalidate();
      return;
    }

    if (item.id === "back") {
      if (state.commandMenu === "base") {
        state.showCommandPalette = false;
        state.notice = "command cancelled";
        app.invalidate();
        return;
      }
      openCommandPalette("base");
      return;
    }

    if (item.id === "menu:mode") {
      openCommandPalette("mode");
      return;
    }

    if (item.id === "menu:advanced") {
      openCommandPalette("advanced");
      return;
    }

    if (item.id === "prompt:scale") {
      openValuePrompt(
        "scaleWorkers",
        "Worker count",
        "Enter number of workers (0+) ",
      );
      return;
    }

    if (item.id === "prompt:interval") {
      openValuePrompt("setIntervalSeconds", "Poll interval seconds", "1..30");
      return;
    }

    if (item.id === "prompt:flush") {
      const currentFlush = state.snapshot.settings?.flushIntervalMs;
      openValuePrompt(
        "setFlushMs",
        "Flush interval ms",
        currentFlush
          ? `Current ${currentFlush}ms (1000..60000)`
          : "1000..60000",
      );
      return;
    }

    if (item.id === "prompt:max-backlog") {
      openValuePrompt("setMaxBacklog", "Max backlog", "Queue backlog cap");
      return;
    }

    if (item.id === "prompt:refill-low") {
      openValuePrompt("setRefillLow", "Refill low watermark", "Refill trigger");
      return;
    }

    if (item.id === "prompt:refill-target") {
      openValuePrompt(
        "setRefillTarget",
        "Refill target backlog",
        "Refill destination",
      );
      return;
    }

    if (item.id === "prompt:max-claim-cycle") {
      openValuePrompt(
        "setMaxClaimCycle",
        "Max claim per cycle",
        "Claim batch size",
      );
      return;
    }

    if (item.id === "prompt:raw") {
      openValuePrompt("rawCommand", "Raw command", "Example: set harvest on");
      return;
    }

    if (item.id === "toggle:harvest") {
      state.showCommandPalette = false;
      try {
        const next = await updateRunnerSettings((current) => ({
          ...current,
          harvestEnabled: !current.harvestEnabled,
        }));
        state.notice = `harvest_enabled=${next.harvestEnabled}`;
        await refresh();
      } catch (error) {
        state.notice =
          error instanceof Error
            ? `harvest toggle failed: ${error.message}`
            : String(error);
        app.invalidate();
      }
      return;
    }

    if (item.id === "action:pause-system") {
      state.showCommandPalette = false;
      await executePromptCommand("pause-system");
      return;
    }

    if (item.id === "action:resume-system") {
      state.showCommandPalette = false;
      await executePromptCommand("resume-system");
      return;
    }

    if (item.id === "action:clear-queue") {
      state.showCommandPalette = false;
      state.showClearConfirm = true;
      state.notice = "confirm clear-queue";
      app.invalidate();
      return;
    }

    if (item.id === "action:halt-all") {
      state.showCommandPalette = false;
      state.showHaltConfirm = true;
      state.notice = "confirm halt-all";
      app.invalidate();
      return;
    }

    if (item.id === "action:refresh") {
      state.showCommandPalette = false;
      state.notice = "manual refresh";
      app.invalidate();
      await refresh();
      return;
    }

    if (item.id === "action:redis-io-reset") {
      state.showCommandPalette = false;
      resetOpsRedisIoStats();
      state.redisIo = readOpsRedisIoStats();
      state.historyRedisKbps = [];
      state.historyRedisReadsPerSec = [];
      state.historyRedisAggregateKbps = [];
      state.historyRedisAggregateRxKbps = [];
      state.historyRedisAggregateTxKbps = [];
      state.lastRedisSampleAtMs = null;
      state.lastRedisIngressBytes = null;
      state.lastRedisIngressReads = null;
      state.notice = "redis io stats reset";
      app.invalidate();
      return;
    }

    if (item.id === "action:help") {
      state.showCommandPalette = false;
      state.showHelp = true;
      state.notice = "help opened";
      app.invalidate();
      return;
    }

    if (item.id === "action:quit") {
      requestQuit();
      return;
    }

    if (item.id.startsWith("mode:")) {
      state.showCommandPalette = false;
      await executePromptCommand(item.id.replace("mode:", ""));
    }
  };

  app.on("key", (event) => {
    if (
      state.showCommandPalette ||
      state.showValuePrompt ||
      state.showHaltConfirm ||
      state.showClearConfirm
    ) {
      return;
    }

    if (event.key === "q") {
      requestQuit();
      return;
    }

    if (event.key === "h") {
      state.showHelp = !state.showHelp;
      app.invalidate();
      return;
    }

    if (event.key === "1") {
      state.activeScreen = "summary";
      state.notice = "screen=summary";
      app.invalidate();
      return;
    }

    if (event.key === "2") {
      state.activeScreen = "infra";
      state.notice = "screen=infra";
      app.invalidate();
      return;
    }

    if (event.key === "3") {
      state.activeScreen = "processing";
      state.notice = "screen=processing";
      app.invalidate();
      return;
    }

    if (event.key === "4") {
      state.activeScreen = "queuejobs";
      state.notice = "screen=queuejobs";
      app.invalidate();
      return;
    }

    if (event.key === "5") {
      state.activeScreen = "observability";
      state.notice = "screen=observability";
      app.invalidate();
      return;
    }

    if (event.key === "tab") {
      state.activeScreen = nextScreen(state.activeScreen);
      state.notice = `screen=${state.activeScreen}`;
      app.invalidate();
      return;
    }

    if (event.key === "r") {
      state.notice = "manual refresh";
      app.invalidate();
      void refresh();
      return;
    }

    if (event.key === "p") {
      if (state.queueGloballyPaused === null) {
        state.notice = "pause/resume unavailable: queue pause state unknown";
        app.invalidate();
        return;
      }
      const command = state.queueGloballyPaused
        ? "resume-system"
        : "pause-system";
      state.notice =
        command === "resume-system"
          ? "resuming system flow"
          : "pausing system flow";
      app.invalidate();
      void executePromptCommand(command);
      return;
    }

    if (event.key === "f") {
      const currentFlush = state.snapshot.settings?.flushIntervalMs;
      openValuePrompt(
        "setFlushMs",
        "Flush interval ms",
        currentFlush
          ? `Current ${currentFlush}ms (1000..60000)`
          : "1000..60000",
      );
      return;
    }

    if (event.key === "+" || event.key === "=") {
      state.intervalMs = clamp(state.intervalMs - 500, 1000, 30000);
      state.notice = `interval=${Math.round(state.intervalMs / 1000)}s`;
      app.invalidate();
      return;
    }

    if (event.key === "-") {
      state.intervalMs = clamp(state.intervalMs + 500, 1000, 30000);
      state.notice = `interval=${Math.round(state.intervalMs / 1000)}s`;
      app.invalidate();
      return;
    }

    if (event.key === ":") {
      openCommandPalette("base");
    }
  });

  app.on("paste", (event) => {
    if (state.showValuePrompt) {
      state.valuePromptInput = insertText(state.valuePromptInput, event.text);
      app.invalidate();
    }
  });

  app.render(({ ui, theme }) => {
    const snapshot = state.snapshot;
    const settings = snapshot.settings;
    const status = snapshot.status;
    const queue = snapshot.queue;
    const projection = snapshot.projections;
    const perfRollups = snapshot.performanceRollups;
    const rollup15s = perfRollups?.rollup15s;
    const rollup1m = perfRollups?.rollup1m;
    const rollup15m = perfRollups?.rollup15m;
    const rollup60m = perfRollups?.rollup60m;
    const rollup24h = perfRollups?.rollup24h;
    const trendPointLimit = trendPointLimitForWindow(state.trendWindowMs);
    const nowMs = Date.now();
    const queueTrendGraph = metricGraphDataFromState({
      state: state.metricState,
      metricId: "snapshot.queueBacklogLive",
      nowMs,
      windowMs: state.trendWindowMs,
      targetPoints: trendPointLimit,
    });
    const moduleBacklogTrend = selectDisplaySeries({
      primary: queueTrendGraph.points,
      secondary: normalizeTrendSeries(
        projection.queueBacklogTrendSmoothed,
        trendPointLimit,
      ),
      fallback: [Math.max(0, Number(queue?.backlog ?? status?.queueBacklog ?? 0))],
      targetPoints: trendPointLimit,
      maxPoints: QUEUE_TREND_DISPLAY_POINT_MAX,
    });
    const longWindowPointLimit = trendPointLimitForWindow(
      LONG_TREND_WINDOW_MINUTES * 60 * 1000,
    );
    const sampledIpsLongRaw = tail(state.historyIpsLong, longWindowPointLimit);
    const shortIpsRaw = tail(sampledIpsLongRaw, trendPointLimit);
    const longIpsDisplayLimit = clamp(
      trendPointLimit * LONG_IPS_DISPLAY_WIDTH_FACTOR,
      trendPointLimit,
      LONG_IPS_DISPLAY_POINT_MAX,
    );
    const moduleIpsTrend =
      shortIpsRaw.length > 0
        ? resampleSeriesToCount(shortIpsRaw, trendPointLimit)
        : normalizeTrendSeries(projection.ipsSmoothed, trendPointLimit);
    const longIpsTrend =
      sampledIpsLongRaw.length > 0
        ? resampleSeriesToCount(sampledIpsLongRaw, longIpsDisplayLimit)
        : moduleIpsTrend;
    const trendWindowMinutes = Math.max(
      1,
      Math.round(state.trendWindowMs / 60000),
    );
    const ipsTrendSharedMax = Math.max(
      1,
      seriesMax(moduleIpsTrend),
      seriesMax(longIpsTrend),
    );
    const queueTrendMax = Math.max(1, seriesMax(moduleBacklogTrend));
    const historyIpsNow =
      state.historyIps.length > 0
        ? state.historyIps[state.historyIps.length - 1] || 0
        : 0;
    const statusIpsNow = Math.max(
      0,
      Number(status?.throughputImagesPerMinute || 0) / 60,
    );
    const projectionIpsNow =
      projection.sampleCount > 0
        ? Math.max(0, projection.headline.ipsSmoothedNow)
        : 0;
    const rollup15sIpsNow = Math.max(0, Number(rollup15s?.ips || 0));
    const rollup1mIpsNow = Math.max(0, Number(rollup1m?.ips || 0));
    const rollup15mIpsNow = Math.max(0, Number(rollup15m?.ips || 0));
    const statusUpdatedAtMs = status?.updatedAt
      ? Date.parse(String(status.updatedAt))
      : null;
    const rollup15sSampledAtMs = rollup15s?.sampledAt
      ? Date.parse(String(rollup15s.sampledAt))
      : null;
    const liveSliceStatusFresh = isSampleFresh({
      sampledAtMs: statusUpdatedAtMs,
      nowMs,
      maxAgeMs: LIVE_SLICE_MAX_AGE_MS,
    });
    const liveSliceRollup15sFresh = isSampleFresh({
      sampledAtMs: rollup15sSampledAtMs,
      nowMs,
      maxAgeMs: LIVE_SLICE_MAX_AGE_MS,
    });
    const liveSliceLocalFresh = isSampleFresh({
      sampledAtMs: state.lastSampleAtMs,
      nowMs,
      maxAgeMs: LIVE_SLICE_MAX_AGE_MS,
    });
    const ipsLiveCandidates: number[] = [];
    if (liveSliceStatusFresh) {
      ipsLiveCandidates.push(statusIpsNow);
    }
    if (liveSliceRollup15sFresh) {
      ipsLiveCandidates.push(rollup15sIpsNow);
    }
    if (liveSliceLocalFresh) {
      ipsLiveCandidates.push(historyIpsNow);
    }
    const ipsNow = Math.max(
      historyIpsNow,
      projectionIpsNow,
      statusIpsNow,
      rollup15sIpsNow,
      rollup1mIpsNow,
      rollup15mIpsNow,
    );
    const ipmNow = ipsNow * 60;
    const secPerImageNow = ipsNow > 0 ? 1 / ipsNow : null;
    const backlog = queue?.backlog ?? 0;
    const etaQueueEmptySeconds =
      backlog === 0 ? 0 : ipsNow > 0 ? backlog / ipsNow : null;
    const maxBacklog = Math.max(1, settings?.maxQueueBacklog ?? 1);
    const backlogFillRatio = clamp(backlog / maxBacklog, 0, 1);
    const queueWaiting = queue?.waiting ?? 0;
    const queueActive = queue?.active ?? 0;
    const queueDelayed = queue?.delayed ?? 0;
    const queuePaused = queue?.paused ?? 0;
    const queuePendingNonActive = queueWaiting + queueDelayed + queuePaused;
    const activeJobRatio = backlog > 0 ? queueActive / backlog : 0;
    const ipsLive =
      ipsLiveCandidates.length > 0 ? Math.max(0, ...ipsLiveCandidates) : 0;
    const ipsGaugeMax = Math.max(
      1,
      ipsLive,
      ...(moduleIpsTrend.length > 0 ? moduleIpsTrend : [0]),
    );
    const ipsGaugeValue = clamp(ipsLive / ipsGaugeMax, 0, 1);
    const telemetry = deriveOpsTelemetry({
      settings,
      infra: snapshot.infra,
      status,
      queue,
      errors: snapshot.errors,
    });
    const runnerStatusAgeSeconds = telemetry.runnerStaleSeconds;
    const runnerStatusIsStale =
      runnerStatusAgeSeconds !== null && runnerStatusAgeSeconds > 30;
    const queueFlowStateLabel =
      state.queueGloballyPaused === null
        ? "unknown"
        : state.queueGloballyPaused
          ? "paused"
          : "running";
    const pauseHotkeyActionLabel =
      state.queueGloballyPaused === null
        ? "unavailable"
        : state.queueGloballyPaused
          ? "resume-system"
          : "pause-system";
    const moduleRole = snapshot.metricSystem?.role || "unknown";

    if (state.activeScreen === "summary") {
      ui.grid(
        {
          columns: ["1fr", "1fr", "1fr", "1fr", "1fr", "1fr"],
          rows: [8, 10, 10, 10],
          gap: 1,
        },
        (grid) => {
          grid.panel({ title: "Heads Up", colSpan: 2 }, (panel) => {
            panel.keyValues([
              { label: "app", value: state.appName },
              { label: "time", value: state.uiClockAt },
              {
                label: "ui_interval_s",
                value: String(Math.round(state.intervalMs / 1000)),
              },
              {
                label: "pause_status",
                value: queueFlowStateLabel,
                color:
                  state.queueGloballyPaused === null
                    ? theme.warning
                    : state.queueGloballyPaused
                      ? theme.danger
                      : theme.success,
              },
              {
                label: "module_role",
                value: moduleRole,
                color:
                  moduleRole === "master"
                    ? theme.success
                    : moduleRole === "standby"
                      ? theme.warning
                      : theme.warning,
              },
              { label: "p_hotkey_action", value: pauseHotkeyActionLabel },
              {
                label: UI_LABELS.image.ips,
                value: formatRate(Number(rollup15s?.ips || ipsNow), 2),
              },
              {
                label: UI_LABELS.image.ipm,
                value: formatRate(Number(rollup15s?.ipm || ipmNow), 2),
              },
              {
                label: UI_LABELS.image.processed,
                value: String(rollup15s?.processedItems ?? 0),
              },
              {
                label: UI_LABELS.image.failed,
                value: String(rollup15s?.failedItems ?? 0),
              },
              {
                label: "sec_per_image_5m",
                value:
                  (rollup15s?.secPerImage ?? secPerImageNow) === null
                    ? "n/a"
                    : formatRate(rollup15s?.secPerImage ?? secPerImageNow, 2),
              },
              { label: UI_LABELS.queue.pending, value: String(backlog) },
              { label: UI_LABELS.queue.active, value: String(queueActive) },
              {
                label: "eta_queue_empty",
                value: formatDuration(etaQueueEmptySeconds),
              },
              {
                label: "db_complete",
                value: `${(snapshot.db?.pct ?? 0).toFixed(2)}%`,
              },
              {
                label: "queue_flow",
                value: queueFlowStateLabel,
                color:
                  state.queueGloballyPaused === null
                    ? theme.warning
                    : state.queueGloballyPaused
                      ? theme.danger
                      : theme.success,
              },
              {
                label: "live_status",
                value: state.machine.notice,
                color:
                  state.machine.notice.toLowerCase().includes("error") ||
                  state.machine.notice.toLowerCase().includes("fail")
                    ? theme.danger
                    : state.machine.notice.toLowerCase().includes("stale")
                      ? theme.warning
                      : theme.success,
              },
              { label: "notice", value: state.notice },
              {
                label: "errors",
                value: `${Object.keys(snapshot.errors).length}`,
              },
              {
                label: "metric_ref_errors",
                value: String(state.metricReferenceErrors.length),
                color:
                  state.metricReferenceErrors.length > 0
                    ? theme.danger
                    : theme.success,
              },
              {
                label: "runner_stale_s",
                value:
                  telemetry.runnerStaleSeconds === null
                    ? "n/a"
                    : String(telemetry.runnerStaleSeconds),
              },
              {
                label: "infra_stale_s",
                value:
                  telemetry.infraStaleSeconds === null
                    ? "n/a"
                    : String(telemetry.infraStaleSeconds),
              },
              { label: "gate_live", value: telemetry.liveGate },
            ]);
          });

          grid.panel({ title: "Infra Snapshot", colSpan: 2 }, (panel) => {
            panel.keyValues([
              {
                label: "machines",
                value: `${snapshot.machines?.length ?? 0} (${machineStateSummary(snapshot.machines)}) / workers ${telemetry.liveWorkersRunning}`,
              },
              {
                label: "workers_running",
                value: String(telemetry.liveWorkersRunning),
              },
              {
                label: "redis_wire",
                value: formatBitrateFromKbps(state.redisIo.redisWireKbps),
              },
              {
                label: "redis_rx",
                value: formatBitrateFromKbps(state.redisIo.redisIngressKbps),
              },
              {
                label: "redis_tx",
                value: formatBitrateFromKbps(state.redisIo.redisEgressKbps),
              },
              {
                label: "redis_reads",
                value: String(state.redisIo.redisIngressReads),
              },
              {
                label: "rx_latency",
                value: `${state.redisIo.rxLatencyMs}ms`,
              },
              {
                label: "tx_latency",
                value: `${state.redisIo.txLatencyMs}ms`,
              },
              { label: "redis_last", value: state.redisIo.lastReadAt || "-" },
            ]);
          });

          grid.panel(
            { title: "Database Completeness", colSpan: 2 },
            (panel) => {
              panel.keyValues([
                {
                  label: "processed",
                  value: String(snapshot.db?.processed ?? 0),
                },
                {
                  label: "pending",
                  value: String(snapshot.db?.pending ?? 0),
                },
                {
                  label: "failed",
                  value: String(snapshot.db?.failed ?? 0),
                },
                { label: "total", value: String(snapshot.db?.total ?? 0) },
                {
                  label: "progress",
                  value: `${(snapshot.db?.pct ?? 0).toFixed(2)}%`,
                },
              ]);
            },
          );

          grid.panel(
            { title: "Image Processing (5m)", colSpan: 2 },
            (panel) => {
              panel.keyValues([
                {
                  label: UI_LABELS.image.processed,
                  value: String(rollup15s?.processedItems ?? 0),
                },
                {
                  label: UI_LABELS.image.failed,
                  value: String(rollup15s?.failedItems ?? 0),
                },
                {
                  label: UI_LABELS.image.ips,
                  value: formatRate(Number(rollup15s?.ips ?? 0), 2),
                },
                {
                  label: UI_LABELS.image.ipm,
                  value: formatRate(Number(rollup15s?.ipm ?? 0), 2),
                },
                {
                  label: UI_LABELS.image.avgFetchMs,
                  value: String(rollup15s?.avgFetchMs ?? 0),
                },
                {
                  label: UI_LABELS.image.avgTransformMs,
                  value: String(rollup15s?.avgTransformMs ?? 0),
                },
                {
                  label: UI_LABELS.image.avgUploadMs,
                  value: String(rollup15s?.avgUploadMs ?? 0),
                },
                {
                  label: UI_LABELS.image.avgElapsedMs,
                  value: String(rollup15s?.metricJobElapsedMsAvg ?? 0),
                },
              ]);
            },
          );

          grid.panel(
            {
              title: `IPS Trend (${trendWindowMinutes}m) (0-${ipsTrendSharedMax.toFixed(1)})`,
              colSpan: 2,
            },
            (panel) => {
              panel.graph({
                values: moduleIpsTrend.length > 0 ? moduleIpsTrend : [0],
                min: 0,
                max: ipsTrendSharedMax,
                axis: false,
                color: theme.success,
              });
            },
          );

          grid.panel({ title: "IPS Rate (live)", colSpan: 2 }, (panel) => {
            panel.gauge({
              value: ipsGaugeValue,
              label: `ips_live ${formatRate(ipsLive, 2)}`,
            });
          });

          grid.panel({ title: "Queue & Jobs (5m)", colSpan: 2 }, (panel) => {
            panel.keyValues([
              { label: "mode", value: status?.mode || "none" },
              {
                label: "runner_state",
                value: runnerStatusIsStale ? "stale" : "fresh",
                color: runnerStatusIsStale ? theme.warning : theme.success,
              },
              {
                label: "desired",
                value: status?.desiredMode || settings?.desiredMode || "n/a",
              },
              {
                label: UI_LABELS.queue.pending,
                value: String(queuePendingNonActive),
              },
              { label: UI_LABELS.queue.active, value: String(queueActive) },
              {
                label: UI_LABELS.queue.completed,
                value: String(rollup15s?.completedJobs ?? 0),
              },
              {
                label: UI_LABELS.queue.failed,
                value: String(rollup15s?.failedJobs ?? 0),
              },
            ]);
            panel.gauge({
              value: activeJobRatio,
              label: `active jobs ${queueActive}`,
            });
          });

          grid.panel(
            {
              title: `Queue Trend (${trendWindowMinutes}m) (0-${queueTrendMax.toFixed(1)})`,
              colSpan: 2,
            },
            (panel) => {
              panel.graph({
                values: moduleBacklogTrend,
                min: 0,
                max: queueTrendMax,
                axis: false,
                color: theme.warning,
              });
            },
          );

          grid.panel({ title: "Queue Size (live)", colSpan: 2 }, (panel) => {
            panel.gauge({
              value: backlogFillRatio,
              label: `backlog_live ${backlog}`,
            });
          });

          grid.panel(
            { title: "Image Processing (15m)", colSpan: 2 },
            (panel) => {
              panel.keyValues([
                {
                  label: UI_LABELS.image.processed,
                  value: String(rollup15m?.processedItems ?? 0),
                },
                {
                  label: UI_LABELS.image.failed,
                  value: String(rollup15m?.failedItems ?? 0),
                },
                {
                  label: UI_LABELS.image.ips,
                  value: formatRate(Number(rollup15m?.ips ?? 0), 2),
                },
                {
                  label: UI_LABELS.image.ipm,
                  value: formatRate(Number(rollup15m?.ipm ?? 0), 2),
                },
                {
                  label: UI_LABELS.image.avgFetchMs,
                  value: String(rollup15m?.avgFetchMs ?? 0),
                },
                {
                  label: UI_LABELS.image.avgTransformMs,
                  value: String(rollup15m?.avgTransformMs ?? 0),
                },
                {
                  label: UI_LABELS.image.avgUploadMs,
                  value: String(rollup15m?.avgUploadMs ?? 0),
                },
                {
                  label: UI_LABELS.image.avgElapsedMs,
                  value: String(rollup15m?.metricJobElapsedMsAvg ?? 0),
                },
              ]);
            },
          );

          grid.panel(
            {
              title: `IPS Trend (${LONG_TREND_WINDOW_MINUTES}m) (0-${ipsTrendSharedMax.toFixed(1)})`,
              colSpan: 4,
            },
            (panel) => {
              panel.graph({
                values: longIpsTrend.length > 0 ? longIpsTrend : [0],
                min: 0,
                max: ipsTrendSharedMax,
                axis: false,
                color: theme.success,
              });
              panel.statusBar({
                items: [{ label: "■ ips_smoothed", color: theme.success }],
                right: [
                  { label: `ips_live ${formatRate(ipsLive, 2)}` },
                  { label: `y:0-${ipsTrendSharedMax.toFixed(1)}` },
                ],
                keyStyle: "plain",
              });
            },
          );
        },
      );
    }

    if (state.showHaltConfirm) {
      ui.modal(
        {
          width: 72,
          height: 10,
          title: "Confirm Stop It All",
          onDismiss: () => {
            if (state.haltInFlight) {
              return;
            }
            state.showHaltConfirm = false;
            state.notice = "halt-all cancelled";
            app.invalidate();
          },
          onKey: (event) => {
            if (state.haltInFlight) {
              return;
            }

            if (event.key === "escape") {
              state.showHaltConfirm = false;
              state.notice = "halt-all cancelled";
              app.invalidate();
              return;
            }

            if (event.key === "enter") {
              state.showHaltConfirm = false;
              void executeHaltAll();
            }
          },
          buttons: [
            {
              label: "Cancel",
              onPress: () => {
                if (state.haltInFlight) {
                  return;
                }
                state.showHaltConfirm = false;
                state.notice = "halt-all cancelled";
                app.invalidate();
              },
            },
            {
              label: state.haltInFlight ? "Stopping..." : "Stop It All",
              onPress: () => {
                if (state.haltInFlight) {
                  return;
                }
                state.showHaltConfirm = false;
                void executeHaltAll();
              },
            },
          ],
        },
        (modal) => {
          modal.text(
            "This will pause workers, clear pending queue, set runner to stop mode, and scale all workers to 0.",
          );
          modal.text("Press Enter or click Stop It All to confirm.");
          modal.text("Press Esc or Cancel to abort.");
        },
      );
    }

    if (state.activeScreen === "processing") {
      const ips60mSeries =
        state.historyIps60m.length > 0 ? state.historyIps60m : moduleIpsTrend;
      const ips24hSeries =
        state.historyIps24h.length > 0 ? state.historyIps24h : longIpsTrend;
      const ips60mAvg = average(ips60mSeries);
      const ips24hAvg = average(ips24hSeries);
      const ipsSectionMax = Math.max(
        1,
        seriesMax(ips60mSeries),
        seriesMax(ips24hSeries),
      );

      const imageProcessingFields = (input: {
        ips: number;
        ipm: number;
        processedItems?: number | null;
        failedItems?: number | null;
        avgFetchMs?: number | null;
        avgTransformMs?: number | null;
        avgUploadMs?: number | null;
        avgElapsedMs?: number | null;
      }) => {
        const processedItems = input.processedItems;
        const failedItems = input.failedItems;
        return [
          {
            label: UI_LABELS.image.processed,
            value:
              processedItems === null ||
              processedItems === undefined ||
              !Number.isFinite(processedItems)
                ? "n/a"
                : String(Math.max(0, Math.round(processedItems))),
          },
          {
            label: UI_LABELS.image.failed,
            value:
              failedItems === null ||
              failedItems === undefined ||
              !Number.isFinite(failedItems)
                ? "n/a"
                : String(Math.max(0, Math.round(failedItems))),
          },
          { label: UI_LABELS.image.ips, value: formatRate(input.ips, 2) },
          { label: UI_LABELS.image.ipm, value: formatRate(input.ipm, 2) },
          {
            label: UI_LABELS.image.avgFetchMs,
            value:
              input.avgFetchMs === null ||
              input.avgFetchMs === undefined ||
              !Number.isFinite(input.avgFetchMs)
                ? "n/a"
                : String(Math.max(0, Math.round(input.avgFetchMs))),
          },
          {
            label: UI_LABELS.image.avgTransformMs,
            value:
              input.avgTransformMs === null ||
              input.avgTransformMs === undefined ||
              !Number.isFinite(input.avgTransformMs)
                ? "n/a"
                : String(Math.max(0, Math.round(input.avgTransformMs))),
          },
          {
            label: UI_LABELS.image.avgUploadMs,
            value:
              input.avgUploadMs === null ||
              input.avgUploadMs === undefined ||
              !Number.isFinite(input.avgUploadMs)
                ? "n/a"
                : String(Math.max(0, Math.round(input.avgUploadMs))),
          },
          {
            label: UI_LABELS.image.avgElapsedMs,
            value:
              input.avgElapsedMs === null ||
              input.avgElapsedMs === undefined ||
              !Number.isFinite(input.avgElapsedMs)
                ? "n/a"
                : String(Math.max(0, Math.round(input.avgElapsedMs))),
          },
        ];
      };

      ui.grid(
        {
          columns: ["1fr", "1fr", "1fr", "1fr", "1fr", "1fr"],
          rows: [8, 8, 8, 10, 10],
          gap: 1,
        },
        (grid) => {
          grid.panel(
            { title: "Image Processing - live", colSpan: 3 },
            (panel) => {
              panel.keyValues(
                imageProcessingFields({
                  ips: ipsLive,
                  ipm: ipsLive * 60,
                  processedItems: status?.processedItems ?? null,
                  failedItems: status?.failedItems ?? null,
                  avgFetchMs: rollup15s?.avgFetchMs ?? null,
                  avgTransformMs: rollup15s?.avgTransformMs ?? null,
                  avgUploadMs: rollup15s?.avgUploadMs ?? null,
                  avgElapsedMs: rollup15s?.metricJobElapsedMsAvg ?? null,
                }),
              );
            },
          );

          grid.panel({ title: "Live IPS Gauge", colSpan: 3 }, (panel) => {
            panel.gauge({
              value: ipsGaugeValue,
              label: `ips_live ${formatRate(ipsLive, 2)}`,
            });
          });

          grid.panel(
            { title: "Image Processing - 15s", colSpan: 3 },
            (panel) => {
              panel.keyValues(
                imageProcessingFields({
                  ips: Number(rollup15s?.ips || 0),
                  ipm: Number(rollup15s?.ipm || 0),
                  processedItems: rollup15s?.processedItems ?? null,
                  failedItems: rollup15s?.failedItems ?? null,
                  avgFetchMs: rollup15s?.avgFetchMs ?? null,
                  avgTransformMs: rollup15s?.avgTransformMs ?? null,
                  avgUploadMs: rollup15s?.avgUploadMs ?? null,
                  avgElapsedMs: rollup15s?.metricJobElapsedMsAvg ?? null,
                }),
              );
            },
          );

          grid.panel(
            { title: "Image Processing - 1m", colSpan: 3 },
            (panel) => {
              panel.keyValues(
                imageProcessingFields({
                  ips: Number(rollup1m?.ips || 0),
                  ipm: Number(rollup1m?.ipm || 0),
                  processedItems: rollup1m?.processedItems ?? null,
                  failedItems: rollup1m?.failedItems ?? null,
                  avgFetchMs: rollup1m?.avgFetchMs ?? null,
                  avgTransformMs: rollup1m?.avgTransformMs ?? null,
                  avgUploadMs: rollup1m?.avgUploadMs ?? null,
                  avgElapsedMs: rollup1m?.metricJobElapsedMsAvg ?? null,
                }),
              );
            },
          );

          grid.panel(
            { title: "Image Processing - 15m", colSpan: 2 },
            (panel) => {
              panel.keyValues(
                imageProcessingFields({
                  ips: Number(rollup15m?.ips || 0),
                  ipm: Number(rollup15m?.ipm || 0),
                  processedItems: rollup15m?.processedItems ?? null,
                  failedItems: rollup15m?.failedItems ?? null,
                  avgFetchMs: rollup15m?.avgFetchMs ?? null,
                  avgTransformMs: rollup15m?.avgTransformMs ?? null,
                  avgUploadMs: rollup15m?.avgUploadMs ?? null,
                  avgElapsedMs: rollup15m?.metricJobElapsedMsAvg ?? null,
                }),
              );
            },
          );

          grid.panel(
            { title: "Image Processing - 60m", colSpan: 2 },
            (panel) => {
              panel.keyValues(
                imageProcessingFields({
                  ips: Number(rollup60m?.ips || ips60mAvg),
                  ipm: Number(rollup60m?.ipm || ips60mAvg * 60),
                  processedItems: rollup60m?.processedItems ?? null,
                  failedItems: rollup60m?.failedItems ?? null,
                  avgFetchMs: rollup60m?.avgFetchMs ?? null,
                  avgTransformMs: rollup60m?.avgTransformMs ?? null,
                  avgUploadMs: rollup60m?.avgUploadMs ?? null,
                  avgElapsedMs: rollup60m?.metricJobElapsedMsAvg ?? null,
                }),
              );
            },
          );

          grid.panel(
            { title: "Image Processing - 24h", colSpan: 2 },
            (panel) => {
              panel.keyValues(
                imageProcessingFields({
                  ips: Number(rollup24h?.ips || ips24hAvg),
                  ipm: Number(rollup24h?.ipm || ips24hAvg * 60),
                  processedItems: rollup24h?.processedItems ?? null,
                  failedItems: rollup24h?.failedItems ?? null,
                  avgFetchMs: rollup24h?.avgFetchMs ?? null,
                  avgTransformMs: rollup24h?.avgTransformMs ?? null,
                  avgUploadMs: rollup24h?.avgUploadMs ?? null,
                  avgElapsedMs: rollup24h?.metricJobElapsedMsAvg ?? null,
                }),
              );
            },
          );

          grid.panel(
            {
              title: `IPS Trend 60m (0-${ipsSectionMax.toFixed(1)})`,
              colSpan: 6,
            },
            (panel) => {
              panel.graph({
                values: ips60mSeries.length > 0 ? ips60mSeries : [0],
                min: 0,
                max: ipsSectionMax,
                axis: false,
                color: theme.success,
              });
            },
          );

          grid.panel(
            {
              title: `IPS Trend 24h (0-${ipsSectionMax.toFixed(1)})`,
              colSpan: 6,
            },
            (panel) => {
              panel.graph({
                values: ips24hSeries.length > 0 ? ips24hSeries : [0],
                min: 0,
                max: ipsSectionMax,
                axis: false,
                color: theme.info,
              });
            },
          );
        },
      );
    }

    if (state.activeScreen === "queuejobs") {
      const deltaSeries = (values: number[]): number[] => {
        if (values.length < 2) {
          return [];
        }
        const output: number[] = [];
        for (let index = 1; index < values.length; index += 1) {
          const previous = values[index - 1] || 0;
          const next = values[index] || 0;
          output.push(Math.max(0, next - previous));
        }
        return output;
      };

      const queueCompletedDeltaHistory = deltaSeries(
        state.historyQueueCompleted,
      );
      const queueFailedDeltaHistory = deltaSeries(state.historyQueueFailed);
      const queueActivityDeltaHistory = queueCompletedDeltaHistory.map(
        (completed, index) => completed + (queueFailedDeltaHistory[index] || 0),
      );

      const queue60mLimit = trendPointLimitForWindow(60 * 60 * 1000);
      const queue24hLimit = clamp(
        trendPointLimitForWindow(24 * 60 * 60 * 1000),
        60,
        QUEUE_24H_DISPLAY_POINT_MAX,
      );
      const nowMs = Date.now();
      const queueBacklogMetricId = "snapshot.queueBacklogLive";
      const queue60mGraph = metricGraphDataFromState({
        state: state.metricState,
        metricId: queueBacklogMetricId,
        nowMs,
        windowMs: 60 * 60 * 1000,
        targetPoints: queue60mLimit,
      });
      const queue24hGraph = metricGraphDataFromState({
        state: state.metricState,
        metricId: queueBacklogMetricId,
        nowMs,
        windowMs: 24 * 60 * 60 * 1000,
        targetPoints: queue24hLimit,
      });
      const queueActivity60mSeries = resampleSeriesToCount(
        queueActivityDeltaHistory,
        queue60mLimit,
      );
      const queueActivity24hSeries = resampleSeriesToCount(
        queueActivityDeltaHistory,
        queue24hLimit,
      );

      const queue60mSeries = selectDisplaySeries({
        primary: queue60mGraph.points,
        secondary: queueActivity60mSeries,
        fallback: moduleBacklogTrend,
        targetPoints: queue60mLimit,
        maxPoints: QUEUE_TREND_DISPLAY_POINT_MAX,
      });
      const queue24hSeries = selectDisplaySeries({
        primary: queue24hGraph.points,
        secondary: queueActivity24hSeries,
        fallback: moduleBacklogTrend,
        targetPoints: queue24hLimit,
        maxPoints: QUEUE_TREND_DISPLAY_POINT_MAX,
      });
      const queue60mSectionMax = Math.max(1, seriesMax(queue60mSeries));
      const queue24hSectionMax = Math.max(1, seriesMax(queue24hSeries));

      const queueCompletedLive =
        snapshot.queue?.completed ?? status?.queueCompleted ?? 0;
      const queueFailedLive =
        snapshot.queue?.failed ?? status?.queueFailed ?? 0;

      ui.grid(
        {
          columns: ["1fr", "1fr", "1fr"],
          rows: [8, 8, 6, 10, 10],
          gap: 1,
        },
        (grid) => {
          grid.panel({ title: "Queue & Jobs - live" }, (panel) => {
            panel.keyValues([
              {
                label: UI_LABELS.queue.pending,
                value: String(queuePendingNonActive),
              },
              { label: UI_LABELS.queue.active, value: String(queueActive) },
              {
                label: UI_LABELS.queue.completed,
                value: String(queueCompletedLive),
              },
              {
                label: UI_LABELS.queue.failed,
                value: String(queueFailedLive),
              },
            ]);
          });

          grid.panel({ title: "Queue & Jobs - 15s" }, (panel) => {
            panel.keyValues([
              {
                label: UI_LABELS.queue.pending,
                value: String(queuePendingNonActive),
              },
              { label: UI_LABELS.queue.active, value: String(queueActive) },
              {
                label: UI_LABELS.queue.completed,
                value: String(rollup15s?.completedJobs ?? 0),
              },
              {
                label: UI_LABELS.queue.failed,
                value: String(rollup15s?.failedJobs ?? 0),
              },
            ]);
          });

          grid.panel({ title: "Queue & Jobs - 1m" }, (panel) => {
            panel.keyValues([
              {
                label: UI_LABELS.queue.pending,
                value: String(queuePendingNonActive),
              },
              { label: UI_LABELS.queue.active, value: String(queueActive) },
              {
                label: UI_LABELS.queue.completed,
                value: String(rollup1m?.completedJobs ?? 0),
              },
              {
                label: UI_LABELS.queue.failed,
                value: String(rollup1m?.failedJobs ?? 0),
              },
            ]);
          });

          grid.panel({ title: "Queue & Jobs - 15m" }, (panel) => {
            panel.keyValues([
              {
                label: UI_LABELS.queue.pending,
                value: String(queuePendingNonActive),
              },
              { label: UI_LABELS.queue.active, value: String(queueActive) },
              {
                label: UI_LABELS.queue.completed,
                value: String(rollup15m?.completedJobs ?? 0),
              },
              {
                label: UI_LABELS.queue.failed,
                value: String(rollup15m?.failedJobs ?? 0),
              },
            ]);
          });

          grid.panel({ title: "Queue & Jobs - 60m" }, (panel) => {
            panel.keyValues([
              {
                label: UI_LABELS.queue.pending,
                value: String(queuePendingNonActive),
              },
              { label: UI_LABELS.queue.active, value: String(queueActive) },
              {
                label: UI_LABELS.queue.completed,
                value: String(rollup60m?.completedJobs ?? 0),
              },
              {
                label: UI_LABELS.queue.failed,
                value: String(rollup60m?.failedJobs ?? 0),
              },
            ]);
          });

          grid.panel({ title: "Queue & Jobs - 24h" }, (panel) => {
            panel.keyValues([
              {
                label: UI_LABELS.queue.pending,
                value: String(queuePendingNonActive),
              },
              { label: UI_LABELS.queue.active, value: String(queueActive) },
              {
                label: UI_LABELS.queue.completed,
                value: String(rollup24h?.completedJobs ?? 0),
              },
              {
                label: UI_LABELS.queue.failed,
                value: String(rollup24h?.failedJobs ?? 0),
              },
            ]);
          });

          grid.panel({ title: "Queue Size Gauge", colSpan: 3 }, (panel) => {
            panel.gauge({
              value: backlogFillRatio,
              label: `backlog_live ${backlog}`,
            });
          });

          grid.panel(
            {
              title: `Queue Trend 60m (0-${queue60mSectionMax.toFixed(1)})`,
              colSpan: 3,
            },
            (panel) => {
              panel.graph({
                values: queue60mSeries.length > 0 ? queue60mSeries : [0],
                min: 0,
                max: queue60mSectionMax,
                axis: false,
                color:
                  state.metricReferenceErrors.length > 0
                    ? theme.danger
                    : theme.warning,
              });
            },
          );

          grid.panel(
            {
              title: `Queue Trend 24h (0-${queue24hSectionMax.toFixed(1)})`,
              colSpan: 3,
            },
            (panel) => {
              panel.graph({
                values: queue24hSeries.length > 0 ? queue24hSeries : [0],
                min: 0,
                max: queue24hSectionMax,
                axis: false,
                color:
                  state.metricReferenceErrors.length > 0
                    ? theme.danger
                    : theme.info,
              });
            },
          );
        },
      );
    }

    if (state.activeScreen === "infra") {
      const aggregate = state.redisIoAggregate;
      const instances = state.redisIoInstances;
      const metricSystem = snapshot.metricSystem;
      const metricRole = metricSystem?.role || "unknown";
      const metricOwnerRole = metricSystem?.ownerRole || "unknown";
      const metricSelfRole = metricSystem?.selfRole || "unknown";
      const metricOwnerInstance = metricSystem?.ownerInstanceId
        ? shortInstance(metricSystem.ownerInstanceId)
        : "n/a";
      const topInfluences = instances.slice(0, 10);
      const influenceMeterMax = Math.max(
        1,
        aggregate.redisIngressKbps,
        aggregate.redisEgressKbps,
        ...topInfluences.map((instance) => instance.redisIngressKbps),
        ...topInfluences.map((instance) => instance.redisEgressKbps),
      );
      const redisTrendPointLimit = clamp(
        trendPointLimitForWindow(state.trendWindowMs),
        60,
        INFRA_REDIS_DISPLAY_POINT_MAX,
      );
      const redisTotalSeries = rollingSeriesForChart({
        values:
          state.historyRedisAggregateKbps.length > 0
            ? state.historyRedisAggregateKbps
            : [aggregate.redisWireKbps],
        targetPoints: redisTrendPointLimit,
        maxPoints: INFRA_REDIS_DISPLAY_POINT_MAX,
        fallbackValue: aggregate.redisWireKbps,
      });
      const redisRxSeries = rollingSeriesForChart({
        values:
          state.historyRedisAggregateRxKbps.length > 0
            ? state.historyRedisAggregateRxKbps
            : [aggregate.redisIngressKbps],
        targetPoints: redisTrendPointLimit,
        maxPoints: INFRA_REDIS_DISPLAY_POINT_MAX,
        fallbackValue: aggregate.redisIngressKbps,
      });
      const redisTxSeries = rollingSeriesForChart({
        values:
          state.historyRedisAggregateTxKbps.length > 0
            ? state.historyRedisAggregateTxKbps
            : [aggregate.redisEgressKbps],
        targetPoints: redisTrendPointLimit,
        maxPoints: INFRA_REDIS_DISPLAY_POINT_MAX,
        fallbackValue: aggregate.redisEgressKbps,
      });
      const redisTrendMax = Math.max(
        chartMaxFromSeries({
          seriesList: [redisTotalSeries, redisRxSeries, redisTxSeries],
          percentile: 0.98,
          minMax: 1,
        }),
        Number(aggregate.redisWireKbps || 0),
        Number(aggregate.redisIngressKbps || 0),
        Number(aggregate.redisEgressKbps || 0),
      );
      const workersTrendPointLimit = trendPointLimitForWindow(5 * 60 * 1000);
      const workersTrend =
        state.historyWorkersRunning.length > 0
          ? tail(state.historyWorkersRunning, workersTrendPointLimit)
          : [Math.max(0, telemetry.liveWorkersRunning)];
      const workersTrendMax = Math.max(1, ...workersTrend);
      const wireSamples = [
        ...topInfluences.map((instance) =>
          formatBitrateFromKbps(instance.redisWireKbps),
        ),
        "-",
      ];
      const rxSamples = [
        ...topInfluences.map((instance) =>
          formatBitrateFromKbps(instance.redisIngressKbps),
        ),
        formatBitrateFromKbps(aggregate.redisIngressKbps),
      ];
      const txSamples = [
        ...topInfluences.map((instance) =>
          formatBitrateFromKbps(instance.redisEgressKbps),
        ),
        formatBitrateFromKbps(aggregate.redisEgressKbps),
      ];
      const readsSamples = [
        ...topInfluences.map((instance) => String(instance.redisIngressReads)),
        String(aggregate.redisIngressReads),
      ];
      const writesSamples = [
        ...topInfluences.map((instance) => String(instance.redisEgressWrites)),
        String(aggregate.redisEgressWrites),
      ];
      const wireColWidth = Math.max(
        ...wireSamples.map((value) => value.length),
      );
      const rxColWidth = Math.max(...rxSamples.map((value) => value.length));
      const txColWidth = Math.max(...txSamples.map((value) => value.length));
      const readsColWidth = Math.max(
        ...readsSamples.map((value) => value.length),
      );
      const writesColWidth = Math.max(
        ...writesSamples.map((value) => value.length),
      );

      const influenceRows: Array<{ label: string; value: string }> = [];
      for (const instance of topInfluences) {
        const wireValue = formatBitrateFromKbps(instance.redisWireKbps);
        const rxValue = formatBitrateFromKbps(instance.redisIngressKbps);
        const txValue = formatBitrateFromKbps(instance.redisEgressKbps);
        const readsValue = String(instance.redisIngressReads);
        const writesValue = String(instance.redisEgressWrites);
        influenceRows.push({
          label: `pid_${instance.pid}_${shortInstance(instance.instanceId)}`,
          value:
            `wire ${wireValue.padStart(wireColWidth)}  ` +
            `rx ${rxValue.padStart(rxColWidth)}  ` +
            `tx ${txValue.padStart(txColWidth)}  ` +
            `r ${readsValue.padStart(readsColWidth)}  ` +
            `w ${writesValue.padStart(writesColWidth)}`,
        });
      }

      if (influenceRows.length === 0) {
        influenceRows.push({
          label: "influences",
          value: "no active instance stats published yet",
        });
      }

      influenceRows.push({
        label: "totals",
        value:
          `wire ${"-".padStart(wireColWidth)}  ` +
          `rx ${formatBitrateFromKbps(aggregate.redisIngressKbps).padStart(rxColWidth)}  ` +
          `tx ${formatBitrateFromKbps(aggregate.redisEgressKbps).padStart(txColWidth)}  ` +
          `r ${String(aggregate.redisIngressReads).padStart(readsColWidth)}  ` +
          `w ${String(aggregate.redisEgressWrites).padStart(writesColWidth)}`,
      });

      const influenceMeterItems = topInfluences.flatMap((instance, index) => {
        const meterSuffix = `${index + 1}_${shortInstance(instance.instanceId)}`;
        return [
          {
            label: `rx_${meterSuffix}`,
            value: instance.redisIngressKbps,
            max: influenceMeterMax,
            color: theme.info,
            text: formatBitrateFromKbps(instance.redisIngressKbps),
          },
          {
            label: `tx_${meterSuffix}`,
            value: instance.redisEgressKbps,
            max: influenceMeterMax,
            color: theme.warning,
            text: formatBitrateFromKbps(instance.redisEgressKbps),
          },
        ];
      });

      ui.grid(
        { columns: ["1fr", "1fr"], rows: [11, 10, 12], gap: 1 },
        (grid) => {
          grid.panel({ title: "Workers & Runner" }, (panel) => {
            panel.keyValues([
              {
                label: "machines",
                value: `${snapshot.machines?.length ?? 0} (${machineStateSummary(snapshot.machines)}) / workers ${telemetry.liveWorkersRunning}`,
              },
              {
                label: "workers_running",
                value: String(telemetry.liveWorkersRunning),
              },
              {
                label: "infra_updated",
                value: snapshot.infra?.updatedAt || "-",
              },
              {
                label: "runner_mode",
                value: status?.mode || "none",
              },
              {
                label: "desired_mode",
                value: status?.desiredMode || settings?.desiredMode || "n/a",
              },
              {
                label: "gate_live",
                value: telemetry.liveGate,
              },
              {
                label: "gate_snapshot",
                value: telemetry.snapshotGateLabel,
              },
              {
                label: "redis_rx",
                value: formatBitrateFromKbps(state.redisIo.redisIngressKbps),
              },
              {
                label: "redis_window_s",
                value: String(state.redisIo.windowSeconds),
              },
              {
                label: "status_age_s",
                value:
                  runnerStatusAgeSeconds === null
                    ? "n/a"
                    : String(runnerStatusAgeSeconds),
              },
              {
                label: "metric_role",
                value: metricRole,
              },
              {
                label: "metric_roles",
                value: `${metricSelfRole}->${metricOwnerRole}`,
              },
              {
                label: "metric_owner",
                value: metricOwnerInstance,
              },
            ]);
          });

          grid.panel({ title: "Workers Running Trend (5m)" }, (panel) => {
            panel.graph({
              values: workersTrend,
              min: 0,
              max: workersTrendMax,
              axis: false,
              color: theme.info,
            });
            panel.statusBar({
              items: [{ label: "■ workers_running", color: theme.info }],
              right: [
                { label: `live ${telemetry.liveWorkersRunning}` },
                { label: `y:0-${workersTrendMax.toFixed(1)}` },
              ],
              keyStyle: "plain",
            });
          });

          grid.panel({ title: "Infra: Redis Aggregate" }, (panel) => {
            panel.keyValues([
              { label: "sampled_at", value: aggregate.sampledAt },
              {
                label: "active_instances",
                value: String(aggregate.activeInstances),
              },
              {
                label: "wire",
                value: formatBitrateFromKbps(aggregate.redisWireKbps),
              },
              {
                label: "rx",
                value: formatBitrateFromKbps(aggregate.redisIngressKbps),
              },
              {
                label: "tx",
                value: formatBitrateFromKbps(aggregate.redisEgressKbps),
              },
              {
                label: "rx_latency",
                value: `${aggregate.rxLatencyMs}ms`,
              },
              {
                label: "tx_latency",
                value: `${aggregate.txLatencyMs}ms`,
              },
              {
                label: "rx_bytes",
                value: String(aggregate.redisIngressBytes),
              },
              {
                label: "tx_bytes",
                value: String(aggregate.redisEgressBytes),
              },
              {
                label: "reads",
                value: String(aggregate.redisIngressReads),
              },
              {
                label: "writes",
                value: String(aggregate.redisEgressWrites),
              },
            ]);
          });

          grid.panel({ title: "Infra: Influence Breakdown" }, (panel) => {
            panel.keyValues(influenceRows);
          });

          grid.panel(
            {
              title: `Infra: Redis Wire Trend (Kbps 0-${redisTrendMax.toFixed(1)})`,
            },
            (panel) => {
              panel.multiGraph(
                [
                  {
                    values: redisTxSeries,
                    color: theme.warning,
                    label: "tx",
                  },
                  {
                    values: redisTotalSeries,
                    color: theme.success,
                    label: "total",
                  },
                  {
                    values: redisRxSeries,
                    color: theme.info,
                    label: "rx",
                  },
                ],
                {
                  min: 0,
                  max: redisTrendMax,
                  axis: false,
                  legend: false,
                },
              );
              panel.statusBar({
                items: [
                  { label: "■ total", color: theme.success },
                  { label: "■ rx", color: theme.info },
                  { label: "■ tx", color: theme.warning },
                ],
                right: [{ label: `y:0-${redisTrendMax.toFixed(1)}` }],
                keyStyle: "plain",
              });
            },
          );

          grid.panel({ title: "Infra: Redis Live Meters" }, (panel) => {
            panel.meters(
              [
                ...influenceMeterItems,
                {
                  label: "rx_total",
                  value: aggregate.redisIngressKbps,
                  max: influenceMeterMax,
                  color: theme.info,
                  text: formatBitrateFromKbps(aggregate.redisIngressKbps),
                },
                {
                  label: "tx_total",
                  value: aggregate.redisEgressKbps,
                  max: influenceMeterMax,
                  color: theme.warning,
                  text: formatBitrateFromKbps(aggregate.redisEgressKbps),
                },
              ],
              {
                style: "segmented",
              },
            );
          });
        },
      );
    }

    if (state.activeScreen === "observability") {
      const formatMetricValue = (
        key: string,
        value: unknown,
        input?: { preserveSign?: boolean },
      ): string => {
        if (value === null || value === undefined) {
          return "n/a";
        }
        if (typeof value === "string") {
          return value;
        }
        if (typeof value !== "number" || !Number.isFinite(value)) {
          return String(value);
        }

        if (
          key === "ips" ||
          key === "ipm" ||
          key === "secPerImage" ||
          key.endsWith("Pct")
        ) {
          return formatRate(value, 2);
        }

        const next = input?.preserveSign ? value : Math.max(0, value);
        return String(Math.round(next));
      };

      const formatTrackedValue = (value: unknown): string => {
        if (value === undefined || value === null) {
          return "n/a";
        }
        if (typeof value === "boolean") {
          return value ? "true" : "false";
        }
        return String(value);
      };

      const toSnakeReferenceName = (name: string): string => {
        const snake = String(name)
          .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
          .replace(/[^a-zA-Z0-9]+/g, "_")
          .toLowerCase();
        return snake;
      };

      const invalidMetricRefs: string[] = [];

      const readSnapshotMetricStrict = (metricName: string): number | null => {
        const metricId = `snapshot.${metricName}`;
        const metricRefError = validateSnapshotMetricId(metricId);
        if (metricRefError) {
          invalidMetricRefs.push(metricRefError);
          return null;
        }
        return state.snapshotTrendLatestByName[metricName] ?? null;
      };

      const readRunnerMetricStrict = (metricName: string): number | null => {
        const metricId = `runner.${metricName}`;
        const metricRefError = validateRunnerMetricId(metricId);
        if (metricRefError) {
          invalidMetricRefs.push(metricRefError);
          return null;
        }
        return state.runnerTrendLatestByName[metricName] ?? null;
      };

      const snapshotMetricRows = OPS_SNAPSHOT_TREND_METRIC_REGISTRY.map(
        (metric) => {
          const latestValue = readSnapshotMetricStrict(metric.name);
          return {
            label: toSnakeReferenceName(metric.name),
            value: formatMetricValue(metric.name, latestValue),
          };
        },
      );

      const runnerMetricRows = OPS_TREND_METRIC_REGISTRY.map((metric) => {
        const latestValue = readRunnerMetricStrict(metric.name);
        return {
          label: toSnakeReferenceName(metric.name),
          value: formatMetricValue(metric.name, latestValue, {
            preserveSign: true,
          }),
        };
      });
      const liveMetricRows = [...snapshotMetricRows, ...runnerMetricRows];

      const rollup15m = snapshot.performanceRollups?.rollup15m;
      const rollup60m = snapshot.performanceRollups?.rollup60m;
      const rollup24h = snapshot.performanceRollups?.rollup24h;

      const resolvedIps = rollup15m?.ips ?? null;
      const resolvedIpm = rollup15m?.ipm ?? null;
      const resolvedAvgFetchMs = rollup15m?.avgFetchMs ?? null;
      const resolvedAvgTransformMs = rollup15m?.avgTransformMs ?? null;
      const resolvedAvgUploadMs = rollup15m?.avgUploadMs ?? null;
      const resolvedAvgEndToEndMs = rollup15m?.avgEndToEndMs ?? null;
      const resolvedProcessedItems = rollup15m?.processedItems ?? null;
      const resolvedFailedItems = rollup15m?.failedItems ?? null;
      const resolvedCompletedJobs = rollup60m?.completedJobs ?? null;
      const resolvedFailedJobs = rollup60m?.failedJobs ?? null;

      const queueBacklogMetricRefError = validateSnapshotMetricId(
        "snapshot.queueBacklogLive",
      );
      if (queueBacklogMetricRefError) {
        invalidMetricRefs.push(queueBacklogMetricRefError);
      }
      const queueBacklogTrendRows = queueBacklogMetricRefError
        ? []
        : (snapshot.trendRowsByMetric?.queueBacklogLive ?? []);

      const trackedRows: Array<{ label: string; value: string }> = [
        { label: "ui_clock", value: formatTrackedValue(state.uiClockAt) },
        { label: "snapshot_at", value: formatTrackedValue(snapshot.at) },
        {
          label: "trend_rows_last_at",
          value: formatTrackedValue(snapshot.trendRowsLastAtMs),
        },
        {
          label: "trend_queue_rows",
          value: formatTrackedValue(queueBacklogTrendRows.length),
        },
        { label: "ips_live", value: formatMetricValue("ips", resolvedIps) },
        { label: "ipm_live", value: formatMetricValue("ipm", resolvedIpm) },
        {
          label: "avg_end_to_end_ms_live",
          value: formatMetricValue("avgEndToEndMs", resolvedAvgEndToEndMs),
        },
        {
          label: "module_role",
          value: snapshot.metricSystem?.role || "unknown",
        },
        {
          label: "queue_flow",
          value:
            state.queueGloballyPaused === null
              ? "unknown"
              : state.queueGloballyPaused
                ? "paused"
                : "running",
        },
        {
          label: "errors_total",
          value: String(Object.keys(snapshot.errors).length),
        },
        {
          label: "invalid_metric_refs",
          value:
            invalidMetricRefs.length > 0
              ? invalidMetricRefs.join(" | ")
              : "none",
        },
        { label: "error_fly", value: formatTrackedValue(snapshot.errors.fly) },
        {
          label: "error_queue",
          value: formatTrackedValue(snapshot.errors.queue),
        },
        { label: "error_db", value: formatTrackedValue(snapshot.errors.db) },
        {
          label: "error_control",
          value: formatTrackedValue(snapshot.errors.control),
        },
      ];

      const settingsRows: Array<{ label: string; value: string }> = [
        {
          label: "settings_desired_mode",
          value: formatTrackedValue(snapshot.settings?.desiredMode),
        },
        {
          label: "settings_enqueue_enabled",
          value: formatTrackedValue(snapshot.settings?.enqueueEnabled),
        },
        {
          label: "settings_require_workers_for_enqueue",
          value: formatTrackedValue(
            snapshot.settings?.requireWorkersForEnqueue,
          ),
        },
        {
          label: "settings_min_workers_to_enqueue",
          value: formatTrackedValue(snapshot.settings?.minWorkersToEnqueue),
        },
        {
          label: "settings_max_queue_backlog",
          value: formatTrackedValue(snapshot.settings?.maxQueueBacklog),
        },
        {
          label: "settings_refill_low_watermark",
          value: formatTrackedValue(snapshot.settings?.refillLowWatermark),
        },
        {
          label: "settings_refill_target_backlog",
          value: formatTrackedValue(snapshot.settings?.refillTargetBacklog),
        },
        {
          label: "settings_max_claim_per_cycle",
          value: formatTrackedValue(snapshot.settings?.maxClaimPerCycle),
        },
        {
          label: "settings_flush_interval_ms",
          value: formatTrackedValue(snapshot.settings?.flushIntervalMs),
        },
        {
          label: "settings_harvest_enabled",
          value: formatTrackedValue(snapshot.settings?.harvestEnabled),
        },
      ];

      const statusRows: Array<{ label: string; value: string }> = [
        {
          label: "status_operation_id",
          value: formatTrackedValue(status?.operationId),
        },
        { label: "status_mode", value: formatTrackedValue(status?.mode) },
        {
          label: "status_desired_mode",
          value: formatTrackedValue(status?.desiredMode),
        },
        {
          label: "status_gate_reason",
          value: formatTrackedValue(status?.gateReason),
        },
        {
          label: "status_workers_running",
          value: formatTrackedValue(status?.workersRunning),
        },
        {
          label: "status_claimed_count",
          value: formatTrackedValue(status?.claimedCount),
        },
        {
          label: "status_queued_count",
          value: formatTrackedValue(status?.queuedCount),
        },
        {
          label: "status_completed_jobs",
          value: formatTrackedValue(status?.completedJobs),
        },
        {
          label: "status_failed_jobs",
          value: formatTrackedValue(status?.failedJobs),
        },
        {
          label: "status_processed_items",
          value: formatTrackedValue(status?.processedItems),
        },
        {
          label: "status_failed_items",
          value: formatTrackedValue(status?.failedItems),
        },
        {
          label: "status_queue_waiting",
          value: formatTrackedValue(status?.queueWaiting),
        },
        {
          label: "status_queue_active",
          value: formatTrackedValue(status?.queueActive),
        },
        {
          label: "status_queue_completed",
          value: formatTrackedValue(status?.queueCompleted),
        },
        {
          label: "status_queue_failed",
          value: formatTrackedValue(status?.queueFailed),
        },
        {
          label: "status_queue_delayed",
          value: formatTrackedValue(status?.queueDelayed),
        },
        {
          label: "status_queue_paused",
          value: formatTrackedValue(status?.queuePaused),
        },
        {
          label: "status_queue_backlog",
          value: formatTrackedValue(status?.queueBacklog),
        },
        {
          label: "status_last_flush_at",
          value: formatTrackedValue(status?.lastFlushAt),
        },
        {
          label: "status_flush_batch_count",
          value: formatTrackedValue(status?.flushBatchCount),
        },
        {
          label: "status_pending_success_buffer",
          value: formatTrackedValue(status?.pendingSuccessBuffer),
        },
        {
          label: "status_pending_error_buffer",
          value: formatTrackedValue(status?.pendingErrorBuffer),
        },
        {
          label: "status_throughput_images_per_minute",
          value: formatTrackedValue(status?.throughputImagesPerMinute),
        },
        {
          label: "status_avg_fetch_ms",
          value: formatTrackedValue(status?.avgFetchMs),
        },
        {
          label: "status_avg_transform_ms",
          value: formatTrackedValue(status?.avgTransformMs),
        },
        {
          label: "status_avg_upload_ms",
          value: formatTrackedValue(status?.avgUploadMs),
        },
        {
          label: "status_avg_end_to_end_ms",
          value: formatTrackedValue(status?.avgEndToEndMs),
        },
        {
          label: "status_updated_at",
          value: formatTrackedValue(status?.updatedAt),
        },
      ];

      const infraRows: Array<{ label: string; value: string }> = [
        {
          label: "infra_workers_running",
          value: formatTrackedValue(snapshot.infra?.workersRunning),
        },
        {
          label: "infra_source",
          value: formatTrackedValue(snapshot.infra?.source),
        },
        {
          label: "infra_updated_at",
          value: formatTrackedValue(snapshot.infra?.updatedAt),
        },
      ];

      const queueRows: Array<{ label: string; value: string }> = [
        {
          label: "queue_waiting",
          value: formatTrackedValue(snapshot.queue?.waiting),
        },
        {
          label: "queue_active",
          value: formatTrackedValue(snapshot.queue?.active),
        },
        {
          label: "queue_completed",
          value: formatTrackedValue(snapshot.queue?.completed),
        },
        {
          label: "queue_failed",
          value: formatTrackedValue(snapshot.queue?.failed),
        },
        {
          label: "queue_delayed",
          value: formatTrackedValue(snapshot.queue?.delayed),
        },
        {
          label: "queue_paused",
          value: formatTrackedValue(snapshot.queue?.paused),
        },
        {
          label: "queue_backlog",
          value: formatTrackedValue(snapshot.queue?.backlog),
        },
      ];

      const dbRows: Array<{ label: string; value: string }> = [
        {
          label: "db_processed",
          value: formatTrackedValue(snapshot.db?.processed),
        },
        {
          label: "db_pending",
          value: formatTrackedValue(snapshot.db?.pending),
        },
        { label: "db_failed", value: formatTrackedValue(snapshot.db?.failed) },
        { label: "db_total", value: formatTrackedValue(snapshot.db?.total) },
        { label: "db_pct", value: formatTrackedValue(snapshot.db?.pct) },
      ];

      const metricSystemRows: Array<{ label: string; value: string }> = [
        {
          label: "metric_system_role",
          value: formatTrackedValue(snapshot.metricSystem?.role),
        },
        {
          label: "metric_system_self_role",
          value: formatTrackedValue(snapshot.metricSystem?.selfRole),
        },
        {
          label: "metric_system_owner_role",
          value: formatTrackedValue(snapshot.metricSystem?.ownerRole),
        },
        {
          label: "metric_system_self_instance_id",
          value: formatTrackedValue(snapshot.metricSystem?.selfInstanceId),
        },
        {
          label: "metric_system_owner_instance_id",
          value: formatTrackedValue(snapshot.metricSystem?.ownerInstanceId),
        },
        {
          label: "metric_system_active_instances",
          value: formatTrackedValue(snapshot.metricSystem?.activeInstances),
        },
      ];

      const redisRows: Array<{ label: string; value: string }> = [
        {
          label: "redis_aggregate_active_instances",
          value: formatTrackedValue(state.redisIoAggregate.activeInstances),
        },
        {
          label: "redis_aggregate_egress_bytes",
          value: formatTrackedValue(state.redisIoAggregate.redisEgressBytes),
        },
        {
          label: "redis_aggregate_ingress_bytes",
          value: formatTrackedValue(state.redisIoAggregate.redisIngressBytes),
        },
        {
          label: "redis_aggregate_ingress_reads",
          value: formatTrackedValue(state.redisIoAggregate.redisIngressReads),
        },
        {
          label: "redis_aggregate_egress_writes",
          value: formatTrackedValue(state.redisIoAggregate.redisEgressWrites),
        },
        {
          label: "redis_aggregate_egress_kbps",
          value: formatTrackedValue(state.redisIoAggregate.redisEgressKbps),
        },
        {
          label: "redis_aggregate_ingress_kbps",
          value: formatTrackedValue(state.redisIoAggregate.redisIngressKbps),
        },
        {
          label: "redis_aggregate_wire_kbps",
          value: formatTrackedValue(state.redisIoAggregate.redisWireKbps),
        },
        {
          label: "redis_aggregate_rx_latency_ms",
          value: formatTrackedValue(state.redisIoAggregate.rxLatencyMs),
        },
        {
          label: "redis_aggregate_tx_latency_ms",
          value: formatTrackedValue(state.redisIoAggregate.txLatencyMs),
        },
        {
          label: "redis_local_egress_bytes",
          value: formatTrackedValue(state.redisIo.redisEgressBytes),
        },
        {
          label: "redis_local_ingress_bytes",
          value: formatTrackedValue(state.redisIo.redisIngressBytes),
        },
        {
          label: "redis_local_wire_bytes",
          value: formatTrackedValue(state.redisIo.redisWireBytes),
        },
        {
          label: "redis_local_ingress_reads",
          value: formatTrackedValue(state.redisIo.redisIngressReads),
        },
        {
          label: "redis_local_egress_writes",
          value: formatTrackedValue(state.redisIo.redisEgressWrites),
        },
        {
          label: "redis_local_window_seconds",
          value: formatTrackedValue(state.redisIo.windowSeconds),
        },
        {
          label: "redis_local_egress_kbps",
          value: formatTrackedValue(state.redisIo.redisEgressKbps),
        },
        {
          label: "redis_local_ingress_kbps",
          value: formatTrackedValue(state.redisIo.redisIngressKbps),
        },
        {
          label: "redis_local_wire_kbps",
          value: formatTrackedValue(state.redisIo.redisWireKbps),
        },
        {
          label: "redis_local_ingress_kb_per_read",
          value: formatTrackedValue(state.redisIo.redisIngressKbPerRead),
        },
        {
          label: "redis_local_rx_latency_ms",
          value: formatTrackedValue(state.redisIo.rxLatencyMs),
        },
        {
          label: "redis_local_tx_latency_ms",
          value: formatTrackedValue(state.redisIo.txLatencyMs),
        },
        {
          label: "redis_local_last_read_at",
          value: formatTrackedValue(state.redisIo.lastReadAt),
        },
        {
          label: "redis_local_last_write_at",
          value: formatTrackedValue(state.redisIo.lastWriteAt),
        },
      ];

      const redisInstanceRows: Array<{ label: string; value: string }> = [];
      for (let index = 0; index < state.redisIoInstances.length; index += 1) {
        const instance = state.redisIoInstances[index];
        const prefix = `redis_instance_${index + 1}`;
        redisInstanceRows.push(
          {
            label: `${prefix}_instance_id`,
            value: formatTrackedValue(instance.instanceId),
          },
          { label: `${prefix}_pid`, value: formatTrackedValue(instance.pid) },
          {
            label: `${prefix}_started_at`,
            value: formatTrackedValue(instance.startedAt),
          },
          {
            label: `${prefix}_updated_at`,
            value: formatTrackedValue(instance.updatedAt),
          },
          {
            label: `${prefix}_window_seconds`,
            value: formatTrackedValue(instance.windowSeconds),
          },
          {
            label: `${prefix}_egress_bytes`,
            value: formatTrackedValue(instance.redisEgressBytes),
          },
          {
            label: `${prefix}_ingress_bytes`,
            value: formatTrackedValue(instance.redisIngressBytes),
          },
          {
            label: `${prefix}_ingress_reads`,
            value: formatTrackedValue(instance.redisIngressReads),
          },
          {
            label: `${prefix}_egress_writes`,
            value: formatTrackedValue(instance.redisEgressWrites),
          },
          {
            label: `${prefix}_egress_kbps`,
            value: formatTrackedValue(instance.redisEgressKbps),
          },
          {
            label: `${prefix}_ingress_kbps`,
            value: formatTrackedValue(instance.redisIngressKbps),
          },
          {
            label: `${prefix}_wire_kbps`,
            value: formatTrackedValue(instance.redisWireKbps),
          },
          {
            label: `${prefix}_rx_latency_ms`,
            value: formatTrackedValue(instance.rxLatencyMs),
          },
          {
            label: `${prefix}_tx_latency_ms`,
            value: formatTrackedValue(instance.txLatencyMs),
          },
        );
      }

      const collectorRows: Array<{ label: string; value: string }> = [
        {
          label: "collector_db_samples",
          value: formatTrackedValue(state.collectorBootSamples.db),
        },
        {
          label: "collector_fly_samples",
          value: formatTrackedValue(state.collectorBootSamples.fly),
        },
        {
          label: "collector_redis_samples",
          value: formatTrackedValue(state.collectorBootSamples.redis),
        },
        {
          label: "collector_bullmq_samples",
          value: formatTrackedValue(state.collectorBootSamples.bullmq),
        },
      ];

      const groupOrder = [
        "images",
        "queue_jobs",
        "infra_redis",
        "database",
        "settings",
        "variables",
      ] as const;

      const groupTitles: Record<(typeof groupOrder)[number], string> = {
        images: "Images",
        queue_jobs: "Queue & Jobs",
        infra_redis: "Infra & Redis",
        database: "Database",
        settings: "Settings",
        variables: "Variables",
      };

      const groupedRows: Record<
        (typeof groupOrder)[number],
        Array<{ label: string; value: string }>
      > = {
        images: [],
        queue_jobs: [],
        infra_redis: [],
        database: [],
        settings: [],
        variables: [],
      };

      const pushGroupRows = (
        group: (typeof groupOrder)[number],
        rows: Array<{ label: string; value: string }>,
      ): void => {
        groupedRows[group].push(...rows);
      };

      const classifyMetricGroup = (
        label: string,
      ): (typeof groupOrder)[number] => {
        if (
          label.includes("fetch") ||
          label.includes("transform") ||
          label.includes("upload") ||
          label.includes("end_to_end") ||
          label.includes("processed") ||
          label.includes("failed_items") ||
          label.includes("throughput") ||
          label.includes("ips") ||
          label.includes("ipm")
        ) {
          return "images";
        }
        if (
          label.includes("queue") ||
          label.includes("job") ||
          label.includes("backlog") ||
          label.includes("flush") ||
          label.includes("pending_")
        ) {
          return "queue_jobs";
        }
        if (label.includes("db")) {
          return "database";
        }
        if (
          label.includes("redis") ||
          label.includes("worker") ||
          label.includes("machine") ||
          label.includes("infra") ||
          label.includes("latency")
        ) {
          return "infra_redis";
        }
        return "variables";
      };

      pushGroupRows("variables", trackedRows);
      pushGroupRows("settings", settingsRows);
      pushGroupRows("variables", statusRows);
      pushGroupRows("infra_redis", infraRows);
      pushGroupRows("queue_jobs", queueRows);
      pushGroupRows("database", dbRows);
      pushGroupRows("infra_redis", metricSystemRows);
      pushGroupRows("infra_redis", redisRows);
      pushGroupRows("infra_redis", redisInstanceRows);
      pushGroupRows("infra_redis", collectorRows);
      for (const row of liveMetricRows) {
        pushGroupRows(classifyMetricGroup(row.label), [row]);
      }

      for (const group of groupOrder) {
        groupedRows[group].sort((left, right) =>
          left.label.localeCompare(right.label),
        );
      }

      const pinnedRows: Record<
        (typeof groupOrder)[number],
        Array<{ label: string; value: string }>
      > = {
        images: [
          { label: "ips", value: formatMetricValue("ips", resolvedIps) },
          { label: "ipm", value: formatMetricValue("ipm", resolvedIpm) },
          {
            label: "avg_fetch_ms",
            value: formatTrackedValue(resolvedAvgFetchMs),
          },
          {
            label: "avg_transform_ms",
            value: formatTrackedValue(resolvedAvgTransformMs),
          },
          {
            label: "avg_upload_ms",
            value: formatTrackedValue(resolvedAvgUploadMs),
          },
          {
            label: "avg_end_to_end_ms",
            value: formatTrackedValue(resolvedAvgEndToEndMs),
          },
          {
            label: "processed_items",
            value: formatTrackedValue(resolvedProcessedItems),
          },
          {
            label: "failed_items",
            value: formatTrackedValue(resolvedFailedItems),
          },
        ],
        queue_jobs: [
          {
            label: "completed_jobs",
            value: formatTrackedValue(resolvedCompletedJobs),
          },
          {
            label: "failed_jobs",
            value: formatTrackedValue(resolvedFailedJobs),
          },
          {
            label: "completed_jobs_24h",
            value: formatTrackedValue(rollup24h?.completedJobs ?? 0),
          },
          {
            label: "failed_jobs_24h",
            value: formatTrackedValue(rollup24h?.failedJobs ?? 0),
          },
        ],
        infra_redis: [
          {
            label: "redis_wire",
            value: formatBitrateFromKbps(state.redisIoAggregate.redisWireKbps),
          },
          {
            label: "redis_rx",
            value: formatBitrateFromKbps(
              state.redisIoAggregate.redisIngressKbps,
            ),
          },
          {
            label: "redis_tx",
            value: formatBitrateFromKbps(
              state.redisIoAggregate.redisEgressKbps,
            ),
          },
          {
            label: "redis_reads",
            value: formatTrackedValue(state.redisIoAggregate.redisIngressReads),
          },
          {
            label: "redis_writes",
            value: formatTrackedValue(state.redisIoAggregate.redisEgressWrites),
          },
          {
            label: "redis_rx_latency_ms",
            value: formatTrackedValue(state.redisIoAggregate.rxLatencyMs),
          },
          {
            label: "redis_tx_latency_ms",
            value: formatTrackedValue(state.redisIoAggregate.txLatencyMs),
          },
          {
            label: "redis_active_instances",
            value: formatTrackedValue(state.redisIoAggregate.activeInstances),
          },
          {
            label: "redis_sampled_at",
            value: formatTrackedValue(state.redisIoAggregate.sampledAt),
          },
        ],
        database: [],
        settings: [],
        variables: [],
      };

      const groupedRowsForDisplay: Record<
        (typeof groupOrder)[number],
        Array<{ label: string; value: string }>
      > = {
        images: [],
        queue_jobs: [],
        infra_redis: [],
        database: [],
        settings: [],
        variables: [],
      };

      for (const group of groupOrder) {
        const seen = new Set<string>();
        const displayRows: Array<{ label: string; value: string }> = [];

        for (const row of pinnedRows[group]) {
          if (seen.has(row.label)) {
            continue;
          }
          seen.add(row.label);
          displayRows.push(row);
        }

        for (const row of groupedRows[group]) {
          if (seen.has(row.label)) {
            continue;
          }
          seen.add(row.label);
          displayRows.push(row);
        }

        groupedRowsForDisplay[group] = displayRows;
      }

      const catalogSummaryRows: Array<{ label: string; value: string }> = [
        {
          label: "catalog_total",
          value: String(
            groupOrder.reduce(
              (sum, group) => sum + groupedRowsForDisplay[group].length,
              0,
            ),
          ),
        },
        { label: "catalog_live_metrics", value: String(liveMetricRows.length) },
        {
          label: "catalog_images",
          value: String(groupedRowsForDisplay.images.length),
        },
        {
          label: "catalog_queue_jobs",
          value: String(groupedRowsForDisplay.queue_jobs.length),
        },
        {
          label: "catalog_infra_redis",
          value: String(groupedRowsForDisplay.infra_redis.length),
        },
        {
          label: "catalog_database",
          value: String(groupedRowsForDisplay.database.length),
        },
        {
          label: "catalog_settings",
          value: String(groupedRowsForDisplay.settings.length),
        },
        {
          label: "catalog_variables",
          value: String(groupedRowsForDisplay.variables.length),
        },
      ];

      ui.grid(
        { columns: ["1fr", "1fr"], rows: [10, 10, 10], gap: 1 },
        (grid) => {
          grid.panel({ title: groupTitles.images }, (panel) => {
            panel.keyValues(groupedRowsForDisplay.images);
          });
          grid.panel({ title: groupTitles.queue_jobs }, (panel) => {
            panel.keyValues(groupedRowsForDisplay.queue_jobs);
          });
          grid.panel({ title: groupTitles.infra_redis }, (panel) => {
            panel.keyValues(groupedRowsForDisplay.infra_redis);
          });
          grid.panel({ title: groupTitles.database }, (panel) => {
            panel.keyValues(groupedRowsForDisplay.database);
          });
          grid.panel({ title: groupTitles.settings }, (panel) => {
            panel.keyValues(groupedRowsForDisplay.settings);
          });
          grid.panel({ title: groupTitles.variables }, (panel) => {
            panel.keyValues([
              ...groupedRowsForDisplay.variables,
              ...catalogSummaryRows,
            ]);
          });
        },
      );
    }

    if (state.showCommandPalette) {
      const items = commandMenuItems(
        state.commandMenu,
        state.queueGloballyPaused,
      );
      const selected = clamp(
        state.commandSelected,
        0,
        Math.max(0, items.length - 1),
      );
      const visibleCount = 7;
      const start = clamp(
        selected - Math.floor(visibleCount / 2),
        0,
        Math.max(0, items.length - visibleCount),
      );
      const visibleItems = items.slice(start, start + visibleCount);

      ui.modal(
        {
          width: 86,
          height: 14,
          title:
            state.commandMenu === "base"
              ? "Command Menu"
              : state.commandMenu === "mode"
                ? "Mode"
                : "Advanced Settings",
          onDismiss: () => {
            state.showCommandPalette = false;
            state.commandQuery = textState();
            state.notice = "command cancelled";
            app.invalidate();
          },
          onKey: (event) => {
            const key = event.key || event.name || "";

            if (key === "escape") {
              state.showCommandPalette = false;
              state.commandQuery = textState();
              state.notice = "command cancelled";
              app.invalidate();
              return;
            }

            if (key === "down" || key === "j") {
              if (items.length > 0) {
                state.commandSelected = Math.min(
                  items.length - 1,
                  state.commandSelected + 1,
                );
                app.invalidate();
              }
              return;
            }

            if (key === "up" || key === "k") {
              if (items.length > 0) {
                state.commandSelected = Math.max(0, state.commandSelected - 1);
                app.invalidate();
              }
              return;
            }

            if (key >= "1" && key <= "9") {
              const index = Number.parseInt(key, 10) - 1;
              if (index >= 0 && index < items.length) {
                state.commandSelected = index;
                app.invalidate();
                void applyMenuSelection(items[index]);
              }
              return;
            }

            if (key === "enter") {
              if (items.length === 0) {
                state.notice = "no matching commands";
                app.invalidate();
                return;
              }
              const selectedIndex = clamp(
                state.commandSelected,
                0,
                items.length - 1,
              );
              void applyMenuSelection(items[selectedIndex]);
              return;
            }
          },
        },
        (modal) => {
          modal.label("Pick a command: Up/Down (or j/k), Enter, 1-9, Esc.");
          if (items.length === 0) {
            modal.text("No matching commands");
            return;
          }
          for (let i = 0; i < visibleItems.length; i += 1) {
            const absoluteIndex = start + i;
            const item = visibleItems[i];
            const marker = absoluteIndex === selected ? ">" : " ";
            const hotkey = absoluteIndex + 1;
            const disabledSuffix = item.disabled ? " [disabled]" : "";
            const line = `${marker} ${hotkey}. ${item.label}${disabledSuffix}${item.hint ? ` - ${item.hint}` : ""}`;
            if (absoluteIndex === selected) {
              modal.text([
                {
                  text: line,
                  fg: theme.selectionText,
                  bg: theme.selection,
                  bold: true,
                },
              ]);
            } else {
              modal.text(line);
            }
          }
        },
      );
    }

    if (state.showValuePrompt) {
      ui.modal(
        {
          width: 72,
          height: 8,
          title: state.valuePromptTitle,
          onDismiss: () => {
            state.showValuePrompt = false;
            state.valuePromptAction = null;
            state.valuePromptInput = textState();
            state.notice = "command cancelled";
            app.invalidate();
          },
          onKey: (event) => {
            if (event.key === "escape") {
              state.showValuePrompt = false;
              state.valuePromptAction = null;
              state.valuePromptInput = textState();
              state.notice = "command cancelled";
              app.invalidate();
              return;
            }

            if (event.key === "enter") {
              void executeValuePrompt();
              return;
            }

            const next = editText(state.valuePromptInput, event);
            if (next) {
              state.valuePromptInput = next;
              app.invalidate();
            }
          },
        },
        (modal) => {
          modal.label(state.valuePromptHint || "Enter value");
          modal.textInput({
            value: state.valuePromptInput.value,
            cursor: state.valuePromptInput.cursor,
            focused: true,
          });
          modal.text("Enter=apply  Esc=cancel");
        },
      );
    }

    if (state.showClearConfirm) {
      ui.modal(
        {
          width: 68,
          height: 9,
          title: "Confirm Clear Queue",
          onDismiss: () => {
            if (state.clearInFlight) {
              return;
            }
            state.showClearConfirm = false;
            state.notice = "clear-queue cancelled";
            app.invalidate();
          },
          onKey: (event) => {
            if (state.clearInFlight) {
              return;
            }

            if (event.key === "escape") {
              state.showClearConfirm = false;
              state.notice = "clear-queue cancelled";
              app.invalidate();
              return;
            }

            if (event.key === "enter") {
              state.showClearConfirm = false;
              void executeClearQueue();
            }
          },
          buttons: [
            {
              label: "Cancel",
              onPress: () => {
                if (state.clearInFlight) {
                  return;
                }
                state.showClearConfirm = false;
                state.notice = "clear-queue cancelled";
                app.invalidate();
              },
            },
            {
              label: state.clearInFlight ? "Clearing..." : "Clear Queue",
              onPress: () => {
                if (state.clearInFlight) {
                  return;
                }
                state.showClearConfirm = false;
                void executeClearQueue();
              },
            },
          ],
        },
        (modal) => {
          modal.text(
            "This will remove pending jobs from waiting/delayed/paused queue states.",
          );
          modal.text("Queue must already be paused.");
          modal.text("Press Enter or click Clear Queue to confirm.");
        },
      );
    }

    if (state.showHelp) {
      ui.modal(
        {
          title: "Help / Commands",
          onDismiss: () => {
            state.showHelp = false;
            app.invalidate();
          },
          buttons: [
            {
              label: "Close",
              onPress: () => {
                state.showHelp = false;
                app.invalidate();
              },
            },
          ],
        },
        (modal) => {
          modal.text(
            "Keys: q quit, h toggle help, r refresh, +/- poll speed, tab next screen",
          );
          modal.text(
            "Keys: 1 summary, 2 infra, 3 processing, 4 queue & jobs, 5 observability",
          );
          modal.text(
            "Use : command menu for pause/resume/clear queue, flush interval, harvest toggle, and chart timing",
          );
          modal.text("Hotkeys: p pause/resume flow, f set flush interval");
          modal.text(
            "Command flow: pick action first, then enter value only when prompted",
          );
          modal.text("Advanced queue policy is under : -> Advanced settings");
          if (snapshot.errors.fly) {
            modal.text(`fly error: ${snapshot.errors.fly}`);
          }
          if (snapshot.errors.queue) {
            modal.text(`queue error: ${snapshot.errors.queue}`);
          }
          if (snapshot.errors.control) {
            modal.text(`control error: ${snapshot.errors.control}`);
          }
          if (snapshot.errors.db) {
            modal.text(`db error: ${snapshot.errors.db}`);
          }
        },
      );
    }

    ui.statusBar({
      items: [
        { key: "q", label: "Quit" },
        { key: "h", label: "Help" },
        { key: "r", label: "Refresh" },
        { key: "p", label: "Pause/Resume" },
        { key: "f", label: "Set Flush" },
        { key: "1..5", label: "Screens" },
        { key: ":", label: "Command" },
      ],
      right: [
        { key: "Tab", label: "Next Screen" },
        { key: "Queue", label: `${backlog}` },
        {
          key: "Flush",
          label:
            state.snapshot.settings?.flushIntervalMs !== null &&
            state.snapshot.settings?.flushIntervalMs !== undefined
              ? `${state.snapshot.settings.flushIntervalMs}ms`
              : "n/a",
        },
      ],
    });
  });

  app.invalidate();
  void refresh();

  void (async () => {
    let needsRefresh = true;
    while (state.running) {
      if (needsRefresh) {
        await refresh();
        needsRefresh = false;
      }
      if (!state.running) {
        break;
      }
      // Strict fixed-interval polling from module snapshot state.
      await sleepMs(state.intervalMs);
      needsRefresh = true;
    }
  })();

  await app.start();
  clearInterval(uiClockTimer);

  process.off("SIGINT", onSigint);

  await uiStateWatcher.close();

  if (explicitQuitRequested) {
    process.exit(0);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`image ops hqtui failed: ${message}\n`);
  process.exit(1);
});
