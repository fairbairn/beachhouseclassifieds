import "@/core/tooling/env/load-env-profile";

import chalk from "chalk";
import Table from "cli-table3";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { createScrapeProgress } from "@/core/tooling/terminal/scrape-progress";
import { getKnownAdapterKeys } from "@/lib/pricing/scraper-engine/adapter-registry";

type Mode = "single-adapter" | "single-listing" | "all-adapters";

type Options = {
  mode: Mode;
  adapterKey: string | null;
  listingId: string | null;
  monthsForward: number;
  asOfDate: Date;
};

type AvailabilityDay = {
  date?: unknown;
  status_code?: unknown;
  day_code?: unknown;
  is_available_for_checkin?: unknown;
  is_available_for_check_in?: unknown;
};

type DetailRecord = {
  external_listing_id?: unknown;
  normalized_availability?: {
    days?: AvailabilityDay[];
  };
};

type ListingMonthRollup = {
  available: number;
  booked: number;
};

type AdapterRollup = {
  adapter: string;
  totalListings: number;
  includedListings: number;
  monthStats: ListingMonthRollup[];
};

const CANONICAL_CODES = new Set(["A", "U", "I", "O", "X"]);

function printUsage(): void {
  console.log("Occupancy Rates From External Sources Availability");
  console.log("Usage:");
  console.log(
    "  tsx src/lib/scripts/run-occupancy-rates.ts [--adapter-key <key>] [--listing-id <id>] [--all-adapters] [--months-forward 6] [--as-of YYYY-MM-DD]",
  );
  console.log("");
  console.log("Modes:");
  console.log("  1) --all-adapters");
  console.log("  2) --adapter-key <key>");
  console.log("  3) --adapter-key <key> --listing-id <id>");
  console.log("");
  console.log("Defaults:");
  console.log("  --adapter-key 360blue");
  console.log("  --months-forward 6");
  console.log("  --as-of <today>");
}

function parseIsoDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    return null;
  }
  const parsed = new Date(`${value.trim()}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseArgs(argv: string[]): Options {
  let adapterKey: string | null = null;
  let listingId: string | null = null;
  let allAdapters = false;
  let monthsForward = 6;
  let asOfDate = new Date();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }

    if (arg === "--all-adapters") {
      allAdapters = true;
      continue;
    }

    if (arg === "--adapter-key" && next) {
      adapterKey = next.trim().toLowerCase() || null;
      i += 1;
      continue;
    }

    if (arg === "--listing-id" && next) {
      listingId = next.trim() || null;
      i += 1;
      continue;
    }

    if (arg === "--months-forward" && next) {
      const parsed = Number(next);
      if (!Number.isFinite(parsed) || parsed < 1 || parsed > 24) {
        throw new Error("--months-forward must be an integer between 1 and 24");
      }
      monthsForward = Math.floor(parsed);
      i += 1;
      continue;
    }

    if (arg === "--as-of" && next) {
      const parsed = parseIsoDate(next);
      if (!parsed) {
        throw new Error("--as-of must be in YYYY-MM-DD format");
      }
      asOfDate = parsed;
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (allAdapters && adapterKey) {
    throw new Error("Use either --all-adapters or --adapter-key, not both");
  }

  if (listingId && !adapterKey) {
    throw new Error("--listing-id requires --adapter-key");
  }

  if (!allAdapters && !adapterKey) {
    adapterKey = "360blue";
  }

  const mode: Mode = allAdapters
    ? "all-adapters"
    : listingId
      ? "single-listing"
      : "single-adapter";

  return {
    mode,
    adapterKey,
    listingId,
    monthsForward,
    asOfDate,
  };
}

function monthStartUtc(input: Date): Date {
  return new Date(Date.UTC(input.getUTCFullYear(), input.getUTCMonth(), 1));
}

function addUtcMonths(input: Date, months: number): Date {
  return new Date(
    Date.UTC(input.getUTCFullYear(), input.getUTCMonth() + months, 1),
  );
}

function monthShortLabel(input: Date): string {
  return input.toLocaleString("en-US", {
    month: "short",
    timeZone: "UTC",
  });
}

function normalizeStatusCode(day: AvailabilityDay): string | null {
  const raw =
    typeof day.status_code === "string" ? day.status_code : day.day_code;
  if (typeof raw !== "string") {
    return null;
  }
  const normalized = raw.trim().toUpperCase();
  if (normalized.length === 0 || !CANONICAL_CODES.has(normalized)) {
    return null;
  }
  return normalized;
}

function resolveCheckinAvailable(day: AvailabilityDay, code: string): boolean {
  const direct = day.is_available_for_checkin;
  if (typeof direct === "boolean") {
    return direct;
  }

  const alt = day.is_available_for_check_in;
  if (typeof alt === "boolean") {
    return alt;
  }

  return code === "A" || code === "I";
}

async function listJsonFiles(dirPath: string): Promise<string[]> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function stripJsonExtension(fileName: string): string {
  return fileName.endsWith(".json") ? fileName.slice(0, -5) : fileName;
}

function formatPercent(value: number | null): string {
  if (value === null || Number.isNaN(value)) {
    return "-";
  }
  return `${value.toFixed(1)}%`;
}

function computePct(available: number, booked: number): number | null {
  const denominator = available + booked;
  if (denominator <= 0) {
    return null;
  }
  return (booked / denominator) * 100;
}

function buildMonthWindows(
  startMonth: Date,
  monthsForward: number,
): {
  monthStarts: Date[];
  endExclusive: Date;
} {
  const monthStarts: Date[] = [];
  for (let i = 0; i < monthsForward; i += 1) {
    monthStarts.push(addUtcMonths(startMonth, i));
  }
  return {
    monthStarts,
    endExclusive: addUtcMonths(startMonth, monthsForward),
  };
}

function monthIndexForDate(date: Date, monthStarts: Date[]): number {
  for (let i = 0; i < monthStarts.length; i += 1) {
    const current = monthStarts[i];
    const next = i + 1 < monthStarts.length ? monthStarts[i + 1] : null;
    if (date >= current && (next === null || date < next)) {
      return i;
    }
  }
  return -1;
}

async function buildAdapterRollup(options: {
  adapter: string;
  listingId: string | null;
  monthStarts: Date[];
  endExclusive: Date;
  progress: ReturnType<typeof createScrapeProgress>;
}): Promise<AdapterRollup> {
  const { adapter, listingId, monthStarts, endExclusive, progress } = options;
  const detailsDir = path.resolve(
    "src/lib/data/external-sources",
    adapter,
    "details/json",
  );

  const allFiles = (await listJsonFiles(detailsDir)).filter(
    (name) => name.toLowerCase() !== "index.json",
  );

  const selectedFiles =
    listingId === null
      ? allFiles
      : allFiles.filter(
          (fileName) => stripJsonExtension(fileName) === listingId,
        );

  if (listingId && selectedFiles.length === 0) {
    throw new Error(
      `Listing '${listingId}' not found under adapter '${adapter}'`,
    );
  }

  const monthStats: ListingMonthRollup[] = monthStarts.map(() => ({
    available: 0,
    booked: 0,
  }));

  let includedListings = 0;

  for (let index = 0; index < selectedFiles.length; index += 1) {
    const fileName = selectedFiles[index];
    const filePath = path.join(detailsDir, fileName);

    let parsed: DetailRecord;
    try {
      parsed = JSON.parse(await readFile(filePath, "utf8")) as DetailRecord;
    } catch {
      continue;
    }

    const days = Array.isArray(parsed.normalized_availability?.days)
      ? parsed.normalized_availability?.days
      : [];
    if (!Array.isArray(days) || days.length === 0) {
      continue;
    }

    const listingMonthStats: ListingMonthRollup[] = monthStarts.map(() => ({
      available: 0,
      booked: 0,
    }));

    let listingAvailableTotal = 0;
    let listingBookedTotal = 0;

    for (const day of days) {
      if (typeof day.date !== "string") {
        continue;
      }

      const parsedDate = parseIsoDate(day.date);
      if (!parsedDate) {
        continue;
      }

      if (parsedDate < monthStarts[0] || parsedDate >= endExclusive) {
        continue;
      }

      const monthIndex = monthIndexForDate(parsedDate, monthStarts);
      if (monthIndex < 0) {
        continue;
      }

      const statusCode = normalizeStatusCode(day);
      if (!statusCode || statusCode === "O") {
        continue;
      }

      const isAvailableForCheckin = resolveCheckinAvailable(day, statusCode);
      const isBookedLike = statusCode === "U" || statusCode === "X";

      if (!isAvailableForCheckin && !isBookedLike) {
        continue;
      }

      if (isAvailableForCheckin) {
        listingMonthStats[monthIndex]!.available += 1;
        listingAvailableTotal += 1;
        continue;
      }

      if (isBookedLike) {
        listingMonthStats[monthIndex]!.booked += 1;
        listingBookedTotal += 1;
      }
    }

    // Exclude listings where all relevant days in window are U/X (or effectively no check-in availability).
    const shouldExclude = listingAvailableTotal === 0 && listingBookedTotal > 0;
    if (shouldExclude) {
      continue;
    }

    const hasSignal = listingAvailableTotal + listingBookedTotal > 0;
    if (!hasSignal) {
      continue;
    }

    includedListings += 1;
    for (let i = 0; i < monthStats.length; i += 1) {
      monthStats[i]!.available += listingMonthStats[i]!.available;
      monthStats[i]!.booked += listingMonthStats[i]!.booked;
    }

    if ((index + 1) % 100 === 0) {
      progress.progress(
        `adapter=${adapter} files_processed=${index + 1}/${selectedFiles.length} included=${includedListings}`,
      );
    }
  }

  return {
    adapter,
    totalListings: selectedFiles.length,
    includedListings,
    monthStats,
  };
}

function seasonalPct(row: AdapterRollup): number | null {
  let available = 0;
  let booked = 0;
  for (const month of row.monthStats) {
    available += month.available;
    booked += month.booked;
  }
  return computePct(available, booked);
}

function toTableRow(row: AdapterRollup): string[] {
  const monthlyPctCells = row.monthStats.map((month) => {
    const pct = computePct(month.available, month.booked);
    return pct === null ? chalk.gray("-") : chalk.white(formatPercent(pct));
  });

  const seasonal = seasonalPct(row);
  const seasonalCell =
    seasonal === null
      ? chalk.gray("-")
      : seasonal < 20
        ? chalk.red(formatPercent(seasonal))
        : seasonal > 65
          ? chalk.hex("#FFA500")(formatPercent(seasonal))
          : chalk.green(formatPercent(seasonal));

  return [
    chalk.cyan(row.adapter),
    `${row.includedListings}/${row.totalListings}`,
    ...monthlyPctCells,
    seasonalCell,
  ];
}

function buildTotalRollup(rows: AdapterRollup[]): AdapterRollup {
  const monthStats: ListingMonthRollup[] =
    rows.length > 0
      ? rows[0]!.monthStats.map(() => ({ available: 0, booked: 0 }))
      : [];

  let totalListings = 0;
  let includedListings = 0;

  for (const row of rows) {
    totalListings += row.totalListings;
    includedListings += row.includedListings;
    for (let i = 0; i < row.monthStats.length; i += 1) {
      monthStats[i]!.available += row.monthStats[i]!.available;
      monthStats[i]!.booked += row.monthStats[i]!.booked;
    }
  }

  return {
    adapter: "TOTAL",
    totalListings,
    includedListings,
    monthStats,
  };
}

function printReport(
  monthStarts: Date[],
  rows: AdapterRollup[],
  options: { windowStart: Date; windowEndExclusive: Date; mode: Mode },
): void {
  const monthHeaders = monthStarts.map((d) => monthShortLabel(d));

  const title =
    options.mode === "all-adapters"
      ? "Occupancy Rates - All Adapters"
      : options.mode === "single-listing"
        ? "Occupancy Rates - Single Listing"
        : "Occupancy Rates - Single Adapter";

  console.log(chalk.bold.cyan(title));
  console.log(
    chalk.gray(
      `Formula: booked / (booked + available_for_checkin) | Window: ${options.windowStart.toISOString().slice(0, 10)} to ${options.windowEndExclusive.toISOString().slice(0, 10)} (exclusive)`,
    ),
  );

  const table = new Table({
    head: ["adapter", "included/total", ...monthHeaders, "seasonal"],
    style: {
      head: ["cyan"],
      border: ["gray"],
    },
  });

  for (const row of rows) {
    table.push(toTableRow(row));
  }

  const totalRollup = buildTotalRollup(rows);
  const totalRow = toTableRow(totalRollup);
  totalRow[0] = chalk.bold.yellow("TOTAL");
  totalRow[1] = chalk.bold.yellow(totalRow[1] ?? "");
  table.push(totalRow);

  console.log(table.toString());
}

async function run(argv: string[] = process.argv.slice(2)): Promise<number> {
  const options = parseArgs(argv);
  const progress = createScrapeProgress({ script: "occupancy-rates" });

  const anchorMonth = monthStartUtc(options.asOfDate);
  const { monthStarts, endExclusive } = buildMonthWindows(
    anchorMonth,
    options.monthsForward,
  );

  const adapters =
    options.mode === "all-adapters"
      ? getKnownAdapterKeys()
      : [options.adapterKey ?? "360blue"];

  progress.phase(
    `starting occupancy rollup mode=${options.mode} adapters=${adapters.length} months_forward=${options.monthsForward} from=${anchorMonth.toISOString().slice(0, 10)}`,
  );

  const rollups: AdapterRollup[] = [];
  for (let i = 0; i < adapters.length; i += 1) {
    const adapter = adapters[i]!;
    progress.info(
      `processing adapter=${adapter} (${i + 1}/${adapters.length})`,
    );
    const rollup = await buildAdapterRollup({
      adapter,
      listingId: options.mode === "single-listing" ? options.listingId : null,
      monthStarts,
      endExclusive,
      progress,
    });
    rollups.push(rollup);
  }

  if (rollups.length === 0) {
    progress.warn("no adapters selected for processing");
    return 1;
  }

  const ordered =
    options.mode === "all-adapters"
      ? [...rollups].sort((a, b) => a.adapter.localeCompare(b.adapter))
      : rollups;

  printReport(monthStarts, ordered, {
    windowStart: anchorMonth,
    windowEndExclusive: endExclusive,
    mode: options.mode,
  });

  const included = ordered.reduce((acc, row) => acc + row.includedListings, 0);
  const total = ordered.reduce((acc, row) => acc + row.totalListings, 0);

  progress.success(
    `occupancy_rates_complete adapters=${ordered.length} included_listings=${included} total_listings=${total}`,
  );

  console.log("occupancy_rates_complete");
  console.log(`- mode: ${options.mode}`);
  console.log(`- adapters: ${ordered.length}`);
  console.log(`- included_listings: ${included}`);
  console.log(`- total_listings: ${total}`);
  console.log(`- window_start: ${anchorMonth.toISOString().slice(0, 10)}`);
  console.log(
    `- window_end_exclusive: ${endExclusive.toISOString().slice(0, 10)}`,
  );

  return 0;
}

let shuttingDown = false;
process.on("SIGINT", () => {
  if (shuttingDown) {
    process.exit(130);
  }
  shuttingDown = true;
  process.stderr.write("Operation cancelled by user.\n");
  process.exit(130);
});

run()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`occupancy rates failed: ${message}\n`);
    process.exit(1);
  });
