import { beforeEach, describe, expect, it, vi } from "vitest";

import { runDbTargetCli } from "@/core/tooling/db/targets/db-target-cli";
import { runDbTargetRuntime } from "@/core/tooling/db/targets/db-target-runtime";

vi.mock("@/core/tooling/db/targets/db-target-runtime", () => ({
  runDbTargetRuntime: vi.fn(async () => {}),
}));

function getRuntimeOptionsCall() {
  const runtimeMock = vi.mocked(runDbTargetRuntime);
  expect(runtimeMock).toHaveBeenCalledTimes(1);

  return runtimeMock.mock.calls[0]?.[0];
}

describe("runDbTargetCli", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.DB_MUTATION_ALLOW_PROD;
  });

  it("allows postgres:dev for db:seed by default", async () => {
    await runDbTargetCli({
      argv: [],
      usage: "Usage: test",
      protectedModes: ["db:setup", "db:seed"],
    });

    const runtimeOptions = getRuntimeOptionsCall();
    const blockedReason = runtimeOptions?.getBlockedReason?.({
      mode: "db:seed",
      target: "postgres:dev",
      childEnv: {},
      parsedMode: "db:seed",
      command: "npm",
      commandArgs: ["run", "db:seed:raw"],
    });

    expect(blockedReason).toBeNull();
  });

  it("allows postgres:prod for db:seed when override env is true", async () => {
    process.env.DB_MUTATION_ALLOW_PROD = "true";

    await runDbTargetCli({
      argv: [],
      usage: "Usage: test",
      protectedModes: ["db:setup", "db:seed"],
    });

    const runtimeOptions = getRuntimeOptionsCall();
    const blockedReason = runtimeOptions?.getBlockedReason?.({
      mode: "db:seed",
      target: "postgres:prod",
      childEnv: {},
      parsedMode: "db:seed",
      command: "npm",
      commandArgs: ["run", "db:seed:raw"],
    });

    expect(blockedReason).toBeNull();
  });

  it("keeps postgres:prod blocked for db:setup", async () => {
    await runDbTargetCli({
      argv: [],
      usage: "Usage: test",
      protectedModes: ["db:setup", "db:seed"],
    });

    const runtimeOptions = getRuntimeOptionsCall();
    const blockedReason = runtimeOptions?.getBlockedReason?.({
      mode: "db:setup",
      target: "postgres:prod",
      childEnv: {},
      parsedMode: "db:setup",
      command: "npm",
      commandArgs: ["run", "db:setup:raw"],
    });

    expect(blockedReason).toContain("Refusing to run db:setup");
    expect(blockedReason).toContain("postgres:prod");
    expect(blockedReason).toContain("DB_MUTATION_ALLOW_PROD=true");
  });
});
