import "@/core/tooling/env/load-env-profile";

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

type CliOptions = {
  seedUrl: string;
  maxPages: number;
  delayMs: number;
  useApifyFallback: boolean;
};

type FetchedPage = {
  url: string;
  status: number;
  headers: Record<string, string>;
  html: string;
  blocked: boolean;
};

type RunSummary = {
  startedAt: string;
  finishedAt: string;
  mode: "native" | "apify-fallback";
  seedUrl: string;
  maxPages: number;
  nativePagesFetched: number;
  apifyItemsFetched: number;
  blockedDetected: boolean;
  listingCount: number;
  runDir: string;
  notes: Array<string>;
};

const defaultSeedUrl =
  "https://www.vrbo.com/search?typeaheadCollationId=9b61402c-a8cd-4cbe-a41c-5cf536e290da&destination=Santa+Rosa+Beach%2C+Florida%2C+United+States+of+America&regionId=183118&latLong=30.396032%2C-86.228828&adults=2&sort=RECOMMENDED&property_type_group=house&bedroom_count_gt=3&bed_count_ge=3";

const usage = [
  "Usage: tsx src/core/scripts/scrape-vrbo-listings.ts [options]",
  "",
  "Options:",
  "  --seed-url <url>        Seed VRBO search URL",
  "  --max-pages <number>    Max paginated pages to attempt (default: 10)",
  "  --delay-ms <number>     Delay between page requests (default: 800)",
  "  --use-apify-fallback    Trigger Apify Playwright fallback when blocked",
  "  --help                  Show help",
].join("\n");

function parseArgs(argv: Array<string>): CliOptions {
  let seedUrl = defaultSeedUrl;
  let maxPages = 10;
  let delayMs = 800;
  let useApifyFallback = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help") {
      console.log(usage);
      process.exit(0);
    }

    if (arg === "--seed-url") {
      const value = argv[index + 1];

      if (!value) {
        throw new Error("Missing value for --seed-url");
      }

      seedUrl = value;
      index += 1;
      continue;
    }

    if (arg === "--max-pages") {
      const value = Number(argv[index + 1]);

      if (!Number.isInteger(value) || value < 1) {
        throw new Error("--max-pages must be a positive integer");
      }

      maxPages = value;
      index += 1;
      continue;
    }

    if (arg === "--delay-ms") {
      const value = Number(argv[index + 1]);

      if (!Number.isInteger(value) || value < 0) {
        throw new Error("--delay-ms must be a non-negative integer");
      }

      delayMs = value;
      index += 1;
      continue;
    }

    if (arg === "--use-apify-fallback") {
      useApifyFallback = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    seedUrl,
    maxPages,
    delayMs,
    useApifyFallback,
  };
}

function nowStamp() {
  return new Date().toISOString().replaceAll(":", "-");
}

function padNumber(value: number, width = 3) {
  return String(value).padStart(width, "0");
}

function detectBlockedPage(status: number, html: string) {
  if (status === 429) {
    return true;
  }

  const lower = html.toLowerCase();
  return (
    lower.includes("bot or not?") ||
    lower.includes("wildcard-challenge-handler") ||
    lower.includes("captcha")
  );
}

async function fetchHtml(url: string): Promise<FetchedPage> {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
      pragma: "no-cache",
      "cache-control": "no-cache",
    },
  });

  const html = await response.text();
  const headers = Object.fromEntries(response.headers.entries());
  const blocked = detectBlockedPage(response.status, html);

  return {
    url,
    status: response.status,
    headers,
    html,
    blocked,
  };
}

function normalizeListingUrl(candidate: string) {
  const url = new URL(candidate);

  if (url.hostname !== "www.vrbo.com") {
    return null;
  }

  if (url.pathname.startsWith("/search")) {
    return null;
  }

  const segments = url.pathname.split("/").filter(Boolean);
  const firstSegment = segments[0] ?? "";

  if (!/^\d+[a-z0-9-]*$/i.test(firstSegment)) {
    return null;
  }

  url.hash = "";

  if (url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }

  return url.toString();
}

function extractListingUrls(html: string, baseUrl: string) {
  const urls = new Set<string>();
  const hrefRegex = /href\s*=\s*["']([^"']+)["']/gi;

  let match = hrefRegex.exec(html);

  while (match) {
    const href = match[1]?.trim() ?? "";

    if (
      href.length > 0 &&
      !href.startsWith("#") &&
      !href.startsWith("javascript:") &&
      !href.startsWith("mailto:")
    ) {
      try {
        const absoluteUrl = new URL(href, baseUrl).toString();
        const normalized = normalizeListingUrl(absoluteUrl);

        if (normalized) {
          urls.add(normalized);
        }
      } catch {
        // Skip malformed href values.
      }
    }

    match = hrefRegex.exec(html);
  }

  return Array.from(urls).sort((left, right) => left.localeCompare(right));
}

function getNumericParam(url: URL, key: string) {
  const raw = url.searchParams.get(key);
  const parsed = raw ? Number(raw) : NaN;

  return Number.isFinite(parsed) ? parsed : null;
}

function generateNextCandidates(currentUrl: string, pageNumber: number) {
  const current = new URL(currentUrl);
  const candidates = new Set<string>();

  const oneIndexedKeys = ["page", "pagenumber", "pageNumber", "pn", "curPage"];
  for (const key of oneIndexedKeys) {
    const next = new URL(current.toString());
    next.searchParams.set(key, String(pageNumber + 1));
    candidates.add(next.toString());
  }

  const offsetKeys = ["offset", "startIndex"];
  for (const key of offsetKeys) {
    const currentValue = getNumericParam(current, key) ?? (pageNumber - 1) * 25;
    const next = new URL(current.toString());
    next.searchParams.set(key, String(currentValue + 25));
    candidates.add(next.toString());
  }

  return Array.from(candidates);
}

function extractSearchPaginationLinks(html: string, baseUrl: string) {
  const links = new Set<string>();
  const hrefRegex = /href\s*=\s*["']([^"']+)["']/gi;

  let match = hrefRegex.exec(html);

  while (match) {
    const href = match[1]?.trim() ?? "";

    try {
      const absolute = new URL(href, baseUrl);
      if (
        absolute.hostname === "www.vrbo.com" &&
        absolute.pathname.startsWith("/search")
      ) {
        absolute.hash = "";
        links.add(absolute.toString());
      }
    } catch {
      // Ignore malformed links.
    }

    match = hrefRegex.exec(html);
  }

  return Array.from(links);
}

async function writePageArtifacts(
  runDir: string,
  prefix: string,
  pageIndex: number,
  page: FetchedPage,
  listingUrls: Array<string>,
) {
  const stem = `${prefix}-${padNumber(pageIndex)}`;
  await writeFile(resolve(runDir, `${stem}.html`), page.html, "utf8");
  await writeFile(
    resolve(runDir, `${stem}.json`),
    JSON.stringify(
      {
        fetchedAt: new Date().toISOString(),
        url: page.url,
        status: page.status,
        blocked: page.blocked,
        headers: page.headers,
        listingCount: listingUrls.length,
      },
      null,
      2,
    ),
    "utf8",
  );
}

function splitProxyGroups(value: string | undefined) {
  if (!value) {
    return ["RESIDENTIAL"];
  }

  const groups = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  return groups.length > 0 ? groups : ["RESIDENTIAL"];
}

function toPositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function normalizeCountryCode(value: string | undefined) {
  const normalized = value?.trim().toUpperCase();

  if (!normalized || !/^[A-Z]{2}$/.test(normalized)) {
    return undefined;
  }

  return normalized;
}

async function runApifyFallback(options: {
  seedUrl: string;
  maxPages: number;
  runDir: string;
  listingSet: Set<string>;
}) {
  const token = process.env.APIFY_API_TOKEN?.trim();

  if (!token) {
    throw new Error(
      "APIFY_API_TOKEN is required for fallback mode. Set it in .env.local.",
    );
  }

  const endpoint =
    `https://api.apify.com/v2/acts/apify~playwright-scraper/` +
    `run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;

  const requestTimeoutSecs = toPositiveInteger(
    process.env.APIFY_REQUEST_TIMEOUT_SECS,
    240,
  );
  const navigationTimeoutSecs = toPositiveInteger(
    process.env.APIFY_NAVIGATION_TIMEOUT_SECS,
    120,
  );
  const maxRequestRetries = toPositiveInteger(
    process.env.APIFY_MAX_REQUEST_RETRIES,
    6,
  );
  const proxyCountryCode = normalizeCountryCode(
    process.env.APIFY_PROXY_COUNTRY,
  );

  const input = {
    startUrls: [{ url: options.seedUrl }],
    globs: [{ glob: "https://www.vrbo.com/search*" }],
    maxPagesPerCrawl: options.maxPages,
    maxConcurrency: 1,
    maxRequestRetries,
    requestTimeoutSecs,
    navigationTimeoutSecs,
    headless: true,
    useSessionPool: true,
    persistCookiesPerSession: true,
    proxyConfiguration: {
      useApifyProxy: true,
      apifyProxyGroups: splitProxyGroups(process.env.APIFY_PROXY_GROUPS),
      ...(proxyCountryCode ? { apifyProxyCountry: proxyCountryCode } : {}),
    },
    pageFunction:
      "async function pageFunction(context) { const { request, page, enqueueLinks, log } = context; await page.waitForLoadState('domcontentloaded', { timeout: 90000 }).catch(() => {}); await page.waitForTimeout(3500); await enqueueLinks({ globs: ['https://www.vrbo.com/search*'] }); const html = await page.content(); const title = await page.title().catch(() => ''); const blocked = /bot or not|captcha|wildcard-challenge-handler/i.test((title + ' ' + html).toLowerCase()); if (blocked) { log.warning(`Potential anti-bot page at ${request.url}`); } return { url: request.url, finalUrl: page.url(), title, blocked, html }; }",
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(input),
  });

  const raw = await response.text();
  await writeFile(
    resolve(options.runDir, "apify-raw-response.json"),
    raw,
    "utf8",
  );

  if (!response.ok) {
    let quotaHint = "";

    try {
      const parsedError = JSON.parse(raw) as {
        error?: { message?: string };
      };
      const message = parsedError.error?.message ?? "";

      if (message.toLowerCase().includes("maximum usage")) {
        quotaHint =
          " Apify account appears to be at billing-cycle usage limit.";
      }
    } catch {
      // Keep original fallback message when error payload is not JSON.
    }

    throw new Error(
      `Apify fallback failed (${response.status}): ${raw.slice(0, 300)}${quotaHint}`,
    );
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("Apify fallback response was not a dataset item array.");
  }

  let itemCount = 0;
  const apifyErrorEntries: Array<unknown> = [];

  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    if (Reflect.get(entry, "#error") === true) {
      apifyErrorEntries.push(entry);
      continue;
    }

    const candidate = entry as { url?: unknown; html?: unknown };
    const url = typeof candidate.url === "string" ? candidate.url : null;
    const html = typeof candidate.html === "string" ? candidate.html : null;

    if (!url || !html) {
      continue;
    }

    itemCount += 1;
    const page: FetchedPage = {
      url,
      html,
      status: 200,
      blocked: detectBlockedPage(200, html),
      headers: {},
    };

    const listingUrls = extractListingUrls(html, url);
    for (const listingUrl of listingUrls) {
      options.listingSet.add(listingUrl);
    }

    await writePageArtifacts(
      options.runDir,
      "apify-item",
      itemCount,
      page,
      listingUrls,
    );
  }

  await writeFile(
    resolve(options.runDir, "apify-errors.json"),
    JSON.stringify(apifyErrorEntries, null, 2),
    "utf8",
  );

  return {
    itemCount,
    errorCount: apifyErrorEntries.length,
  };
}

function sleep(ms: number) {
  return new Promise<void>((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

async function main() {
  const startedAt = new Date().toISOString();
  const options = parseArgs(process.argv.slice(2));
  const runDir = resolve(process.cwd(), ".tmp", "vrbo", "listings", nowStamp());

  await mkdir(runDir, { recursive: true });

  const listingSet = new Set<string>();
  const notes: Array<string> = [];
  const seenSearchUrls = new Set<string>();
  let currentUrl = options.seedUrl;
  let blockedDetected = false;
  let nativePagesFetched = 0;
  let apifyItemsFetched = 0;

  for (let pageNumber = 1; pageNumber <= options.maxPages; pageNumber += 1) {
    if (seenSearchUrls.has(currentUrl)) {
      notes.push(
        `Duplicate search URL encountered; stopping at page ${pageNumber}.`,
      );
      break;
    }

    seenSearchUrls.add(currentUrl);
    const fetchedPage = await fetchHtml(currentUrl);
    nativePagesFetched += 1;

    const listingUrls = extractListingUrls(fetchedPage.html, currentUrl);
    for (const listingUrl of listingUrls) {
      listingSet.add(listingUrl);
    }

    await writePageArtifacts(
      runDir,
      "native-page",
      pageNumber,
      fetchedPage,
      listingUrls,
    );

    console.log(
      `Native page ${pageNumber}: status=${fetchedPage.status} blocked=${String(fetchedPage.blocked)} listings=${listingUrls.length}`,
    );

    if (fetchedPage.blocked) {
      blockedDetected = true;
      notes.push(`Blocked response detected at native page ${pageNumber}.`);
      break;
    }

    const discovered = extractSearchPaginationLinks(
      fetchedPage.html,
      currentUrl,
    );
    const generated = generateNextCandidates(currentUrl, pageNumber);
    const nextUrl = [...discovered, ...generated].find(
      (candidate) => !seenSearchUrls.has(candidate),
    );

    if (!nextUrl) {
      notes.push(
        `No additional pagination URL discovered after native page ${pageNumber}.`,
      );
      break;
    }

    currentUrl = nextUrl;
    if (options.delayMs > 0) {
      await sleep(options.delayMs);
    }
  }

  if (blockedDetected && options.useApifyFallback) {
    try {
      const apifyResult = await runApifyFallback({
        seedUrl: options.seedUrl,
        maxPages: options.maxPages,
        runDir,
        listingSet,
      });
      apifyItemsFetched = apifyResult.itemCount;
      notes.push(
        `Apify fallback completed. items=${apifyResult.itemCount}, datasetErrors=${apifyResult.errorCount}.`,
      );
      console.log(`Apify fallback pages: ${apifyItemsFetched}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notes.push(`Apify fallback failed: ${message}`);
      console.error(`Apify fallback failed: ${message}`);
    }
  }

  const listings = Array.from(listingSet).sort((left, right) =>
    left.localeCompare(right),
  );
  await writeFile(
    resolve(runDir, "listings.json"),
    JSON.stringify(listings, null, 2),
    "utf8",
  );

  const summary: RunSummary = {
    startedAt,
    finishedAt: new Date().toISOString(),
    mode:
      blockedDetected && options.useApifyFallback ? "apify-fallback" : "native",
    seedUrl: options.seedUrl,
    maxPages: options.maxPages,
    nativePagesFetched,
    apifyItemsFetched,
    blockedDetected,
    listingCount: listings.length,
    runDir,
    notes,
  };

  await writeFile(
    resolve(runDir, "summary.json"),
    JSON.stringify(summary, null, 2),
    "utf8",
  );

  console.log(`Run directory: ${runDir}`);
  console.log(`Unique listings discovered: ${summary.listingCount}`);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`VRBO listing scrape failed: ${message}`);
  process.exit(1);
}
