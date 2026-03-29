import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

type Mode =
  | "monthly-full"
  | "daily-new-listings"
  | "daily-availability"
  | "daily-pricing"
  | "daily-all";

type CliOptions = {
  mode: Mode;
  maxNewListings: number | null;
  pricingWeeks: number;
};

type KnownDetailRecord = {
  detail_url?: string;
};

type DiscoveredListingRecord = {
  link?: string;
};

const ROOT = process.cwd();
const DETAILS_JSON_DIR = resolve(
  ROOT,
  "src",
  "lib",
  "data",
  "external-sources",
  "30aescapes",
  "details",
  "json",
);
const DISCOVERY_LISTINGS_PATH = resolve(
  ROOT,
  "src",
  "lib",
  "data",
  "external-sources",
  "30aescapes_listings.json",
);
const REPORTS_DIR = resolve(ROOT, ".tmp", "reports");
const NEW_URLS_FILE_PATH = resolve(REPORTS_DIR, "30aescapes-new-listings-urls.txt");

let activeChild: ReturnType<typeof spawn> | null = null;
let wasCancelled = false;

function parseArgs(argv: string[]): CliOptions {
  let mode: Mode = "daily-all";
  let maxNewListings: number | null = null;
  let pricingWeeks = 24;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    if (arg === "--mode" && value) {
      if (
        value === "monthly-full" ||
        value === "daily-new-listings" ||
        value === "daily-availability" ||
        value === "daily-pricing" ||
        value === "daily-all"
      ) {
        mode = value;
      }
      index += 1;
      continue;
    }

    if (arg === "--max-new-listings" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        maxNewListings = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--pricing-weeks" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0 && parsed <= 52) {
        pricingWeeks = Math.floor(parsed);
      }
      index += 1;
    }
  }

  return {
    mode,
    maxNewListings,
    pricingWeeks,
  };
}

function normalizeLink(url: string): string {
  return url.split("#")[0]?.replace(/\/$/, "") ?? url;
}

async function runNpmScript(scriptName: string, args: string[] = []): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn("npm", ["run", scriptName, "--", ...args], {
      cwd: ROOT,
      stdio: "inherit",
      env: process.env,
    });

    activeChild = child;

    child.on("error", (error) => {
      activeChild = null;
      rejectPromise(error);
    });

    child.on("exit", (code, signal) => {
      activeChild = null;

      if (signal === "SIGINT" || signal === "SIGTERM") {
        wasCancelled = true;
        rejectPromise(new Error(`Command interrupted: npm run ${scriptName}`));
        return;
      }

      if (code === 0) {
        resolvePromise();
        return;
      }

      rejectPromise(
        new Error(`Command failed (${code ?? "unknown"}): npm run ${scriptName}`),
      );
    });
  });
}

async function loadKnownDetailUrls(): Promise<Set<string>> {
  const known = new Set<string>();

  let entries: Awaited<ReturnType<typeof readdir>> = [];
  try {
    entries = await readdir(DETAILS_JSON_DIR, { withFileTypes: true });
  } catch {
    return known;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }

    try {
      const raw = await readFile(resolve(DETAILS_JSON_DIR, entry.name), "utf8");
      const parsed = JSON.parse(raw) as KnownDetailRecord;
      if (typeof parsed.detail_url !== "string" || !parsed.detail_url.trim()) {
        continue;
      }
      known.add(normalizeLink(parsed.detail_url.trim()));
    } catch {
      // Ignore malformed files.
    }
  }

  return known;
}

async function loadDiscoveredDetailUrls(): Promise<string[]> {
  const raw = await readFile(DISCOVERY_LISTINGS_PATH, "utf8");
  const parsed = JSON.parse(raw) as DiscoveredListingRecord[];

  return parsed
    .map((row) => (typeof row.link === "string" ? normalizeLink(row.link.trim()) : ""))
    .filter((url) => url.length > 0);
}

async function runDailyNewListings(maxNewListings: number | null): Promise<void> {
  await runNpmScript("managers:scrape:30aescapes:raw", [
    "--discover-only",
    "--refresh-mode",
    "static",
  ]);

  const [knownUrls, discoveredUrls] = await Promise.all([
    loadKnownDetailUrls(),
    loadDiscoveredDetailUrls(),
  ]);

  const newUrls = Array.from(new Set(discoveredUrls))
    .filter((url) => !knownUrls.has(url))
    .sort();

  const selectedNewUrls =
    maxNewListings === null ? newUrls : newUrls.slice(0, maxNewListings);

  if (selectedNewUrls.length === 0) {
    console.log("30aescapes ops: no new listings detected in discovery.");
    return;
  }

  await mkdir(REPORTS_DIR, { recursive: true });
  await writeFile(NEW_URLS_FILE_PATH, `${selectedNewUrls.join("\n")}\n`, "utf8");

  await runNpmScript("managers:scrape:30aescapes:raw", [
    "--detail-urls-file",
    NEW_URLS_FILE_PATH,
    "--refresh-mode",
    "static",
  ]);

  console.log(
    `30aescapes ops: ingested ${selectedNewUrls.length} new listing(s) from discovery.`,
  );
}

async function runDailyAvailability(): Promise<void> {
  await runNpmScript("managers:scrape:30aescapes:raw", [
    "--refresh-known",
    "--refresh-mode",
    "static",
  ]);
}

async function runDailyPricing(pricingWeeks: number): Promise<void> {
  await runNpmScript("managers:scrape:30aescapes:raw", [
    "--refresh-known",
    "--refresh-mode",
    "dynamic",
  ]);
  await runNpmScript("pricing:cache:30aescapes:raw", [
    "--weeks",
    String(pricingWeeks),
  ]);
}

async function runMonthlyFull(): Promise<void> {
  await runNpmScript("managers:scrape:30aescapes:raw", [
    "--refresh-mode",
    "full",
  ]);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  process.on("SIGINT", () => {
    wasCancelled = true;
    if (activeChild && !activeChild.killed) {
      activeChild.kill("SIGINT");
    }
  });

  if (options.mode === "monthly-full") {
    await runMonthlyFull();
    return;
  }

  if (options.mode === "daily-new-listings") {
    await runDailyNewListings(options.maxNewListings);
    return;
  }

  if (options.mode === "daily-availability") {
    await runDailyAvailability();
    return;
  }

  if (options.mode === "daily-pricing") {
    await runDailyPricing(options.pricingWeeks);
    return;
  }

  await runDailyNewListings(options.maxNewListings);
  await runDailyAvailability();
  await runDailyPricing(options.pricingWeeks);
}

main()
  .then(() => {
    if (wasCancelled) {
      process.exit(130);
    }
    process.exit(0);
  })
  .catch((error: unknown) => {
    if (wasCancelled) {
      process.exit(130);
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    console.error(`30aescapes ops run failed: ${message}`);
    process.exit(1);
  });
