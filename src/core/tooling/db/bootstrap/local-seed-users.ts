import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { DEFAULT_TIME_ZONE, normalizeTimeZone } from "@/core/shared/time-zone";

type EnvProfile = "local" | "dev" | "prod";

const seedUsersFileByProfile: Record<Exclude<EnvProfile, "prod">, string> = {
  local: ".users.local",
  dev: ".users.dev",
};

const localSeedUserSchema = z.object({
  name: z.string().trim().min(1),
  email: z.string().trim().email(),
  password: z.preprocess((value) => {
    if (typeof value === "number" || typeof value === "bigint") {
      return String(value);
    }

    return value;
  }, z.string().min(8)),
  timeZone: z
    .string()
    .trim()
    .optional()
    .transform((value, context) => {
      if (!value) {
        return DEFAULT_TIME_ZONE;
      }

      const normalized = normalizeTimeZone(value);

      if (!normalized) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Invalid IANA time zone '${value}'.`,
        });
        return z.NEVER;
      }

      return normalized;
    }),
});

const localSeedUsersSchema = z.array(localSeedUserSchema);

const devSeedUserSchema = z.object({
  email: z.string().trim().email(),
  name: z.string().trim().min(1).optional(),
  password: z
    .preprocess((value) => {
      if (typeof value === "number" || typeof value === "bigint") {
        return String(value);
      }

      return value;
    }, z.string().min(8))
    .optional(),
  timeZone: z
    .string()
    .trim()
    .optional()
    .transform((value, context) => {
      if (!value) {
        return DEFAULT_TIME_ZONE;
      }

      const normalized = normalizeTimeZone(value);

      if (!normalized) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Invalid IANA time zone '${value}'.`,
        });
        return z.NEVER;
      }

      return normalized;
    }),
});

const devSeedUsersSchema = z.array(devSeedUserSchema);

export type LocalSeedUser = z.infer<typeof localSeedUserSchema>;
export type DevSeedUser = z.infer<typeof devSeedUserSchema>;
export type SeedUser = LocalSeedUser | DevSeedUser;

function resolveEnvProfile() {
  return (process.env.APP_ENV_PROFILE?.trim().toLowerCase() ||
    "local") as EnvProfile;
}

export function getSeedUsersFileForProfile(profile: EnvProfile) {
  if (profile === "prod") {
    return null;
  }

  return seedUsersFileByProfile[profile];
}

export function loadSeedUsersForProfile(profile: EnvProfile) {
  const usersFile = getSeedUsersFileForProfile(profile);

  if (!usersFile) {
    return [] as Array<LocalSeedUser>;
  }

  const absolutePath = resolve(process.cwd(), usersFile);

  if (!existsSync(absolutePath)) {
    return [] as Array<LocalSeedUser>;
  }

  const fileContents = readFileSync(absolutePath, "utf-8");
  const parsed = parseYaml(fileContents);
  const schema =
    profile === "local" ? localSeedUsersSchema : devSeedUsersSchema;
  const validated = schema.safeParse(parsed);

  if (!validated.success) {
    throw new Error(
      `Invalid auth users file at '${usersFile}': ${validated.error.message}`,
    );
  }

  return validated.data as Array<SeedUser>;
}

export function loadSeedUsersForActiveProfile() {
  return loadSeedUsersForProfile(resolveEnvProfile());
}

export function loadLocalSeedUsers() {
  return loadSeedUsersForProfile("local") as Array<LocalSeedUser>;
}
