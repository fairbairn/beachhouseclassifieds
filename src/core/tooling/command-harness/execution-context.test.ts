import { describe, expect, it } from "vitest";

import {
  assertExecutionContextOperationalValues,
  buildExecutionContext,
  formatExecutionContextBanner,
  inferExecutionMode,
  validateExecutionContextOperationalValues,
  validateRequestedLabel,
} from "@/core/tooling/command-harness/execution-context";

describe("inferExecutionMode", () => {
  it("infers dev mode from npm run dev:raw", () => {
    expect(inferExecutionMode("npm", ["run", "dev:raw"])).toBe("dev");
  });

  it("infers setup mode from npm run db:setup:raw", () => {
    expect(inferExecutionMode("npm", ["run", "db:setup:raw"])).toBe("db:setup");
  });

  it("infers seed mode from npm run db:seed:raw", () => {
    expect(inferExecutionMode("npm", ["run", "db:seed:raw"])).toBe("db:seed");
  });

  it("infers prod mode from vite preview command", () => {
    expect(inferExecutionMode("vite", ["preview"])).toBe("prod");
  });

  it("falls back to requested label when command is unknown", () => {
    expect(inferExecutionMode("custom", ["x"], "my:label")).toBe("my:label");
  });
});

describe("validateRequestedLabel", () => {
  it("flags postgres label with sqlite provider as mismatch", () => {
    const result = validateRequestedLabel({
      requestedLabel: "db:postgres:setup",
      provider: "sqlite",
    });

    expect(result.status).toBe("mismatch");
    expect(result.message).toContain("postgres");
  });

  it("returns ok for neutral label", () => {
    const result = validateRequestedLabel({
      requestedLabel: "db:setup",
      provider: "sqlite",
    });

    expect(result.status).toBe("ok");
  });
});

describe("execution banner formatting", () => {
  it("includes core resolved context fields", () => {
    const context = buildExecutionContext({
      requestedLabel: "db:setup",
      command: "npm",
      commandArgs: ["run", "db:setup:raw"],
      plannedCommand: "npm run db:setup:raw",
      target: "sqlite:local",
      targetLabel: "SQLite Local",
      envProfile: "local",
      databaseProvider: "sqlite",
      databaseUrl: "",
    });

    const banner = formatExecutionContextBanner(context);

    expect(banner).toContain("Mode");
    expect(banner).toContain("db:setup");
    expect(banner).toContain("Script");
    expect(banner).toContain("npm run db:setup:raw");
    expect(banner).toContain("Target");
    expect(banner).toContain("SQLite Local (sqlite:local)");
    expect(banner).toContain("Provider");
    expect(banner).toContain("sqlite");
    expect(banner).toContain("Auth Base URL");
    expect(banner).toContain("http://localhost:3000");
    expect(banner).toContain("Auth Secret");
    expect(banner).toContain("missing");
    expect(context.warnings).toEqual([]);
  });

  it("reflects resolved mode from command rather than requested label", () => {
    const context = buildExecutionContext({
      requestedLabel: "db:postgres:setup",
      command: "npm",
      commandArgs: ["run", "db:setup:raw"],
      target: "sqlite:local",
      targetLabel: "SQLite Local",
      envProfile: "local",
      databaseProvider: "sqlite",
      databaseUrl: "",
    });

    expect(context.mode).toBe("db:setup");
    expect(context.provider).toBe("sqlite");
    expect(context.envProfile).toBe("local");
    expect(context.target).toBe("sqlite:local");
  });

  it("shows postgres dev target context values as resolved", () => {
    const context = buildExecutionContext({
      requestedLabel: "prod",
      command: "npm",
      commandArgs: ["run", "prod:raw"],
      target: "postgres:dev",
      targetLabel: "Postgres Dev",
      envProfile: "dev",
      databaseProvider: "postgres",
      databaseUrl: "postgresql://dev-host/app_dev",
    });

    expect(context.mode).toBe("prod");
    expect(context.provider).toBe("postgres");
    expect(context.envProfile).toBe("dev");
    expect(context.databaseUrl).toBe("postgresql://dev-host/app_dev");
    expect(context.betterAuthBaseUrl).toBe("http://localhost:4173");
    expect(context.betterAuthSecretConfigured).toBe(false);
    expect(context.warnings.length).toBe(1);
    expect(context.warnings[0]).toContain("http://localhost:4173");

    const banner = formatExecutionContextBanner(context);
    expect(banner).toContain("Postgres Dev (postgres:dev)");
    expect(banner).toContain("postgres");
    expect(banner).toContain("dev");
    expect(banner).toContain("Warning");
  });

  it("does not warn in prod mode when BETTER_AUTH_BASE_URL is explicitly set", () => {
    const context = buildExecutionContext({
      requestedLabel: "prod",
      command: "npm",
      commandArgs: ["run", "prod:raw"],
      target: "postgres:prod",
      targetLabel: "Postgres Prod",
      envProfile: "prod",
      databaseProvider: "postgres",
      databaseUrl: "postgresql://prod-host/app",
      betterAuthBaseUrl: "http://localhost:4173",
      betterAuthSecret: "abc123",
    });

    expect(context.warnings).toEqual([]);
    expect(formatExecutionContextBanner(context)).not.toContain("Warning");
  });

  it("includes label check row when label mismatches provider", () => {
    const context = buildExecutionContext({
      requestedLabel: "db:postgres:setup",
      command: "npm",
      commandArgs: ["run", "db:setup:raw"],
      target: "sqlite:local",
      targetLabel: "SQLite Local",
      envProfile: "local",
      databaseProvider: "sqlite",
      databaseUrl: "",
    });

    const banner = formatExecutionContextBanner(context);

    expect(banner).toContain("Label Check");
    expect(banner).toContain("mentions postgres");
  });

  it("redacts password in DATABASE_URL banner display", () => {
    const context = buildExecutionContext({
      requestedLabel: "db:seed",
      command: "npm",
      commandArgs: ["run", "db:seed:raw"],
      target: "postgres:local",
      targetLabel: "Postgres Local",
      envProfile: "local",
      databaseProvider: "postgres",
      databaseUrl:
        "postgresql://postgres:supersecret@localhost:5432/app_local",
    });

    const banner = formatExecutionContextBanner(context);

    expect(banner).toContain(
      "postgresql://postgres:***@localhost:5432/app_local",
    );
    expect(banner).not.toContain("supersecret");
  });
});

describe("validateExecutionContextOperationalValues", () => {
  it("returns error when postgres context has no database url", () => {
    const errors = validateExecutionContextOperationalValues({
      mode: "dev",
      target: "postgres:local",
      targetLabel: "Postgres Local",
      provider: "postgres",
      envProfile: "local",
      databaseUrl: "(not set)",
      betterAuthBaseUrl: "http://localhost:3000",
      betterAuthSecretConfigured: false,
      warnings: [],
    });

    expect(errors.some((value) => value.includes("DATABASE_URL"))).toBe(true);
  });

  it("returns error when target/provider are mismatched", () => {
    const errors = validateExecutionContextOperationalValues({
      mode: "dev",
      target: "postgres:dev",
      targetLabel: "Postgres Dev",
      provider: "sqlite",
      envProfile: "dev",
      databaseUrl: "",
      betterAuthBaseUrl: "http://localhost:3000",
      betterAuthSecretConfigured: false,
      warnings: [],
    });

    expect(
      errors.some((value) => value.includes("requires provider 'postgres'")),
    ).toBe(true);
  });

  it("returns error when target/profile are mismatched", () => {
    const errors = validateExecutionContextOperationalValues({
      mode: "dev",
      target: "postgres:dev",
      targetLabel: "Postgres Dev",
      provider: "postgres",
      envProfile: "local",
      databaseUrl: "postgresql://dev-host/app_dev",
      betterAuthBaseUrl: "http://localhost:3000",
      betterAuthSecretConfigured: false,
      warnings: [],
    });

    expect(
      errors.some((value) => value.includes("requires env profile 'dev'")),
    ).toBe(true);
  });

  it("returns error for invalid target shape", () => {
    const errors = validateExecutionContextOperationalValues({
      mode: "dev",
      target: "postgres",
      targetLabel: "Postgres",
      provider: "postgres",
      envProfile: "dev",
      databaseUrl: "postgresql://dev-host/app_dev",
      betterAuthBaseUrl: "http://localhost:3000",
      betterAuthSecretConfigured: false,
      warnings: [],
    });

    expect(
      errors.some((value) =>
        value.includes("Resolved target 'postgres' is invalid"),
      ),
    ).toBe(true);
  });

  it("throws aggregated error details when context is invalid", () => {
    expect(() =>
      assertExecutionContextOperationalValues({
        mode: "prod",
        target: "postgres:prod",
        targetLabel: "Postgres Prod",
        provider: "postgres",
        envProfile: "prod",
        databaseUrl: "(not set)",
        betterAuthBaseUrl: "http://localhost:3000",
        betterAuthSecretConfigured: false,
        warnings: [],
      }),
    ).toThrow("Invalid command execution context");
  });

  it("downgrades missing DATABASE_URL to warning for db setup mode", () => {
    const context = {
      mode: "db:setup" as const,
      target: "postgres:dev" as const,
      targetLabel: "Postgres Dev",
      provider: "postgres" as const,
      envProfile: "dev" as const,
      databaseUrl: "(not set)",
      betterAuthBaseUrl: "http://localhost:3000",
      betterAuthSecretConfigured: false,
      warnings: [] as Array<string>,
    };

    const errors = validateExecutionContextOperationalValues(context);
    expect(
      errors.some((value) => value.includes("requires DATABASE_URL")),
    ).toBe(true);

    expect(() =>
      assertExecutionContextOperationalValues(context),
    ).not.toThrow();
    expect(
      context.warnings.some((value) => value.includes("Missing DATABASE_URL")),
    ).toBe(true);
  });
});
