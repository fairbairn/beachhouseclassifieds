import { runDbTargetCli } from "@/core/tooling/db/targets/db-target-cli";

const usage =
  "Usage: tsx src/core/scripts/setup-db.ts [--target <target>] -- <command> [args...]";

const protectedModes = ["db:setup"];

await runDbTargetCli({
  argv: process.argv.slice(2),
  usage,
  protectedModes,
});
