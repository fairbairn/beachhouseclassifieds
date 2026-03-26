import { betterAuth } from "better-auth";
import { tanstackStartCookies } from "better-auth/tanstack-start";

const localhostBaseUrlPattern = /^https?:\/\/localhost(?::\d+)?$/;

function toNonEmptyString(value: string | undefined) {
  const trimmed = value?.trim();

  return trimmed ? trimmed : undefined;
}

function resolveAuthBaseUrl(options: {
  betterAuthBaseUrl?: string;
  betterAuthUrl?: string;
  netlifyContext?: string;
  netlifyDeployPrimeUrl?: string;
  netlifyDeployUrl?: string;
  netlifySiteUrl?: string;
  fallbackBaseUrl?: string;
}) {
  const context = toNonEmptyString(options.netlifyContext)?.toLowerCase();
  const betterAuthBaseUrl = toNonEmptyString(options.betterAuthBaseUrl);
  const betterAuthUrl = toNonEmptyString(options.betterAuthUrl);
  const netlifySiteUrl = toNonEmptyString(options.netlifySiteUrl);
  const netlifyDeployPrimeUrl = toNonEmptyString(options.netlifyDeployPrimeUrl);
  const netlifyDeployUrl = toNonEmptyString(options.netlifyDeployUrl);
  const fallbackBaseUrl = toNonEmptyString(options.fallbackBaseUrl);

  if (context === "production") {
    return (
      betterAuthBaseUrl ??
      betterAuthUrl ??
      netlifySiteUrl ??
      netlifyDeployPrimeUrl ??
      netlifyDeployUrl ??
      fallbackBaseUrl ??
      "http://localhost:3000"
    );
  }

  if (context === "deploy-preview" || context === "branch-deploy") {
    return (
      betterAuthBaseUrl ??
      betterAuthUrl ??
      netlifyDeployPrimeUrl ??
      netlifyDeployUrl ??
      netlifySiteUrl ??
      fallbackBaseUrl ??
      "http://localhost:3000"
    );
  }

  return (
    betterAuthBaseUrl ??
    betterAuthUrl ??
    netlifySiteUrl ??
    netlifyDeployPrimeUrl ??
    netlifyDeployUrl ??
    fallbackBaseUrl ??
    "http://localhost:3000"
  );
}

function resolveAuthSecret(options: {
  secret?: string;
  authBaseUrl: string;
  localhostFallbackSecret?: string;
}) {
  const isLocalhostBaseUrl = localhostBaseUrlPattern.test(options.authBaseUrl);
  const betterAuthSecret = toNonEmptyString(options.secret);
  const localhostFallbackSecret = toNonEmptyString(
    options.localhostFallbackSecret,
  );

  return (
    betterAuthSecret ??
    (isLocalhostBaseUrl ? localhostFallbackSecret : undefined)
  );
}

export function createBetterAuthRuntime(options: {
  database: unknown;
  betterAuthBaseUrl?: string;
  betterAuthUrl?: string;
  netlifyContext?: string;
  netlifyDeployPrimeUrl?: string;
  netlifyDeployUrl?: string;
  netlifySiteUrl?: string;
  fallbackBaseUrl?: string;
  betterAuthSecret?: string;
  localhostFallbackSecret?: string;
  missingSecretMessage?: string;
}) {
  const authBaseUrl = resolveAuthBaseUrl({
    betterAuthBaseUrl: options.betterAuthBaseUrl,
    betterAuthUrl: options.betterAuthUrl,
    netlifyContext: options.netlifyContext,
    netlifyDeployPrimeUrl: options.netlifyDeployPrimeUrl,
    netlifyDeployUrl: options.netlifyDeployUrl,
    netlifySiteUrl: options.netlifySiteUrl,
    fallbackBaseUrl: options.fallbackBaseUrl,
  });

  const authSecret = resolveAuthSecret({
    secret: options.betterAuthSecret,
    authBaseUrl,
    localhostFallbackSecret: options.localhostFallbackSecret,
  });

  if (!authSecret) {
    throw new Error(
      options.missingSecretMessage ??
        "Missing BETTER_AUTH_SECRET. Set BETTER_AUTH_SECRET in your environment for non-localhost environments.",
    );
  }

  return betterAuth({
    baseURL: authBaseUrl,
    secret: authSecret,
    database: options.database,
    emailAndPassword: {
      enabled: true,
    },
    plugins: [tanstackStartCookies()],
  });
}
