import chalk from "chalk";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

type CliOptions = {
  maxAdapters: number | null;
};

type AdapterResult = {
  adapter: string;
  pass: boolean;
  summaryLine: string;
};

function parseArgs(argv: string[]): CliOptions {
  let maxAdapters: number | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    if (arg === "--max-adapters" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        maxAdapters = Math.floor(parsed);
      }
      index += 1;
      continue;
    }
  }

  return { maxAdapters };
}

function listAdaptersWithQuoteModules(root: string): string[] {
  const quoteAdaptersDir = resolve(
    root,
    "src",
    "lib",
    "pricing",
    "scraper-engine",
    "adapters",
    "quotes",
  );

  return readdirSync(quoteAdaptersDir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.startsWith("legacy-"),
    )
    .map((entry) => entry.name.replace(/\.ts$/i, ""))
    .sort((left, right) => left.localeCompare(right));
}

function runAdapterValidation(root: string, adapter: string): AdapterResult {
  const result = spawnSync(
    "npm",
    ["run", "pricing:validate:quotes:raw", "--", "--adapter-key", adapter],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 20,
    },
  );

  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const pass = /Quote validator passed/.test(output) && result.status === 0;
  const summaryLine =
    output
      .split("\n")
      .find(
        (line) =>
          line.includes("Quote validator passed") ||
          line.includes("Quote validator failed"),
      ) ?? `exit=${result.status ?? 1}`;

  return {
    adapter,
    pass,
    summaryLine,
  };
}

async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const options = parseArgs(argv);
  const root = process.cwd();

  const adapters = listAdaptersWithQuoteModules(root);
  const selected =
    options.maxAdapters === null
      ? adapters
      : adapters.slice(0, options.maxAdapters);

  if (selected.length === 0) {
    console.error("No quote adapter modules found.");
    return 1;
  }

  const results = selected.map((adapter) =>
    runAdapterValidation(root, adapter),
  );
  const passed = results.filter((entry) => entry.pass).length;
  const failed = results.length - passed;

  console.log(
    failed > 0
      ? chalk.yellow(
          `adapters_checked=${results.length} passed=${passed} failed=${failed}`,
        )
      : chalk.green(
          `adapters_checked=${results.length} passed=${passed} failed=0`,
        ),
  );
  for (const entry of results) {
    const statusLabel = entry.pass ? chalk.green("PASS") : chalk.red("FAIL");
    console.log(
      `${statusLabel} ${chalk.bold(entry.adapter)} :: ${entry.summaryLine}`,
    );
  }

  return failed > 0 ? 1 : 0;
}

let exiting = false;
process.on("SIGINT", () => {
  if (exiting) {
    process.exit(130);
  }
  exiting = true;
  process.stderr.write("Operation cancelled by user.\n");
  process.exit(130);
});

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`All-adapter quote validation failed: ${message}\n`);
    process.exit(1);
  });
