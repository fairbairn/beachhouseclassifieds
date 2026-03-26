import chalk from "chalk";
import Table from "cli-table3";

import { databaseProvider, pgDb, pgPool, sqliteDb } from "@/core/server/db";
import { resolvePostgresTlsMode } from "@/core/server/postgres-connection-string";

type SqliteTableRow = {
  name: string;
};

type PostgresIdentityRow = {
  db: string;
  user_name: string;
  server_time: string;
};

type PostgresTableRow = {
  table_schema: string;
  table_name: string;
};

type TableCountRow = {
  tableName: string;
  rowCount: number | null;
};

function isLocalHost(host: string) {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1"
  );
}

function assertPostgresPolicyChecks() {
  const databaseUrl = process.env.DATABASE_URL?.trim();

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for postgres checks.");
  }

  const profile = process.env.APP_ENV_PROFILE?.trim().toLowerCase() ?? "local";
  const betterAuthSecret = process.env.BETTER_AUTH_SECRET?.trim();

  let parsed: URL;

  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL is not a valid URL.");
  }

  const databaseName = parsed.pathname.replace(/^\//, "").toLowerCase();
  const host = parsed.hostname;

  if (profile !== "prod" && databaseName.endsWith("_prod")) {
    throw new Error(
      `Profile '${profile}' is not allowed to target production database '${databaseName}'. Update APP_ENV_PROFILE or DATABASE_URL.`,
    );
  }

  if (profile === "prod" && databaseName.endsWith("_dev")) {
    throw new Error(
      `Profile 'prod' is not allowed to target development database '${databaseName}'. Update APP_ENV_PROFILE or DATABASE_URL.`,
    );
  }

  if (!isLocalHost(host) && !betterAuthSecret) {
    throw new Error(
      "Remote Postgres target requires BETTER_AUTH_SECRET to be explicitly set. Add BETTER_AUTH_SECRET to the active env profile.",
    );
  }
}

function printTableCounts(rows: Array<TableCountRow>) {
  if (rows.length === 0) {
    console.log(chalk.gray("No tables found."));
    return;
  }

  console.log(chalk.cyan("Tables:"));

  const table = new Table({
    head: ["#", "Table", "Rows"],
    style: { head: ["cyan"] },
    wordWrap: true,
  });

  rows.forEach((row, index) => {
    table.push([
      String(index + 1),
      row.tableName,
      row.rowCount === null ? "(unavailable)" : String(row.rowCount),
    ]);
  });

  console.log(table.toString());
}

function quoteIdentifier(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

function getSqliteTableCount(tableName: string) {
  try {
    const escapedTableName = quoteIdentifier(tableName);
    const row = sqliteDb
      .prepare<{
        row_count: number;
      }>(`select count(*) as row_count from ${escapedTableName}`)
      .get();

    return row?.row_count ?? 0;
  } catch {
    return null;
  }
}

async function getPostgresTableCount(options: {
  schema: string;
  table: string;
}) {
  if (!pgPool) {
    return null;
  }

  try {
    const escapedSchema = quoteIdentifier(options.schema);
    const escapedTable = quoteIdentifier(options.table);
    const result = await pgPool.query<{ row_count: string }>(
      `select count(*)::text as row_count from ${escapedSchema}.${escapedTable}`,
    );

    const value = result.rows[0]?.row_count;

    if (!value) {
      return 0;
    }

    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return null;
  }

  tables.forEach((tableName, index) => {
    console.log(`${index + 1}. ${tableName}`);
  });
}

async function runSqliteConnectivityCheck() {
  const row = sqliteDb
    .prepare<{
      db: string;
      server_time: string;
    }>("select 'main' as db, datetime('now') as server_time")
    .get();

  if (!row) {
    throw new Error(
      "Connected to SQLite, but identity query returned no rows.",
    );
  }

  const tableRows = sqliteDb
    .prepare<SqliteTableRow>(
      `
        select name
        from sqlite_master
        where type = 'table'
          and name not like 'sqlite_%'
        order by name asc
      `,
    )
    .all();

  const tableCounts = tableRows.map((entry) => ({
    tableName: entry.name,
    rowCount: getSqliteTableCount(entry.name),
  }));

  console.log(chalk.green("SQLite connectivity check successful."));
  console.log(`db=${row.db}`);
  console.log(`server_time=${row.server_time}`);
  printTableCounts(tableCounts);
}

async function runPostgresConnectivityCheck() {
  if (!pgPool || !pgDb) {
    throw new Error("Postgres database is not configured.");
  }

  assertPostgresPolicyChecks();

  const tlsMode = resolvePostgresTlsMode(process.env.DATABASE_URL ?? "");

  const identityResult = await pgPool.query<PostgresIdentityRow>(
    "select current_database() as db, current_user as user_name, now()::text as server_time",
  );

  const identity = identityResult.rows[0];

  if (!identity) {
    throw new Error(
      "Connected to Postgres, but identity query returned no rows.",
    );
  }

  const tablesResult = await pgPool.query<PostgresTableRow>(
    `
      select table_schema, table_name
      from information_schema.tables
      where table_schema not in ('pg_catalog', 'information_schema')
        and table_type = 'BASE TABLE'
      order by table_schema asc, table_name asc
    `,
  );

  const tableCounts: Array<TableCountRow> = [];

  for (const entry of tablesResult.rows) {
    const tableName = `${entry.table_schema}.${entry.table_name}`;
    const rowCount = await getPostgresTableCount({
      schema: entry.table_schema,
      table: entry.table_name,
    });

    tableCounts.push({
      tableName,
      rowCount,
    });
  }

  console.log(chalk.green("Postgres connectivity check successful."));
  console.log(`db=${identity.db}`);
  console.log(`user=${identity.user_name}`);
  console.log(`tls_mode=${tlsMode}`);
  console.log(`server_time=${identity.server_time}`);
  printTableCounts(tableCounts);
}

export async function runDbConnectivityCheck() {
  if (databaseProvider === "sqlite") {
    await runSqliteConnectivityCheck();
    return;
  }

  if (databaseProvider === "postgres") {
    try {
      await runPostgresConnectivityCheck();
    } finally {
      if (pgPool) {
        await pgPool.end();
      }
    }

    return;
  }

  throw new Error(
    `db:check requires DATABASE_PROVIDER to be sqlite or postgres. Received '${databaseProvider}'.`,
  );
}
