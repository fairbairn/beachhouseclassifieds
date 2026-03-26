import { describe, expect, it } from "vitest";

import { planDownstreamCommand } from "@/core/tooling/command-harness/downstream-command-plan";
import { resolveDatabaseTargetEnvironment } from "@/core/tooling/db/targets/db-targets";

describe("db:seed intent environment", () => {
  it("uses sqlite provider with empty DATABASE_URL for sqlite:local", () => {
    const targetEnv = resolveDatabaseTargetEnvironment("sqlite:local");

    expect(targetEnv.DATABASE_PROVIDER).toBe("sqlite");
    expect(targetEnv.DATABASE_URL).toBe("");
    expect(targetEnv.APP_ENV_PROFILE).toBe("local");

    const plan = planDownstreamCommand({
      mode: "db:seed",
      provider: String(targetEnv.DATABASE_PROVIDER ?? ""),
      command: "npm",
      commandArgs: ["run", "db:seed:raw"],
    });

    expect(plan.commandArgs).toEqual(["run", "db:seed:sqlite:raw"]);
  });

  it("uses postgres provider and postgres seed routing for postgres:local", () => {
    const targetEnv = resolveDatabaseTargetEnvironment("postgres:local");

    expect(targetEnv.DATABASE_PROVIDER).toBe("postgres");
    expect(typeof targetEnv.DATABASE_URL).toBe("string");
    expect(targetEnv.APP_ENV_PROFILE).toBe("local");

    const plan = planDownstreamCommand({
      mode: "db:seed",
      provider: String(targetEnv.DATABASE_PROVIDER ?? ""),
      command: "npm",
      commandArgs: ["run", "db:seed:raw"],
    });

    expect(plan.commandArgs).toEqual(["run", "db:seed:postgres:raw"]);
  });
});
