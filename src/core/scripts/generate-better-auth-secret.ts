import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

type CliOptions = {
  writeEnvPath?: string;
  quiet: boolean;
  plain: boolean;
  format: "base64" | "base64url" | "hex";
};

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const styles = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  cyan: "\u001b[36m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  dim: "\u001b[2m",
};

function colorize(text: string, ...codes: Array<string>) {
  if (!useColor) {
    return text;
  }

  return `${codes.join("")}${text}${styles.reset}`;
}

function parseArgs(argv: Array<string>): CliOptions {
  let writeEnvPath: string | undefined;
  let quiet = false;
  let plain = false;
  let format: "base64" | "base64url" | "hex" = "hex";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (!arg) {
      continue;
    }

    if (arg === "--quiet") {
      quiet = true;
      continue;
    }

    if (arg === "--plain") {
      plain = true;
      continue;
    }

    if (arg === "--format") {
      const value = argv[index + 1]?.trim().toLowerCase();

      if (!value) {
        throw new Error("Missing value for --format <base64|base64url|hex>.");
      }

      if (value !== "base64" && value !== "base64url" && value !== "hex") {
        throw new Error(
          `Invalid --format '${value}'. Use base64, base64url, or hex.`,
        );
      }

      format = value;
      index += 1;
      continue;
    }

    if (arg === "--write-env") {
      const value = argv[index + 1];

      if (!value) {
        throw new Error("Missing value for --write-env <path>.");
      }

      writeEnvPath = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument '${arg}'.`);
  }

  return {
    writeEnvPath,
    quiet,
    plain,
    format,
  };
}

function generateSecret(format: "base64" | "base64url" | "hex") {
  if (format === "base64url") {
    return randomBytes(32).toString("base64url");
  }

  if (format === "hex") {
    return randomBytes(32).toString("hex");
  }

  return randomBytes(32).toString("base64");
}

function updateEnvFileSecret(envPath: string, secret: string) {
  const absolutePath = resolve(process.cwd(), envPath);

  if (!existsSync(absolutePath)) {
    throw new Error(`Env file not found: ${envPath}`);
  }

  const current = readFileSync(absolutePath, "utf8");
  const hasSecretKey = /^BETTER_AUTH_SECRET=.*$/m.test(current);

  if (!hasSecretKey) {
    throw new Error(
      `BETTER_AUTH_SECRET key is missing in ${envPath}. Add 'BETTER_AUTH_SECRET=' and retry.`,
    );
  }

  const next = current.replace(
    /^BETTER_AUTH_SECRET=.*$/m,
    `BETTER_AUTH_SECRET=${secret}`,
  );

  writeFileSync(absolutePath, next, "utf8");
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  const secret = generateSecret(options.format);

  if (options.writeEnvPath) {
    updateEnvFileSecret(options.writeEnvPath, secret);

    if (options.quiet) {
      console.log(`Updated BETTER_AUTH_SECRET in ${options.writeEnvPath}.`);
      return;
    }

    console.log(`Updated BETTER_AUTH_SECRET in ${options.writeEnvPath}.`);
    console.log(`Length: ${secret.length}`);
    console.log(`Format: ${options.format}`);
    return;
  }

  if (options.plain) {
    console.log(secret);
    return;
  }

  console.log(`\n${colorize("Better Auth Secret", styles.bold, styles.cyan)}`);
  console.log(colorize("─".repeat(72), styles.dim));
  console.log(colorize("Copy this value into BETTER_AUTH_SECRET", styles.dim));
  console.log(colorize(secret, styles.bold, styles.green));
  console.log(colorize(`format=${options.format}`, styles.yellow));
  console.log(colorize(`length=${secret.length}`, styles.yellow));
  console.log("");
}

await run();
