import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const DEFAULT_URL = "https://www.360blue.com/travel-collections/30A";
const MAX_SCROLL_STEPS = 60;
const SCROLL_PAUSE_MS = 1000;
const NETWORK_IDLE_WAIT_MS = 800;

type ScrapedLink = {
  link: string;
  source_url: string;
  anchor_text: string;
};

type PlaywrightBrowserModule = {
  chromium: {
    launch(options?: Record<string, unknown>): Promise<{
      newPage(): Promise<{
        goto(url: string, options?: Record<string, unknown>): Promise<unknown>;
        waitForTimeout(ms: number): Promise<void>;
        evaluate<TReturn>(fn: () => TReturn): Promise<TReturn>;
      }>;
      close(): Promise<void>;
    }>;
  };
};

function normalizeLink(url: string): string {
  return url.split("#")[0]?.replace(/\/$/, "") ?? url;
}

async function loadPlaywright(): Promise<PlaywrightBrowserModule> {
  try {
    const module = (await import("playwright")) as PlaywrightBrowserModule;
    return module;
  } catch {
    throw new Error(
      "Playwright is not installed. Run: npm install -D playwright && npx playwright install chromium",
    );
  }
}

async function run(): Promise<void> {
  const anchorUrl = process.argv[2] ?? DEFAULT_URL;

  let parsedAnchor: URL;
  try {
    parsedAnchor = new URL(anchorUrl);
  } catch {
    throw new Error(`Invalid URL: ${anchorUrl}`);
  }

  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage();
    await page.goto(parsedAnchor.toString(), {
      waitUntil: "domcontentloaded",
      timeout: 120000,
    });

    let previousHeight = 0;
    for (let step = 0; step < MAX_SCROLL_STEPS; step += 1) {
      await page.evaluate(() => {
        window.scrollBy(0, window.innerHeight * 1.5);
      });

      await page.waitForTimeout(SCROLL_PAUSE_MS);

      const currentHeight = await page.evaluate(
        () => document.body.scrollHeight,
      );
      if (currentHeight === previousHeight) {
        await page.waitForTimeout(NETWORK_IDLE_WAIT_MS);
        const recheckHeight = await page.evaluate(
          () => document.body.scrollHeight,
        );
        if (recheckHeight === currentHeight) {
          break;
        }
      }

      previousHeight = currentHeight;
    }

    const linkRows = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll("a[href]"));
      return anchors.map((anchor) => ({
        href: (anchor as HTMLAnchorElement).href,
        text: (anchor.textContent ?? "").trim(),
      }));
    });

    const rows: ScrapedLink[] = [];
    const seen = new Set<string>();

    for (const row of linkRows) {
      const href = typeof row.href === "string" ? row.href : "";
      if (!href) {
        continue;
      }

      let parsed: URL;
      try {
        parsed = new URL(href);
      } catch {
        continue;
      }

      const isPropertyUrl =
        (parsed.hostname.endsWith("360blue.com") ||
          parsed.hostname.endsWith("callistavacations.com")) &&
        parsed.pathname.includes("/properties/");

      if (!isPropertyUrl) {
        continue;
      }

      const normalized = normalizeLink(parsed.toString());
      if (seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);

      rows.push({
        link: normalized,
        source_url: parsedAnchor.toString(),
        anchor_text: typeof row.text === "string" ? row.text : "",
      });
    }

    rows.sort((left, right) => left.link.localeCompare(right.link));

    const root = process.cwd();
    const reportsDir = resolve(root, ".tmp", "reports");
    const externalSourceDir = resolve(
      root,
      "src",
      "core",
      "data",
      "external-sources",
    );

    await mkdir(reportsDir, { recursive: true });
    await mkdir(externalSourceDir, { recursive: true });

    const payload = {
      generated_at: new Date().toISOString(),
      source_url: parsedAnchor.toString(),
      link_count: rows.length,
      links: rows,
    };

    const reportPath = resolve(reportsDir, "360blue-30a-playwright-links.json");
    const sourcePath = resolve(externalSourceDir, "360blue_listings.json");

    await writeFile(
      reportPath,
      `${JSON.stringify(payload, null, 2)}\n`,
      "utf8",
    );
    await writeFile(sourcePath, `${JSON.stringify(rows, null, 2)}\n`, "utf8");

    console.log("360Blue Playwright scrape complete.");
    console.log(`- source_url: ${parsedAnchor.toString()}`);
    console.log(`- links_found: ${rows.length}`);
    console.log(`- report_json: ${reportPath}`);
    console.log(`- external_source_json: ${sourcePath}`);
  } finally {
    await browser.close();
  }
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`360Blue Playwright scrape failed: ${message}`);
  process.exit(1);
});
