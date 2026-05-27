import { getKnownAdapterKeys } from "@/lib/pricing/scraper-engine/adapter-registry";
import { runValidateAdapterQuoteSidecarsCli } from "@/lib/pricing/validation/validate-adapter-quote-sidecars";
import { runValidateAvailabilityStatusCodesCli } from "@/lib/pricing/validation/validate-availability-status-codes";
import { runValidateMediaGalleryCountCoverageCli } from "@/lib/pricing/validation/validate-media-gallery-count-coverage";
import { runValidatePricingCacheAlignmentCli } from "@/lib/pricing/validation/validate-pricing-cache-alignment";
import { runValidateRoomsGuidanceCoverageCli } from "@/lib/pricing/validation/validate-rooms-guidance-coverage";
import { runValidateScrapeFilenameAlignmentCli } from "@/lib/pricing/validation/validate-scrape-filename-alignment";
import chalk from "chalk";
import Table from "cli-table3";

type ParsedArgs = {
  adapterKey: string | null;
  showHelp: boolean;
  scrapeOnly: boolean;
  summaryOnly: boolean;
};

function printUsage(): void {
  const known = getKnownAdapterKeys().join(", ");
  console.log(
    [
      "Usage:",
      "  tsx src/lib/scripts/run-adapter-validation-suite.ts --adapter-key <adapterKey>",
      "  tsx src/lib/scripts/run-adapter-validation-suite.ts --adapter-key <adapterKey> --scrape-only",
      "  tsx src/lib/scripts/run-adapter-validation-suite.ts --adapter-key <adapterKey> --scrape-only --summary-only",
      "",
      "Runs validators in order:",
      "  1) scrape filenames",
      "  2) media gallery count (warns when < 10 images)",
      "  3) rooms guidance",
      "  4) availability status",
      "  5) quotes",
      "  6) pricing cache",
      "",
      "Options:",
      "  --scrape-only    Run only scrape-stage validators (1-4), skip quotes/pricing",
      "                   and continue through all scrape checks before returning status",
      "  --summary-only   Reduce validator output to per-step summary lines",
      "",
      `Known adapters: ${known}`,
    ].join("\n"),
  );
}

function parseArgs(argv: string[]): ParsedArgs {
  let adapterKey: string | null = null;
  let showHelp = false;
  let scrapeOnly = false;
  let summaryOnly = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      showHelp = true;
      continue;
    }

    if (arg === "--scrape-only") {
      scrapeOnly = true;
      continue;
    }

    if (arg === "--summary-only") {
      summaryOnly = true;
      continue;
    }

    if (arg === "--adapter-key") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--adapter-key requires a value");
      }
      adapterKey = value.trim().toLowerCase();
      index += 1;
      continue;
    }

    if (arg.startsWith("--adapter-key=")) {
      const value = arg.slice("--adapter-key=".length).trim().toLowerCase();
      if (!value) {
        throw new Error("--adapter-key requires a value");
      }
      adapterKey = value;
      continue;
    }
  }

  return { adapterKey, showHelp, scrapeOnly, summaryOnly };
}

function resolveAdapterKey(input: string): string {
  return input.trim().toLowerCase();
}

type StepRunResult = {
  code: number;
  statusLine: string | null;
  issues: string[];
  checked: number | null;
  issueCount: number | null;
  warningCount: number | null;
};

function extractMetricValue(
  lines: string[],
  metricNames: readonly string[],
): number | null {
  for (const line of lines) {
    for (const metric of metricNames) {
      const match = line.match(new RegExp(`(?:^|\\b)${metric}=(-?\\d+)`, "i"));
      if (!match?.[1]) {
        continue;
      }
      const parsed = Number(match[1]);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return null;
}

async function runStep(input: {
  title: string;
  run: (argv: string[]) => Promise<number>;
  argv: string[];
  summaryOnly: boolean;
}): Promise<StepRunResult> {
  if (!input.summaryOnly) {
    console.log(`\n[${input.title}] starting`);
  }

  if (!input.summaryOnly) {
    const code = await input.run(input.argv);
    if (code === 0) {
      console.log(`[${input.title}] passed`);
      return {
        code: 0,
        statusLine: null,
        issues: [],
        checked: null,
        issueCount: null,
        warningCount: null,
      };
    }
    if (code === 130) {
      console.error(`[${input.title}] cancelled`);
      return {
        code: 130,
        statusLine: null,
        issues: [],
        checked: null,
        issueCount: null,
        warningCount: null,
      };
    }
    console.error(`[${input.title}] failed (exit=${code})`);
    return {
      code: 1,
      statusLine: null,
      issues: [],
      checked: null,
      issueCount: null,
      warningCount: null,
    };
  }

  const capturedLines: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const capture = (...args: unknown[]): void => {
    const rendered = args
      .map((value) => (typeof value === "string" ? value : String(value)))
      .join(" ")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    capturedLines.push(...rendered);
  };

  let code = 1;
  try {
    console.log = capture;
    console.error = capture;
    code = await input.run(input.argv);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  const firstStatusLine =
    capturedLines.find((line) =>
      /(validator passed|validator failed|validation_summary|issues=|files=|selected=)/i.test(
        line,
      ),
    ) ?? capturedLines[0];
  const issueLines = capturedLines
    .filter(
      (line) => /\[[a-z0-9_-]+\]/i.test(line) && line.includes("details/"),
    )
    .map((line) => line.replace(/^[-\s]+/, ""))
    .slice(0, 3);
  const checked = extractMetricValue(capturedLines, [
    "primary_checked",
    "selected",
    "files",
    "listings_selected",
    "validated",
  ]);
  const issueCount = extractMetricValue(capturedLines, [
    "issues",
    "failed",
    "listings_below_threshold",
  ]);
  const warningCount = extractMetricValue(capturedLines, ["warnings"]);

  if (code === 130) {
    return {
      code: 130,
      statusLine: firstStatusLine ?? null,
      issues: [],
      checked,
      issueCount,
      warningCount,
    };
  }

  return {
    code: code === 0 ? 0 : 1,
    statusLine: firstStatusLine ?? null,
    issues: code === 0 ? [] : issueLines,
    checked,
    issueCount,
    warningCount: code !== 0 && warningCount === null ? 0 : warningCount,
  };
}

function renderSummaryTable(input: {
  adapterKey: string;
  results: Array<{
    title: string;
    code: number;
    statusLine: string | null;
    issues: string[];
    checked: number | null;
    issueCount: number | null;
    warningCount: number | null;
  }>;
}): void {
  const table = new Table({
    head: ["Validator", "Result", "Checked", "Issues", "Warn"],
    colAligns: ["left", "center", "right", "right", "right"],
    style: { head: [], border: [] },
    wordWrap: false,
  });

  for (const row of input.results) {
    const resultCell = row.code === 0 ? chalk.green("PASS") : chalk.red("FAIL");
    const checkedCell =
      typeof row.checked === "number" ? String(row.checked) : "-";
    const issuesCell =
      row.code !== 0
        ? typeof row.issueCount === "number"
          ? String(row.issueCount)
          : "-"
        : "-";
    const warningsCell =
      row.code !== 0
        ? typeof row.warningCount === "number"
          ? String(row.warningCount)
          : "-"
        : "-";
    table.push([row.title, resultCell, checkedCell, issuesCell, warningsCell]);
  }

  console.log(
    `\nValidation Summary adapter=${input.adapterKey} (summary-only mode)`,
  );
  console.log(table.toString());

  const failed = input.results.filter((row) => row.code !== 0);
  if (failed.length > 0) {
    console.log("\nFailure Details:");
    for (const row of failed) {
      if (row.issues.length === 0) {
        console.log(`- ${row.title}: no issue detail captured`);
        continue;
      }
      for (const issue of row.issues) {
        console.log(`- ${row.title}: ${issue}`);
      }
    }
  }
}

async function main(argv: string[]): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Adapter validation suite failed: ${message}`);
    return 1;
  }

  if (parsed.showHelp) {
    printUsage();
    return 0;
  }

  if (!parsed.adapterKey) {
    console.error(
      "Adapter validation suite failed: missing --adapter-key <adapterKey>",
    );
    printUsage();
    return 1;
  }

  const adapterKey = resolveAdapterKey(parsed.adapterKey);
  const known = new Set(getKnownAdapterKeys());
  if (!known.has(adapterKey)) {
    console.error(
      `Adapter validation suite failed: unknown adapter key '${parsed.adapterKey}'`,
    );
    printUsage();
    return 1;
  }

  const validatorArgv = ["--adapter-key", adapterKey];
  console.log(
    `Adapter validation suite adapter=${adapterKey} mode=${parsed.scrapeOnly ? "scrape-only" : "full"} summary_only=${parsed.summaryOnly}`,
  );

  const scrapeSteps: Array<{
    title: string;
    run: (argv: string[]) => Promise<number>;
    supportsSummaryOnly?: boolean;
  }> = [
    {
      title: "scrape-validator",
      run: runValidateScrapeFilenameAlignmentCli,
    },
    {
      title: "media-gallery-count-validator",
      run: runValidateMediaGalleryCountCoverageCli,
      supportsSummaryOnly: true,
    },
    {
      title: "rooms-validator",
      run: runValidateRoomsGuidanceCoverageCli,
      supportsSummaryOnly: true,
    },
    {
      title: "availability-validator",
      run: runValidateAvailabilityStatusCodesCli,
    },
  ];

  const quoteAndPricingSteps: Array<{
    title: string;
    run: (argv: string[]) => Promise<number>;
    supportsSummaryOnly?: boolean;
  }> = [
    {
      title: "quotes-validator",
      run: runValidateAdapterQuoteSidecarsCli,
      supportsSummaryOnly: true,
    },
    {
      title: "pricing-validator",
      run: runValidatePricingCacheAlignmentCli,
    },
  ];

  const steps = parsed.scrapeOnly
    ? scrapeSteps
    : [...scrapeSteps, ...quoteAndPricingSteps];
  const failedSteps: string[] = [];
  const stepResults: Array<{
    title: string;
    code: number;
    statusLine: string | null;
    issues: string[];
    checked: number | null;
    issueCount: number | null;
    warningCount: number | null;
  }> = [];

  for (const step of steps) {
    const stepArgv = [...validatorArgv];
    if (parsed.summaryOnly && step.supportsSummaryOnly) {
      stepArgv.push("--summary-only");
    }
    const stepResult = await runStep({
      title: step.title,
      run: step.run,
      argv: stepArgv,
      summaryOnly: parsed.summaryOnly,
    });
    stepResults.push({
      title: step.title,
      code: stepResult.code,
      statusLine: stepResult.statusLine,
      issues: stepResult.issues,
      checked: stepResult.checked,
      issueCount: stepResult.issueCount,
      warningCount: stepResult.warningCount,
    });
    if (stepResult.code === 130) {
      if (parsed.summaryOnly) {
        renderSummaryTable({ adapterKey, results: stepResults });
      }
      return 130;
    }

    if (stepResult.code !== 0) {
      failedSteps.push(step.title);
      if (!parsed.scrapeOnly) {
        if (parsed.summaryOnly) {
          renderSummaryTable({ adapterKey, results: stepResults });
        }
        return 1;
      }
    }
  }

  if (parsed.summaryOnly) {
    renderSummaryTable({ adapterKey, results: stepResults });
  }

  if (failedSteps.length > 0) {
    console.error(
      `\nAdapter validation suite failed adapter=${adapterKey} failed_steps=${failedSteps.join(",")}`,
    );
    return 1;
  }

  console.log(`\nAdapter validation suite passed adapter=${adapterKey}`);
  return 0;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Adapter validation suite failed: ${message}`);
    process.exit(1);
  });
