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
  "NODE_USE_ENV_PROXY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
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
  "OPENAI_API_KEY",
  "DISCOVER_SEARCH_BACKEND",
  "MEILISEARCH_HOST",
  "MEILISEARCH_API_KEY",
  "MEILISEARCH_DISCOVER_INDEX",
  "STAYON30A_QUOTE_RUNTIME_V2",
  "STAYON30A_V2_PROXY_URL",
  "STAYON30A_V2_PROXY_ARRAY",
  "STAYON30A_V2_HEADLESS",
  "STAYON30A_V2_USER_AGENT",
  "STAYON30A_V2_SKIP_LANDING",
] as const;

const localProfileFileAuthorityKeys = new Set<string>([
  "DISCOVER_SEARCH_BACKEND",
  "MEILISEARCH_HOST",
  "MEILISEARCH_API_KEY",
  "MEILISEARCH_DISCOVER_INDEX",
]);

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
    if (profile === "local" && localProfileFileAuthorityKeys.has(key)) {
      continue;
    }

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
