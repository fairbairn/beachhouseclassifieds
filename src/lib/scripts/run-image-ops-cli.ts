import "@/core/tooling/env/load-env-profile";

import { execFile } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";

import { Queue } from "bullmq";
import chalk from "chalk";
import Table from "cli-table3";
import { Pool } from "pg";

import {
  IMAGE_QUEUE_NAME,
  createRedisConnection,
} from "../../workers/image-queue";
import {
  readRunnerControlSettings,
  readRunnerStatus,
  writeRunnerControlSettings,
  type RunnerControlSettings,
  type RunnerStatusSnapshot,
} from "../workers/image-runner-control";

const execFileAsync = promisify(execFile);
const DEFAULT_APP = "beachhouseclassifieds-image-worker";

type Command =
  | "dashboard"
  | "fly-scale"
  | "fly-stop-all"
  | "fly-status"
  | "control-show"
  | "control-set"
  | "help";

type ParsedArgs = {
  command: Command;
  options: Map<string, string>;
  flags: Set<string>;
};

type FlyMachine = {
  id: string;
  name: string;
  state: string;
  region: string;
};

type QueueCounts = {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: number;
  backlog: number;
};

type DbProgress = {
  processed: number;
  pending: number;
  total: number;
  pct: number;
} | null;

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
  machines: FlyMachine[] | null;
  queue: QueueCounts | null;
  db: DbProgress;
  settings: RunnerControlSettings | null;
  status: RunnerStatusSnapshot | null;
  errors: {
    fly?: string;
    queue?: string;
    db?: string;
    control?: string;
  };
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
    "  npm run workers:image:ops -- dashboard [--watch] [--top] [--interval-seconds 3] [--app <flyApp>]",
    "      top watch keys: q quit, h help, s settings, + faster, - slower, r reset trends",
    "  npm run workers:image:ops -- fly-scale --count <n> [--app <flyApp>]",
    "  npm run workers:image:ops -- fly-stop-all [--app <flyApp>]",
    "  npm run workers:image:ops -- fly-status [--app <flyApp>]",
    "  npm run workers:image:ops -- control-show",
    "  npm run workers:image:ops -- control-set [--flush-interval-ms <n>] [--harvest-enabled true|false]",
  ].join("\n");
}

function parseArgs(argv: string[]): ParsedArgs {
  const raw = (argv[0] || "help").trim().toLowerCase();
  const command: Command =
    raw === "dashboard" ||
    raw === "fly-scale" ||
    raw === "fly-stop-all" ||
    raw === "fly-status" ||
    raw === "control-show" ||
    raw === "control-set"
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runFlyctl(args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync("flyctl", args, {
    maxBuffer: 2 * 1024 * 1024,
  });
  return `${stdout || ""}${stderr || ""}`;
}

async function fetchFlyMachines(app: string): Promise<FlyMachine[]> {
  try {
    const output = await runFlyctl(["machines", "list", "-a", app, "--json"]);
    const parsed = JSON.parse(output) as FlyMachine[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function fetchQueueCounts(): Promise<QueueCounts> {
  const connection = createRedisConnection();
  const queue = new Queue(IMAGE_QUEUE_NAME, { connection });
  try {
    const counts = await queue.getJobCounts(
      "waiting",
      "active",
      "completed",
      "failed",
      "delayed",
      "paused",
    );
    const waiting = counts.waiting || 0;
    const active = counts.active || 0;
    const delayed = counts.delayed || 0;
    return {
      waiting,
      active,
      completed: counts.completed || 0,
      failed: counts.failed || 0,
      delayed,
      paused: counts.paused || 0,
      backlog: waiting + active + delayed,
    };
  } finally {
    await queue.close();
    await connection.quit();
  }
}

async function fetchDbProgress(): Promise<DbProgress> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    return null;
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  try {
    const [{ rows: processedRows }, { rows: pendingRows }] = await Promise.all([
      pool.query<{ count: string }>(
        "select count(*)::bigint as count from listing_source_image where status = 'processed_site'",
      ),
      pool.query<{ count: string }>(
        `select count(*)::bigint as count
         from listing_source_image lsi
         join listing_source_link lsl on lsl.id = lsi.source_link_id
         where lsi.site_image is null
           and coalesce(lsi.source_image_url, '') <> ''
           and lsl.source_status = 'active'
           and lsl.active_to is null`,
      ),
    ]);

    const processed = Number(processedRows[0]?.count || 0);
    const pending = Number(pendingRows[0]?.count || 0);
    const total = processed + pending;

    return {
      processed,
      pending,
      total,
      pct: total > 0 ? (processed / total) * 100 : 0,
    };
  } finally {
    await pool.end();
  }
}

async function fetchControlSnapshot(): Promise<{
  settings: RunnerControlSettings;
  status: RunnerStatusSnapshot | null;
}> {
  const connection = createRedisConnection();
  try {
    const settings = await readRunnerControlSettings(connection);
    const status = await readRunnerStatus(connection);
    return { settings, status };
  } finally {
    await connection.quit();
  }
}

async function gatherDashboardSnapshot(
  app: string,
): Promise<DashboardSnapshot> {
  const [machinesResult, queueResult, dbResult, controlResult] =
    await Promise.allSettled([
      fetchFlyMachines(app),
      fetchQueueCounts(),
      fetchDbProgress(),
      fetchControlSnapshot(),
    ]);

  return {
    machines:
      machinesResult.status === "fulfilled" ? machinesResult.value : null,
    queue: queueResult.status === "fulfilled" ? queueResult.value : null,
    db: dbResult.status === "fulfilled" ? dbResult.value : null,
    settings:
      controlResult.status === "fulfilled"
        ? controlResult.value.settings
        : null,
    status:
      controlResult.status === "fulfilled" ? controlResult.value.status : null,
    errors: {
      fly:
        machinesResult.status === "rejected"
          ? shortError(machinesResult.reason)
          : undefined,
      queue:
        queueResult.status === "rejected"
          ? shortError(queueResult.reason)
          : undefined,
      db:
        dbResult.status === "rejected"
          ? shortError(dbResult.reason)
          : undefined,
      control:
        controlResult.status === "rejected"
          ? shortError(controlResult.reason)
          : undefined,
    },
  };
}

async function panelFly(app: string): Promise<void> {
  const machines = await fetchFlyMachines(app);
  const byState = new Map<string, number>();
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

  process.stdout.write(chalk.cyan(`Fly App: ${app}\n`));
  process.stdout.write(`${table.toString()}\n`);
  process.stdout.write(chalk.gray(`total_machines=${machines.length}\n`));
}

async function panelQueue(): Promise<void> {
  const counts = await fetchQueueCounts();
  const table = new Table({
    head: [
      "Queue",
      "Waiting",
      "Active",
      "Completed",
      "Failed",
      "Delayed",
      "Paused",
      "Backlog",
    ],
    style: { head: ["cyan"] },
  });
  table.push([
    IMAGE_QUEUE_NAME,
    counts.waiting,
    counts.active,
    counts.completed,
    counts.failed,
    counts.delayed,
    counts.paused,
    counts.backlog,
  ]);
  process.stdout.write(`${table.toString()}\n`);
}

async function panelDb(): Promise<void> {
  const snapshot = await fetchDbProgress();
  if (!snapshot) {
    process.stdout.write(
      chalk.yellow("DATABASE_URL missing; DB panel skipped\n"),
    );
    return;
  }

  const table = new Table({
    head: ["Processed", "Pending", "Total", "Progress %"],
    style: { head: ["cyan"] },
  });
  table.push([
    snapshot.processed,
    snapshot.pending,
    snapshot.total,
    snapshot.pct.toFixed(2),
  ]);
  process.stdout.write(`${table.toString()}\n`);
}

async function panelControl(): Promise<void> {
  const { settings, status } = await fetchControlSnapshot();

  const settingsTable = new Table({
    head: ["Control Setting", "Value"],
    style: { head: ["cyan"] },
  });
  settingsTable.push(
    ["flush_interval_ms", settings.flushIntervalMs],
    ["harvest_enabled", settings.harvestEnabled],
  );
  process.stdout.write(`${settingsTable.toString()}\n`);

  if (!status) {
    process.stdout.write(
      chalk.yellow("No runner status has been published yet\n"),
    );
    return;
  }

  const statusTable = new Table({
    head: ["Runner Metric", "Value"],
    style: { head: ["cyan"] },
  });
  statusTable.push(
    ["operation_id", status.operationId],
    ["mode", status.mode],
    ["claimed_count", status.claimedCount],
    ["queued_count", status.queuedCount],
    ["completed_jobs", status.completedJobs],
    ["failed_jobs", status.failedJobs],
    ["processed_items", status.processedItems],
    ["failed_items", status.failedItems],
    ["queue_waiting", status.queueWaiting],
    ["queue_active", status.queueActive],
    ["queue_completed", status.queueCompleted],
    ["queue_failed", status.queueFailed],
    ["queue_delayed", status.queueDelayed],
    ["queue_paused", status.queuePaused],
    ["queue_backlog", status.queueBacklog],
    ["pending_success_buffer", status.pendingSuccessBuffer],
    ["pending_error_buffer", status.pendingErrorBuffer],
    ["last_flush_at", status.lastFlushAt || "-"],
    ["updated_at", status.updatedAt],
  );
  process.stdout.write(`${statusTable.toString()}\n`);
}

function renderTopLikeDashboard(params: {
  app: string;
  watch: boolean;
  ui: TopUiState;
  snapshot: DashboardSnapshot;
}): void {
  const { app, watch, ui, snapshot } = params;
  const { intervalSeconds, samples } = ui;
  const byState = new Map<string, number>();
  for (const machine of snapshot.machines || []) {
    const state = String(machine.state || "unknown").toLowerCase();
    byState.set(state, (byState.get(state) || 0) + 1);
  }

  const status = snapshot.status;
  const latest = samples[samples.length - 1] || null;
  const previous = samples.length > 1 ? samples[samples.length - 2] : null;

  let ratePerMin = 0;
  if (
    latest &&
    previous &&
    latest.processedItems >= previous.processedItems &&
    latest.atMs > previous.atMs
  ) {
    const deltaItems = latest.processedItems - previous.processedItems;
    const deltaSeconds = (latest.atMs - previous.atMs) / 1000;
    if (deltaSeconds > 0) {
      ratePerMin = (deltaItems / deltaSeconds) * 60;
    }
  }

  const backlogTrend = renderTrend(
    samples.map((sample) => sample.queueBacklog),
  );
  const processedTrend = renderTrend(
    samples.map((sample) => sample.processedItems),
  );
  const failedTrend = renderTrend(samples.map((sample) => sample.failedItems));

  const machineStates = [...byState.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([stateName, count]) => `${stateName}:${count}`)
    .join(" ");

  process.stdout.write(chalk.bold.cyan("Image Control Tower (top mode)\n"));
  process.stdout.write(chalk.gray(`${new Date().toISOString()}\n`));
  process.stdout.write(
    chalk.gray(
      `watch=${watch} interval=${intervalSeconds}s samples=${samples.length} app=${app}\n\n`,
    ),
  );

  if (ui.notice) {
    process.stdout.write(chalk.yellow(`notice: ${ui.notice}\n\n`));
  }

  if (ui.showHelp) {
    process.stdout.write(
      chalk.gray(
        "keys: q quit | h toggle-help | s settings prompt | + faster refresh | - slower refresh | r reset trends\n\n",
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
      `flush_interval_ms=${snapshot.settings.flushIntervalMs} harvest_enabled=${snapshot.settings.harvestEnabled}\n\n`,
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
      `queue waiting=${snapshot.queue.waiting} active=${snapshot.queue.active} delayed=${snapshot.queue.delayed} paused=${snapshot.queue.paused} backlog=${snapshot.queue.backlog}\n`,
    );
    process.stdout.write(
      `queue totals completed=${snapshot.queue.completed} failed=${snapshot.queue.failed}\n`,
    );
    process.stdout.write(`queue backlog trend  ${backlogTrend}\n`);
  }
  process.stdout.write("\n");

  process.stdout.write(chalk.bold("Progress\n"));
  if (!status) {
    process.stdout.write("runner_status=none\n");
  } else {
    process.stdout.write(
      `operation=${status.operationId} mode=${status.mode} updated_at=${status.updatedAt}\n`,
    );
    process.stdout.write(
      `jobs completed=${status.completedJobs} failed=${status.failedJobs} queued=${status.queuedCount} claimed=${status.claimedCount}\n`,
    );
    process.stdout.write(
      `items processed=${status.processedItems} failed=${status.failedItems} rate=${fixedOne(ratePerMin)} images/min\n`,
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
      `processed=${snapshot.db.processed} pending=${snapshot.db.pending} total=${snapshot.db.total} progress=${snapshot.db.pct.toFixed(2)}%\n`,
    );
  }
}

async function promptTopSettings(ui: TopUiState): Promise<void> {
  const connection = createRedisConnection();
  try {
    const current = await readRunnerControlSettings(connection);
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

      const next = {
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

      await writeRunnerControlSettings(connection, next);
      ui.notice = `settings updated: flush_interval_ms=${next.flushIntervalMs} harvest_enabled=${next.harvestEnabled}`;
    } finally {
      rl.close();
    }
  } finally {
    await connection.quit();
  }
}

function installTopKeyControls(ui: TopUiState): () => void {
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
      ui.intervalSeconds = Math.max(1, ui.intervalSeconds - 1);
      ui.notice = `refresh interval ${ui.intervalSeconds}s`;
      return;
    }

    if (key === "-") {
      ui.intervalSeconds = Math.min(30, ui.intervalSeconds + 1);
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
    3,
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
  if (watch && topMode) {
    teardownTopKeys = installTopKeyControls(ui);
  }

  try {
    while (ui.running) {
      clearScreen();
      if (topMode) {
        const snapshot = await gatherDashboardSnapshot(app);
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
        });
      } else {
        process.stdout.write(chalk.bold.cyan("Image Control Tower\n"));
        process.stdout.write(chalk.gray(`${new Date().toISOString()}\n\n`));

        try {
          await panelFly(app);
        } catch (error) {
          process.stdout.write(
            `${chalk.yellow("Fly panel unavailable")}: ${shortError(error)}\n`,
          );
        }
        process.stdout.write("\n");
        try {
          await panelQueue();
        } catch (error) {
          process.stdout.write(
            `${chalk.yellow("Queue panel unavailable")}: ${shortError(error)}\n`,
          );
        }
        process.stdout.write("\n");
        try {
          await panelDb();
        } catch (error) {
          process.stdout.write(
            `${chalk.yellow("DB panel unavailable")}: ${shortError(error)}\n`,
          );
        }
        process.stdout.write("\n");
        try {
          await panelControl();
        } catch (error) {
          process.stdout.write(
            `${chalk.yellow("Control panel unavailable")}: ${shortError(error)}\n`,
          );
        }
      }

      if (!watch) {
        ui.running = false;
        continue;
      }

      await sleep(Math.max(1, ui.intervalSeconds) * 1000);
    }
  } finally {
    teardownTopKeys();
  }
}

async function runFlyScale(args: ParsedArgs): Promise<void> {
  const countRaw = args.options.get("count");
  if (!countRaw) {
    throw new Error("Missing --count for fly-scale");
  }
  const count = parsePositiveInt(countRaw, -1);
  if (count < 0) {
    throw new Error(`Invalid --count: ${countRaw}`);
  }

  const output = await runFlyctl([
    "scale",
    "count",
    String(count),
    "--process-group",
    "worker",
    "-a",
    appName(args.options),
    "--yes",
  ]);
  process.stdout.write(output);
}

async function runFlyStopAll(args: ParsedArgs): Promise<void> {
  const output = await runFlyctl([
    "scale",
    "count",
    "0",
    "--process-group",
    "worker",
    "-a",
    appName(args.options),
    "--yes",
  ]);
  process.stdout.write(output);
}

async function runControlSet(args: ParsedArgs): Promise<void> {
  const flushIntervalRaw = args.options.get("flush-interval-ms");
  const harvestEnabledRaw = args.options.get("harvest-enabled");
  if (!flushIntervalRaw && harvestEnabledRaw === undefined) {
    throw new Error(
      "control-set requires --flush-interval-ms and/or --harvest-enabled",
    );
  }

  const connection = createRedisConnection();
  try {
    const current = await readRunnerControlSettings(connection);
    const next = {
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

    await writeRunnerControlSettings(connection, next);
    process.stdout.write(
      `${chalk.green("control settings updated")} flush_interval_ms=${next.flushIntervalMs} harvest_enabled=${next.harvestEnabled}\n`,
    );
  } finally {
    await connection.quit();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case "dashboard":
      await runDashboard(args);
      return;
    case "fly-scale":
      await runFlyScale(args);
      return;
    case "fly-stop-all":
      await runFlyStopAll(args);
      return;
    case "fly-status":
      await panelFly(appName(args.options));
      return;
    case "control-show":
      await panelControl();
      return;
    case "control-set":
      await runControlSet(args);
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
