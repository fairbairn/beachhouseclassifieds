import { getKnownAdapterKeys } from "@/lib/pricing/scraper-engine/adapter-registry";
import chalk from "chalk";
import { spawnSync } from "node:child_process";

type CliOptions = {
  maxAdapters: number | null;
};

type AdapterResult = {
  adapter: string;
  pass: boolean;
  summaryLine: string;
};

function colorizeWarningCount(summaryLine: string): string {
  return summaryLine.replace(/warnings=(\d+)/gi, (_, digits: string) => {
    const parsed = Number(digits);
    if (Number.isFinite(parsed) && parsed > 0) {
      return `warnings=${chalk.hex("#ff8c00")(digits)}`;
    }
    return `warnings=${digits}`;
  });
}

function formatAdapterResultLine(entry: AdapterResult): string {
  const statusLabel = entry.pass ? chalk.green("PASS") : chalk.red("FAIL");
  const summaryLine = colorizeWarningCount(entry.summaryLine);
  return `${statusLabel} ${chalk.bold(entry.adapter)} :: ${summaryLine}`;
}

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

function runAdapterValidation(root: string, adapter: string): AdapterResult {
  const result = spawnSync(
    "npm",
    [
      "run",
      "pricing:validate:scrape-filenames:raw",
      "--",
      "--adapter-key",
      adapter,
    ],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 20,
    },
  );

  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const pass =
    /Scrape filename validator passed/.test(output) && result.status === 0;
  const summaryLine =
    output
      .split("\n")
      .find(
        (line) =>
          line.includes("Scrape filename validator passed") ||
          line.includes("Scrape filename validator failed"),
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

  const adapters = getKnownAdapterKeys();
  const selected =
    options.maxAdapters === null
      ? adapters
      : adapters.slice(0, options.maxAdapters);

  if (selected.length === 0) {
    console.error("No adapters available for scrape filename validation.");
    return 1;
  }

  const results: AdapterResult[] = [];

  console.log(
    chalk.cyan(
      `Starting scrape filename validation for ${selected.length} adapter(s)...`,
    ),
  );

  for (let index = 0; index < selected.length; index += 1) {
    const adapter = selected[index];
    console.log(
      chalk.dim(`[${index + 1}/${selected.length}] validating ${adapter}...`),
    );

    const entry = runAdapterValidation(root, adapter);
    results.push(entry);
    console.log(formatAdapterResultLine(entry));
  }

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
    process.stderr.write(
      `All-adapter scrape filename validation failed: ${message}\n`,
    );
    process.exit(1);
  });
