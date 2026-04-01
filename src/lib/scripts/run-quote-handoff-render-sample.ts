import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { chromium } from "playwright";

import { createScrapeProgress } from "@/core/tooling/terminal/scrape-progress";
import type { CanonicalQuotesSidecarRecord } from "@/lib/pricing/contracts/quote-observations-contract";
import { runWithConcurrency } from "@/lib/pricing/quotes/shared/run-with-concurrency";
import { parseRealjoyRenderedTotal } from "@/lib/pricing/validation/handoff/adapters/realjoy30a";
import {
  createPacedGate,
  createPerfTracker,
  parseRetryDelaysMs,
  withRetries,
} from "@/lib/pricing/validation/handoff/shared/execution";

type CliOptions = {
  adapterKey: string;
  listingId: string | null;
  maxListings: number | null;
  maxObservations: number;
  tolerance: number;
  timeoutMs: number;
  settleMs: number;
  concurrency: number;
  minGapMs: number;
  retryDelaysMs: number[];
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
  let timeoutMs = 15000;
  let settleMs = 1000;
  let concurrency = 3;
  let minGapMs = 120;
  let retryDelaysRaw = "";

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

    if (arg === "--settle-ms" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed >= 0) {
        settleMs = Math.max(0, Math.floor(parsed));
      }
      index += 1;
      continue;
    }

    if (arg === "--concurrency" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        concurrency = Math.max(1, Math.floor(parsed));
      }
      index += 1;
      continue;
    }

    if (arg === "--min-gap-ms" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed >= 0) {
        minGapMs = Math.max(0, Math.floor(parsed));
      }
      index += 1;
      continue;
    }

    if (arg === "--retry-delays-ms" && value) {
      retryDelaysRaw = value;
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
    settleMs,
    concurrency,
    minGapMs,
    retryDelaysMs: parseRetryDelaysMs(retryDelaysRaw, [0, 700, 1800, 4000]),
  };
}

function parseMoney(value: string): number | null {
  const parsed = Number(value.replace(/[^0-9.-]+/g, "").trim());
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.round(parsed * 100) / 100;
}

function parseGenericRenderedTotal(html: string): number | null {
  const match = html.match(
    /\bTotal\b[^$]{0,120}\$\s*([0-9,]+(?:\.[0-9]{2})?)/i,
  );
  if (!match?.[1]) {
    return null;
  }
  return parseMoney(match[1]);
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
    files = files.filter((name) => name === `${listingId}.json`);
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

async function extractRenderedTotal(input: {
  adapterKey: string;
  handoffUrl: string;
  timeoutMs: number;
  settleMs: number;
  retryDelaysMs: number[];
  paced: ReturnType<typeof createPacedGate>;
  onRetry?: (message: string) => void;
}): Promise<number | null> {
  return withRetries(
    async () =>
      input.paced.run(async () => {
        const browser = await chromium.launch({ headless: true });
        try {
          const page = await browser.newPage();
          await page.addInitScript(() => {
            (
              window as unknown as { __name?: (target: unknown) => unknown }
            ).__name = (target: unknown) => target;
          });

          await page.goto(input.handoffUrl, {
            waitUntil: "domcontentloaded",
            timeout: input.timeoutMs,
          });

          await page
            .waitForLoadState("networkidle", { timeout: input.timeoutMs })
            .catch(() => {
              // Best-effort if page continues background activity.
            });

          if (input.settleMs > 0) {
            await page.waitForTimeout(input.settleMs);
          }

          const html = await page.content();
          const adapterTotal =
            input.adapterKey === "realjoy30a"
              ? parseRealjoyRenderedTotal(html)
              : null;
          const total = adapterTotal ?? parseGenericRenderedTotal(html);

          if (total === null) {
            throw new Error("rendered total not found");
          }

          return total;
        } finally {
          await browser.close();
        }
      }),
    {
      retryDelaysMs: input.retryDelaysMs,
      label: "handoff_render",
      onRetry: input.onRetry,
    },
  ).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("rendered total not found")) {
      return null;
    }
    throw error;
  });
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
    const raw = await readFile(resolve(quotesDir, fileName), "utf8");
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
    `Running handoff render sample adapter=${options.adapterKey} observations=${candidates.length} tolerance=${options.tolerance.toFixed(2)} concurrency=${options.concurrency} min_gap_ms=${options.minGapMs}`,
  );

  const paced = createPacedGate({
    concurrency: options.concurrency,
    minGapMs: options.minGapMs,
  });
  const perf = createPerfTracker();

  let failures = 0;
  const results = await runWithConcurrency(
    candidates,
    options.concurrency,
    async (candidate) => {
      const renderedTotal = await extractRenderedTotal({
        adapterKey: options.adapterKey,
        handoffUrl: candidate.handoffUrl,
        timeoutMs: options.timeoutMs,
        settleMs: options.settleMs,
        retryDelaysMs: options.retryDelaysMs,
        paced,
        onRetry: (message) => {
          progress.tick(
            `listing=${candidate.listingId} window=${candidate.startDate}->${candidate.endDate} ${message}`,
          );
        },
      });

      const snapshot = perf.markDone();
      const diff =
        renderedTotal === null
          ? null
          : Math.abs(renderedTotal - candidate.observedGrandTotal);
      const outcome =
        renderedTotal === null
          ? "total_not_found"
          : diff !== null && diff <= options.tolerance
            ? "match"
            : "mismatch";

      return { candidate, renderedTotal, diff, outcome, snapshot };
    },
  );

  for (const result of results) {
    const { candidate, renderedTotal, diff, outcome, snapshot } = result;

    if (renderedTotal === null) {
      failures += 1;
      progress.failure(
        `listing=${candidate.listingId} window=${candidate.startDate}->${candidate.endDate} rendered_total=n/a observed=${candidate.observedGrandTotal.toFixed(2)} code=total_not_found elapsed_s=${snapshot.elapsedSeconds.toFixed(1)}`,
      );
      continue;
    }

    progress.progress(
      `${snapshot.completed}/${candidates.length} listing=${candidate.listingId} window=${candidate.startDate}->${candidate.endDate} observed=${candidate.observedGrandTotal.toFixed(2)} rendered=${renderedTotal.toFixed(2)} diff=${(diff ?? 0).toFixed(2)} outcome=${outcome} elapsed_s=${snapshot.elapsedSeconds.toFixed(1)} throughput_per_min=${snapshot.throughputPerMinute.toFixed(2)}`,
    );

    if (diff !== null && diff > options.tolerance) {
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
