import "@/core/tooling/env/load-env-profile";

import {
  createScrapeProgress,
  formatModeProgressLine,
} from "@/core/tooling/terminal/scrape-progress";
import {
  processPendingListingAiEnrichment,
  type PendingEnrichmentProgressEvent,
} from "@/lib/listings/enrichment/listing-ai-enrichment-service";

type Options = {
  limit: number;
  concurrency: number;
  progressEvery: number;
  adapterKey: string | null;
  listingId: string | null;
  model: string | null;
  dryRun: boolean;
};

function printUsage(): void {
  console.log("Run AI Enrichment For Pending Listings");
  console.log("Usage:");
  console.log(
    "  tsx src/lib/scripts/run-ai-enrichment-pending.ts [--limit 10] [--concurrency 2] [--adapter-key <key>] [--listing-id <id>] [--model <name>] [--dry-run]",
  );
  console.log("");
  console.log("Options:");
  console.log(
    "  --limit <n>          Max pending rows to process (default 10)",
  );
  console.log(
    "  --concurrency <n>    Concurrent enrichment workers (default 2)",
  );
  console.log(
    "  --progress-every <n> Emit progress line every n processed rows (default 1)",
  );
  console.log("  --adapter-key <key>  Restrict to one adapter");
  console.log("  --listing-id <id>    Restrict to one listing id");
  console.log("  --model <name>       Override generation model");
  console.log("  --dry-run            Do not persist enrichment output");
  console.log("  --help               Show help");
}

function parseArgs(argv: string[]): Options {
  let limit = 10;
  let concurrency = 2;
  let progressEvery = 1;
  let adapterKey: string | null = null;
  let listingId: string | null = null;
  let model: string | null = null;
  let dryRun = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (arg === "--limit" && next) {
      const parsed = Number(next);
      if (Number.isFinite(parsed) && parsed > 0) {
        limit = Math.floor(parsed);
      }
      i += 1;
      continue;
    }

    if (arg === "--concurrency" && next) {
      const parsed = Number(next);
      if (Number.isFinite(parsed) && parsed > 0) {
        concurrency = Math.floor(parsed);
      }
      i += 1;
      continue;
    }

    if (arg === "--progress-every" && next) {
      const parsed = Number(next);
      if (Number.isFinite(parsed) && parsed > 0) {
        progressEvery = Math.floor(parsed);
      }
      i += 1;
      continue;
    }

    if (arg === "--adapter-key" && next) {
      adapterKey = next.trim().toLowerCase() || null;
      i += 1;
      continue;
    }

    if (arg === "--listing-id" && next) {
      listingId = next.trim() || null;
      i += 1;
      continue;
    }

    if (arg === "--model" && next) {
      model = next.trim() || null;
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    limit,
    concurrency,
    progressEvery,
    adapterKey,
    listingId,
    model,
    dryRun,
  };
}

function renderEnrichmentProgress(
  event: PendingEnrichmentProgressEvent,
): string {
  const base = formatModeProgressLine({
    mode: "enrichment",
    completed: event.processed,
    total: event.selected,
    startedAtMs: event.started_at_ms,
    text:
      `processed=${event.processed}/${event.selected} completed=${event.completed} failed=${event.failed} ` +
      `skipped_missing_snapshot=${event.skipped_missing_snapshot}`,
  });

  const listingSuffix = event.listing_id
    ? ` listing_id=${event.listing_id}`
    : "";
  const modelSuffix = event.model ? ` model=${event.model}` : "";
  const messageSuffix = event.message ? ` message=${event.message}` : "";

  return `${base}${listingSuffix}${modelSuffix}${messageSuffix}`;
}

async function run(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const progress = createScrapeProgress({ script: "ai-enrichment" });
  const startedAtMs = Date.now();

  progress.phase(
    `starting pending enrichment limit=${options.limit} concurrency=${options.concurrency} progress_every=${options.progressEvery} dry_run=${options.dryRun} adapter_key=${options.adapterKey ?? "all"} listing_id=${options.listingId ?? "all"} model=${options.model ?? "default"}`,
  );

  const summary = await processPendingListingAiEnrichment({
    limit: options.limit,
    concurrency: options.concurrency,
    model: options.model ?? undefined,
    adapterKey: options.adapterKey ?? undefined,
    listingId: options.listingId ?? undefined,
    dryRun: options.dryRun,
    progressEvery: options.progressEvery,
    onProgress: (event) => {
      if (event.outcome === "start") {
        progress.info(
          `selected=${event.selected} concurrency=${options.concurrency} dry_run=${event.dry_run}`,
        );
        return;
      }

      if (event.outcome === "end") {
        return;
      }

      const line = renderEnrichmentProgress(event);
      if (event.outcome === "failed") {
        progress.failure(line);
        return;
      }
      if (event.outcome === "skipped_missing_snapshot") {
        progress.warn(line);
        return;
      }
      progress.progress(line);
    },
  });

  const elapsedMs = Math.max(1, Date.now() - startedAtMs);
  const throughputPerMinute =
    summary.processed > 0
      ? ((summary.processed / elapsedMs) * 60_000).toFixed(2)
      : "0.00";

  if (summary.failed > 0) {
    progress.failure(
      `pending enrichment complete with failures selected=${summary.selected} processed=${summary.processed} completed=${summary.completed} failed=${summary.failed} skipped_missing_snapshot=${summary.skipped_missing_snapshot} throughput_per_min=${throughputPerMinute}`,
    );
  } else {
    progress.success(
      `pending enrichment complete selected=${summary.selected} processed=${summary.processed} completed=${summary.completed} failed=0 skipped_missing_snapshot=${summary.skipped_missing_snapshot} throughput_per_min=${throughputPerMinute}`,
    );
  }

  console.log("listing_ai_enrichment_pending_complete");
  console.log(`- selected: ${summary.selected}`);
  console.log(`- processed: ${summary.processed}`);
  console.log(`- completed: ${summary.completed}`);
  console.log(`- failed: ${summary.failed}`);
  console.log(
    `- skipped_missing_snapshot: ${summary.skipped_missing_snapshot}`,
  );
  console.log(`- dry_run: ${summary.dry_run}`);

  return summary.failed > 0 ? 1 : 0;
}

run()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`run-ai-enrichment-pending failed: ${message}`);
    process.exit(1);
  });
