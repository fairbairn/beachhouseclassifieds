import { getMigrations } from "better-auth/db";
import chalk from "chalk";

import { auth } from "@/core/server/auth";
import { authDatabase, databaseProvider } from "@/core/server/db";

export async function runAuthMigrations() {
  if (databaseProvider !== "postgres") {
    throw new Error(
      `auth:migrate requires DATABASE_PROVIDER=postgres. Received '${databaseProvider}'.`,
    );
  }

  const { runMigrations } = await getMigrations({
    ...auth.options,
    database: authDatabase,
  });

  console.log(chalk.gray("Running Better Auth migrations..."));
  await runMigrations();
  console.log(chalk.green("Better Auth migrations completed."));
}
