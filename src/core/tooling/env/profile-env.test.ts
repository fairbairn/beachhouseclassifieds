import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveDatabaseTargetEnvironment } from "@/core/tooling/db/targets/db-targets";
import { resolveProfileEnvironment } from "@/core/tooling/env/profile-env";

function writeEnvFile(dir: string, name: string, content: string) {
  writeFileSync(join(dir, name), content, "utf8");
}

const cwdBeforeSuite = process.cwd();

afterEach(() => {
  process.chdir(cwdBeforeSuite);
});

describe("resolveProfileEnvironment", () => {
  it("resolves DATABASE_URL from selected profile file", () => {
    const tempDir = mkdtempSync(join(cwdBeforeSuite, ".tmp-profile-env-"));

    try {
      writeEnvFile(
        tempDir,
        ".env.local",
        "DATABASE_URL=postgresql://local-db/app_local\n",
      );
      writeEnvFile(
        tempDir,
        ".env.dev",
        "DATABASE_URL=postgresql://dev-db/app_dev\n",
      );

      const local = resolveProfileEnvironment({
        rootDir: tempDir,
        profileValue: "local",
        processEnv: {},
      });
      const dev = resolveProfileEnvironment({
        rootDir: tempDir,
        profileValue: "dev",
        processEnv: {},
      });

      expect(local.resolvedEnv.DATABASE_URL).toBe(
        "postgresql://local-db/app_local",
      );
      expect(dev.resolvedEnv.DATABASE_URL).toBe("postgresql://dev-db/app_dev");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps explicit process env overrides over profile file values", () => {
    const tempDir = mkdtempSync(join(cwdBeforeSuite, ".tmp-profile-env-"));

    try {
      writeEnvFile(
        tempDir,
        ".env.dev",
        "DATABASE_URL=postgresql://dev-db/app_dev\n",
      );

      const resolved = resolveProfileEnvironment({
        rootDir: tempDir,
        profileValue: "dev",
        processEnv: {
          DATABASE_URL: "postgresql://override/app_override",
        },
      });

      expect(resolved.resolvedEnv.DATABASE_URL).toBe(
        "postgresql://override/app_override",
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("resolveDatabaseTargetEnvironment", () => {
  it("uses selected target profile for postgres DATABASE_URL", () => {
    const tempDir = mkdtempSync(join(cwdBeforeSuite, ".tmp-profile-env-"));
    const previousDatabaseUrl = process.env.DATABASE_URL;
    const previousAppEnvProfile = process.env.APP_ENV_PROFILE;

    try {
      delete process.env.DATABASE_URL;
      delete process.env.APP_ENV_PROFILE;

      writeEnvFile(
        tempDir,
        ".env.local",
        "DATABASE_URL=postgresql://local-db/app_local\n",
      );
      writeEnvFile(
        tempDir,
        ".env.dev",
        "DATABASE_URL=postgresql://dev-db/app_dev\n",
      );

      process.chdir(tempDir);

      const localTargetEnv = resolveDatabaseTargetEnvironment("postgres:local");
      const devTargetEnv = resolveDatabaseTargetEnvironment("postgres:dev");

      expect(localTargetEnv.DATABASE_URL).toBe(
        "postgresql://local-db/app_local",
      );
      expect(devTargetEnv.DATABASE_URL).toBe("postgresql://dev-db/app_dev");
      expect(localTargetEnv.DATABASE_PROVIDER).toBe("postgres");
      expect(devTargetEnv.APP_ENV_PROFILE).toBe("dev");
    } finally {
      if (previousDatabaseUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = previousDatabaseUrl;
      }

      if (previousAppEnvProfile === undefined) {
        delete process.env.APP_ENV_PROFILE;
      } else {
        process.env.APP_ENV_PROFILE = previousAppEnvProfile;
      }

      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("forces sqlite target provider and empty url", () => {
    const sqliteTargetEnv = resolveDatabaseTargetEnvironment("sqlite:local");

    expect(sqliteTargetEnv.DATABASE_PROVIDER).toBe("sqlite");
    expect(sqliteTargetEnv.DATABASE_URL).toBe("");
    expect(sqliteTargetEnv.APP_ENV_PROFILE).toBe("local");
  });
});
