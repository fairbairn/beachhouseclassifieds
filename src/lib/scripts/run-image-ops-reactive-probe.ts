import "@/core/tooling/env/load-env-profile";

import {
  createOpsStateUpdatesSubscriber,
  createOpsUiStateWatcher,
  type OpsReactiveProfile,
  type OpsUiSnapshot,
} from "@/lib/workers/image-ops-control-module";

const DEFAULT_APP = "beachhouseclassifieds-image-worker";

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(raw || "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseArgs(argv: string[]): {
  appName: string;
  durationSeconds: number;
  waitMs: number;
  fallbackMs: number;
  profile: OpsReactiveProfile;
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
      continue;
    }
    options.set(key, "true");
  }

  const profileRaw = String(options.get("profile") || "cli")
    .trim()
    .toLowerCase();

  return {
    appName: options.get("app")?.trim() || DEFAULT_APP,
    durationSeconds: parsePositiveInt(options.get("duration-seconds"), 20),
    waitMs: parsePositiveInt(options.get("wait-ms"), 1000),
    fallbackMs: parsePositiveInt(options.get("fallback-ms"), 5000),
    profile: profileRaw === "runner-lite" ? "runner-lite" : "cli",
  };
}

function snapshotVersion(snapshot: OpsUiSnapshot | null): string {
  if (!snapshot) {
    return "none";
  }
  const statusUpdated = snapshot.status?.updatedAt || "none";
  const infraUpdated = snapshot.infra?.updatedAt || "none";
  const projectionUpdated = String(snapshot.projections.latestAtMs || 0);
  const queueBacklog = String(snapshot.queue?.backlog ?? -1);
  return [statusUpdated, infraUpdated, projectionUpdated, queueBacklog].join(
    "|",
  );
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const startedAtMs = Date.now();
  const endAtMs = startedAtMs + args.durationSeconds * 1000;

  const watcher = await createOpsUiStateWatcher({
    appName: args.appName,
    profile: args.profile,
    minRefreshIntervalMs: 1000,
    fallbackRefreshIntervalMs: args.fallbackMs,
  });
  const signalSubscriber = await createOpsStateUpdatesSubscriber();

  let lastVersion = snapshotVersion(watcher.getSnapshot());
  let stateEvents = 0;
  let timeoutEvents = 0;
  let changedEvents = 0;
  let rawSignals = 0;

  process.stdout.write(
    `reactive_probe_start app=${args.appName} profile=${args.profile} duration_s=${args.durationSeconds} wait_ms=${args.waitMs} fallback_ms=${args.fallbackMs}\n`,
  );

  try {
    while (Date.now() < endAtMs) {
      const rawSignal = await signalSubscriber.waitForUpdate(1);
      if (rawSignal === "message") {
        rawSignals += 1;
      }

      const stateResult = await watcher.waitForState(args.waitMs);
      if (stateResult === "state") {
        stateEvents += 1;
      } else {
        timeoutEvents += 1;
      }

      const snapshot = watcher.getSnapshot();
      const nextVersion = snapshotVersion(snapshot);
      const changed = nextVersion !== lastVersion;
      if (changed) {
        changedEvents += 1;
      }
      lastVersion = nextVersion;

      const nowIso = new Date().toISOString();
      const projectionLatest = snapshot?.projections.latestAtMs ?? null;
      const runnerUpdated = snapshot?.status?.updatedAt ?? null;
      const backlog = snapshot?.queue?.backlog ?? null;

      process.stdout.write(
        `${nowIso} state=${stateResult} raw_signal=${rawSignal} changed=${String(changed)} backlog=${String(backlog)} projection_latest_ms=${String(projectionLatest)} runner_updated_at=${String(runnerUpdated)}\n`,
      );
    }

    process.stdout.write(
      `reactive_probe_summary state_events=${stateEvents} timeout_events=${timeoutEvents} changed_events=${changedEvents} raw_signals=${rawSignals}\n`,
    );
    return 0;
  } finally {
    await watcher.close();
    await signalSubscriber.close();
  }
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`run-image-ops-reactive-probe failed: ${message}\n`);
    process.exit(1);
  });
