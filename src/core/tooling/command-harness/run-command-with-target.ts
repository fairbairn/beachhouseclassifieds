import { spawn } from "node:child_process";
import readline from "node:readline/promises";

import {
  assertExecutionContextOperationalValues,
  buildExecutionContext,
  formatExecutionContextBanner,
} from "@/core/tooling/command-harness/execution-context";

export type ParseTargetFn<TTarget> = (
  value: string | undefined,
) => TTarget | null;

export type ParsedTargetCommandArgs<TTarget> = {
  target: TTarget | null;
  mode: string;
  command: string;
  commandArgs: Array<string>;
};

export function parseTargetCommandArgs<TTarget>(
  argv: Array<string>,
  parseTarget: ParseTargetFn<TTarget>,
  usage: string,
): ParsedTargetCommandArgs<TTarget> {
  let targetValue: string | undefined;
  let mode = "command";
  let commandStartIndex = -1;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--") {
      commandStartIndex = index + 1;
      break;
    }

    if (arg === "--target") {
      const value = argv[index + 1];

      if (!value) {
        throw new Error(usage);
      }

      targetValue = value;
      index += 1;
      continue;
    }

    if (arg === "--mode" || arg === "--label") {
      const value = argv[index + 1];

      if (!value) {
        throw new Error(usage);
      }

      mode = value;
      index += 1;
      continue;
    }
  }

  if (commandStartIndex < 0 || commandStartIndex >= argv.length) {
    throw new Error(usage);
  }

  const command = argv[commandStartIndex];

  if (!command) {
    throw new Error(usage);
  }

  const parsedTarget = parseTarget(targetValue);

  if (targetValue && !parsedTarget) {
    throw new Error(`Invalid --target '${targetValue}'.`);
  }

  return {
    target: parsedTarget,
    mode,
    command,
    commandArgs: argv.slice(commandStartIndex + 1),
  };
}

export async function resolveCommandTarget<TTarget>(options: {
  target: TTarget | null;
  mode: string;
  isInteractiveTerminal: boolean;
  noInteractiveTerminalErrorMessage: string;
  promptForTarget: (mode: string) => Promise<TTarget | null>;
}): Promise<TTarget> {
  if (options.target) {
    return options.target;
  }

  if (!options.isInteractiveTerminal) {
    throw new Error(options.noInteractiveTerminalErrorMessage);
  }

  let selected: TTarget | null;

  try {
    selected = await options.promptForTarget(options.mode);
  } catch (error) {
    const abortLikeError =
      error instanceof Error &&
      (error.name === "AbortError" ||
        ("code" in error &&
          ((error as { code?: string }).code === "ABORT_ERR" ||
            (error as { code?: string }).code === "ERR_USE_AFTER_CLOSE")));

    if (abortLikeError) {
      console.log("\nSelection cancelled.");
      process.exit(130);
    }

    throw error;
  }

  if (!selected) {
    console.log("No target selected. Exiting.");
    process.exit(0);
  }

  return selected;
}

export function runCommandWithEnvironment(
  command: string,
  commandArgs: Array<string>,
  environment: NodeJS.ProcessEnv,
) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      stdio: "inherit",
      env: {
        ...process.env,
        ...environment,
      },
    });

    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

function requiresOperationConfirmation(mode: string) {
  const normalizedMode = mode.trim().toLowerCase();
  return (
    normalizedMode === "db:setup" ||
    normalizedMode === "db:seed" ||
    normalizedMode === "db:migrate"
  );
}

async function promptYesNoConfirmation(promptText: string) {
  const prompt = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const handleSigint = () => {
    const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
    const reset = "\u001b[0m";
    const yellow = "\u001b[33m";
    console.log(
      useColor
        ? `\n${yellow}Operation cancelled.${reset}`
        : "\nOperation cancelled.",
    );
    process.exit(130);
  };

  process.once("SIGINT", handleSigint);

  try {
    const answer = (await prompt.question(promptText)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    process.off("SIGINT", handleSigint);
    prompt.close();
  }
}

function getStyledConfirmationPrompt(mode: string) {
  const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

  if (!useColor) {
    return `Proceed with ${mode}? (yes/no): `;
  }

  const reset = "\u001b[0m";
  const bold = "\u001b[1m";
  const yellow = "\u001b[33m";
  const cyan = "\u001b[36m";

  return `${yellow}${bold}Confirm${reset} ${cyan}Proceed with ${mode}?${reset} (yes/no): `;
}

export async function confirmSensitiveOperation(options: {
  mode: string;
  isInteractiveTerminal: boolean;
  promptForConfirmation?: (promptText: string) => Promise<boolean>;
}) {
  if (!requiresOperationConfirmation(options.mode)) {
    return;
  }

  if (!options.isInteractiveTerminal) {
    throw new Error(
      `${options.mode} requires an interactive confirmation prompt. Re-run this command in an interactive terminal.`,
    );
  }

  const promptText = getStyledConfirmationPrompt(options.mode);

  try {
    const confirmed = await (
      options.promptForConfirmation ?? promptYesNoConfirmation
    )(promptText);

    if (confirmed) {
      return;
    }

    const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
    const reset = "\u001b[0m";
    const yellow = "\u001b[33m";
    console.log(
      useColor
        ? `${yellow}Operation cancelled.${reset}`
        : "Operation cancelled.",
    );
    process.exit(0);
  } catch (error) {
    const abortLikeError =
      error instanceof Error &&
      (error.name === "AbortError" ||
        ("code" in error &&
          ((error as { code?: string }).code === "ABORT_ERR" ||
            (error as { code?: string }).code === "ERR_USE_AFTER_CLOSE")));

    if (abortLikeError) {
      const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
      const reset = "\u001b[0m";
      const yellow = "\u001b[33m";
      console.log(
        useColor
          ? `\n${yellow}Operation cancelled.${reset}`
          : "\nOperation cancelled.",
      );
      process.exit(130);
    }

    throw error;
  }
}

export function logCommandExecutionContext(options: {
  mode?: string;
  command: string;
  commandArgs: Array<string>;
  plannedCommand?: string;
  target: string;
  targetLabel?: string;
  envProfile?: string;
  databaseProvider?: string;
  databaseUrl?: string;
  betterAuthBaseUrl?: string;
  betterAuthSecret?: string;
}) {
  const context = buildExecutionContext({
    requestedLabel: options.mode,
    command: options.command,
    commandArgs: options.commandArgs,
    plannedCommand: options.plannedCommand,
    target: options.target,
    targetLabel: options.targetLabel,
    envProfile: options.envProfile,
    databaseProvider: options.databaseProvider,
    databaseUrl: options.databaseUrl,
    betterAuthBaseUrl: options.betterAuthBaseUrl,
    betterAuthSecret: options.betterAuthSecret,
  });

  assertExecutionContextOperationalValues(context);

  console.log(formatExecutionContextBanner(context));
}
