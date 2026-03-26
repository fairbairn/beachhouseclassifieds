import "@/core/tooling/env/load-env-profile";
import { Client } from "pg";

import {
  normalizePostgresConnectionString,
  resolvePostgresTlsMode,
} from "@/core/server/postgres-connection-string";

async function run() {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error(
      "Missing DATABASE_URL. Example: postgresql://<user>:<password>@localhost:5432/<database>",
    );
  }

  const client = new Client({
    connectionString: normalizePostgresConnectionString(databaseUrl),
  });
  const tlsMode = resolvePostgresTlsMode(databaseUrl);

  await client.connect();

  try {
    const result = await client.query<{
      db: string;
      user_name: string;
      server_time: string;
    }>(
      "select current_database() as db, current_user as user_name, now()::text as server_time",
    );

    const row = result.rows[0];

    if (!row) {
      throw new Error("Connected, but query returned no rows.");
    }

    console.log("Postgres connection successful.");
    console.log(`db=${row.db}`);
    console.log(`user=${row.user_name}`);
    console.log(`tls_mode=${tlsMode}`);
    console.log(`server_time=${row.server_time}`);
  } finally {
    await client.end();
  }
}

await run();
