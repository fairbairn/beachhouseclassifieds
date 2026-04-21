import { getKnownAdapterKeys } from "@/lib/pricing/scraper-engine/adapter-registry";
import { runValidateAdapterQuoteSidecarsCli } from "@/lib/pricing/validation/validate-adapter-quote-sidecars";
import { runValidateAvailabilityStatusCodesCli } from "@/lib/pricing/validation/validate-availability-status-codes";
import { runValidatePricingCacheAlignmentCli } from "@/lib/pricing/validation/validate-pricing-cache-alignment";
import { runValidateRoomsGuidanceCoverageCli } from "@/lib/pricing/validation/validate-rooms-guidance-coverage";
import { runValidateScrapeFilenameAlignmentCli } from "@/lib/pricing/validation/validate-scrape-filename-alignment";
import chalk from "chalk";
import Table from "cli-table3";
import readline from "node:readline";

type ParsedArgs = {
  showHelp: boolean;
  progressMode: boolean;
};

type StepId = "scrape" | "rooms" | "availability" | "quotes" | "pricing";

type StepResult = "pass" | "fail";

type AdapterResult = {
  adapterKey: string;
  scrape: StepResult;
  rooms: StepResult;
  availability: StepResult;
  quotes: StepResult;
  pricing: StepResult;
};

type StepDef = {
  id: StepId;
  title: string;
  run: (argv: string[]) => Promise<number>;
};

type TableCell = {
  raw: string;
  display: string;
};

const ADAPTER_COLOR = (text: string): string => chalk.cyan(text);

function isAdapterPass(result: AdapterResult): boolean {
  return (
    result.scrape === "pass" &&
    result.rooms === "pass" &&
    result.availability === "pass" &&
    result.quotes === "pass" &&
    result.pricing === "pass"
  );
}

function printUsage(): void {
  const known = getKnownAdapterKeys().join(", ");
  console.log(
    [
      "Usage:",
      "  tsx src/lib/scripts/run-all-adapters-validation-suite.ts",
      "  tsx src/lib/scripts/run-all-adapters-validation-suite.ts --progress",
      "",
      "Runs validators in order for each known adapter:",
      "  1) scrape filenames",
      "  2) rooms guidance",
      "  3) availability status",
      "  4) quotes",
      "  5) pricing cache",
      "",
      "Prints a results table with checkmarks and X values.",
      "Use --progress to suppress validator logs and show a live progress meter.",
      "",
      `Known adapters: ${known}`,
    ].join("\n"),
  );
}

function parseArgs(argv: string[]): ParsedArgs {
  let showHelp = false;
  let progressMode = false;

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      showHelp = true;
    }

    if (arg === "--progress" || arg === "--quiet-progress") {
      progressMode = true;
    }
  }

  return { showHelp, progressMode };
}

function icon(result: StepResult): string {
  return result === "pass" ? "✓" : "X";
}

function toResultCell(result: StepResult): TableCell {
  const symbol = icon(result);
  return {
    raw: symbol,
    display: result === "pass" ? chalk.green(symbol) : chalk.red(symbol),
  };
}

function toPassCell(result: AdapterResult): TableCell {
  const pass = isAdapterPass(result);
  const symbol = pass ? "✓" : "X";
  return {
    raw: symbol,
    display: pass ? chalk.green(symbol) : chalk.red(symbol),
  };
}

function toConsoleTable(results: AdapterResult[]): string {
  const headers: TableCell[] = [
    "Adapter",
    "Scrape",
    "Rooms",
    "Availability",
    "Quotes",
    "Pricing",
    "Pass",
  ].map((value) => ({ raw: value, display: value }));

  const rows: TableCell[][] = results.map((result) => [
    { raw: result.adapterKey, display: ADAPTER_COLOR(result.adapterKey) },
    toResultCell(result.scrape),
    toResultCell(result.rooms),
    toResultCell(result.availability),
    toResultCell(result.quotes),
    toResultCell(result.pricing),
    toPassCell(result),
  ]);

  const passCount = results.reduce(
    (count, result) => (isAdapterPass(result) ? count + 1 : count),
    0,
  );

  const summaryRow: TableCell[] = [
    { raw: "Summary", display: chalk.bold("Summary") },
    {
      raw: `${results.filter((entry) => entry.scrape === "pass").length}/${results.length}`,
      display: `${results.filter((entry) => entry.scrape === "pass").length}/${results.length}`,
    },
    {
      raw: `${results.filter((entry) => entry.rooms === "pass").length}/${results.length}`,
      display: `${results.filter((entry) => entry.rooms === "pass").length}/${results.length}`,
    },
    {
      raw: `${results.filter((entry) => entry.availability === "pass").length}/${results.length}`,
      display: `${results.filter((entry) => entry.availability === "pass").length}/${results.length}`,
    },
    {
      raw: `${results.filter((entry) => entry.quotes === "pass").length}/${results.length}`,
      display: `${results.filter((entry) => entry.quotes === "pass").length}/${results.length}`,
    },
    {
      raw: `${results.filter((entry) => entry.pricing === "pass").length}/${results.length}`,
      display: `${results.filter((entry) => entry.pricing === "pass").length}/${results.length}`,
    },
    {
      raw: `${passCount}/${results.length}`,
      display: `${passCount}/${results.length}`,
    },
  ];

  const allRows = [...rows, summaryRow];
  const colWidths = headers.map(
    (header, columnIndex) =>
      Math.max(
        header.raw.length,
        ...allRows.map((row) => row[columnIndex]?.raw.length ?? 0),
      ) + 2,
  );

  const table = new Table({
    head: headers.map((header) => header.display),
    colAligns: [
      "left",
      "center",
      "center",
      "center",
      "center",
      "center",
      "center",
    ],
    colWidths,
    style: {
      head: [],
      border: [],
    },
    wordWrap: false,
  });

  for (const row of rows) {
    table.push(row.map((cell) => cell.display));
  }

  table.push(summaryRow.map((cell) => chalk.bold(cell.display)));
  return table.toString();
}

function renderProgressBar(completed: number, total: number): string {
  const width = 22;
  const ratio = total === 0 ? 0 : completed / total;
  const filled = Math.round(width * ratio);
  const empty = Math.max(width - filled, 0);
  return `${"█".repeat(filled)}${"░".repeat(empty)}`;
}

function writeProgressLine(line: string): void {
  if (!process.stdout.isTTY) {
    console.log(line);
    return;
  }

  readline.cursorTo(process.stdout, 0);
  readline.clearLine(process.stdout, 0);
  process.stdout.write(line);
}

function finishProgressLine(line: string): void {
  writeProgressLine(line);
  process.stdout.write("\n");
}

async function runStep(input: {
  adapterKey: string;
  step: StepDef;
  argv: string[];
  progressMode: boolean;
}): Promise<number> {
  if (!input.progressMode) {
    console.log(`\n[${input.adapterKey}] [${input.step.title}] starting`);
  }

  const code = input.progressMode
    ? await runWithSuppressedConsole(async () => input.step.run(input.argv))
    : await input.step.run(input.argv);

  if (code === 0) {
    if (!input.progressMode) {
      console.log(`[${input.adapterKey}] [${input.step.title}] passed`);
    }
    return 0;
  }

  if (code === 130) {
    if (!input.progressMode) {
      console.error(`[${input.adapterKey}] [${input.step.title}] cancelled`);
    }
    return 130;
  }

  if (!input.progressMode) {
    console.error(
      `[${input.adapterKey}] [${input.step.title}] failed (exit=${code})`,
    );
  }
  return 1;
}

async function runWithSuppressedConsole<T>(run: () => Promise<T>): Promise<T> {
  const originalLog = console.log;
  const originalInfo = console.info;
  const originalWarn = console.warn;
  const originalError = console.error;

  console.log = () => {};
  console.info = () => {};
  console.warn = () => {};
  console.error = () => {};

  try {
    return await run();
  } finally {
    console.log = originalLog;
    console.info = originalInfo;
    console.warn = originalWarn;
    console.error = originalError;
  }
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.showHelp) {
    printUsage();
    return 0;
  }

  const steps: StepDef[] = [
    {
      id: "scrape",
      title: "scrape-validator",
      run: runValidateScrapeFilenameAlignmentCli,
    },
    {
      id: "rooms",
      title: "rooms-validator",
      run: runValidateRoomsGuidanceCoverageCli,
    },
    {
      id: "availability",
      title: "availability-validator",
      run: runValidateAvailabilityStatusCodesCli,
    },
    {
      id: "quotes",
      title: "quotes-validator",
      run: runValidateAdapterQuoteSidecarsCli,
    },
    {
      id: "pricing",
      title: "pricing-validator",
      run: runValidatePricingCacheAlignmentCli,
    },
  ];

  const adapters = getKnownAdapterKeys();
  const results: AdapterResult[] = [];

  console.log(
    `All-adapters validation suite adapters=${adapters.length} mode=${parsed.progressMode ? "progress" : "verbose"}`,
  );

  for (
    let adapterIndex = 0;
    adapterIndex < adapters.length;
    adapterIndex += 1
  ) {
    const adapterKey = adapters[adapterIndex];
    if (!parsed.progressMode) {
      console.log(`\n=== adapter: ${adapterKey} ===`);
    }

    const result: AdapterResult = {
      adapterKey,
      scrape: "fail",
      rooms: "fail",
      availability: "fail",
      quotes: "fail",
      pricing: "fail",
    };

    const validatorArgv = ["--adapter-key", adapterKey];
    let completedSteps = 0;

    const renderAdapterMeter = (status: string): string => {
      const bar = renderProgressBar(completedSteps, steps.length);
      return [
        `[${String(adapterIndex + 1).padStart(2, "0")}/${adapters.length}]`,
        ADAPTER_COLOR(adapterKey),
        `[${bar}]`,
        `${completedSteps}/${steps.length}`,
        status,
      ].join(" ");
    };

    if (parsed.progressMode) {
      writeProgressLine(renderAdapterMeter("starting"));
    }

    for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
      const step = steps[stepIndex];

      if (parsed.progressMode) {
        writeProgressLine(renderAdapterMeter(`running ${step.title}`));
      }

      const code = await runStep({
        adapterKey,
        step,
        argv: validatorArgv,
        progressMode: parsed.progressMode,
      });

      if (code === 130) {
        if (parsed.progressMode) {
          finishProgressLine(renderAdapterMeter(chalk.yellow("cancelled")));
        }
        console.error("All-adapters validation suite cancelled.");
        return 130;
      }

      result[step.id] = code === 0 ? "pass" : "fail";
      completedSteps += 1;

      if (parsed.progressMode) {
        const status =
          code === 0
            ? `${step.title} ${chalk.green("✓")}`
            : `${step.title} ${chalk.red("X")}`;
        writeProgressLine(renderAdapterMeter(status));
      }
    }

    if (parsed.progressMode) {
      finishProgressLine(
        renderAdapterMeter(
          isAdapterPass(result)
            ? chalk.green("adapter pass ✓")
            : chalk.red("adapter fail X"),
        ),
      );
    }

    results.push(result);
  }

  console.log("\nValidation matrix");
  console.log(toConsoleTable(results));

  const failedAdapters = results.filter((entry) => !isAdapterPass(entry));

  if (failedAdapters.length > 0) {
    console.error(
      `\nAll-adapters validation suite completed with failures failed_adapters=${failedAdapters.length} total_adapters=${results.length}`,
    );
    return 1;
  }

  console.log(
    `\nAll-adapters validation suite passed adapters=${results.length}`,
  );
  return 0;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`All-adapters validation suite failed: ${message}`);
    process.exit(1);
  });
