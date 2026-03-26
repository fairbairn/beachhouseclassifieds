import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

import { resolveProfileEnvironment } from "@/core/tooling/env/profile-env";

export type DatabaseTarget =
  | "sqlite:local"
  | "postgres:local"
  | "postgres:dev"
  | "postgres:prod";

type TargetDefinition = {
  label: string;
  envProfile: "local" | "dev" | "prod";
  databaseProvider: "sqlite" | "postgres";
  resolveDatabaseUrl: () => string;
};

const targetDefinitions: Record<DatabaseTarget, TargetDefinition> = {
  "sqlite:local": {
    label: "SQLite Local",
    envProfile: "local",
    databaseProvider: "sqlite",
    resolveDatabaseUrl: () => "",
  },
  "postgres:local": {
    label: "Postgres Local",
    envProfile: "local",
    databaseProvider: "postgres",
    resolveDatabaseUrl: () =>
      resolveProfileEnvironment({
        profileValue: "local",
      }).resolvedEnv.DATABASE_URL?.trim() ?? "",
  },
  "postgres:dev": {
    label: "Postgres Dev",
    envProfile: "dev",
    databaseProvider: "postgres",
    resolveDatabaseUrl: () =>
      resolveProfileEnvironment({
        profileValue: "dev",
      }).resolvedEnv.DATABASE_URL?.trim() ?? "",
  },
  "postgres:prod": {
    label: "Postgres Prod",
    envProfile: "prod",
    databaseProvider: "postgres",
    resolveDatabaseUrl: () =>
      resolveProfileEnvironment({
        profileValue: "prod",
      }).resolvedEnv.DATABASE_URL?.trim() ?? "",
  },
};

const targetAliases: Record<string, DatabaseTarget> = {
  "sqlite:local": "sqlite:local",
  sqlite: "sqlite:local",
  local: "sqlite:local",
  "postgres:local": "postgres:local",
  "pg:local": "postgres:local",
  "postgres-local": "postgres:local",
  "postgres:dev": "postgres:dev",
  "pg:dev": "postgres:dev",
  "postgres-dev": "postgres:dev",
  "postgres:prod": "postgres:prod",
  "pg:prod": "postgres:prod",
  "postgres-prod": "postgres:prod",
};

const useColor = output.isTTY && !process.env.NO_COLOR;
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

function isNeonDatabaseUrl(value: string) {
  const normalized = value.trim();

  if (!normalized) {
    return false;
  }

  try {
    const parsed = new URL(normalized);
    const host = parsed.hostname.trim().toLowerCase();
    return host.endsWith(".neon.tech");
  } catch {
    return false;
  }
}

function resolveTargetProviderDisplay(target: DatabaseTarget) {
  const definition = targetDefinitions[target];

  if (definition.databaseProvider !== "postgres") {
    return definition.databaseProvider.toUpperCase();
  }

  const databaseUrl = definition.resolveDatabaseUrl();

  if (!databaseUrl.trim()) {
    return "UNKNOWN";
  }

  if (isNeonDatabaseUrl(databaseUrl)) {
    return "NEON";
  }

  return "POSTGRES";
}

export const databaseTargetOrder: Array<DatabaseTarget> = [
  "sqlite:local",
  "postgres:local",
  "postgres:dev",
  "postgres:prod",
];

export function getDatabaseTargetLabel(target: DatabaseTarget) {
  return targetDefinitions[target].label;
}

export function parseDatabaseTarget(value: string | undefined) {
  if (!value) {
    return null;
  }

  return targetAliases[value.trim().toLowerCase()] ?? null;
}

export function resolveDatabaseTargetEnvironment(target: DatabaseTarget) {
  const definition = targetDefinitions[target];
  const { resolvedEnv } = resolveProfileEnvironment({
    profileValue: definition.envProfile,
  });

  const betterAuthSecret = resolvedEnv.BETTER_AUTH_SECRET?.trim() ?? "";
  const betterAuthBaseUrl = resolvedEnv.BETTER_AUTH_BASE_URL?.trim() ?? "";
  const betterAuthUrl = resolvedEnv.BETTER_AUTH_URL?.trim() ?? "";

  return {
    APP_ENV_PROFILE: definition.envProfile,
    DATABASE_PROVIDER: definition.databaseProvider,
    DATABASE_URL: definition.resolveDatabaseUrl(),
    BETTER_AUTH_SECRET: betterAuthSecret,
    BETTER_AUTH_BASE_URL: betterAuthBaseUrl,
    BETTER_AUTH_URL: betterAuthUrl,
  };
}

export function printDatabaseTargetMenu() {
  console.log(`\n${colorize("Database Targets", styles.bold, styles.cyan)}`);
  console.log(colorize("─".repeat(72), styles.dim));

  const rows = databaseTargetOrder.map((target, index) => {
    const definition = targetDefinitions[target];

    return {
      index: String(index + 1),
      label: definition.label,
      target: `(${target})`,
      provider: resolveTargetProviderDisplay(target),
      profile: definition.envProfile.toUpperCase(),
    };
  });

  const labelWidth = Math.max(...rows.map((row) => row.label.length));
  const targetWidth = Math.max(...rows.map((row) => row.target.length));
  const providerWidth = Math.max(...rows.map((row) => row.provider.length));

  rows.forEach((row) => {
    const label = row.label.padEnd(labelWidth, " ");
    const target = row.target.padEnd(targetWidth, " ");
    const provider = row.provider.padEnd(providerWidth, " ");

    const providerColor =
      row.provider === "UNKNOWN" ? styles.yellow : styles.green;

    console.log(
      `${colorize(row.index, styles.bold, styles.green)}) ${label}  ${colorize(target, styles.bold)}  ${colorize(provider, styles.bold, providerColor)}  ${colorize(row.profile, styles.dim)}`,
    );
  });

  console.log("");
}

export async function promptForDatabaseTarget() {
  const rl = createInterface({ input, output });
  const handleSigint = () => {
    console.log(`\n${colorize("Selection cancelled.", styles.yellow)}`);
    process.exit(130);
  };

  process.once("SIGINT", handleSigint);

  try {
    let answer: string;

    try {
      answer = await rl.question(
        `${colorize("Select target", styles.bold, styles.cyan)} ${colorize("(1-4)", styles.dim)} or press Enter to exit: `,
      );
    } catch (error) {
      const abortLikeError =
        error instanceof Error &&
        (error.name === "AbortError" ||
          ("code" in error &&
            ((error as { code?: string }).code === "ABORT_ERR" ||
              (error as { code?: string }).code === "ERR_USE_AFTER_CLOSE")));

      if (abortLikeError) {
        return null;
      }

      throw error;
    }

    const normalizedAnswer = answer.trim();

    if (!normalizedAnswer) {
      return null;
    }

    const index = Number.parseInt(normalizedAnswer, 10) - 1;

    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= databaseTargetOrder.length
    ) {
      console.error(colorize("Invalid choice.", styles.yellow));
      return null;
    }

    return databaseTargetOrder[index] ?? null;
  } finally {
    process.off("SIGINT", handleSigint);
    rl.close();
  }
}
