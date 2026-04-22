import { spawnSync } from "node:child_process";

const DEFAULT_CONTAINER_NAME = "beachhouse-meilisearch";
const DEFAULT_IMAGE = "getmeili/meilisearch:latest";
const DEFAULT_PORT = 7700;
const DEFAULT_MASTER_KEY = "beachhouse-local-meili-master-key";
const DEFAULT_TIMEOUT_MS = 30_000;

type CommandOptions = {
  containerName: string;
  image: string;
  port: number;
  masterKey: string;
  timeoutMs: number;
};

type ParsedArgs = {
  action: "start" | "stop" | "status";
  options: CommandOptions;
};

function printUsage(): void {
  console.log("Manage local Meilisearch Docker container");
  console.log("Usage:");
  console.log(
    "  tsx src/lib/scripts/run-meilisearch-container.ts <start|stop|status> [--container-name <name>] [--image <image>] [--port <port>] [--master-key <key>] [--timeout-ms <ms>]",
  );
  console.log("");
  console.log("Examples:");
  console.log(
    "  tsx src/lib/scripts/run-meilisearch-container.ts start --port 7700",
  );
  console.log("  tsx src/lib/scripts/run-meilisearch-container.ts stop");
}

function parseArgs(argv: string[]): ParsedArgs {
  let action: ParsedArgs["action"] | null = null;
  let containerName = DEFAULT_CONTAINER_NAME;
  let image = DEFAULT_IMAGE;
  let port = DEFAULT_PORT;
  let masterKey = DEFAULT_MASTER_KEY;
  let timeoutMs = DEFAULT_TIMEOUT_MS;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }

    if (!action && (arg === "start" || arg === "stop" || arg === "status")) {
      action = arg;
      continue;
    }

    if (arg === "--container-name" && next) {
      containerName = next.trim();
      index += 1;
      continue;
    }

    if (arg === "--image" && next) {
      image = next.trim();
      index += 1;
      continue;
    }

    if (arg === "--port" && next) {
      const parsed = Number(next);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("--port must be a positive integer");
      }
      port = Math.floor(parsed);
      index += 1;
      continue;
    }

    if (arg === "--master-key" && next) {
      masterKey = next;
      index += 1;
      continue;
    }

    if (arg === "--timeout-ms" && next) {
      const parsed = Number(next);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("--timeout-ms must be a positive integer");
      }
      timeoutMs = Math.floor(parsed);
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!action) {
    throw new Error("Missing action: start|stop|status");
  }

  return {
    action,
    options: {
      containerName,
      image,
      port,
      masterKey,
      timeoutMs,
    },
  };
}

function runDockerCommand(args: string[]): string {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    throw new Error(`docker command failed: ${result.error.message}`);
  }

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || "unknown docker error";
    throw new Error(`docker ${args.join(" ")} failed: ${stderr}`);
  }

  return (result.stdout || "").trim();
}

function getContainerState(containerName: string): {
  exists: boolean;
  running: boolean;
} {
  const output = runDockerCommand([
    "ps",
    "-a",
    "--filter",
    `name=^/${containerName}$`,
    "--format",
    "{{.Status}}",
  ]);

  if (!output) {
    return { exists: false, running: false };
  }

  const running = output.toLowerCase().startsWith("up ");
  return { exists: true, running };
}

async function waitForHealthy(port: number, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  const healthUrl = `http://127.0.0.1:${port}/health`;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(healthUrl);
      if (response.ok) {
        console.log(`Meilisearch health check OK at ${healthUrl}`);
        return;
      }
    } catch {
      // Keep retrying until timeout.
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(
    `Meilisearch did not become healthy within ${timeoutMs}ms (checked /health on port ${port}).`,
  );
}

async function startContainer(options: CommandOptions): Promise<void> {
  const state = getContainerState(options.containerName);

  if (!state.exists) {
    console.log(
      `Creating container ${options.containerName} from ${options.image} on port ${options.port}...`,
    );
    runDockerCommand([
      "run",
      "-d",
      "--name",
      options.containerName,
      "-p",
      `${options.port}:7700`,
      "-e",
      `MEILI_MASTER_KEY=${options.masterKey}`,
      "-e",
      "MEILI_NO_ANALYTICS=true",
      options.image,
    ]);
  } else if (!state.running) {
    console.log(`Starting existing container ${options.containerName}...`);
    runDockerCommand(["start", options.containerName]);
  } else {
    console.log(`Container ${options.containerName} is already running.`);
  }

  await waitForHealthy(options.port, options.timeoutMs);

  console.log("Meilisearch is ready.");
  console.log(`- container: ${options.containerName}`);
  console.log(`- port: ${options.port}`);
  console.log("- health: /health -> 200");
}

function stopContainer(options: CommandOptions): void {
  const state = getContainerState(options.containerName);
  if (!state.exists) {
    console.log(`Container ${options.containerName} does not exist.`);
    return;
  }

  if (!state.running) {
    console.log(`Container ${options.containerName} is already stopped.`);
    return;
  }

  runDockerCommand(["stop", options.containerName]);
  console.log(`Stopped container ${options.containerName}.`);
}

function printStatus(options: CommandOptions): void {
  const state = getContainerState(options.containerName);
  console.log("meilisearch_container_status");
  console.log(`- container: ${options.containerName}`);
  console.log(`- exists: ${state.exists}`);
  console.log(`- running: ${state.running}`);
  console.log(`- mapped_port: ${options.port}`);
}

async function run(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.action === "start") {
    await startContainer(parsed.options);
    return 0;
  }

  if (parsed.action === "stop") {
    stopContainer(parsed.options);
    return 0;
  }

  printStatus(parsed.options);
  return 0;
}

run()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`meilisearch container command failed: ${message}`);
    process.exit(1);
  });
