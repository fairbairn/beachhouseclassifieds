import { defineConfig } from "drizzle-kit";

import "./src/core/tooling/env/load-env-profile";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    "Missing DATABASE_URL for drizzle Postgres config. Set DATABASE_URL in the active env profile.",
  );
}

export default defineConfig({
  out: "./drizzle/pg",
  schema: "./src/lib/db/schema-postgres-drizzle.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: databaseUrl,
  },
  strict: true,
  verbose: true,
});
