import { spawn } from "node:child_process";

import "@/core/tooling/env/load-env-profile";

const mode = process.argv[2]?.trim() || "postgres";

const child = spawn(
  "bash",
  ["src/core/tooling/db/ops/run-local-postgres.sh", mode],
  {
    stdio: "inherit",
    env: process.env,
  },
);

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});

child.on("close", (code) => {
  process.exit(code ?? 1);
});
