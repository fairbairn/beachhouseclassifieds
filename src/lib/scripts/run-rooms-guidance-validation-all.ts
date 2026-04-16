import { getKnownAdapterKeys } from "@/lib/pricing/scraper-engine/adapter-registry";
import chalk from "chalk";
import { spawnSync } from "node:child_process";

type CliOptions = {
  adapters: string[] | null;
  maxAdapters: number | null;
  maxListings: number | null;
  strict: boolean;
  summaryOnly: boolean;
};

type AdapterResult = {
  adapter: string;
  pass: boolean;
  summaryLine: string;
};

function parseArgs(argv: string[]): CliOptions {
  let adapters: string[] | null = null;
  let maxAdapters: number | null = null;
  let maxListings: number | null = null;
  let strict = false;
  let summaryOnly = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    if (arg === "--adapters" && value) {
      const parsed = value
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean);
      adapters = parsed.length > 0 ? parsed : null;
      index += 1;
      continue;
    }

    if (arg === "--max-adapters" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        maxAdapters = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--max-listings" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        maxListings = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--strict") {
      strict = true;
      continue;
    }

    if (arg === "--summary-only") {
      summaryOnly = true;
      continue;
    }
  }

  return {
    adapters,
    maxAdapters,
    maxListings,
    strict,
    summaryOnly,
  };
}

function runAdapterValidation(
  root: string,
  adapter: string,
  options: CliOptions,
): AdapterResult {
  const args: string[] = [
    "run",
    "pricing:validate:rooms:raw",
    "--",
    "--adapter-key",
    adapter,
    "--summary-only",
  ];

  if (options.maxListings !== null) {
    args.push("--max-listings", String(options.maxListings));
  }

  if (options.strict) {
    args.push("--strict");
  }

  const result = spawnSync("npm", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 20,
  });

  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const pass =
    /Rooms guidance validator passed/.test(output) && result.status === 0;
  const summaryLine =
    output
      .split("\n")
      .find(
        (line) =>
          line.includes("Rooms guidance validator passed") ||
          line.includes("Rooms guidance validator failed"),
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

  let selected = getKnownAdapterKeys();

  if (options.adapters) {
    const allowed = new Set(options.adapters);
    selected = selected.filter((adapter) => allowed.has(adapter));
  }

  if (options.maxAdapters !== null) {
    selected = selected.slice(0, options.maxAdapters);
  }

  if (selected.length === 0) {
    console.error("No adapters selected for rooms guidance validation.");
    return 1;
  }

  const results: AdapterResult[] = [];

  if (!options.summaryOnly) {
    const scope = options.adapters ? "selected" : "all";
    console.log(
      chalk.cyan(
        `Starting rooms guidance validation for ${selected.length} ${scope} adapter(s)...`,
      ),
    );
  }

  for (let index = 0; index < selected.length; index += 1) {
    const adapter = selected[index];

    if (!options.summaryOnly) {
      console.log(
        chalk.dim(`[${index + 1}/${selected.length}] validating ${adapter}...`),
      );
    }

    const entry = runAdapterValidation(root, adapter, options);
    results.push(entry);

    if (!options.summaryOnly) {
      const statusLabel = entry.pass ? chalk.green("PASS") : chalk.red("FAIL");
      console.log(
        `${statusLabel} ${chalk.bold(entry.adapter)} :: ${entry.summaryLine}`,
      );
    }
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

  if (failed > 0) {
    console.log(chalk.red("flagged_adapters:"));
    for (const result of results) {
      if (!result.pass) {
        console.log(`- ${result.adapter} :: ${result.summaryLine}`);
      }
    }
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
    process.stderr.write(
      `All-adapter rooms guidance validation failed: ${message}\n`,
    );
    process.exit(1);
  });
