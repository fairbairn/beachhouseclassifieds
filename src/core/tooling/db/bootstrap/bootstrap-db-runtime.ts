import { getMigrations } from "better-auth/db";
import chalk from "chalk";

import { auth } from "@/core/server/auth";
import { authDatabase, databaseProvider } from "@/core/server/db";
import {
  ensureUserTimeZoneStorageReady,
  setStoredUserTimeZoneByEmail,
} from "@/core/server/user-time-zone";
import { DEFAULT_TIME_ZONE } from "@/core/shared/time-zone";
import { bootstrapLocalDb } from "@/core/tooling/db/bootstrap/local-db-bootstrap";
import { type LocalSeedUser } from "@/core/tooling/db/bootstrap/local-seed-users";

type BootstrapDbRuntimeOptions = {
  runSqliteBootstrap: (context: {
    targetUserEmails: Array<string>;
  }) => Promise<void>;
};

async function seedLocalAuthUser(user: LocalSeedUser) {
  try {
    await auth.api.signUpEmail({
      body: {
        name: user.name,
        email: user.email,
        password: user.password,
      },
    });

    console.log(chalk.green(`Seeded local auth user: ${user.email}`));
  } catch {
    console.log(
      chalk.gray(`Local auth user exists; skipping seed: ${user.email}`),
    );
  }

  await setStoredUserTimeZoneByEmail({
    email: user.email,
    timeZone: user.timeZone ?? DEFAULT_TIME_ZONE,
  });
}

export async function bootstrapDbRuntime(options: BootstrapDbRuntimeOptions) {
  const appEnvProfile =
    process.env.APP_ENV_PROFILE?.trim().toLowerCase() ?? "local";

  const result = await bootstrapLocalDb({
    databaseProvider,
    appEnvProfile,
    nodeEnv: process.env.NODE_ENV,
    runAuthMigrations: async () => {
      console.log(chalk.gray("Running Better Auth migrations..."));

      const { runMigrations } = await getMigrations({
        ...auth.options,
        database: authDatabase,
      });

      await runMigrations();
    },
    seedLocalAuthUser,
    runSqliteBootstrap: options.runSqliteBootstrap,
  });

  if (result.outcome === "skipped" && result.reason === "production") {
    console.log(chalk.gray("Skipping dev DB setup in production mode."));
    return;
  }

  await ensureUserTimeZoneStorageReady();
}
