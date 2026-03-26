import "@/core/tooling/env/load-env-profile";

import { bootstrapDbRuntime } from "@/core/tooling/db/bootstrap/bootstrap-db-runtime";

await bootstrapDbRuntime({
  // The baseline scaffold has no additional sqlite domain bootstrap yet.
  runSqliteBootstrap: async () => {},
});
