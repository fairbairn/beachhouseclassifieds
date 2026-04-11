import "@/core/tooling/env/load-env-profile";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "pg";

import { normalizePostgresConnectionString } from "@/core/server/postgres-connection-string";

type OutputFormat = "tsv" | "json" | "table";

function printUsage(): void {
  console.error(
    "Usage: tsx src/core/tooling/db/ops/run-postgres-sql-file.ts --file <path> [--format tsv|json|table] [--header true|false]",
  );
}

function parseBoolean(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(`Invalid boolean value: ${value}`);
}

function parseArgs(argv: string[]): {
  filePath: string;
  format: OutputFormat;
  includeHeader: boolean;
} {
  let filePath = "";
  let format: OutputFormat = "tsv";
  let includeHeader = true;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--file") {
      const value = argv[i + 1];
      if (!value) throw new Error("Missing value for --file");
      filePath = value;
      i += 1;
      continue;
    }

    if (arg === "--format") {
      const value = argv[i + 1];
      if (!value) throw new Error("Missing value for --format");
      if (value !== "tsv" && value !== "json" && value !== "table") {
        throw new Error("Invalid --format. Use tsv, json, or table.");
      }
      format = value;
      i += 1;
      continue;
    }

    if (arg === "--header") {
      const value = argv[i + 1];
      if (!value) throw new Error("Missing value for --header");
      includeHeader = parseBoolean(value);
      i += 1;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!filePath) {
    throw new Error("Missing required --file argument.");
  }

  return { filePath, format, includeHeader };
}

function formatTsvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replaceAll("\t", " ").replaceAll("\n", " ");
}

function formatTableCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replaceAll("\n", " ").trim();
}

function printTable(
  columns: string[],
  rows: Array<Record<string, unknown>>,
  includeHeader: boolean,
): void {
  const widths = columns.map((column) => column.length);

  for (const row of rows) {
    columns.forEach((column, index) => {
      const cell = formatTableCell(row[column]);
      if (cell.length > widths[index]) {
        widths[index] = cell.length;
      }
    });
  }

  const separator = widths.map((width) => "-".repeat(width)).join("-+-");

  if (includeHeader) {
    const header = columns
      .map((column, index) => column.padEnd(widths[index], " "))
      .join(" | ");
    console.log(header);
    console.log(separator);
  }

  for (const row of rows) {
    const line = columns
      .map((column, index) =>
        formatTableCell(row[column]).padEnd(widths[index], " "),
      )
      .join(" | ");
    console.log(line);
  }
}

async function run(): Promise<void> {
  const { filePath, format, includeHeader } = parseArgs(process.argv.slice(2));

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("Missing DATABASE_URL in environment.");
  }

  const absoluteSqlPath = resolve(process.cwd(), filePath);
  const sql = (await readFile(absoluteSqlPath, "utf8")).trim();

  if (!sql) {
    throw new Error(`SQL file is empty: ${absoluteSqlPath}`);
  }

  const client = new Client({
    connectionString: normalizePostgresConnectionString(databaseUrl),
  });

  let interrupted = false;
  const onSigInt = () => {
    interrupted = true;
  };

  process.once("SIGINT", onSigInt);

  await client.connect();

  try {
    const result = await client.query<Record<string, unknown>>(sql);

    if (interrupted) {
      process.exitCode = 130;
      return;
    }

    if (format === "json") {
      console.log(JSON.stringify(result.rows, null, 2));
      return;
    }

    const columns = result.fields.map((field) => field.name);

    if (format === "table") {
      printTable(columns, result.rows, includeHeader);
      return;
    }

    if (includeHeader) {
      console.log(columns.join("\t"));
    }

    for (const row of result.rows) {
      const line = columns
        .map((columnName) => formatTsvCell(row[columnName]))
        .join("\t");
      console.log(line);
    }
  } finally {
    process.removeListener("SIGINT", onSigInt);
    await client.end();
  }
}

try {
  await run();
} catch (error) {
  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error("Unknown query runner failure.");
  }

  process.exit(1);
}
