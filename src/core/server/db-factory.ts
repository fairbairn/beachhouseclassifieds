import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";

import { drizzle } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzlePostgres } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { normalizePostgresConnectionString } from "@/core/server/postgres-connection-string";

export type DatabaseProvider = "sqlite" | "postgres";

const DEFAULT_POSTGRES_POOL_MAX = 10;
const NEON_POOLED_POSTGRES_POOL_MAX = 2;
const require = createRequire(import.meta.url);

function createSqliteRuntime(sqliteDbPath: string) {
  const BetterSqlite3 =
    require("better-sqlite3") as typeof import("better-sqlite3");
  const sqliteDb = new BetterSqlite3(sqliteDbPath);
  const db = drizzle(sqliteDb);

  return {
    sqliteDb,
    db,
  };
}

export function resolveDatabaseProvider(
  value: string | undefined,
  databaseUrl?: string,
) {
  const normalizedValue = value?.trim().toLowerCase();

  if (normalizedValue === "sqlite") {
    return "sqlite";
  }

  if (normalizedValue === "postgres") {
    return "postgres";
  }

  const protocol = databaseUrl ? resolveDatabaseUrlProtocol(databaseUrl) : null;
  const isPostgresProtocol =
    protocol === "postgres:" || protocol === "postgresql:";

  if (isPostgresProtocol) {
    return "postgres";
  }

  return "postgres";
}

function resolveDatabaseUrlProtocol(databaseUrl: string) {
  try {
    const parsed = new URL(databaseUrl);
    return parsed.protocol.toLowerCase();
  } catch {
    return null;
  }
}

function assertDatabaseProviderAlignment(options: {
  databaseProvider: DatabaseProvider;
  databaseUrl?: string;
}) {
  if (options.databaseProvider === "sqlite") {
    return;
  }

  const databaseUrl = options.databaseUrl?.trim();

  if (!databaseUrl) {
    return;
  }

  const protocol = resolveDatabaseUrlProtocol(databaseUrl);
  const isPostgresProtocol =
    protocol === "postgres:" || protocol === "postgresql:";

  if (options.databaseProvider === "postgres" && !isPostgresProtocol) {
    throw new Error(
      "DATABASE_PROVIDER is postgres, but DATABASE_URL is not a Postgres URL. Use a postgres:// or postgresql:// connection string.",
    );
  }
}

function resolvePostgresPoolMax(databaseUrl: string) {
  try {
    const parsed = new URL(databaseUrl);
    const host = parsed.hostname.toLowerCase();
    const isNeonHost = host.endsWith(".neon.tech");
    const usesNeonPooler = host.includes("-pooler.") || parsed.port === "6432";

    if (isNeonHost && usesNeonPooler) {
      return NEON_POOLED_POSTGRES_POOL_MAX;
    }
  } catch {
    return DEFAULT_POSTGRES_POOL_MAX;
  }

  return DEFAULT_POSTGRES_POOL_MAX;
}

export function createDbRuntime(options: {
  sqliteDbPath: string;
  databaseProvider: DatabaseProvider;
  databaseUrl?: string;
}) {
  mkdirSync(dirname(options.sqliteDbPath), { recursive: true });

  const sqliteRuntime =
    options.databaseProvider === "sqlite"
      ? createSqliteRuntime(options.sqliteDbPath)
      : null;
  const databaseUrl = options.databaseUrl?.trim();
  assertDatabaseProviderAlignment({
    databaseProvider: options.databaseProvider,
    databaseUrl,
  });
  const normalizedDatabaseUrl =
    options.databaseProvider === "postgres" && databaseUrl
      ? normalizePostgresConnectionString(databaseUrl)
      : undefined;

  if (options.databaseProvider === "postgres" && !databaseUrl) {
    throw new Error(
      "DATABASE_PROVIDER=postgres requires DATABASE_URL to be set.",
    );
  }

  const pgPool =
    options.databaseProvider === "postgres"
      ? new Pool({
          connectionString: normalizedDatabaseUrl,
          max: resolvePostgresPoolMax(normalizedDatabaseUrl ?? ""),
        })
      : null;

  const pgDb = pgPool ? drizzlePostgres(pgPool) : null;
  const authDatabase =
    options.databaseProvider === "postgres" ? pgPool : sqliteRuntime?.sqliteDb;

  if (options.databaseProvider === "sqlite" && !sqliteRuntime) {
    throw new Error("SQLite runtime failed to initialize.");
  }

  return {
    sqliteDb:
      sqliteRuntime?.sqliteDb ??
      (null as unknown as ReturnType<typeof createSqliteRuntime>["sqliteDb"]),
    db:
      sqliteRuntime?.db ??
      (null as unknown as ReturnType<typeof createSqliteRuntime>["db"]),
    pgPool,
    pgDb,
    authDatabase,
  };
}
