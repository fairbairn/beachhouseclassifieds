import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createScrapeProgress } from "@/core/tooling/terminal/scrape-progress";
import {
  createValidatedAdapterOperationProxyByKey,
  getKnownAdapterKeys,
} from "@/lib/pricing/scraper-engine/adapter-registry";

type CliOptions = {
  adapters: string[] | "all";
  mode: string[] | null;
  fullScrape: boolean;
  discoverNew: boolean;
  availabilityRefresh: boolean;
  preferFullAvailabilityRefresh: boolean;
  pricingRefresh: boolean;
  quoteCapture: boolean;
  quotesValidate: boolean;
  pricingCache: boolean;
  allSteps: boolean;
  maxNewListings: number | null;
  quoteWeeks: number;
  quoteConcurrency: number;
  quoteListingConcurrency: number;
  quoteListingId: string | null;
  quoteMaxListings: number | null;
  quoteAllListings: boolean;
  quoteSkipExisting: boolean;
  pricingWeeks: number;
  continueOnError: boolean;
  dryRun: boolean;
};

type KnownDetailRecord = {
  external_listing_id?: string;
  detail_url?: string;
};

type DiscoveredListingRecord = {
  link?: string;
};

const ROOT = process.cwd();
const REPORTS_DIR = resolve(ROOT, ".tmp", "reports");
const runtimeProgress = createScrapeProgress({ script: "adapter-ops" });

let wasCancelled = false;

function parseModeTokens(rawModeValue: string): string[] {
  return rawModeValue
    .split(/[|,]/g)
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean)
    .map((token) => (token === "price" ? "pricing" : token));
}

function parseArgs(argv: string[]): CliOptions {
  let adapters: string[] | "all" = "all";
  let mode: string[] | null = null;
  let fullScrape = false;
  let discoverNew = false;
  let availabilityRefresh = false;
  let preferFullAvailabilityRefresh = false;
  let pricingRefresh = false;
  let quoteCapture = false;
  let quotesValidate = false;
  let pricingCache = false;
  let allSteps = false;
  let maxNewListings: number | null = null;
  let quoteWeeks = 24;
  let quoteConcurrency = 4;
  let quoteListingConcurrency = 2;
  let quoteListingId: string | null = null;
  let quoteMaxListings: number | null = null;
  let quoteAllListings = false;
  let quoteSkipExisting = false;
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

    if (arg === "--mode" && value) {
      mode = parseModeTokens(value);
      index += 1;
      continue;
    }

    if (arg.startsWith("--mode=")) {
      mode = parseModeTokens(arg.slice("--mode=".length));
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

    if (arg === "--quote-capture") {
      quoteCapture = true;
      continue;
    }

    if (arg === "--quotes-validate") {
      quotesValidate = true;
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

    if (arg === "--quote-weeks" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0 && parsed <= 52) {
        quoteWeeks = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--quote-concurrency" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        quoteConcurrency = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--quote-listing-concurrency" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        quoteListingConcurrency = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--quote-listing-id" && value) {
      quoteListingId = value.trim();
      index += 1;
      continue;
    }

    if (arg === "--quote-max-listings" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        quoteMaxListings = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--quote-all-listings") {
      quoteAllListings = true;
      continue;
    }

    if (arg === "--quote-skip-existing") {
      quoteSkipExisting = true;
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
    quoteCapture = true;
    quotesValidate = true;
    pricingCache = true;
  }

  if (mode !== null) {
    const allowed = new Set(["detail", "avail", "quote", "pricing"]);
    const unknown = mode.filter((token) => !allowed.has(token));
    if (unknown.length > 0) {
      throw new Error(
        `Unknown mode value(s): ${unknown.join(", ")}. Allowed mode values: detail, avail, quote, pricing.`,
      );
    }

    fullScrape = mode.includes("detail");
    availabilityRefresh = mode.includes("avail");
    preferFullAvailabilityRefresh = availabilityRefresh;
    quoteCapture = mode.includes("quote");
    pricingCache = mode.includes("pricing");
  }

  return {
    adapters,
    mode,
    fullScrape,
    discoverNew,
    availabilityRefresh,
    preferFullAvailabilityRefresh,
    pricingRefresh,
    quoteCapture,
    quotesValidate,
    pricingCache,
    allSteps,
    maxNewListings,
    quoteWeeks,
    quoteConcurrency,
    quoteListingConcurrency,
    quoteListingId,
    quoteMaxListings,
    quoteAllListings,
    quoteSkipExisting,
    pricingWeeks,
    continueOnError,
    dryRun,
  };
}

function normalizeLink(url: string): string {
  return url.split("#")[0]?.replace(/\/$/, "") ?? url;
}

function resolveSelectedAdapters(requested: string[] | "all"): string[] {
  const known = getKnownAdapterKeys();
  if (requested === "all") {
    return known;
  }

  const unknown = requested.filter((adapter) => !known.includes(adapter));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown adapter(s): ${unknown.join(", ")}. Known adapters: ${known.join(", ")}`,
    );
  }

  return requested;
}

function ensureNotCancelled(): void {
  if (wasCancelled) {
    throw new Error("Operation cancelled by user.");
  }
}

function logDryRun(
  operation: string,
  adapterKey: string,
  args: string[],
  progress: ReturnType<typeof createScrapeProgress>,
): void {
  const renderedArgs = args.join(" ");
  progress.tick(
    `[dry-run] ${operation} adapter=${adapterKey}${renderedArgs.length > 0 ? ` args=${renderedArgs}` : ""}`,
  );
}

async function runScrape(
  adapterKey: string,
  args: string[],
  dryRun: boolean,
  progress: ReturnType<typeof createScrapeProgress>,
): Promise<void> {
  ensureNotCancelled();
  if (dryRun) {
    logDryRun("scrape", adapterKey, args, progress);
    return;
  }

  const proxy = createValidatedAdapterOperationProxyByKey(adapterKey);
  if (!proxy) {
    throw new Error(`Unknown scrape adapter '${adapterKey}'.`);
  }

  await proxy.runScrape(args);
}

async function runQuoteCapture(
  adapterKey: string,
  args: string[],
  dryRun: boolean,
  progress: ReturnType<typeof createScrapeProgress>,
): Promise<void> {
  ensureNotCancelled();
  const proxy = createValidatedAdapterOperationProxyByKey(adapterKey);
  if (!proxy) {
    throw new Error(`Unknown adapter '${adapterKey}'.`);
  }

  if (!proxy.capabilities.quoteCapture) {
    progress.warn(
      `${adapterKey}: skipped quote-capture (adapter not quote-capable).`,
    );
    return;
  }

  if (dryRun) {
    logDryRun("quote", adapterKey, args, progress);
    return;
  }

  await proxy.runQuoteCapture(args, progress);
}

async function runQuoteValidation(
  adapterKey: string,
  dryRun: boolean,
  progress: ReturnType<typeof createScrapeProgress>,
): Promise<void> {
  ensureNotCancelled();
  const proxy = createValidatedAdapterOperationProxyByKey(adapterKey);
  if (!proxy) {
    throw new Error(`Unknown adapter '${adapterKey}'.`);
  }

  if (!proxy.capabilities.quoteValidation) {
    progress.warn(
      `${adapterKey}: skipped quotes-validate (adapter not quote-capable).`,
    );
    return;
  }

  if (dryRun) {
    logDryRun("validate", adapterKey, ["--adapter-key", adapterKey], progress);
    return;
  }

  await proxy.runQuoteValidation();
}

async function runPricingCache(
  adapterKey: string,
  args: string[],
  dryRun: boolean,
  progress: ReturnType<typeof createScrapeProgress>,
): Promise<void> {
  ensureNotCancelled();
  const proxy = createValidatedAdapterOperationProxyByKey(adapterKey);
  if (!proxy) {
    throw new Error(`Unknown adapter '${adapterKey}'.`);
  }

  if (!proxy.capabilities.pricingCache) {
    progress.warn(
      `${adapterKey}: skipped pricing-cache (adapter has no shared cache definition).`,
    );
    return;
  }

  if (dryRun) {
    logDryRun("cache", adapterKey, args, progress);
    return;
  }

  await proxy.runPricingCache(args);
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

  let entries: Array<{ isFile(): boolean; name: string }> = [];
  try {
    entries = await readdir(detailsJsonDir, {
      withFileTypes: true,
      encoding: "utf8",
    });
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

async function loadDetailUrlForListing(
  adapterKey: string,
  listingId: string,
): Promise<string | null> {
  const detailJsonPath = resolve(
    ROOT,
    "src",
    "lib",
    "data",
    "external-sources",
    adapterKey,
    "details",
    "json",
    `${listingId}.json`,
  );

  try {
    const raw = await readFile(detailJsonPath, "utf8");
    const parsed = JSON.parse(raw) as KnownDetailRecord;
    if (typeof parsed.detail_url === "string" && parsed.detail_url.trim()) {
      return parsed.detail_url.trim();
    }
    return null;
  } catch {
    return null;
  }
}

async function loadDiscoveredDetailUrls(adapterKey: string): Promise<string[]> {
  const listingsFilePath = resolve(
    ROOT,
    "src",
    "lib",
    "data",
    "external-sources",
    adapterKey,
    "working",
    "listings.json",
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
  adapterKey: string,
  maxNewListings: number | null,
  dryRun: boolean,
  progress: ReturnType<typeof createScrapeProgress>,
): Promise<void> {
  await runScrape(
    adapterKey,
    ["--discover-only", "--refresh-mode", "static"],
    dryRun,
    progress,
  );

  if (dryRun) {
    return;
  }

  const [knownUrls, discoveredUrls] = await Promise.all([
    loadKnownDetailUrls(adapterKey),
    loadDiscoveredDetailUrls(adapterKey),
  ]);

  const newUrls = Array.from(new Set(discoveredUrls))
    .filter((url) => !knownUrls.has(url))
    .sort();

  const selectedNewUrls =
    maxNewListings === null ? newUrls : newUrls.slice(0, maxNewListings);

  if (selectedNewUrls.length === 0) {
    progress.info(`${adapterKey}: no new listings detected in discovery.`);
    return;
  }

  await mkdir(REPORTS_DIR, { recursive: true });
  const urlsFilePath = resolve(
    REPORTS_DIR,
    `${adapterKey}-new-listings-urls.txt`,
  );
  await writeFile(urlsFilePath, `${selectedNewUrls.join("\n")}\n`, "utf8");

  await runScrape(
    adapterKey,
    ["--detail-urls-file", urlsFilePath, "--refresh-mode", "static"],
    false,
    progress,
  );

  progress.success(
    `${adapterKey}: ingested ${selectedNewUrls.length} new listing(s) from discovery.`,
  );
}

async function runAdapterSteps(
  adapterKey: string,
  options: CliOptions,
): Promise<void> {
  const progress = createScrapeProgress({ script: adapterKey });
  progress.phase("starting requested operations");

  const scopedDetailUrl = options.quoteListingId
    ? await loadDetailUrlForListing(adapterKey, options.quoteListingId)
    : null;

  if (options.fullScrape) {
    const fullScrapeArgs =
      scopedDetailUrl !== null
        ? ["--detail-url", scopedDetailUrl, "--refresh-mode", "full"]
        : ["--refresh-mode", "full"];
    await runScrape(adapterKey, fullScrapeArgs, options.dryRun, progress);
  }

  if (options.discoverNew) {
    await runDiscoverNewStep(
      adapterKey,
      options.maxNewListings,
      options.dryRun,
      progress,
    );
  }

  if (options.availabilityRefresh) {
    if (options.fullScrape) {
      progress.info(
        `${adapterKey}: skipping avail step because detail mode/full-scrape already ran availability extraction.`,
      );
    } else {
      const availabilityArgs =
        scopedDetailUrl !== null
          ? ["--detail-url", scopedDetailUrl, "--refresh-mode", "static"]
          : options.preferFullAvailabilityRefresh
            ? ["--refresh-mode", "full"]
            : ["--refresh-known", "--refresh-mode", "static"];
      await runScrape(adapterKey, availabilityArgs, options.dryRun, progress);
    }
  }

  if (options.pricingRefresh) {
    const pricingRefreshArgs =
      scopedDetailUrl !== null
        ? ["--detail-url", scopedDetailUrl, "--refresh-mode", "dynamic"]
        : ["--refresh-known", "--refresh-mode", "dynamic"];
    await runScrape(adapterKey, pricingRefreshArgs, options.dryRun, progress);
  }

  if (options.quoteCapture) {
    const quoteScopeArgs: string[] = [];
    if (options.quoteListingId) {
      quoteScopeArgs.push("--listing-id", options.quoteListingId);
    } else if (options.quoteMaxListings !== null) {
      quoteScopeArgs.push("--max-listings", String(options.quoteMaxListings));
    } else if (options.quoteAllListings) {
      quoteScopeArgs.push("--all-listings");
    }

    await runQuoteCapture(
      adapterKey,
      [
        "--weeks",
        String(options.quoteWeeks),
        "--quote-concurrency",
        String(options.quoteConcurrency),
        "--listing-concurrency",
        String(options.quoteListingConcurrency),
        ...(options.quoteSkipExisting ? ["--skip-existing"] : []),
        ...quoteScopeArgs,
      ],
      options.dryRun,
      progress,
    );
  }

  if (options.quotesValidate) {
    await runQuoteValidation(adapterKey, options.dryRun, progress);
  }

  if (options.pricingCache) {
    const pricingScopeArgs: string[] = [];
    if (options.quoteListingId) {
      pricingScopeArgs.push("--listing-id", options.quoteListingId);
    } else if (options.quoteMaxListings !== null) {
      pricingScopeArgs.push("--max-listings", String(options.quoteMaxListings));
    }

    await runPricingCache(
      adapterKey,
      ["--weeks", String(options.pricingWeeks), ...pricingScopeArgs],
      options.dryRun,
      progress,
    );
  }

  progress.success("completed requested operations");
}

function ensureAnyStepEnabled(options: CliOptions): void {
  if (
    !options.fullScrape &&
    !options.discoverNew &&
    !options.availabilityRefresh &&
    !options.pricingRefresh &&
    !options.quoteCapture &&
    !options.quotesValidate &&
    !options.pricingCache
  ) {
    throw new Error(
      "No operation flags provided. Enable one or more: --mode, --full-scrape, --discover-new, --availability-refresh, --pricing-refresh, --quote-capture, --quotes-validate, --pricing-cache.",
    );
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  ensureAnyStepEnabled(options);

  runtimeProgress.phase("starting unified adapter runtime");
  runtimeProgress.info(
    `adapters=${options.adapters === "all" ? "all" : options.adapters.join(",")} mode=${options.mode?.join(",") ?? "n/a"} dry_run=${options.dryRun} quote_weeks=${options.quoteWeeks} quote_concurrency=${options.quoteConcurrency} quote_listing_concurrency=${options.quoteListingConcurrency} quote_listing_id=${options.quoteListingId ?? "n/a"} quote_max_listings=${options.quoteMaxListings ?? "n/a"} quote_all_listings=${options.quoteAllListings} quote_skip_existing=${options.quoteSkipExisting} pricing_weeks=${options.pricingWeeks}`,
  );

  process.on("SIGINT", () => {
    wasCancelled = true;
  });

  const selectedAdapters = resolveSelectedAdapters(options.adapters);
  const failures: Array<{ adapterKey: string; reason: string }> = [];

  for (const adapterKey of selectedAdapters) {
    if (wasCancelled) {
      break;
    }

    try {
      await runAdapterSteps(adapterKey, options);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ adapterKey, reason: message });
      const adapterProgress = createScrapeProgress({ script: adapterKey });
      adapterProgress.failure(message);
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

  runtimeProgress.success("unified adapter runtime complete");
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
    }

    const message = error instanceof Error ? error.message : String(error);
    runtimeProgress.failure(`adapter runtime failed: ${message}`);
    process.exit(1);
  });
