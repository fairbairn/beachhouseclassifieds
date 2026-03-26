import { eq, sql } from "drizzle-orm";

import { databaseProvider, db, pgDb } from "@/core/server/db";
import {
  normalizeTimeZone,
  resolveUserTimeZone,
} from "@/core/shared/time-zone";
import { users as pgUsers } from "@/lib/db/schema-postgres";
import { users as sqliteUsers } from "@/lib/db/schema-sqlite";

let ensureStoragePromise: Promise<void> | null = null;

function asErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function ensureSqliteUserTimeZoneColumn() {
  const rows = db.all(sql`PRAGMA table_info('user')`) as Array<{
    name: string;
  }>;

  const hasTimeZoneColumn = rows.some((row) => row.name === "timeZone");

  if (!hasTimeZoneColumn) {
    db.run(sql`ALTER TABLE "user" ADD COLUMN "timeZone" TEXT`);
  }
}

async function ensurePostgresUserTimeZoneColumn() {
  if (!pgDb) {
    throw new Error("Postgres database is not configured.");
  }

  await pgDb.execute(
    sql`ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "timeZone" text`,
  );
}

async function ensureStorageInternal() {
  if (databaseProvider === "postgres") {
    await ensurePostgresUserTimeZoneColumn();
    return;
  }

  await ensureSqliteUserTimeZoneColumn();
}

export async function ensureUserTimeZoneStorageReady() {
  if (!ensureStoragePromise) {
    ensureStoragePromise = ensureStorageInternal().catch((error) => {
      ensureStoragePromise = null;
      throw error;
    });
  }

  await ensureStoragePromise;
}

export async function getStoredUserTimeZoneByUserId(userId: string) {
  await ensureUserTimeZoneStorageReady();

  if (databaseProvider === "postgres") {
    if (!pgDb) {
      throw new Error("Postgres database is not configured.");
    }

    const rows = await pgDb
      .select({ timeZone: pgUsers.timeZone })
      .from(pgUsers)
      .where(eq(pgUsers.id, userId))
      .limit(1);

    return rows[0]?.timeZone ?? null;
  }

  const row = db
    .select({ timeZone: sqliteUsers.timeZone })
    .from(sqliteUsers)
    .where(eq(sqliteUsers.id, userId))
    .limit(1)
    .get();

  return row?.timeZone ?? null;
}

export async function setStoredUserTimeZoneByUserId(
  userId: string,
  timeZone: string,
) {
  await ensureUserTimeZoneStorageReady();

  const normalizedTimeZone = normalizeTimeZone(timeZone);

  if (!normalizedTimeZone) {
    throw new Error(`Invalid IANA time zone '${timeZone}'.`);
  }

  if (databaseProvider === "postgres") {
    if (!pgDb) {
      throw new Error("Postgres database is not configured.");
    }

    await pgDb
      .update(pgUsers)
      .set({
        timeZone: normalizedTimeZone,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(pgUsers.id, userId));

    return;
  }

  db.update(sqliteUsers)
    .set({
      timeZone: normalizedTimeZone,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(sqliteUsers.id, userId))
    .run();
}

export async function setStoredUserTimeZoneByEmail(options: {
  email: string;
  timeZone: string;
}) {
  await ensureUserTimeZoneStorageReady();

  const normalizedTimeZone = normalizeTimeZone(options.timeZone);

  if (!normalizedTimeZone) {
    throw new Error(`Invalid IANA time zone '${options.timeZone}'.`);
  }

  if (databaseProvider === "postgres") {
    if (!pgDb) {
      throw new Error("Postgres database is not configured.");
    }

    const rows = await pgDb
      .select({ id: pgUsers.id })
      .from(pgUsers)
      .where(sql`lower(${pgUsers.email}) = lower(${options.email})`)
      .limit(1);

    const userId = rows[0]?.id;

    if (!userId) {
      return false;
    }

    await setStoredUserTimeZoneByUserId(userId, normalizedTimeZone);
    return true;
  }

  const row = db
    .select({ id: sqliteUsers.id })
    .from(sqliteUsers)
    .where(sql`lower(${sqliteUsers.email}) = lower(${options.email})`)
    .limit(1)
    .get();

  if (!row?.id) {
    return false;
  }

  await setStoredUserTimeZoneByUserId(row.id, normalizedTimeZone);
  return true;
}

export async function getEffectiveUserTimeZoneByUserId(userId: string) {
  try {
    const storedTimeZone = await getStoredUserTimeZoneByUserId(userId);
    return resolveUserTimeZone(storedTimeZone);
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
      console.error(
        `Failed to load user timezone for user '${userId}': ${asErrorMessage(error)}`,
      );
    }

    return resolveUserTimeZone(null);
  }
}
