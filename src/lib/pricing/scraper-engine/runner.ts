import { access, mkdir, open, readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { Browser } from "playwright";

import {
  createScrapeProgress,
  formatModeProgressLine,
} from "@/core/tooling/terminal/scrape-progress";

import type {
  DetailRecordBase,
  RunOptions,
  ScrapedLink,
  ScraperAdapter,
  ScraperInventoryMode,
  ScraperRefreshMode,
  ScraperRunMode,
} from "./types";

const RUN_MODE_ORDER = ["detail", "avail", "quote"] as const;

function normalizeMode(value: string): ScraperRunMode | null {
  const tokens = value
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) {
    return null;
  }

  const unique = new Set(tokens);
  for (const token of unique) {
    if (!RUN_MODE_ORDER.includes(token as (typeof RUN_MODE_ORDER)[number])) {
      return null;
    }
  }

  const canonical = RUN_MODE_ORDER.filter((token) => unique.has(token)).join(
    ",",
  );
  return canonical as ScraperRunMode;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function normalizeLink(url: string): string {
  return url.split("#")[0]?.replace(/\/$/, "") ?? url;
}

function externalListingIdFromDetailUrl(detailUrl: string): string {
  try {
    const url = new URL(detailUrl);
    const idsTuple =
      url.searchParams.get("rcav[IDs][8][0]") ??
      url.searchParams.get("rcav%5BIDs%5D%5B8%5D%5B0%5D") ??
      "";
    const tupleIdMatch = idsTuple.match(/(?:\d+-)?(\d+)$/);
    if (tupleIdMatch?.[1]) {
      return tupleIdMatch[1];
    }

    const segments = url.pathname.split("/").filter(Boolean);
    return segments[segments.length - 1] ?? "";
  } catch {
    const normalized = normalizeLink(detailUrl);
    const segments = normalized.split("/").filter(Boolean);
    return segments[segments.length - 1] ?? "";
  }
}

function extractCanonicalQuoteContext(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const context = value as Record<string, unknown>;
  const sanitized = Object.fromEntries(
    Object.entries(context).filter(([key]) => key !== "endpoint_path"),
  );

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function toProjectRelativePath(pathValue: string, root: string): string {
  const trimmed = pathValue.trim();
  if (!trimmed) {
    return "";
  }

  const absolute = isAbsolute(trimmed) ? trimmed : resolve(root, trimmed);
  const rel = relative(root, absolute);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    return trimmed.replace(/\\/g, "/");
  }

  return rel.replace(/\\/g, "/");
}

function resolveFromProjectRoot(pathValue: string, root: string): string {
  const trimmed = pathValue.trim();
  if (!trimmed) {
    return "";
  }
  return isAbsolute(trimmed) ? trimmed : resolve(root, trimmed);
}

function buildUsageText(defaultAnchorUrl: string): string {
  return [
    "Usage:",
    `  <script> [anchor-url] [options]`,
    "",
    `Default anchor URL: ${defaultAnchorUrl}`,
    "",
    "Options:",
    "  --target-detail-url <url>          Scrape one detail URL and exit",
    "  --inventory-mode <full-scan|refresh-known>",
    "                                   Select full site discovery vs known-set refresh",
    "  --target-detail-urls-file <path>   Refresh URLs listed in file (one URL per line)",
    "  --target-refresh-known              Refresh known URLs from existing artifacts",
    "  --run-discover-only                 Discover links only (no detail pulls)",
    "  --target-max-listings <n>          Positive integer",
    "  --target-start-index <n>           Non-negative integer",
    "  --engine-scroll-steps <n>          Positive integer",
    "  --engine-scroll-pause-ms <n>       Positive integer",
    "  --engine-network-idle-wait-ms <n>  Positive integer",
    "  --detail-fetch-concurrency <n>      Positive integer",
    "  --detail-fetch-delay-ms <n>         Non-negative integer",
    "  --detail-timeout-ms <n>             Positive integer",
    "  --detail-retry-attempts <n>         Non-negative integer (bounded retry passes)",
    "  --detail-retry-delay-ms <n>         Non-negative integer (delay between retries)",
    "  --skip-existing-details             Skip pull when detail JSON already exists",
    "  --skip-fresh-details                Skip pull for fresh existing artifacts",
    "  --fresh-hours <n>                   Positive integer",
    "  --run-mode <detail|avail|quote|...> Data pull mode (canonical order detail,avail,quote)",
    "  --run-refresh-mode <full|dynamic|static>",
    "  --avail-horizon-days <n>            Override availability horizon days",
    "  --avail-max-calendar-months <n>     Override availability calendar months",
    "  --quote-window-days <n>             Override quote window days",
    "  --quote-sample-step-days <n>        Override quote sample step days",
    "  --quote-nights <n>                  Override quote nights",
    "  --quote-max-queries <n>             Override quote sample count",
    "  --quote-anchor-date <YYYY-MM-DD>    Override quote anchor date",
    "  --quote-observation-retry-delays-ms <csv> Override quote retry delays",
    "  --allow-canonical-prune             Allow canonical index entry removals (manual approval)",
    "  --allow-empty-canonical-index-prune Allow writing an empty canonical index (manual approval)",
    "  --mode, --refresh-mode, --detail-url, --detail-urls-file,",
    "  --refresh-known, --discover-only, --max-listings, --start-index,",
    "  --max-scroll-steps, --scroll-pause-ms, --network-idle-wait-ms",
    "                                   are supported as backward-compatible aliases.",
    "  --help                              Show this help",
    "",
    "Mode constraints:",
    "  --target-detail-url cannot be combined with --target-detail-urls-file, --target-refresh-known, or --run-discover-only.",
  ].join("\n");
}

type CanonicalIndexEntry = {
  detail_url: string;
  external_listing_id: string;
  quote_context?: Record<string, unknown>;
};

async function loadCanonicalIndexUrls(
  canonicalIndexPath: string,
): Promise<Set<string>> {
  try {
    const raw = await readFile(canonicalIndexPath, "utf8");
    const parsed = JSON.parse(raw) as Array<{ detail_url?: unknown }>;
    if (!Array.isArray(parsed)) {
      return new Set();
    }

    return new Set(
      parsed
        .map((entry) =>
          typeof entry?.detail_url === "string"
            ? normalizeLink(entry.detail_url)
            : "",
        )
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

async function writeCanonicalIndexWithPruneGuard(params: {
  canonicalIndexPath: string;
  canonicalIndex: CanonicalIndexEntry[];
  allowCanonicalPrune: boolean;
  allowEmptyCanonicalIndexPrune: boolean;
}): Promise<void> {
  const {
    canonicalIndexPath,
    canonicalIndex,
    allowCanonicalPrune,
    allowEmptyCanonicalIndexPrune,
  } = params;

  const existingUrls = await loadCanonicalIndexUrls(canonicalIndexPath);
  const nextUrls = new Set(
    canonicalIndex
      .map((entry) => normalizeLink(entry.detail_url))
      .filter(Boolean),
  );

  const prunedUrls = Array.from(existingUrls).filter(
    (url) => !nextUrls.has(url),
  );
  if (prunedUrls.length > 0 && !allowCanonicalPrune) {
    const sample = prunedUrls.slice(0, 5).join(", ");
    throw new Error(
      `Canonical index prune blocked for ${canonicalIndexPath}: existing=${existingUrls.size}, next=${nextUrls.size}, pruned=${prunedUrls.length}. ` +
        `Manual approval required. Re-run with --allow-canonical-prune. Sample removed URLs: ${sample}`,
    );
  }

  if (
    nextUrls.size === 0 &&
    existingUrls.size > 0 &&
    !allowEmptyCanonicalIndexPrune
  ) {
    throw new Error(
      `Empty canonical index write blocked for ${canonicalIndexPath}: existing entries=${existingUrls.size}, next entries=0. ` +
        "Manual approval required. Re-run with --allow-empty-canonical-index-prune after verification.",
    );
  }

  await writeTextFileDurable(
    canonicalIndexPath,
    `${JSON.stringify(canonicalIndex, null, 2)}\n`,
  );
}

async function writeTextFileDurable(
  filePath: string,
  content: string,
): Promise<void> {
  const handle = await open(filePath, "w");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function loadPlaywright(): Promise<{
  chromium: (typeof import("playwright"))["chromium"];
}> {
  try {
    const module = await import("playwright");
    return { chromium: module.chromium };
  } catch {
    throw new Error(
      "Playwright is not installed. Run: npm install -D playwright && npx playwright install chromium",
    );
  }
}

function parseRunOptions(argv: string[], defaultAnchorUrl: string): RunOptions {
  let anchorUrl = defaultAnchorUrl;
  let inventoryMode: ScraperInventoryMode = "full-scan";
  let inventoryModeExplicit = false;
  let maxListings: number | null = null;
  let startIndex = 0;
  let discoverOnly = false;
  let detailUrl: string | null = null;
  let detailUrlsFile: string | null = null;
  let refreshKnown = false;
  let refreshKnownExplicit = false;
  let maxScrollSteps = 80;
  let scrollPauseMs = 900;
  let networkIdleWaitMs = 800;
  let detailFetchConcurrency: number | null = null;
  let detailFetchDelayMs: number | null = null;
  const detailTimeoutFromEnv = Number(
    process.env.SCRAPER_DETAIL_TIMEOUT_MS ?? "120000",
  );
  let detailTimeoutMs =
    Number.isFinite(detailTimeoutFromEnv) && detailTimeoutFromEnv > 0
      ? Math.floor(detailTimeoutFromEnv)
      : 120000;
  const detailRetryAttemptsFromEnv = Number(
    process.env.SCRAPER_DETAIL_RETRY_ATTEMPTS ?? "1",
  );
  let detailRetryAttempts =
    Number.isFinite(detailRetryAttemptsFromEnv) &&
    detailRetryAttemptsFromEnv >= 0
      ? Math.min(5, Math.floor(detailRetryAttemptsFromEnv))
      : 1;
  const detailRetryDelayFromEnv = Number(
    process.env.SCRAPER_DETAIL_RETRY_DELAY_MS ?? "2000",
  );
  let detailRetryDelayMs =
    Number.isFinite(detailRetryDelayFromEnv) && detailRetryDelayFromEnv >= 0
      ? Math.floor(detailRetryDelayFromEnv)
      : 2000;
  const skipExistingFromEnv =
    process.env.SCRAPER_SKIP_EXISTING_DETAILS === "1" ||
    process.env.SCRAPER_SKIP_EXISTING_DETAILS === "true";
  let skipExistingDetails = skipExistingFromEnv;
  const refreshModeFromEnv =
    process.env.SCRAPER_REFRESH_MODE === "dynamic" ||
    process.env.SCRAPER_REFRESH_MODE === "static"
      ? (process.env.SCRAPER_REFRESH_MODE as ScraperRefreshMode)
      : "full";
  let refreshMode: ScraperRefreshMode = refreshModeFromEnv;
  let refreshModeExplicit = false;
  const modeFromEnv = normalizeMode(process.env.SCRAPER_MODE ?? "");
  let mode: ScraperRunMode = modeFromEnv ?? "detail,avail";
  let availHorizonDays: number | null = null;
  let availMaxCalendarMonths: number | null = null;
  let quoteWindowDays: number | null = null;
  let quoteSampleStepDays: number | null = null;
  let quoteNights: number | null = null;
  let quoteMaxQueries: number | null = null;
  let quoteAnchorDate: string | null = null;
  let quoteObservationRetryDelaysMs: string | null = null;
  const allowCanonicalPruneFromEnv =
    process.env.SCRAPER_ALLOW_CANONICAL_PRUNE === "1" ||
    process.env.SCRAPER_ALLOW_CANONICAL_PRUNE === "true";
  let allowCanonicalPrune = allowCanonicalPruneFromEnv;
  const allowEmptyCanonicalIndexPruneFromEnv =
    process.env.SCRAPER_ALLOW_EMPTY_CANONICAL_INDEX_PRUNE === "1" ||
    process.env.SCRAPER_ALLOW_EMPTY_CANONICAL_INDEX_PRUNE === "true";
  let allowEmptyCanonicalIndexPrune = allowEmptyCanonicalIndexPruneFromEnv;
  const skipFreshFromEnv =
    process.env.SCRAPER_SKIP_FRESH_DETAILS === "1" ||
    process.env.SCRAPER_SKIP_FRESH_DETAILS === "true";
  const freshHoursFromEnv = Number(process.env.SCRAPER_FRESH_HOURS ?? "24");
  let skipFreshDetails = skipFreshFromEnv;
  let freshHours =
    Number.isFinite(freshHoursFromEnv) && freshHoursFromEnv > 0
      ? Math.floor(freshHoursFromEnv)
      : 24;
  const errors: string[] = [];

  const parsePositiveInt = (value: string, flag: string): number | null => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      errors.push(`${flag} must be a positive number. Received: ${value}`);
      return null;
    }
    return Math.floor(parsed);
  };

  const parseNonNegativeInt = (value: string, flag: string): number | null => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
      errors.push(`${flag} must be a non-negative number. Received: ${value}`);
      return null;
    }
    return Math.floor(parsed);
  };

  const requireValue = (
    args: string[],
    currentIndex: number,
    flag: string,
  ): string | null => {
    const nextValue = args[currentIndex + 1];
    if (!nextValue || nextValue.startsWith("--")) {
      errors.push(`${flag} requires a value.`);
      return null;
    }
    return nextValue;
  };

  let index = 2;
  if (argv[index] && !argv[index]?.startsWith("--")) {
    anchorUrl = argv[index] as string;
    index += 1;
  }

  for (; index < argv.length; index += 1) {
    const arg = argv[index];

    if (!arg) {
      continue;
    }

    if (arg === "--help") {
      throw new Error(buildUsageText(defaultAnchorUrl));
    }

    if (arg === "--max-listings" || arg === "--target-max-listings") {
      const value = requireValue(argv, index, arg);
      if (value) {
        const parsed = parsePositiveInt(value, arg);
        if (parsed !== null) {
          maxListings = parsed;
        }
      }
      index += 1;
      continue;
    }

    if (arg === "--start-index" || arg === "--target-start-index") {
      const value = requireValue(argv, index, arg);
      if (value) {
        const parsed = parseNonNegativeInt(value, arg);
        if (parsed !== null) {
          startIndex = parsed;
        }
      }
      index += 1;
      continue;
    }

    if (arg === "--detail-url" || arg === "--target-detail-url") {
      const value = requireValue(argv, index, arg);
      if (value) {
        detailUrl = value;
      }
      index += 1;
      continue;
    }

    if (arg === "--discover-only" || arg === "--run-discover-only") {
      discoverOnly = true;
      continue;
    }

    if (arg === "--detail-urls-file" || arg === "--target-detail-urls-file") {
      const value = requireValue(argv, index, arg);
      if (value) {
        detailUrlsFile = value;
      }
      index += 1;
      continue;
    }

    if (arg === "--refresh-known" || arg === "--target-refresh-known") {
      refreshKnown = true;
      refreshKnownExplicit = true;
      continue;
    }

    if (arg === "--inventory-mode") {
      const value = requireValue(argv, index, arg);
      if (value) {
        const normalized = value.trim().toLowerCase();
        if (normalized === "full-scan" || normalized === "refresh-known") {
          inventoryMode = normalized as ScraperInventoryMode;
          inventoryModeExplicit = true;
        } else {
          errors.push(
            `${arg} must be one of: full-scan, refresh-known. Received: ${value}`,
          );
        }
      }
      index += 1;
      continue;
    }

    if (arg === "--max-scroll-steps" || arg === "--engine-scroll-steps") {
      const value = requireValue(argv, index, arg);
      if (value) {
        const parsed = parsePositiveInt(value, arg);
        if (parsed !== null) {
          maxScrollSteps = parsed;
        }
      }
      index += 1;
      continue;
    }

    if (arg === "--scroll-pause-ms" || arg === "--engine-scroll-pause-ms") {
      const value = requireValue(argv, index, arg);
      if (value) {
        const parsed = parsePositiveInt(value, arg);
        if (parsed !== null) {
          scrollPauseMs = parsed;
        }
      }
      index += 1;
      continue;
    }

    if (
      arg === "--network-idle-wait-ms" ||
      arg === "--engine-network-idle-wait-ms"
    ) {
      const value = requireValue(argv, index, arg);
      if (value) {
        const parsed = parsePositiveInt(value, arg);
        if (parsed !== null) {
          networkIdleWaitMs = parsed;
        }
      }
      index += 1;
      continue;
    }

    if (arg === "--detail-fetch-concurrency") {
      const value = requireValue(argv, index, arg);
      if (value) {
        const parsed = parsePositiveInt(value, arg);
        if (parsed !== null) {
          detailFetchConcurrency = parsed;
        }
      }
      index += 1;
      continue;
    }

    if (arg === "--detail-fetch-delay-ms") {
      const value = requireValue(argv, index, arg);
      if (value) {
        const parsed = parseNonNegativeInt(value, arg);
        if (parsed !== null) {
          detailFetchDelayMs = parsed;
        }
      }
      index += 1;
      continue;
    }

    if (arg === "--detail-timeout-ms") {
      const value = requireValue(argv, index, arg);
      if (value) {
        const parsed = parsePositiveInt(value, arg);
        if (parsed !== null) {
          detailTimeoutMs = parsed;
        }
      }
      index += 1;
      continue;
    }

    if (arg === "--detail-retry-attempts") {
      const value = requireValue(argv, index, arg);
      if (value) {
        const parsed = parseNonNegativeInt(value, arg);
        if (parsed !== null) {
          detailRetryAttempts = Math.min(5, parsed);
        }
      }
      index += 1;
      continue;
    }

    if (arg === "--detail-retry-delay-ms") {
      const value = requireValue(argv, index, arg);
      if (value) {
        const parsed = parseNonNegativeInt(value, arg);
        if (parsed !== null) {
          detailRetryDelayMs = parsed;
        }
      }
      index += 1;
      continue;
    }

    if (arg === "--skip-existing-details") {
      skipExistingDetails = true;
      continue;
    }

    if (arg === "--skip-fresh-details") {
      skipFreshDetails = true;
      continue;
    }

    if (arg === "--fresh-hours") {
      const value = requireValue(argv, index, arg);
      if (value) {
        const parsed = parsePositiveInt(value, arg);
        if (parsed !== null) {
          freshHours = parsed;
        }
      }
      index += 1;
      continue;
    }

    if (arg === "--refresh-mode" || arg === "--run-refresh-mode") {
      const value = requireValue(argv, index, arg);
      if (value) {
        if (value === "full" || value === "dynamic" || value === "static") {
          refreshMode = value;
          refreshModeExplicit = true;
        } else {
          errors.push(
            `${arg} must be one of: full, dynamic, static. Received: ${value}`,
          );
        }
      }
      index += 1;
      continue;
    }

    if (arg === "--mode" || arg === "--run-mode") {
      const value = requireValue(argv, index, arg);
      if (value) {
        const normalized = normalizeMode(value);
        if (normalized) {
          mode = normalized;
        } else {
          errors.push(
            `${arg} must be a comma-separated subset of: detail, avail, quote. Received: ${value}`,
          );
        }
      }
      index += 1;
      continue;
    }

    if (arg === "--detail-only") {
      mode = "detail,avail";
      continue;
    }

    if (arg === "--availability-only") {
      mode = "avail";
      continue;
    }

    if (arg === "--quote-only") {
      mode = "quote";
      continue;
    }

    if (arg === "--avail-horizon-days") {
      const value = requireValue(argv, index, arg);
      if (value) {
        const parsed = parsePositiveInt(value, arg);
        if (parsed !== null) {
          availHorizonDays = parsed;
        }
      }
      index += 1;
      continue;
    }

    if (arg === "--avail-max-calendar-months") {
      const value = requireValue(argv, index, arg);
      if (value) {
        const parsed = parsePositiveInt(value, arg);
        if (parsed !== null) {
          availMaxCalendarMonths = parsed;
        }
      }
      index += 1;
      continue;
    }

    if (arg === "--quote-window-days") {
      const value = requireValue(argv, index, arg);
      if (value) {
        const parsed = parsePositiveInt(value, arg);
        if (parsed !== null) {
          quoteWindowDays = parsed;
        }
      }
      index += 1;
      continue;
    }

    if (arg === "--quote-sample-step-days") {
      const value = requireValue(argv, index, arg);
      if (value) {
        const parsed = parsePositiveInt(value, arg);
        if (parsed !== null) {
          quoteSampleStepDays = parsed;
        }
      }
      index += 1;
      continue;
    }

    if (arg === "--quote-nights") {
      const value = requireValue(argv, index, arg);
      if (value) {
        const parsed = parsePositiveInt(value, arg);
        if (parsed !== null) {
          quoteNights = parsed;
        }
      }
      index += 1;
      continue;
    }

    if (arg === "--quote-max-queries") {
      const value = requireValue(argv, index, arg);
      if (value) {
        const parsed = parsePositiveInt(value, arg);
        if (parsed !== null) {
          quoteMaxQueries = parsed;
        }
      }
      index += 1;
      continue;
    }

    if (arg === "--quote-anchor-date") {
      const value = requireValue(argv, index, arg);
      if (value) {
        quoteAnchorDate = value.trim();
      }
      index += 1;
      continue;
    }

    if (arg === "--quote-observation-retry-delays-ms") {
      const value = requireValue(argv, index, arg);
      if (value) {
        quoteObservationRetryDelaysMs = value.trim();
      }
      index += 1;
      continue;
    }

    if (arg === "--allow-canonical-prune") {
      allowCanonicalPrune = true;
      continue;
    }

    if (arg === "--allow-empty-canonical-index-prune") {
      allowEmptyCanonicalIndexPrune = true;
      continue;
    }

    if (arg.startsWith("--")) {
      errors.push(`Unknown flag: ${arg}`);
      continue;
    }

    errors.push(`Unexpected positional argument: ${arg}`);
  }

  if (detailUrl && (detailUrlsFile || refreshKnown || discoverOnly)) {
    errors.push(
      "--target-detail-url cannot be combined with --target-detail-urls-file, --target-refresh-known, or --run-discover-only.",
    );
  }

  if (inventoryModeExplicit && inventoryMode === "full-scan") {
    if (refreshKnownExplicit || detailUrlsFile) {
      errors.push(
        "--inventory-mode full-scan cannot be combined with --target-refresh-known or --target-detail-urls-file.",
      );
    }
  }

  if (inventoryModeExplicit && inventoryMode === "refresh-known") {
    refreshKnown = true;
  }

  if (!inventoryModeExplicit) {
    if (refreshKnown || detailUrlsFile) {
      inventoryMode = "refresh-known";
    } else {
      inventoryMode = "full-scan";
    }
  }

  if (quoteAnchorDate && !/^\d{4}-\d{2}-\d{2}$/.test(quoteAnchorDate)) {
    errors.push(
      `--quote-anchor-date must be YYYY-MM-DD. Received: ${quoteAnchorDate}`,
    );
  }

  if (quoteObservationRetryDelaysMs) {
    const csvValid = quoteObservationRetryDelaysMs
      .split(",")
      .map((token) => token.trim())
      .filter(Boolean)
      .every((token) => /^\d+$/.test(token));
    if (!csvValid) {
      errors.push(
        `--quote-observation-retry-delays-ms must be comma-separated non-negative integers. Received: ${quoteObservationRetryDelaysMs}`,
      );
    }
  }

  if (!refreshModeExplicit) {
    if (mode.includes("quote")) {
      refreshMode = "dynamic";
    }
    if (!mode.includes("quote")) {
      refreshMode = "static";
    }
  }

  if (errors.length > 0) {
    const details = errors.map((entry) => `- ${entry}`).join("\n");
    throw new Error(
      `Invalid scraper-engine parameters:\n${details}\n\n${buildUsageText(defaultAnchorUrl)}`,
    );
  }

  return {
    anchorUrl,
    inventoryMode,
    maxListings,
    startIndex,
    discoverOnly,
    detailUrl,
    detailUrlsFile,
    refreshKnown,
    maxScrollSteps,
    scrollPauseMs,
    networkIdleWaitMs,
    detailFetchConcurrency,
    detailFetchDelayMs,
    detailTimeoutMs,
    detailRetryAttempts,
    detailRetryDelayMs,
    skipExistingDetails,
    skipFreshDetails,
    freshHours,
    refreshMode,
    mode,
    availHorizonDays,
    availMaxCalendarMonths,
    quoteWindowDays,
    quoteSampleStepDays,
    quoteNights,
    quoteMaxQueries,
    quoteAnchorDate,
    quoteObservationRetryDelaysMs,
    allowCanonicalPrune,
    allowEmptyCanonicalIndexPrune,
    logLevel: "default",
  };
}

type TimedDetailFetchOutcome<TDetail extends DetailRecordBase> =
  | { timedOut: false; detail: TDetail | null }
  | { timedOut: true };

async function runTimedDetailFetch<TDetail extends DetailRecordBase>(
  fetchPromise: Promise<TDetail | null>,
  timeoutMs: number,
): Promise<TimedDetailFetchOutcome<TDetail>> {
  if (timeoutMs <= 0) {
    return { timedOut: false, detail: await fetchPromise };
  }

  const settledFetchPromise = fetchPromise.then(
    (detail) => ({ kind: "fetch" as const, detail }),
    (error: unknown) => {
      throw error;
    },
  );
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<{ kind: "timeout" }>((resolvePromise) => {
    timeoutHandle = setTimeout(() => {
      resolvePromise({ kind: "timeout" });
    }, timeoutMs);
    if (
      timeoutHandle &&
      typeof (timeoutHandle as { unref?: () => void }).unref === "function"
    ) {
      (timeoutHandle as { unref: () => void }).unref();
    }
  });

  try {
    const result = await Promise.race([settledFetchPromise, timeoutPromise]);
    if (result.kind === "timeout") {
      return { timedOut: true };
    }
    return { timedOut: false, detail: result.detail };
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

type ExistingDetailArtifact = {
  detailUrl: string;
  externalListingId: string;
  fetchedAt: Date;
  jsonPath: string;
  htmlPath: string | null;
  quoteContext?: Record<string, unknown>;
};

async function loadExistingDetailArtifacts(
  root: string,
  outputDetailsJsonDir: string,
  validate: (value: string) => string | null,
): Promise<Map<string, ExistingDetailArtifact>> {
  const byUrl = new Map<string, ExistingDetailArtifact>();

  let entries: Awaited<ReturnType<typeof readdir>> = [];
  try {
    entries = await readdir(outputDetailsJsonDir, { withFileTypes: true });
  } catch {
    return byUrl;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }

    const jsonPath = resolve(outputDetailsJsonDir, entry.name);
    try {
      const raw = await readFile(jsonPath, "utf8");
      const parsed = JSON.parse(raw) as {
        detail_url?: unknown;
        fetched_at?: unknown;
        html_path?: unknown;
        external_listing_id?: unknown;
      };

      const detailUrlRaw =
        typeof parsed.detail_url === "string" ? parsed.detail_url : "";
      const detailUrl = validate(detailUrlRaw);
      if (!detailUrl) {
        continue;
      }

      const fetchedAtRaw =
        typeof parsed.fetched_at === "string" ? parsed.fetched_at : "";
      const fetchedAt = new Date(fetchedAtRaw);
      if (!Number.isFinite(fetchedAt.getTime())) {
        continue;
      }

      const htmlPath =
        typeof parsed.html_path === "string" &&
        parsed.html_path.trim().length > 0
          ? resolveFromProjectRoot(parsed.html_path, root)
          : null;
      const externalListingId =
        typeof parsed.external_listing_id === "string"
          ? parsed.external_listing_id.trim()
          : "";
      if (!externalListingId) {
        continue;
      }

      const quoteContext = extractCanonicalQuoteContext(
        (parsed as { quote_context?: unknown }).quote_context,
      );

      byUrl.set(detailUrl, {
        detailUrl,
        externalListingId,
        fetchedAt,
        jsonPath,
        htmlPath,
        quoteContext,
      });
    } catch {
      // Ignore malformed detail files.
    }
  }

  return byUrl;
}

async function isArtifactFreshAndValid(
  artifact: ExistingDetailArtifact,
  freshHours: number,
): Promise<boolean> {
  const now = Date.now();
  const ageMs = now - artifact.fetchedAt.getTime();
  const freshnessMs = freshHours * 60 * 60 * 1000;
  if (ageMs < 0 || ageMs > freshnessMs) {
    return false;
  }

  try {
    const jsonStat = await stat(artifact.jsonPath);
    if (!jsonStat.isFile()) {
      return false;
    }
  } catch {
    return false;
  }

  if (!artifact.htmlPath) {
    return false;
  }

  try {
    await access(artifact.htmlPath);
  } catch {
    return false;
  }

  return true;
}

async function loadDetailUrlsFromFile(
  filePath: string,
  validate: (value: string) => string | null,
): Promise<string[]> {
  const raw = await readFile(filePath, "utf8");
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  const urls: string[] = [];
  for (const line of lines) {
    const parsed = validate(line);
    if (parsed) {
      urls.push(parsed);
    }
  }

  return Array.from(new Set(urls));
}

async function loadKnownDetailUrlsFromArtifacts(
  outputRoot: string,
  outputDetailsJsonDir: string,
  validate: (value: string) => string | null,
  reportProgress?: (message: string) => void,
): Promise<string[]> {
  const manifestPath = resolve(outputRoot, "details", "index.json");
  reportProgress?.(`known-set: reading canonical manifest ${manifestPath}`);

  let parsed: Array<{ detail_url?: unknown }>;
  try {
    const raw = await readFile(manifestPath, "utf8");
    parsed = JSON.parse(raw) as Array<{ detail_url?: unknown }>;
  } catch {
    throw new Error(
      `Missing canonical manifest at ${manifestPath}. Run a full inventory scan first (for example: --inventory-mode full-scan).`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error(
      `Canonical manifest is malformed at ${manifestPath}. Expected a JSON array of { detail_url } entries.`,
    );
  }

  const urls: string[] = [];
  for (const row of parsed) {
    const detailUrl = typeof row?.detail_url === "string" ? row.detail_url : "";
    const valid = validate(detailUrl);
    if (valid) {
      urls.push(valid);
    }
  }

  const deduped = Array.from(new Set(urls));
  reportProgress?.(`known-set: canonical urls=${deduped.length}`);
  return deduped;
}

async function pullDetails<TDetail extends DetailRecordBase>(
  root: string,
  browser: Browser,
  urls: string[],
  adapter: ScraperAdapter<TDetail>,
  outputDetailsJsonDir: string,
  progress: ReturnType<typeof createScrapeProgress>,
  detailFetchConcurrency: number,
  detailFetchDelayMs: number,
  detailTimeoutMs: number,
  detailRetryAttempts: number,
  detailRetryDelayMs: number,
  availabilityHorizonDays: number,
  maxCalendarAdvanceMonths: number,
  refreshMode: ScraperRefreshMode,
  mode: ScraperRunMode,
  reportDetailProgress: (message: string) => void,
  existingArtifactsByUrl?: Map<string, ExistingDetailArtifact>,
): Promise<{
  detailRecords: TDetail[];
  failedDetailUrls: string[];
}> {
  const detailResults: Array<TDetail | null> = new Array(urls.length).fill(
    null,
  );
  const detailDurationsMs: number[] = [];
  const failedDetailUrls: string[] = [];
  const detailRecords: TDetail[] = [];

  let nextIndex = 0;
  let started = 0;
  let inFlight = 0;
  let processed = 0;
  let liveFailures = 0;
  const pullStartedAtMs = Date.now();
  const workerCount = Math.min(detailFetchConcurrency, urls.length);

  const buildProgressLine = (label: string): string => {
    const elapsedMs = Date.now() - pullStartedAtMs;
    const elapsedSec = Math.max(1, Math.round(elapsedMs / 1000));
    const avgMsPerDetail =
      detailDurationsMs.length > 0
        ? Math.round(
            detailDurationsMs.reduce((sum, value) => sum + value, 0) /
              detailDurationsMs.length,
          )
        : 0;
    const avgSecPerDetail =
      avgMsPerDetail > 0 ? Math.round((avgMsPerDetail / 1000) * 10) / 10 : 0;
    const throughputCompletedPerMinute = Math.round(
      (processed / elapsedSec) * 60,
    );
    const throughputStartedPerMinute = Math.round((started / elapsedSec) * 60);
    return formatModeProgressLine({
      mode: "detail",
      completed: processed,
      total: urls.length,
      startedAtMs: pullStartedAtMs,
      text: `${label} started=${started}/${urls.length} in_flight=${inFlight} processed=${processed}/${urls.length} failures=${liveFailures} elapsed_s=${elapsedSec} avg_s_per_completed=${avgSecPerDetail || "n/a"} throughput_completed_per_min=${throughputCompletedPerMinute} throughput_started_per_min=${throughputStartedPerMinute}`,
    });
  };

  const buildTickLine = (text: string): string =>
    formatModeProgressLine({
      mode: "detail",
      completed: processed,
      total: urls.length,
      startedAtMs: pullStartedAtMs,
      text,
    });

  const heartbeatInterval = setInterval(() => {
    if (processed >= urls.length) {
      return;
    }
    progress.progress(buildProgressLine("details heartbeat"));
  }, 15000);

  const worker = async (): Promise<void> => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= urls.length) {
        return;
      }

      const detailUrl = urls[currentIndex] as string;
      const existingArtifact = existingArtifactsByUrl?.get(detailUrl);
      started += 1;
      inFlight += 1;
      const detailStartedAtMs = Date.now();
      const fetchPromise = adapter.fetchDetail({
        browser,
        detailUrl,
        availabilityHorizonDays,
        maxCalendarAdvanceMonths,
        refreshMode,
        mode,
        existingDetailJsonPath: existingArtifact?.jsonPath ?? null,
        reportDetailProgress,
      });
      const timed = await runTimedDetailFetch(fetchPromise, detailTimeoutMs);
      detailDurationsMs.push(Date.now() - detailStartedAtMs);
      inFlight = Math.max(0, inFlight - 1);

      let detail: TDetail | null = null;
      if (timed.timedOut) {
        progress.tick(
          buildTickLine(
            `detail timed out listing=${detailUrl} timeout_ms=${detailTimeoutMs}; marking failed and continuing`,
          ),
        );
      } else {
        detail = timed.detail;
      }

      detailResults[currentIndex] = detail;
      if (detail) {
        const detailForStorage = {
          ...detail,
          html_path: toProjectRelativePath(detail.html_path, root),
        };
        const detailPath = resolve(
          outputDetailsJsonDir,
          `${detail.external_listing_id}.json`,
        );
        await writeTextFileDurable(
          detailPath,
          `${JSON.stringify(detailForStorage, null, 2)}\n`,
        );
      }
      processed += 1;
      if (!detail) {
        liveFailures += 1;
      }
      if (processed <= 20 || processed % 5 === 0 || processed === urls.length) {
        progress.progress(buildProgressLine("details progress"));
      }

      if (detailFetchDelayMs > 0) {
        await sleep(detailFetchDelayMs);
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  } finally {
    clearInterval(heartbeatInterval);
  }

  for (let index = 0; index < urls.length; index += 1) {
    const detail = detailResults[index];
    const detailUrl = urls[index] as string;

    if (!detail) {
      failedDetailUrls.push(detailUrl);
      continue;
    }

    detailRecords.push(detail);
  }

  if (failedDetailUrls.length > 0 && detailRetryAttempts > 0) {
    let pending = [...failedDetailUrls];
    const recovered = new Set<string>();

    for (
      let attempt = 1;
      attempt <= detailRetryAttempts && pending.length > 0;
      attempt += 1
    ) {
      progress.phase(
        `retrying failed details attempt=${attempt}/${detailRetryAttempts} pending=${pending.length}`,
      );

      const nextPending: string[] = [];
      for (const detailUrl of pending) {
        const existingArtifact = existingArtifactsByUrl?.get(detailUrl);
        const fetchPromise = adapter.fetchDetail({
          browser,
          detailUrl,
          availabilityHorizonDays,
          maxCalendarAdvanceMonths,
          refreshMode,
          mode,
          existingDetailJsonPath: existingArtifact?.jsonPath ?? null,
          reportDetailProgress,
        });

        const timed = await runTimedDetailFetch(fetchPromise, detailTimeoutMs);
        if (timed.timedOut || !timed.detail) {
          nextPending.push(detailUrl);
          progress.tick(
            buildTickLine(
              `retry detail failed attempt=${attempt} listing=${detailUrl}`,
            ),
          );
        } else {
          const detail = timed.detail;
          const detailForStorage = {
            ...detail,
            html_path: toProjectRelativePath(detail.html_path, root),
          };
          const detailPath = resolve(
            outputDetailsJsonDir,
            `${detail.external_listing_id}.json`,
          );
          await writeTextFileDurable(
            detailPath,
            `${JSON.stringify(detailForStorage, null, 2)}\n`,
          );
          detailRecords.push(detail);
          recovered.add(detailUrl);
          progress.tick(
            buildTickLine(
              `retry detail recovered attempt=${attempt} listing=${detailUrl}`,
            ),
          );
        }

        if (detailRetryDelayMs > 0) {
          await sleep(detailRetryDelayMs);
        }
      }

      pending = nextPending;
    }

    if (recovered.size > 0) {
      failedDetailUrls.splice(
        0,
        failedDetailUrls.length,
        ...failedDetailUrls.filter((url) => !recovered.has(url)),
      );
      progress.info(
        `detail retry summary: recovered=${recovered.size}, remaining_failed=${failedDetailUrls.length}`,
      );
    }
  }

  return { detailRecords, failedDetailUrls };
}

export async function runScraperEngine<TDetail extends DetailRecordBase>(
  adapter: ScraperAdapter<TDetail>,
  argv: string[] = process.argv,
): Promise<void> {
  const progress = createScrapeProgress({ script: adapter.scriptLabel });
  const options = parseRunOptions(argv, adapter.defaultAnchorUrl);
  const isRefreshOperation =
    options.inventoryMode === "refresh-known" ||
    options.refreshKnown ||
    Boolean(options.detailUrlsFile);
  const detailFetchConcurrency =
    options.detailFetchConcurrency ?? (isRefreshOperation ? 8 : 4);
  const detailFetchDelayMs =
    options.detailFetchDelayMs ?? adapter.detailFetchDelayMs;
  const verboseDetailProgress =
    process.env.SCRAPER_VERBOSE_DETAIL_PROGRESS === "1" ||
    process.env.SCRAPER_VERBOSE_DETAIL_PROGRESS === "true";
  const detailProgressStartedAtMs = Date.now();
  const reportDetailProgress = (message: string): void => {
    if (verboseDetailProgress) {
      progress.tick(
        formatModeProgressLine({
          mode: "detail",
          completed: 0,
          total: 0,
          startedAtMs: detailProgressStartedAtMs,
          text: message,
        }),
      );
    }
  };
  const availabilityHorizonDays =
    options.availHorizonDays ?? adapter.availabilityHorizonDays;
  const maxCalendarAdvanceMonths =
    options.availMaxCalendarMonths ?? adapter.maxCalendarAdvanceMonths;

  progress.phase("starting scraper engine run");
  const targetScope = options.detailUrl
    ? "single-detail-url"
    : options.inventoryMode === "refresh-known" ||
        options.refreshKnown ||
        options.detailUrlsFile
      ? "refresh-known"
      : options.discoverOnly
        ? "discover-only"
        : "collection-discovery";
  progress.info(
    `target_scope=${targetScope}, inventory_mode=${options.inventoryMode}, run_mode=${options.mode}, refresh_mode=${options.refreshMode}, avail_horizon_days=${availabilityHorizonDays}, avail_max_calendar_months=${maxCalendarAdvanceMonths}, scroll_steps=${options.maxScrollSteps}, scroll_pause_ms=${options.scrollPauseMs}, network_idle_wait_ms=${options.networkIdleWaitMs}, concurrency=${detailFetchConcurrency}, detail_delay_ms=${detailFetchDelayMs}, detail_timeout_ms=${options.detailTimeoutMs}, detail_retry_attempts=${options.detailRetryAttempts}, detail_retry_delay_ms=${options.detailRetryDelayMs}, skip_existing_details=${options.skipExistingDetails}, skip_fresh_details=${options.skipFreshDetails}, fresh_hours=${options.freshHours}, allow_canonical_prune=${options.allowCanonicalPrune}, allow_empty_canonical_index_prune=${options.allowEmptyCanonicalIndexPrune}`,
  );

  if (options.quoteWindowDays !== null) {
    process.env.SCRAPER_QUOTE_WINDOW_DAYS = String(options.quoteWindowDays);
  }
  if (options.quoteSampleStepDays !== null) {
    process.env.SCRAPER_QUOTE_SAMPLE_STEP_DAYS = String(
      options.quoteSampleStepDays,
    );
  }
  if (options.quoteNights !== null) {
    process.env.SCRAPER_QUOTE_NIGHTS = String(options.quoteNights);
  }
  if (options.quoteMaxQueries !== null) {
    process.env.SCRAPER_QUOTE_MAX_QUERIES = String(options.quoteMaxQueries);
  }
  if (options.quoteAnchorDate !== null) {
    process.env.SCRAPER_QUOTE_ANCHOR_DATE = options.quoteAnchorDate;
  }
  if (options.quoteObservationRetryDelaysMs !== null) {
    process.env.SCRAPER_QUOTE_OBSERVATION_RETRY_DELAYS_MS =
      options.quoteObservationRetryDelaysMs;
  }

  const root = process.cwd();
  const reportsDir = resolve(root, ".tmp", "reports");
  const externalSourceDir = resolve(
    root,
    "src",
    "lib",
    "data",
    "external-sources",
  );
  const outputRoot = resolve(externalSourceDir, adapter.managerKey);
  const outputDetailsHtmlDir = resolve(outputRoot, "details", "html");
  const outputDetailsJsonDir = resolve(outputRoot, "details", "json");

  await mkdir(reportsDir, { recursive: true });
  await mkdir(externalSourceDir, { recursive: true });
  await mkdir(outputDetailsHtmlDir, { recursive: true });
  await mkdir(outputDetailsJsonDir, { recursive: true });

  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ headless: true });

  try {
    if (options.detailUrl) {
      progress.info(`direct_detail_input=${options.detailUrl}`);
      const valid = adapter.isValidDetailUrl(options.detailUrl);
      if (!valid) {
        throw new Error(`Invalid detail URL: ${options.detailUrl}`);
      }
      progress.info(`direct_detail_validated=${valid}`);

      const existingArtifacts = await loadExistingDetailArtifacts(
        root,
        outputDetailsJsonDir,
        adapter.isValidDetailUrl,
      );
      const existingArtifact = existingArtifacts.get(valid);

      progress.phase("single-target pull: processing one listing");
      const timed = await runTimedDetailFetch(
        adapter.fetchDetail({
          browser,
          detailUrl: valid,
          availabilityHorizonDays,
          maxCalendarAdvanceMonths,
          refreshMode: options.refreshMode,
          mode: options.mode,
          existingDetailJsonPath: existingArtifact?.jsonPath ?? null,
          reportDetailProgress,
        }),
        options.detailTimeoutMs,
      );

      if (timed.timedOut) {
        throw new Error(
          `Direct detail scrape timed out after ${options.detailTimeoutMs}ms for ${valid}`,
        );
      }

      const detail = timed.detail;
      if (!detail) {
        throw new Error("Direct detail scrape failed for requested URL");
      }

      const detailPath = resolve(
        outputDetailsJsonDir,
        `${detail.external_listing_id}.json`,
      );
      const detailPathRel = toProjectRelativePath(detailPath, root);
      const detailForStorage = {
        ...detail,
        html_path: toProjectRelativePath(detail.html_path, root),
      };
      await writeTextFileDurable(
        detailPath,
        `${JSON.stringify(detailForStorage, null, 2)}\n`,
      );

      const reportPath = resolve(
        reportsDir,
        `${adapter.managerKey}-direct-detail-report.json`,
      );
      const reportPathRel = toProjectRelativePath(reportPath, root);
      await writeTextFileDurable(
        reportPath,
        `${JSON.stringify(
          {
            generated_at: new Date().toISOString(),
            mode: "direct_detail",
            detail_url: detail.detail_url,
            external_listing_id: detail.external_listing_id,
            detail_json: detailPathRel,
          },
          null,
          2,
        )}\n`,
      );

      progress.success(
        `direct detail scrape complete (id=${detail.external_listing_id})`,
      );
      progress.info(`${adapter.scriptLabel} direct detail scrape complete.`);
      progress.info(`- detail_url: ${detail.detail_url}`);
      progress.info(`- external_listing_id: ${detail.external_listing_id}`);
      progress.info(`- detail_json: ${detailPathRel}`);
      progress.info(`- report_json: ${reportPathRel}`);
      return;
    }

    if (options.inventoryMode === "refresh-known" || options.detailUrlsFile) {
      progress.phase("acquiring known listing set for refresh");
      const knownUrls = options.refreshKnown
        ? await loadKnownDetailUrlsFromArtifacts(
            outputRoot,
            outputDetailsJsonDir,
            adapter.isValidDetailUrl,
            reportDetailProgress,
          )
        : [];
      const fileUrls = options.detailUrlsFile
        ? await loadDetailUrlsFromFile(
            options.detailUrlsFile,
            adapter.isValidDetailUrl,
          )
        : [];

      const merged = Array.from(new Set([...knownUrls, ...fileUrls])).sort();
      const startIndex = Math.min(options.startIndex, merged.length);
      const selectedUrls =
        options.maxListings === null
          ? merged.slice(startIndex)
          : merged.slice(startIndex, startIndex + options.maxListings);

      if (selectedUrls.length === 0) {
        throw new Error(
          "No known detail URLs available. Use --detail-urls-file or run a full scrape first.",
        );
      }

      progress.info(
        `refresh inputs: known=${merged.length}, selected=${selectedUrls.length}, start_index=${startIndex}, max_listings=${options.maxListings ?? "all"}`,
      );
      progress.info(
        `refresh strategy: refresh_mode=${options.refreshMode}, skip_existing_details=${options.skipExistingDetails}, skip_fresh_details=${options.skipFreshDetails}, fresh_hours=${options.freshHours}`,
      );

      const existingArtifacts = await loadExistingDetailArtifacts(
        root,
        outputDetailsJsonDir,
        adapter.isValidDetailUrl,
      );

      let urlsToPull = selectedUrls;
      let skippedFreshUrls: string[] = [];
      let skippedExistingUrls: string[] = [];
      if (options.skipExistingDetails) {
        skippedExistingUrls = selectedUrls.filter((url) =>
          existingArtifacts.has(url),
        );
        urlsToPull = selectedUrls.filter((url) => !existingArtifacts.has(url));
        progress.tick(
          `existing-skip evaluation complete: skipped_existing=${skippedExistingUrls.length}/${selectedUrls.length}, pull=${urlsToPull.length}`,
        );
      }
      if (options.skipFreshDetails) {
        progress.phase(
          "evaluating fresh detail artifacts for skip eligibility",
        );
        const checks = await Promise.all(
          urlsToPull.map(async (url) => {
            const artifact = existingArtifacts.get(url);
            if (!artifact) {
              return { url, skip: false };
            }
            const skip = await isArtifactFreshAndValid(
              artifact,
              options.freshHours,
            );
            return { url, skip };
          }),
        );

        skippedFreshUrls = checks
          .filter((result) => result.skip)
          .map((result) => result.url);
        urlsToPull = checks
          .filter((result) => !result.skip)
          .map((result) => result.url);

        const skipPct =
          selectedUrls.length > 0
            ? Math.round((skippedFreshUrls.length / selectedUrls.length) * 100)
            : 0;
        progress.tick(
          `fresh-skip evaluation complete: skipped=${skippedFreshUrls.length}/${selectedUrls.length} (${skipPct}%), pull=${urlsToPull.length}`,
        );
      }

      progress.phase(
        `refresh mode: pulling known detail pages (selected=${selectedUrls.length}, pull=${urlsToPull.length}, skipped_existing=${skippedExistingUrls.length}, skipped_fresh=${skippedFreshUrls.length}, concurrency=${detailFetchConcurrency})`,
      );

      const refreshPullStartedAt = Date.now();

      const { detailRecords, failedDetailUrls } = await pullDetails(
        root,
        browser,
        urlsToPull,
        adapter,
        outputDetailsJsonDir,
        progress,
        detailFetchConcurrency,
        detailFetchDelayMs,
        options.detailTimeoutMs,
        options.detailRetryAttempts,
        options.detailRetryDelayMs,
        availabilityHorizonDays,
        maxCalendarAdvanceMonths,
        options.refreshMode,
        options.mode,
        reportDetailProgress,
        existingArtifacts,
      );

      const refreshPullElapsedMs = Date.now() - refreshPullStartedAt;
      const refreshPullElapsedSeconds = Math.max(
        1,
        Math.round(refreshPullElapsedMs / 1000),
      );
      const throughputPerMinute =
        detailRecords.length > 0
          ? Math.round((detailRecords.length / refreshPullElapsedSeconds) * 60)
          : 0;
      const avgSecondsPerPulled =
        detailRecords.length > 0
          ? Math.round(
              (refreshPullElapsedMs / detailRecords.length / 1000) * 10,
            ) / 10
          : null;

      progress.info(
        `refresh pull metrics: elapsed_s=${refreshPullElapsedSeconds}, pulled=${detailRecords.length}, failed=${failedDetailUrls.length}, throughput_per_min=${throughputPerMinute}, avg_s_per_pulled=${avgSecondsPerPulled ?? "n/a"}`,
      );

      const reportPath = resolve(
        reportsDir,
        `${adapter.managerKey}-refresh-known-report.json`,
      );
      const reportPathRel = toProjectRelativePath(reportPath, root);
      await writeTextFileDurable(
        reportPath,
        `${JSON.stringify(
          {
            generated_at: new Date().toISOString(),
            mode: "refresh_known_details",
            refresh_mode: options.refreshMode,
            skip_existing_details: options.skipExistingDetails,
            skip_fresh_details: options.skipFreshDetails,
            fresh_hours: options.freshHours,
            source_count: merged.length,
            start_index: startIndex,
            max_listings: options.maxListings,
            selected_count: selectedUrls.length,
            detail_pages_skipped_existing: skippedExistingUrls.length,
            detail_pages_skipped_fresh: skippedFreshUrls.length,
            detail_pages_pulled: detailRecords.length,
            detail_pages_failed: failedDetailUrls.length,
            pull_elapsed_ms: refreshPullElapsedMs,
            pull_throughput_per_minute: throughputPerMinute,
            pull_avg_seconds_per_detail:
              avgSecondsPerPulled === null ? null : avgSecondsPerPulled,
            failed_detail_urls: failedDetailUrls,
            skipped_existing_urls: skippedExistingUrls,
            skipped_fresh_urls: skippedFreshUrls,
            selected_urls: selectedUrls,
          },
          null,
          2,
        )}\n`,
      );

      // In refresh-known mode, details/index.json is the authoritative source list.
      // Do not rebuild it from filesystem artifacts here.
      const canonicalIndexPath = resolve(outputRoot, "details", "index.json");
      progress.info(
        `canonical index preserved: ${toProjectRelativePath(canonicalIndexPath, root)} (refresh-known source of truth)`,
      );

      progress.success(
        `refresh scrape complete (selected=${selectedUrls.length}, pulled=${detailRecords.length}, skipped_existing=${skippedExistingUrls.length}, skipped_fresh=${skippedFreshUrls.length}, failed=${failedDetailUrls.length}, refresh_mode=${options.refreshMode})`,
      );
      progress.info(`${adapter.scriptLabel} refresh scrape complete.`);
      progress.info(`- refresh_mode: ${options.refreshMode}`);
      progress.info(`- skip_existing_details: ${options.skipExistingDetails}`);
      progress.info(`- skip_fresh_details: ${options.skipFreshDetails}`);
      progress.info(`- fresh_hours: ${options.freshHours}`);
      progress.info(`- known_urls_discovered: ${merged.length}`);
      progress.info(`- urls_selected: ${selectedUrls.length}`);
      progress.info(`- urls_to_pull: ${urlsToPull.length}`);
      progress.info(
        `- detail_pages_skipped_existing: ${skippedExistingUrls.length}`,
      );
      progress.info(`- detail_pages_skipped_fresh: ${skippedFreshUrls.length}`);
      progress.info(`- detail_pages_pulled: ${detailRecords.length}`);
      progress.info(`- detail_pages_failed: ${failedDetailUrls.length}`);
      progress.info(`- pull_elapsed_ms: ${refreshPullElapsedMs}`);
      progress.info(`- pull_throughput_per_minute: ${throughputPerMinute}`);
      progress.info(
        `- pull_avg_seconds_per_detail: ${avgSecondsPerPulled ?? "n/a"}`,
      );
      progress.info(`- report_json: ${reportPathRel}`);
      return;
    }

    let parsedAnchor: URL;
    try {
      parsedAnchor = new URL(options.anchorUrl);
    } catch {
      throw new Error(`Invalid URL: ${options.anchorUrl}`);
    }

    progress.phase("opening collection page");
    const page = await browser.newPage();
    progress.phase("discovering listing links from collection page");
    const discoveryStartedAtMs = Date.now();
    let discoveryTicks = 0;
    const discoveredRows = await adapter.discoverListings({
      page,
      anchorUrl: parsedAnchor.toString(),
      maxScrollSteps: options.maxScrollSteps,
      scrollPauseMs: options.scrollPauseMs,
      networkIdleWaitMs: options.networkIdleWaitMs,
      reportProgress: (message: string) => {
        discoveryTicks += 1;
        progress.tick(
          formatModeProgressLine({
            mode: "discover",
            completed: discoveryTicks,
            total: 0,
            startedAtMs: discoveryStartedAtMs,
            text: message,
          }),
        );
      },
    });

    const normalizedRows = discoveredRows
      .map((row) => ({
        link: normalizeLink(row.link),
        source_url: parsedAnchor.toString(),
        anchor_text: row.anchor_text,
      }))
      .filter((row) => !!row.link);

    const seen = new Set<string>();
    const rows: ScrapedLink[] = [];
    for (const row of normalizedRows) {
      if (seen.has(row.link)) {
        continue;
      }
      seen.add(row.link);
      rows.push(row);
    }
    rows.sort((left, right) => left.link.localeCompare(right.link));

    const totalDiscovered = rows.length;
    const startIndex = Math.min(options.startIndex, totalDiscovered);
    const subsetRows =
      options.maxListings === null
        ? rows.slice(startIndex)
        : rows.slice(startIndex, startIndex + options.maxListings);
    const isSubsetMode = options.maxListings !== null || options.startIndex > 0;

    const selectedUrls = subsetRows.map((row) => row.link);
    let detailRecords: TDetail[] = [];
    let failedDetailUrls: string[] = [];

    if (!options.discoverOnly) {
      progress.phase(
        `pulling detail pages from selected subset (count=${subsetRows.length}, concurrency=${detailFetchConcurrency})`,
      );

      const pulled = await pullDetails(
        root,
        browser,
        selectedUrls,
        adapter,
        outputDetailsJsonDir,
        progress,
        detailFetchConcurrency,
        detailFetchDelayMs,
        options.detailTimeoutMs,
        options.detailRetryAttempts,
        options.detailRetryDelayMs,
        availabilityHorizonDays,
        maxCalendarAdvanceMonths,
        options.refreshMode,
        options.mode,
        reportDetailProgress,
      );
      detailRecords = pulled.detailRecords;
      failedDetailUrls = pulled.failedDetailUrls;
    } else {
      progress.phase("discover-only mode: skipping detail page pulls");
    }

    const payload = {
      generated_at: new Date().toISOString(),
      source_url: parsedAnchor.toString(),
      total_links_discovered: totalDiscovered,
      link_count: subsetRows.length,
      start_index: startIndex,
      max_listings: options.maxListings,
      is_subset_mode: isSubsetMode,
      detail_pages_pulled: detailRecords.length,
      detail_pages_failed: failedDetailUrls.length,
      failed_detail_urls: failedDetailUrls,
      links: subsetRows,
    };

    const reportPath = resolve(
      reportsDir,
      isSubsetMode
        ? `${adapter.managerKey}-playwright-links-subset.json`
        : `${adapter.managerKey}-playwright-links.json`,
    );
    const reportPathRel = toProjectRelativePath(reportPath, root);
    const detailsManifestPath = resolve(
      reportsDir,
      isSubsetMode
        ? `${adapter.managerKey}-details-manifest-subset.json`
        : `${adapter.managerKey}-details-manifest.json`,
    );
    const detailsManifestPathRel = toProjectRelativePath(
      detailsManifestPath,
      root,
    );

    await writeTextFileDurable(
      reportPath,
      `${JSON.stringify(payload, null, 2)}\n`,
    );
    await writeTextFileDurable(
      detailsManifestPath,
      `${JSON.stringify(detailRecords, null, 2)}\n`,
    );

    if (!isSubsetMode) {
      const canonicalIndexPath = resolve(outputRoot, "details", "index.json");
      const existingDetailArtifacts = await loadExistingDetailArtifacts(
        root,
        outputDetailsJsonDir,
        adapter.isValidDetailUrl,
      );
      const existingCanonicalByUrl = new Map<string, Record<string, unknown>>();
      try {
        const existingRaw = await readFile(canonicalIndexPath, "utf8");
        const existingParsed = JSON.parse(existingRaw) as Array<{
          detail_url?: unknown;
          quote_context?: unknown;
        }>;
        if (Array.isArray(existingParsed)) {
          for (const entry of existingParsed) {
            const detailUrl =
              typeof entry?.detail_url === "string"
                ? normalizeLink(entry.detail_url)
                : "";
            const quoteContext = extractCanonicalQuoteContext(
              entry?.quote_context,
            );
            if (!detailUrl || !quoteContext) {
              continue;
            }
            existingCanonicalByUrl.set(detailUrl, quoteContext);
          }
        }
      } catch {
        // Canonical index may not exist yet on first full scan.
      }

      const pulledQuoteContextByUrl = new Map<
        string,
        Record<string, unknown>
      >();
      const pulledExternalListingIdByUrl = new Map<string, string>();
      for (const detail of detailRecords) {
        const detailUrl = normalizeLink(detail.detail_url);
        if (!detailUrl) {
          continue;
        }

        const pulledExternalListingIdRaw =
          typeof detail.external_listing_id === "string"
            ? detail.external_listing_id.trim()
            : "";
        if (pulledExternalListingIdRaw) {
          pulledExternalListingIdByUrl.set(
            detailUrl,
            pulledExternalListingIdRaw,
          );
        }

        const quoteContext = extractCanonicalQuoteContext(
          (detail as Record<string, unknown>).quote_context,
        );
        if (quoteContext) {
          pulledQuoteContextByUrl.set(detailUrl, quoteContext);
        }
      }

      const canonicalIndex = rows.map((row) => {
        const detailUrl = normalizeLink(row.link);
        const externalListingId =
          pulledExternalListingIdByUrl.get(detailUrl) ??
          existingDetailArtifacts.get(detailUrl)?.externalListingId ??
          externalListingIdFromDetailUrl(detailUrl);
        const quoteContext =
          pulledQuoteContextByUrl.get(detailUrl) ??
          existingDetailArtifacts.get(detailUrl)?.quoteContext ??
          existingCanonicalByUrl.get(detailUrl);

        return {
          detail_url: detailUrl,
          external_listing_id: externalListingId,
          ...(quoteContext ? { quote_context: quoteContext } : {}),
        };
      });
      await writeCanonicalIndexWithPruneGuard({
        canonicalIndexPath,
        canonicalIndex,
        allowCanonicalPrune: options.allowCanonicalPrune,
        allowEmptyCanonicalIndexPrune: options.allowEmptyCanonicalIndexPrune,
      });
      progress.info(
        `canonical index updated: ${toProjectRelativePath(canonicalIndexPath, root)} entries=${canonicalIndex.length}`,
      );
    }

    progress.success(
      options.discoverOnly
        ? `discovery complete (discovered=${totalDiscovered}, selected=${subsetRows.length})`
        : `collection+detail scrape complete (discovered=${totalDiscovered}, selected=${subsetRows.length}, details=${detailRecords.length})`,
    );
    progress.info(
      options.discoverOnly
        ? `${adapter.scriptLabel} discovery complete.`
        : `${adapter.scriptLabel} scrape complete.`,
    );
    progress.info(`- source_url: ${parsedAnchor.toString()}`);
    progress.info(`- total_links_discovered: ${totalDiscovered}`);
    progress.info(`- links_selected: ${subsetRows.length}`);
    progress.info(`- start_index: ${startIndex}`);
    progress.info(`- max_listings: ${options.maxListings ?? "all"}`);
    progress.info(`- subset_mode: ${isSubsetMode}`);
    progress.info(`- detail_pages_pulled: ${detailRecords.length}`);
    progress.info(`- detail_pages_failed: ${failedDetailUrls.length}`);
    progress.info(`- report_json: ${reportPathRel}`);
    progress.info(`- details_manifest_json: ${detailsManifestPathRel}`);
  } finally {
    const closeStartedAt = Date.now();
    progress.phase("finalizing browser shutdown");
    await browser.close();
    progress.tick(
      `browser shutdown complete elapsed_ms=${Date.now() - closeStartedAt}`,
    );
  }
}
