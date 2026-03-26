import { spawn } from "node:child_process";

import { Client } from "pg";

import { normalizePostgresConnectionString } from "@/core/server/postgres-connection-string";
import "@/core/tooling/env/load-env-profile";

async function resetPublicSchema(databaseUrl: string) {
  const normalizedUrl = normalizePostgresConnectionString(databaseUrl);
  const parsed = new URL(normalizedUrl);
  const schemaOwner = decodeURIComponent(parsed.username || "postgres");

  const client = new Client({ connectionString: normalizedUrl });
  await client.connect();

  try {
    await client.query("drop schema if exists public cascade");
    await client.query("create schema public");
    await client.query(
      `grant all on schema public to "${schemaOwner.replace(/"/g, '""')}"`,
    );
    await client.query("grant all on schema public to public");
  } finally {
    await client.end();
  }
}

function runPush() {
  return new Promise<number>((resolve, reject) => {
    const child = spawn("npm", ["run", "db:postgres:push:force"], {
      stdio: "inherit",
      env: process.env,
    });

    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

async function run() {
  const databaseUrl = process.env.DATABASE_URL?.trim();

  if (!databaseUrl) {
    console.error(
      "Missing DATABASE_URL for experimental Postgres schema sync. Set DATABASE_URL in the active env profile.",
    );
    process.exit(1);
  }

  await resetPublicSchema(databaseUrl);
  const exitCode = await runPush();

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

try {
  await run();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Experimental schema sync failed: ${message}`);
  process.exit(1);
}
