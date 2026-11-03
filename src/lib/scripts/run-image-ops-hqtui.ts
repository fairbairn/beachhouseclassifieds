import "@/core/tooling/env/load-env-profile";
import { createApp, type TextEditState } from "@profullstack/hqtui";

import {
  clearOpsQueueIfPaused,
  createOpsUiStateWatcher,
  pauseOpsSystemFlow,
  readOpsQueuePausedState,
  readOpsRedisIoAggregateStats,
  readOpsRedisIoInstanceStats,
  readOpsRedisIoStats,
  readOpsTrendProjection,
  readOpsUiSnapshot,
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

type QueueCounts = ImageQueueCounts;
type ChartTimingMode = "ordinal" | "interpolated";

type DashboardSnapshot = {
  at: OpsUiSnapshot["at"];
  machines: OpsUiSnapshot["machines"];
  queue: QueueCounts | null;
  db: OpsUiSnapshot["db"];
  settings: RunnerControlSettings | null;
  infra: RunnerInfraSnapshot | null;
  status: RunnerStatusSnapshot | null;
  projections: OpsTrendProjection;
  errors: OpsUiSnapshot["errors"];
};

type State = {
  appName: string;
  uiClockAt: string;
  intervalMs: number;
  trendSamples: number;
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
  activeScreen: "summary" | "queues" | "workers" | "redis";
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
  lastSampleAtMs: number | null;
  lastRedisSampleAtMs: number | null;
  lastRedisIngressBytes: number | null;
  lastRedisIngressReads: number | null;
  lastDbProcessed: number | null;
  lastBacklog: number | null;
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

const SCREEN_ORDER: Array<"summary" | "queues" | "workers" | "redis"> = [
  "summary",
  "queues",
  "workers",
  "redis",
];

function screenLabel(
  screen: "summary" | "queues" | "workers" | "redis",
): string {
  if (screen === "summary") {
    return "Summary";
  }
  if (screen === "queues") {
    return "Queues";
  }
  if (screen === "workers") {
    return "Workers";
  }
  return "Redis";
}

function nextScreen(
  screen: "summary" | "queues" | "workers" | "redis",
): "summary" | "queues" | "workers" | "redis" {
  const index = SCREEN_ORDER.indexOf(screen);
  const nextIndex = (index + 1) % SCREEN_ORDER.length;
  return SCREEN_ORDER[nextIndex];
}

function textState(value = ""): TextEditState {
  return { value, cursor: value.length };
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
    {
      id: "action:toggle-chart-timing",
      label: "Toggle chart timing",
      hint: "ordinal / interpolated",
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
  trendSamples: number;
  chartTimingMode: ChartTimingMode;
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
    chartTimingRaw === "interpolated" || chartTimingRaw === "timebucket"
      ? "interpolated"
      : "ordinal";

  return {
    appName: options.get("app")?.trim() || DEFAULT_APP,
    intervalSeconds: parsePositiveInt(options.get("interval-seconds"), 5),
    trendSamples: clamp(
      parsePositiveInt(options.get("trend-samples"), 100),
      10,
      100,
    ),
    chartTimingMode,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function pushHistory(values: number[], next: number, max = 120): number[] {
  values.push(next);
  if (values.length > max) {
    values.splice(0, values.length - max);
  }
  return values;
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  return total / values.length;
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

function tail(values: number[], count: number): number[] {
  if (values.length <= count) {
    return values;
  }
  return values.slice(values.length - count);
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

async function gatherSnapshot(appName: string): Promise<DashboardSnapshot> {
  return readOpsUiSnapshot(appName, 8000);
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const preloadProjectionPromise = readOpsTrendProjection(
    args.trendSamples,
  ).catch(() => emptyProjection());

  const state: State = {
    appName: args.appName,
    uiClockAt: formatLocalClockAt(),
    intervalMs: Math.max(1000, args.intervalSeconds * 1000),
    trendSamples: args.trendSamples,
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
    notice: "starting UI...",
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
    lastSampleAtMs: null,
    lastRedisSampleAtMs: null,
    lastRedisIngressBytes: null,
    lastRedisIngressReads: null,
    lastDbProcessed: null,
    lastBacklog: null,
    queueGloballyPaused: null,
    machine: initialOpsMachineState(),
    snapshot: {
      at: new Date().toISOString(),
      machines: null,
      queue: null,
      db: null,
      settings: null,
      infra: null,
      status: null,
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
    if (pollDelayTimer) {
      clearTimeout(pollDelayTimer);
      pollDelayTimer = null;
    }
    if (pollDelayResolve) {
      const resolve = pollDelayResolve;
      pollDelayResolve = null;
      resolve();
    }
    app.quit();
  };

  const onSigint = (): void => {
    state.notice = "Use q to quit";
    app.invalidate();
  };
  process.on("SIGINT", onSigint);

  let uiStateWatcher: OpsUiStateWatcher | null = null;
  let lastRefreshCompletedAtMs = 0;

  const refresh = async (): Promise<void> => {
    if (state.polling || !state.running) {
      return;
    }
    state.polling = true;
    try {
      const snapshot = uiStateWatcher
        ? uiStateWatcher.getSnapshot()
        : await gatherSnapshot(state.appName);
      if (!snapshot) {
        return;
      }
      const previous = state.snapshot;
      const merged: DashboardSnapshot = {
        ...snapshot,
        machines: snapshot.machines ?? previous.machines,
        queue: snapshot.queue ?? previous.queue,
        db: snapshot.db ?? previous.db,
        settings: snapshot.settings ?? previous.settings,
        infra: snapshot.infra ?? previous.infra,
        status: snapshot.status ?? previous.status,
        projections: snapshot.projections,
      };
      state.snapshot = merged;

      const nowMs = Date.now();
      const currentBacklog = merged.queue?.backlog ?? 0;
      const currentProcessed =
        merged.status?.processedItems ?? merged.db?.processed ?? 0;
      const currentFailed =
        merged.status?.failedItems ?? merged.queue?.failed ?? 0;

      pushHistory(state.historyBacklog, currentBacklog);
      pushHistory(state.historyProcessed, currentProcessed);
      pushHistory(state.historyFailures, currentFailed);

      if (
        state.lastSampleAtMs !== null &&
        state.lastDbProcessed !== null &&
        state.lastBacklog !== null
      ) {
        const elapsedSeconds = Math.max(
          0.001,
          (nowMs - state.lastSampleAtMs) / 1000,
        );
        const ipsNow = Math.max(
          0,
          (currentProcessed - state.lastDbProcessed) / elapsedSeconds,
        );
        const backlogDeltaNow =
          (currentBacklog - state.lastBacklog) / elapsedSeconds;
        pushHistory(state.historyIps, Number(ipsNow.toFixed(3)));
        pushHistory(
          state.historyBacklogDeltaPerSec,
          Number(backlogDeltaNow.toFixed(3)),
        );
      } else {
        pushHistory(state.historyIps, 0);
        pushHistory(state.historyBacklogDeltaPerSec, 0);
      }

      state.lastSampleAtMs = nowMs;
      state.lastDbProcessed = currentProcessed;
      state.lastBacklog = currentBacklog;

      pushHistory(state.historyQueueWaiting, merged.queue?.waiting ?? 0);
      pushHistory(state.historyQueueActive, merged.queue?.active ?? 0);
      pushHistory(state.historyQueueDelayed, merged.queue?.delayed ?? 0);
      pushHistory(state.historyQueuePaused, merged.queue?.paused ?? 0);
      pushHistory(state.historyQueueCompleted, merged.queue?.completed ?? 0);
      pushHistory(state.historyQueueFailed, merged.queue?.failed ?? 0);
      pushHistory(
        state.historyWorkersRunning,
        merged.infra?.workersRunning ?? merged.status?.workersRunning ?? 0,
      );
      pushHistory(
        state.historyPendingSuccess,
        merged.status?.pendingSuccessBuffer ?? 0,
      );
      pushHistory(
        state.historyPendingError,
        merged.status?.pendingErrorBuffer ?? 0,
      );
      pushHistory(
        state.historyFlushBatches,
        merged.status?.flushBatchCount ?? 0,
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
      const [aggregateIo, instanceIo] = await Promise.all([
        readOpsRedisIoAggregateStats().catch(() => null),
        readOpsRedisIoInstanceStats().catch(() => []),
      ]);
      const pausedState = await readOpsQueuePausedState().catch(() => null);
      if (aggregateIo) {
        state.redisIoAggregate = aggregateIo;
      }
      state.redisIoInstances = instanceIo;
      state.queueGloballyPaused = pausedState;

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
        );
        pushHistory(
          state.historyRedisReadsPerSec,
          Number((deltaReads / elapsedSeconds).toFixed(3)),
        );
      } else {
        pushHistory(state.historyRedisKbps, state.redisIo.redisIngressKbps);
        pushHistory(
          state.historyRedisReadsPerSec,
          Number(
            (
              state.redisIo.redisIngressReads /
              Math.max(1, state.redisIo.windowSeconds)
            ).toFixed(3),
          ),
        );
      }
      pushHistory(
        state.historyRedisAggregateKbps,
        state.redisIoAggregate.redisWireKbps,
      );

      state.lastRedisSampleAtMs = nowMs;
      state.lastRedisIngressBytes = state.redisIo.redisIngressBytes;
      state.lastRedisIngressReads = state.redisIo.redisIngressReads;
      state.notice = state.machine.notice;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.machine = reduceOpsMachine(state.machine, {
        type: "refresh_error",
        message,
        nowMs: Date.now(),
      });
      state.notice = state.machine.notice;
    } finally {
      state.polling = false;
      lastRefreshCompletedAtMs = Date.now();
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

    if (item.id === "action:toggle-chart-timing") {
      state.showCommandPalette = false;
      state.chartTimingMode =
        state.chartTimingMode === "ordinal" ? "interpolated" : "ordinal";
      state.notice = `chart_timing=${state.chartTimingMode}`;
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
      state.activeScreen = "queues";
      state.notice = "screen=queues";
      app.invalidate();
      return;
    }

    if (event.key === "3") {
      state.activeScreen = "workers";
      state.notice = "screen=workers";
      app.invalidate();
      return;
    }

    if (event.key === "4") {
      state.activeScreen = "redis";
      state.notice = "screen=redis";
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
    const ipsNow =
      projection.sampleCount > 0
        ? projection.headline.ipsSmoothedNow
        : state.historyIps[state.historyIps.length - 1] || 0;
    const ipmNow = ipsNow * 60;
    const ipsAvg30 =
      projection.sampleCount > 0
        ? projection.headline.ipsAvg30
        : average(tail(state.historyIps, 30));
    const ipmAvg30 =
      projection.sampleCount > 0 ? projection.headline.ipmAvg30 : ipsAvg30 * 60;
    const backlogDeltaNow =
      projection.sampleCount > 0
        ? projection.headline.backlogDeltaSmoothedNow
        : state.historyBacklogDeltaPerSec[
            state.historyBacklogDeltaPerSec.length - 1
          ] || 0;
    const refillPerSec =
      projection.sampleCount > 0
        ? projection.headline.fillPerSecSmoothed
        : Math.max(0, backlogDeltaNow);
    const drainPerSec =
      projection.sampleCount > 0
        ? projection.headline.drainPerSecSmoothed
        : Math.max(0, -backlogDeltaNow);
    const maxBacklog = Math.max(1, settings?.maxQueueBacklog ?? 1);
    const backlog = queue?.backlog ?? 0;
    const backlogFillRatio = clamp(backlog / maxBacklog, 0, 1);
    const backlogDeltaSeries = state.historyBacklogDeltaPerSec;
    const backlogDeltaAbsMax =
      backlogDeltaSeries.length > 0
        ? Math.max(1, ...backlogDeltaSeries.map((value) => Math.abs(value)))
        : 1;
    const currentScreenLabel = screenLabel(state.activeScreen);
    const telemetry = deriveOpsTelemetry({
      settings,
      infra: snapshot.infra,
      status,
      queue,
      errors: snapshot.errors,
    });
    const queueFlowStateLabel =
      state.queueGloballyPaused === null
        ? "unknown"
        : state.queueGloballyPaused
          ? "paused"
          : "running";

    if (state.activeScreen === "summary") {
      ui.grid(
        { columns: ["1fr", "1fr"], rows: [8, 10, 10, 10], gap: 1 },
        (grid) => {
          grid.panel({ title: "Control Tower" }, (panel) => {
            panel.keyValues([
              { label: "app", value: state.appName },
              { label: "screen", value: currentScreenLabel },
              { label: "time", value: state.uiClockAt },
              { label: "queue_flow_state", value: queueFlowStateLabel },
              { label: "notice", value: state.notice },
              {
                label: "poll",
                value: `${Math.round(state.intervalMs / 1000)}s${state.polling ? " (busy)" : ""}`,
              },
              {
                label: "redis_io",
                value:
                  `wire=${formatBitrateFromKbps(state.redisIo.redisWireKbps)} ` +
                  `rx=${formatBitrateFromKbps(state.redisIo.redisIngressKbps)} ` +
                  `tx=${formatBitrateFromKbps(state.redisIo.redisEgressKbps)} ` +
                  `reads=${state.redisIo.redisIngressReads}`,
              },
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
              { label: "chart_timing", value: state.chartTimingMode },
              {
                label: "redis_bytes",
                value: String(state.redisIo.redisIngressBytes),
              },
              {
                label: "redis_kb_per_read",
                value: state.redisIo.redisIngressKbPerRead.toFixed(3),
              },
              { label: "redis_last", value: state.redisIo.lastReadAt || "-" },
            ]);
          });

          grid.panel({ title: "Infra" }, (panel) => {
            panel.keyValues([
              {
                label: "machines",
                value: `${snapshot.machines?.length ?? 0} (${machineStateSummary(snapshot.machines)}) / workers ${telemetry.liveWorkersRunning}`,
              },
              {
                label: "queue_size",
                value: `${backlog} pending`,
              },
              { label: "q_wait", value: String(queue?.waiting ?? 0) },
              { label: "q_active", value: String(queue?.active ?? 0) },
              { label: "q_delayed", value: String(queue?.delayed ?? 0) },
              { label: "q_backlog", value: String(queue?.backlog ?? 0) },
            ]);
          });

          grid.panel({ title: "Queue Backlog Trend", rowSpan: 1 }, (panel) => {
            panel.graph({
              values: state.historyBacklog,
              min: 0,
              axis: true,
              color: theme.warning,
            });
          });

          grid.panel({ title: "Processed Trend", rowSpan: 1 }, (panel) => {
            panel.graph({
              values:
                state.historyProcessed.length > 0
                  ? state.historyProcessed
                  : [status?.processedItems ?? snapshot.db?.processed ?? 0],
              min: 0,
              axis: true,
              color: theme.success,
            });
          });

          grid.panel({ title: "Runner / Settings" }, (panel) => {
            panel.keyValues([
              { label: "mode", value: status?.mode || "none" },
              { label: "gate_live", value: telemetry.liveGate },
              { label: "gate_snapshot", value: telemetry.snapshotGateLabel },
              { label: "op", value: status?.operationId || "none" },
              {
                label: "processed",
                value: String(status?.processedItems ?? 0),
              },
              { label: "failed", value: String(status?.failedItems ?? 0) },
              { label: "jobs_done", value: String(status?.completedJobs ?? 0) },
              { label: "jobs_fail", value: String(status?.failedJobs ?? 0) },
              {
                label: "flush_ms",
                value: String(settings?.flushIntervalMs ?? "n/a"),
              },
              {
                label: "harvest",
                value:
                  settings?.harvestEnabled === undefined
                    ? "n/a"
                    : String(settings.harvestEnabled),
              },
            ]);
          });

          grid.panel({ title: "Database" }, (panel) => {
            panel.keyValues([
              {
                label: "processed",
                value: String(snapshot.db?.processed ?? 0),
              },
              {
                label: "pending",
                value: String(snapshot.db?.pending ?? 0),
              },
              { label: "total", value: String(snapshot.db?.total ?? 0) },
              {
                label: "progress",
                value: `${(snapshot.db?.pct ?? 0).toFixed(2)}%`,
              },
            ]);
          });

          grid.panel({ title: "Throughput" }, (panel) => {
            panel.keyValues([
              { label: "ips_now", value: ipsNow.toFixed(2) },
              { label: "ipm_now", value: ipmNow.toFixed(1) },
              { label: "ips_avg30", value: ipsAvg30.toFixed(2) },
              { label: "ipm_avg30", value: ipmAvg30.toFixed(1) },
              { label: "drain_q/s", value: drainPerSec.toFixed(2) },
              { label: "fill_q/s", value: refillPerSec.toFixed(2) },
            ]);
          });

          grid.panel({ title: "Queue Size" }, (panel) => {
            panel.gauge({
              value: backlogFillRatio,
              label: String(backlog),
            });
            panel.graph({
              values: state.historyBacklog,
              min: 0,
              axis: true,
              color: theme.warning,
            });
          });
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
        { columns: ["1fr", "1fr"], rows: [8, 12, 12], gap: 1 },
        (grid) => {
          grid.panel({ title: "Queue Health" }, (panel) => {
            panel.keyValues([
              { label: "screen", value: currentScreenLabel },
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

          grid.panel({ title: "Queue Fill Policy" }, (panel) => {
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
                label: "gate_live",
                value: telemetry.liveGate,
              },
              {
                label: "gate_snapshot",
                value: telemetry.snapshotGateLabel,
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
              values: state.historyBacklog,
              min: 0,
              axis: true,
              color: theme.warning,
            });
          });

          grid.panel({ title: "Backlog Delta / Fill-Drain" }, (panel) => {
            panel.multiGraph(
              [
                {
                  values: state.historyBacklogDeltaPerSec,
                  color: theme.warning,
                  label: "dq/s",
                },
                {
                  values: state.historyIps,
                  color: theme.success,
                  label: "ips",
                },
              ],
              {
                min: -backlogDeltaAbsMax,
                max: Math.max(
                  backlogDeltaAbsMax,
                  Math.max(...state.historyIps, 0),
                ),
                axis: true,
                legend: true,
              },
            );
          });
        },
      );
    }

    if (state.activeScreen === "workers") {
      const redisMax = Math.max(
        1,
        ...state.historyRedisKbps,
        ...state.historyRedisReadsPerSec,
      );
      ui.grid(
        { columns: ["1fr", "1fr"], rows: [8, 12, 12], gap: 1 },
        (grid) => {
          grid.panel({ title: "Workers & Infra" }, (panel) => {
            panel.keyValues([
              { label: "screen", value: currentScreenLabel },
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
            ]);
          });

          grid.panel({ title: "Throughput" }, (panel) => {
            panel.keyValues([
              { label: "ips_now", value: ipsNow.toFixed(2) },
              { label: "ipm_now", value: ipmNow.toFixed(1) },
              { label: "ips_avg30", value: ipsAvg30.toFixed(2) },
              { label: "ipm_avg30", value: ipmAvg30.toFixed(1) },
              { label: "drain_q/s", value: drainPerSec.toFixed(2) },
              { label: "fill_q/s", value: refillPerSec.toFixed(2) },
            ]);
          });

          grid.panel({ title: "Processed Rate Trend" }, (panel) => {
            panel.multiGraph(
              [
                {
                  values: state.historyRedisKbps,
                  color: theme.success,
                  label: "kbps",
                },
                {
                  values: state.historyRedisReadsPerSec,
                  color: theme.info,
                  label: "reads/s",
                },
              ],
              {
                min: 0,
                max: redisMax,
                axis: true,
                legend: true,
              },
            );
          });

          grid.panel({ title: "Runner Status Buffers" }, (panel) => {
            panel.keyValues([
              {
                label: "pending_success",
                value: String(status?.pendingSuccessBuffer ?? 0),
              },
              {
                label: "pending_error",
                value: String(status?.pendingErrorBuffer ?? 0),
              },
              {
                label: "flush_batches",
                value: String(status?.flushBatchCount ?? 0),
              },
              {
                label: "last_flush",
                value: status?.lastFlushAt || "-",
              },
              {
                label: "op",
                value: status?.operationId || "none",
              },
              {
                label: "updated",
                value: status?.updatedAt || "-",
              },
            ]);
          });
        },
      );
    }

    if (state.activeScreen === "redis") {
      const aggregate = state.redisIoAggregate;
      const instances = state.redisIoInstances;
      const aggregateMax = Math.max(
        1,
        ...state.historyRedisAggregateKbps,
        aggregate.redisWireKbps,
      );
      const influenceRows = instances.slice(0, 10).map((instance) => ({
        label: `pid_${instance.pid}_${shortInstance(instance.instanceId)}`,
        value:
          `wire=${formatBitrateFromKbps(instance.redisWireKbps)} ` +
          `rx=${formatBitrateFromKbps(instance.redisIngressKbps)} ` +
          `tx=${formatBitrateFromKbps(instance.redisEgressKbps)} ` +
          `r=${instance.redisIngressReads} w=${instance.redisEgressWrites}`,
      }));

      if (influenceRows.length === 0) {
        influenceRows.push({
          label: "influences",
          value: "no active instance stats published yet",
        });
      }

      ui.grid(
        { columns: ["1fr", "1fr"], rows: [8, 12, 12], gap: 1 },
        (grid) => {
          grid.panel({ title: "Redis Aggregate" }, (panel) => {
            panel.keyValues([
              { label: "screen", value: currentScreenLabel },
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

          grid.panel({ title: "Influence Breakdown" }, (panel) => {
            panel.keyValues(influenceRows);
          });

          grid.panel({ title: "Aggregate Redis Wire KB/s Trend" }, (panel) => {
            panel.graph({
              values: state.historyRedisAggregateKbps,
              min: 0,
              max: aggregateMax,
              axis: true,
              color: theme.info,
            });
          });

          grid.panel({ title: "Local Module I/O" }, (panel) => {
            panel.keyValues([
              {
                label: "local_wire",
                value: formatBitrateFromKbps(state.redisIo.redisWireKbps),
              },
              {
                label: "local_rx",
                value: formatBitrateFromKbps(state.redisIo.redisIngressKbps),
              },
              {
                label: "local_tx",
                value: formatBitrateFromKbps(state.redisIo.redisEgressKbps),
              },
              {
                label: "local_reads",
                value: String(state.redisIo.redisIngressReads),
              },
              {
                label: "local_writes",
                value: String(state.redisIo.redisEgressWrites),
              },
              {
                label: "last_read",
                value: state.redisIo.lastReadAt || "-",
              },
              {
                label: "last_write",
                value: state.redisIo.lastWriteAt || "-",
              },
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
          modal.text("Keys: 1 summary, 2 queues, 3 workers, 4 redis");
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
        { key: "1/2/3/4", label: "Screens" },
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
  void (async () => {
    const preloadProjection = await preloadProjectionPromise;
    if (!state.running || preloadProjection.sampleCount <= 0) {
      return;
    }
    if (
      state.historyBacklog.length === 0 &&
      preloadProjection.queueBacklogTrendSmoothed.length > 0
    ) {
      state.historyBacklog = [...preloadProjection.queueBacklogTrendSmoothed];
    }
    if (
      state.historyProcessed.length === 0 &&
      preloadProjection.processedItemsTrend.length > 0
    ) {
      state.historyProcessed = [...preloadProjection.processedItemsTrend];
    }
    if (
      state.historyFailures.length === 0 &&
      preloadProjection.failedItemsTrend.length > 0
    ) {
      state.historyFailures = [...preloadProjection.failedItemsTrend];
    }
    if (
      state.historyIps.length === 0 &&
      preloadProjection.ipsSmoothed.length > 0
    ) {
      state.historyIps = [...preloadProjection.ipsSmoothed];
    }
    if (
      state.historyBacklogDeltaPerSec.length === 0 &&
      preloadProjection.backlogDeltaSmoothed.length > 0
    ) {
      state.historyBacklogDeltaPerSec = [
        ...preloadProjection.backlogDeltaSmoothed,
      ];
    }
    if (
      state.lastSampleAtMs === null &&
      preloadProjection.latestAtMs !== null
    ) {
      state.lastSampleAtMs = preloadProjection.latestAtMs;
    }
    const processedTail = preloadProjection.processedItemsTrend;
    state.lastDbProcessed =
      processedTail.length > 0 ? processedTail[processedTail.length - 1] : null;
    const backlogTail = preloadProjection.queueBacklogTrendRaw;
    state.lastBacklog =
      backlogTail.length > 0 ? backlogTail[backlogTail.length - 1] : null;
    state.notice = "trend history loaded";
    app.invalidate();
  })();

  void refresh();

  state.notice = "connecting to module watcher...";
  app.invalidate();
  void (async () => {
    uiStateWatcher = await createOpsUiStateWatcher({
      appName: state.appName,
      profile: "cli",
      snapshotTimeoutMs: 8000,
      minRefreshIntervalMs: 1000,
      fallbackRefreshIntervalMs: state.intervalMs,
    }).catch(() => null);
    if (!state.running) {
      return;
    }
    state.notice = uiStateWatcher
      ? "reactive watcher connected"
      : "watcher unavailable; using timed refresh";
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
        const signal = await uiStateWatcher.waitForState(1000);
        if (signal === "state") {
          needsRefresh = true;
        } else {
          const elapsedSinceRefresh =
            Date.now() - Math.max(0, lastRefreshCompletedAtMs);
          needsRefresh = elapsedSinceRefresh >= state.intervalMs;
        }
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
