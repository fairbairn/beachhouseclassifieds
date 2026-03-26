import { spawn } from "node:child_process";

import "@/core/tooling/env/load-env-profile";

import { runAuthMigrations } from "@/core/tooling/db/ops/run-auth-migrations";

function runPostgresMigrations() {
  return new Promise<number>((resolve, reject) => {
    const child = spawn("npm", ["run", "db:postgres:migrate"], {
      stdio: "inherit",
      env: process.env,
    });

    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

await runAuthMigrations();

const exitCode = await runPostgresMigrations();

if (exitCode !== 0) {
  process.exit(exitCode);
}
