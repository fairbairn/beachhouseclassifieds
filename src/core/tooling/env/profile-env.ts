import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parse as parseEnv } from "dotenv";

export type EnvProfile = "local" | "dev" | "prod";

const profileAliases: Record<string, EnvProfile> = {
  local: "local",
  development: "dev",
  dev: "dev",
  production: "prod",
  prod: "prod",
};

export const envOverrideKeys = [
  "APP_ENV_PROFILE",
  "DATABASE_PROVIDER",
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_BASE_URL",
  "BETTER_AUTH_URL",
  "BETTER_AUTH_LOCALHOST_FALLBACK_SECRET",
  "APIFY_API_TOKEN",
  "APIFY_PROXY_GROUPS",
  "APIFY_PROXY_COUNTRY",
  "GOOGLE_MAPS_API_KEY",
] as const;

export function resolveProfile(value: string | undefined): EnvProfile {
  if (!value) {
    return "local";
  }

  return profileAliases[value.trim().toLowerCase()] ?? "local";
}

export function profileEnvFilename(profile: EnvProfile) {
  if (profile === "dev") {
    return ".env.dev";
  }

  if (profile === "prod") {
    return ".env.prod";
  }

  return ".env.local";
}

function readEnvFile(path: string) {
  if (!existsSync(path)) {
    return {};
  }

  return parseEnv(readFileSync(path, "utf8"));
}

export function resolveProfileEnvironment(options?: {
  profileValue?: string;
  rootDir?: string;
  processEnv?: NodeJS.ProcessEnv;
}) {
  const processEnv = options?.processEnv ?? process.env;
  const rootDir = options?.rootDir ?? process.cwd();
  const profile = resolveProfile(
    options?.profileValue ?? processEnv.APP_ENV_PROFILE,
  );

  const explicitOverrides = Object.fromEntries(
    envOverrideKeys.map((key) => [key, processEnv[key]]),
  ) as Record<(typeof envOverrideKeys)[number], string | undefined>;

  const baseEnv = readEnvFile(resolve(rootDir, ".env"));
  const profileEnv = readEnvFile(resolve(rootDir, profileEnvFilename(profile)));

  const resolvedEnv: NodeJS.ProcessEnv = {
    ...baseEnv,
    ...profileEnv,
  };

  for (const key of envOverrideKeys) {
    const value = explicitOverrides[key];

    if (value !== undefined) {
      resolvedEnv[key] = value;
    }
  }

  return {
    profile,
    resolvedEnv,
  };
}
