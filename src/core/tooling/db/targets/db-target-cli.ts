import { runDbTargetRuntime } from "@/core/tooling/db/targets/db-target-runtime";

type RunDbTargetCliOptions = {
  argv: Array<string>;
  usage: string;
  protectedModes: Array<string>;
  blockedTargets?: Array<string>;
  previewBaseUrl?: string;
  allowProdMutationOverrideEnvVar?: string;
};

function normalize(value: string) {
  return value.trim().toLowerCase();
}

function createTargetBlockReason(options: {
  protectedModes: Array<string>;
  blockedTargets: Array<string>;
  allowProdMutationOverrideEnvVar: string;
  buildMessage?: (context: { mode: string; target: string }) => string;
}) {
  const protectedModeSet = new Set(options.protectedModes.map(normalize));
  const blockedTargetSet = new Set(options.blockedTargets.map(normalize));

  return (context: { mode: string; target: string }) => {
    const normalizedMode = normalize(context.mode);
    const normalizedTarget = normalize(context.target);
    const isProdMutationMode =
      normalizedTarget === "postgres:prod" &&
      (normalizedMode === "db:setup" || normalizedMode === "db:seed");
    const allowProdMutationOverride =
      process.env[options.allowProdMutationOverrideEnvVar]?.trim() === "true";

    if (!protectedModeSet.has(normalizedMode)) {
      return null;
    }

    if (isProdMutationMode && allowProdMutationOverride) {
      return null;
    }

    if (!blockedTargetSet.has(normalizedTarget)) {
      return null;
    }

    if (options.buildMessage) {
      return options.buildMessage({
        mode: context.mode,
        target: context.target,
      });
    }

    return `Refusing to run ${context.mode} against target '${context.target}'.`;
  };
}

export async function runDbTargetCli(options: RunDbTargetCliOptions) {
  const allowProdMutationOverrideEnvVar =
    options.allowProdMutationOverrideEnvVar ?? "DB_MUTATION_ALLOW_PROD";

  const getBlockedReason = createTargetBlockReason({
    protectedModes: options.protectedModes,
    blockedTargets: options.blockedTargets ?? ["postgres:prod"],
    allowProdMutationOverrideEnvVar,
    buildMessage: ({ mode, target }) =>
      target === "postgres:prod" && (mode === "db:setup" || mode === "db:seed")
        ? `Refusing to run ${mode} against target '${target}'. Set ${allowProdMutationOverrideEnvVar}=true to allow this intentionally.`
        : `Refusing to run ${mode} against target '${target}'. This routine is restricted to local targets only.`,
  });

  await runDbTargetRuntime({
    argv: options.argv,
    usage: options.usage,
    getAdditionalEnvironment: ({ mode }) => {
      const effectiveBetterAuthBaseUrl =
        process.env.BETTER_AUTH_BASE_URL ??
        process.env.BETTER_AUTH_URL ??
        (mode === "prod"
          ? (options.previewBaseUrl ?? "http://localhost:4173")
          : undefined);

      if (effectiveBetterAuthBaseUrl && !process.env.BETTER_AUTH_BASE_URL) {
        return {
          BETTER_AUTH_BASE_URL: effectiveBetterAuthBaseUrl,
        };
      }

      return undefined;
    },
    getBlockedReason,
  });
}
