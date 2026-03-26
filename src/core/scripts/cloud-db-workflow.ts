import { spawn } from "node:child_process";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

import chalk from "chalk";

import {
  resolveDatabaseTargetEnvironment,
  type DatabaseTarget,
} from "@/core/tooling/db/targets/db-targets";

type CloudTarget = "postgres:dev" | "postgres:prod";

type WorkflowAction = {
  key: string;
  label: string;
  description: string;
  command?: string;
  commandArgs?: Array<string>;
  requiresProdConfirmation?: boolean;
};

const workflowActions: Array<WorkflowAction> = [
  {
    key: "1",
    label: "Connectivity check",
    description: "Verify connection + tls + current tables",
    command: "npm",
    commandArgs: ["run", "db:check:raw"],
  },
  {
    key: "2",
    label: "Migrate schema",
    description: "Run Drizzle migrations (auth + app tables)",
    command: "npm",
    commandArgs: ["run", "db:postgres:migrate"],
    requiresProdConfirmation: true,
  },
  {
    key: "3",
    label: "Table verification check",
    description: "Verify migrated tables are present",
    command: "npm",
    commandArgs: ["run", "db:check:raw"],
  },
  {
    key: "4",
    label: "Create first user",
    description: "Run manage:users CLI",
    command: "npm",
    commandArgs: ["run", "manage:users:raw"],
  },
  {
    key: "5",
    label: "Exit",
    description: "Close workflow",
  },
];

function parseCloudTarget(value: string | undefined): CloudTarget | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase();

  if (normalized === "postgres:dev") {
    return "postgres:dev";
  }

  if (normalized === "postgres:prod") {
    return "postgres:prod";
  }

  return null;
}

function isAbortLikeError(error: unknown) {
  return (
    error instanceof Error &&
    (error.name === "AbortError" ||
      ("code" in error &&
        ((error as { code?: string }).code === "ABORT_ERR" ||
          (error as { code?: string }).code === "ERR_USE_AFTER_CLOSE")))
  );
}

async function runCommandWithEnv(options: {
  command: string;
  commandArgs: Array<string>;
  childEnv: NodeJS.ProcessEnv;
}) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(options.command, options.commandArgs, {
      stdio: "inherit",
      env: {
        ...process.env,
        ...options.childEnv,
      },
    });

    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

async function promptForTarget(
  rl: ReturnType<typeof createInterface>,
): Promise<CloudTarget | null> {
  console.log(chalk.cyan("\nCloud DB Workflow Targets"));
  console.log("1) postgres:dev");
  console.log("2) postgres:prod");
  console.log("3) Exit");

  while (true) {
    const answer = (
      await rl.question(chalk.yellow("Select target (1-3): "))
    ).trim();

    if (!answer || answer === "3" || answer.toLowerCase() === "exit") {
      return null;
    }

    if (answer === "1") {
      return "postgres:dev";
    }

    if (answer === "2") {
      return "postgres:prod";
    }

    const parsed = parseCloudTarget(answer);

    if (parsed) {
      return parsed;
    }

    console.log(chalk.gray("Please choose 1, 2, or 3."));
  }
}

async function promptYesNo(
  rl: ReturnType<typeof createInterface>,
  question: string,
) {
  while (true) {
    const answer = (await rl.question(chalk.yellow(`${question} (yes/no): `)))
      .trim()
      .toLowerCase();

    if (answer === "yes" || answer === "y") {
      return true;
    }

    if (answer === "no" || answer === "n") {
      return false;
    }

    console.log(chalk.gray("Please answer yes or no."));
  }
}

async function promptForAction(rl: ReturnType<typeof createInterface>) {
  console.log(chalk.cyan("\nCloud DB Workflow Steps"));
  workflowActions.forEach((action) => {
    console.log(`${action.key}) ${action.label} — ${action.description}`);
  });

  while (true) {
    const answer = (
      await rl.question(chalk.yellow("Select step (1-5): "))
    ).trim();

    const action = workflowActions.find((entry) => entry.key === answer);

    if (action) {
      return action;
    }

    console.log(chalk.gray("Please choose 1 through 5."));
  }
}

async function run() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "db:cloud requires an interactive terminal. Re-run in an interactive shell.",
    );
  }

  let rl = createInterface({ input, output });

  const reopenPrompt = () => {
    rl = createInterface({ input, output });
  };

  const closePrompt = () => {
    rl.close();
  };

  try {
    const target = await promptForTarget(rl);

    if (!target) {
      console.log(chalk.gray("No target selected. Exiting."));
      return;
    }

    const targetEnv = resolveDatabaseTargetEnvironment(
      target as DatabaseTarget,
    );

    if (targetEnv.DATABASE_PROVIDER !== "postgres") {
      throw new Error("db:cloud supports postgres targets only.");
    }

    const hasDatabaseUrl = Boolean(targetEnv.DATABASE_URL?.trim());

    if (!hasDatabaseUrl) {
      throw new Error(
        `Missing DATABASE_URL for ${target}. Set DATABASE_URL in the selected profile env file and retry.`,
      );
    }

    console.log(chalk.green(`\nUsing target: ${target}`));
    console.log(chalk.gray("Recommended sequence: 1 -> 2 -> 3 -> 4"));

    while (true) {
      const action = await promptForAction(rl);

      if (action.key === "5") {
        console.log(chalk.gray("Exiting cloud DB workflow."));
        return;
      }

      if (!action.command || !action.commandArgs) {
        continue;
      }

      if (target === "postgres:prod" && action.requiresProdConfirmation) {
        const approved = await promptYesNo(
          rl,
          `Proceed with '${action.label}' against ${target}?`,
        );

        if (!approved) {
          console.log(chalk.gray("Skipped."));
          continue;
        }
      }

      console.log(
        chalk.cyan(
          `\nRunning: ${[action.command, ...action.commandArgs].join(" ")}\n`,
        ),
      );

      closePrompt();
      const exitCode = await runCommandWithEnv({
        command: action.command,
        commandArgs: action.commandArgs,
        childEnv: {
          ...targetEnv,
          ...(target === "postgres:dev" && action.key === "4"
            ? {
                MANAGE_USERS_ALLOW_REMOTE: "true",
              }
            : {}),
        },
      });
      reopenPrompt();

      if (exitCode !== 0) {
        console.log(chalk.red(`Step failed with exit code ${exitCode}.`));
      } else {
        console.log(chalk.green("Step completed."));
      }
    }
  } catch (error) {
    try {
      closePrompt();
    } catch {
      // no-op
    }

    if (isAbortLikeError(error)) {
      console.log(chalk.gray("Selection cancelled."));
      process.exit(130);
    }

    throw error;
  } finally {
    try {
      closePrompt();
    } catch {
      // no-op
    }
  }
}

await run();
