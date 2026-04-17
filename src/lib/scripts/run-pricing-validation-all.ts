import { SHARED_LISTING_CACHE_ADAPTER_DEFINITIONS } from "@/lib/pricing/cache/listing-pricing-cache-adapter-definitions";
import { runValidatePricingCacheAlignmentCli } from "@/lib/pricing/validation/validate-pricing-cache-alignment";
import chalk from "chalk";

type CliOptions = {
  adapters: string[] | null;
  maxAdapters: number | null;
  passthroughArgs: string[];
};

type AdapterResult = {
  adapter: string;
  pass: boolean;
  summaryLine: string;
};

function parseArgs(argv: string[]): CliOptions {
  let adapters: string[] | null = null;
  let maxAdapters: number | null = null;
  const passthroughArgs: string[] = [];

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

    passthroughArgs.push(arg);
  }

  return { adapters, maxAdapters, passthroughArgs };
}

async function runAdapterValidation(
  adapter: string,
  passthroughArgs: string[],
): Promise<AdapterResult> {
  const outputLines: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;

  console.log = (...args: unknown[]) => {
    outputLines.push(args.map((entry) => String(entry)).join(" "));
  };
  console.error = (...args: unknown[]) => {
    outputLines.push(args.map((entry) => String(entry)).join(" "));
  };

  try {
    const code = await runValidatePricingCacheAlignmentCli([
      "--adapter-key",
      adapter,
      ...passthroughArgs,
    ]);

    const summaryLine =
      outputLines.find(
        (line) =>
          line.includes("Pricing alignment validator passed") ||
          line.includes("Pricing alignment validator failed"),
      ) ?? `exit=${code}`;

    return {
      adapter,
      pass: code === 0,
      summaryLine,
    };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const options = parseArgs(argv);

  let selected = Object.keys(SHARED_LISTING_CACHE_ADAPTER_DEFINITIONS).sort();

  if (options.adapters) {
    const allowed = new Set(options.adapters);
    selected = selected.filter((adapter) => allowed.has(adapter));
  }

  if (options.maxAdapters !== null) {
    selected = selected.slice(0, options.maxAdapters);
  }

  if (selected.length === 0) {
    console.error("No adapters selected for pricing cache validation.");
    return 1;
  }

  console.log(
    chalk.cyan(
      `Starting pricing cache validation for ${selected.length} adapter(s)...`,
    ),
  );

  const results: AdapterResult[] = [];
  for (let index = 0; index < selected.length; index += 1) {
    const adapter = selected[index]!;
    console.log(
      chalk.dim(`[${index + 1}/${selected.length}] validating ${adapter}...`),
    );

    const result = await runAdapterValidation(adapter, options.passthroughArgs);
    results.push(result);

    const status = result.pass ? chalk.green("PASS") : chalk.red("FAIL");
    console.log(`${status} ${chalk.bold(adapter)} :: ${result.summaryLine}`);
  }

  const passed = results.filter((result) => result.pass).length;
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
    process.stderr.write(
      `All-adapter pricing cache validation failed: ${message}\n`,
    );
    process.exit(1);
  });
