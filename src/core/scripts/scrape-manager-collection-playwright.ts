import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

type ScrapedLink = {
  link: string;
  source_url: string;
  anchor_text: string;
};

type Options = {
  anchorUrl: string;
  managerKey: string;
  allowedHosts: string[];
  pathContains: string[];
  maxScrollSteps: number;
  scrollPauseMs: number;
  networkIdleWaitMs: number;
  clickLoadMore: boolean;
  maxLoadMoreClicksPerStep: number;
  clickNextPage: boolean;
};

type PlaywrightBrowserModule = {
  chromium: {
    launch(options?: Record<string, unknown>): Promise<{
      newPage(): Promise<{
        on(
          event: "response",
          listener: (response: {
            url(): string;
            headers(): Record<string, string>;
            text(): Promise<string>;
          }) => void,
        ): void;
        goto(url: string, options?: Record<string, unknown>): Promise<unknown>;
        waitForTimeout(ms: number): Promise<void>;
        evaluate<TReturn>(fn: () => TReturn): Promise<TReturn>;
      }>;
      close(): Promise<void>;
    }>;
  };
};

const DEFAULT_MAX_SCROLL_STEPS = 60;
const DEFAULT_SCROLL_PAUSE_MS = 1000;
const DEFAULT_NETWORK_IDLE_WAIT_MS = 800;
const DEFAULT_MAX_LOAD_MORE_CLICKS_PER_STEP = 4;

function normalizeHost(host: string): string {
  return host
    .toLowerCase()
    .replace(/^www\./, "")
    .trim();
}

function normalizeLink(url: string): string {
  return url.split("#")[0]?.replace(/\/$/, "") ?? url;
}

function toManagerKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 60);
}

function parseListArg(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseArgs(argv: string[]): Options {
  const anchorUrl = argv[2];
  if (!anchorUrl) {
    throw new Error(
      "Usage: tsx src/core/scripts/scrape-manager-collection-playwright.ts <anchor-url> [--manager-key slug] [--allowed-hosts host1,host2] [--path-contains /properties/,/vacation-rentals/]",
    );
  }

  let parsedAnchor: URL;
  try {
    parsedAnchor = new URL(anchorUrl);
  } catch {
    throw new Error(`Invalid anchor URL: ${anchorUrl}`);
  }

  let managerKey = toManagerKey(parsedAnchor.hostname);
  let allowedHosts: string[] = [normalizeHost(parsedAnchor.hostname)];
  let pathContains = ["/properties/", "/vacation-rentals/"];
  let maxScrollSteps = DEFAULT_MAX_SCROLL_STEPS;
  let scrollPauseMs = DEFAULT_SCROLL_PAUSE_MS;
  let networkIdleWaitMs = DEFAULT_NETWORK_IDLE_WAIT_MS;
  let clickLoadMore = true;
  let maxLoadMoreClicksPerStep = DEFAULT_MAX_LOAD_MORE_CLICKS_PER_STEP;
  let clickNextPage = true;

  for (let index = 3; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    if (arg === "--manager-key" && value) {
      managerKey = toManagerKey(value);
      index += 1;
      continue;
    }

    if (arg === "--allowed-hosts" && value) {
      const hosts = parseListArg(value).map(normalizeHost);
      if (hosts.length > 0) {
        allowedHosts = hosts;
      }
      index += 1;
      continue;
    }

    if (arg === "--path-contains" && value) {
      const includes = parseListArg(value).map((item) => item.toLowerCase());
      if (includes.length > 0) {
        pathContains = includes;
      }
      index += 1;
      continue;
    }

    if (arg === "--max-scroll-steps" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        maxScrollSteps = parsed;
      }
      index += 1;
      continue;
    }

    if (arg === "--scroll-pause-ms" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        scrollPauseMs = parsed;
      }
      index += 1;
      continue;
    }

    if (arg === "--network-idle-wait-ms" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        networkIdleWaitMs = parsed;
      }
      index += 1;
      continue;
    }

    if (arg === "--click-load-more" && value) {
      const normalized = value.toLowerCase();
      clickLoadMore =
        normalized !== "false" && normalized !== "0" && normalized !== "no";
      index += 1;
      continue;
    }

    if (arg === "--max-load-more-clicks-per-step" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        maxLoadMoreClicksPerStep = parsed;
      }
      index += 1;
      continue;
    }

    if (arg === "--click-next-page" && value) {
      const normalized = value.toLowerCase();
      clickNextPage =
        normalized !== "false" && normalized !== "0" && normalized !== "no";
      index += 1;
      continue;
    }
  }

  return {
    anchorUrl: parsedAnchor.toString(),
    managerKey,
    allowedHosts,
    pathContains,
    maxScrollSteps,
    scrollPauseMs,
    networkIdleWaitMs,
    clickLoadMore,
    maxLoadMoreClicksPerStep,
    clickNextPage,
  };
}

async function loadPlaywright(): Promise<PlaywrightBrowserModule> {
  try {
    return (await import("playwright")) as PlaywrightBrowserModule;
  } catch {
    throw new Error(
      "Playwright is not installed. Run: npm install -D playwright && npx playwright install chromium",
    );
  }
}

function includeLink(href: string, options: Options): boolean {
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    return false;
  }

  const host = normalizeHost(parsed.hostname);
  if (
    !options.allowedHosts.some((allowed) => host === normalizeHost(allowed))
  ) {
    return false;
  }

  const path = parsed.pathname.toLowerCase();
  if (
    path.includes("/_next/") ||
    path.includes("/static/") ||
    path.includes("/assets/") ||
    path.includes("/chunks/") ||
    /\.(?:js|mjs|css|map|png|jpg|jpeg|webp|gif|svg|ico|woff|woff2|ttf|eot|pdf|xml|json|tsx?)$/i.test(
      path,
    )
  ) {
    return false;
  }

  return options.pathContains.some((segment) => path.includes(segment));
}

function resolveMaybeRelativeUrl(raw: string, baseUrl: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("javascript:")) {
    return null;
  }

  let withProtocol = trimmed;
  if (/^\/+www\./i.test(trimmed)) {
    withProtocol = `https://${trimmed.replace(/^\/+/, "")}`;
  } else if (/^www\./i.test(trimmed)) {
    withProtocol = `https://${trimmed}`;
  } else if (/^\/+[a-z0-9.-]+\.[a-z]{2,}\//i.test(trimmed)) {
    withProtocol = `https://${trimmed.replace(/^\/+/, "")}`;
  } else if (/^[a-z0-9.-]+\.[a-z]{2,}\//i.test(trimmed)) {
    withProtocol = `https://${trimmed}`;
  }

  try {
    return new URL(withProtocol, baseUrl).toString();
  } catch {
    return null;
  }
}

async function run(): Promise<void> {
  const options = parseArgs(process.argv);
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage();
    const networkRows: Array<{ href: string; text: string }> = [];
    const networkSeen = new Set<string>();

    page.on("response", (response) => {
      void (async () => {
        try {
          const responseUrl = response.url();
          const parsed = new URL(responseUrl);
          const host = normalizeHost(parsed.hostname);
          if (
            !options.allowedHosts.some(
              (allowed) => host === normalizeHost(allowed),
            )
          ) {
            return;
          }

          const headers = response.headers();
          const contentType = (
            headers["content-type"] ??
            headers["Content-Type"] ??
            ""
          ).toLowerCase();
          const isJsonLike =
            contentType.includes("application/json") ||
            contentType.includes("application/ld+json") ||
            responseUrl.includes("/api/") ||
            responseUrl.includes("graphql");

          if (!isJsonLike) {
            return;
          }

          const bodyText = await response.text();
          if (!bodyText || bodyText.length < 8) {
            return;
          }

          const matches =
            bodyText.match(
              /(?:https?:\/\/[^"'\s<>]+|\/[a-z0-9][^"'\s<>]{2,})/gi,
            ) ?? [];
          for (const match of matches) {
            const normalized = match
              .replace(/\\\\\//g, "/")
              .replace(/\\\//g, "/")
              .replace(/["']/g, "")
              .trim();
            if (!normalized || normalized.startsWith("javascript:")) {
              continue;
            }

            const absolute = resolveMaybeRelativeUrl(normalized, responseUrl);
            if (!absolute) {
              continue;
            }

            const dedupe = normalizeLink(absolute);
            if (networkSeen.has(dedupe)) {
              continue;
            }
            networkSeen.add(dedupe);
            networkRows.push({ href: absolute, text: "network-response" });
          }
        } catch {
          // Ignore parsing failures from non-JSON or opaque responses.
        }
      })();
    });

    await page.goto(options.anchorUrl, {
      waitUntil: "domcontentloaded",
      timeout: 120000,
    });

    let previousHeight = 0;
    for (let step = 0; step < options.maxScrollSteps; step += 1) {
      await page.evaluate(() => {
        window.scrollBy(0, window.innerHeight * 1.5);
      });

      await page.waitForTimeout(options.scrollPauseMs);

      let clickedLoadMore = false;
      if (options.clickLoadMore) {
        for (
          let clickAttempt = 0;
          clickAttempt < options.maxLoadMoreClicksPerStep;
          clickAttempt += 1
        ) {
          const clickedCount = await page.evaluate(() => {
            const clickables = Array.from(
              document.querySelectorAll(
                "button, a, [role='button'], input[type='button'], input[type='submit']",
              ),
            );

            let clicked = 0;
            for (const clickable of clickables) {
              const element = clickable as HTMLElement;
              if (element.offsetParent === null) {
                continue;
              }
              if (
                element.getAttribute("disabled") !== null ||
                element.getAttribute("aria-disabled") === "true"
              ) {
                continue;
              }

              const text = (clickable.textContent ?? "").toLowerCase().trim();
              const valueAttr = (clickable.getAttribute("value") ?? "")
                .toLowerCase()
                .trim();
              const ariaLabel = (clickable.getAttribute("aria-label") ?? "")
                .toLowerCase()
                .trim();
              const title = (clickable.getAttribute("title") ?? "")
                .toLowerCase()
                .trim();
              const combined = `${text} ${valueAttr} ${ariaLabel} ${title}`;
              const matchesLoadMoreAction =
                combined.includes("load more") ||
                combined.includes("show more") ||
                combined.includes("view more") ||
                combined.includes("more results") ||
                combined.includes("see more") ||
                combined.includes("show all") ||
                combined.includes("more homes");

              if (!matchesLoadMoreAction) {
                continue;
              }

              element.click();
              clicked += 1;
            }

            return clicked;
          });

          if (clickedCount === 0) {
            break;
          }

          clickedLoadMore = true;
          await page.waitForTimeout(options.scrollPauseMs);
        }
      }

      let clickedNextPage = false;
      if (options.clickNextPage) {
        clickedNextPage = await page.evaluate(() => {
          const nextCandidates = Array.from(
            document.querySelectorAll(
              "a[rel='next'], button[rel='next'], a[aria-label*='Next' i], button[aria-label*='Next' i], .pagination-next a, .pagination-next button",
            ),
          );

          for (const candidate of nextCandidates) {
            const element = candidate as HTMLElement;
            const isVisible = element.offsetParent !== null;
            const isDisabled =
              element.getAttribute("disabled") !== null ||
              element.getAttribute("aria-disabled") === "true" ||
              element.classList.contains("disabled");
            if (!isVisible || isDisabled) {
              continue;
            }
            element.click();
            return true;
          }

          const textCandidates = Array.from(
            document.querySelectorAll("a, button, [role='button']"),
          );
          for (const candidate of textCandidates) {
            const element = candidate as HTMLElement;
            const isVisible = element.offsetParent !== null;
            const isDisabled =
              element.getAttribute("disabled") !== null ||
              element.getAttribute("aria-disabled") === "true" ||
              element.classList.contains("disabled");
            if (!isVisible || isDisabled) {
              continue;
            }
            const text = (element.textContent ?? "").toLowerCase().trim();
            if (text === "next" || text === "next page" || text === "more") {
              element.click();
              return true;
            }
          }

          return false;
        });

        if (clickedNextPage) {
          await page.waitForTimeout(options.scrollPauseMs);
        }
      }

      const currentHeight = await page.evaluate(
        () => document.body.scrollHeight,
      );
      if (currentHeight === previousHeight) {
        if (clickedLoadMore || clickedNextPage) {
          continue;
        }
        await page.waitForTimeout(options.networkIdleWaitMs);
        const recheckHeight = await page.evaluate(
          () => document.body.scrollHeight,
        );
        if (recheckHeight === currentHeight) {
          break;
        }
      }

      previousHeight = currentHeight;
    }

    const rawRows = await page.evaluate(() => {
      const candidates: Array<{ href: string; text: string }> = [];

      const anchors = Array.from(document.querySelectorAll("a[href]"));
      for (const anchor of anchors) {
        const href = (anchor as HTMLAnchorElement).getAttribute("href") ?? "";
        const trimmed = href.trim();
        if (!trimmed || trimmed.startsWith("javascript:")) {
          continue;
        }

        let withProtocol = trimmed;
        if (/^\/+www\./i.test(trimmed)) {
          withProtocol = `https://${trimmed.replace(/^\/+/, "")}`;
        } else if (/^www\./i.test(trimmed)) {
          withProtocol = `https://${trimmed}`;
        }

        try {
          const absolute = new URL(
            withProtocol,
            window.location.origin,
          ).toString();
          candidates.push({
            href: absolute,
            text: (anchor.textContent ?? "").trim(),
          });
        } catch {
          // Ignore malformed URL values from arbitrary attributes/scripts.
        }
      }

      const attrs = [
        "href",
        "src",
        "action",
        "data-href",
        "data-url",
        "data-link",
        "data-path",
        "data-permalink",
        "data-entity-url",
      ];

      const attrNodes = Array.from(
        document.querySelectorAll(
          "*[href], *[src], *[action], *[data-href], *[data-url], *[data-link], *[data-path], *[data-permalink], *[data-entity-url]",
        ),
      );
      for (const node of attrNodes) {
        for (const attr of attrs) {
          const value = node.getAttribute(attr);
          if (!value) {
            continue;
          }

          const trimmed = value.trim();
          if (!trimmed || trimmed.startsWith("javascript:")) {
            continue;
          }

          let withProtocol = trimmed;
          if (/^\/+www\./i.test(trimmed)) {
            withProtocol = `https://${trimmed.replace(/^\/+/, "")}`;
          } else if (/^www\./i.test(trimmed)) {
            withProtocol = `https://${trimmed}`;
          }

          try {
            const absolute = new URL(
              withProtocol,
              window.location.origin,
            ).toString();
            candidates.push({
              href: absolute,
              text: (node.textContent ?? "").trim(),
            });
          } catch {
            // Ignore malformed URL values from arbitrary attributes/scripts.
          }
        }
      }

      const scriptUrlRegex =
        /(?:https?:\/\/[^"'\s<>]+|\/[a-z0-9][^"'\s<>]{2,})/gi;
      const scripts = Array.from(document.querySelectorAll("script"));
      for (const script of scripts) {
        const text = script.textContent ?? "";
        if (text.length < 20) {
          continue;
        }

        const matches = text.match(scriptUrlRegex) ?? [];
        for (const rawMatch of matches) {
          const normalized = rawMatch
            .replace(/\\\\\//g, "/")
            .replace(/\\\//g, "/")
            .replace(/["']/g, "")
            .trim();
          if (!normalized || normalized.startsWith("javascript:")) {
            continue;
          }

          let withProtocol = normalized;
          if (/^\/+www\./i.test(normalized)) {
            withProtocol = `https://${normalized.replace(/^\/+/, "")}`;
          } else if (/^www\./i.test(normalized)) {
            withProtocol = `https://${normalized}`;
          }

          try {
            const absolute = new URL(
              withProtocol,
              window.location.origin,
            ).toString();
            candidates.push({ href: absolute, text: "script-embedded" });
          } catch {
            // Ignore malformed URL values from embedded script fragments.
          }
        }
      }

      return candidates;
    });

    await page.waitForTimeout(options.networkIdleWaitMs);
    const allRows = [...rawRows, ...networkRows];

    const links: ScrapedLink[] = [];
    const seen = new Set<string>();

    for (const row of allRows) {
      const href = typeof row.href === "string" ? row.href : "";
      if (!href || !includeLink(href, options)) {
        continue;
      }

      const normalized = normalizeLink(href);
      if (seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);

      links.push({
        link: normalized,
        source_url: options.anchorUrl,
        anchor_text: typeof row.text === "string" ? row.text : "",
      });
    }

    links.sort((left, right) => left.link.localeCompare(right.link));

    const payload = {
      generated_at: new Date().toISOString(),
      manager_key: options.managerKey,
      source_url: options.anchorUrl,
      allowed_hosts: options.allowedHosts,
      path_contains: options.pathContains,
      link_count: links.length,
      links,
    };

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

    const reportPath = resolve(
      reportsDir,
      `${options.managerKey}-playwright-links.json`,
    );
    const sourcePath = resolve(
      externalSourceDir,
      `${options.managerKey}_listings.json`,
    );

    await writeFile(
      reportPath,
      `${JSON.stringify(payload, null, 2)}\n`,
      "utf8",
    );
    await writeFile(sourcePath, `${JSON.stringify(links, null, 2)}\n`, "utf8");

    console.log("Manager Playwright scrape complete.");
    console.log(`- manager_key: ${options.managerKey}`);
    console.log(`- source_url: ${options.anchorUrl}`);
    console.log(`- links_found: ${links.length}`);
    console.log(`- report_json: ${reportPath}`);
    console.log(`- external_source_json: ${sourcePath}`);
  } finally {
    await browser.close();
  }
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Manager Playwright scrape failed: ${message}`);
  process.exit(1);
});
