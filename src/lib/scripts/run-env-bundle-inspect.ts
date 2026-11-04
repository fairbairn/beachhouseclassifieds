import chalk from "chalk";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  createEnvironmentReference,
  decryptEnvironmentBundle,
} from "../../core/tooling/env/environment-bundle";

function maskValue(value: string): string {
  if (value.length <= 8) {
    return "*".repeat(value.length);
  }
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function parseArgs(argv: string[]): {
  reveal: boolean;
} {
  let reveal = false;

  for (const token of argv) {
    if (token === "--reveal" || token === "--reveal=true") {
      reveal = true;
    }
  }

  return { reveal };
}

async function resolveShareOne(params: {
  explicitShareOne: string | undefined;
  hash16: string;
}): Promise<string> {
  if (params.explicitShareOne?.trim()) {
    return params.explicitShareOne.trim();
  }

  const candidatePath = resolve(
    process.cwd(),
    ".secrets/env-shares",
    `${params.hash16}.share1`,
  );

  try {
    const raw = (await readFile(candidatePath, "utf8")).trim();
    if (!raw) {
      throw new Error("empty_file");
    }
    return raw;
  } catch {
    throw new Error(
      `Missing ENVIRONMENT_KEY/SHAMIR_SHARE_1 and could not load ${candidatePath}`,
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const environment = process.env.ENVIRONMENT?.trim();
  const shareOneFromEnv =
    process.env.ENVIRONMENT_KEY?.trim() || process.env.SHAMIR_SHARE_1?.trim();

  if (!environment) {
    throw new Error("Missing ENVIRONMENT");
  }

  const tokenMatch = environment.match(/^([0-9a-fA-F]{16})\.([^.]+)\.(.+)$/);
  if (!tokenMatch) {
    throw new Error("ENVIRONMENT token must be hash16.share2.base58");
  }

  const [, hash16, shareTwo, base58Payload] = tokenMatch;
  const shareOne = await resolveShareOne({
    explicitShareOne: shareOneFromEnv,
    hash16,
  });

  const secrets = await import("secrets.js-grempe");
  const keyHex = secrets.default.combine([shareOne, shareTwo]);

  const payload = decryptEnvironmentBundle({
    environment: base58Payload,
    keyHex,
  });

  const reference = createEnvironmentReference(environment);

  process.stdout.write(chalk.bold.cyan("\nEnvironment Inspect\n"));
  process.stdout.write(
    `${chalk.gray("version")}      ${chalk.white(reference.version)}\n`,
  );
  process.stdout.write(
    `${chalk.gray("fingerprint")}  ${chalk.white(reference.fingerprint)}\n`,
  );
  process.stdout.write(
    `${chalk.gray("hash16")}       ${chalk.magenta(hash16)}\n`,
  );
  process.stdout.write(
    `${chalk.gray("share2_len")}   ${chalk.yellow(String(shareTwo.length))}\n`,
  );
  process.stdout.write(
    `${chalk.gray("payload_len")}  ${chalk.blue(String(base58Payload.length))}\n\n`,
  );

  const keys = Object.keys(payload).sort();
  process.stdout.write(chalk.bold.green(`Decrypted Keys (${keys.length})\n`));

  for (const key of keys) {
    const value = payload[key] || "";
    const rendered = args.reveal ? value : maskValue(value);
    process.stdout.write(`${chalk.green(key)}=${chalk.white(rendered)}\n`);
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `${chalk.red("env_bundle_inspect_failed")} ${message}\n`,
  );
  process.exit(1);
});
