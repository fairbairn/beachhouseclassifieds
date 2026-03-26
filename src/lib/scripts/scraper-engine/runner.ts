import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Browser } from "playwright";

import { createScrapeProgress } from "@/core/tooling/terminal/scrape-progress";

import type {
  DetailRecordBase,
  RunOptions,
  ScrapedLink,
  ScraperAdapter,
} from "./types";

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function normalizeLink(url: string): string {
  return url.split("#")[0]?.replace(/\/$/, "") ?? url;
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
  let detailUrl: string | null = null;
  let detailUrlsFile: string | null = null;
  let refreshKnown = false;
  let maxScrollSteps = 80;
  let scrollPauseMs = 900;
  let networkIdleWaitMs = 800;
  let detailFetchConcurrency: number | null = null;
  let detailFetchDelayMs: number | null = null;

  let index = 2;
  if (argv[index] && !argv[index]?.startsWith("--")) {
    anchorUrl = argv[index] as string;
    index += 1;
  }

  for (; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    if (arg === "--max-listings" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        maxListings = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--start-index" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed >= 0) {
        startIndex = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--detail-url" && value) {
      detailUrl = value;
      index += 1;
      continue;
    }

    if (arg === "--detail-urls-file" && value) {
      detailUrlsFile = value;
      index += 1;
      continue;
    }

    if (arg === "--refresh-known") {
      refreshKnown = true;
      continue;
    }

    if (arg === "--max-scroll-steps" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        maxScrollSteps = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--scroll-pause-ms" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        scrollPauseMs = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--network-idle-wait-ms" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        networkIdleWaitMs = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--detail-fetch-concurrency" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        detailFetchConcurrency = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--detail-fetch-delay-ms" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed >= 0) {
        detailFetchDelayMs = Math.floor(parsed);
      }
      index += 1;
    }
  }

  return {
    anchorUrl,
    maxListings,
    startIndex,
    detailUrl,
    detailUrlsFile,
    refreshKnown,
    maxScrollSteps,
    scrollPauseMs,
    networkIdleWaitMs,
    detailFetchConcurrency,
    detailFetchDelayMs,
  };
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
  reportsDir: string,
  managerKey: string,
  outputRoot: string,
  outputDetailsJsonDir: string,
  validate: (value: string) => string | null,
): Promise<string[]> {
  const urls: string[] = [];

  const manifestPaths = [
    resolve(reportsDir, `${managerKey}-details-manifest.json`),
    resolve(reportsDir, `${managerKey}-details-manifest-subset.json`),
    resolve(outputRoot, "details", "index.json"),
    resolve(outputRoot, "details", "index-subset.json"),
  ];

  for (const manifestPath of manifestPaths) {
    try {
      const raw = await readFile(manifestPath, "utf8");
      const parsed = JSON.parse(raw) as Array<{ detail_url?: unknown }>;
      if (!Array.isArray(parsed)) {
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
    } catch {
      // Ignore missing or malformed manifests.
    }
  }

  try {
    const entries = await readdir(outputDetailsJsonDir, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }

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
      } catch {
        // Ignore malformed detail files.
      }
    }
  } catch {
    // Details directory may not exist yet.
  }

  return Array.from(new Set(urls));
}

async function pullDetails<TDetail extends DetailRecordBase>(
  browser: Browser,
  urls: string[],
  adapter: ScraperAdapter<TDetail>,
  outputDetailsJsonDir: string,
  progress: ReturnType<typeof createScrapeProgress>,
  detailFetchConcurrency: number,
  detailFetchDelayMs: number,
): Promise<{
  detailRecords: TDetail[];
  failedDetailUrls: string[];
}> {
  const detailResults: Array<TDetail | null> = new Array(urls.length).fill(
    null,
  );
  const failedDetailUrls: string[] = [];
  const detailRecords: TDetail[] = [];

  let nextIndex = 0;
  let processed = 0;
  const workerCount = Math.min(detailFetchConcurrency, urls.length);

  const worker = async (): Promise<void> => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= urls.length) {
        return;
      }

      const detailUrl = urls[currentIndex] as string;
      const detail = await adapter.fetchDetail({
        browser,
        detailUrl,
        availabilityHorizonDays: adapter.availabilityHorizonDays,
        maxCalendarAdvanceMonths: adapter.maxCalendarAdvanceMonths,
      });

      detailResults[currentIndex] = detail;
      processed += 1;
      if (processed % 5 === 0 || processed === urls.length) {
        progress.tick(`details processed ${processed}/${urls.length}`);
      }

      if (detailFetchDelayMs > 0) {
        await sleep(detailFetchDelayMs);
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  for (let index = 0; index < urls.length; index += 1) {
    const detail = detailResults[index];
    const detailUrl = urls[index] as string;

    if (!detail) {
      failedDetailUrls.push(detailUrl);
      continue;
    }

    detailRecords.push(detail);
    const detailPath = resolve(
      outputDetailsJsonDir,
      `${detail.external_listing_id}.json`,
    );
    await writeFile(detailPath, `${JSON.stringify(detail, null, 2)}\n`, "utf8");
  }

  return { detailRecords, failedDetailUrls };
}

export async function runScraperEngine<TDetail extends DetailRecordBase>(
  adapter: ScraperAdapter<TDetail>,
): Promise<void> {
  const progress = createScrapeProgress({ script: adapter.scriptLabel });
  const options = parseRunOptions(process.argv, adapter.defaultAnchorUrl);
  const detailFetchConcurrency =
    options.detailFetchConcurrency ?? adapter.detailFetchConcurrency;
  const detailFetchDelayMs =
    options.detailFetchDelayMs ?? adapter.detailFetchDelayMs;

  progress.phase("starting scraper engine run");
  progress.info(
    `mode=${options.detailUrl ? "direct-detail" : options.refreshKnown || options.detailUrlsFile ? "refresh-known" : "full"}, scroll_steps=${options.maxScrollSteps}, scroll_pause_ms=${options.scrollPauseMs}, network_idle_wait_ms=${options.networkIdleWaitMs}, concurrency=${detailFetchConcurrency}, detail_delay_ms=${detailFetchDelayMs}`,
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
      const valid = adapter.isValidDetailUrl(options.detailUrl);
      if (!valid) {
        throw new Error(`Invalid detail URL: ${options.detailUrl}`);
      }

      progress.phase("direct detail mode: pulling one listing detail page");
      const detail = await adapter.fetchDetail({
        browser,
        detailUrl: valid,
        availabilityHorizonDays: adapter.availabilityHorizonDays,
        maxCalendarAdvanceMonths: adapter.maxCalendarAdvanceMonths,
      });

      if (!detail) {
        throw new Error("Direct detail scrape failed for requested URL");
      }

      const detailPath = resolve(
        outputDetailsJsonDir,
        `${detail.external_listing_id}.json`,
      );
      await writeFile(
        detailPath,
        `${JSON.stringify(detail, null, 2)}\n`,
        "utf8",
      );

      const reportPath = resolve(
        reportsDir,
        `${adapter.managerKey}-direct-detail-report.json`,
      );
      await writeFile(
        reportPath,
        `${JSON.stringify(
          {
            generated_at: new Date().toISOString(),
            mode: "direct_detail",
            detail_url: detail.detail_url,
            external_listing_id: detail.external_listing_id,
            detail_json: detailPath,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      progress.success(
        `direct detail scrape complete (id=${detail.external_listing_id})`,
      );
      console.log(`${adapter.scriptLabel} direct detail scrape complete.`);
      console.log(`- detail_url: ${detail.detail_url}`);
      console.log(`- external_listing_id: ${detail.external_listing_id}`);
      console.log(`- detail_json: ${detailPath}`);
      console.log(`- report_json: ${reportPath}`);
      return;
    }

    if (options.refreshKnown || options.detailUrlsFile) {
      const knownUrls = options.refreshKnown
        ? await loadKnownDetailUrlsFromArtifacts(
            reportsDir,
            adapter.managerKey,
            outputRoot,
            outputDetailsJsonDir,
            adapter.isValidDetailUrl,
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

      progress.phase(
        `refresh mode: pulling known detail pages (count=${selectedUrls.length}, concurrency=${detailFetchConcurrency})`,
      );

      const { detailRecords, failedDetailUrls } = await pullDetails(
        browser,
        selectedUrls,
        adapter,
        outputDetailsJsonDir,
        progress,
        detailFetchConcurrency,
        detailFetchDelayMs,
      );

      const reportPath = resolve(
        reportsDir,
        `${adapter.managerKey}-refresh-known-report.json`,
      );
      await writeFile(
        reportPath,
        `${JSON.stringify(
          {
            generated_at: new Date().toISOString(),
            mode: "refresh_known_details",
            source_count: merged.length,
            start_index: startIndex,
            max_listings: options.maxListings,
            selected_count: selectedUrls.length,
            detail_pages_pulled: detailRecords.length,
            detail_pages_failed: failedDetailUrls.length,
            failed_detail_urls: failedDetailUrls,
            selected_urls: selectedUrls,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      progress.success(
        `refresh scrape complete (selected=${selectedUrls.length}, details=${detailRecords.length})`,
      );
      console.log(`${adapter.scriptLabel} refresh scrape complete.`);
      console.log(`- known_urls_discovered: ${merged.length}`);
      console.log(`- urls_selected: ${selectedUrls.length}`);
      console.log(`- detail_pages_pulled: ${detailRecords.length}`);
      console.log(`- detail_pages_failed: ${failedDetailUrls.length}`);
      console.log(`- report_json: ${reportPath}`);
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

    progress.phase(
      `pulling detail pages from selected subset (count=${subsetRows.length}, concurrency=${detailFetchConcurrency})`,
    );

    const selectedUrls = subsetRows.map((row) => row.link);
    const { detailRecords, failedDetailUrls } = await pullDetails(
      browser,
      selectedUrls,
      adapter,
      outputDetailsJsonDir,
      progress,
      detailFetchConcurrency,
      detailFetchDelayMs,
    );

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
    const sourcePath = resolve(
      externalSourceDir,
      isSubsetMode
        ? `${adapter.managerKey}_listings_subset.json`
        : `${adapter.managerKey}_listings.json`,
    );
    const detailsManifestPath = resolve(
      reportsDir,
      isSubsetMode
        ? `${adapter.managerKey}-details-manifest-subset.json`
        : `${adapter.managerKey}-details-manifest.json`,
    );

    await writeFile(
      reportPath,
      `${JSON.stringify(payload, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      sourcePath,
      `${JSON.stringify(subsetRows, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      detailsManifestPath,
      `${JSON.stringify(detailRecords, null, 2)}\n`,
      "utf8",
    );

    progress.success(
      `collection+detail scrape complete (discovered=${totalDiscovered}, selected=${subsetRows.length}, details=${detailRecords.length})`,
    );
    console.log(`${adapter.scriptLabel} scrape complete.`);
    console.log(`- source_url: ${parsedAnchor.toString()}`);
    console.log(`- total_links_discovered: ${totalDiscovered}`);
    console.log(`- links_selected: ${subsetRows.length}`);
    console.log(`- start_index: ${startIndex}`);
    console.log(`- max_listings: ${options.maxListings ?? "all"}`);
    console.log(`- subset_mode: ${isSubsetMode}`);
    console.log(`- detail_pages_pulled: ${detailRecords.length}`);
    console.log(`- detail_pages_failed: ${failedDetailUrls.length}`);
    console.log(`- report_json: ${reportPath}`);
    console.log(`- external_source_json: ${sourcePath}`);
    console.log(`- details_manifest_json: ${detailsManifestPath}`);
  } finally {
    await browser.close();
  }
}
