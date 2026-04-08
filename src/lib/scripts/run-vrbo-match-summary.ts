import { promises as fs } from "node:fs";
import path from "node:path";

type AdapterRow = {
  adapter: string;
  scanned: number;
  matched: number;
  unmatched: number;
  highConfidence: number;
  hitRatePercent: number;
};

type CliOptions = {
  sortBy: "adapter" | "hit-rate";
};

function parseArgs(argv: string[]): CliOptions {
  let sortBy: CliOptions["sortBy"] = "hit-rate";

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];

    if (arg === "--sort-by" && value) {
      if (value === "adapter" || value === "hit-rate") {
        sortBy = value;
        i += 1;
        continue;
      }
      throw new Error("--sort-by must be one of: adapter, hit-rate");
    }
  }

  return { sortBy };
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function padRight(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function padLeft(value: string, width: number): string {
  return value.length >= width ? value : " ".repeat(width - value.length) + value;
}

function renderTable(rows: AdapterRow[]): string {
  const headers = [
    "adapter",
    "scanned",
    "matched",
    "unmatched",
    "high_conf",
    "hit_rate_%",
  ];

  const colWidths = {
    adapter: Math.max(
      headers[0].length,
      ...rows.map((row) => row.adapter.length),
      "TOTAL".length,
    ),
    scanned: Math.max(headers[1].length, ...rows.map((row) => String(row.scanned).length)),
    matched: Math.max(headers[2].length, ...rows.map((row) => String(row.matched).length)),
    unmatched: Math.max(
      headers[3].length,
      ...rows.map((row) => String(row.unmatched).length),
    ),
    highConf: Math.max(
      headers[4].length,
      ...rows.map((row) => String(row.highConfidence).length),
    ),
    hitRate: Math.max(
      headers[5].length,
      ...rows.map((row) => row.hitRatePercent.toFixed(2).length),
    ),
  };

  const totals = rows.reduce(
    (acc, row) => ({
      scanned: acc.scanned + row.scanned,
      matched: acc.matched + row.matched,
      unmatched: acc.unmatched + row.unmatched,
      highConfidence: acc.highConfidence + row.highConfidence,
    }),
    { scanned: 0, matched: 0, unmatched: 0, highConfidence: 0 },
  );

  const totalHitRate =
    totals.scanned > 0 ? (totals.matched / totals.scanned) * 100 : 0;

  const divider = [
    "-".repeat(colWidths.adapter),
    "-".repeat(colWidths.scanned),
    "-".repeat(colWidths.matched),
    "-".repeat(colWidths.unmatched),
    "-".repeat(colWidths.highConf),
    "-".repeat(colWidths.hitRate),
  ].join(" | ");

  const lines = [
    [
      padRight(headers[0], colWidths.adapter),
      padLeft(headers[1], colWidths.scanned),
      padLeft(headers[2], colWidths.matched),
      padLeft(headers[3], colWidths.unmatched),
      padLeft(headers[4], colWidths.highConf),
      padLeft(headers[5], colWidths.hitRate),
    ].join(" | "),
    divider,
  ];

  for (const row of rows) {
    lines.push(
      [
        padRight(row.adapter, colWidths.adapter),
        padLeft(String(row.scanned), colWidths.scanned),
        padLeft(String(row.matched), colWidths.matched),
        padLeft(String(row.unmatched), colWidths.unmatched),
        padLeft(String(row.highConfidence), colWidths.highConf),
        padLeft(row.hitRatePercent.toFixed(2), colWidths.hitRate),
      ].join(" | "),
    );
  }

  lines.push(divider);
  lines.push(
    [
      padRight("TOTAL", colWidths.adapter),
      padLeft(String(totals.scanned), colWidths.scanned),
      padLeft(String(totals.matched), colWidths.matched),
      padLeft(String(totals.unmatched), colWidths.unmatched),
      padLeft(String(totals.highConfidence), colWidths.highConf),
      padLeft(totalHitRate.toFixed(2), colWidths.hitRate),
    ].join(" | "),
  );

  return lines.join("\n");
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const lookupsDir = path.resolve(process.cwd(), "db/lookups");

  const entries = await fs.readdir(lookupsDir, { withFileTypes: true });
  const reportFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith("-match-report.json"))
    .map((entry) => path.join(lookupsDir, entry.name))
    .sort();

  if (reportFiles.length === 0) {
    throw new Error("No adapter match report files found under db/lookups");
  }

  const rows: AdapterRow[] = [];

  for (const filePath of reportFiles) {
    const raw = await fs.readFile(filePath, "utf8");
    const json = JSON.parse(raw) as {
      metadata?: { adapter_key?: string };
      totals?: {
        scanned?: number;
        matched?: number;
        unmatched?: number;
        high_confidence_0_95_plus?: number;
      };
    };

    const adapter =
      json.metadata?.adapter_key ??
      path.basename(filePath).replace(/-match-report\.json$/, "");
    const scanned = asNumber(json.totals?.scanned);
    const matched = asNumber(json.totals?.matched);
    const unmatched = asNumber(json.totals?.unmatched);
    const highConfidence = asNumber(json.totals?.high_confidence_0_95_plus);
    const hitRatePercent = scanned > 0 ? (matched / scanned) * 100 : 0;

    rows.push({
      adapter,
      scanned,
      matched,
      unmatched,
      highConfidence,
      hitRatePercent,
    });
  }

  if (opts.sortBy === "adapter") {
    rows.sort((a, b) => a.adapter.localeCompare(b.adapter));
  } else {
    rows.sort(
      (a, b) =>
        b.hitRatePercent - a.hitRatePercent ||
        b.matched - a.matched ||
        a.adapter.localeCompare(b.adapter),
    );
  }

  console.log("\nVRBO Adapter Match Summary\n");
  console.log(renderTable(rows));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
