import "@/core/tooling/env/load-env-profile";

import { runAuthMigrations } from "@/core/tooling/db/ops/run-auth-migrations";

await runAuthMigrations();
