import "@/core/tooling/env/load-env-profile";
import { createApp, type TextEditState } from "@profullstack/hqtui";

import {
  configureRedisTarget,
  type RedisTarget,
} from "../../workers/image-queue";
import {
  clearOpsQueueIfPaused,
  createOpsUiStateWatcher,
  OPS_UI_METRIC_LABELS,
  pauseOpsSystemFlow,
  readOpsRedisIoStats,
  readOpsRedisPreflight,
  readOpsSnapshotTrendLatest,
  readOpsSnapshotTrendSeries,
  readOpsTrendProjectionSampled,
  resetOpsRedisIoStats,
  resumeOpsSystemFlow,
  scaleOpsWorkers,
  setOpsDesiredModeWithQueueAction,
  updateOpsControlSettings,
  type OpsMetricSystemSnapshot,
  type OpsRedisIoAggregateStats,
  type OpsRedisIoInstanceStats,
  type OpsRedisIoStats,
  type OpsTrendProjection,
  type OpsUiSnapshot,
  type OpsUiStateWatcher,
} from "../workers/image-ops-control-module";
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
const REDIS_TREND_DISPLAY_SAMPLES_MIN = 240;
const LONG_TREND_REFRESH_MS = 5_000;
const LONG_TREND_INTERPOLATION_MAX_GAP_MS = 120_000;
const LONG_IPS_DISPLAY_WIDTH_FACTOR = 3;
const LONG_IPS_DISPLAY_POINT_MAX = 240;
const LIVE_SLICE_MAX_AGE_MS = 5_000;
const UI_LABELS = OPS_UI_METRIC_LABELS;

type QueueCounts = ImageQueueCounts;
type ChartTimingMode = "ordinal" | "interpolated";

type DashboardSnapshot = {
  at: OpsUiSnapshot["at"];
  machines: OpsUiSnapshot["machines"];
  queue: QueueCounts | null;
  recentJobs24h: OpsUiSnapshot["recentJobs24h"];
  queuePaused: boolean | null;
  db: OpsUiSnapshot["db"];
  settings: RunnerControlSettings | null;
  infra: RunnerInfraSnapshot | null;
  status: RunnerStatusSnapshot | null;
  metricSystem?: OpsMetricSystemSnapshot;
  redisIoAggregate?: OpsRedisIoAggregateStats;
  redisIoInstances?: OpsRedisIoInstanceStats[];
  projections: OpsTrendProjection;
  errors: OpsUiSnapshot["errors"];
};

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
  activeScreen: "summary" | "infra" | "processing" | "queuejobs";
  historyBacklog: number[];
  historyProcessed: number[];
  historyFailures: number[];
  historyIps: number[];
  historyIpsLong: number[];
  historyIps60m: number[];
  historyIps24h: number[];
  historyBacklogDeltaPerSec: number[];
  historyQueue60m: number[];
  historyQueue24h: number[];
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
  machine: OpsMachineState;
  snapshot: DashboardSnapshot;
  redisIo: OpsRedisIoStats;
  redisIoAggregate: OpsRedisIoAggregateStats;
  redisIoInstances: OpsRedisIoInstanceStats[];
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

const SCREEN_ORDER: Array<"summary" | "infra" | "processing" | "queuejobs"> = [
  "summary",
  "infra",
  "processing",
  "queuejobs",
];

function nextScreen(
  screen: "summary" | "infra" | "processing" | "queuejobs",
): "summary" | "infra" | "processing" | "queuejobs" {
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
  return {
    value: nextValue,
    cursor: cursor + text.length,
  };
}

function editText(
  state: TextEditState,
  event: TextEditKeyEvent,
): TextEditState | null {
  const cursor = Math.max(0, Math.min(state.cursor, state.value.length));

  if (event.key === "left") {
    return { value: state.value, cursor: Math.max(0, cursor - 1) };
  }
  if (event.key === "right") {
    return {
      value: state.value,
      cursor: Math.min(state.value.length, cursor + 1),
    };
  }
  if (event.key === "home") {
    return { value: state.value, cursor: 0 };
  }
  if (event.key === "end") {
    return { value: state.value, cursor: state.value.length };
  }
  if (event.key === "backspace") {
    if (cursor <= 0) {
      return null;
    }
    return {
      value: state.value.slice(0, cursor - 1) + state.value.slice(cursor),
      cursor: cursor - 1,
    };
  }
  if (event.key === "delete") {
    if (cursor >= state.value.length) {
      return null;
    }
    return {
      value: state.value.slice(0, cursor) + state.value.slice(cursor + 1),
      cursor,
    };
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
  return clamp(Math.round(safeWindowMs / TREND_GRAPH_BUCKET_MS), 60, 1000);
}

function quantizedTrendAnchorAtMs(input: {
  nowMs: number;
  windowMs: number;
  sampleCount: number;
}): number {
  const safeNowMs = Math.max(0, Number(input.nowMs) || 0);
  const safeWindowMs = Math.max(1, Number(input.windowMs) || 1);
  const safeSampleCount = Math.max(2, Number(input.sampleCount) || 2);
  const bucketMs = Math.max(
    1000,
    Math.round(safeWindowMs / (safeSampleCount - 1)),
  );
  return Math.floor(safeNowMs / bucketMs) * bucketMs;
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

function emptyProjection(): OpsTrendProjection {
  return {
    sampleCount: 0,
    latestAtMs: null,
    queueBacklogTrendRaw: [],
    queueBacklogTrendSmoothed: [],
    processedItemsTrend: [],
    failedItemsTrend: [],
    ipsRaw: [],
    ipsSmoothed: [],
    backlogDeltaRaw: [],
    backlogDeltaSmoothed: [],
    headline: {
      ipsNow: 0,
      ipsSmoothedNow: 0,
      ipsAvg30: 0,
      ipmAvg30: 0,
      backlogDeltaNow: 0,
      backlogDeltaSmoothedNow: 0,
      drainPerSecSmoothed: 0,
      fillPerSecSmoothed: 0,
    },
  };
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const redisSelection = configureRedisTarget(args.redisTarget);
  const initialIntervalMs = Math.max(1000, args.intervalSeconds * 1000);
  const initialTrendWindowMs = DEFAULT_TREND_WINDOW_MINUTES * 60 * 1000;
  const redisPreflight = await readOpsRedisPreflight();

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
    notice: `redis target=${redisSelection.target} preflight ok endpoint=${redisPreflight.endpoint} auth=${redisPreflight.authMode}`,
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
    historyQueue60m: [],
    historyQueue24h: [],
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
    machine: initialOpsMachineState(),
    snapshot: {
      at: new Date().toISOString(),
      machines: null,
      queue: null,
      queuePaused: null,
      db: null,
      settings: null,
      infra: null,
      status: null,
      redisIoAggregate: undefined,
      redisIoInstances: undefined,
      projections: emptyProjection(),
      errors: {},
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
    },
    redisIoInstances: [],
  };

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

  let uiStateWatcher: OpsUiStateWatcher | null = null;

  const refresh = async (): Promise<void> => {
    if (state.polling || !state.running) {
      return;
    }
    state.polling = true;
    try {
      if (!uiStateWatcher) {
        return;
      }
      const snapshot = uiStateWatcher.getSnapshot();
      if (!snapshot) {
        return;
      }
      const previous = state.snapshot;
      const merged: DashboardSnapshot = {
        ...snapshot,
        machines: snapshot.machines ?? previous.machines,
        queue: snapshot.queue ?? previous.queue,
        recentJobs24h: snapshot.recentJobs24h ?? previous.recentJobs24h,
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
        projections: snapshot.projections,
      };
      state.snapshot = merged;
      const historyMax = trendPointLimitForWindow(state.trendWindowMs);

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

      const nowMs = Date.now();
      if (
        nowMs - state.lastLongTrendRefreshAtMs >= LONG_TREND_REFRESH_MS ||
        state.historyIpsLong.length === 0 ||
        state.historyIps60m.length === 0 ||
        state.historyIps24h.length === 0 ||
        state.historyQueue60m.length === 0 ||
        state.historyQueue24h.length === 0
      ) {
        const longWindowMs = LONG_TREND_WINDOW_MINUTES * 60 * 1000;
        const longLimit = trendPointLimitForWindow(longWindowMs);
        const longProjection = await readOpsTrendProjectionSampled({
          limit: longLimit,
          sampleMode: "interpolated",
          sampleMaxGapMs: Math.max(
            LONG_TREND_INTERPOLATION_MAX_GAP_MS,
            state.intervalMs * 3,
          ),
          sampleAnchorAtMs: nowMs,
          sampleWindowMs: longWindowMs,
        }).catch(() => null);
        const window60mMs = 60 * 60 * 1000;
        const limit60m = trendPointLimitForWindow(window60mMs);
        const projection60m = await readOpsTrendProjectionSampled({
          limit: limit60m,
          sampleMode: "interpolated",
          sampleMaxGapMs: Math.max(
            LONG_TREND_INTERPOLATION_MAX_GAP_MS,
            state.intervalMs * 3,
          ),
          sampleAnchorAtMs: nowMs,
          sampleWindowMs: window60mMs,
        }).catch(() => null);
        const window24hMs = 24 * 60 * 60 * 1000;
        const limit24h = trendPointLimitForWindow(window24hMs);
        const projection24h = await readOpsTrendProjectionSampled({
          limit: limit24h,
          sampleMode: "interpolated",
          sampleMaxGapMs: Math.max(
            LONG_TREND_INTERPOLATION_MAX_GAP_MS,
            state.intervalMs * 3,
          ),
          sampleAnchorAtMs: nowMs,
          sampleWindowMs: window24hMs,
        }).catch(() => null);
        if (longProjection) {
          state.historyIpsLong = tail(longProjection.ipsSmoothed, longLimit);
        }
        if (projection60m) {
          state.historyIps60m = tail(projection60m.ipsSmoothed, limit60m);
          state.historyQueue60m = tail(
            projection60m.queueBacklogTrendSmoothed,
            limit60m,
          );
        }
        if (projection24h) {
          state.historyIps24h = tail(projection24h.ipsSmoothed, limit24h);
          state.historyQueue24h = tail(
            projection24h.queueBacklogTrendSmoothed,
            limit24h,
          );
        }
        state.lastLongTrendRefreshAtMs = nowMs;
      }

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
      const redisTrendMetricNames = [
        "redisWireKbpsAggregate",
        "redisIngressKbpsAggregate",
        "redisEgressKbpsAggregate",
      ] as const;
      const redisTrendLatest = await readOpsSnapshotTrendLatest({
        metricNames: [...redisTrendMetricNames],
      });
      const redisLatestAtMs = Math.max(
        0,
        redisTrendLatest.redisWireKbpsAggregate?.atMs ?? 0,
        redisTrendLatest.redisIngressKbpsAggregate?.atMs ?? 0,
        redisTrendLatest.redisEgressKbpsAggregate?.atMs ?? 0,
      );

      const redisTrendSeries = await readOpsSnapshotTrendSeries({
        metricNames: [
          "redisWireKbpsAggregate",
          "redisIngressKbpsAggregate",
          "redisEgressKbpsAggregate",
        ],
        limit:
          state.chartTimingMode === "ordinal"
            ? historyMax
            : Math.max(historyMax, REDIS_TREND_DISPLAY_SAMPLES_MIN),
        sampleMode:
          state.chartTimingMode === "ordinal" ? "raw" : "interpolated",
        sampleMaxGapMs: Math.max(1000, state.intervalMs * 3),
        sampleAnchorAtMs: quantizedTrendAnchorAtMs({
          nowMs: redisLatestAtMs > 0 ? redisLatestAtMs : nowMs,
          windowMs: state.trendWindowMs,
          sampleCount:
            state.chartTimingMode === "ordinal"
              ? historyMax
              : Math.max(historyMax, REDIS_TREND_DISPLAY_SAMPLES_MIN),
        }),
        sampleWindowMs: state.trendWindowMs,
      });
      state.historyRedisAggregateKbps = [
        ...((redisTrendSeries.redisWireKbpsAggregate ?? []).slice(
          -Math.max(
            historyMax,
            state.chartTimingMode === "ordinal"
              ? historyMax
              : REDIS_TREND_DISPLAY_SAMPLES_MIN,
          ),
        ) as number[]),
      ];
      state.historyRedisAggregateRxKbps = [
        ...((redisTrendSeries.redisIngressKbpsAggregate ?? []).slice(
          -Math.max(
            historyMax,
            state.chartTimingMode === "ordinal"
              ? historyMax
              : REDIS_TREND_DISPLAY_SAMPLES_MIN,
          ),
        ) as number[]),
      ];
      state.historyRedisAggregateTxKbps = [
        ...((redisTrendSeries.redisEgressKbpsAggregate ?? []).slice(
          -Math.max(
            historyMax,
            state.chartTimingMode === "ordinal"
              ? historyMax
              : REDIS_TREND_DISPLAY_SAMPLES_MIN,
          ),
        ) as number[]),
      ];

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
      state.historyQueue60m = [];
      state.historyQueue24h = [];
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
    const moduleBacklogTrend = normalizeTrendSeries(
      projection.queueBacklogTrendSmoothed,
      trendPointLimit,
    );
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
    const nowMs = Date.now();
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
      const queue60mSeries =
        state.historyQueue60m.length > 0
          ? state.historyQueue60m
          : moduleBacklogTrend;
      const queue24hSeries =
        state.historyQueue24h.length > 0
          ? state.historyQueue24h
          : moduleBacklogTrend;
      const queueSectionMax = Math.max(
        1,
        seriesMax(queue60mSeries),
        seriesMax(queue24hSeries),
      );

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
                value: String(rollup15s?.completedJobs ?? 0),
              },
              {
                label: UI_LABELS.queue.failed,
                value: String(rollup15s?.failedJobs ?? 0),
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
              title: `Queue Trend 60m (0-${queueSectionMax.toFixed(1)})`,
              colSpan: 3,
            },
            (panel) => {
              panel.graph({
                values: queue60mSeries.length > 0 ? queue60mSeries : [0],
                min: 0,
                max: queueSectionMax,
                axis: false,
                color: theme.warning,
              });
            },
          );

          grid.panel(
            {
              title: `Queue Trend 24h (0-${queueSectionMax.toFixed(1)})`,
              colSpan: 3,
            },
            (panel) => {
              panel.graph({
                values: queue24hSeries.length > 0 ? queue24hSeries : [0],
                min: 0,
                max: queueSectionMax,
                axis: false,
                color: theme.info,
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
      const aggregateMax = Math.max(
        1,
        ...state.historyRedisAggregateKbps,
        ...state.historyRedisAggregateRxKbps,
        ...state.historyRedisAggregateTxKbps,
        aggregate.redisWireKbps,
        aggregate.redisIngressKbps,
        aggregate.redisEgressKbps,
      );
      const redisTrendMax = Math.max(1, aggregateMax);
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
                    values:
                      state.historyRedisAggregateKbps.length > 0
                        ? state.historyRedisAggregateKbps
                        : [0],
                    color: theme.success,
                    label: "total",
                  },
                  {
                    values:
                      state.historyRedisAggregateRxKbps.length > 0
                        ? state.historyRedisAggregateRxKbps
                        : [0],
                    color: theme.info,
                    label: "rx",
                  },
                  {
                    values:
                      state.historyRedisAggregateTxKbps.length > 0
                        ? state.historyRedisAggregateTxKbps
                        : [0],
                    color: theme.warning,
                    label: "tx",
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
          modal.text("Keys: 1 summary, 2 infra, 3 processing, 4 queue & jobs");
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
        { key: "1..4", label: "Screens" },
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

  state.notice = "connecting to module watcher...";
  app.invalidate();
  void (async () => {
    uiStateWatcher = await createOpsUiStateWatcher({
      appName: state.appName,
      profile: "cli",
      snapshotTimeoutMs: STARTUP_SNAPSHOT_TIMEOUT_MS,
      minRefreshIntervalMs: 1000,
      skipInitialRefresh: true,
      trendProjectionLimit: trendPointLimitForWindow(state.trendWindowMs),
      trendSampleMode: "interpolated",
      trendSampleWindowMs: state.trendWindowMs,
      trendSampleMaxGapMs: Math.max(1000, state.intervalMs * 3),
    }).catch(() => null);
    if (!state.running) {
      return;
    }
    state.notice = uiStateWatcher
      ? "reactive watcher connected"
      : "watcher unavailable; state feed offline";
    wakeRefreshLoop();
    app.invalidate();
  })();

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
      if (uiStateWatcher) {
        const signal = await uiStateWatcher.waitForState(state.intervalMs);
        needsRefresh = signal === "state";
      } else {
        await new Promise<void>((resolve) => {
          pollDelayResolve = () => {
            pollDelayResolve = null;
            resolve();
          };
          pollDelayTimer = setTimeout(() => {
            pollDelayTimer = null;
            const done = pollDelayResolve;
            pollDelayResolve = null;
            done?.();
          }, state.intervalMs);
        });
        needsRefresh = true;
      }
    }
  })();

  await app.start();
  clearInterval(uiClockTimer);

  process.off("SIGINT", onSigint);

  if (uiStateWatcher) {
    await uiStateWatcher.close();
  }

  if (explicitQuitRequested) {
    process.exit(0);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`image ops hqtui failed: ${message}\n`);
  process.exit(1);
});
