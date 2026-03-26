import {
  envOverrideKeys,
  resolveProfileEnvironment,
} from "@/core/tooling/env/profile-env";

function loadEnv() {
  const { resolvedEnv } = resolveProfileEnvironment();

  for (const key of envOverrideKeys) {
    const value = resolvedEnv[key];

    if (value !== undefined) {
      process.env[key] = value;
    }
  }
}

loadEnv();
