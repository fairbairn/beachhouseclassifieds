import { runDbTargetCli } from "@/core/tooling/db/targets/db-target-cli";

const usage =
  "Usage: tsx src/scripts/target.ts [--target <target>] [--mode <name>] -- <command> [args...]";

const protectedModes = [
  "db:setup",
  "db:seed",
  "manage:users",
];

function formatCommandFailureOutput(message: string) {
  const lines = message
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  const useColor = process.stderr.isTTY && !process.env.NO_COLOR;

  if (!useColor) {
    return ["", "Command failed", ...lines.map((line) => `  ${line}`)].join(
      "\n",
    );
  }

  const reset = "\u001b[0m";
  const bold = "\u001b[1m";
  const red = "\u001b[31m";
  const yellow = "\u001b[33m";
  const dim = "\u001b[2m";
  const heading = `${red}${bold}✖ Command failed${reset}`;

  const decoratedLines = lines.map((line) => {
    if (line.startsWith("- ")) {
      return `${yellow}${line}${reset}`;
    }

    return `${dim}${line}${reset}`;
  });

  return ["", heading, ...decoratedLines].join("\n");
}

async function run() {
  try {
    await runDbTargetCli({
      argv: process.argv.slice(2),
      usage,
      protectedModes,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown command failure.";
    console.error(formatCommandFailureOutput(message));
    process.exit(1);
  }
}

await run();
