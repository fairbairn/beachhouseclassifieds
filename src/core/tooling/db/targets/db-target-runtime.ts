import { planDownstreamCommand } from "@/core/tooling/command-harness/downstream-command-plan";
import { inferExecutionMode } from "@/core/tooling/command-harness/execution-context";
import {
  confirmSensitiveOperation,
  logCommandExecutionContext,
  parseTargetCommandArgs,
  resolveCommandTarget,
  runCommandWithEnvironment,
} from "@/core/tooling/command-harness/run-command-with-target";
import {
  getDatabaseTargetLabel,
  parseDatabaseTarget,
  printDatabaseTargetMenu,
  promptForDatabaseTarget,
  resolveDatabaseTargetEnvironment,
} from "@/core/tooling/db/targets/db-targets";

type RunDbTargetRuntimeContext = {
  mode: string;
  target: string;
  childEnv: NodeJS.ProcessEnv;
  parsedMode: string;
  command: string;
  commandArgs: Array<string>;
};

type RunDbTargetRuntimeOptions = {
  argv: Array<string>;
  usage: string;
  noInteractiveTerminalErrorMessage?: string;
  getAdditionalEnvironment?: (context: {
    mode: string;
    target: string;
    parsedMode: string;
    command: string;
    commandArgs: Array<string>;
  }) => NodeJS.ProcessEnv | undefined;
  getBlockedReason?: (context: RunDbTargetRuntimeContext) => string | null;
  onMissingDatabaseUrl?: (context: { mode: string; target: string }) => void;
};

function logMissingDatabaseUrlWarning(options: {
  mode: string;
  target: string;
}) {
  const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
  const yellow = "\u001b[33m";
  const reset = "\u001b[0m";

  const lines = [
    "",
    "Configuration warning:",
    `- Target ${options.target} is selected for ${options.mode}.`,
    "- Missing DATABASE_URL in the selected profile env file (.env.local/.env.dev/.env.prod).",
    "- Command was not started.",
  ];

  const message = lines.join("\n");

  if (!useColor) {
    console.log(message);
    return;
  }

  console.log(`${yellow}${message}${reset}`);
}

export async function runDbTargetRuntime(options: RunDbTargetRuntimeOptions) {
  const isInteractiveTerminal = process.stdin.isTTY && process.stdout.isTTY;

  const parsed = parseTargetCommandArgs(
    options.argv,
    parseDatabaseTarget,
    options.usage,
  );

  const target = await resolveCommandTarget({
    target: parsed.target,
    mode: parsed.mode,
    isInteractiveTerminal,
    noInteractiveTerminalErrorMessage:
      options.noInteractiveTerminalErrorMessage ??
      "No interactive terminal detected. Use explicit shortcut commands or pass --target <sqlite:local|postgres:local|postgres:dev|postgres:prod>.",
    promptForTarget: async (mode) => {
      console.log(`\nChoose database target for ${mode}:`);
      printDatabaseTargetMenu();
      return promptForDatabaseTarget();
    },
  });

  const targetEnv = resolveDatabaseTargetEnvironment(target);
  const mode = inferExecutionMode(
    parsed.command,
    parsed.commandArgs,
    parsed.mode,
  );

  const childEnv: NodeJS.ProcessEnv = {
    ...targetEnv,
    ...(options.getAdditionalEnvironment?.({
      mode,
      target,
      parsedMode: parsed.mode,
      command: parsed.command,
      commandArgs: parsed.commandArgs,
    }) ?? {}),
  };

  const plannedDownstreamCommand = planDownstreamCommand({
    mode,
    provider: String(childEnv.DATABASE_PROVIDER ?? ""),
    command: parsed.command,
    commandArgs: parsed.commandArgs,
  });

  logCommandExecutionContext({
    mode: parsed.mode,
    command: parsed.command,
    commandArgs: parsed.commandArgs,
    plannedCommand: plannedDownstreamCommand.plannedCommand,
    target,
    targetLabel: getDatabaseTargetLabel(target),
    envProfile: childEnv.APP_ENV_PROFILE,
    databaseProvider: childEnv.DATABASE_PROVIDER,
    databaseUrl: childEnv.DATABASE_URL,
    betterAuthBaseUrl: childEnv.BETTER_AUTH_BASE_URL,
    betterAuthSecret: childEnv.BETTER_AUTH_SECRET,
  });

  const context: RunDbTargetRuntimeContext = {
    mode,
    target,
    childEnv,
    parsedMode: parsed.mode,
    command: parsed.command,
    commandArgs: parsed.commandArgs,
  };

  const blockedReason = options.getBlockedReason?.(context) ?? null;

  if (blockedReason) {
    throw new Error(blockedReason);
  }

  const hasDatabaseUrl = Boolean(childEnv.DATABASE_URL?.trim());
  const isPostgresTarget = childEnv.DATABASE_PROVIDER === "postgres";

  if (isPostgresTarget && !hasDatabaseUrl) {
    (options.onMissingDatabaseUrl ?? logMissingDatabaseUrlWarning)({
      mode,
      target,
    });
    process.exit(1);
  }

  await confirmSensitiveOperation({
    mode,
    isInteractiveTerminal,
  });

  const exitCode = await runCommandWithEnvironment(
    plannedDownstreamCommand.command,
    plannedDownstreamCommand.commandArgs,
    childEnv,
  );

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

export { runDbTargetRuntime as runWithDbTarget };
