const FLY_GRAPHQL_URL = "https://api.fly.io/graphql";

export type FlyMachine = {
  id: string;
  name: string;
  state: string;
  region: string;
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

async function postFlyGraphql<TData>(
  input: {
    query: string;
    variables?: Record<string, unknown>;
  },
  token: string,
): Promise<TData> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

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
      throw new Error(`fly api status ${response.status}`);
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
  return fetchFlyMachinesViaApi(app, requireFlyApiToken());
}

export async function scaleFlyWorkers(
  app: string,
  count: number,
): Promise<string> {
  const token = requireFlyApiToken();
  const targetCount = Math.max(0, Math.floor(count));
  const attempts: Array<{
    name: string;
    query: string;
    variables: Record<string, unknown>;
  }> = [
    {
      name: "scaleApp:processGroup",
      query:
        "mutation ScaleApp($appName: String!, $processGroup: String!, $count: Int!) { scaleApp(input: { appName: $appName, processGroup: $processGroup, count: $count }) { app { name } } }",
      variables: {
        appName: app,
        processGroup: "worker",
        count: targetCount,
      },
    },
    {
      name: "setVmCount:group",
      query:
        "mutation SetVmCount($appName: String!, $group: String!, $count: Int!) { setVmCount(input: { appName: $appName, group: $group, count: $count }) { app { name } } }",
      variables: {
        appName: app,
        group: "worker",
        count: targetCount,
      },
    },
    {
      name: "setVmCount:processGroup",
      query:
        "mutation SetVmCount($appName: String!, $processGroup: String!, $count: Int!) { setVmCount(input: { appName: $appName, processGroup: $processGroup, count: $count }) { app { name } } }",
      variables: {
        appName: app,
        processGroup: "worker",
        count: targetCount,
      },
    },
  ];

  let lastError: Error | null = null;
  for (const attempt of attempts) {
    try {
      await postFlyGraphql(attempt, token);
      return `scaled app=${app} process_group=worker target=${targetCount} via=${attempt.name}`;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw new Error(
    `failed to scale workers via Fly API for app=${app}: ${lastError?.message || "unknown error"}`,
  );
}
