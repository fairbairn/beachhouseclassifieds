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
  "STAYON30A_HEADLESS",
  "STAYON30A_USER_AGENT",
  "STAYON30A_SKIP_LANDING",
  "STAYON30A_PRICING_FIRST",
  "STAYON30A_FALLBACK_AVAILABILITY",
  "STAYON30A_HTTPS_PROXY",
  "STAYON30A_HTTP_PROXY",
  "STAYON30A_PROXY",
  "DUNEVR30A_HEADLESS",
  "DUNEVR30A_USER_AGENT",
  "DUNEVR30A_SKIP_LANDING",
  "DUNEVR30A_PRICING_FIRST",
  "DUNEVR30A_FALLBACK_AVAILABILITY",
  "DUNEVR30A_HTTPS_PROXY",
  "DUNEVR30A_HTTP_PROXY",
  "DUNEVR30A_PROXY",
  "ROSEMARY30A_HEADLESS",
  "ROSEMARY30A_USER_AGENT",
  "ROSEMARY30A_SKIP_LANDING",
  "ROSEMARY30A_PRICING_FIRST",
  "ROSEMARY30A_FALLBACK_AVAILABILITY",
  "ROSEMARY30A_HTTPS_PROXY",
  "ROSEMARY30A_HTTP_PROXY",
  "ROSEMARY30A_PROXY",
  "ROSEMARY30A_STEALTH",
  "ROSEMARY30A_REAL_CHROME",
  "ROSEMARY30A_CF_CLEARANCE",
  "ROSEMARY30A_CF_BM",
  "COASTPROPERTIES30A_HEADLESS",
  "COASTPROPERTIES30A_USER_AGENT",
  "COASTPROPERTIES30A_SKIP_LANDING",
  "COASTPROPERTIES30A_PRICING_FIRST",
  "COASTPROPERTIES30A_FALLBACK_AVAILABILITY",
  "COASTPROPERTIES30A_HTTPS_PROXY",
  "COASTPROPERTIES30A_HTTP_PROXY",
  "COASTPROPERTIES30A_PROXY",
  "30ABEACH_HEADLESS",
  "30ABEACH_USER_AGENT",
  "30ABEACH_SKIP_LANDING",
  "30ABEACH_PRICING_FIRST",
  "30ABEACH_FALLBACK_AVAILABILITY",
  "30ABEACH_HTTPS_PROXY",
  "30ABEACH_HTTP_PROXY",
  "30ABEACH_PROXY",
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
