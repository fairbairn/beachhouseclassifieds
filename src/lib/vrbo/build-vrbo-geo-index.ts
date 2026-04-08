import chalk from "chalk";
import { promises as fs } from "node:fs";
import path from "node:path";

type CliOptions = {
  listingsDir: string;
  outFile: string;
  cellDegrees: number;
};

type VrboGeoPoint = {
  ref_id: string;
  latitude: number;
  longitude: number;
  city: string | null;
  name: string;
  url: string | null;
};

type VrboGeoIndex = {
  metadata: {
    generated_at: string;
    source_dir: string;
    total_files_scanned: number;
    total_points_indexed: number;
    cell_degrees: number;
    contract: "vrbo-geo-index-v1";
  };
  cells: Record<string, string[]>;
  points: Record<string, VrboGeoPoint>;
};

function usage(entryPath: string): string {
  return [
    "Usage:",
    `  tsx ${entryPath} [options]`,
    "",
    "Options:",
    "  --listings-dir <path>   Default: db/listings",
    "  --out-file <path>       Default: db/lookups/vrbo-geo-index.json",
    "  --cell-degrees <n>      Default: 0.002 (about 200m bins)",
    "  --help                  Show help",
  ].join("\n");
}

function parseArgs(argv: string[]): CliOptions {
  let listingsDir = "db/listings";
  let outFile = "db/lookups/vrbo-geo-index.json";
  let cellDegrees = 0.002;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];

    if (arg === "--help" || arg === "-h") {
      console.log(
        usage(process.argv[1] ?? "src/lib/vrbo/build-vrbo-geo-index.ts"),
      );
      process.exit(0);
    }

    if (arg === "--listings-dir" && value) {
      listingsDir = value.trim();
      i += 1;
      continue;
    }

    if (arg === "--out-file" && value) {
      outFile = value.trim();
      i += 1;
      continue;
    }

    if (arg === "--cell-degrees" && value) {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("--cell-degrees must be a positive number");
      }
      cellDegrees = parsed;
      i += 1;
      continue;
    }
  }

  return { listingsDir, outFile, cellDegrees };
}

function toFiniteOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function cellKey(lat: number, lng: number, cellDegrees: number): string {
  const latCell = Math.floor(lat / cellDegrees);
  const lngCell = Math.floor(lng / cellDegrees);
  return `${latCell}:${lngCell}`;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const listingsDir = path.resolve(process.cwd(), opts.listingsDir);
  const outFile = path.resolve(process.cwd(), opts.outFile);

  console.log(chalk.bold("\nBuild VRBO Geo Index"));
  console.log(chalk.cyan(`Listings dir: ${listingsDir}`));
  console.log(chalk.cyan(`Output file: ${outFile}`));
  console.log(chalk.gray(`Cell degrees: ${opts.cellDegrees}`));

  const entries = await fs.readdir(listingsDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(listingsDir, entry.name))
    .sort();

  const cells: Record<string, string[]> = {};
  const points: Record<string, VrboGeoPoint> = {};

  let indexed = 0;

  for (const filePath of files) {
    const raw = await fs.readFile(filePath, "utf8");
    const payload = JSON.parse(raw) as unknown;
    const record = asRecord(payload);
    if (!record) {
      continue;
    }

    const coordinate = asRecord(record.coordinate);
    const latitude = toFiniteOrNull(coordinate?.latitude);
    const longitude = toFiniteOrNull(coordinate?.longitude);
    if (latitude === null || longitude === null) {
      continue;
    }

    const refId = path.basename(filePath, ".json");
    const address = asRecord(record.address);

    points[refId] = {
      ref_id: refId,
      latitude,
      longitude,
      city: asStringOrNull(address?.city),
      name: asStringOrNull(record.name) ?? "",
      url: asStringOrNull(record.url),
    };

    const key = cellKey(latitude, longitude, opts.cellDegrees);
    cells[key] ||= [];
    cells[key].push(refId);
    indexed += 1;
  }

  const output: VrboGeoIndex = {
    metadata: {
      generated_at: new Date().toISOString(),
      source_dir: opts.listingsDir,
      total_files_scanned: files.length,
      total_points_indexed: indexed,
      cell_degrees: opts.cellDegrees,
      contract: "vrbo-geo-index-v1",
    },
    cells,
    points,
  };

  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, `${JSON.stringify(output, null, 2)}\n`, "utf8");

  console.log(chalk.green(`Indexed points: ${indexed}`));
  console.log(chalk.green(`Cell count: ${Object.keys(cells).length}`));
  console.log(chalk.green("Geo index build complete."));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(chalk.red(`Geo index build failed: ${message}`));
  process.exit(1);
});
