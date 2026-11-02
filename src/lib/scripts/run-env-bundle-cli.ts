import chalk from "chalk";
import { parse as parseDotenv } from "dotenv";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import secrets from "secrets.js-grempe";

import {
  createEnvironmentToken,
  decryptEnvironmentBundle,
  encryptEnvironmentBundle,
  parseEnvironmentToken,
  serializeEnvironmentBundleAsBase58Json,
} from "../../core/tooling/env/environment-bundle";

type Command = "pack" | "inspect" | "help" | "menu";

function usage(): string {
  return [
    "Usage:",
    "  npx tsx src/lib/scripts/run-env-bundle-cli.ts pack [options]",
    "  npx tsx src/lib/scripts/run-env-bundle-cli.ts inspect [options]",
    "  npx tsx src/lib/scripts/run-env-bundle-cli.ts menu",
    "",
    "pack options:",
    "  --set KEY=VALUE          Add key/value (repeatable)",
    "  --env KEY                Copy KEY from current process.env (repeatable)",
    "  --source-env-file PATH   Read KEY=VALUE source file (dotenv format)",
    "  --source-env-keys A,B,C  Copy listed keys from source file",
    "  --env-local-keys A,B,C   Copy listed keys from .env.local",
    "  --env-local-file PATH    Override .env.local path",
    "  --keys-toml PATH         Read key list from TOML manifest",
    "  --keys-toml-section NAME TOML section (default env_bundle)",
    "  --keys-toml-key NAME     TOML array key (default capture_env_keys)",
    "  --keys-env-file PATH     Dotenv file for manifest keys (default .env.local)",
    "  --compression br|gz|none Compression mode (default br)",
    "  --share-dir PATH         share1 directory (default .secrets/env-shares)",
    "  --no-write-share         Do not write local share1 file",
    "",
    "inspect options:",
    "  --environment TOKEN      ENVIRONMENT token (default ENVIRONMENT env var)",
    "  --share-one SHARE        Optional share1 value (default file lookup)",
    "  --share-dir PATH         share1 directory (default .secrets/env-shares)",
    "  --reveal                 Show full values",
    "",
    "Token format:",
    "  ENVIRONMENT=<hash16>.<share2>.<base58payload>",
  ].join("\n");
}

function parseArgs(argv: string[]): {
  command: Command;
  options: Map<string, string[]>;
} {
  const first = (argv[0] || "").toLowerCase();
  const command: Command =
    first === "pack" || first === "inspect" || first === "menu"
      ? first
      : first
        ? "help"
        : "menu";
  const options = new Map<string, string[]>();

  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      continue;
    }

    const eq = token.indexOf("=");
    let key = token.slice(2);
    let value = "true";

    if (eq >= 0) {
      key = token.slice(2, eq);
      value = token.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        value = next;
        i += 1;
      }
    }

    const prev = options.get(key) || [];
    prev.push(value);
    options.set(key, prev);
  }

  return { command, options };
}

function getValues(options: Map<string, string[]>, key: string): string[] {
  return options.get(key) || [];
}

function getLast(
  options: Map<string, string[]>,
  key: string,
): string | undefined {
  const values = getValues(options, key);
  return values.length > 0 ? values[values.length - 1] : undefined;
}

function hasFlag(options: Map<string, string[]>, key: string): boolean {
  return options.has(key);
}

function resolveShareDir(options: Map<string, string[]>): string {
  return resolve(
    process.cwd(),
    getLast(options, "share-dir") || ".secrets/env-shares",
  );
}

function parseCompression(
  options: Map<string, string[]>,
): "none" | "br" | "gz" {
  const raw = (getLast(options, "compression") || "br").trim().toLowerCase();
  if (raw === "none" || raw === "br" || raw === "gz") {
    return raw;
  }
  throw new Error(`invalid compression ${raw}`);
}

function parsePayload(options: Map<string, string[]>): Record<string, string> {
  const payload: Record<string, string> = {};

  for (const pair of getValues(options, "set")) {
    const idx = pair.indexOf("=");
    if (idx <= 0) {
      throw new Error(`invalid --set value ${pair}`);
    }
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1);
    payload[key] = value;
  }

  for (const key of getValues(options, "env")) {
    const value = process.env[key];
    if (value === undefined) {
      throw new Error(`missing process.env key ${key}`);
    }
    payload[key] = value;
  }

  const sourceEnvKeys = getValues(options, "source-env-keys")
    .flatMap((raw) => raw.split(","))
    .map((key) => key.trim())
    .filter(Boolean);
  if (sourceEnvKeys.length > 0) {
    const sourceEnv = parseSourceEnvFile(options);
    for (const key of sourceEnvKeys) {
      const value = sourceEnv[key];
      if (value === undefined) {
        throw new Error(`missing key '${key}' in source env file`);
      }
      payload[key] = value;
    }
  }

  const envLocalKeys = getValues(options, "env-local-keys")
    .flatMap((raw) => raw.split(","))
    .map((key) => key.trim())
    .filter(Boolean);
  if (envLocalKeys.length > 0) {
    const envLocal = parseEnvLocalFile(options);
    for (const key of envLocalKeys) {
      const value = envLocal[key];
      if (value === undefined) {
        throw new Error(`missing key '${key}' in .env.local`);
      }
      payload[key] = value;
    }
  }

  const manifestKeys = parseTomlManifestKeys(options);
  if (manifestKeys.length > 0) {
    const keysEnvPath = resolveKeysEnvPath(options);
    const source = parseDotenv(readFileSync(keysEnvPath, "utf8")) as Record<
      string,
      string
    >;

    for (const key of manifestKeys) {
      const value = source[key];
      if (value === undefined) {
        throw new Error(`missing key '${key}' in keys env file ${keysEnvPath}`);
      }
      payload[key] = value;
    }
  }

  if (Object.keys(payload).length === 0) {
    throw new Error("no payload specified; use --set and/or --env");
  }

  return payload;
}

function resolveEnvLocalPath(options: Map<string, string[]>): string {
  return resolve(
    process.cwd(),
    getLast(options, "env-local-file") || ".env.local",
  );
}

function resolveSourceEnvPath(options: Map<string, string[]>): string {
  return resolve(
    process.cwd(),
    getLast(options, "source-env-file") || ".env.local",
  );
}

function parseSourceEnvFile(
  options: Map<string, string[]>,
): Record<string, string> {
  const path = resolveSourceEnvPath(options);
  return parseDotenv(readFileSync(path, "utf8")) as Record<string, string>;
}

function parseEnvLocalFile(
  options: Map<string, string[]>,
): Record<string, string> {
  const path = resolveEnvLocalPath(options);
  return parseDotenv(readFileSync(path, "utf8")) as Record<string, string>;
}

function resolveKeysTomlPath(options: Map<string, string[]>): string {
  return resolve(
    process.cwd(),
    getLast(options, "keys-toml") || "src/workers/fly/fly.worker.toml",
  );
}

function resolveKeysEnvPath(options: Map<string, string[]>): string {
  return resolve(
    process.cwd(),
    getLast(options, "keys-env-file") ||
      getLast(options, "env-local-file") ||
      ".env.local",
  );
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseTomlStringArray(content: string, key: string): string[] {
  const arrayPattern = new RegExp(
    `${escapeRegExp(key)}\\s*=\\s*\\[([\\s\\S]*?)\\]`,
    "m",
  );
  const match = content.match(arrayPattern);
  if (!match) {
    return [];
  }

  const raw = match[1];
  const values: string[] = [];
  const itemPattern = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'/g;
  let itemMatch: RegExpExecArray | null;

  while ((itemMatch = itemPattern.exec(raw)) !== null) {
    const token = itemMatch[1] ?? itemMatch[2] ?? "";
    const normalized = token
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\'/g, "'")
      .replace(/\\\\/g, "\\");
    if (normalized.trim()) {
      values.push(normalized.trim());
    }
  }

  return values;
}

function extractTomlSection(content: string, section: string): string {
  const sectionPattern = new RegExp(
    `^\\[${escapeRegExp(section)}\\]\\s*$([\\s\\S]*?)(?=^\\[|\\Z)`,
    "m",
  );
  const match = content.match(sectionPattern);
  if (!match) {
    throw new Error(`TOML section [${section}] not found`);
  }
  return match[1];
}

function parseTomlManifestKeys(options: Map<string, string[]>): string[] {
  if (!hasFlag(options, "keys-toml")) {
    return [];
  }

  const path = resolveKeysTomlPath(options);
  const sectionName = getLast(options, "keys-toml-section") || "env_bundle";
  const keyName = getLast(options, "keys-toml-key") || "capture_env_keys";
  const content = readFileSync(path, "utf8");

  const sectionContent = extractTomlSection(content, sectionName);
  const keys = parseTomlStringArray(sectionContent, keyName);
  if (keys.length === 0) {
    throw new Error(
      `no keys found in TOML manifest section=[${sectionName}] key=${keyName} path=${path}`,
    );
  }

  return [...new Set(keys)];
}

function parseSelectionTokens(raw: string, max: number): number[] {
  const out = new Set<number>();
  const tokens = raw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

  for (const token of tokens) {
    const rangeMatch = token.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = Number.parseInt(rangeMatch[1], 10);
      const end = Number.parseInt(rangeMatch[2], 10);
      const lo = Math.min(start, end);
      const hi = Math.max(start, end);
      for (let i = lo; i <= hi; i += 1) {
        if (i >= 1 && i <= max) {
          out.add(i);
        }
      }
      continue;
    }

    const single = Number.parseInt(token, 10);
    if (Number.isFinite(single) && single >= 1 && single <= max) {
      out.add(single);
    }
  }

  return [...out].sort((a, b) => a - b);
}

function maskValue(value: string): string {
  if (value.length <= 8) {
    return "*".repeat(value.length);
  }
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

async function runPack(options: Map<string, string[]>): Promise<void> {
  const payload = parsePayload(options);
  const compression = parseCompression(options);
  const packed = encryptEnvironmentBundle({ payload, compression });

  const shares = secrets.share(packed.keyHex, 2, 2);
  const shareOne = shares[0];
  const shareTwo = shares[1];

  const payloadBase58 = serializeEnvironmentBundleAsBase58Json(packed.envelope);
  const token = createEnvironmentToken({
    shareTwo,
    payloadBase58,
  });
  const parts = parseEnvironmentToken(token);
  if (!parts) {
    throw new Error("generated token parse failed");
  }

  const shareDir = resolveShareDir(options);
  const sharePath = resolve(shareDir, `${parts.hash16}.share1`);
  const writeShare = !hasFlag(options, "no-write-share");

  if (writeShare) {
    await mkdir(shareDir, { recursive: true });
    await writeFile(sharePath, `${shareOne}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  process.stdout.write(`\n${chalk.bold.cyan("Environment Token Created")}\n`);
  process.stdout.write(
    `${chalk.gray("hash16:")}     ${chalk.magenta(parts.hash16)}\n`,
  );
  process.stdout.write(
    `${chalk.gray("share2 len:")} ${chalk.yellow(String(parts.shareTwo.length))}\n`,
  );
  process.stdout.write(
    `${chalk.gray("payload len:")} ${chalk.blue(String(parts.payloadBase58.length))}\n`,
  );
  process.stdout.write(
    `${chalk.gray("compression:")} ${chalk.white(compression)}\n`,
  );
  process.stdout.write(
    `${chalk.gray("keys:")}       ${chalk.white(String(Object.keys(payload).length))}\n\n`,
  );

  process.stdout.write(chalk.bold.green("SaaS Variable\n"));
  process.stdout.write(`${chalk.green("ENVIRONMENT")}=`);
  process.stdout.write(`${chalk.magenta(parts.hash16)}.`);
  process.stdout.write(`${chalk.yellow(parts.shareTwo)}.`);
  process.stdout.write(`${chalk.blue(parts.payloadBase58)}\n\n`);

  process.stdout.write(chalk.bold.yellow("Local Share1\n"));
  process.stdout.write(`${chalk.yellow("SHARE1")}=${chalk.white(shareOne)}\n`);
  process.stdout.write(
    `${chalk.gray("share1 file:")} ${chalk.white(sharePath)}\n`,
  );
  process.stdout.write(
    `${chalk.gray("written:")} ${chalk.white(writeShare ? "yes" : "no")}\n`,
  );
}

async function resolveShareOne(
  options: Map<string, string[]>,
  hash16: string,
): Promise<string> {
  const explicit =
    getLast(options, "share-one") ||
    process.env.ENVIRONMENT_KEY ||
    process.env.SHAMIR_SHARE_1;
  if (explicit?.trim()) {
    return explicit.trim();
  }

  const sharePath = resolve(resolveShareDir(options), `${hash16}.share1`);
  const value = (await readFile(sharePath, "utf8")).trim();
  if (!value) {
    throw new Error(`share1 file empty ${sharePath}`);
  }
  return value;
}

async function runInspect(options: Map<string, string[]>): Promise<void> {
  const environment = (
    getLast(options, "environment") ||
    process.env.ENVIRONMENT ||
    ""
  ).trim();
  if (!environment) {
    throw new Error("missing ENVIRONMENT");
  }

  const parts = parseEnvironmentToken(environment);
  if (!parts) {
    throw new Error("ENVIRONMENT must be hash16.share2.base58");
  }

  const shareOne = await resolveShareOne(options, parts.hash16);
  const keyHex = secrets.combine([shareOne, parts.shareTwo]);

  const payload = decryptEnvironmentBundle({
    environment,
    keyHex,
  });

  const reveal = hasFlag(options, "reveal");

  process.stdout.write(`\n${chalk.bold.cyan("Environment Token Decrypted")}\n`);
  process.stdout.write(
    `${chalk.gray("hash16:")}     ${chalk.magenta(parts.hash16)}\n`,
  );
  process.stdout.write(
    `${chalk.gray("share2 len:")} ${chalk.yellow(String(parts.shareTwo.length))}\n`,
  );
  process.stdout.write(
    `${chalk.gray("payload len:")} ${chalk.blue(String(parts.payloadBase58.length))}\n`,
  );
  process.stdout.write(
    `${chalk.gray("keys:")}       ${chalk.white(String(Object.keys(payload).length))}\n\n`,
  );

  process.stdout.write(chalk.bold.green("Payload Keys\n"));
  for (const key of Object.keys(payload).sort()) {
    const value = payload[key] || "";
    process.stdout.write(
      `${chalk.green(key)}=${chalk.white(reveal ? value : maskValue(value))}\n`,
    );
  }
}

function appendOption(
  options: Map<string, string[]>,
  key: string,
  value: string,
): void {
  const prev = options.get(key) || [];
  prev.push(value);
  options.set(key, prev);
}

function parseYesNo(raw: string): boolean {
  const normalized = raw.trim().toLowerCase();
  return (
    normalized === "y" ||
    normalized === "yes" ||
    normalized === "1" ||
    normalized === "true"
  );
}

async function runInteractiveMenu(): Promise<void> {
  const rl = createInterface({ input, output });
  try {
    process.stdout.write(`\n${chalk.bold.cyan("Env Bundle CLI Menu")}\n`);
    process.stdout.write(`${chalk.white("1")}. Pack ENVIRONMENT token\n`);
    process.stdout.write(
      `${chalk.white("2")}. Inspect/decrypt ENVIRONMENT token\n`,
    );
    process.stdout.write(`${chalk.white("3")}. Show help\n`);
    process.stdout.write(`${chalk.white("4")}. Exit\n\n`);

    const choice = (
      await rl.question(chalk.gray("Select option [1-4]: "))
    ).trim();

    if (
      choice === "4" ||
      choice.toLowerCase() === "exit" ||
      choice.toLowerCase() === "q"
    ) {
      process.stdout.write(chalk.gray("No action taken.\n"));
      return;
    }

    if (choice === "3" || choice.toLowerCase() === "help") {
      process.stdout.write(`${usage()}\n`);
      return;
    }

    if (choice === "1") {
      const options = new Map<string, string[]>();
      const compression = (
        await rl.question(chalk.gray("Compression [br/gz/none] (default br): "))
      ).trim();
      if (compression) {
        appendOption(options, "compression", compression);
      }

      process.stdout.write(
        chalk.gray(
          "Enter KEY=VALUE pairs for payload. Submit blank line to finish.\n",
        ),
      );
      while (true) {
        const pair = (await rl.question(chalk.gray("set> "))).trim();
        if (!pair) {
          break;
        }
        appendOption(options, "set", pair);
      }

      const envKeysRaw = (
        await rl.question(
          chalk.gray("Optional env keys to include (comma-separated): "),
        )
      ).trim();
      if (envKeysRaw) {
        for (const key of envKeysRaw
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean)) {
          appendOption(options, "env", key);
        }
      }

      const useEnvLocal = (
        await rl.question(chalk.gray("Select keys from .env.local? [y/N]: "))
      ).trim();
      if (parseYesNo(useEnvLocal)) {
        const envLocalPathInput = (
          await rl.question(
            chalk.gray(".env.local path (blank for .env.local): "),
          )
        ).trim();
        if (envLocalPathInput) {
          appendOption(options, "env-local-file", envLocalPathInput);
        }

        const envLocal = parseEnvLocalFile(options);
        const keys = Object.keys(envLocal).sort();
        if (keys.length === 0) {
          process.stdout.write(chalk.yellow("No keys found in .env.local\n"));
        } else {
          process.stdout.write(chalk.bold.cyan("\n.env.local keys\n"));
          keys.forEach((key, idx) => {
            process.stdout.write(
              `${chalk.gray(String(idx + 1).padStart(2, " "))}. ${chalk.green(key)}\n`,
            );
          });

          const selection = (
            await rl.question(
              chalk.gray(
                "Select indices (e.g. 1,3,5-8) to include, blank to skip: ",
              ),
            )
          ).trim();

          if (selection) {
            const picked = parseSelectionTokens(selection, keys.length);
            if (picked.length === 0) {
              process.stdout.write(
                chalk.yellow("No valid indices selected from .env.local\n"),
              );
            } else {
              const chosenKeys = picked.map((i) => keys[i - 1]);
              appendOption(options, "env-local-keys", chosenKeys.join(","));
              process.stdout.write(
                chalk.gray(
                  `Selected .env.local keys: ${chosenKeys.join(", ")}\n`,
                ),
              );
            }
          }
        }
      }

      const useSourceEnv = (
        await rl.question(
          chalk.gray("Select keys from a custom env file? [y/N]: "),
        )
      ).trim();
      if (parseYesNo(useSourceEnv)) {
        const sourcePathInput = (
          await rl.question(
            chalk.gray("Source env file path (blank for .env.local): "),
          )
        ).trim();
        if (sourcePathInput) {
          appendOption(options, "source-env-file", sourcePathInput);
        }

        const sourceEnv = parseSourceEnvFile(options);
        const keys = Object.keys(sourceEnv).sort();
        if (keys.length === 0) {
          process.stdout.write(
            chalk.yellow("No keys found in source env file\n"),
          );
        } else {
          process.stdout.write(chalk.bold.cyan("\nsource env keys\n"));
          keys.forEach((key, idx) => {
            process.stdout.write(
              `${chalk.gray(String(idx + 1).padStart(2, " "))}. ${chalk.green(
                key,
              )}\n`,
            );
          });

          const selection = (
            await rl.question(
              chalk.gray(
                "Select indices (e.g. 1,3,5-8) to include, blank to skip: ",
              ),
            )
          ).trim();

          if (selection) {
            const picked = parseSelectionTokens(selection, keys.length);
            if (picked.length === 0) {
              process.stdout.write(
                chalk.yellow(
                  "No valid indices selected from source env file\n",
                ),
              );
            } else {
              const chosenKeys = picked.map((i) => keys[i - 1]);
              appendOption(options, "source-env-keys", chosenKeys.join(","));
              process.stdout.write(
                chalk.gray(
                  `Selected source env keys: ${chosenKeys.join(", ")}\n`,
                ),
              );
            }
          }
        }
      }

      const useTomlManifest = (
        await rl.question(chalk.gray("Load keys from TOML manifest? [y/N]: "))
      ).trim();
      if (parseYesNo(useTomlManifest)) {
        const tomlPath = (
          await rl.question(
            chalk.gray(
              "TOML path (blank for src/workers/fly/fly.worker.toml): ",
            ),
          )
        ).trim();
        appendOption(
          options,
          "keys-toml",
          tomlPath || "src/workers/fly/fly.worker.toml",
        );

        const sectionName = (
          await rl.question(chalk.gray("TOML section (blank for env_bundle): "))
        ).trim();
        if (sectionName) {
          appendOption(options, "keys-toml-section", sectionName);
        }

        const keyName = (
          await rl.question(
            chalk.gray("TOML key name (blank for capture_env_keys): "),
          )
        ).trim();
        if (keyName) {
          appendOption(options, "keys-toml-key", keyName);
        }

        const keysEnvPath = (
          await rl.question(
            chalk.gray("Keys env file (blank for .env.local): "),
          )
        ).trim();
        if (keysEnvPath) {
          appendOption(options, "keys-env-file", keysEnvPath);
        }
      }

      const noWrite = (
        await rl.question(chalk.gray("Skip writing local share1 file? [y/N]: "))
      ).trim();
      if (parseYesNo(noWrite)) {
        appendOption(options, "no-write-share", "true");
      }

      await runPack(options);
      return;
    }

    if (choice === "2") {
      const options = new Map<string, string[]>();
      const environment = (
        await rl.question(
          chalk.gray("ENVIRONMENT token (blank to use ENVIRONMENT env var): "),
        )
      ).trim();
      if (environment) {
        appendOption(options, "environment", environment);
      }

      const shareOne = (
        await rl.question(
          chalk.gray("Optional share1 override (blank for file/env lookup): "),
        )
      ).trim();
      if (shareOne) {
        appendOption(options, "share-one", shareOne);
      }

      const reveal = (
        await rl.question(chalk.gray("Reveal full values? [y/N]: "))
      ).trim();
      if (parseYesNo(reveal)) {
        appendOption(options, "reveal", "true");
      }

      await runInspect(options);
      return;
    }

    throw new Error(`unknown menu choice '${choice}'`);
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.command === "help") {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  if (parsed.command === "menu") {
    if (!process.stdin.isTTY) {
      process.stdout.write(`${usage()}\n`);
      return;
    }
    await runInteractiveMenu();
    return;
  }

  if (parsed.command === "pack") {
    await runPack(parsed.options);
    return;
  }

  await runInspect(parsed.options);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${chalk.red("env_bundle_cli_failed")} ${message}\n\n`);
  process.stderr.write(`${usage()}\n`);
  process.exit(1);
});
