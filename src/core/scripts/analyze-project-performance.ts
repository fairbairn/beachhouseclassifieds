import chalk from "chalk";
import Table from "cli-table3";
import { execFileSync } from "node:child_process";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

type ScopeMetrics = {
  scope: string;
  timeWindow: "total" | "weekly";
  weekNumber: number | null;
  periodLabel: string;
  commitCount: number;
  allFileChurn: number;
  codeOnlyChurn: number;
  insertions: number;
  deletions: number;
  codeInsertions: number;
  codeDeletions: number;
};

type HoursEstimate = {
  min: number;
  mid: number;
  max: number;
};

type CliOptions = {
  rates: Array<number>;
  ratesProvided: boolean;
  minLocPerHour: number;
  maxLocPerHour: number;
  json: boolean;
  report: "mid" | "range" | "full";
  interactive: boolean;
  budget: number | null;
};

type NumstatSummary = {
  insertions: number;
  deletions: number;
  churn: number;
};

const defaultCodePathspecs = [
  "*.ts",
  "*.tsx",
  "*.js",
  "*.jsx",
  "*.mjs",
  "*.cjs",
  "*.css",
  "*.sql",
  "*.sh",
];

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

function runGit(args: Array<string>) {
  return execFileSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function parseArgs(argv: Array<string>): CliOptions {
  let rates = [90];
  let ratesProvided = false;
  let minLocPerHour = 90;
  let maxLocPerHour = 140;
  let json = false;
  let report: "mid" | "range" | "full" = "mid";
  let interactive = false;
  let budget: number | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (!arg) {
      continue;
    }

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--interactive") {
      interactive = true;
      continue;
    }

    if (arg === "--report") {
      const raw = argv[index + 1]?.trim().toLowerCase();

      if (!raw) {
        throw new Error("Missing value for --report <mid|range|full>.");
      }

      if (raw !== "mid" && raw !== "range" && raw !== "full") {
        throw new Error("--report must be one of: mid, range, full.");
      }

      report = raw;
      index += 1;
      continue;
    }

    if (arg === "--rates") {
      const raw = argv[index + 1];

      if (!raw) {
        throw new Error("Missing value for --rates <comma-separated numbers>.");
      }

      const parsed = raw
        .split(",")
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isFinite(value) && value > 0);

      if (parsed.length === 0) {
        throw new Error("--rates must contain at least one positive number.");
      }

      rates = parsed;
      ratesProvided = true;
      index += 1;
      continue;
    }

    if (arg === "--budget") {
      const raw = argv[index + 1];
      const parsed = Number(raw);

      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("--budget must be a positive number.");
      }

      budget = parsed;
      index += 1;
      continue;
    }

    if (arg === "--min-loc-per-hour") {
      const raw = argv[index + 1];
      const parsed = Number(raw);

      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("--min-loc-per-hour must be a positive number.");
      }

      minLocPerHour = parsed;
      index += 1;
      continue;
    }

    if (arg === "--max-loc-per-hour") {
      const raw = argv[index + 1];
      const parsed = Number(raw);

      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("--max-loc-per-hour must be a positive number.");
      }

      maxLocPerHour = parsed;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument '${arg}'.`);
  }

  if (minLocPerHour > maxLocPerHour) {
    throw new Error(
      "--min-loc-per-hour cannot be greater than --max-loc-per-hour.",
    );
  }

  return {
    rates,
    ratesProvided,
    minLocPerHour,
    maxLocPerHour,
    json,
    report,
    interactive,
    budget,
  };
}

async function promptInteractiveOptions(options: CliOptions) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return options;
  }

  const prompt = createInterface({ input, output });
  const heading = (value: string) =>
    useColor ? chalk.bold.cyan(value) : value;
  const label = (value: string) =>
    useColor ? chalk.bold.yellow(value) : value;
  const muted = (value: string) => (useColor ? chalk.gray(value) : value);
  const accent = (value: string) => (useColor ? chalk.green(value) : value);

  try {
    console.log(`\n${heading("Interactive Performance Report")}`);
    console.log(
      muted(
        "Choose report style, optional comparison rates, and optional fixed-budget backsolve.",
      ),
    );
    console.log("");
    console.log(`${label("Report format")}`);
    console.log(
      `  ${accent("1")}) Midpoint only ${muted("(default, easiest to compare across weeks)")}`,
    );
    console.log(
      `  ${accent("2")}) Range only ${muted("(min-max hours/cost by productivity bounds)")}`,
    );
    console.log(
      `  ${accent("3")}) Full details ${muted("(min/mid/max all shown)")}`,
    );

    let report = options.report;

    while (true) {
      const answer = (
        await prompt.question(label("Select report type (1-3): "))
      )
        .trim()
        .toLowerCase();

      if (!answer) {
        report = options.report;
        break;
      }

      if (answer === "1") {
        report = "mid";
        break;
      }

      if (answer === "2") {
        report = "range";
        break;
      }

      if (answer === "3") {
        report = "full";
        break;
      }

      console.log(
        muted("Please choose 1, 2, or 3 (or press Enter for default)."),
      );
    }

    console.log("");
    console.log(`${label("Rate assumptions")}`);
    console.log(
      muted(
        "Provide comma-separated hourly rates for column comparison (example: 75,100,150).",
      ),
    );

    const ratesAnswer = (
      await prompt.question(
        `${label("Rates")} (Enter for ${options.rates.join(",")}): `,
      )
    ).trim();

    console.log("");
    console.log(`${label("Fixed-budget backsolve (optional)")}`);
    console.log(
      muted(
        "Budget is treated as one fixed project value: we derive ONE equivalent rate from TOTAL and apply that rate to all rows.",
      ),
    );

    const budgetAnswer = (
      await prompt.question(
        `${label("Budget")} (Enter to skip${
          options.budget ? `, current ${Math.round(options.budget)}` : ""
        }): `,
      )
    ).trim();

    let budget = options.budget;

    if (budgetAnswer) {
      const parsedBudget = Number(budgetAnswer);
      if (Number.isFinite(parsedBudget) && parsedBudget > 0) {
        budget = parsedBudget;
      } else {
        console.log(
          muted("Invalid budget input; skipping budget backsolve mode."),
        );
      }
    }

    if (!ratesAnswer) {
      return {
        ...options,
        report,
        budget,
      };
    }

    const parsedRates = ratesAnswer
      .split(",")
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isFinite(value) && value > 0);

    if (parsedRates.length === 0) {
      console.log(muted("Invalid rates input; using defaults."));
      return {
        ...options,
        report,
        budget,
      };
    }

    return {
      ...options,
      report,
      rates: parsedRates,
      ratesProvided: true,
      budget,
    };
  } finally {
    prompt.close();
  }
}

function formatDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseIsoDate(value: string) {
  return new Date(`${value}T00:00:00`);
}

function endOfDay(date: Date) {
  const next = new Date(date);
  next.setHours(23, 59, 59, 999);
  return next;
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function startOfWeek(date: Date) {
  const next = new Date(date);
  const day = next.getDay();
  const daysFromSunday = day;
  next.setHours(0, 0, 0, 0);
  next.setDate(next.getDate() - daysFromSunday);
  return next;
}

function minDate(left: Date, right: Date) {
  return left.getTime() <= right.getTime() ? left : right;
}

function getFirstCommitDate() {
  const output = runGit([
    "log",
    "--reverse",
    "--pretty=format:%ad",
    "--date=short",
  ]);
  const firstLine = output.split("\n")[0]?.trim();

  if (!firstLine) {
    throw new Error("Unable to resolve first commit date.");
  }

  return firstLine;
}

function getCommitCount(since?: string, until?: string) {
  const args = ["rev-list", "--count"];

  if (since) {
    args.push(`--since=${since}`);
  }

  if (until) {
    args.push(`--until=${until}`);
  }

  args.push("HEAD");

  const output = runGit(args);
  const parsed = Number.parseInt(output, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getNumstatSummary(options?: {
  since?: string;
  until?: string;
  pathspecs?: Array<string>;
}): NumstatSummary {
  const args = ["log"];

  if (options?.since) {
    args.push(`--since=${options.since}`);
  }

  if (options?.until) {
    args.push(`--until=${options.until}`);
  }

  args.push("--pretty=tformat:", "--numstat");

  if (options?.pathspecs && options.pathspecs.length > 0) {
    args.push("--", ...options.pathspecs);
  }

  const output = runGit(args);

  if (!output) {
    return {
      insertions: 0,
      deletions: 0,
      churn: 0,
    };
  }

  let insertions = 0;
  let deletions = 0;

  output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .forEach((line) => {
      const [addRaw, delRaw] = line.split("\t");

      const parsedAdds = Number.parseInt(addRaw ?? "", 10);
      const parsedDels = Number.parseInt(delRaw ?? "", 10);

      if (Number.isFinite(parsedAdds)) {
        insertions += parsedAdds;
      }

      if (Number.isFinite(parsedDels)) {
        deletions += parsedDels;
      }
    });

  return {
    insertions,
    deletions,
    churn: insertions + deletions,
  };
}

function estimateHours(
  churn: number,
  minLocPerHour: number,
  maxLocPerHour: number,
): HoursEstimate {
  if (churn <= 0) {
    return {
      min: 0,
      mid: 0,
      max: 0,
    };
  }

  const min = churn / maxLocPerHour;
  const max = churn / minLocPerHour;

  return {
    min,
    max,
    mid: (min + max) / 2,
  };
}

function toCurrency(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

function toRate(value: number) {
  return `$${Math.round(value)}/hr`;
}

function toRoundedTraditionalRateValue(value: number) {
  return Math.max(0, Math.round(value / 5) * 5);
}

function toRoundedTraditionalRate(value: number) {
  const rounded = toRoundedTraditionalRateValue(value);
  return `$${rounded}/hr`;
}

function toSignedCurrency(value: number) {
  const absolute = toCurrency(Math.abs(value));
  return value >= 0 ? `+${absolute}` : `-${absolute}`;
}

function toHours(value: number) {
  return `${Math.round(value)} hrs`;
}

function printTable(
  headers: Array<string>,
  rows: Array<Array<string>>,
  colAligns: Array<"left" | "right" | "center">,
) {
  const table = new Table({
    head: headers.map((header) =>
      useColor ? chalk.bold.cyan(header) : header,
    ),
    colAligns,
    style: {
      head: [],
      border: useColor ? ["gray"] : [],
      compact: false,
    },
    chars: {
      top: "-",
      "top-mid": "+",
      "top-left": "+",
      "top-right": "+",
      bottom: "-",
      "bottom-mid": "+",
      "bottom-left": "+",
      "bottom-right": "+",
      left: "|",
      "left-mid": "+",
      mid: "-",
      "mid-mid": "+",
      right: "|",
      "right-mid": "+",
      middle: "|",
    },
  });

  table.push(...rows);
  console.log(table.toString());
}

function buildScopeMetrics(): Array<ScopeMetrics> {
  const now = new Date();
  const nowEnd = endOfDay(now);
  const firstCommitDate = getFirstCommitDate();

  const toDateAll = getNumstatSummary();
  const toDateCode = getNumstatSummary({ pathspecs: defaultCodePathspecs });

  const chronology: Array<ScopeMetrics> = [];
  const firstCommitWeekStart = startOfWeek(parseIsoDate(firstCommitDate));

  for (
    let cursor = new Date(firstCommitWeekStart);
    cursor.getTime() <= nowEnd.getTime();
    cursor = addDays(cursor, 7)
  ) {
    const weekStart = new Date(cursor);
    const weekEnd = minDate(endOfDay(addDays(weekStart, 6)), nowEnd);
    const since = `${formatDate(weekStart)} 00:00:00`;
    const weekUntil = `${formatDate(weekEnd)} 23:59:59`;
    const all = getNumstatSummary({ since, until: weekUntil });
    const code = getNumstatSummary({
      since,
      until: weekUntil,
      pathspecs: defaultCodePathspecs,
    });

    const weekNumber = chronology.length + 1;

    chronology.push({
      scope: `week-${weekNumber}`,
      timeWindow: "weekly",
      weekNumber,
      periodLabel: `${formatDate(weekStart)} -> ${formatDate(weekEnd)}`,
      commitCount: getCommitCount(since, weekUntil),
      allFileChurn: all.churn,
      codeOnlyChurn: code.churn,
      insertions: all.insertions,
      deletions: all.deletions,
      codeInsertions: code.insertions,
      codeDeletions: code.deletions,
    });
  }

  return [
    {
      scope: "total",
      timeWindow: "total",
      weekNumber: null,
      periodLabel: `${firstCommitDate} -> ${formatDate(now)}`,
      commitCount: getCommitCount(),
      allFileChurn: toDateAll.churn,
      codeOnlyChurn: toDateCode.churn,
      insertions: toDateAll.insertions,
      deletions: toDateAll.deletions,
      codeInsertions: toDateCode.insertions,
      codeDeletions: toDateCode.deletions,
    },
    ...chronology.reverse(),
  ];
}

function formatHoursRange(hours: HoursEstimate) {
  return `${toHours(hours.min)} - ${toHours(hours.max)}`;
}

function formatCostRange(minCost: number, maxCost: number) {
  return `${toCurrency(minCost)} - ${toCurrency(maxCost)}`;
}

function formatPercent(value: number) {
  return `${(value * 100).toFixed(2)}%`;
}

function formatPercentFromNumber(value: number) {
  return `${value.toFixed(2)}%`;
}

function buildPercentOfTotalByPeriod(scopeMetrics: Array<ScopeMetrics>) {
  const byPeriod = new Map<string, number>();
  const totalRow = scopeMetrics.find((scope) => scope.timeWindow === "total");
  const totalCodeChurn = totalRow?.codeOnlyChurn ?? 0;

  if (totalCodeChurn <= 0) {
    scopeMetrics.forEach((scope) => {
      byPeriod.set(scope.periodLabel, scope.timeWindow === "total" ? 100 : 0);
    });
    return byPeriod;
  }

  const weeklyRows = scopeMetrics.filter(
    (scope) => scope.timeWindow === "weekly",
  );
  const precisionFactor = 100;
  const raw = weeklyRows.map((scope) => {
    const percent = (scope.codeOnlyChurn / totalCodeChurn) * 100;
    const floored = Math.floor(percent * precisionFactor) / precisionFactor;
    const remainder = percent - floored;

    return {
      periodLabel: scope.periodLabel,
      floored,
      remainder,
    };
  });

  const flooredSum = raw.reduce((sum, row) => sum + row.floored, 0);
  const unitsToDistribute = Math.max(
    0,
    Math.round((100 - flooredSum) * precisionFactor),
  );

  raw
    .sort((left, right) => right.remainder - left.remainder)
    .forEach((row, index) => {
      const bonus = unitsToDistribute > index ? 1 / precisionFactor : 0;
      byPeriod.set(row.periodLabel, row.floored + bonus);
    });

  byPeriod.set(totalRow?.periodLabel ?? "", 100);

  return byPeriod;
}

function sortRates(rates: Array<number>) {
  return [...rates].sort((left, right) => left - right);
}

function classifyPricingOutcome(options: {
  budget: number;
  expectedCost: number;
}) {
  const delta = options.budget - options.expectedCost;
  const marginPct =
    options.expectedCost > 0 ? (delta / options.expectedCost) * 100 : 0;

  if (Math.abs(marginPct) <= 5) {
    return {
      label: "about right",
      delta,
      marginPct,
    };
  }

  if (delta > 0) {
    return {
      label: "making money",
      delta,
      marginPct,
    };
  }

  return {
    label: "losing money",
    delta,
    marginPct,
  };
}

async function run() {
  let options = parseArgs(process.argv.slice(2));

  if (options.interactive && !options.json) {
    options = await promptInteractiveOptions(options);
  }

  const scopeMetrics = buildScopeMetrics();
  const percentOfTotalByPeriod = buildPercentOfTotalByPeriod(scopeMetrics);

  const scopedRowsBase = scopeMetrics.map((scope) => {
    const hours = estimateHours(
      scope.codeOnlyChurn,
      options.minLocPerHour,
      options.maxLocPerHour,
    );

    return {
      scope: scope.scope,
      timeWindow: scope.timeWindow,
      weekNumber: scope.weekNumber,
      period: scope.periodLabel,
      hours,
    };
  });

  const totalBaseRow = scopedRowsBase.find(
    (entry) => entry.timeWindow === "total",
  );
  const autoBudgetComparisonRate =
    !options.interactive &&
    !options.ratesProvided &&
    options.budget &&
    totalBaseRow &&
    totalBaseRow.hours.mid > 0
      ? toRoundedTraditionalRateValue(options.budget / totalBaseRow.hours.mid)
      : null;

  const effectiveRates = sortRates([
    ...options.rates,
    ...(autoBudgetComparisonRate && autoBudgetComparisonRate > 0
      ? [autoBudgetComparisonRate]
      : []),
  ]);

  const scopedRows = scopedRowsBase.map((entry) => {
    const costsByRate = Object.fromEntries(
      effectiveRates.map((rate) => {
        return [
          rate,
          {
            min: entry.hours.min * rate,
            mid: entry.hours.mid * rate,
            max: entry.hours.max * rate,
          },
        ];
      }),
    );

    return {
      scope: entry.scope,
      timeWindow: entry.timeWindow,
      weekNumber: entry.weekNumber,
      period: entry.period,
      hours: entry.hours,
      costsByRate,
    };
  });

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          assumptions: {
            rates: effectiveRates,
            minLocPerHour: options.minLocPerHour,
            maxLocPerHour: options.maxLocPerHour,
            codePathspecs: defaultCodePathspecs,
            budget: options.budget,
            roundedRateIncrement: 5,
            autoBudgetComparisonRate,
          },
          metrics: scopeMetrics,
          estimates: scopedRows,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(
    useColor
      ? `\n${chalk.bold.cyan("Project Performance Analysis")}\n`
      : "\nProject Performance Analysis\n",
  );

  printTable(
    [
      "Time Window",
      "Week",
      "Period",
      "Commits",
      "Code Churn",
      "% of Total",
      "All-File Churn",
      "Code Adds",
      "Code Dels",
    ],
    scopeMetrics.map((scope) => [
      scope.timeWindow,
      scope.weekNumber ? `Week ${scope.weekNumber}` : "-",
      scope.periodLabel,
      String(scope.commitCount),
      String(scope.codeOnlyChurn),
      scope.timeWindow === "total"
        ? formatPercent(1)
        : formatPercentFromNumber(
            percentOfTotalByPeriod.get(scope.periodLabel) ?? 0,
          ),
      String(scope.allFileChurn),
      String(scope.codeInsertions),
      String(scope.codeDeletions),
    ]),
    [
      "left",
      "left",
      "left",
      "right",
      "right",
      "right",
      "right",
      "right",
      "right",
    ],
  );

  console.log(
    useColor
      ? `\n${chalk.bold.cyan("Estimated Hours and Cost")}\n`
      : "\nEstimated Hours and Cost\n",
  );

  const costHeaders = [
    "Time Window",
    "Week",
    "Period",
    options.report === "mid"
      ? "Hours (mid)"
      : options.report === "range"
        ? "Hours (range)"
        : "Hours (min/mid/max)",
    ...effectiveRates.map((rate) => `$${rate}/hr`),
    "Cost Range (rates)",
  ];

  const costRows = scopedRows.map((entry) => {
    const hoursCell =
      options.report === "mid"
        ? toHours(entry.hours.mid)
        : options.report === "range"
          ? formatHoursRange(entry.hours)
          : `${toHours(entry.hours.min)} / ${toHours(entry.hours.mid)} / ${toHours(entry.hours.max)}`;

    const rateCells = effectiveRates.map((rate) => {
      const estimate =
        entry.costsByRate[rate as keyof typeof entry.costsByRate];

      if (options.report === "mid") {
        return toCurrency(estimate.mid);
      }

      if (options.report === "range") {
        return formatCostRange(estimate.min, estimate.max);
      }

      return `${toCurrency(estimate.min)} / ${toCurrency(estimate.mid)} / ${toCurrency(estimate.max)}`;
    });

    const lowestRate = effectiveRates[0] ?? 0;
    const highestRate = effectiveRates[effectiveRates.length - 1] ?? 0;

    const rangeCell =
      options.report === "mid"
        ? formatCostRange(
            entry.hours.mid * lowestRate,
            entry.hours.mid * highestRate,
          )
        : formatCostRange(
            entry.hours.min * lowestRate,
            entry.hours.max * highestRate,
          );

    return [
      entry.timeWindow,
      entry.weekNumber ? `Week ${entry.weekNumber}` : "-",
      entry.period,
      hoursCell,
      ...rateCells,
      rangeCell,
    ];
  });

  printTable(costHeaders, costRows, [
    "left",
    "left",
    "left",
    ...costHeaders.slice(3).map(() => "right" as const),
  ]);

  if (options.budget) {
    const budget = options.budget;
    const totalRow = scopedRows.find((entry) => entry.timeWindow === "total");

    if (!totalRow) {
      throw new Error("Unable to resolve total row for budget backsolve.");
    }

    const eqRawRateFromTotalMid =
      totalRow.hours.mid > 0 ? budget / totalRow.hours.mid : 0;
    const eqRoundedRateFromTotalMid = toRoundedTraditionalRateValue(
      eqRawRateFromTotalMid,
    );

    console.log(
      useColor
        ? `\n${chalk.bold.cyan("Fixed Budget Backsolve")}
${chalk.gray("Rate is derived from TOTAL only, then applied to every row.")}\n`
        : "\nFixed Budget Backsolve\nRate is derived from TOTAL only, then applied to every row.\n",
    );

    printTable(
      [
        "Budget",
        "Total Hours Basis",
        "Eq Rate (raw from total)",
        "Eq Rate (rounded $5)",
      ],
      [
        [
          toCurrency(budget),
          toHours(totalRow.hours.mid),
          toRate(eqRawRateFromTotalMid),
          toRoundedTraditionalRate(eqRawRateFromTotalMid),
        ],
      ],
      ["right", "right", "right", "right"],
    );

    const pricingReferenceRate = options.rates[0] ?? 90;
    const expectedAtReferenceRate =
      totalRow.hours.mid * pricingReferenceRate;
    const outcome = classifyPricingOutcome({
      budget,
      expectedCost: expectedAtReferenceRate,
    });
    const outcomeText = useColor
      ? outcome.label === "making money"
        ? chalk.green(outcome.label)
        : outcome.label === "losing money"
          ? chalk.red(outcome.label)
          : chalk.yellow(outcome.label)
      : outcome.label;

    printTable(
      [
        "Pricing Outcome",
        "Budget",
        `Expected @ ${toRate(pricingReferenceRate)} (total-mid)`,
        "Delta",
        "Margin",
      ],
      [
        [
          outcomeText,
          toCurrency(budget),
          toCurrency(expectedAtReferenceRate),
          toSignedCurrency(outcome.delta),
          `${outcome.marginPct.toFixed(2)}%`,
        ],
      ],
      ["left", "right", "right", "right", "right"],
    );

    const budgetRows = scopedRows.map((entry) => {
      const rawCostCell =
        options.report === "mid"
          ? toCurrency(entry.hours.mid * eqRawRateFromTotalMid)
          : formatCostRange(
              entry.hours.min * eqRawRateFromTotalMid,
              entry.hours.max * eqRawRateFromTotalMid,
            );

      const roundedCostCell =
        options.report === "mid"
          ? toCurrency(entry.hours.mid * eqRoundedRateFromTotalMid)
          : formatCostRange(
              entry.hours.min * eqRoundedRateFromTotalMid,
              entry.hours.max * eqRoundedRateFromTotalMid,
            );

      return [
        entry.timeWindow,
        entry.weekNumber ? `Week ${entry.weekNumber}` : "-",
        entry.period,
        options.report === "mid"
          ? toHours(entry.hours.mid)
          : formatHoursRange(entry.hours),
        toRate(eqRawRateFromTotalMid),
        toRoundedTraditionalRate(eqRawRateFromTotalMid),
        rawCostCell,
        roundedCostCell,
      ];
    });

    printTable(
      [
        "Time Window",
        "Week",
        "Period",
        options.report === "mid" ? "Hours (mid)" : "Hours (range)",
        "Eq Rate (raw, fixed)",
        "Eq Rate (rounded $5)",
        "Cost @ Eq Rate (raw)",
        "Cost @ Eq Rate (rounded)",
      ],
      budgetRows,
      ["left", "left", "left", "right", "right", "right", "right", "right"],
    );
  }

  console.log(
    `\nAssumptions: code-only churn, ${options.minLocPerHour}-${options.maxLocPerHour} LOC/hour productivity.` +
      `${autoBudgetComparisonRate ? `\nNon-interactive default comparison enabled: $90/hr vs budget-derived ${toRoundedTraditionalRate(autoBudgetComparisonRate)}.` : ""}` +
      "\nDefault rate is $90/hr when --rates is not provided. Use --interactive for report picker, --report mid|range|full, --rates for pricing scenarios, --budget for fixed-price backsolve, or --json for machine-readable output.\n",
  );
}

await run();
