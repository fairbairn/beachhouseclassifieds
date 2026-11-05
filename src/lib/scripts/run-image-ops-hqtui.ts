import "@/core/tooling/env/load-env-profile";
import { createApp, type TextEditState } from "@profullstack/hqtui";

import {
  configureRedisTarget,
  createRedisConnection,
  formatRedisEndpointForLogs,
  resolveRedisUrl,
  type RedisTarget,
} from "../../workers/image-queue";
import {
  clearOpsQueueIfPaused,
  createOpsUiStateWatcher,
  pauseOpsSystemFlow,
  readOpsRedisIoStats,
  readOpsSnapshotTrendLatest,
  readOpsSnapshotTrendSeries,
  readOpsTrendProjectionSampled,
  resetOpsRedisIoStats,
  resumeOpsSystemFlow,
  scaleOpsWorkers,
  setOpsDesiredModeWithQueueAction,
  updateOpsControlSettings,
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
const TREND_GRAPH_BUCKET_MS = 5000;
const REDIS_TREND_DISPLAY_SAMPLES_MIN = 240;
const TREND_AXIS_HEADROOM_MULTIPLIER = 1.15;
const TREND_AXIS_DECAY_PER_REFRESH = 0.998;
const TREND_AXIS_WINDOW_1H_MS = 60 * 60 * 1000;
const TREND_AXIS_WINDOW_1H_REFRESH_MS = 15_000;

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
  activeScreen: "summary" | "infra" | "queues" | "workers" | "redis";
  historyBacklog: number[];
  historyProcessed: number[];
  historyFailures: number[];
  historyIps: number[];
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
  processingTrendHourMax: number;
  queueTrendHourMax: number;
  lastTrendAxisWindowRefreshAtMs: number;
  processingTrendLogicalMax: number;
  queueTrendLogicalMax: number;
  compositeTrendLogicalMax: number;
  redisTrendLogicalMax: number;
  lastSampleAtMs: number | null;
  lastRedisSampleAtMs: number | null;
  lastRedisIngressBytes: number | null;
  lastRedisIngressReads: number | null;
  lastDbProcessed: number | null;
  lastBacklog: number | null;
  lastQueueCompleted: number | null;
  lastRunnerMode: string | null;
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

const SCREEN_ORDER: Array<"summary" | "infra"> = ["summary", "infra"];

function nextScreen(
  screen: "summary" | "infra" | "queues" | "workers" | "redis",
): "summary" | "infra" {
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

function nextLogicalAxisMax(previousMax: number, observedMax: number): number {
  const observedWithHeadroom = Math.max(
    1,
    observedMax * TREND_AXIS_HEADROOM_MULTIPLIER,
  );
  if (!Number.isFinite(previousMax) || previousMax <= 0) {
    return observedWithHeadroom;
  }
  const decayed = Math.max(1, previousMax * TREND_AXIS_DECAY_PER_REFRESH);
  return Math.max(decayed, observedWithHeadroom);
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

function parseRedisAuthMode(
  redisUrl: string,
): "present" | "missing" | "unknown" {
  try {
    const parsed = new URL(redisUrl);
    return parsed.username || parsed.password ? "present" : "missing";
  } catch {
    return "unknown";
  }
}

async function preflightRedisForGui(input?: {
  timeoutMs?: number;
}): Promise<{ endpoint: string; authMode: "present" | "missing" | "unknown" }> {
  const redisUrl = resolveRedisUrl();
  const endpoint = formatRedisEndpointForLogs(redisUrl);
  const authMode = parseRedisAuthMode(redisUrl);
  const timeoutMs = Math.max(1000, input?.timeoutMs ?? 4000);

  const connection = createRedisConnection();
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  try {
    await Promise.race([
      connection.ping(),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`redis preflight timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
    return { endpoint, authMode };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const authHint =
      message.toUpperCase().includes("NOAUTH") || authMode !== "present"
        ? "If using a local proxy to Upstash, include credentials in REDIS_URL, e.g. redis://:PASSWORD@127.0.0.1:16379/0"
        : "Check proxy health, network reachability, and Redis credentials.";
    throw new Error(
      `Redis preflight failed endpoint=${endpoint} auth=${authMode} reason=${message}. ${authHint}`,
    );
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    await connection.quit().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const redisSelection = configureRedisTarget(args.redisTarget);
  const initialIntervalMs = Math.max(1000, args.intervalSeconds * 1000);
  const initialTrendWindowMs = DEFAULT_TREND_WINDOW_MINUTES * 60 * 1000;
  const redisPreflight = await preflightRedisForGui();

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
    processingTrendHourMax: 1,
    queueTrendHourMax: 1,
    lastTrendAxisWindowRefreshAtMs: 0,
    processingTrendLogicalMax: 1,
    queueTrendLogicalMax: 1,
    compositeTrendLogicalMax: 1,
    redisTrendLogicalMax: 1,
    lastSampleAtMs: null,
    lastRedisSampleAtMs: null,
    lastRedisIngressBytes: null,
    lastRedisIngressReads: null,
    lastDbProcessed: null,
    lastBacklog: null,
    lastQueueCompleted: null,
    lastRunnerMode: null,
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
        redisIoAggregate:
          snapshot.redisIoAggregate ?? previous.redisIoAggregate,
        redisIoInstances:
          snapshot.redisIoInstances ?? previous.redisIoInstances,
        projections: snapshot.projections,
      };
      state.snapshot = merged;
      const historyMax = trendPointLimitForWindow(state.trendWindowMs);
      state.compositeTrendLogicalMax = nextLogicalAxisMax(
        state.compositeTrendLogicalMax,
        Math.max(
          seriesMax(merged.projections.processedItemsTrend),
          seriesMax(merged.projections.failedItemsTrend),
          seriesMax(merged.projections.queueBacklogTrendSmoothed),
        ),
      );

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
        nowMs - state.lastTrendAxisWindowRefreshAtMs >=
          TREND_AXIS_WINDOW_1H_REFRESH_MS ||
        state.processingTrendHourMax <= 1 ||
        state.queueTrendHourMax <= 1
      ) {
        const oneHourProjection = await readOpsTrendProjectionSampled({
          limit: trendPointLimitForWindow(TREND_AXIS_WINDOW_1H_MS),
          sampleMode: "interpolated",
          sampleMaxGapMs: Math.max(1000, state.intervalMs * 3),
          sampleAnchorAtMs: nowMs,
          sampleWindowMs: TREND_AXIS_WINDOW_1H_MS,
        }).catch(() => null);
        if (oneHourProjection) {
          state.processingTrendHourMax = Math.max(
            1,
            seriesMax(oneHourProjection.ipsSmoothed),
          );
          state.queueTrendHourMax = Math.max(
            1,
            seriesMax(oneHourProjection.queueBacklogTrendSmoothed),
          );
          state.lastTrendAxisWindowRefreshAtMs = nowMs;
        }
      }

      const processingObservedMax = Math.max(
        seriesMax(merged.projections.ipsSmoothed),
        state.processingTrendHourMax,
      );
      const queueObservedMax = Math.max(
        seriesMax(merged.projections.queueBacklogTrendSmoothed),
        state.queueTrendHourMax,
      );
      state.processingTrendLogicalMax = Math.max(
        1,
        processingObservedMax * TREND_AXIS_HEADROOM_MULTIPLIER,
      );
      state.queueTrendLogicalMax = Math.max(
        1,
        queueObservedMax * TREND_AXIS_HEADROOM_MULTIPLIER,
      );

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
      state.redisTrendLogicalMax = nextLogicalAxisMax(
        state.redisTrendLogicalMax,
        Math.max(
          seriesMax(state.historyRedisAggregateKbps),
          seriesMax(state.historyRedisAggregateRxKbps),
          seriesMax(state.historyRedisAggregateTxKbps),
        ),
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
      state.redisTrendLogicalMax = 1;
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
    const rollup24h = perfRollups?.rollup24h;
    const rollupDeep = perfRollups?.rollupDeep;
    const trendPointLimit = trendPointLimitForWindow(state.trendWindowMs);
    const moduleBacklogTrend = normalizeTrendSeries(
      projection.queueBacklogTrendSmoothed,
      trendPointLimit,
    );
    const compositeQueueSizeTrend = moduleBacklogTrend;
    const compositeProcessedTrend = normalizeTrendSeries(
      projection.processedItemsTrend,
      trendPointLimit,
    );
    const compositeFailedTrend = normalizeTrendSeries(
      projection.failedItemsTrend,
      trendPointLimit,
    );
    const moduleIpsTrend = normalizeTrendSeries(
      projection.ipsSmoothed,
      trendPointLimit,
    );
    const moduleBacklogDeltaTrend = normalizeTrendSeries(
      projection.backlogDeltaSmoothed,
      trendPointLimit,
    );
    const processingTrendMax = Math.max(
      1,
      state.processingTrendLogicalMax,
      seriesMax(moduleIpsTrend),
    );
    const queueTrendMax = Math.max(
      1,
      state.queueTrendLogicalMax,
      seriesMax(moduleBacklogTrend),
    );
    const compositeTrendMax = Math.max(
      1,
      state.compositeTrendLogicalMax,
      seriesMax(compositeProcessedTrend),
      seriesMax(compositeFailedTrend),
      seriesMax(compositeQueueSizeTrend),
    );
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
    const queueCompleted = queue?.completed ?? 0;
    const queueFailed = queue?.failed ?? 0;
    const totalJobsRetained =
      queueWaiting +
      queueActive +
      queueDelayed +
      queuePaused +
      queueCompleted +
      queueFailed;
    const activeJobRatio = backlog > 0 ? queueActive / backlog : 0;
    const ipsLive = Math.max(0, statusIpsNow || historyIpsNow || 0);
    const ipsGaugeMax = Math.max(
      1,
      ipsLive,
      ...(moduleIpsTrend.length > 0 ? moduleIpsTrend : [0]),
    );
    const ipsGaugeValue = clamp(ipsLive / ipsGaugeMax, 0, 1);
    const backlogDeltaSeries = state.historyBacklogDeltaPerSec;
    const backlogDeltaAbsMax =
      backlogDeltaSeries.length > 0
        ? Math.max(1, ...backlogDeltaSeries.map((value) => Math.abs(value)))
        : 1;
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
                label: "ips_15s",
                value: formatRate(Number(rollup15s?.ips || ipsNow), 2),
              },
              {
                label: "ipm_15s",
                value: formatRate(Number(rollup15s?.ipm || ipmNow), 2),
              },
              {
                label: "processed_items_15s",
                value: String(rollup15s?.processedItems ?? 0),
              },
              {
                label: "failed_items_15s",
                value: String(rollup15s?.failedItems ?? 0),
              },
              {
                label: "sec_per_image_15s",
                value:
                  (rollup15s?.secPerImage ?? secPerImageNow) === null
                    ? "n/a"
                    : formatRate(rollup15s?.secPerImage ?? secPerImageNow, 2),
              },
              { label: "queue_pending", value: String(backlog) },
              { label: "queue_active", value: String(queueActive) },
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
            { title: "Image Processing (15s)", colSpan: 2 },
            (panel) => {
              panel.keyValues([
                {
                  label: "processed_items",
                  value: String(rollup15s?.processedItems ?? 0),
                },
                {
                  label: "failed_items",
                  value: String(rollup15s?.failedItems ?? 0),
                },
                {
                  label: "ips",
                  value: formatRate(Number(rollup15s?.ips ?? 0), 2),
                },
                {
                  label: "ipm",
                  value: formatRate(Number(rollup15s?.ipm ?? 0), 2),
                },
                {
                  label: "avg_fetch_ms",
                  value: String(rollup15s?.avgFetchMs ?? 0),
                },
                {
                  label: "avg_transform_ms",
                  value: String(rollup15s?.avgTransformMs ?? 0),
                },
                {
                  label: "avg_upload_ms",
                  value: String(rollup15s?.avgUploadMs ?? 0),
                },
              ]);
            },
          );

          grid.panel(
            {
              title: `Processing Trend (0-${processingTrendMax.toFixed(1)})`,
              colSpan: 2,
            },
            (panel) => {
              panel.graph({
                values: moduleIpsTrend.length > 0 ? moduleIpsTrend : [0],
                min: 0,
                max: processingTrendMax,
                axis: false,
                color: theme.success,
              });
            },
          );

          grid.panel({ title: "IPS Rate", colSpan: 2 }, (panel) => {
            panel.gauge({
              value: ipsGaugeValue,
              label: `ips_live ${formatRate(ipsLive, 2)}`,
            });
          });

          grid.panel({ title: "Queue & Jobs (15s)", colSpan: 2 }, (panel) => {
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
              { label: "pending_live", value: String(backlog) },
              { label: "active_live", value: String(queueActive) },
              {
                label: "jobs_done_15s",
                value: String(rollup15s?.completedJobs ?? 0),
              },
              {
                label: "jobs_fail_15s",
                value: String(rollup15s?.failedJobs ?? 0),
              },
              {
                label: "items_done_15s",
                value: String(rollup15s?.processedItems ?? 0),
              },
              {
                label: "items_fail_15s",
                value: String(rollup15s?.failedItems ?? 0),
              },
              { label: "op", value: status?.operationId || "none" },
              {
                label: "flush_ms",
                value: String(settings?.flushIntervalMs ?? "n/a"),
              },
              {
                label: "harvest_enabled",
                value:
                  settings?.harvestEnabled === undefined
                    ? "n/a"
                    : String(settings.harvestEnabled),
              },
            ]);
            panel.gauge({
              value: activeJobRatio,
              label: `active jobs ${queueActive}`,
            });
          });

          grid.panel(
            {
              title: `Queue Trend (0-${queueTrendMax.toFixed(1)})`,
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

          grid.panel({ title: "Queue Size", colSpan: 2 }, (panel) => {
            panel.gauge({
              value: backlogFillRatio,
              label: `pending_live ${backlog}`,
            });
          });

          grid.panel(
            {
              title: `Composite Trend (0-${compositeTrendMax.toFixed(1)})`,
              colSpan: 6,
            },
            (panel) => {
              panel.multiGraph(
                [
                  {
                    values:
                      compositeProcessedTrend.length > 0
                        ? compositeProcessedTrend
                        : [0],
                    color: theme.success,
                    label: "processed_items",
                  },
                  {
                    values:
                      compositeFailedTrend.length > 0
                        ? compositeFailedTrend
                        : [0],
                    color: theme.danger,
                    label: "failed_items",
                  },
                  {
                    values:
                      compositeQueueSizeTrend.length > 0
                        ? compositeQueueSizeTrend
                        : [0],
                    color: theme.warning,
                    label: "queue_size",
                  },
                ],
                {
                  min: 0,
                  max: compositeTrendMax,
                  axis: false,
                  legend: false,
                },
              );
              panel.statusBar({
                items: [
                  { label: "■ processed_items", color: theme.success },
                  { label: "■ failed_items", color: theme.danger },
                  { label: "■ queue_size", color: theme.warning },
                ],
                right: [{ label: `y:0-${compositeTrendMax.toFixed(1)}` }],
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

    if (state.activeScreen === "queues") {
      ui.grid(
        { columns: ["1fr", "1fr"], rows: [8, 10, 10, 10], gap: 1 },
        (grid) => {
          grid.panel({ title: "Queue Health" }, (panel) => {
            panel.keyValues([
              { label: "queue_size_pending", value: String(backlog) },
              {
                label: "queue_size_formula",
                value: "waiting + active + delayed + paused",
              },
              {
                label: "queue_size_snapshot",
                value:
                  telemetry.snapshotBacklog === null
                    ? "n/a"
                    : String(telemetry.snapshotBacklog),
              },
              {
                label: "queue_size_match",
                value: telemetry.backlogMismatch ? "false" : "true",
              },
              { label: "gate_live", value: telemetry.liveGate },
              { label: "gate_snapshot", value: telemetry.snapshotGateLabel },
              { label: "waiting_live", value: String(queue?.waiting ?? 0) },
              { label: "active_live", value: String(queue?.active ?? 0) },
              { label: "delayed_live", value: String(queue?.delayed ?? 0) },
              { label: "paused_live", value: String(queue?.paused ?? 0) },
              {
                label: "completed_live",
                value: String(queue?.completed ?? 0),
              },
              { label: "failed_live", value: String(queue?.failed ?? 0) },
            ]);
          });

          grid.panel({ title: "Queue Policy" }, (panel) => {
            panel.keyValues([
              {
                label: "queue_size_pending",
                value: String(backlog),
              },
              {
                label: "queue_capacity_max",
                value: String(settings?.maxQueueBacklog ?? "n/a"),
              },
              {
                label: "queue_fill_pct",
                value: `${(backlogFillRatio * 100).toFixed(1)}%`,
              },
              {
                label: "refill_low",
                value: String(settings?.refillLowWatermark ?? "n/a"),
              },
              {
                label: "refill_target",
                value: String(settings?.refillTargetBacklog ?? "n/a"),
              },
              {
                label: "max_claim_cycle",
                value: String(settings?.maxClaimPerCycle ?? "n/a"),
              },
              {
                label: "backlog_snapshot",
                value:
                  telemetry.snapshotBacklog === null
                    ? "n/a"
                    : String(telemetry.snapshotBacklog),
              },
              {
                label: "backlog_match",
                value: telemetry.backlogMismatch ? "false" : "true",
              },
            ]);
          });

          grid.panel({ title: "Backlog Trend" }, (panel) => {
            panel.graph({
              values: moduleBacklogTrend,
              min: 0,
              axis: true,
              color: theme.warning,
            });
          });

          grid.panel({ title: "Backlog Delta vs Processing" }, (panel) => {
            panel.multiGraph(
              [
                {
                  values: moduleBacklogDeltaTrend,
                  color: theme.warning,
                  label: "dq/s",
                },
                {
                  values: moduleIpsTrend,
                  color: theme.success,
                  label: "ips",
                },
              ],
              {
                min: -backlogDeltaAbsMax,
                max: Math.max(
                  backlogDeltaAbsMax,
                  Math.max(...moduleIpsTrend, 0),
                ),
                axis: true,
                legend: true,
              },
            );
          });

          grid.panel({ title: "Job Outcome Trends" }, (panel) => {
            panel.multiGraph(
              [
                {
                  values: state.historyQueueCompleted,
                  color: theme.success,
                  label: "completed_live",
                },
                {
                  values: state.historyQueueFailed,
                  color: theme.danger,
                  label: "failed_live",
                },
                {
                  values: state.historyProcessed,
                  color: theme.info,
                  label: "processed_status",
                },
              ],
              {
                min: 0,
                axis: true,
                legend: true,
              },
            );
          });

          grid.panel({ title: "Active Window (15m)" }, (panel) => {
            panel.keyValues([
              {
                label: "status_completed_jobs",
                value: String(status?.completedJobs ?? 0),
              },
              {
                label: "status_failed_jobs",
                value: String(status?.failedJobs ?? 0),
              },
              {
                label: "status_processed_items",
                value: String(status?.processedItems ?? 0),
              },
              {
                label: "status_failed_items",
                value: String(status?.failedItems ?? 0),
              },
              {
                label: "status_queued_count",
                value: String(status?.queuedCount ?? 0),
              },
              {
                label: "status_claimed_count",
                value: String(status?.claimedCount ?? 0),
              },
              {
                label: "status_updated_at",
                value: status?.updatedAt || "-",
              },
              {
                label: "runner_stale_s",
                value:
                  runnerStatusAgeSeconds === null
                    ? "n/a"
                    : String(runnerStatusAgeSeconds),
              },
            ]);
          });

          grid.panel({ title: "Daily Window (24h)" }, (panel) => {
            panel.keyValues([
              {
                label: "daily_completed_jobs",
                value: String(snapshot.recentJobs24h?.completedJobs ?? 0),
              },
              {
                label: "daily_failed_jobs",
                value: String(snapshot.recentJobs24h?.failedJobs ?? 0),
              },
              {
                label: "daily_processed_items",
                value: String(snapshot.recentJobs24h?.processedItems ?? 0),
              },
              {
                label: "daily_failed_items",
                value: String(snapshot.recentJobs24h?.failedItems ?? 0),
              },
              {
                label: "daily_window_start",
                value: snapshot.recentJobs24h?.windowStartAt || "-",
              },
              {
                label: "daily_sampled_at",
                value: snapshot.recentJobs24h?.sampledAt || "-",
              },
            ]);
          });

          grid.panel({ title: "All Windows" }, (panel) => {
            panel.keyValues([
              {
                label: "15s_jobs",
                value: `${rollup15s?.completedJobs ?? 0}/${rollup15s?.failedJobs ?? 0}`,
              },
              {
                label: "15s_ipm",
                value: formatRate(Number(rollup15s?.ipm || 0), 2),
              },
              {
                label: "1m_jobs",
                value: `${rollup1m?.completedJobs ?? 0}/${rollup1m?.failedJobs ?? 0}`,
              },
              {
                label: "1m_ipm",
                value: formatRate(Number(rollup1m?.ipm || 0), 2),
              },
              {
                label: "15m_jobs",
                value: `${rollup15m?.completedJobs ?? 0}/${rollup15m?.failedJobs ?? 0}`,
              },
              {
                label: "15m_ipm",
                value: formatRate(Number(rollup15m?.ipm || 0), 2),
              },
              {
                label: "24h_jobs",
                value: `${rollup24h?.completedJobs ?? 0}/${rollup24h?.failedJobs ?? 0}`,
              },
              {
                label: "24h_ipm",
                value: formatRate(Number(rollup24h?.ipm || 0), 2),
              },
              {
                label: "deep_jobs",
                value: `${rollupDeep?.completedJobs ?? 0}/${rollupDeep?.failedJobs ?? 0}`,
              },
              {
                label: "deep_ipm",
                value: formatRate(Number(rollupDeep?.ipm || 0), 2),
              },
            ]);
          });
        },
      );
    }

    if (state.activeScreen === "infra") {
      const queueBacklog =
        queueWaiting + queueActive + queueDelayed + queuePaused;
      const queuePendingShareRatio =
        totalJobsRetained > 0 ? queueBacklog / totalJobsRetained : 0;
      const aggregate = state.redisIoAggregate;
      const instances = state.redisIoInstances;
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
      const redisTrendMax = Math.max(
        1,
        state.redisTrendLogicalMax,
        aggregateMax,
      );
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
            ]);
          });

          grid.panel({ title: "Queue (Live)" }, (panel) => {
            panel.keyValues([
              { label: "pending", value: String(queueBacklog) },
              { label: "waiting", value: String(queueWaiting) },
              { label: "active", value: String(queueActive) },
              { label: "delayed", value: String(queueDelayed) },
              { label: "paused", value: String(queuePaused) },
              { label: "completed", value: String(queueCompleted) },
              { label: "failed", value: String(queueFailed) },
              {
                label: "pending_share",
                value: `${(queuePendingShareRatio * 100).toFixed(1)}%`,
              },
            ]);
            panel.gauge({
              value: queuePendingShareRatio,
              label: `pending jobs ${queueBacklog}`,
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
          modal.text("Keys: 1 summary, 2 infra");
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
        { key: "1/2", label: "Screens" },
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
