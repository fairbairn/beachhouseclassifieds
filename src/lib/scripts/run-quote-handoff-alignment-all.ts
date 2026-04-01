import chalk from "chalk";
import { spawn } from "node:child_process";
import {
  createValidatedAdapterOperationProxyByKey,
  getKnownAdapterKeys,
} from "@/lib/pricing/scraper-engine/adapter-registry";

type CliOptions = {
  adapters: string[] | null;
  maxAdapters: number | null;
  sampleListings: number;
  maxObservations: number;
  concurrency: number;
  tolerance: number;
};

type AdapterRun = {
  adapter: string;
  code: number;
};

function parseArgs(argv: string[]): CliOptions {
  let adapters: string[] | null = null;
  let maxAdapters: number | null = null;
  let sampleListings = 5;
  let maxObservations = 3;
  let concurrency = 3;
  let tolerance = 1;

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

    if (arg === "--sample-listings" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        sampleListings = Math.max(1, Math.floor(parsed));
      }
      index += 1;
      continue;
    }

    if (arg === "--max-observations" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        maxObservations = Math.max(1, Math.floor(parsed));
      }
      index += 1;
      continue;
    }

    if (arg === "--concurrency" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        concurrency = Math.max(1, Math.floor(parsed));
      }
      index += 1;
      continue;
    }

    if (arg === "--tolerance" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed >= 0) {
        tolerance = parsed;
      }
      index += 1;
      continue;
    }
  }

  return {
    adapters,
    maxAdapters,
    sampleListings,
    maxObservations,
    concurrency,
    tolerance,
  };
}

function listActiveQuoteAdapters(): string[] {
  return getKnownAdapterKeys().filter((adapterKey) => {
    const proxy = createValidatedAdapterOperationProxyByKey(adapterKey);
    return proxy?.capabilities.quoteValidation === true;
  });
}

function runAdapter(
  root: string,
  adapter: string,
  options: CliOptions,
): Promise<number> {
  const args = [
    "run",
    "pricing:validate:handoff:raw",
    "--",
    "--adapter-key",
    adapter,
    "--max-listings",
    String(options.sampleListings),
    "--max-observations",
    String(options.maxObservations),
    "--concurrency",
    String(options.concurrency),
    "--tolerance",
    String(options.tolerance),
  ];

  return new Promise((resolveRun) => {
    const child = spawn("npm", args, {
      cwd: root,
      stdio: "inherit",
      env: process.env,
    });

    child.on("exit", (code) => {
      resolveRun(code ?? 1);
    });

    child.on("error", () => {
      resolveRun(1);
    });
  });
}

async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const options = parseArgs(argv);
  const root = process.cwd();
  const discovered = listActiveQuoteAdapters();

  let selected = discovered;
  if (options.adapters) {
    const allowed = new Set(options.adapters);
    selected = discovered.filter((adapter) => allowed.has(adapter));
  }

  if (options.maxAdapters !== null) {
    selected = selected.slice(0, options.maxAdapters);
  }

  if (selected.length === 0) {
    console.error("No adapters selected for handoff QA validation.");
    return 1;
  }

  console.log(
    chalk.cyan(
      `handoff_qa adapters=${selected.length} sample_listings=${options.sampleListings} max_observations=${options.maxObservations} tolerance=${options.tolerance.toFixed(2)}`,
    ),
  );

  const results: AdapterRun[] = [];

  for (const adapter of selected) {
    console.log(chalk.bold(`\n=== adapter ${adapter} ===`));
    const code = await runAdapter(root, adapter, options);
    results.push({ adapter, code });
  }

  const failed = results.filter((entry) => entry.code !== 0);
  const passed = results.length - failed.length;

  console.log("\n=== handoff qa summary ===");
  console.log(
    failed.length === 0
      ? chalk.green(
          `adapters_checked=${results.length} passed=${passed} failed=0`,
        )
      : chalk.yellow(
          `adapters_checked=${results.length} passed=${passed} failed=${failed.length}`,
        ),
  );

  for (const result of results) {
    const status = result.code === 0 ? chalk.green("PASS") : chalk.red("FAIL");
    console.log(`${status} ${result.adapter} exit=${result.code}`);
  }

  if (failed.length > 0) {
    console.log(chalk.red("\nflagged_adapters:"));
    for (const entry of failed) {
      console.log(`- ${entry.adapter}`);
    }
    return 1;
  }

  return 0;
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
    process.stderr.write(`All-adapter handoff QA failed: ${message}\n`);
    process.exit(1);
  });
