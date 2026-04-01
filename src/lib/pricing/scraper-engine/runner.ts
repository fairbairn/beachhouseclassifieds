import { access, mkdir, open, readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { Browser } from "playwright";

import { createScrapeProgress } from "@/core/tooling/terminal/scrape-progress";

import type {
  DetailRecordBase,
  RunOptions,
  ScrapedLink,
  ScraperAdapter,
  ScraperRefreshMode,
} from "./types";

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function normalizeLink(url: string): string {
  return url.split("#")[0]?.replace(/\/$/, "") ?? url;
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
    "  --detail-url <url>                 Scrape one detail URL and exit",
    "  --detail-urls-file <path>          Refresh URLs listed in file (one URL per line)",
    "  --refresh-known                     Refresh known URLs from existing artifacts",
    "  --discover-only                     Discover links only (no detail pulls)",
    "  --max-listings <n>                  Positive integer",
    "  --start-index <n>                   Non-negative integer",
    "  --max-scroll-steps <n>              Positive integer",
    "  --scroll-pause-ms <n>               Positive integer",
    "  --network-idle-wait-ms <n>          Positive integer",
    "  --detail-fetch-concurrency <n>      Positive integer",
    "  --detail-fetch-delay-ms <n>         Non-negative integer",
    "  --detail-timeout-ms <n>             Positive integer",
    "  --skip-existing-details             Skip pull when detail JSON already exists",
    "  --skip-fresh-details                Skip pull for fresh existing artifacts",
    "  --fresh-hours <n>                   Positive integer",
    "  --refresh-mode <full|dynamic|static>",
    "  --help                              Show this help",
    "",
    "Mode constraints:",
    "  --detail-url cannot be combined with --detail-urls-file, --refresh-known, or --discover-only.",
  ].join("\n");
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
  let maxListings: number | null = null;
  let startIndex = 0;
  let discoverOnly = false;
  let detailUrl: string | null = null;
  let detailUrlsFile: string | null = null;
  let refreshKnown = false;
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

    if (arg === "--max-listings") {
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

    if (arg === "--start-index") {
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

    if (arg === "--detail-url") {
      const value = requireValue(argv, index, arg);
      if (value) {
        detailUrl = value;
      }
      index += 1;
      continue;
    }

    if (arg === "--discover-only") {
      discoverOnly = true;
      continue;
    }

    if (arg === "--detail-urls-file") {
      const value = requireValue(argv, index, arg);
      if (value) {
        detailUrlsFile = value;
      }
      index += 1;
      continue;
    }

    if (arg === "--refresh-known") {
      refreshKnown = true;
      continue;
    }

    if (arg === "--max-scroll-steps") {
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

    if (arg === "--scroll-pause-ms") {
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

    if (arg === "--network-idle-wait-ms") {
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

    if (arg === "--refresh-mode") {
      const value = requireValue(argv, index, arg);
      if (value) {
        if (value === "full" || value === "dynamic" || value === "static") {
          refreshMode = value;
        } else {
          errors.push(
            `${arg} must be one of: full, dynamic, static. Received: ${value}`,
          );
        }
      }
      index += 1;
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
      "--detail-url cannot be combined with --detail-urls-file, --refresh-known, or --discover-only.",
    );
  }

  if (errors.length > 0) {
    const details = errors.map((entry) => `- ${entry}`).join("\n");
    throw new Error(
      `Invalid scraper-engine parameters:\n${details}\n\n${buildUsageText(defaultAnchorUrl)}`,
    );
  }

  return {
    anchorUrl,
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
    skipExistingDetails,
    skipFreshDetails,
    freshHours,
    refreshMode,
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
  fetchedAt: Date;
  jsonPath: string;
  htmlPath: string | null;
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

      byUrl.set(detailUrl, {
        detailUrl,
        fetchedAt,
        jsonPath,
        htmlPath,
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
  const urls: string[] = [];

  // Known-set resolution should come from canonical adapter artifacts, not transient report files.
  const manifestPaths = [
    resolve(outputRoot, "details", "index.json"),
    resolve(outputRoot, "details", "index-subset.json"),
  ];

  for (const manifestPath of manifestPaths) {
    const before = urls.length;
    reportProgress?.(`known-set: reading manifest ${manifestPath}`);
    try {
      const raw = await readFile(manifestPath, "utf8");
      const parsed = JSON.parse(raw) as Array<{ detail_url?: unknown }>;
      if (!Array.isArray(parsed)) {
        reportProgress?.(
          `known-set: manifest not array, skipped ${manifestPath}`,
        );
        continue;
      }

      for (const row of parsed) {
        const detailUrl =
          typeof row?.detail_url === "string" ? row.detail_url : "";
        const valid = validate(detailUrl);
        if (valid) {
          urls.push(valid);
        }
      }
      reportProgress?.(
        `known-set: manifest added ${urls.length - before} urls (${urls.length} cumulative)`,
      );
    } catch {
      reportProgress?.(
        `known-set: canonical manifest missing/malformed, skipped ${manifestPath}`,
      );
    }
  }

  try {
    reportProgress?.("known-set: scanning existing detail json artifacts");
    const entries = await readdir(outputDetailsJsonDir, {
      withFileTypes: true,
    });
    let scanned = 0;
    let parsedCount = 0;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }

      scanned += 1;
      const filePath = resolve(outputDetailsJsonDir, entry.name);
      try {
        const raw = await readFile(filePath, "utf8");
        const parsed = JSON.parse(raw) as { detail_url?: unknown };
        const detailUrl =
          parsed && typeof parsed.detail_url === "string"
            ? parsed.detail_url
            : "";
        const valid = validate(detailUrl);
        if (valid) {
          urls.push(valid);
        }
        parsedCount += 1;
        if (scanned % 50 === 0) {
          reportProgress?.(
            `known-set: scanned ${scanned} detail json files, parsed=${parsedCount}, urls=${urls.length}`,
          );
        }
      } catch {
        // Ignore malformed detail files.
      }
    }
    reportProgress?.(
      `known-set: detail json scan complete scanned=${scanned}, parsed=${parsedCount}, urls=${urls.length}`,
    );
  } catch {
    reportProgress?.("known-set: details json directory missing, skipped scan");
  }

  const deduped = Array.from(new Set(urls));
  reportProgress?.(
    `known-set: final unique urls=${deduped.length} (raw=${urls.length})`,
  );
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
  refreshMode: ScraperRefreshMode,
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
    const remaining = Math.max(0, urls.length - processed);
    const etaMinutes =
      throughputCompletedPerMinute > 0
        ? Math.round((remaining / throughputCompletedPerMinute) * 10) / 10
        : null;
    const pct =
      urls.length > 0 ? Math.round((processed / urls.length) * 100) : 0;

    return `${label}: started=${started}/${urls.length}, in_flight=${inFlight}, processed=${processed}/${urls.length} (${pct}%), failures=${liveFailures}, elapsed_s=${elapsedSec}, avg_s_per_completed=${avgSecPerDetail || "n/a"}, throughput_completed_per_min=${throughputCompletedPerMinute}, throughput_started_per_min=${throughputStartedPerMinute}, eta_min=${etaMinutes ?? "n/a"}`;
  };

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
        availabilityHorizonDays: adapter.availabilityHorizonDays,
        maxCalendarAdvanceMonths: adapter.maxCalendarAdvanceMonths,
        refreshMode,
        existingDetailJsonPath: existingArtifact?.jsonPath ?? null,
        reportDetailProgress: (message: string) => {
          progress.tick(message);
        },
      });
      const timed = await runTimedDetailFetch(fetchPromise, detailTimeoutMs);
      detailDurationsMs.push(Date.now() - detailStartedAtMs);
      inFlight = Math.max(0, inFlight - 1);

      let detail: TDetail | null = null;
      if (timed.timedOut) {
        progress.tick(
          `detail ${detailUrl} timed out after ${detailTimeoutMs}ms; marking failed and continuing`,
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

  return { detailRecords, failedDetailUrls };
}

export async function runScraperEngine<TDetail extends DetailRecordBase>(
  adapter: ScraperAdapter<TDetail>,
  argv: string[] = process.argv,
): Promise<void> {
  const progress = createScrapeProgress({ script: adapter.scriptLabel });
  const options = parseRunOptions(argv, adapter.defaultAnchorUrl);
  const isRefreshOperation =
    options.refreshKnown || Boolean(options.detailUrlsFile);
  const detailFetchConcurrency =
    options.detailFetchConcurrency ?? (isRefreshOperation ? 12 : 4);
  const detailFetchDelayMs =
    options.detailFetchDelayMs ?? adapter.detailFetchDelayMs;

  progress.phase("starting scraper engine run");
  progress.info(
    `mode=${options.detailUrl ? "direct-detail" : options.refreshKnown || options.detailUrlsFile ? "refresh-known" : options.discoverOnly ? "discover-only" : "full"}, refresh_mode=${options.refreshMode}, scroll_steps=${options.maxScrollSteps}, scroll_pause_ms=${options.scrollPauseMs}, network_idle_wait_ms=${options.networkIdleWaitMs}, concurrency=${detailFetchConcurrency}, detail_delay_ms=${detailFetchDelayMs}, detail_timeout_ms=${options.detailTimeoutMs}, skip_existing_details=${options.skipExistingDetails}, skip_fresh_details=${options.skipFreshDetails}, fresh_hours=${options.freshHours}`,
  );

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

      progress.phase("direct detail mode: pulling one listing detail page");
      const timed = await runTimedDetailFetch(
        adapter.fetchDetail({
          browser,
          detailUrl: valid,
          availabilityHorizonDays: adapter.availabilityHorizonDays,
          maxCalendarAdvanceMonths: adapter.maxCalendarAdvanceMonths,
          refreshMode: options.refreshMode,
          existingDetailJsonPath: null,
          reportDetailProgress: (message: string) => {
            progress.tick(message);
          },
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
      console.log(`${adapter.scriptLabel} direct detail scrape complete.`);
      console.log(`- detail_url: ${detail.detail_url}`);
      console.log(`- external_listing_id: ${detail.external_listing_id}`);
      console.log(`- detail_json: ${detailPathRel}`);
      console.log(`- report_json: ${reportPathRel}`);
      return;
    }

    if (options.refreshKnown || options.detailUrlsFile) {
      progress.phase("acquiring known listing set for refresh");
      const knownUrls = options.refreshKnown
        ? await loadKnownDetailUrlsFromArtifacts(
            outputRoot,
            outputDetailsJsonDir,
            adapter.isValidDetailUrl,
            (message: string) => {
              progress.tick(message);
            },
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
        options.refreshMode,
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

      progress.success(
        `refresh scrape complete (selected=${selectedUrls.length}, pulled=${detailRecords.length}, skipped_existing=${skippedExistingUrls.length}, skipped_fresh=${skippedFreshUrls.length}, failed=${failedDetailUrls.length}, refresh_mode=${options.refreshMode})`,
      );
      console.log(`${adapter.scriptLabel} refresh scrape complete.`);
      console.log(`- refresh_mode: ${options.refreshMode}`);
      console.log(`- skip_existing_details: ${options.skipExistingDetails}`);
      console.log(`- skip_fresh_details: ${options.skipFreshDetails}`);
      console.log(`- fresh_hours: ${options.freshHours}`);
      console.log(`- known_urls_discovered: ${merged.length}`);
      console.log(`- urls_selected: ${selectedUrls.length}`);
      console.log(`- urls_to_pull: ${urlsToPull.length}`);
      console.log(
        `- detail_pages_skipped_existing: ${skippedExistingUrls.length}`,
      );
      console.log(`- detail_pages_skipped_fresh: ${skippedFreshUrls.length}`);
      console.log(`- detail_pages_pulled: ${detailRecords.length}`);
      console.log(`- detail_pages_failed: ${failedDetailUrls.length}`);
      console.log(`- pull_elapsed_ms: ${refreshPullElapsedMs}`);
      console.log(`- pull_throughput_per_minute: ${throughputPerMinute}`);
      console.log(
        `- pull_avg_seconds_per_detail: ${avgSecondsPerPulled ?? "n/a"}`,
      );
      console.log(`- report_json: ${reportPathRel}`);
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
    const discoveredRows = await adapter.discoverListings({
      page,
      anchorUrl: parsedAnchor.toString(),
      maxScrollSteps: options.maxScrollSteps,
      scrollPauseMs: options.scrollPauseMs,
      networkIdleWaitMs: options.networkIdleWaitMs,
      reportProgress: (message: string) => progress.tick(message),
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
        options.refreshMode,
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
    const sourcePath = resolve(
      externalSourceDir,
      isSubsetMode
        ? `${adapter.managerKey}_listings_subset.json`
        : `${adapter.managerKey}_listings.json`,
    );
    const sourcePathRel = toProjectRelativePath(sourcePath, root);
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
      sourcePath,
      `${JSON.stringify(subsetRows, null, 2)}\n`,
    );
    await writeTextFileDurable(
      detailsManifestPath,
      `${JSON.stringify(detailRecords, null, 2)}\n`,
    );

    progress.success(
      options.discoverOnly
        ? `discovery complete (discovered=${totalDiscovered}, selected=${subsetRows.length})`
        : `collection+detail scrape complete (discovered=${totalDiscovered}, selected=${subsetRows.length}, details=${detailRecords.length})`,
    );
    console.log(
      options.discoverOnly
        ? `${adapter.scriptLabel} discovery complete.`
        : `${adapter.scriptLabel} scrape complete.`,
    );
    console.log(`- source_url: ${parsedAnchor.toString()}`);
    console.log(`- total_links_discovered: ${totalDiscovered}`);
    console.log(`- links_selected: ${subsetRows.length}`);
    console.log(`- start_index: ${startIndex}`);
    console.log(`- max_listings: ${options.maxListings ?? "all"}`);
    console.log(`- subset_mode: ${isSubsetMode}`);
    console.log(`- detail_pages_pulled: ${detailRecords.length}`);
    console.log(`- detail_pages_failed: ${failedDetailUrls.length}`);
    console.log(`- report_json: ${reportPathRel}`);
    console.log(`- external_source_json: ${sourcePathRel}`);
    console.log(`- details_manifest_json: ${detailsManifestPathRel}`);
  } finally {
    const closeStartedAt = Date.now();
    progress.phase("finalizing browser shutdown");
    await browser.close();
    progress.tick(
      `browser shutdown complete elapsed_ms=${Date.now() - closeStartedAt}`,
    );
  }
}
