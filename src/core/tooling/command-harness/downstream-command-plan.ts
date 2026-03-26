export type DownstreamCommandPlanInput = {
  mode: string;
  provider: string;
  command: string;
  commandArgs: Array<string>;
};

export type DownstreamCommandPlan = {
  command: string;
  commandArgs: Array<string>;
  plannedCommand: string;
};

function assertKnownDatabaseProvider(provider: string, mode: string) {
  if (provider === "sqlite" || provider === "postgres") {
    return;
  }

  throw new Error(
    `Cannot resolve downstream command for ${mode}: unknown DATABASE_PROVIDER '${provider || "(empty)"}'.`,
  );
}

function toDisplayCommand(command: string, commandArgs: Array<string>) {
  return [command, ...commandArgs].join(" ").trim();
}

function isNpmRun(
  command: string,
  commandArgs: Array<string>,
  scriptName: string,
) {
  const normalizedCommand = command.trim().toLowerCase();

  return (
    (normalizedCommand === "npm" || normalizedCommand === "npm.cmd") &&
    commandArgs[0] === "run" &&
    commandArgs[1] === scriptName
  );
}

export function planDownstreamCommand(
  input: DownstreamCommandPlanInput,
): DownstreamCommandPlan {
  const normalizedMode = input.mode.trim().toLowerCase();
  const normalizedProvider = input.provider.trim().toLowerCase();

  if (
    normalizedMode === "db:setup" &&
    isNpmRun(input.command, input.commandArgs, "db:setup:raw")
  ) {
    assertKnownDatabaseProvider(normalizedProvider, "db:setup");

    const setupScript =
      normalizedProvider === "sqlite"
        ? "db:setup:sqlite:raw"
        : "db:setup:postgres:raw";

    return {
      command: "npm",
      commandArgs: ["run", setupScript],
      plannedCommand: `npm run ${setupScript}`,
    };
  }

  if (
    normalizedMode === "db:seed" &&
    isNpmRun(input.command, input.commandArgs, "db:seed:raw")
  ) {
    assertKnownDatabaseProvider(normalizedProvider, "db:seed");

    if (normalizedProvider === "sqlite") {
      return {
        command: "npm",
        commandArgs: ["run", "db:seed:sqlite:raw"],
        plannedCommand: "npm run db:seed:sqlite:raw",
      };
    }

    return {
      command: "npm",
      commandArgs: ["run", "db:seed:postgres:raw"],
      plannedCommand: "npm run db:seed:postgres:raw",
    };
  }

  return {
    command: input.command,
    commandArgs: input.commandArgs,
    plannedCommand: toDisplayCommand(input.command, input.commandArgs),
  };
}
