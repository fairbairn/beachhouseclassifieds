import "@/core/tooling/env/load-env-profile";
import { createApp, type TextEditState } from "@profullstack/hqtui";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

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
  readOpsMetricSliceValue,
  readOpsQueuePausedState,
  readOpsRedisIoStats,
  readOpsRedisPreflight,
  readOpsRedisServerIoStats,
  resetOpsRedisIoStats,
  resolveOpsTrendWindowSeries,
  resumeOpsSystemFlow,
  runOpsCollectorsAndIngestSamples,
  runOpsOneShotPipeline,
  scaleOpsWorkers,
  setOpsDesiredModeWithQueueAction,
  updateOpsControlSettings,
  type OpsMetricSliceCache,
  type OpsMetricSliceId,
  type OpsMetricSliceValueType,
  type OpsMetricSystemSnapshot,
  type OpsRedisIoAggregateStats,
  type OpsRedisIoInstanceStats,
  type OpsRedisIoStats,
  type OpsRedisServerIoStats,
  type OpsSampleCollectorKey,
  type OpsTrendProjection,
  type OpsUiSnapshot,
} from "../workers/image-ops-control-module";
import { selectDisplaySeries } from "../workers/image-ops-graph-series";
import {
  createOpsMetricState,
  ingestTrendRows,
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
import type {
  RunnerControlSettings,
  RunnerInfraSnapshot,
  RunnerStatusSnapshot,
} from "../workers/image-runner-control";

const DEFAULT_APP = "beachhouseclassifieds-image-worker";
type ChartTimingMode = "interpolated" | "ordinal";
const DEFAULT_TREND_WINDOW_MINUTES = 5;
const LONG_TREND_WINDOW_MINUTES = 15;
const LONG_IPS_DISPLAY_WIDTH_FACTOR = 3;
const LONG_IPS_DISPLAY_POINT_MAX = 720;
const TREND_GRAPH_BUCKET_MS = 5000;
const QUEUE_24H_DISPLAY_POINT_MAX = 720;
const QUEUE_TREND_DISPLAY_POINT_MAX = 240;
const INFRA_REDIS_DISPLAY_POINT_MAX = 240;
const METRIC_HISTORY_MAX_POINTS = 30_000;
const STARTUP_REDIS_PREFLIGHT_TIMEOUT_MS = 8_000;
const STARTUP_REDIS_PREFLIGHT_MAX_ATTEMPTS = 3;
const STARTUP_REDIS_PREFLIGHT_RETRY_DELAY_MS = 600;
const STARTUP_PIPELINE_TIMEOUT_MS = 10_000;
const STARTUP_SNAPSHOT_TIMEOUT_MS = 10_000;
const UI_LABELS = OPS_UI_METRIC_LABELS;
const HQTUI_RUNTIME_LOG_PATH = resolve(
  process.cwd(),
  ".tmp/logs/image-ops-hqtui-runtime.log",
);

function writeHqtuiRuntimeLog(event: string, details?: unknown): void {
  try {
    mkdirSync(dirname(HQTUI_RUNTIME_LOG_PATH), { recursive: true });
    const payload = {
      at: new Date().toISOString(),
      pid: process.pid,
      event,
      details: details ?? null,
    };
    appendFileSync(HQTUI_RUNTIME_LOG_PATH, `${JSON.stringify(payload)}\n`, {
      encoding: "utf8",
    });
  } catch {
    // Best-effort logging only.
  }
}

function serializeUnknownError(error: unknown): {
  message: string;
  stack?: string;
  raw?: string;
} {
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack,
    };
  }

  try {
    return {
      message: String(error),
      raw: JSON.stringify(error),
    };
  } catch {
    return {
      message: String(error),
    };
  }
}

type DashboardSnapshot = {
  at: OpsUiSnapshot["at"];
  machines: OpsUiSnapshot["machines"];
  queue: OpsUiSnapshot["queue"];
  recentJobs15m: OpsUiSnapshot["recentJobs15m"];
  recentJobs24h: OpsUiSnapshot["recentJobs24h"];
  performanceRollups: OpsUiSnapshot["performanceRollups"];
  metricSlices: OpsMetricSliceCache | undefined;
  queueWindowAverages: OpsUiSnapshot["queueWindowAverages"];
  queuePaused: OpsUiSnapshot["queuePaused"];
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
  snapshotTrendLatestAtMsByName: Record<string, number>;
  runnerTrendLatestByName: Record<string, number | null>;
  runnerTrendLatestAtMsByName: Record<string, number>;
  collectorBootLatencyMs: Partial<Record<OpsSampleCollectorKey, number>>;
  collectorBootSamples: Partial<Record<OpsSampleCollectorKey, number>>;
  metricReferenceErrors: string[];
  lockedYAxisMaxByChart: Record<string, number>;
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

type MenuItem = {
  id: string;
  label: string;
  hint?: string;
  disabled?: boolean;
};

function textState(value = ""): TextEditState {
  return {
    value,
    cursor: value.length,
  } as TextEditState;
}

function editText(
  state: TextEditState,
  event: { key?: string; name?: string; sequence?: string },
): TextEditState | null {
  const key = String(event.key || event.name || "");
  const rawValue = String(state.value ?? "");
  const rawCursor = Number.isFinite(Number(state.cursor))
    ? Number(state.cursor)
    : rawValue.length;
  const cursor = clamp(rawCursor, 0, rawValue.length);

  if (key === "left") {
    return { ...state, cursor: clamp(cursor - 1, 0, rawValue.length) };
  }
  if (key === "right") {
    return { ...state, cursor: clamp(cursor + 1, 0, rawValue.length) };
  }
  if (key === "home") {
    return { ...state, cursor: 0 };
  }
  if (key === "end") {
    return { ...state, cursor: rawValue.length };
  }
  if (key === "backspace") {
    if (cursor <= 0) {
      return null;
    }
    const next = `${rawValue.slice(0, cursor - 1)}${rawValue.slice(cursor)}`;
    return { ...state, value: next, cursor: cursor - 1 };
  }
  if (key === "delete") {
    if (cursor >= rawValue.length) {
      return null;
    }
    const next = `${rawValue.slice(0, cursor)}${rawValue.slice(cursor + 1)}`;
    return { ...state, value: next, cursor };
  }

  if (key.length === 1 && key >= " ") {
    const next = `${rawValue.slice(0, cursor)}${key}${rawValue.slice(cursor)}`;
    return { ...state, value: next, cursor: cursor + 1 };
  }

  return null;
}

function commandMenuItems(
  menu: "base" | "mode" | "advanced",
  queueGloballyPaused: boolean | null,
): MenuItem[] {
  if (menu === "mode") {
    return [
      { id: "mode:run", label: "Mode: run", hint: "normal operation" },
      { id: "mode:idle", label: "Mode: idle", hint: "pause new work" },
      { id: "mode:drain", label: "Mode: drain", hint: "finish active jobs" },
      { id: "mode:stop", label: "Mode: stop", hint: "stop workers" },
      { id: "back", label: "Back", hint: "return to main menu" },
    ];
  }

  if (menu === "advanced") {
    return [
      {
        id: "prompt:max-backlog",
        label: "Set max queue backlog",
        hint: "queue cap",
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
    },
    {
      id: "action:resume-system",
      label: "Resume system flow",
      hint: isPaused ? "resume queue + enable enqueue" : "already running",
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

function chartRangeForSeries(
  values: number[],
  input?: {
    forceZeroMin?: boolean;
    padRatio?: number;
    minPad?: number;
    minSpan?: number;
  },
): { min: number; max: number } {
  const source = values.filter((value) => Number.isFinite(value));
  if (source.length <= 0) {
    return { min: 0, max: 1 };
  }

  const low = Math.min(...source);
  const high = Math.max(...source);
  if (!Number.isFinite(low) || !Number.isFinite(high)) {
    return { min: 0, max: 1 };
  }

  const padRatio = Number.isFinite(input?.padRatio)
    ? Number(input?.padRatio)
    : 0.08;
  const minPad = Number.isFinite(input?.minPad) ? Number(input?.minPad) : 1;
  const minSpan = Number.isFinite(input?.minSpan) ? Number(input?.minSpan) : 5;

  const span = Math.max(0, high - low);
  const pad = Math.max(minPad, span * padRatio);

  let rangeMin = low - pad;
  const rangeMax = Math.max(1, high);

  if ((input?.forceZeroMin ?? false) || low <= 0) {
    rangeMin = 0;
  }

  if (rangeMax - rangeMin < minSpan) {
    rangeMin = Math.max(0, rangeMax - minSpan);
  }

  return {
    min: Math.max(0, rangeMin),
    max: rangeMax,
  };
}

function lockYAxisMaxFromSeries(input: {
  state: State;
  chartId: string;
  plottedValues: number[];
  minMax?: number;
}): number {
  const minMax = Math.max(1, input.minMax ?? 1);
  const values = input.plottedValues.filter((value) => Number.isFinite(value));
  const nextMax = Math.max(minMax, seriesMax(values));
  const previousMax = input.state.lockedYAxisMaxByChart[input.chartId];

  if (!Number.isFinite(previousMax) || previousMax <= 0) {
    input.state.lockedYAxisMaxByChart[input.chartId] = nextMax;
    return nextMax;
  }

  if (nextMax >= previousMax) {
    input.state.lockedYAxisMaxByChart[input.chartId] = nextMax;
    return nextMax;
  }

  const epsilon = Math.max(0.0001, previousMax * 0.001);
  const previousHighStillVisible = values.some(
    (value) => value >= previousMax - epsilon,
  );
  if (previousHighStillVisible) {
    return previousMax;
  }

  input.state.lockedYAxisMaxByChart[input.chartId] = nextMax;
  return nextMax;
}

function latestSeriesValue(values: number[]): number | null {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const candidate = values[index];
    if (Number.isFinite(candidate)) {
      return Number(candidate);
    }
  }
  return null;
}

function formatChartLegendHeader(input: {
  label: string;
  low: number;
  high: number;
  values: number[];
  digits?: number;
}): { title: string; subtitle: string } {
  const digits = Math.max(0, input.digits ?? 1);
  const safeLow = Number.isFinite(input.low) ? Math.max(0, input.low) : 0;
  const safeHigh = Number.isFinite(input.high) ? Math.max(0, input.high) : 0;
  const latest = latestSeriesValue(input.values);
  const latestLabel =
    latest === null ? "n/a" : Number(latest).toFixed(Math.max(1, digits));
  return {
    title: `${input.label} (${safeLow.toFixed(digits)}-${safeHigh.toFixed(digits)})`,
    subtitle: `[${latestLabel}]`,
  };
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

function formatLocalClockAt(date = new Date()): string {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) {
    return "n/a";
  }
  if (seconds < 1) {
    return "<1s";
  }

  const totalSeconds = Math.floor(seconds);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;

  if (days > 0) {
    const remHours = Math.floor((totalSeconds % 86400) / 3600);
    return `${days}d ${remHours}h ${minutes}m`;
  }

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${secs}s`;
  }
  return `${secs}s`;
}

function tail(
  values: readonly number[] | null | undefined,
  count: number,
): number[] {
  const source = Array.isArray(values) ? values : [];
  if (source.length <= count) {
    return [...source];
  }
  return source.slice(source.length - count);
}

function normalizeTrendSeries(
  values: readonly number[] | null | undefined,
  count: number,
): number[] {
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

function buildWindowHistorySeries(input: {
  values: readonly number[] | null | undefined;
  windowMs: number;
  targetPoints: number;
  padMissingCoverage?: boolean;
  scale?: number;
  endAtMs?: number;
  stepMs?: number;
}): number[] {
  const expectedPoints = Math.max(1, trendPointLimitForWindow(input.windowMs));
  const trimmed = tail(input.values, expectedPoints);
  const base =
    input.padMissingCoverage === false
      ? trimmed
      : normalizeTrendSeries(trimmed, expectedPoints);
  const endAtMs = Number.isFinite(input.endAtMs)
    ? Number(input.endAtMs)
    : Date.now();
  const stepMs = Math.max(1, Math.floor(input.stepMs ?? TREND_GRAPH_BUCKET_MS));
  const startAtMs = endAtMs - (base.length - 1) * stepMs;
  const rows = base.map((value, index) => ({
    atMs: startAtMs + index * stepMs,
    value,
  }));
  const bucketed = buildStableWindowSeriesFromRows({
    rows,
    nowMs: endAtMs,
    windowMs: input.windowMs,
    targetPoints: input.targetPoints,
  });
  const scale = Number.isFinite(input.scale) ? Number(input.scale) : 1;
  if (scale === 1) {
    return bucketed;
  }
  return bucketed.map((value) => value * scale);
}

function buildStableWindowSeriesFromRows(input: {
  rows: Array<{ atMs: number; value: number }> | null | undefined;
  nowMs: number;
  windowMs: number;
  targetPoints: number;
}): number[] {
  const rows = Array.isArray(input.rows) ? input.rows : [];
  let anchorNowMs = Number.isFinite(input.nowMs)
    ? Number(input.nowMs)
    : Date.now();
  let latestRowAtMs = -1;
  for (const row of rows) {
    const atMs = Number(row.atMs);
    if (Number.isFinite(atMs) && atMs > latestRowAtMs) {
      latestRowAtMs = atMs;
    }
  }
  if (latestRowAtMs > 0) {
    anchorNowMs = latestRowAtMs;
  }
  return resolveOpsTrendWindowSeries({
    trendRowsByMetric: {
      __metric: rows,
    },
    metricName: "__metric",
    nowMs: anchorNowMs,
    windowMs: input.windowMs,
    targetPoints: input.targetPoints,
  });
}

function buildIpsSeriesFromProcessedEventRows(input: {
  rows: Array<{ atMs: number; value: number }> | null | undefined;
  nowMs: number;
  lookbackWindowMs: number;
  targetPoints: number;
  rateWindowMs?: number;
}): number[] {
  const sourceRows = Array.isArray(input.rows) ? input.rows : [];
  const rows = sourceRows
    .filter((row) => Number.isFinite(row.atMs) && Number.isFinite(row.value))
    .map((row) => ({
      atMs: Math.floor(Number(row.atMs)),
      value: Math.max(0, Number(row.value)),
    }))
    .sort((left, right) => left.atMs - right.atMs);

  const targetPoints = Math.max(2, Math.floor(input.targetPoints));
  const nowMs = Number.isFinite(input.nowMs) ? Number(input.nowMs) : Date.now();
  const lookbackWindowMs = Math.max(1000, Math.floor(input.lookbackWindowMs));
  const rateWindowMs = Math.max(1000, Math.floor(input.rateWindowMs ?? 15_000));
  const startAtMs = nowMs - lookbackWindowMs;
  const stepMs =
    targetPoints <= 1
      ? lookbackWindowMs
      : Math.max(1, Math.floor(lookbackWindowMs / (targetPoints - 1)));

  const anchors: number[] = [];
  for (let index = 0; index < targetPoints; index += 1) {
    anchors.push(startAtMs + index * stepMs);
  }

  const output: number[] = [];
  let includeIndex = 0;
  let excludeIndex = 0;
  let rollingSum = 0;

  for (const anchorAtMs of anchors) {
    while (
      includeIndex < rows.length &&
      rows[includeIndex].atMs <= anchorAtMs
    ) {
      rollingSum += rows[includeIndex].value;
      includeIndex += 1;
    }

    const minAtMs = anchorAtMs - rateWindowMs;
    while (excludeIndex < includeIndex && rows[excludeIndex].atMs < minAtMs) {
      rollingSum -= rows[excludeIndex].value;
      excludeIndex += 1;
    }

    const ips = rollingSum / Math.max(1, rateWindowMs / 1000);
    output.push(Number.isFinite(ips) ? Math.max(0, ips) : 0);
  }

  return output;
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

function nextScreen(current: State["activeScreen"]): State["activeScreen"] {
  const order: State["activeScreen"][] = [
    "summary",
    "infra",
    "processing",
    "queuejobs",
    "observability",
  ];
  const currentIndex = order.indexOf(current);
  if (currentIndex < 0) {
    return "summary";
  }
  return order[(currentIndex + 1) % order.length];
}

function previousScreen(current: State["activeScreen"]): State["activeScreen"] {
  const order: State["activeScreen"][] = [
    "summary",
    "infra",
    "processing",
    "queuejobs",
    "observability",
  ];
  const currentIndex = order.indexOf(current);
  if (currentIndex < 0) {
    return "summary";
  }
  return order[(currentIndex - 1 + order.length) % order.length];
}

function shortInstance(instanceId: string | null | undefined): string {
  const value = String(instanceId || "").trim();
  if (!value) {
    return "n/a";
  }
  if (value.length <= 12) {
    return value;
  }
  return `${value.slice(0, 8)}..${value.slice(-4)}`;
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
  writeHqtuiRuntimeLog("main_start", {
    argv: process.argv.slice(2),
    cwd: process.cwd(),
  });

  const onUncaughtException = (error: unknown): void => {
    writeHqtuiRuntimeLog("uncaught_exception", serializeUnknownError(error));
  };
  const onUnhandledRejection = (reason: unknown): void => {
    writeHqtuiRuntimeLog("unhandled_rejection", serializeUnknownError(reason));
  };
  process.on("uncaughtException", onUncaughtException);
  process.on("unhandledRejection", onUnhandledRejection);

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
    writeTrendSamples: false,
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
      reconcileBullmqStatus: false,
      writeTrendSamples: false,
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
      writeTrendSamples: false,
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
    enableCollectors: true,
    ingestDerivedSamplesOnRefresh: true,
    pollEventDrivenCollectorsOnInterval: true,
    collectors: ["db", "fly", "redis", "bullmq"],
    skipInitialRefresh: true,
    hydrateOnInit: false,
    waitForQueueEventsReadyOnInit: true,
    seedCollectorsOnInit: true,
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
      metricSlices: startupPipeline.snapshot.metricSlices,
      queueWindowAverages: startupPipeline.snapshot.queueWindowAverages,
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
    lockedYAxisMaxByChart: {},
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
    writeHqtuiRuntimeLog("app_exit", {
      explicitQuitRequested,
      running: state.running,
    });
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
  const uiClockTimer = setInterval(
    () => {
      if (!state.running) {
        return;
      }
      state.uiClockAt = formatLocalClockAt();
      app.invalidate();
    },
    Math.max(1000, state.intervalMs),
  );

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
      const bullmqPausedNow = await readOpsQueuePausedState().catch(() => null);
      const merged: DashboardSnapshot = {
        ...snapshot,
        machines: snapshot.machines ?? previous.machines,
        queue: snapshot.queue ?? previous.queue,
        recentJobs15m: snapshot.recentJobs15m ?? previous.recentJobs15m,
        recentJobs24h: snapshot.recentJobs24h ?? previous.recentJobs24h,
        performanceRollups:
          snapshot.performanceRollups ?? previous.performanceRollups,
        metricSlices: snapshot.metricSlices ?? previous.metricSlices,
        queueWindowAverages:
          snapshot.queueWindowAverages ?? previous.queueWindowAverages,
        queuePaused: bullmqPausedNow,
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
      const statusIpsSample =
        merged.status?.throughputImagesPerMinute !== undefined &&
        merged.status?.throughputImagesPerMinute !== null
          ? Number(merged.status.throughputImagesPerMinute) / 60
          : null;
      const rollupIpsSample =
        readOpsMetricSliceValue({
          snapshot: merged,
          metricName: "statusThroughputImagesPerMinute",
          sliceId: "w15s",
          valueType: "avg",
        }) / 60;
      const projectionIpsSample =
        merged.projections.sampleCount > 0
          ? Number(merged.projections.headline.ipsSmoothedNow || 0)
          : 0;
      const preferredIpsSample = Math.max(
        0,
        Number.isFinite(statusIpsSample ?? NaN)
          ? Number(statusIpsSample)
          : Number.isFinite(rollupIpsSample)
            ? rollupIpsSample
            : projectionIpsSample,
      );

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
        const processedDelta = Math.max(
          0,
          currentProcessed - state.lastDbProcessed,
        );
        const ipsFromDelta = processedDelta / elapsedSeconds;
        const ipsNow = Math.max(
          0,
          Number.isFinite(ipsFromDelta) ? ipsFromDelta : 0,
        );
        const backlogDeltaNow =
          (currentBacklog - state.lastBacklog) / elapsedSeconds;
        pushHistory(state.historyIps, Number(ipsNow.toFixed(3)), historyMax);
        pushHistory(
          state.historyBacklogDeltaPerSec,
          Number(backlogDeltaNow.toFixed(3)),
          historyMax,
        );
      } else {
        pushHistory(
          state.historyIps,
          Number(preferredIpsSample.toFixed(3)),
          historyMax,
        );
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
      state.queueGloballyPaused = bullmqPausedNow;

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
      try {
        const pausedNow = await readOpsQueuePausedState().catch(() => null);
        if (pausedNow === true) {
          state.queueGloballyPaused = true;
          state.notice = "system already paused";
          app.invalidate();
          return;
        }
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
      try {
        const pausedNow = await readOpsQueuePausedState().catch(() => null);
        if (pausedNow === false) {
          state.queueGloballyPaused = false;
          state.notice = "system already running";
          app.invalidate();
          return;
        }
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
      state.lockedYAxisMaxByChart = {};
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

    if (
      event.key === "backtab" ||
      event.key === "shift+tab" ||
      (event.key === "tab" && Boolean((event as { shift?: boolean }).shift))
    ) {
      state.activeScreen = previousScreen(state.activeScreen);
      state.notice = `screen=${state.activeScreen}`;
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
      void (async () => {
        const pausedNow = await readOpsQueuePausedState().catch(() => null);
        if (pausedNow === null) {
          state.notice = "pause/resume unavailable: queue pause state unknown";
          app.invalidate();
          return;
        }
        state.queueGloballyPaused = pausedNow;
        const command = pausedNow ? "resume-system" : "pause-system";
        state.notice =
          command === "resume-system"
            ? "resuming system flow"
            : "pausing system flow";
        app.invalidate();
        await executePromptCommand(command);
      })();
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
    const sliceValue = (
      metricName: string,
      sliceId: OpsMetricSliceId,
      valueType: OpsMetricSliceValueType = "avg",
    ): number =>
      readOpsMetricSliceValue({
        snapshot,
        metricName,
        sliceId,
        valueType,
      });
    const readModuleMetricValue = (
      metricName: string,
      sliceId: OpsMetricSliceId = "w15s",
      valueType: OpsMetricSliceValueType = "latest",
    ): number => Math.max(0, sliceValue(metricName, sliceId, valueType));
    const readModuleMetricInt = (
      metricName: string,
      sliceId: OpsMetricSliceId = "w15s",
      valueType: OpsMetricSliceValueType = "latest",
    ): number =>
      Math.max(
        0,
        Math.round(readModuleMetricValue(metricName, sliceId, valueType)),
      );
    const sliceWindowSeconds = (sliceId: OpsMetricSliceId): number => {
      switch (sliceId) {
        case "w5s":
          return 5;
        case "w15s":
          return 15;
        case "w1m":
          return 60;
        case "w15m":
          return 15 * 60;
        case "w60m":
          return 60 * 60;
        case "w24h":
          return 24 * 60 * 60;
        case "wDeep":
          return 24 * 60 * 60;
      }
    };
    const throughputAverageForSlice = (
      sliceId: OpsMetricSliceId,
    ): {
      ips: number;
      ipm: number;
    } => {
      const processedSum = Math.max(
        0,
        sliceValue("statusProcessedItems", sliceId, "sum"),
      );
      const ips = processedSum / Math.max(1, sliceWindowSeconds(sliceId));
      const ipm = ips * 60;
      return {
        ips,
        ipm,
      };
    };
    const processedItemsForSlice = (sliceId: OpsMetricSliceId): number => {
      return Math.max(0, sliceValue("statusProcessedItems", sliceId, "sum"));
    };
    const completedJobsForSlice = (sliceId: OpsMetricSliceId): number => {
      return Math.max(0, sliceValue("statusCompletedJobs", sliceId, "sum"));
    };
    const failedItemsForSlice = (sliceId: OpsMetricSliceId): number => {
      const statusItemAvg = Math.max(
        0,
        sliceValue("statusFailedItems", sliceId, "sum"),
      );
      const statusJobAvg = Math.max(
        0,
        sliceValue("statusFailedJobs", sliceId, "sum"),
      );
      return Math.max(statusItemAvg, statusJobAvg);
    };
    const sliceWindowMs = (sliceId: OpsMetricSliceId): number =>
      Math.max(1000, sliceWindowSeconds(sliceId) * 1000);
    const snapshotAnchorMs = Number.isFinite(Date.parse(snapshot.at || ""))
      ? Date.parse(snapshot.at || "")
      : Date.now();
    const strictWindowRows = (
      metricName: string,
      sliceId: OpsMetricSliceId,
    ): Array<{ atMs: number; value: number }> => {
      const nowMsLocal = snapshotAnchorMs;
      const startMs = nowMsLocal - sliceWindowMs(sliceId);
      const rows = snapshot.trendRowsByMetric?.[metricName] ?? [];
      return rows
        .map((row) => ({ atMs: Number(row.atMs), value: Number(row.value) }))
        .filter(
          (row) =>
            Number.isFinite(row.atMs) &&
            Number.isFinite(row.value) &&
            row.atMs >= startMs &&
            row.atMs <= nowMsLocal,
        );
    };
    const latestSampleAgeSeconds = (metricName: string): number | null => {
      const rows = snapshot.trendRowsByMetric?.[metricName] ?? [];
      if (rows.length <= 0) {
        return null;
      }
      let latestAtMs = 0;
      for (const row of rows) {
        const atMs = Number(row.atMs);
        if (Number.isFinite(atMs) && atMs > latestAtMs) {
          latestAtMs = atMs;
        }
      }
      if (latestAtMs <= 0) {
        return null;
      }
      return Math.max(0, (Date.now() - latestAtMs) / 1000);
    };
    const buildSliceRollupView = (sliceId: OpsMetricSliceId) => {
      const throughput = throughputAverageForSlice(sliceId);
      const ipm = throughput.ipm;
      const ips = throughput.ips;
      const sampledAtMs =
        snapshot.metricSlices?.statusThroughputImagesPerMinute?.[sliceId]
          ?.sampledAtMs ?? null;
      return {
        ips,
        ipm,
        processedItems: processedItemsForSlice(sliceId),
        failedItems: failedItemsForSlice(sliceId),
        completedJobs: completedJobsForSlice(sliceId),
        failedJobs: Math.max(0, sliceValue("statusFailedJobs", sliceId, "sum")),
        avgFetchMs: Math.max(0, sliceValue("avgFetchMs", sliceId, "avg")),
        avgTransformMs: Math.max(
          0,
          sliceValue("avgTransformMs", sliceId, "avg"),
        ),
        avgUploadMs: Math.max(0, sliceValue("avgUploadMs", sliceId, "avg")),
        avgEndToEndMs: Math.max(0, sliceValue("avgEndToEndMs", sliceId, "avg")),
        metricJobElapsedMsAvg: Math.max(
          0,
          sliceValue("avgEndToEndMs", sliceId, "avg"),
        ),
        secPerImage: ips > 0 ? 1 / ips : null,
        sampledAt: Number.isFinite(sampledAtMs)
          ? new Date(Number(sampledAtMs)).toISOString()
          : null,
      };
    };
    const rollup15s = buildSliceRollupView("w15s");
    const trendPointLimit = trendPointLimitForWindow(state.trendWindowMs);
    const nowMs = state.lastSampleAtMs ?? Date.now();
    const queueBacklogRows = snapshot.trendRowsByMetric?.queueBacklogLive ?? [];
    const processedEventRows =
      snapshot.trendRowsByMetric?.statusProcessedItems ?? [];
    const queueTrendMetricSeries = buildStableWindowSeriesFromRows({
      rows: queueBacklogRows,
      nowMs,
      windowMs: state.trendWindowMs,
      targetPoints: trendPointLimit,
    });
    const queueHistoryTrend = buildWindowHistorySeries({
      values: state.historyBacklog,
      windowMs: state.trendWindowMs,
      targetPoints: trendPointLimit,
      padMissingCoverage: true,
      endAtMs: state.lastSampleAtMs ?? nowMs,
      stepMs: state.intervalMs,
    });
    const moduleBacklogTrend = selectDisplaySeries({
      primary: queueTrendMetricSeries,
      secondary: normalizeTrendSeries(
        projection.queueBacklogTrendSmoothed,
        trendPointLimit,
      ),
      fallback:
        queueHistoryTrend.length > 0
          ? queueHistoryTrend
          : [Math.max(0, Number(queue?.backlog ?? status?.queueBacklog ?? 0))],
      targetPoints: trendPointLimit,
      maxPoints: QUEUE_TREND_DISPLAY_POINT_MAX,
    });
    const longIpsDisplayLimit = clamp(
      trendPointLimit * LONG_IPS_DISPLAY_WIDTH_FACTOR,
      trendPointLimit,
      LONG_IPS_DISPLAY_POINT_MAX,
    );
    const ips5mMetricSeries = buildIpsSeriesFromProcessedEventRows({
      rows: processedEventRows,
      nowMs,
      lookbackWindowMs: state.trendWindowMs,
      targetPoints: trendPointLimit,
      rateWindowMs: 15_000,
    });
    const ips5mHistorySeries = buildWindowHistorySeries({
      values: state.historyIpsLong,
      windowMs: state.trendWindowMs,
      targetPoints: trendPointLimit,
      padMissingCoverage: true,
      endAtMs: state.lastSampleAtMs ?? nowMs,
      stepMs: state.intervalMs,
    });
    const ips15mMetricSeries = buildIpsSeriesFromProcessedEventRows({
      rows: processedEventRows,
      nowMs,
      lookbackWindowMs: LONG_TREND_WINDOW_MINUTES * 60 * 1000,
      targetPoints: longIpsDisplayLimit,
      rateWindowMs: 15_000,
    });
    const ips15mHistorySeries = buildWindowHistorySeries({
      values: state.historyIpsLong,
      windowMs: LONG_TREND_WINDOW_MINUTES * 60 * 1000,
      targetPoints: longIpsDisplayLimit,
      padMissingCoverage: true,
      endAtMs: state.lastSampleAtMs ?? nowMs,
      stepMs: state.intervalMs,
    });
    const moduleIpsTrend = selectDisplaySeries({
      primary: ips5mHistorySeries,
      secondary: ips5mMetricSeries,
      fallback: [
        Math.max(0, Number(status?.throughputImagesPerMinute || 0) / 60),
      ],
      targetPoints: trendPointLimit,
      maxPoints: LONG_IPS_DISPLAY_POINT_MAX,
    });
    const longIpsTrend = selectDisplaySeries({
      primary: ips15mHistorySeries,
      secondary: ips15mMetricSeries,
      fallback: moduleIpsTrend,
      targetPoints: longIpsDisplayLimit,
      maxPoints: LONG_IPS_DISPLAY_POINT_MAX,
    });
    const trendWindowMinutes = Math.max(
      1,
      Math.round(state.trendWindowMs / 60000),
    );
    const ipsTrendSharedMax = lockYAxisMaxFromSeries({
      state,
      chartId: "summary.ipsTrendShared",
      plottedValues: [...moduleIpsTrend, ...longIpsTrend],
      minMax: 1,
    });
    const queueTrendRange = chartRangeForSeries(moduleBacklogTrend, {
      forceZeroMin: false,
      minSpan: 5,
      minPad: 1,
      padRatio: 0.08,
    });
    const queueTrendMax = lockYAxisMaxFromSeries({
      state,
      chartId: "summary.queueTrend",
      plottedValues: moduleBacklogTrend,
      minMax: 1,
    });
    const liveIpsFrom15s = Math.max(0, throughputAverageForSlice("w15s").ips);
    const liveIpmFrom15s = Math.max(0, throughputAverageForSlice("w15s").ipm);
    const ipsNow = Math.max(0, liveIpsFrom15s);
    const processed5m = readModuleMetricInt(
      "statusProcessedItems",
      "w15s",
      "sum",
    );
    const failed5m = readModuleMetricInt("statusFailedItems", "w15s", "sum");
    const ips5m = Math.max(0, liveIpsFrom15s);
    const ipm5m = Math.max(0, liveIpmFrom15s);
    const completedJobs5m = readModuleMetricInt(
      "statusCompletedJobs",
      "w15s",
      "sum",
    );
    const failedJobs5m = readModuleMetricInt("statusFailedJobs", "w15s", "sum");
    const secPerImageNow = ipsNow > 0 ? 1 / ipsNow : null;
    const queuePendingLive = readModuleMetricInt(
      "queuePendingLive",
      "w15s",
      "latest",
    );
    const queueActive = readModuleMetricInt(
      "queueActiveLive",
      "w15s",
      "latest",
    );
    const queueInSystem = Math.max(0, queuePendingLive + queueActive);
    const backlog = Math.max(0, queuePendingLive);
    const etaQueueEmptySeconds =
      queueInSystem === 0 ? 0 : ipsNow > 0 ? queueInSystem / ipsNow : null;
    const dbPending = Math.max(0, Number(snapshot.db?.pending ?? 0));
    const etaDbCompleteSeconds =
      dbPending === 0 ? 0 : ipsNow > 0 ? dbPending / ipsNow : null;
    const maxBacklog = Math.max(1, settings?.maxQueueBacklog ?? 1);
    const backlogFillRatio = clamp(backlog / maxBacklog, 0, 1);
    const activeJobRatio = queueInSystem > 0 ? queueActive / queueInSystem : 0;
    const ipsLive = Math.max(0, liveIpsFrom15s);
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

    const imageProcessingFields = (input: {
      ips: number;
      ipm: number;
      processedItems?: number | null;
      completedItems?: number | null;
      failedItems?: number | null;
      avgFetchMs?: number | null;
      avgTransformMs?: number | null;
      avgUploadMs?: number | null;
      avgElapsedMs?: number | null;
    }) => {
      const processedItems = input.processedItems;
      const completedItems = input.completedItems;
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
          label: UI_LABELS.image.completed,
          value:
            completedItems === null ||
            completedItems === undefined ||
            !Number.isFinite(completedItems)
              ? "n/a"
              : String(Math.max(0, Math.round(completedItems))),
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

    const imageProcessingSliceFields = (sliceId: OpsMetricSliceId) => {
      const latestLatencyAgeSeconds = latestSampleAgeSeconds("avgEndToEndMs");
      const latestJobAgeSeconds = latestSampleAgeSeconds("statusCompletedJobs");
      const rollup = buildSliceRollupView(sliceId);
      const rollup15s = buildSliceRollupView("w15s");
      const liveWindowFallbackMaxAgeSeconds = 20;
      const canUseLiveFallback =
        sliceId === "w5s" &&
        rollup.ips <= 0 &&
        rollup.processedItems <= 0 &&
        rollup.completedJobs <= 0 &&
        rollup.failedItems <= 0 &&
        rollup15s.ips > 0 &&
        latestJobAgeSeconds !== null &&
        latestJobAgeSeconds <= liveWindowFallbackMaxAgeSeconds;
      const effectiveSliceId: OpsMetricSliceId = canUseLiveFallback
        ? "w15s"
        : sliceId;
      const effectiveRollup = canUseLiveFallback ? rollup15s : rollup;
      const latencySampleCount = strictWindowRows(
        "avgEndToEndMs",
        effectiveSliceId,
      ).length;
      const fields = imageProcessingFields({
        ips: effectiveRollup.ips,
        ipm: effectiveRollup.ipm,
        processedItems: Math.round(effectiveRollup.processedItems),
        completedItems: Math.round(effectiveRollup.completedJobs),
        failedItems: Math.round(effectiveRollup.failedItems),
        avgFetchMs:
          latencySampleCount > 0
            ? Math.max(0, effectiveRollup.avgFetchMs)
            : null,
        avgTransformMs:
          latencySampleCount > 0
            ? Math.max(0, effectiveRollup.avgTransformMs)
            : null,
        avgUploadMs:
          latencySampleCount > 0
            ? Math.max(0, effectiveRollup.avgUploadMs)
            : null,
        avgElapsedMs:
          latencySampleCount > 0
            ? Math.max(0, effectiveRollup.avgEndToEndMs)
            : null,
      });
      fields.push(
        {
          label: "latency_samples",
          value: String(Math.max(0, latencySampleCount)),
        },
        {
          label: "latency_last_age",
          value: formatDuration(latestLatencyAgeSeconds),
        },
        {
          label: "jobs_last_age",
          value: formatDuration(latestJobAgeSeconds),
        },
      );
      if (canUseLiveFallback) {
        fields.push({ label: "window_source", value: "w15s_fallback" });
      }
      return fields;
    };

    const queueJobsFields = (
      sliceId: OpsMetricSliceId,
      mode: "state" | "change" = "change",
    ) => {
      const pendingValueType: OpsMetricSliceValueType =
        mode === "state" ? "latest" : "delta";
      const activeValueType: OpsMetricSliceValueType =
        mode === "state" ? "latest" : "delta";
      return [
        {
          label: UI_LABELS.queue.pending,
          value: String(
            readModuleMetricInt("queuePendingLive", sliceId, pendingValueType),
          ),
        },
        {
          label: UI_LABELS.queue.active,
          value: String(
            readModuleMetricInt("queueActiveLive", sliceId, activeValueType),
          ),
        },
        {
          label: UI_LABELS.queue.completed,
          value: String(
            readModuleMetricInt("statusCompletedJobs", sliceId, "sum"),
          ),
        },
        {
          label: UI_LABELS.queue.failed,
          value: String(
            readModuleMetricInt("statusFailedJobs", sliceId, "sum"),
          ),
        },
      ];
    };

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
                value: formatRate(ips5m, 2),
              },
              {
                label: UI_LABELS.image.ipm,
                value: formatRate(ipm5m, 2),
              },
              {
                label: UI_LABELS.image.processed,
                value: String(processed5m),
              },
              {
                label: UI_LABELS.image.failed,
                value: String(failed5m),
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
                label: "eta_db_complete",
                value: formatDuration(etaDbCompleteSeconds),
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
              const dbCollectorUpdatedAtMs = Number(
                state.snapshotTrendLatestAtMsByName.dbProcessed || 0,
              );
              const dbCollectorUpdatedAt =
                dbCollectorUpdatedAtMs > 0
                  ? new Date(dbCollectorUpdatedAtMs).toISOString()
                  : "n/a";
              panel.keyValues([
                {
                  label: "processed",
                  value: String(snapshot.db?.processed ?? 0),
                },
                {
                  label: "pending",
                  value: String(dbPending),
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
                {
                  label: "eta_at_live_ips",
                  value: formatDuration(etaDbCompleteSeconds),
                },
                {
                  label: "collector_updated_at",
                  value: dbCollectorUpdatedAt,
                },
              ]);
            },
          );

          grid.panel(
            { title: "Image Processing (live 5s)", colSpan: 2 },
            (panel) => {
              panel.keyValues(imageProcessingSliceFields("w5s"));
            },
          );

          grid.panel(
            {
              ...formatChartLegendHeader({
                label: `IPS Trend (${trendWindowMinutes}m)`,
                low: 0,
                high: ipsTrendSharedMax,
                values: moduleIpsTrend.length > 0 ? moduleIpsTrend : [0],
              }),
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
                value: String(queuePendingLive),
              },
              { label: UI_LABELS.queue.active, value: String(queueActive) },
              {
                label: UI_LABELS.queue.completed,
                value: String(completedJobs5m),
              },
              {
                label: UI_LABELS.queue.failed,
                value: String(failedJobs5m),
              },
            ]);
            panel.gauge({
              value: activeJobRatio,
              label: `active jobs ${queueActive}`,
            });
          });

          grid.panel(
            {
              ...formatChartLegendHeader({
                label: `Queue Trend (${trendWindowMinutes}m)`,
                low: queueTrendRange.min,
                high: queueTrendMax,
                values: moduleBacklogTrend,
              }),
              colSpan: 2,
            },
            (panel) => {
              panel.graph({
                values: moduleBacklogTrend,
                min: queueTrendRange.min,
                max: queueTrendMax,
                axis: false,
                color: theme.warning,
              });
            },
          );

          grid.panel({ title: "Queue Size (live)", colSpan: 2 }, (panel) => {
            panel.gauge({
              value: backlogFillRatio,
              label: `pending_live ${backlog}`,
            });
          });

          grid.panel(
            { title: "Image Processing (15m)", colSpan: 2 },
            (panel) => {
              panel.keyValues(imageProcessingSliceFields("w15m"));
            },
          );

          grid.panel(
            {
              ...formatChartLegendHeader({
                label: `IPS Trend (${LONG_TREND_WINDOW_MINUTES}m)`,
                low: 0,
                high: ipsTrendSharedMax,
                values: longIpsTrend.length > 0 ? longIpsTrend : [0],
              }),
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
                items: [{ label: "■ ips", color: theme.success }],
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
      const ips60mDisplayPoints = trendPointLimitForWindow(60 * 60 * 1000);
      const ips24hDisplayPoints = clamp(
        trendPointLimitForWindow(24 * 60 * 60 * 1000),
        60,
        LONG_IPS_DISPLAY_POINT_MAX,
      );
      const ips60mSeries = selectDisplaySeries({
        primary: buildIpsSeriesFromProcessedEventRows({
          rows: processedEventRows,
          nowMs,
          lookbackWindowMs: 60 * 60 * 1000,
          targetPoints: ips60mDisplayPoints,
          rateWindowMs: 15_000,
        }),
        secondary:
          state.historyIps60m.length > 0
            ? buildWindowHistorySeries({
                values: state.historyIps60m,
                windowMs: 60 * 60 * 1000,
                targetPoints: ips60mDisplayPoints,
                padMissingCoverage: true,
              })
            : [],
        fallback: moduleIpsTrend,
        targetPoints: ips60mDisplayPoints,
        maxPoints: LONG_IPS_DISPLAY_POINT_MAX,
      });
      const ips24hSeries = selectDisplaySeries({
        primary: buildIpsSeriesFromProcessedEventRows({
          rows: processedEventRows,
          nowMs,
          lookbackWindowMs: 24 * 60 * 60 * 1000,
          targetPoints: ips24hDisplayPoints,
          rateWindowMs: 15_000,
        }),
        secondary:
          state.historyIps24h.length > 0
            ? buildWindowHistorySeries({
                values: state.historyIps24h,
                windowMs: 24 * 60 * 60 * 1000,
                targetPoints: ips24hDisplayPoints,
                padMissingCoverage: true,
              })
            : [],
        fallback: longIpsTrend,
        targetPoints: ips24hDisplayPoints,
        maxPoints: LONG_IPS_DISPLAY_POINT_MAX,
      });
      const ipsProcessingTrendMax = lockYAxisMaxFromSeries({
        state,
        chartId: "processing.ipsTrendShared",
        plottedValues: [...longIpsTrend, ...ips60mSeries, ...ips24hSeries],
        minMax: 1,
      });

      ui.grid(
        {
          columns: ["1fr", "1fr"],
          rows: [11],
          size: 11,
          gap: 1,
        },
        (grid) => {
          grid.panel({ title: "Image Processing - live" }, (panel) => {
            panel.keyValues(imageProcessingSliceFields("w5s"));
          });

          grid.panel({ title: "Live IPS Gauge" }, (panel) => {
            panel.gauge({
              value: ipsGaugeValue,
              label: `ips_live ${formatRate(ipsLive, 2)}`,
            });
          });
        },
      );

      ui.grid(
        {
          columns: Array.from({ length: 5 }, () => "1fr"),
          rows: [11],
          size: 11,
          gap: 1,
        },
        (grid) => {
          grid.panel({ title: "Image Processing - 15s" }, (panel) => {
            panel.keyValues(imageProcessingSliceFields("w15s"));
          });

          grid.panel({ title: "Image Processing - 1m" }, (panel) => {
            panel.keyValues(imageProcessingSliceFields("w1m"));
          });

          grid.panel({ title: "Image Processing - 15m" }, (panel) => {
            panel.keyValues(imageProcessingSliceFields("w15m"));
          });

          grid.panel({ title: "Image Processing - 60m" }, (panel) => {
            panel.keyValues(imageProcessingSliceFields("w60m"));
          });

          grid.panel({ title: "Image Processing - 24h" }, (panel) => {
            panel.keyValues(imageProcessingSliceFields("w24h"));
          });
        },
      );

      ui.grid(
        {
          columns: ["1fr", "1fr", "1fr"],
          rows: [10],
          size: 10,
          gap: 1,
        },
        (grid) => {
          grid.panel(
            {
              ...formatChartLegendHeader({
                label: "IPS Trend 15m",
                low: 0,
                high: ipsProcessingTrendMax,
                values: longIpsTrend.length > 0 ? longIpsTrend : [0],
              }),
            },
            (panel) => {
              panel.graph({
                values: longIpsTrend.length > 0 ? longIpsTrend : [0],
                min: 0,
                max: ipsProcessingTrendMax,
                axis: false,
                color: theme.success,
              });
            },
          );

          grid.panel(
            {
              ...formatChartLegendHeader({
                label: "IPS Trend 60m",
                low: 0,
                high: ipsProcessingTrendMax,
                values: ips60mSeries.length > 0 ? ips60mSeries : [0],
              }),
            },
            (panel) => {
              panel.graph({
                values: ips60mSeries.length > 0 ? ips60mSeries : [0],
                min: 0,
                max: ipsProcessingTrendMax,
                axis: false,
                color: theme.success,
              });
            },
          );

          grid.panel(
            {
              ...formatChartLegendHeader({
                label: "IPS Trend 24h",
                low: 0,
                high: ipsProcessingTrendMax,
                values: ips24hSeries.length > 0 ? ips24hSeries : [0],
              }),
            },
            (panel) => {
              panel.graph({
                values: ips24hSeries.length > 0 ? ips24hSeries : [0],
                min: 0,
                max: ipsProcessingTrendMax,
                axis: false,
                color: theme.info,
              });
            },
          );
        },
      );
    }

    if (state.activeScreen === "queuejobs") {
      const queuePendingLive5s = readModuleMetricInt(
        "queuePendingLive",
        "w5s",
        "latest",
      );
      const backlogFillRatio5s = clamp(queuePendingLive5s / maxBacklog, 0, 1);
      const queue15mLimit = trendPointLimitForWindow(15 * 60 * 1000);
      const queue60mLimit = trendPointLimitForWindow(60 * 60 * 1000);
      const queue24hLimit = clamp(
        trendPointLimitForWindow(24 * 60 * 60 * 1000),
        60,
        QUEUE_24H_DISPLAY_POINT_MAX,
      );
      const queueBacklogRows =
        state.snapshot.trendRowsByMetric?.queueBacklogLive ?? [];
      const queue15mMetricSeries = buildStableWindowSeriesFromRows({
        rows: queueBacklogRows,
        nowMs,
        windowMs: 15 * 60 * 1000,
        targetPoints: queue15mLimit,
      });
      const queue60mMetricSeries = buildStableWindowSeriesFromRows({
        rows: queueBacklogRows,
        nowMs,
        windowMs: 60 * 60 * 1000,
        targetPoints: queue60mLimit,
      });
      const queue24hMetricSeries = buildStableWindowSeriesFromRows({
        rows: queueBacklogRows,
        nowMs,
        windowMs: 24 * 60 * 60 * 1000,
        targetPoints: queue24hLimit,
      });

      const queue15mSeries = queue15mMetricSeries;
      const queue60mSeries = queue60mMetricSeries;
      const queue24hSeries = queue24hMetricSeries;
      const queueTrendSharedMax = lockYAxisMaxFromSeries({
        state,
        chartId: "queuejobs.backlogTrendShared",
        plottedValues: [
          ...queue15mSeries,
          ...queue60mSeries,
          ...queue24hSeries,
        ],
        minMax: 1,
      });

      ui.grid(
        {
          columns: ["1fr", "1fr"],
          rows: [8],
          size: 8,
          gap: 1,
        },
        (grid) => {
          grid.panel({ title: "Queue & Jobs - live (5s)" }, (panel) => {
            panel.keyValues(queueJobsFields("w5s", "state"));
          });

          grid.panel({ title: "Queue Size Gauge" }, (panel) => {
            panel.gauge({
              value: backlogFillRatio5s,
              label: `pending_live ${queuePendingLive5s}`,
            });
          });
        },
      );

      ui.grid(
        {
          columns: Array.from({ length: 5 }, () => "1fr"),
          rows: [8],
          size: 8,
          gap: 1,
        },
        (grid) => {
          grid.panel({ title: "Queue & Jobs - 15s" }, (panel) => {
            panel.keyValues(queueJobsFields("w15s"));
          });

          grid.panel({ title: "Queue & Jobs - 1m" }, (panel) => {
            panel.keyValues(queueJobsFields("w1m"));
          });

          grid.panel({ title: "Queue & Jobs - 15m" }, (panel) => {
            panel.keyValues(queueJobsFields("w15m"));
          });

          grid.panel({ title: "Queue & Jobs - 60m" }, (panel) => {
            panel.keyValues(queueJobsFields("w60m"));
          });

          grid.panel({ title: "Queue & Jobs - 24h" }, (panel) => {
            panel.keyValues(queueJobsFields("w24h"));
          });
        },
      );

      ui.grid(
        {
          columns: ["1fr", "1fr", "1fr"],
          rows: [10],
          size: 10,
          gap: 1,
        },
        (grid) => {
          grid.panel(
            {
              ...formatChartLegendHeader({
                label: "Queue Trend 15m",
                low: 0,
                high: queueTrendSharedMax,
                values: queue15mSeries.length > 0 ? queue15mSeries : [0],
              }),
            },
            (panel) => {
              panel.graph({
                values: queue15mSeries.length > 0 ? queue15mSeries : [0],
                min: 0,
                max: queueTrendSharedMax,
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
              ...formatChartLegendHeader({
                label: "Queue Trend 60m",
                low: 0,
                high: queueTrendSharedMax,
                values: queue60mSeries.length > 0 ? queue60mSeries : [0],
              }),
            },
            (panel) => {
              panel.graph({
                values: queue60mSeries.length > 0 ? queue60mSeries : [0],
                min: 0,
                max: queueTrendSharedMax,
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
              ...formatChartLegendHeader({
                label: "Queue Trend 24h",
                low: 0,
                high: queueTrendSharedMax,
                values: queue24hSeries.length > 0 ? queue24hSeries : [0],
              }),
            },
            (panel) => {
              panel.graph({
                values: queue24hSeries.length > 0 ? queue24hSeries : [0],
                min: 0,
                max: queueTrendSharedMax,
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
      const redisTotalSeries = buildWindowHistorySeries({
        values:
          state.historyRedisAggregateKbps.length > 0
            ? state.historyRedisAggregateKbps
            : [aggregate.redisWireKbps],
        windowMs: state.trendWindowMs,
        targetPoints: redisTrendPointLimit,
        padMissingCoverage: true,
      });
      const redisRxSeries = buildWindowHistorySeries({
        values:
          state.historyRedisAggregateRxKbps.length > 0
            ? state.historyRedisAggregateRxKbps
            : [aggregate.redisIngressKbps],
        windowMs: state.trendWindowMs,
        targetPoints: redisTrendPointLimit,
        padMissingCoverage: true,
      });
      const redisTxSeries = buildWindowHistorySeries({
        values:
          state.historyRedisAggregateTxKbps.length > 0
            ? state.historyRedisAggregateTxKbps
            : [aggregate.redisEgressKbps],
        windowMs: state.trendWindowMs,
        targetPoints: redisTrendPointLimit,
        padMissingCoverage: true,
      });
      const redisTrendRawMax = Math.max(
        1,
        ...redisTotalSeries,
        ...redisRxSeries,
        ...redisTxSeries,
      );
      const redisTrendMax = lockYAxisMaxFromSeries({
        state,
        chartId: "infra.redisWireTrend",
        plottedValues: [redisTrendRawMax],
        minMax: 1,
      });
      const workersTrendPointLimit = trendPointLimitForWindow(5 * 60 * 1000);
      const workersTrend =
        state.historyWorkersRunning.length > 0
          ? buildWindowHistorySeries({
              values: state.historyWorkersRunning,
              windowMs: 5 * 60 * 1000,
              targetPoints: workersTrendPointLimit,
              padMissingCoverage: true,
            })
          : [Math.max(0, telemetry.liveWorkersRunning)];
      const workersTrendMax = lockYAxisMaxFromSeries({
        state,
        chartId: "infra.workersTrend",
        plottedValues: workersTrend,
        minMax: 1,
      });
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

          grid.panel(
            {
              ...formatChartLegendHeader({
                label: "Workers Running Trend (5m)",
                low: 0,
                high: workersTrendMax,
                values: workersTrend,
              }),
            },
            (panel) => {
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
            },
          );

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
              ...formatChartLegendHeader({
                label: "Infra: Redis Wire Trend (Kbps)",
                low: 0,
                high: redisTrendMax,
                values: redisTotalSeries,
              }),
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
        if (typeof value === "number") {
          if (!Number.isFinite(value)) {
            return "n/a";
          }
          if (Number.isInteger(value)) {
            return String(value);
          }
          const abs = Math.abs(value);
          if (abs >= 1000) {
            return value.toFixed(1);
          }
          if (abs >= 1) {
            return value.toFixed(2);
          }
          return value.toFixed(4);
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

      const toCanonicalMetricLabel = (metricName: string): string => {
        const snake = toSnakeReferenceName(metricName);
        return snake.replace(/^status_/, "").replace(/_live$/, "");
      };

      const invalidMetricRefs: string[] = [];

      const readSnapshotMetricStrict = (metricName: string): number | null => {
        const metricId = `snapshot.${metricName}`;
        const metricRefError = validateSnapshotMetricId(metricId);
        if (metricRefError) {
          invalidMetricRefs.push(metricRefError);
          return null;
        }
        return readModuleMetricValue(metricName, "w15s", "latest");
      };

      const snapshotMetricRows = OPS_SNAPSHOT_TREND_METRIC_REGISTRY.map(
        (metric) => {
          const latestValue = readSnapshotMetricStrict(metric.name);
          return {
            label: toCanonicalMetricLabel(metric.name),
            value: formatMetricValue(metric.name, latestValue),
          };
        },
      );
      const liveMetricRows = [...snapshotMetricRows];

      const resolvedIps =
        readModuleMetricValue(
          "statusThroughputImagesPerMinute",
          "w15s",
          "avg",
        ) / 60;
      const resolvedIpm = readModuleMetricValue(
        "statusThroughputImagesPerMinute",
        "w15s",
        "avg",
      );
      const resolvedAvgEndToEndMs = readModuleMetricValue(
        "avgEndToEndMs",
        "w15s",
        "avg",
      );

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
        { label: "ips", value: formatMetricValue("ips", resolvedIps) },
        { label: "ipm", value: formatMetricValue("ipm", resolvedIpm) },
        {
          label: "avg_end_to_end_ms",
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
          label: "system_error_fields_total",
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
          label: "status_updated_at",
          value: formatTrackedValue(status?.updatedAt),
        },
      ];

      const infraRows: Array<{ label: string; value: string }> = [
        {
          label: "infra_workers_running",
          value: formatTrackedValue(
            readModuleMetricInt("workersRunningLive", "w15s", "latest"),
          ),
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
          value: formatTrackedValue(
            readModuleMetricInt("queueWaitingLive", "w15s", "latest"),
          ),
        },
        {
          label: "queue_active",
          value: formatTrackedValue(
            readModuleMetricInt("queueActiveLive", "w15s", "latest"),
          ),
        },
        {
          label: "queue_completed",
          value: formatTrackedValue(
            readModuleMetricInt("queueCompletedLive", "w15s", "latest"),
          ),
        },
        {
          label: "queue_failed",
          value: formatTrackedValue(
            readModuleMetricInt("queueFailedLive", "w15s", "latest"),
          ),
        },
        {
          label: "queue_delayed",
          value: formatTrackedValue(
            readModuleMetricInt("queueDelayedLive", "w15s", "latest"),
          ),
        },
        {
          label: "queue_paused",
          value: formatTrackedValue(
            readModuleMetricInt("queuePausedLive", "w15s", "latest"),
          ),
        },
        {
          label: "queue_backlog",
          value: formatTrackedValue(
            readModuleMetricInt("queueBacklogLive", "w15s", "latest"),
          ),
        },
      ];

      const dbRows: Array<{ label: string; value: string }> = [
        {
          label: "db_processed",
          value: formatTrackedValue(
            readModuleMetricInt("dbProcessed", "w15s", "latest"),
          ),
        },
        {
          label: "db_pending",
          value: formatTrackedValue(
            readModuleMetricInt("dbPending", "w15s", "latest"),
          ),
        },
        {
          label: "db_total",
          value: formatTrackedValue(
            readModuleMetricInt("dbTotal", "w15s", "latest"),
          ),
        },
        {
          label: "db_pct",
          value: formatTrackedValue(
            readModuleMetricValue("dbProgressPct", "w15s", "avg"),
          ),
        },
        {
          label: "db_eta_at_live_ips",
          value: formatDuration(
            (() => {
              const pending = Math.max(
                0,
                readModuleMetricInt("dbPending", "w15s", "latest"),
              );
              const liveIps = Math.max(0, liveIpsFrom15s);
              return pending === 0 ? 0 : liveIps > 0 ? pending / liveIps : null;
            })(),
          ),
        },
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
        if (label.startsWith("db_") || label.includes("db")) {
          return "database";
        }
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
      for (const row of liveMetricRows) {
        pushGroupRows(classifyMetricGroup(row.label), [row]);
      }

      for (const group of groupOrder) {
        groupedRows[group].sort((left, right) =>
          left.label.localeCompare(right.label),
        );
      }

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

    if (
      state.activeScreen === "processing" ||
      state.activeScreen === "queuejobs"
    ) {
      ui.spacer("1fr");
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
  writeHqtuiRuntimeLog("app_start_returned", {
    explicitQuitRequested,
    running: state.running,
  });
  clearInterval(uiClockTimer);

  process.off("SIGINT", onSigint);
  process.off("uncaughtException", onUncaughtException);
  process.off("unhandledRejection", onUnhandledRejection);

  await uiStateWatcher.close();
  writeHqtuiRuntimeLog("watcher_closed", { explicitQuitRequested });

  if (explicitQuitRequested) {
    writeHqtuiRuntimeLog("process_exit_0_explicit_quit");
    process.exit(0);
  }

  writeHqtuiRuntimeLog("main_complete_without_explicit_quit");
}

main().catch((error: unknown) => {
  const serialized = serializeUnknownError(error);
  const message = serialized.message;
  writeHqtuiRuntimeLog("main_catch", serialized);
  process.stderr.write(`image ops hqtui failed: ${message}\n`);
  process.exit(1);
});
