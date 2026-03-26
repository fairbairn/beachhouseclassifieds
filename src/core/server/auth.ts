import { createBetterAuthRuntime } from "@/core/server/better-auth-runtime";
import { authDatabase } from "@/core/server/db";

// Server auth runtime configuration shared by API routes/session resolvers.
export const auth = createBetterAuthRuntime({
  database: authDatabase,
  betterAuthBaseUrl: process.env.BETTER_AUTH_BASE_URL,
  betterAuthUrl: process.env.BETTER_AUTH_URL,
  netlifyContext: process.env.CONTEXT,
  netlifyDeployPrimeUrl: process.env.DEPLOY_PRIME_URL,
  netlifyDeployUrl: process.env.DEPLOY_URL,
  netlifySiteUrl: process.env.URL,
  betterAuthSecret: process.env.BETTER_AUTH_SECRET,
  fallbackBaseUrl: "http://localhost:3000",
  localhostFallbackSecret:
    process.env.BETTER_AUTH_LOCALHOST_FALLBACK_SECRET ?? "local-preview-secret",
});
