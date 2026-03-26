import { spawn } from "node:child_process";

import "@/core/tooling/env/load-env-profile";

import { normalizePostgresConnectionString } from "@/core/server/postgres-connection-string";

function runMigrate() {
  return new Promise<number>((resolve, reject) => {
    const databaseUrl = process.env.DATABASE_URL?.trim();

    if (!databaseUrl) {
      reject(
        new Error(
          "Missing DATABASE_URL for db:postgres:migrate. Set DATABASE_URL in active env profile.",
        ),
      );
      return;
    }

    const child = spawn(
      "drizzle-kit",
      ["migrate", "--config", "drizzle.config.pg.ts"],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          DATABASE_URL: normalizePostgresConnectionString(databaseUrl),
        },
      },
    );

    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

const exitCode = await runMigrate();

if (exitCode !== 0) {
  process.exit(exitCode);
}
