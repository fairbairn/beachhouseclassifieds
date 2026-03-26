import "@/core/tooling/env/load-env-profile";

import { runDbConnectivityCheck } from "@/core/tooling/db/ops/run-db-connectivity-check";

await runDbConnectivityCheck();
