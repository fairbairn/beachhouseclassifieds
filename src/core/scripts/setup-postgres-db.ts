import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import "@/core/tooling/env/load-env-profile";

import { pgDb } from "@/core/server/db";
import { runAuthMigrations } from "@/core/tooling/db/ops/run-auth-migrations";
import { site } from "@/lib/db/schema-postgres";

const BASELINE_SITE_SLUG = "30acollections";
const BASELINE_SITE_NAME = "30A Collections";

async function ensureBaselineSiteRecord() {
  if (!pgDb) {
    throw new Error("Postgres database is not configured.");
  }

  const existing = await pgDb
    .select({ id: site.id })
    .from(site)
    .where(eq(site.slug, BASELINE_SITE_SLUG))
    .limit(1);

  if (existing.length > 0) {
    await pgDb
      .update(site)
      .set({
        name: BASELINE_SITE_NAME,
        status: "active",
        updated_at: new Date().toISOString(),
      })
      .where(eq(site.slug, BASELINE_SITE_SLUG));
    return;
  }

  await pgDb.insert(site).values({
    id: `site_${randomUUID().replace(/-/g, "")}`,
    slug: BASELINE_SITE_SLUG,
    name: BASELINE_SITE_NAME,
    status: "active",
  });
}

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

const exitCode = await runPostgresMigrations();

if (exitCode !== 0) {
  process.exit(exitCode);
}

await runAuthMigrations();
await ensureBaselineSiteRecord();
