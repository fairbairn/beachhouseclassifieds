import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { chromium } from "playwright";

import { createScrapeProgress } from "@/core/tooling/terminal/scrape-progress";
import type { CanonicalQuotesSidecarRecord } from "@/lib/pricing/contracts/quote-observations-contract";

type CliOptions = {
  adapterKey: string;
  listingId: string | null;
  maxListings: number | null;
  maxObservations: number;
  tolerance: number;
  timeoutMs: number;
};

type Candidate = {
  listingId: string;
  startDate: string;
  endDate: string;
  observedGrandTotal: number;
  handoffUrl: string;
};

function parseArgs(argv: string[]): CliOptions {
  let adapterKey = "realjoy30a";
  let listingId: string | null = null;
  let maxListings: number | null = null;
  let maxObservations = 4;
  let tolerance = 1;
  let timeoutMs = 30000;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    if (arg === "--adapter-key" && value) {
      adapterKey = value.trim().toLowerCase();
      index += 1;
      continue;
    }

    if (arg === "--listing-id" && value) {
      listingId = value.trim();
      index += 1;
      continue;
    }

    if (arg === "--max-listings" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        maxListings = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--max-observations" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        maxObservations = Math.max(1, Math.floor(parsed));
      }
      index += 1;
      continue;
    }

    if (arg === "--tolerance" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed >= 0) {
        tolerance = parsed;
      }
      index += 1;
      continue;
    }

    if (arg === "--timeout-ms" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        timeoutMs = Math.max(1000, Math.floor(parsed));
      }
      index += 1;
      continue;
    }
  }

  return {
    adapterKey,
    listingId,
    maxListings,
    maxObservations,
    tolerance,
    timeoutMs,
  };
}

function parseMoney(value: string): number | null {
  const parsed = Number(value.replace(/[^0-9.\-]+/g, "").trim());
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.round(parsed * 100) / 100;
}

async function collectQuoteFiles(
  quotesDir: string,
  listingId: string | null,
  maxListings: number | null,
): Promise<string[]> {
  const entries = await readdir(quotesDir, { withFileTypes: true });
  let files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();

  if (listingId) {
    files = files.filter((fileName) => fileName === `${listingId}.json`);
  }

  if (maxListings !== null) {
    files = files.slice(0, maxListings);
  }

  return files;
}

function collectCandidates(
  sidecar: CanonicalQuotesSidecarRecord,
  maxObservations: number,
): Candidate[] {
  const listingId = sidecar.external_listing_id;

  return sidecar.observations
    .filter(
      (observation) =>
        observation.quote_available === true &&
        typeof observation.grand_total === "number" &&
        Number.isFinite(observation.grand_total) &&
        typeof observation.handoff_url === "string" &&
        observation.handoff_url.length > 0,
    )
    .slice(0, maxObservations)
    .map((observation) => ({
      listingId,
      startDate: observation.start_date,
      endDate: observation.end_date,
      observedGrandTotal: observation.grand_total as number,
      handoffUrl: observation.handoff_url as string,
    }));
}

async function extractRenderedTotal(
  handoffUrl: string,
  timeoutMs: number,
): Promise<number | null> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      (window as unknown as { __name?: (target: unknown) => unknown }).__name =
        (target: unknown) => target;
    });
    await page.goto(handoffUrl, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });

    await page
      .waitForLoadState("networkidle", { timeout: timeoutMs })
      .catch(() => {
        // Continue with best-effort extraction if network stays chatty.
      });

    await page.waitForTimeout(1500);

    const value = await page.evaluate(() => {
      const parseMoneyInPage = (raw: string): number | null => {
        const parsed = Number(raw.replace(/[^0-9.\-]+/g, "").trim());
        if (!Number.isFinite(parsed)) {
          return null;
        }
        return Math.round(parsed * 100) / 100;
      };

      const labelNodes = Array.from(
        document.querySelectorAll(
          ".pdp-quote-item-text, .book-quote-item-text",
        ),
      ) as HTMLElement[];
      for (const labelNode of labelNodes) {
        const label = labelNode.textContent?.trim().toLowerCase() ?? "";
        if (!label.includes("total")) {
          continue;
        }
        const item =
          labelNode.closest("li, .pdp-quote-item, .book-quote-item") ??
          labelNode.parentElement;
        const priceNode = item?.querySelector(
          ".book-quote-item-price, .pdp-quote-item-price, [data-price]",
        ) as HTMLElement | null;
        const priceAttr = priceNode?.getAttribute("data-price") ?? "";
        const priceText = priceNode?.textContent ?? "";
        const parsed = parseMoneyInPage(priceAttr || priceText);
        if (parsed !== null) {
          return parsed;
        }
      }

      // Fallback: find any quote price node carrying data-price and pair it with nearby total text.
      const pricedNodes = Array.from(
        document.querySelectorAll(
          ".book-quote-item-price[data-price], .pdp-quote-item-price[data-price], [data-price]",
        ),
      ) as HTMLElement[];
      for (const node of pricedNodes) {
        const container =
          node.closest("li, .book-quote-item, .pdp-quote-item") ??
          node.parentElement;
        const context = (container?.textContent ?? "").toLowerCase();
        if (!context.includes("total")) {
          continue;
        }
        const parsed = parseMoneyInPage(node.getAttribute("data-price") ?? "");
        if (parsed !== null) {
          return parsed;
        }
      }

      const bodyText = document.body?.innerText ?? "";
      const match = bodyText.match(
        /\bTotal\b[^$]{0,80}\$\s*([0-9,]+(?:\.[0-9]{2})?)/i,
      );
      if (match?.[1]) {
        return parseMoneyInPage(match[1]);
      }

      return null;
    });

    return typeof value === "number" && Number.isFinite(value) ? value : null;
  } finally {
    await browser.close();
  }
}

async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const options = parseArgs(argv);
  const progress = createScrapeProgress({
    script: `${options.adapterKey}-handoff-render`,
  });

  const root = process.cwd();
  const quotesDir = resolve(
    root,
    "src",
    "lib",
    "data",
    "external-sources",
    options.adapterKey,
    "details",
    "quotes",
  );

  const files = await collectQuoteFiles(
    quotesDir,
    options.listingId,
    options.maxListings,
  );

  if (files.length === 0) {
    progress.failure(
      `No quote sidecars found for adapter=${options.adapterKey}`,
    );
    return 1;
  }

  const candidates: Candidate[] = [];
  for (const fileName of files) {
    const filePath = resolve(quotesDir, fileName);
    const raw = await readFile(filePath, "utf8");
    const sidecar = JSON.parse(raw) as CanonicalQuotesSidecarRecord;
    candidates.push(...collectCandidates(sidecar, options.maxObservations));
  }

  if (candidates.length === 0) {
    progress.failure(
      "No quote_available observations with handoff_url were selected.",
    );
    return 1;
  }

  progress.phase(
    `Running handoff render sample adapter=${options.adapterKey} observations=${candidates.length} tolerance=${options.tolerance.toFixed(2)}`,
  );

  let failures = 0;
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;
    const renderedTotal = await extractRenderedTotal(
      candidate.handoffUrl,
      options.timeoutMs,
    );

    if (renderedTotal === null) {
      failures += 1;
      progress.failure(
        `listing=${candidate.listingId} window=${candidate.startDate}->${candidate.endDate} rendered_total=n/a observed=${candidate.observedGrandTotal.toFixed(2)} code=total_not_found`,
      );
      continue;
    }

    const diff = Math.abs(renderedTotal - candidate.observedGrandTotal);
    const outcome = diff <= options.tolerance ? "match" : "mismatch";
    progress.progress(
      `${index + 1}/${candidates.length} listing=${candidate.listingId} window=${candidate.startDate}->${candidate.endDate} observed=${candidate.observedGrandTotal.toFixed(2)} rendered=${renderedTotal.toFixed(2)} diff=${diff.toFixed(2)} outcome=${outcome}`,
    );

    if (diff > options.tolerance) {
      failures += 1;
    }
  }

  if (failures > 0) {
    progress.failure(
      `Handoff render sample failed adapter=${options.adapterKey} tested=${candidates.length} failed=${failures}`,
    );
    return 1;
  }

  progress.success(
    `Handoff render sample passed adapter=${options.adapterKey} tested=${candidates.length} failed=0`,
  );
  return 0;
}

let exiting = false;
process.on("SIGINT", () => {
  if (exiting) {
    process.exit(130);
  }
  exiting = true;
  process.stderr.write("Operation cancelled by user.\n");
  process.exit(130);
});

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Handoff render sampler failed: ${message}\n`);
    process.exit(1);
  });
