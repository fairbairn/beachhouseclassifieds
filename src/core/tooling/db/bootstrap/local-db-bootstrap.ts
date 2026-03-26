import {
  loadLocalSeedUsers,
  type LocalSeedUser,
} from "@/core/tooling/db/bootstrap/local-seed-users";

type DatabaseProvider = "sqlite" | "postgres";

type LocalDbBootstrapOptions = {
  databaseProvider: DatabaseProvider;
  appEnvProfile: string;
  nodeEnv: string | undefined;
  runAuthMigrations: () => Promise<void>;
  seedLocalAuthUser: (user: LocalSeedUser) => Promise<void>;
  runSqliteBootstrap: (context: {
    targetUserEmails: Array<string>;
  }) => Promise<void>;
};

export type LocalDbBootstrapResult =
  | {
      outcome: "skipped";
      reason: "production";
    }
  | {
      outcome: "completed";
      targetUserEmails: Array<string>;
    };

export async function bootstrapLocalDb(
  options: LocalDbBootstrapOptions,
): Promise<LocalDbBootstrapResult> {
  const normalizedProfile = options.appEnvProfile.trim().toLowerCase();

  if (
    options.databaseProvider === "postgres" &&
    (normalizedProfile === "dev" || normalizedProfile === "prod")
  ) {
    throw new Error(
      `Refusing to run local bootstrap against postgres '${normalizedProfile}' profile. Use a local postgres target only.`,
    );
  }

  if (options.nodeEnv === "production") {
    return {
      outcome: "skipped",
      reason: "production",
    };
  }

  await options.runAuthMigrations();

  const localSeedUsers = loadLocalSeedUsers();

  for (const user of localSeedUsers) {
    await options.seedLocalAuthUser(user);
  }

  const targetUserEmails = localSeedUsers.map((user) => user.email);

  if (options.databaseProvider === "sqlite") {
    await options.runSqliteBootstrap({
      targetUserEmails,
    });
  }

  return {
    outcome: "completed",
    targetUserEmails,
  };
}
