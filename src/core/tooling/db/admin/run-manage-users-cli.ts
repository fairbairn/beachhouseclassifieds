import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

import "@/core/tooling/env/load-env-profile";

import { hashPassword } from "better-auth/crypto";
import chalk from "chalk";
import { and, asc, eq, or, sql } from "drizzle-orm";
import { z } from "zod";

import { auth } from "@/core/server/auth";
import { databaseProvider, db, pgDb, pgPool } from "@/core/server/db";
import {
  ensureUserTimeZoneStorageReady,
  setStoredUserTimeZoneByEmail,
} from "@/core/server/user-time-zone";
import {
  DEFAULT_TIME_ZONE,
  normalizeTimeZone,
  resolveUserTimeZone,
} from "@/core/shared/time-zone";
import {
  authAccounts as pgAuthAccounts,
  authSessions as pgAuthSessions,
  authVerifications as pgAuthVerifications,
  users as pgUsers,
} from "@/lib/db/schema-postgres";
import {
  authAccounts as sqliteAuthAccounts,
  authSessions as sqliteAuthSessions,
  authVerifications as sqliteAuthVerifications,
  users as sqliteUsers,
} from "@/lib/db/schema-sqlite";

const normalizedEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email("Email must be a valid address");

const createUserSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Name cannot be empty")
    .max(80, "Name must be at most 80 characters")
    .optional(),
  email: normalizedEmailSchema,
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(128, "Password must be at most 128 characters"),
});

const changePasswordSchema = z.object({
  email: normalizedEmailSchema,
  newPassword: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(128, "Password must be at most 128 characters"),
});

const changeNameSchema = z.object({
  email: normalizedEmailSchema,
  newName: z
    .string()
    .trim()
    .min(1, "Name cannot be empty")
    .max(80, "Name must be at most 80 characters"),
});

function isAbortLikeError(error: unknown) {
  return (
    error instanceof Error &&
    (error.name === "AbortError" ||
      ("code" in error &&
        ((error as { code?: string }).code === "ABORT_ERR" ||
          (error as { code?: string }).code === "ERR_USE_AFTER_CLOSE")))
  );
}

function defaultNameFromEmail(email: string) {
  return email.split("@")[0] ?? "User";
}

function maskPassword(password: string) {
  return "*".repeat(Math.max(password.length, 8));
}

function printValidationErrors(error: z.ZodError) {
  console.error(chalk.red("Input validation failed:"));
  for (const issue of error.issues) {
    const path = issue.path.join(".") || "input";
    console.error(chalk.red(`- ${path}: ${issue.message}`));
  }
}

function getPostgresOperationTimeoutMs() {
  const rawValue = process.env.MANAGE_USERS_PG_TIMEOUT_MS?.trim();

  if (!rawValue) {
    return 15000;
  }

  const parsed = Number.parseInt(rawValue, 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 15000;
  }

  return parsed;
}

async function withPostgresTimeout<T>(operation: Promise<T>, label: string) {
  if (databaseProvider !== "postgres") {
    return operation;
  }

  const timeoutMs = getPostgresOperationTimeoutMs();

  return await new Promise<T>((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      reject(
        new Error(
          `Timed out while ${label} after ${timeoutMs}ms. Check postgres:dev network/access and retry.`,
        ),
      );
    }, timeoutMs);

    void operation
      .then((value) => {
        clearTimeout(timeoutHandle);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timeoutHandle);
        reject(error);
      });
  });
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function assertBetterAuthTablesPresentOrThrow() {
  try {
    if (databaseProvider === "postgres") {
      if (!pgDb) {
        throw new Error("Postgres database is not configured.");
      }

      await pgDb.select({ id: pgUsers.id }).from(pgUsers).limit(1);
      await pgDb
        .select({ id: pgAuthAccounts.id })
        .from(pgAuthAccounts)
        .limit(1);
      await pgDb
        .select({ id: pgAuthSessions.id })
        .from(pgAuthSessions)
        .limit(1);
      await pgDb
        .select({ id: pgAuthVerifications.id })
        .from(pgAuthVerifications)
        .limit(1);
      return;
    }

    db.select({ id: sqliteUsers.id }).from(sqliteUsers).limit(1).all();
    db.select({ id: sqliteAuthAccounts.id })
      .from(sqliteAuthAccounts)
      .limit(1)
      .all();
    db.select({ id: sqliteAuthSessions.id })
      .from(sqliteAuthSessions)
      .limit(1)
      .all();
    db.select({ id: sqliteAuthVerifications.id })
      .from(sqliteAuthVerifications)
      .limit(1)
      .all();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    throw new Error(
      `Better Auth tables are missing or inaccessible for the selected target. Run db:setup (local) or db:cloud (postgres targets) first. Original error: ${message}`,
    );
  }
}

type UserRecord = {
  id: string;
  name: string;
  email: string;
  timeZone: string | null;
};

type UsTimeZoneChoice = {
  label: string;
  timeZone: string;
};

const usTimeZoneChoices: Array<UsTimeZoneChoice> = [
  { label: "Eastern", timeZone: "America/New_York" },
  { label: "Central", timeZone: "America/Chicago" },
  { label: "Mountain", timeZone: "America/Denver" },
  { label: "Pacific", timeZone: "America/Los_Angeles" },
  { label: "Alaska", timeZone: "America/Anchorage" },
  { label: "Hawaii", timeZone: "Pacific/Honolulu" },
];

const scriptedInputQueue = input.isTTY
  ? null
  : readFileSync(0, "utf-8").split(/\r?\n/);

function getPostgresTarget() {
  const databaseUrl = process.env.DATABASE_URL ?? "";

  try {
    const parsed = new URL(databaseUrl);

    return {
      host: parsed.hostname,
      port: parsed.port || "5432",
      database: parsed.pathname.replace(/^\//, "") || "(default)",
    };
  } catch {
    return null;
  }
}

function assertSafeTargetOrThrow() {
  if (databaseProvider !== "postgres") {
    return;
  }

  const appEnvProfile =
    process.env.APP_ENV_PROFILE?.trim().toLowerCase() ?? "local";

  if (appEnvProfile === "prod") {
    throw new Error(
      `Refusing to run manage-users against postgres '${appEnvProfile}' profile. Use local or dev postgres targets only.`,
    );
  }

  const target = getPostgresTarget();

  if (!target) {
    throw new Error(
      "DATABASE_PROVIDER=postgres but DATABASE_URL is missing or invalid.",
    );
  }

  const isLocalHost =
    target.host === "localhost" ||
    target.host === "127.0.0.1" ||
    target.host === "::1";

  console.log(
    chalk.gray(
      `Using Postgres target ${target.host}:${target.port}/${target.database}`,
    ),
  );

  const requiresRemoteHostConfirmation = appEnvProfile !== "dev";

  if (
    requiresRemoteHostConfirmation &&
    !isLocalHost &&
    process.env.MANAGE_USERS_ALLOW_REMOTE !== "true"
  ) {
    throw new Error(
      `Refusing to run against non-local Postgres host '${target.host}'. Set MANAGE_USERS_ALLOW_REMOTE=true to proceed intentionally.`,
    );
  }
}

async function promptTrimmed(
  rl: ReturnType<typeof createInterface>,
  question: string,
) {
  if (scriptedInputQueue) {
    const rawValue = scriptedInputQueue.shift();

    if (rawValue === undefined) {
      throw new Error(
        "No more scripted input is available for this prompt sequence.",
      );
    }

    console.log(`${question}${rawValue}`);
    return rawValue.trim();
  }

  return (await rl.question(question)).trim();
}

async function promptMenu(
  rl: ReturnType<typeof createInterface>,
): Promise<
  "list" | "create" | "delete" | "password" | "name" | "timezone" | "exit"
> {
  console.log(chalk.cyan("\nUser Management"));
  console.log("1) List users");
  console.log("2) Create new user");
  console.log("3) Delete existing user");
  console.log("4) Change password");
  console.log("5) Change name");
  console.log("6) Change time zone");
  console.log("7) Exit");

  while (true) {
    const choice = (
      await promptTrimmed(rl, chalk.yellow("Select an option (1-7): "))
    ).toLowerCase();

    if (choice === "1" || choice === "list") {
      return "list";
    }

    if (choice === "2" || choice === "create") {
      return "create";
    }

    if (choice === "3" || choice === "delete") {
      return "delete";
    }

    if (choice === "4" || choice === "password" || choice === "change") {
      return "password";
    }

    if (choice === "5" || choice === "name") {
      return "name";
    }

    if (choice === "6" || choice === "timezone" || choice === "tz") {
      return "timezone";
    }

    if (choice === "7" || choice === "exit" || choice === "quit") {
      return "exit";
    }

    console.log(chalk.gray("Please enter 1, 2, 3, 4, 5, 6, or 7."));
  }
}

async function askYesNo(
  rl: ReturnType<typeof createInterface>,
  question: string,
): Promise<boolean> {
  while (true) {
    const answer = (
      await promptTrimmed(rl, chalk.yellow(`${question} (yes/no): `))
    ).toLowerCase();

    if (answer === "yes" || answer === "y") {
      return true;
    }

    if (answer === "no" || answer === "n") {
      return false;
    }

    console.log(chalk.gray("Please answer yes or no."));
  }
}

async function promptTimeZoneSelection(rl: ReturnType<typeof createInterface>) {
  console.log(chalk.cyan("\nSelect a time zone:"));

  usTimeZoneChoices.forEach((choice, index) => {
    console.log(`${index + 1}) ${choice.label} (${choice.timeZone})`);
  });

  console.log(`${usTimeZoneChoices.length + 1}) Enter IANA time zone manually`);
  console.log(
    `${usTimeZoneChoices.length + 2}) Use default (America/New_York)`,
  );

  while (true) {
    const rawChoice = await promptTrimmed(
      rl,
      chalk.yellow(`Select an option (1-${usTimeZoneChoices.length + 2}): `),
    );

    const selection = Number.parseInt(rawChoice, 10);

    if (
      Number.isFinite(selection) &&
      selection >= 1 &&
      selection <= usTimeZoneChoices.length
    ) {
      return usTimeZoneChoices[selection - 1]?.timeZone ?? DEFAULT_TIME_ZONE;
    }

    if (selection === usTimeZoneChoices.length + 1) {
      const manualValue = await promptTrimmed(
        rl,
        "IANA time zone (example: America/New_York): ",
      );
      const normalizedTimeZone = normalizeTimeZone(manualValue);

      if (normalizedTimeZone) {
        return normalizedTimeZone;
      }

      console.log(chalk.red("Invalid IANA time zone. Please try again."));
      continue;
    }

    if (selection === usTimeZoneChoices.length + 2) {
      return DEFAULT_TIME_ZONE;
    }

    console.log(
      chalk.gray(
        `Please enter a number from 1 to ${usTimeZoneChoices.length + 2}.`,
      ),
    );
  }
}

async function getUserByEmail(email: string): Promise<UserRecord | null> {
  if (databaseProvider === "postgres") {
    if (!pgDb) {
      throw new Error("Postgres database is not configured.");
    }

    const rows = await withPostgresTimeout(
      pgDb
        .select({
          id: pgUsers.id,
          name: pgUsers.name,
          email: pgUsers.email,
          timeZone: pgUsers.timeZone,
        })
        .from(pgUsers)
        .where(sql`lower(${pgUsers.email}) = lower(${email})`)
        .limit(1),
      "looking up user",
    );

    return rows[0] ?? null;
  }

  return (
    db
      .select({
        id: sqliteUsers.id,
        name: sqliteUsers.name,
        email: sqliteUsers.email,
        timeZone: sqliteUsers.timeZone,
      })
      .from(sqliteUsers)
      .where(sql`lower(${sqliteUsers.email}) = lower(${email})`)
      .limit(1)
      .get() ?? null
  );
}

async function listUsers() {
  if (databaseProvider === "postgres") {
    console.log(chalk.gray("Fetching users from Postgres..."));
  }

  const allUsers =
    databaseProvider === "postgres"
      ? await (() => {
          if (!pgDb) {
            throw new Error("Postgres database is not configured.");
          }

          return withPostgresTimeout(
            pgDb
              .select({
                name: pgUsers.name,
                email: pgUsers.email,
                timeZone: pgUsers.timeZone,
              })
              .from(pgUsers)
              .orderBy(asc(pgUsers.email)),
            "listing users",
          );
        })()
      : db
          .select({
            name: sqliteUsers.name,
            email: sqliteUsers.email,
            timeZone: sqliteUsers.timeZone,
          })
          .from(sqliteUsers)
          .orderBy(asc(sqliteUsers.email))
          .all();

  if (allUsers.length === 0) {
    console.log(chalk.gray("No users found."));
    return;
  }

  console.log(chalk.cyan("\nUsers:"));
  allUsers.forEach((user, index) => {
    const name = user.name?.trim() || "(no name)";
    const effectiveTimeZone = resolveUserTimeZone(user.timeZone);
    console.log(`${index + 1}. ${name} <${user.email}> [${effectiveTimeZone}]`);
  });
}

async function createUserFlow(rl: ReturnType<typeof createInterface>) {
  while (true) {
    const nameInput = await promptTrimmed(rl, "Name (optional): ");
    const email = (await promptTrimmed(rl, "Email: ")).toLowerCase();
    const password = await promptTrimmed(rl, "Password (min 8 chars): ");

    const payload = {
      name: nameInput || undefined,
      email,
      password,
    };

    const validation = createUserSchema.safeParse(payload);

    if (!validation.success) {
      printValidationErrors(validation.error);
      console.log(chalk.gray("Please try again.\n"));
      continue;
    }

    const validated = validation.data;
    const resolvedName =
      validated.name ?? defaultNameFromEmail(validated.email);

    console.log(chalk.cyan("\nReview before create:"));
    console.log(`- Name: ${chalk.white(resolvedName)}`);
    console.log(`- Email: ${chalk.white(validated.email)}`);
    console.log(`- Password: ${chalk.white(maskPassword(validated.password))}`);

    const shouldCreate = await askYesNo(rl, "Proceed with user creation?");

    if (!shouldCreate) {
      console.log(chalk.gray("Cancelled. No changes made."));
      return;
    }

    try {
      const result = await auth.api.signUpEmail({
        body: {
          name: resolvedName,
          email: validated.email,
          password: validated.password,
        },
      });

      const createdEmail = result?.user?.email ?? validated.email;
      await setStoredUserTimeZoneByEmail({
        email: createdEmail,
        timeZone: DEFAULT_TIME_ZONE,
      });
      console.log(chalk.green(`✅ Created user: ${createdEmail}`));
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (/exist|already/i.test(message)) {
        console.error(
          chalk.yellow(`⚠️  User already exists: ${validated.email}`),
        );
        return;
      }

      console.error(chalk.red(`Failed to create user: ${message}`));
      return;
    }
  }
}

async function deleteUserFlow(rl: ReturnType<typeof createInterface>) {
  const email = (await promptTrimmed(rl, "Email to delete: ")).toLowerCase();
  const emailValidation = normalizedEmailSchema.safeParse(email);

  if (!emailValidation.success) {
    printValidationErrors(emailValidation.error);
    return;
  }

  const user = await getUserByEmail(email);

  if (!user) {
    console.log(chalk.gray(`No user found for ${email}.`));
    return;
  }

  const displayName = user.name?.trim() || "(no name)";

  console.log(chalk.cyan("\nReview before delete:"));
  console.log(`- Name: ${chalk.white(displayName)}`);
  console.log(`- Email: ${chalk.white(user.email)}`);

  const shouldDelete = await askYesNo(
    rl,
    "Delete this user and related auth records?",
  );

  if (!shouldDelete) {
    console.log(chalk.gray("Cancelled. No changes made."));
    return;
  }

  if (databaseProvider === "postgres") {
    if (!pgDb) {
      throw new Error("Postgres database is not configured.");
    }

    await pgDb.delete(pgAuthSessions).where(eq(pgAuthSessions.userId, user.id));
    await pgDb.delete(pgAuthAccounts).where(eq(pgAuthAccounts.userId, user.id));
    await pgDb
      .delete(pgAuthVerifications)
      .where(
        or(
          eq(pgAuthVerifications.identifier, user.email),
          eq(pgAuthVerifications.value, user.id),
        ),
      );
    await pgDb.delete(pgUsers).where(eq(pgUsers.id, user.id));
  } else {
    db.delete(sqliteAuthSessions)
      .where(eq(sqliteAuthSessions.userId, user.id))
      .run();
    db.delete(sqliteAuthAccounts)
      .where(eq(sqliteAuthAccounts.userId, user.id))
      .run();
    db.delete(sqliteAuthVerifications)
      .where(
        or(
          eq(sqliteAuthVerifications.identifier, user.email),
          eq(sqliteAuthVerifications.value, user.id),
        ),
      )
      .run();
    db.delete(sqliteUsers).where(eq(sqliteUsers.id, user.id)).run();
  }

  console.log(chalk.green(`✅ Deleted user: ${user.email}`));
}

async function changePasswordFlow(rl: ReturnType<typeof createInterface>) {
  const email = (await promptTrimmed(rl, "Email: ")).toLowerCase();
  const newPassword = await promptTrimmed(rl, "New password (min 8 chars): ");

  const validation = changePasswordSchema.safeParse({ email, newPassword });

  if (!validation.success) {
    printValidationErrors(validation.error);
    return;
  }

  const user = await getUserByEmail(validation.data.email);

  if (!user) {
    console.log(chalk.gray(`No user found for ${validation.data.email}.`));
    return;
  }

  const shouldChange = await askYesNo(rl, `Change password for ${user.email}?`);

  if (!shouldChange) {
    console.log(chalk.gray("Cancelled. No changes made."));
    return;
  }

  const credentialAccount =
    databaseProvider === "postgres"
      ? await (() => {
          if (!pgDb) {
            throw new Error("Postgres database is not configured.");
          }

          return pgDb
            .select({ id: pgAuthAccounts.id })
            .from(pgAuthAccounts)
            .where(
              and(
                eq(pgAuthAccounts.userId, user.id),
                eq(pgAuthAccounts.providerId, "credential"),
              ),
            )
            .limit(1)
            .then((rows) => rows[0] ?? null);
        })()
      : db
          .select({ id: sqliteAuthAccounts.id })
          .from(sqliteAuthAccounts)
          .where(
            and(
              eq(sqliteAuthAccounts.userId, user.id),
              eq(sqliteAuthAccounts.providerId, "credential"),
            ),
          )
          .limit(1)
          .get();

  const passwordHash = await hashPassword(validation.data.newPassword);
  const now = new Date().toISOString();

  if (credentialAccount) {
    if (databaseProvider === "postgres") {
      if (!pgDb) {
        throw new Error("Postgres database is not configured.");
      }

      await pgDb
        .update(pgAuthAccounts)
        .set({
          password: passwordHash,
          updatedAt: now,
        })
        .where(eq(pgAuthAccounts.id, credentialAccount.id));
    } else {
      db.update(sqliteAuthAccounts)
        .set({
          password: passwordHash,
          updatedAt: now,
        })
        .where(eq(sqliteAuthAccounts.id, credentialAccount.id))
        .run();
    }

    console.log(chalk.green(`✅ Password updated for: ${user.email}`));
    return;
  }

  const accountId = randomUUID();

  if (databaseProvider === "postgres") {
    if (!pgDb) {
      throw new Error("Postgres database is not configured.");
    }

    await pgDb.insert(pgAuthAccounts).values({
      id: accountId,
      userId: user.id,
      accountId: user.id,
      providerId: "credential",
      password: passwordHash,
      createdAt: now,
      updatedAt: now,
    });
  } else {
    db.insert(sqliteAuthAccounts)
      .values({
        id: accountId,
        userId: user.id,
        accountId: user.id,
        providerId: "credential",
        password: passwordHash,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  console.log(chalk.green(`✅ Password set for: ${user.email}`));
}

async function changeNameFlow(rl: ReturnType<typeof createInterface>) {
  const email = (await promptTrimmed(rl, "Email: ")).toLowerCase();
  const newName = await promptTrimmed(rl, "New name: ");

  const validation = changeNameSchema.safeParse({ email, newName });

  if (!validation.success) {
    printValidationErrors(validation.error);
    return;
  }

  const user = await getUserByEmail(validation.data.email);

  if (!user) {
    console.log(chalk.gray(`No user found for ${validation.data.email}.`));
    return;
  }

  const currentName = user.name?.trim() || "(no name)";

  console.log(chalk.cyan("\nReview before name change:"));
  console.log(`- Email: ${chalk.white(user.email)}`);
  console.log(`- Current name: ${chalk.white(currentName)}`);
  console.log(`- New name: ${chalk.white(validation.data.newName)}`);

  const shouldChange = await askYesNo(rl, `Change name for ${user.email}?`);

  if (!shouldChange) {
    console.log(chalk.gray("Cancelled. No changes made."));
    return;
  }

  if (databaseProvider === "postgres") {
    if (!pgDb) {
      throw new Error("Postgres database is not configured.");
    }

    await pgDb
      .update(pgUsers)
      .set({
        name: validation.data.newName,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(pgUsers.id, user.id));
  } else {
    db.update(sqliteUsers)
      .set({
        name: validation.data.newName,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(sqliteUsers.id, user.id))
      .run();
  }

  console.log(chalk.green(`✅ Name updated for: ${user.email}`));
}

async function changeTimeZoneFlow(rl: ReturnType<typeof createInterface>) {
  const email = (await promptTrimmed(rl, "Email: ")).toLowerCase();
  const emailValidation = normalizedEmailSchema.safeParse(email);

  if (!emailValidation.success) {
    printValidationErrors(emailValidation.error);
    return;
  }

  const user = await getUserByEmail(emailValidation.data);

  if (!user) {
    console.log(chalk.gray(`No user found for ${emailValidation.data}.`));
    return;
  }

  const currentTimeZone = resolveUserTimeZone(user.timeZone);
  console.log(chalk.cyan("\nCurrent time zone:"));
  console.log(`- ${chalk.white(currentTimeZone)}`);

  const selectedTimeZone = await promptTimeZoneSelection(rl);

  console.log(chalk.cyan("\nReview before time zone change:"));
  console.log(`- Email: ${chalk.white(user.email)}`);
  console.log(`- Current: ${chalk.white(currentTimeZone)}`);
  console.log(`- New: ${chalk.white(selectedTimeZone)}`);

  const shouldChange = await askYesNo(
    rl,
    `Change time zone for ${user.email}?`,
  );

  if (!shouldChange) {
    console.log(chalk.gray("Cancelled. No changes made."));
    return;
  }

  const now = new Date().toISOString();

  if (databaseProvider === "postgres") {
    if (!pgDb) {
      throw new Error("Postgres database is not configured.");
    }

    await pgDb
      .update(pgUsers)
      .set({
        timeZone: selectedTimeZone,
        updatedAt: now,
      })
      .where(eq(pgUsers.id, user.id));
  } else {
    db.update(sqliteUsers)
      .set({
        timeZone: selectedTimeZone,
        updatedAt: now,
      })
      .where(eq(sqliteUsers.id, user.id))
      .run();
  }

  console.log(
    chalk.green(
      `✅ Time zone updated for: ${user.email} (${selectedTimeZone})`,
    ),
  );
}

async function run() {
  assertSafeTargetOrThrow();
  await ensureUserTimeZoneStorageReady();
  await assertBetterAuthTablesPresentOrThrow();

  const rl = createInterface({ input, output });
  const handleSigint = () => {
    console.log(chalk.yellow("\nOperation cancelled."));
    process.exit(130);
  };

  process.once("SIGINT", handleSigint);

  try {
    try {
      while (true) {
        const action = await promptMenu(rl);

        if (action === "exit") {
          console.log(chalk.gray("Done."));
          return;
        }

        if (action === "list") {
          try {
            await listUsers();
          } catch (error) {
            console.error(
              chalk.red(`List users failed: ${errorMessage(error)}`),
            );
          }
          continue;
        }

        if (action === "create") {
          try {
            await createUserFlow(rl);
          } catch (error) {
            console.error(
              chalk.red(`Create user failed: ${errorMessage(error)}`),
            );
          }
          continue;
        }

        if (action === "delete") {
          try {
            await deleteUserFlow(rl);
          } catch (error) {
            console.error(
              chalk.red(`Delete user failed: ${errorMessage(error)}`),
            );
          }
          continue;
        }

        if (action === "password") {
          try {
            await changePasswordFlow(rl);
          } catch (error) {
            console.error(
              chalk.red(`Change password failed: ${errorMessage(error)}`),
            );
          }
          continue;
        }

        if (action === "name") {
          try {
            await changeNameFlow(rl);
          } catch (error) {
            console.error(
              chalk.red(`Change name failed: ${errorMessage(error)}`),
            );
          }
          continue;
        }

        if (action === "timezone") {
          try {
            await changeTimeZoneFlow(rl);
          } catch (error) {
            console.error(
              chalk.red(`Change time zone failed: ${errorMessage(error)}`),
            );
          }
        }
      }
    } catch (error) {
      if (isAbortLikeError(error)) {
        console.log(chalk.yellow("\nOperation cancelled."));
        process.exit(130);
      }

      throw error;
    }
  } finally {
    process.off("SIGINT", handleSigint);
    rl.close();

    if (databaseProvider === "postgres" && pgPool) {
      await pgPool.end();
    }
  }
}

async function main() {
  try {
    await run();
  } catch (error) {
    if (isAbortLikeError(error)) {
      console.log(chalk.yellow("Operation cancelled."));
      process.exit(130);
    }

    console.error(chalk.red(`manage-users failed: ${errorMessage(error)}`));
    process.exit(1);
  }
}

await main();
