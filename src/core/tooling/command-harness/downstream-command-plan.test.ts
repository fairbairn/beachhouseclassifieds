import { describe, expect, it } from "vitest";

import { planDownstreamCommand } from "@/core/tooling/command-harness/downstream-command-plan";

describe("planDownstreamCommand", () => {
  it("maps db:setup + sqlite to sqlite setup workflow", () => {
    const plan = planDownstreamCommand({
      mode: "db:setup",
      provider: "sqlite",
      command: "npm",
      commandArgs: ["run", "db:setup:raw"],
    });

    expect(plan.command).toBe("npm");
    expect(plan.commandArgs).toEqual(["run", "db:setup:sqlite:raw"]);
    expect(plan.plannedCommand).toBe("npm run db:setup:sqlite:raw");
  });

  it("maps db:setup + postgres to postgres setup workflow", () => {
    const plan = planDownstreamCommand({
      mode: "db:setup",
      provider: "postgres",
      command: "npm",
      commandArgs: ["run", "db:setup:raw"],
    });

    expect(plan.command).toBe("npm");
    expect(plan.commandArgs).toEqual(["run", "db:setup:postgres:raw"]);
    expect(plan.plannedCommand).toBe("npm run db:setup:postgres:raw");
  });

  it("maps db:seed + sqlite to sqlite seed workflow", () => {
    const plan = planDownstreamCommand({
      mode: "db:seed",
      provider: "sqlite",
      command: "npm",
      commandArgs: ["run", "db:seed:raw"],
    });

    expect(plan.command).toBe("npm");
    expect(plan.commandArgs).toEqual(["run", "db:seed:sqlite:raw"]);
    expect(plan.plannedCommand).toBe("npm run db:seed:sqlite:raw");
  });

  it("maps db:seed + postgres to postgres seed workflow", () => {
    const plan = planDownstreamCommand({
      mode: "db:seed",
      provider: "postgres",
      command: "npm",
      commandArgs: ["run", "db:seed:raw"],
    });

    expect(plan.command).toBe("npm");
    expect(plan.commandArgs).toEqual(["run", "db:seed:postgres:raw"]);
    expect(plan.plannedCommand).toBe("npm run db:seed:postgres:raw");
  });

  it("throws when db:setup provider is unknown", () => {
    expect(() =>
      planDownstreamCommand({
        mode: "db:setup",
        provider: "",
        command: "npm",
        commandArgs: ["run", "db:setup:raw"],
      }),
    ).toThrow("unknown DATABASE_PROVIDER");
  });

  it("throws when db:seed provider is unknown", () => {
    expect(() =>
      planDownstreamCommand({
        mode: "db:seed",
        provider: "",
        command: "npm",
        commandArgs: ["run", "db:seed:raw"],
      }),
    ).toThrow("unknown DATABASE_PROVIDER");
  });

  it("keeps arbitrary command passthrough", () => {
    const plan = planDownstreamCommand({
      mode: "dev",
      provider: "sqlite",
      command: "npm",
      commandArgs: ["run", "dev:raw"],
    });

    expect(plan.command).toBe("npm");
    expect(plan.commandArgs).toEqual(["run", "dev:raw"]);
    expect(plan.plannedCommand).toBe("npm run dev:raw");
  });
});
