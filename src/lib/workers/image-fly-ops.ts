const FLY_GRAPHQL_URL = "https://api.fly.io/graphql";
const FLY_MACHINES_API_BASE = "https://api.machines.dev/v1";

export type FlyMachine = {
  id: string;
  name: string;
  state: string;
  region: string;
};

export type FlyAppSnapshot = {
  appId: string;
  appName: string;
  machines: FlyMachine[];
};

type FlyGraphqlMachineNode = {
  id?: unknown;
  name?: unknown;
  state?: unknown;
  region?: unknown;
};

type FlyGraphqlResponse<TData> = {
  data?: TData;
  errors?: Array<{ message?: string }>;
};

type FlyMachineApiRecord = {
  id?: unknown;
  name?: unknown;
  state?: unknown;
  region?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  image_ref?: unknown;
  image?: unknown;
  config?: {
    env?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    image?: unknown;
    services?: unknown;
    mounts?: unknown;
    checks?: unknown;
    restart?: unknown;
    stop_config?: unknown;
    guest?: unknown;
    init?: unknown;
  } | null;
};

function flyApiToken(): string {
  return (
    process.env.FLY_TOKEN?.trim() || process.env.FLY_API_TOKEN?.trim() || ""
  );
}

function requireFlyApiToken(): string {
  const token = flyApiToken();
  if (!token) {
    throw new Error("Missing FLY_TOKEN or FLY_API_TOKEN for Fly API access");
  }
  return token;
}

function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return fallback;
  }
  return String(value);
}

async function fetchFlyMachinesViaApi(
  app: string,
  token: string,
): Promise<FlyMachine[]> {
  const data = await postFlyGraphql<{
    app?: {
      machines?: {
        nodes?: FlyGraphqlMachineNode[];
      };
    };
  }>(
    {
      query: `query AppMachines($appName: String!) {\n  app(name: $appName) {\n    machines {\n      nodes {\n        id\n        name\n        state\n        region\n      }\n    }\n  }\n}`,
      variables: {
        appName: app,
      },
    },
    token,
  );

  const nodes = data.app?.machines?.nodes;
  if (!Array.isArray(nodes)) {
    return [];
  }

  return nodes.map((node) => ({
    id: asString(node.id, ""),
    name: asString(node.name, ""),
    state: asString(node.state, "unknown"),
    region: asString(node.region, ""),
  }));
}

function machineProcessGroup(machine: FlyMachineApiRecord): string {
  const metadata = machine.config?.metadata || {};
  const env = machine.config?.env || {};
  const fromMetadata = asString(metadata.fly_process_group, "").trim();
  if (fromMetadata) {
    return fromMetadata;
  }
  const fromEnv = asString(env.FLY_PROCESS_GROUP, "").trim();
  if (fromEnv) {
    return fromEnv;
  }
  return "";
}

async function listFlyMachinesViaRest(
  app: string,
  token: string,
  input?: {
    includeDeleted?: boolean;
  },
): Promise<FlyMachineApiRecord[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);

  try {
    const includeDeleted = input?.includeDeleted === true;
    const query = includeDeleted ? "?include_deleted=true" : "";
    const response = await fetch(
      `${FLY_MACHINES_API_BASE}/apps/${encodeURIComponent(app)}/machines${query}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      const body = (await response.text().catch(() => "")).trim();
      throw new Error(
        `machines api status ${response.status}${body ? ` body=${body.slice(0, 300)}` : ""}`,
      );
    }

    const payload = (await response.json()) as unknown;
    if (!Array.isArray(payload)) {
      throw new Error("machines api returned non-array payload");
    }
    return payload as FlyMachineApiRecord[];
  } finally {
    clearTimeout(timeout);
  }
}

async function destroyFlyMachineViaRest(
  app: string,
  machineId: string,
  token: string,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);

  try {
    const response = await fetch(
      `${FLY_MACHINES_API_BASE}/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(machineId)}?force=true`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      const body = (await response.text().catch(() => "")).trim();
      throw new Error(
        `destroy machine status ${response.status}${body ? ` body=${body.slice(0, 300)}` : ""}`,
      );
    }
  } finally {
    clearTimeout(timeout);
  }
}

function activeWorkerMachines(
  machines: FlyMachineApiRecord[],
): FlyMachineApiRecord[] {
  return machines.filter((machine) => {
    const processGroup = machineProcessGroup(machine).toLowerCase();
    const state = asString(machine.state, "unknown").toLowerCase();
    if (state === "destroyed") {
      return false;
    }
    if (!processGroup) {
      return true;
    }
    return processGroup === "worker";
  });
}

function latestWorkerTemplateMachine(
  machines: FlyMachineApiRecord[],
): FlyMachineApiRecord | null {
  const workerMachines = machines.filter((machine) => {
    const processGroup = machineProcessGroup(machine).toLowerCase();
    return processGroup === "worker" || !processGroup;
  });

  if (workerMachines.length === 0) {
    return null;
  }

  return [...workerMachines].sort((a, b) => {
    const aMs = Date.parse(asString(a.updated_at || a.created_at, "")) || 0;
    const bMs = Date.parse(asString(b.updated_at || b.created_at, "")) || 0;
    return bMs - aMs;
  })[0];
}

async function createFlyMachineViaRest(input: {
  app: string;
  token: string;
  template: FlyMachineApiRecord;
}): Promise<void> {
  const config = input.template.config;
  if (!config) {
    throw new Error("worker template has no config to clone");
  }

  const payload = {
    config,
    region: asString(input.template.region, "iad") || "iad",
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);

  try {
    const response = await fetch(
      `${FLY_MACHINES_API_BASE}/apps/${encodeURIComponent(input.app)}/machines`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      const body = (await response.text().catch(() => "")).trim();
      throw new Error(
        `create machine status ${response.status}${body ? ` body=${body.slice(0, 400)}` : ""}`,
      );
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function unsuspendViaMachinesApi(input: {
  app: string;
  token: string;
  targetCount: number;
}): Promise<string> {
  const machines = await listFlyMachinesViaRest(input.app, input.token, {
    includeDeleted: true,
  });
  const activeWorkers = activeWorkerMachines(machines);
  if (activeWorkers.length >= Math.max(1, input.targetCount)) {
    return `workers already active=${activeWorkers.length}`;
  }

  const template = latestWorkerTemplateMachine(machines);
  if (!template) {
    throw new Error(
      `unable to unsuspend app=${input.app}: no worker template machine found`,
    );
  }

  const needed = Math.max(1, input.targetCount) - activeWorkers.length;
  for (let i = 0; i < needed; i += 1) {
    await createFlyMachineViaRest({
      app: input.app,
      token: input.token,
      template,
    });
  }

  return `unsuspend_requested created_workers=${Math.max(0, needed)}`;
}

async function scaleFlyWorkersToZeroViaMachinesApi(
  app: string,
  token: string,
): Promise<string> {
  const machines = await listFlyMachinesViaRest(app, token);
  const workerMachines = activeWorkerMachines(machines);

  for (const machine of workerMachines) {
    const machineId = asString(machine.id, "").trim();
    if (!machineId) {
      continue;
    }
    await destroyFlyMachineViaRest(app, machineId, token);
  }

  return `scaled app=${app} process_group=worker target=0 via=machines-api-destroy requested_destroy=${workerMachines.length}`;
}

async function downscaleFlyWorkersViaMachinesApi(input: {
  app: string;
  token: string;
  targetCount: number;
}): Promise<string> {
  const machines = await listFlyMachinesViaRest(input.app, input.token);
  const workerMachines = activeWorkerMachines(machines);
  const currentActive = workerMachines.length;

  if (currentActive <= input.targetCount) {
    return (
      `scaled app=${input.app} process_group=worker target=${input.targetCount} ` +
      `via=machines-api-destroy requested_destroy=0 active_workers=${currentActive}`
    );
  }

  const destroyCount = currentActive - input.targetCount;
  const toDestroy = workerMachines.slice(-destroyCount);

  for (const machine of toDestroy) {
    const machineId = asString(machine.id, "").trim();
    if (!machineId) {
      continue;
    }
    await destroyFlyMachineViaRest(input.app, machineId, input.token);
  }

  return (
    `scaled app=${input.app} process_group=worker target=${input.targetCount} ` +
    `via=machines-api-destroy requested_destroy=${toDestroy.length} active_before=${currentActive}`
  );
}

async function fetchFlyAppId(app: string, token: string): Promise<string> {
  const data = await postFlyGraphql<{
    app?: {
      id?: unknown;
      name?: unknown;
    };
  }>(
    {
      query: `query AppIdentity($appName: String!) {\n  app(name: $appName) {\n    id\n    name\n  }\n}`,
      variables: {
        appName: app,
      },
    },
    token,
  );

  const appId = asString(data.app?.id, "").trim();
  if (!appId) {
    throw new Error(`fly app id lookup returned empty for app=${app}`);
  }
  return appId;
}

async function postFlyGraphql<TData>(
  input: {
    query: string;
    variables?: Record<string, unknown>;
  },
  token: string,
): Promise<TData> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch(FLY_GRAPHQL_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
      signal: controller.signal,
    });

    if (!response.ok) {
      let payloadText = "";
      try {
        payloadText = (await response.text()).trim();
      } catch {
        payloadText = "";
      }
      const details = payloadText ? ` body=${payloadText.slice(0, 500)}` : "";
      throw new Error(`fly api status ${response.status}${details}`);
    }

    const payload = (await response.json()) as FlyGraphqlResponse<TData>;

    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
      throw new Error(payload.errors[0]?.message || "fly api graphql error");
    }

    if (!payload.data) {
      throw new Error("fly api returned no data");
    }
    return payload.data;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchFlyMachines(app: string): Promise<FlyMachine[]> {
  const token = requireFlyApiToken();

  // Prefer Machines REST API so output matches operational machine state.
  try {
    const machines = await listFlyMachinesViaRest(app, token);
    return machines.map((machine) => ({
      id: asString(machine.id, ""),
      name: asString(machine.name, ""),
      state: asString(machine.state, "unknown"),
      region: asString(machine.region, ""),
    }));
  } catch {
    // Fall back to GraphQL read path if Machines API is unavailable.
    return fetchFlyMachinesViaApi(app, token);
  }
}

export async function fetchFlyAppSnapshot(
  app: string,
): Promise<FlyAppSnapshot> {
  const token = requireFlyApiToken();
  const [appId, machines] = await Promise.all([
    fetchFlyAppId(app, token),
    fetchFlyMachinesViaApi(app, token),
  ]);

  return {
    appId,
    appName: app,
    machines,
  };
}

export async function scaleFlyWorkers(
  app: string,
  count: number,
): Promise<string> {
  const token = requireFlyApiToken();
  const targetCount = Math.max(0, Math.floor(count));

  if (targetCount === 0) {
    return scaleFlyWorkersToZeroViaMachinesApi(app, token);
  }

  // Downscale via Machines API for deterministic behavior when GraphQL scale mutations are flaky.
  try {
    const activeMachines = activeWorkerMachines(
      await listFlyMachinesViaRest(app, token),
    );
    if (targetCount < activeMachines.length) {
      return downscaleFlyWorkersViaMachinesApi({
        app,
        token,
        targetCount,
      });
    }
  } catch {
    // Fall through to GraphQL attempts when Machines API read is unavailable.
  }

  const appId = await fetchFlyAppId(app, token);
  const machines = await fetchFlyMachinesViaApi(app, token);
  const targetRegion =
    machines.find((machine) => machine.region)?.region || "iad";
  const attempts: Array<{
    name: string;
    query: string;
    variables: Record<string, unknown>;
  }> = [
    {
      name: "scaleApp:appId:regions",
      query:
        "mutation ScaleApp($appId: ID!, $regions: [ScaleRegionInput!]!) { scaleApp(input: { appId: $appId, regions: $regions }) { app { name } } }",
      variables: {
        appId,
        regions: [{ region: targetRegion, count: targetCount }],
      },
    },
    {
      name: "setVmCount:appId:groupCounts:maxPerRegion",
      query:
        "mutation SetVmCount($appId: ID!, $groupCounts: [VMCountInput!]!) { setVmCount(input: { appId: $appId, groupCounts: $groupCounts }) { app { name } } }",
      variables: {
        appId,
        groupCounts: [
          {
            group: "worker",
            count: targetCount,
            maxPerRegion: Math.max(0, targetCount),
          },
        ],
      },
    },
    {
      name: "setVmCount:appId:groupCounts",
      query:
        "mutation SetVmCount($appId: ID!, $groupCounts: [VMCountInput!]!) { setVmCount(input: { appId: $appId, groupCounts: $groupCounts }) { app { name } } }",
      variables: {
        appId,
        groupCounts: [{ group: "worker", count: targetCount }],
      },
    },
  ];

  const runScaleAttempts = async (): Promise<
    | { ok: true; message: string }
    | { ok: false; lastError: Error | null; errors: string[] }
  > => {
    let lastError: Error | null = null;
    const attemptErrors: string[] = [];
    for (const attempt of attempts) {
      try {
        await postFlyGraphql(attempt, token);
        return {
          ok: true,
          message: `scaled app=${app} process_group=worker target=${targetCount} via=${attempt.name}`,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const message = lastError.message;
        attemptErrors.push(`${attempt.name}: ${message}`);
      }
    }
    return {
      ok: false,
      lastError,
      errors: attemptErrors,
    };
  };

  const firstAttempt = await runScaleAttempts();
  if (firstAttempt.ok) {
    return firstAttempt.message;
  }

  const suspendedError = firstAttempt.errors.find(
    (line) =>
      line.includes("currently suspended") &&
      line.includes("Resume before scaling"),
  );

  if (suspendedError) {
    const unsuspendMessage = await unsuspendViaMachinesApi({
      app,
      token,
      targetCount,
    });
    const secondAttempt = await runScaleAttempts();
    if (secondAttempt.ok) {
      return `${secondAttempt.message} ${unsuspendMessage}`;
    }

    const afterUnsuspendMachines = await listFlyMachinesViaRest(app, token);
    const activeAfterUnsuspend = activeWorkerMachines(
      afterUnsuspendMachines,
    ).length;
    if (activeAfterUnsuspend >= targetCount) {
      return (
        `scaled app=${app} process_group=worker target=${targetCount} ` +
        `via=machines-api-unsuspend active_workers=${activeAfterUnsuspend} ${unsuspendMessage}`
      );
    }

    throw new Error(
      `scale retry after unsuspend failed for app=${app}: ${secondAttempt.lastError?.message || "unknown error"}; attempts=${secondAttempt.errors.join(" | ")}`,
    );
  }

  throw new Error(
    `failed to scale workers via Fly API for app=${app}: ${firstAttempt.lastError?.message || "unknown error"}; attempts=${firstAttempt.errors.join(" | ")}`,
  );
}
