export type ExecutionContext = {
  mode: string;
  plannedCommand?: string;
  target: string;
  targetLabel: string;
  provider: string;
  envProfile: string;
  databaseUrl: string;
  betterAuthBaseUrl: string;
  betterAuthSecretConfigured: boolean;
  warnings: Array<string>;
  requestedLabel?: string;
  labelStatus?: "ok" | "mismatch";
  labelMessage?: string;
};

type BuildExecutionContextInput = {
  requestedLabel?: string;
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
};

const localhostBaseUrlPattern = /^https?:\/\/localhost(?::\d+)?$/;

function resolveBetterAuthBaseUrl(options: {
  value: string | undefined;
  mode: string;
}) {
  const normalized = options.value?.trim();

  if (!normalized) {
    return options.mode.trim().toLowerCase() === "prod"
      ? "http://localhost:4173"
      : "http://localhost:3000";
  }

  return normalized;
}

function buildExecutionContextWarnings(input: {
  mode: string;
  betterAuthBaseUrlInput?: string;
}) {
  const warnings: Array<string> = [];
  const normalizedMode = input.mode.trim().toLowerCase();
  const hasExplicitBetterAuthBaseUrl = Boolean(
    input.betterAuthBaseUrlInput?.trim(),
  );

  if (normalizedMode === "prod" && !hasExplicitBetterAuthBaseUrl) {
    warnings.push(
      "BETTER_AUTH_BASE_URL is not explicitly set. Using default http://localhost:4173 for local prod run.",
    );
  }

  return warnings;
}

function inferModeFromNpmScript(scriptName: string) {
  if (scriptName === "dev:raw") return "dev";
  if (scriptName === "prod:raw") return "prod";
  if (scriptName === "test:raw") return "test";
  if (scriptName === "db:setup:raw") {
    return "db:setup";
  }
  if (scriptName === "db:seed:raw") {
    return "db:seed";
  }
  if (scriptName === "manage:users:raw") return "manage:users";

  return scriptName;
}

export function inferExecutionMode(
  command: string,
  commandArgs: Array<string>,
  requestedLabel?: string,
) {
  const normalizedCommand = command.trim().toLowerCase();

  if (
    (normalizedCommand === "npm" || normalizedCommand === "npm.cmd") &&
    commandArgs[0] === "run"
  ) {
    const scriptName = commandArgs[1];

    if (scriptName) {
      return inferModeFromNpmScript(scriptName);
    }
  }

  if (normalizedCommand === "vite" && commandArgs[0] === "dev") {
    return "dev";
  }

  if (normalizedCommand === "vite" && commandArgs[0] === "preview") {
    return "prod";
  }

  if (normalizedCommand === "vitest") {
    return "test";
  }

  if (requestedLabel?.trim()) {
    return requestedLabel.trim();
  }

  return command;
}

export function validateRequestedLabel(options: {
  requestedLabel?: string;
  provider: string;
}) {
  const normalizedLabel = options.requestedLabel?.trim().toLowerCase();

  if (!normalizedLabel) {
    return {
      status: "ok" as const,
    };
  }

  const mentionsPostgres = normalizedLabel.includes("postgres");
  const mentionsSqlite = normalizedLabel.includes("sqlite");

  if (mentionsPostgres && options.provider === "sqlite") {
    return {
      status: "mismatch" as const,
      message:
        "Requested label mentions postgres, but resolved provider is sqlite.",
    };
  }

  if (mentionsSqlite && options.provider === "postgres") {
    return {
      status: "mismatch" as const,
      message:
        "Requested label mentions sqlite, but resolved provider is postgres.",
    };
  }

  return {
    status: "ok" as const,
  };
}

export function buildExecutionContext(
  input: BuildExecutionContextInput,
): ExecutionContext {
  const provider = input.databaseProvider ?? "(unknown)";
  const mode = inferExecutionMode(
    input.command,
    input.commandArgs,
    input.requestedLabel,
  );
  const betterAuthBaseUrl = resolveBetterAuthBaseUrl({
    value: input.betterAuthBaseUrl,
    mode,
  });
  const betterAuthSecretConfigured = Boolean(input.betterAuthSecret?.trim());
  const validation = validateRequestedLabel({
    requestedLabel: input.requestedLabel,
    provider,
  });

  const warnings = buildExecutionContextWarnings({
    mode,
    betterAuthBaseUrlInput: input.betterAuthBaseUrl,
  });

  return {
    mode,
    plannedCommand: input.plannedCommand,
    target: input.target,
    targetLabel: input.targetLabel ?? input.target,
    provider,
    envProfile: input.envProfile ?? "(unknown)",
    databaseUrl: input.databaseUrl?.trim() || "(not set)",
    betterAuthBaseUrl,
    betterAuthSecretConfigured,
    warnings,
    requestedLabel: input.requestedLabel,
    labelStatus: validation.status,
    labelMessage: validation.message,
  };
}

export function validateExecutionContextOperationalValues(
  context: ExecutionContext,
) {
  const errors: Array<string> = [];
  const normalizedProvider = context.provider.trim().toLowerCase();
  const normalizedProfile = context.envProfile.trim().toLowerCase();
  const normalizedTarget = context.target.trim().toLowerCase();
  const targetParts = normalizedTarget.split(":");
  const targetProvider = targetParts[0] ?? "";
  const targetProfile = targetParts[1] ?? "";
  const hasValidTargetShape =
    targetParts.length === 2 &&
    (targetProvider === "sqlite" || targetProvider === "postgres") &&
    (targetProfile === "local" ||
      targetProfile === "dev" ||
      targetProfile === "prod");
  const hasDatabaseUrl =
    context.databaseUrl.trim().length > 0 &&
    context.databaseUrl !== "(not set)";

  if (!normalizedTarget) {
    errors.push("Resolved target is missing.");
  }

  if (normalizedTarget && !hasValidTargetShape) {
    errors.push(
      `Resolved target '${context.target}' is invalid. Expected one of: sqlite:local, postgres:local, postgres:dev, postgres:prod.`,
    );
  }

  if (normalizedProvider !== "sqlite" && normalizedProvider !== "postgres") {
    errors.push(
      `Resolved provider '${context.provider}' is invalid. Expected 'sqlite' or 'postgres'.`,
    );
  }

  if (
    normalizedProfile !== "local" &&
    normalizedProfile !== "dev" &&
    normalizedProfile !== "prod"
  ) {
    errors.push(
      `Resolved env profile '${context.envProfile}' is invalid. Expected 'local', 'dev', or 'prod'.`,
    );
  }

  if (targetProvider === "postgres" && normalizedProvider !== "postgres") {
    errors.push(
      `Target '${context.target}' requires provider 'postgres', but resolved provider is '${context.provider}'.`,
    );
  }

  if (targetProvider === "sqlite" && normalizedProvider !== "sqlite") {
    errors.push(
      `Target '${context.target}' requires provider 'sqlite', but resolved provider is '${context.provider}'.`,
    );
  }

  if (targetProfile && normalizedProfile !== targetProfile) {
    errors.push(
      `Target '${context.target}' requires env profile '${targetProfile}', but resolved env profile is '${context.envProfile}'.`,
    );
  }

  if (normalizedProvider === "postgres" && !hasDatabaseUrl) {
    errors.push(
      "Postgres execution requires DATABASE_URL, but no value was resolved. Set DATABASE_URL in the selected profile env file (.env.local/.env.dev/.env.prod) or use a valid local postgres target setup.",
    );
  }

  let hasValidBetterAuthBaseUrl = false;
  let isLocalhostBetterAuthBaseUrl = false;

  try {
    const parsedBaseUrl = new URL(context.betterAuthBaseUrl);
    hasValidBetterAuthBaseUrl = true;
    isLocalhostBetterAuthBaseUrl = localhostBaseUrlPattern.test(
      parsedBaseUrl.origin,
    );
  } catch {
    errors.push(
      `Better Auth base URL '${context.betterAuthBaseUrl}' is invalid. Set BETTER_AUTH_BASE_URL (or BETTER_AUTH_URL) to a valid URL.`,
    );
  }

  if (
    hasValidBetterAuthBaseUrl &&
    !isLocalhostBetterAuthBaseUrl &&
    !context.betterAuthSecretConfigured
  ) {
    errors.push(
      "BETTER_AUTH_SECRET is required when BETTER_AUTH_BASE_URL is non-localhost. Set BETTER_AUTH_SECRET in your environment.",
    );
  }

  return errors;
}

export function assertExecutionContextOperationalValues(
  context: ExecutionContext,
) {
  const errors = validateExecutionContextOperationalValues(context);
  const normalizedMode = context.mode.trim().toLowerCase();
  const isDbSetupOrSeedMode =
    normalizedMode === "db:setup" || normalizedMode === "db:seed";

  const fatalErrors = errors.filter((value) => {
    if (!isDbSetupOrSeedMode) {
      return true;
    }

    return !value.includes("Postgres execution requires DATABASE_URL");
  });

  const downgradedDatabaseUrlErrorCount = errors.length - fatalErrors.length;

  if (downgradedDatabaseUrlErrorCount > 0) {
    context.warnings.push(
      `Missing DATABASE_URL for target ${context.target}. This run requires DATABASE_URL at runtime. Set DATABASE_URL in the selected profile env file (.env.local/.env.dev/.env.prod) and retry.`,
    );
  }

  if (fatalErrors.length === 0) {
    return;
  }

  const message = [
    "Invalid command execution context:",
    ...fatalErrors.map((value) => `- ${value}`),
  ].join("\n");
  throw new Error(message);
}

function truncateValue(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function redactDatabaseUrlPassword(value: string) {
  if (!value || value === "(not set)") {
    return value;
  }

  try {
    const parsed = new URL(value);

    if (!parsed.password) {
      return value;
    }

    parsed.password = "***";
    return parsed.toString();
  } catch {
    return value;
  }
}

export function formatExecutionContextBanner(context: ExecutionContext) {
  const displayDatabaseUrl = truncateValue(
    redactDatabaseUrlPassword(context.databaseUrl),
    72,
  );

  const rows: Array<[string, string]> = [
    ["Mode", context.mode],
    ...(context.plannedCommand
      ? [["Script", context.plannedCommand] as [string, string]]
      : []),
    ["Target", `${context.targetLabel} (${context.target})`],
    ["Provider", context.provider],
    ["Env Profile", context.envProfile],
    ["DATABASE_URL", displayDatabaseUrl],
    ["Auth Base URL", context.betterAuthBaseUrl],
    [
      "Auth Secret",
      context.betterAuthSecretConfigured ? "configured" : "missing",
    ],
  ];

  if (context.labelStatus === "mismatch" && context.labelMessage) {
    rows.push(["Label Check", context.labelMessage]);
  }

  context.warnings.forEach((warning) => {
    rows.push(["Warning", warning]);
  });

  const maxLabelLength = Math.max(...rows.map(([label]) => label.length));
  const maxValueLength = Math.max(...rows.map(([, value]) => value.length));
  const horizontalRule = `+${"-".repeat(maxLabelLength + 2)}+${"-".repeat(maxValueLength + 2)}+`;

  const lines = rows.map(([label, value]) => {
    const paddedLabel = label.padEnd(maxLabelLength, " ");
    const paddedValue = value.padEnd(maxValueLength, " ");

    return `| ${paddedLabel} | ${paddedValue} |`;
  });

  const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

  if (!useColor) {
    return [
      "",
      "RUN CONTEXT",
      horizontalRule,
      ...lines,
      horizontalRule,
      "",
    ].join("\n");
  }

  const reset = "\u001b[0m";
  const bold = "\u001b[1m";
  const white = "\u001b[97m";
  const cyan = "\u001b[36m";
  const dim = "\u001b[2m";
  const blueBackground = "\u001b[44m";
  const yellow = "\u001b[33m";

  const badge = `${blueBackground}${white}${bold} RUN ${reset}`;
  const decoratedRule = `${dim}${horizontalRule}${reset}`;
  const decoratedLines = lines.map((line) => {
    if (line.includes("Label Check") || line.includes("Warning")) {
      return `${yellow}${line}${reset}`;
    }

    return `${cyan}${line}${reset}`;
  });

  return [
    "",
    `${badge} ${bold}${white}CONTEXT${reset}`,
    decoratedRule,
    ...decoratedLines,
    decoratedRule,
    "",
  ].join("\n");
}
