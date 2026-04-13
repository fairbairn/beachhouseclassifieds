import "@/core/tooling/env/load-env-profile";

import chalk from "chalk";
import { sql } from "drizzle-orm";
import { spawnSync } from "node:child_process";

import { pgDb } from "@/core/server/db";
import { getKnownAdapterKeys } from "@/lib/pricing/scraper-engine/adapter-registry";

type CliOptions = {
  maxAdapters: number | null;
};

type AdapterCheck = {
  adapter: string;
  pass: boolean;
  warnings: number;
  occupancyErrors: number;
  summaryLine: string;
};

type DbRollup = {
  any_room_field_null: number;
  all_room_fields_null: number;
  only_bedrooms_null: number;
  only_bathrooms_null: number;
  only_sleeps_null: number;
};

function parseArgs(argv: string[]): CliOptions {
  let maxAdapters: number | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--max-adapters" && next) {
      const parsed = Number(next);
      if (Number.isFinite(parsed) && parsed > 0) {
        maxAdapters = Math.floor(parsed);
      }
      i += 1;
      continue;
    }
  }

  return { maxAdapters };
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function parseWarnings(summaryLine: string): number {
  const clean = stripAnsi(summaryLine);
  const match = clean.match(/warnings=(\d+)/i);
  if (!match) return 0;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseOccupancyErrors(summaryLine: string): number {
  const clean = stripAnsi(summaryLine);
  const match = clean.match(/occupancy_errors=(\d+)/i);
  if (!match) return 0;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : 0;
}

function runAdapter(adapter: string): AdapterCheck {
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
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 20,
    },
  );

  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
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
    pass:
      /Scrape filename validator passed/.test(output) && result.status === 0,
    warnings: parseWarnings(summaryLine),
    occupancyErrors: parseOccupancyErrors(summaryLine),
    summaryLine,
  };
}

async function queryDbRollup(): Promise<DbRollup> {
  const result = await pgDb.execute<DbRollup>(sql`
    select
      count(*)::int as any_room_field_null,
      coalesce(sum((bedrooms is null and bathrooms is null and sleeps is null)::int), 0)::int as all_room_fields_null,
      coalesce(sum((bedrooms is null and bathrooms is not null and sleeps is not null)::int), 0)::int as only_bedrooms_null,
      coalesce(sum((bedrooms is not null and bathrooms is null and sleeps is not null)::int), 0)::int as only_bathrooms_null,
      coalesce(sum((bedrooms is not null and bathrooms is not null and sleeps is null)::int), 0)::int as only_sleeps_null
    from listing
    where bedrooms is null or bathrooms is null or sleeps is null;
  `);

  return (
    result.rows[0] ?? {
      any_room_field_null: 0,
      all_room_fields_null: 0,
      only_bedrooms_null: 0,
      only_bathrooms_null: 0,
      only_sleeps_null: 0,
    }
  );
}

async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const options = parseArgs(argv);
  const adapters = getKnownAdapterKeys();
  const selected =
    options.maxAdapters === null
      ? adapters
      : adapters.slice(0, options.maxAdapters);

  console.log(
    chalk.cyan(
      `occupancy_health_check adapters=${selected.length} db=postgres`,
    ),
  );

  const checks: AdapterCheck[] = [];
  for (let i = 0; i < selected.length; i += 1) {
    const adapter = selected[i];
    const check = runAdapter(adapter);
    checks.push(check);

    const status = check.pass ? chalk.green("PASS") : chalk.red("FAIL");
    const occ =
      check.occupancyErrors > 0
        ? chalk.magenta(` occupancy_errors=${check.occupancyErrors}`)
        : "";
    const warn =
      check.warnings > 0
        ? chalk.hex("#ff8c00")(` warnings=${check.warnings}`)
        : "";

    console.log(`${status} ${chalk.bold(adapter)}${warn}${occ}`);
  }

  const failed = checks.filter((c) => !c.pass).length;
  const warningAdapters = checks.filter((c) => c.warnings > 0).length;
  const occupancyErrorAdapters = checks.filter(
    (c) => c.occupancyErrors > 0,
  ).length;
  const occupancyErrorsTotal = checks.reduce(
    (acc, c) => acc + c.occupancyErrors,
    0,
  );

  const dbRollup = await queryDbRollup();

  console.log(
    chalk.bold("scrape_summary"),
    `adapters_checked=${checks.length}`,
    `failed=${failed}`,
    `warning_adapters=${warningAdapters}`,
    `occupancy_error_adapters=${occupancyErrorAdapters}`,
    `occupancy_errors_total=${occupancyErrorsTotal}`,
  );

  console.log(
    chalk.bold("db_summary"),
    `any_room_field_null=${dbRollup.any_room_field_null}`,
    `all_room_fields_null=${dbRollup.all_room_fields_null}`,
    `only_bedrooms_null=${dbRollup.only_bedrooms_null}`,
    `only_bathrooms_null=${dbRollup.only_bathrooms_null}`,
    `only_sleeps_null=${dbRollup.only_sleeps_null}`,
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
    process.stderr.write(`occupancy health check failed: ${message}\n`);
    process.exit(1);
  });
