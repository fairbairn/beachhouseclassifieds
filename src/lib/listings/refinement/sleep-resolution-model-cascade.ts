const DEFAULT_SLEEP_RESOLUTION_MODEL_CASCADE = [
  "gpt-5.4-nano",
  "gpt-4.1-mini",
  "gpt-4.1",
] as const;

export function getDefaultSleepResolutionModelCascade(): string[] {
  return [...DEFAULT_SLEEP_RESOLUTION_MODEL_CASCADE];
}

export function resolveSleepResolutionModelCascadeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const cascadeEnv =
    env.LISTING_REFINEMENT_SLEEP_RESOLUTION_MODELS?.trim() ?? "";
  if (cascadeEnv.length > 0) {
    return Array.from(
      new Set(
        cascadeEnv
          .split(",")
          .map((model) => model.trim())
          .filter(Boolean),
      ),
    );
  }

  const singleModelOverride =
    env.LISTING_REFINEMENT_SLEEP_RESOLUTION_MODEL?.trim() ?? "";
  if (singleModelOverride.length > 0) {
    return [singleModelOverride];
  }

  return getDefaultSleepResolutionModelCascade();
}
