import { spawn } from "node:child_process";
import readline from "node:readline/promises";

type HelpCommand = {
  script: string;
  description: string;
};

const helpCommands: Array<HelpCommand> = [
  { script: "dev", description: "App dev server (prompts for DB target)" },
  { script: "build", description: "Create production build artifacts" },
  { script: "test", description: "Run test suite (prompts for DB target)" },
  { script: "lint", description: "Run ESLint checks" },
  { script: "db:check", description: "DB connectivity + table listing" },
  { script: "db:setup", description: "Initialize DB baseline for active target" },
  { script: "db:migrate", description: "Postgres schema migrations" },
  { script: "db:cloud", description: "Guided cloud DB workflow (dev/prod)" },
  { script: "manage:users", description: "User management CLI" },
  {
    script: "analyze:performance:interactive",
    description: "Performance report picker",
  },
  { script: "auth:secret:generate", description: "Generate Better Auth secret" },
  { script: "prod", description: "Local prod preview (prompts for DB target)" },
  { script: "docs:dev", description: "Docs dev server" },
  { script: "docs:build", description: "Docs static build" },
];

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const ctrlCExitCode = 130;
const styles = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  cyan: "\u001b[36m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  dim: "\u001b[2m",
};

function colorize(text: string, ...codes: Array<string>) {
  if (!useColor) {
    return text;
  }

  return `${codes.join("")}${text}${styles.reset}`;
}

function printHelpMenu() {
  const title = colorize("Scaffold Command Center", styles.bold, styles.cyan);
  const divider = colorize("─".repeat(72), styles.dim);
  const commandLabels = helpCommands.map(
    (command) => `npm run ${command.script}`,
  );
  const commandWidth = Math.max(...commandLabels.map((value) => value.length));
  const indexWidth = String(helpCommands.length).length;
  const commandPrefix = "npm run ";

  const renderCommandLabel = (script: string) => {
    const plain = `${commandPrefix}${script}`.padEnd(commandWidth, " ");
    const keywordEnd = commandPrefix.length + script.length;
    const prefix = plain.slice(0, commandPrefix.length);
    const keyword = plain.slice(commandPrefix.length, keywordEnd);
    const trailing = plain.slice(keywordEnd);

    return `${colorize(prefix, styles.bold)}${colorize(keyword, styles.bold, styles.cyan)}${trailing}`;
  };

  const lines = [
    "",
    title,
    divider,
    "",
    ...helpCommands.map(
      (command, index) =>
        ` ${colorize(String(index + 1).padStart(indexWidth, " "), styles.bold, styles.green)}. ${renderCommandLabel(command.script)}  ${command.description}`,
    ),
    "",
    colorize("Notes", styles.bold, styles.yellow),
    "- Commands run from the current template directory.",
    "- Prefer non-:raw commands unless troubleshooting internals.",
    "",
  ];

  console.log(lines.join("\n"));
}

function runNpmScript(script: string, args: Array<string> = []) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn("npm", ["run", script, ...args], {
      stdio: "inherit",
      env: process.env,
    });

    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
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

async function run() {
  printHelpMenu();

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(
      `${colorize("Non-interactive terminal detected.", styles.yellow)} Run one of the commands above directly.`,
    );
    return;
  }

  const prompt = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const handleSigint = () => {
    console.log(`\n${colorize("Selection cancelled.", styles.yellow)}`);
    process.exit(ctrlCExitCode);
  };

  process.once("SIGINT", handleSigint);
  let promptClosed = false;
  const closePrompt = () => {
    if (promptClosed) {
      return;
    }

    process.off("SIGINT", handleSigint);
    prompt.close();
    promptClosed = true;
  };

  try {
    let response: string;

    try {
      response = (
        await prompt.question(
          `${colorize("Select command", styles.bold, styles.cyan)} ${colorize(`(1-${helpCommands.length})`, styles.dim)} or press Enter to exit: `,
        )
      ).trim();
    } catch (error) {
      if (isAbortLikeError(error)) {
        process.exit(ctrlCExitCode);
      }

      throw error;
    }

    if (!response) {
      return;
    }

    const selectedIndex = Number(response);

    if (
      !Number.isInteger(selectedIndex) ||
      selectedIndex < 1 ||
      selectedIndex > helpCommands.length
    ) {
      console.log(
        `${colorize("Invalid selection:", styles.yellow)} '${response}'.`,
      );
      process.exit(1);
    }

    const selectedCommand = helpCommands[selectedIndex - 1];

    if (!selectedCommand) {
      process.exit(1);
    }

    closePrompt();
    const exitCode = await runNpmScript(selectedCommand.script);

    if (exitCode !== 0) {
      process.exit(exitCode);
    }
  } finally {
    closePrompt();
  }
}

async function main() {
  try {
    await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(colorize(`Help command failed: ${message}`, styles.yellow));
    process.exit(1);
  }
}

await main();
