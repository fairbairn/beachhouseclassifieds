import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

type CliOptions = {
  adapters: string[] | "all";
  fullScrape: boolean;
  discoverNew: boolean;
  availabilityRefresh: boolean;
  pricingRefresh: boolean;
  pricingCache: boolean;
  allSteps: boolean;
  maxNewListings: number | null;
  pricingWeeks: number;
  continueOnError: boolean;
  dryRun: boolean;
};

type PackageJson = {
  scripts?: Record<string, string>;
};

type AdapterScriptInfo = {
  adapterKey: string;
  scrapeScript: string;
  scrapeCommand: string;
};

type KnownDetailRecord = {
  detail_url?: string;
};

type DiscoveredListingRecord = {
  link?: string;
};

const ROOT = process.cwd();
const REPORTS_DIR = resolve(ROOT, ".tmp", "reports");

let activeChild: ReturnType<typeof spawn> | null = null;
let wasCancelled = false;

function parseArgs(argv: string[]): CliOptions {
  let adapters: string[] | "all" = "all";
  let fullScrape = false;
  let discoverNew = false;
  let availabilityRefresh = false;
  let pricingRefresh = false;
  let pricingCache = false;
  let allSteps = false;
  let maxNewListings: number | null = null;
  let pricingWeeks = 24;
  let continueOnError = false;
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    if (arg === "--adapters" && value) {
      if (value.trim().toLowerCase() === "all") {
        adapters = "all";
      } else {
        adapters = value
          .split(",")
          .map((token) => token.trim().toLowerCase())
          .filter(Boolean);
      }
      index += 1;
      continue;
    }

    if (arg === "--full-scrape") {
      fullScrape = true;
      continue;
    }

    if (arg === "--discover-new") {
      discoverNew = true;
      continue;
    }

    if (arg === "--availability-refresh") {
      availabilityRefresh = true;
      continue;
    }

    if (arg === "--pricing-refresh") {
      pricingRefresh = true;
      continue;
    }

    if (arg === "--pricing-cache") {
      pricingCache = true;
      continue;
    }

    if (arg === "--all-steps") {
      allSteps = true;
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
      continue;
    }

    if (arg === "--continue-on-error") {
      continueOnError = true;
      continue;
    }

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
  }

  if (allSteps) {
    fullScrape = true;
    discoverNew = true;
    availabilityRefresh = true;
    pricingRefresh = true;
    pricingCache = true;
  }

  return {
    adapters,
    fullScrape,
    discoverNew,
    availabilityRefresh,
    pricingRefresh,
    pricingCache,
    allSteps,
    maxNewListings,
    pricingWeeks,
    continueOnError,
    dryRun,
  };
}

function normalizeLink(url: string): string {
  return url.split("#")[0]?.replace(/\/$/, "") ?? url;
}

function choosePreferredScript(
  existing: AdapterScriptInfo | null,
  incoming: AdapterScriptInfo,
): AdapterScriptInfo {
  if (!existing) {
    return incoming;
  }

  const score = (scriptName: string): number => {
    if (scriptName.endsWith(":engine:raw")) {
      return 3;
    }
    if (scriptName.endsWith(":raw")) {
      return 2;
    }
    return 1;
  };

  return score(incoming.scrapeScript) > score(existing.scrapeScript)
    ? incoming
    : existing;
}

async function readPackageScripts(): Promise<Record<string, string>> {
  const packageJsonPath = resolve(ROOT, "package.json");
  const raw = await readFile(packageJsonPath, "utf8");
  const parsed = JSON.parse(raw) as PackageJson;
  return parsed.scripts ?? {};
}

function buildAdapterScriptCatalog(
  scripts: Record<string, string>,
): Map<string, AdapterScriptInfo> {
  const byAdapter = new Map<string, AdapterScriptInfo>();

  for (const [scriptName, scriptCommand] of Object.entries(scripts)) {
    const engineMatch = scriptCommand.match(/scrape-([a-z0-9-]+)-engine\.ts/i);
    if (!engineMatch?.[1]) {
      continue;
    }

    const adapterKey = engineMatch[1].toLowerCase();
    const info: AdapterScriptInfo = {
      adapterKey,
      scrapeScript: scriptName,
      scrapeCommand: scriptCommand,
    };

    const existing = byAdapter.get(adapterKey) ?? null;
    byAdapter.set(adapterKey, choosePreferredScript(existing, info));
  }

  return byAdapter;
}

function resolveSelectedAdapters(
  requested: string[] | "all",
  catalog: Map<string, AdapterScriptInfo>,
): string[] {
  const known = Array.from(catalog.keys()).sort();
  if (requested === "all") {
    return known;
  }

  const unknown = requested.filter((adapter) => !catalog.has(adapter));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown adapter(s): ${unknown.join(", ")}. Known adapters: ${known.join(", ")}`,
    );
  }

  return requested;
}

async function runNpmScript(
  scriptName: string,
  args: string[],
  dryRun: boolean,
): Promise<void> {
  const commandText = `npm run ${scriptName}${args.length > 0 ? ` -- ${args.join(" ")}` : ""}`;
  if (dryRun) {
    console.log(`[dry-run] ${commandText}`);
    return;
  }

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
        rejectPromise(new Error(`Command interrupted: ${commandText}`));
        return;
      }

      if (code === 0) {
        resolvePromise();
        return;
      }

      rejectPromise(
        new Error(`Command failed (${code ?? "unknown"}): ${commandText}`),
      );
    });
  });
}

async function loadKnownDetailUrls(adapterKey: string): Promise<Set<string>> {
  const known = new Set<string>();
  const detailsJsonDir = resolve(
    ROOT,
    "src",
    "lib",
    "data",
    "external-sources",
    adapterKey,
    "details",
    "json",
  );

  let entries: Awaited<ReturnType<typeof readdir>> = [];
  try {
    entries = await readdir(detailsJsonDir, { withFileTypes: true });
  } catch {
    return known;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }

    try {
      const raw = await readFile(resolve(detailsJsonDir, entry.name), "utf8");
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

async function loadDiscoveredDetailUrls(adapterKey: string): Promise<string[]> {
  const listingsFilePath = resolve(
    ROOT,
    "src",
    "lib",
    "data",
    "external-sources",
    `${adapterKey}_listings.json`,
  );

  const raw = await readFile(listingsFilePath, "utf8");
  const parsed = JSON.parse(raw) as DiscoveredListingRecord[];

  return parsed
    .map((row) =>
      typeof row.link === "string" ? normalizeLink(row.link.trim()) : "",
    )
    .filter((url) => url.length > 0);
}

async function runDiscoverNewStep(
  adapter: AdapterScriptInfo,
  maxNewListings: number | null,
  dryRun: boolean,
): Promise<void> {
  await runNpmScript(
    adapter.scrapeScript,
    ["--discover-only", "--refresh-mode", "static"],
    dryRun,
  );

  if (dryRun) {
    return;
  }

  const [knownUrls, discoveredUrls] = await Promise.all([
    loadKnownDetailUrls(adapter.adapterKey),
    loadDiscoveredDetailUrls(adapter.adapterKey),
  ]);

  const newUrls = Array.from(new Set(discoveredUrls))
    .filter((url) => !knownUrls.has(url))
    .sort();

  const selectedNewUrls =
    maxNewListings === null ? newUrls : newUrls.slice(0, maxNewListings);

  if (selectedNewUrls.length === 0) {
    console.log(
      `${adapter.adapterKey}: no new listings detected in discovery.`,
    );
    return;
  }

  await mkdir(REPORTS_DIR, { recursive: true });
  const urlsFilePath = resolve(
    REPORTS_DIR,
    `${adapter.adapterKey}-new-listings-urls.txt`,
  );
  await writeFile(urlsFilePath, `${selectedNewUrls.join("\n")}\n`, "utf8");

  await runNpmScript(
    adapter.scrapeScript,
    ["--detail-urls-file", urlsFilePath, "--refresh-mode", "static"],
    false,
  );

  console.log(
    `${adapter.adapterKey}: ingested ${selectedNewUrls.length} new listing(s) from discovery.`,
  );
}

async function runAdapterSteps(
  adapter: AdapterScriptInfo,
  options: CliOptions,
  scripts: Record<string, string>,
): Promise<void> {
  console.log(`adapter ${adapter.adapterKey}: starting requested operations`);

  if (options.fullScrape) {
    await runNpmScript(
      adapter.scrapeScript,
      ["--refresh-mode", "full"],
      options.dryRun,
    );
  }

  if (options.discoverNew) {
    await runDiscoverNewStep(adapter, options.maxNewListings, options.dryRun);
  }

  if (options.availabilityRefresh) {
    await runNpmScript(
      adapter.scrapeScript,
      ["--refresh-known", "--refresh-mode", "static"],
      options.dryRun,
    );
  }

  if (options.pricingRefresh) {
    await runNpmScript(
      adapter.scrapeScript,
      ["--refresh-known", "--refresh-mode", "dynamic"],
      options.dryRun,
    );
  }

  if (options.pricingCache) {
    const pricingScript = `pricing:cache:${adapter.adapterKey}:raw`;
    if (!scripts[pricingScript]) {
      console.log(
        `${adapter.adapterKey}: skipped pricing-cache (no script '${pricingScript}').`,
      );
    } else {
      await runNpmScript(
        pricingScript,
        ["--weeks", String(options.pricingWeeks)],
        options.dryRun,
      );
    }
  }

  console.log(`adapter ${adapter.adapterKey}: completed requested operations`);
}

function ensureAnyStepEnabled(options: CliOptions): void {
  if (
    !options.fullScrape &&
    !options.discoverNew &&
    !options.availabilityRefresh &&
    !options.pricingRefresh &&
    !options.pricingCache
  ) {
    throw new Error(
      "No operation flags provided. Enable one or more: --full-scrape, --discover-new, --availability-refresh, --pricing-refresh, --pricing-cache.",
    );
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  ensureAnyStepEnabled(options);

  process.on("SIGINT", () => {
    wasCancelled = true;
    if (activeChild && !activeChild.killed) {
      activeChild.kill("SIGINT");
    }
  });

  const scripts = await readPackageScripts();
  const catalog = buildAdapterScriptCatalog(scripts);
  const selectedAdapters = resolveSelectedAdapters(options.adapters, catalog);

  const failures: Array<{ adapterKey: string; reason: string }> = [];

  for (const adapterKey of selectedAdapters) {
    const adapter = catalog.get(adapterKey);
    if (!adapter) {
      failures.push({
        adapterKey,
        reason: "missing scrape script mapping",
      });
      if (!options.continueOnError) {
        break;
      }
      continue;
    }

    try {
      await runAdapterSteps(adapter, options, scripts);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ adapterKey, reason: message });
      console.error(`${adapterKey}: ${message}`);
      if (!options.continueOnError) {
        break;
      }
    }
  }

  if (failures.length > 0) {
    const summary = failures
      .map((failure) => `${failure.adapterKey}: ${failure.reason}`)
      .join(" | ");
    throw new Error(`adapter ops completed with failures -> ${summary}`);
  }
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
    console.error(`adapter ops failed: ${message}`);
    process.exit(1);
  });
