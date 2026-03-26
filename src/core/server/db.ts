import { resolve } from "node:path";

import {
  createDbRuntime,
  resolveDatabaseProvider,
} from "@/core/server/db-factory";

export const databaseProvider = resolveDatabaseProvider(
  process.env.DATABASE_PROVIDER,
  process.env.DATABASE_URL,
);

function sanitizeAppName(value: string) {
  return value.trim().toLowerCase().replace(/^@/, "").replace(/\//g, "-");
}

function resolveDefaultSqliteBaseName() {
  const explicit = process.env.APP_DB_BASENAME?.trim();

  if (explicit) {
    return explicit;
  }

  const packageName = process.env.npm_package_name?.trim();

  if (!packageName) {
    return "app";
  }

  const normalized = sanitizeAppName(packageName);
  return normalized.length > 0 ? normalized : "app";
}

// Primary SQLite DB path used by auth and app domain data.
const sqliteBaseName = resolveDefaultSqliteBaseName();
const sqliteDbFilename = `${sqliteBaseName}-dev.db`;

export const sqliteDbPath = resolve(process.cwd(), "db", sqliteDbFilename);

const runtime = createDbRuntime({
  sqliteDbPath,
  databaseProvider,
  databaseUrl: process.env.DATABASE_URL,
});

export const sqliteDb = runtime.sqliteDb;
export const db = runtime.db;
export const pgPool = runtime.pgPool;
export const pgDb = runtime.pgDb;
export const authDatabase = runtime.authDatabase;
