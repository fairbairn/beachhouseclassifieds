import {
  getKnownQuoteRuntimeAdapterKeys,
  getQuoteRuntimeExecutor,
} from "@/lib/pricing/quote-runtime/registry";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

type CliOptions = {
  adapters: string[];
  sampleListings: number;
  repeats: number;
  minAvailableObservations: number;
  adults: number;
  children: number;
  includeBookingFetch: boolean;
  continueOnError: boolean;
  summaryOnly: boolean;
};

type QuoteObservation = {
  quote_available?: boolean;
  start_date?: string;
  end_date?: string;
  handoff_url?: string;
  sampled_at?: string;
};

type QuotesSidecar = {
  external_listing_id?: string;
  detail_url?: string;
  endpoint_path?: string;
  observations?: QuoteObservation[];
};

type DetailRecordForLatency = {
  quote_context?: Record<string, unknown>;
  property_profile?: {
    unit_id?: string;
  };
};

type ListingSample = {
  adapterKey: string;
  listingId: string;
  quoteContext: Record<string, unknown> | null;
  startDate: string;
  endDate: string;
  handoffUrl: string;
  availableObservations: number;
  fallbackWindows: Array<{
    startDate: string;
    endDate: string;
    handoffUrl: string;
  }>;
};

type RequestResult = {
  adapterKey: string;
  listingId: string;
  elapsedMs: number;
  bookingElapsedMs: number | null;
  success: boolean;
  reason: string | null;
  runtimeError: {
    code: string;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  } | null;
  observationSample: {
    startDate: string;
    endDate: string;
    quoteAvailable: boolean;
    currency: string | null;
    baseTotal: number | null;
    taxesTotal: number | null;
    feesTotalExclTaxes: number | null;
    grandTotal: number | null;
    quotedTotal: number | null;
    handoffUrl: string | null;
  };
};

type AdapterRunResult = {
  adapterKey: string;
  sampleListings: number;
  requestsTotal: number;
  successful: number;
  failed: number;
  avgMs: number | null;
  medianMs: number | null;
  p95Ms: number | null;
  bookingAvgMs: number | null;
  bookingP95Ms: number | null;
  perListing: Array<{
    listingId: string;
    availableObservations: number;
    successCount: number;
    totalCount: number;
    avgMs: number | null;
    medianMs: number | null;
    p95Ms: number | null;
  }>;
  failureReason: string | null;
};

const DEFAULT_ADAPTERS: string[] = [];
const DEFAULT_SAMPLE_LISTINGS = 5;
const DEFAULT_REPEATS = 2;
const DEFAULT_MIN_AVAILABLE_OBSERVATIONS = 2;
const DEFAULT_ADULTS = 2;
const DEFAULT_CHILDREN = 0;
const MAX_FALLBACK_WINDOWS_PER_LISTING = 12;
const DEFAULT_SINGLE_OBSERVATION_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.SCRAPER_ADHOC_SINGLE_OBSERVATION_TIMEOUT_MS ?? "20000") ||
    20000,
);
const BASE_DATA_ROOT = resolve(
  process.cwd(),
  "src",
  "lib",
  "data",
  "external-sources",
);

const COLOR = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
};

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ANSI_ESCAPE_REGEX = new RegExp(
  `${String.fromCharCode(27)}\\[[0-9;]*m`,
  "g",
);

function paint(text: string, color: string): string {
  return `${color}${text}${COLOR.reset}`;
}

function fmtMs(value: number | null): string {
  return value === null ? "n/a" : `${value.toFixed(1)} ms`;
}

function fmtMsCompact(value: number | null): string {
  return value === null ? "n/a" : `${value.toFixed(1)}ms`;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1]! + sorted[middle]!) / 2;
  }
  return sorted[middle]!;
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[index]!;
}

function parseAdaptersArg(value: string): string[] {
  if (!value || value.trim().toLowerCase() === "all") {
    return ["all"];
  }
  return value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function parseArgs(argv: string[]): CliOptions {
  let adapters = [...DEFAULT_ADAPTERS];
  let sampleListings = DEFAULT_SAMPLE_LISTINGS;
  let repeats = DEFAULT_REPEATS;
  let minAvailableObservations = DEFAULT_MIN_AVAILABLE_OBSERVATIONS;
  let adults = DEFAULT_ADULTS;
  let children = DEFAULT_CHILDREN;
  let includeBookingFetch = false;
  let continueOnError = true;
  let summaryOnly = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    if (arg === "--adapters" && value) {
      adapters = parseAdaptersArg(value);
      index += 1;
      continue;
    }

    if (arg === "--adapter-key" && value) {
      adapters = [value.trim().toLowerCase()];
      index += 1;
      continue;
    }

    if (arg === "--sample-listings" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        sampleListings = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--repeats" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0 && parsed <= 20) {
        repeats = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--min-available-observations" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        minAvailableObservations = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--adults" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        adults = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--children" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed >= 0) {
        children = Math.floor(parsed);
      }
      index += 1;
      continue;
    }

    if (arg === "--include-booking-fetch") {
      includeBookingFetch = true;
      continue;
    }

    if (arg === "--no-continue-on-error") {
      continueOnError = false;
      continue;
    }

    if (arg === "--summary-only") {
      summaryOnly = true;
      continue;
    }
  }

  return {
    adapters,
    sampleListings,
    repeats,
    minAvailableObservations,
    adults,
    children,
    includeBookingFetch,
    continueOnError,
    summaryOnly,
  };
}

function pad(value: string, width: number): string {
  const visibleLength = measureDisplayWidth(value);
  if (visibleLength >= width) {
    return value;
  }
  return `${value}${" ".repeat(width - visibleLength)}`;
}

function padLeft(value: string, width: number): string {
  const visibleLength = measureDisplayWidth(value);
  if (visibleLength >= width) {
    return value;
  }
  return `${" ".repeat(width - visibleLength)}${value}`;
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_REGEX, "");
}

function measureDisplayWidth(value: string): number {
  return stripAnsi(value).length;
}

function renderTable(
  headers: string[],
  rows: string[][],
  alignments?: Array<"left" | "right">,
): string {
  const widths = headers.map((header, index) => {
    const rowMax = rows.reduce((max, row) => {
      const value = row[index] ?? "";
      return Math.max(max, measureDisplayWidth(value));
    }, 0);
    return Math.max(measureDisplayWidth(header), rowMax);
  });

  const padFor = (value: string, index: number): string => {
    const alignment = alignments?.[index] ?? "left";
    return alignment === "right"
      ? padLeft(value, widths[index]!)
      : pad(value, widths[index]!);
  };

  const headerLine = headers
    .map((header, index) => padFor(header, index))
    .join(" | ");
  const divider = widths.map((width) => "-".repeat(width)).join("-+-");
  const body = rows
    .map((row) => row.map((value, index) => padFor(value, index)).join(" | "))
    .join("\n");

  return [headerLine, divider, body].filter(Boolean).join("\n");
}

function renderProgressBar(input: {
  completed: number;
  total: number;
  ok: number;
  fail: number;
  adapterKey: string;
  phase: "run";
}): string {
  const safeTotal = Math.max(1, input.total);
  const ratio = Math.min(1, input.completed / safeTotal);
  const width = 24;
  const filled = Math.round(ratio * width);
  const empty = Math.max(0, width - filled);
  const frame = SPINNER_FRAMES[input.completed % SPINNER_FRAMES.length] ?? "•";
  const bar = `${"█".repeat(filled)}${"░".repeat(empty)}`;
  const phaseLabel = "quotes";

  return [
    paint(frame, COLOR.cyan),
    paint(input.adapterKey, COLOR.cyan),
    paint(phaseLabel, COLOR.dim),
    `[${bar}]`,
    `${input.completed}/${safeTotal}`,
    `${paint("ok", COLOR.green)}:${input.ok}`,
    `${paint("fail", COLOR.red)}:${input.fail}`,
  ].join(" ");
}

function writeProgressLine(message: string): void {
  process.stdout.write(`\r\x1b[2K${message}`);
}

function clearProgressLine(): void {
  process.stdout.write("\n");
}

async function listAdaptersWithQuotes(): Promise<string[]> {
  const entries = await readdir(BASE_DATA_ROOT, { withFileTypes: true });
  const adapters = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const withQuotes: string[] = [];
  for (const adapterKey of adapters) {
    const quotesDir = resolve(BASE_DATA_ROOT, adapterKey, "details", "quotes");
    try {
      const quoteEntries = await readdir(quotesDir, { withFileTypes: true });
      const hasQuoteFiles = quoteEntries.some(
        (entry) =>
          entry.isFile() &&
          entry.name.endsWith(".json") &&
          entry.name !== "index.json",
      );
      if (hasQuoteFiles) {
        withQuotes.push(adapterKey);
      }
    } catch {
      // Ignore missing quote directories.
    }
  }

  return withQuotes;
}

async function collectListingSamplesForAdapter(
  adapterKey: string,
  options: CliOptions,
): Promise<ListingSample[]> {
  const quotesDir = resolve(BASE_DATA_ROOT, adapterKey, "details", "quotes");
  const detailsJsonDir = resolve(BASE_DATA_ROOT, adapterKey, "details", "json");
  const quoteEntries = await readdir(quotesDir, { withFileTypes: true });
  const quoteFiles = quoteEntries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".json") &&
        entry.name !== "index.json",
    )
    .map((entry) => entry.name)
    .sort();

  const candidates: ListingSample[] = [];

  for (const fileName of quoteFiles) {
    const sidecarPath = resolve(quotesDir, fileName);
    const sidecarRaw = await readFile(sidecarPath, "utf8");
    const sidecar = JSON.parse(sidecarRaw) as QuotesSidecar;

    const listingId = sidecar.external_listing_id?.trim() ?? "";
    const detailUrl = sidecar.detail_url?.trim() ?? "";
    const observations = sidecar.observations ?? [];

    if (!listingId || !detailUrl) {
      continue;
    }

    const availableObservations = observations.filter(
      (observation) => observation.quote_available === true,
    );

    if (availableObservations.length < options.minAvailableObservations) {
      continue;
    }

    const validAvailableObservations = availableObservations.filter(
      (observation) =>
        typeof observation.start_date === "string" &&
        typeof observation.end_date === "string" &&
        typeof observation.handoff_url === "string",
    );

    if (validAvailableObservations.length === 0) {
      continue;
    }

    const fallbackWindows = [...validAvailableObservations]
      .sort((left, right) => {
        const leftKey = `${left.start_date ?? ""}|${left.end_date ?? ""}|${left.handoff_url ?? ""}`;
        const rightKey = `${right.start_date ?? ""}|${right.end_date ?? ""}|${right.handoff_url ?? ""}`;
        return rightKey.localeCompare(leftKey);
      })
      .slice(0, MAX_FALLBACK_WINDOWS_PER_LISTING)
      .map((observation) => ({
        startDate: observation.start_date!,
        endDate: observation.end_date!,
        handoffUrl: observation.handoff_url!,
      }));

    const selectedObservation = fallbackWindows[0];
    if (!selectedObservation) {
      continue;
    }

    let quoteContext: Record<string, unknown> | null = null;
    const detailPath = resolve(detailsJsonDir, `${listingId}.json`);
    try {
      const detailRaw = await readFile(detailPath, "utf8");
      const detail = JSON.parse(detailRaw) as DetailRecordForLatency;
      if (
        detail.quote_context &&
        typeof detail.quote_context === "object" &&
        !Array.isArray(detail.quote_context)
      ) {
        quoteContext = detail.quote_context;
      } else if (adapterKey === "360blue") {
        const unitId = detail.property_profile?.unit_id?.trim() ?? "";
        if (unitId) {
          quoteContext = {
            unit_id: unitId,
            endpoint_path: sidecar.endpoint_path ?? null,
          };
        }
      }
    } catch {
      // Detail JSON may be missing or malformed for older captures.
    }

    candidates.push({
      adapterKey,
      listingId,
      quoteContext,
      startDate: selectedObservation.startDate,
      endDate: selectedObservation.endDate,
      handoffUrl: selectedObservation.handoffUrl,
      availableObservations: availableObservations.length,
      fallbackWindows,
    });
  }

  candidates.sort((left, right) => {
    if (right.availableObservations !== left.availableObservations) {
      return right.availableObservations - left.availableObservations;
    }
    return left.listingId.localeCompare(right.listingId);
  });

  return candidates.slice(0, options.sampleListings);
}

async function runSingleQuoteRequestOnce(
  sample: ListingSample,
  options: CliOptions,
): Promise<RequestResult> {
  const runtimeExecutor = getQuoteRuntimeExecutor(sample.adapterKey);
  if (runtimeExecutor) {
    const startedAt = performance.now();
    try {
      const result = await runtimeExecutor({
        listingId: sample.listingId,
        checkInIso: sample.startDate,
        checkOutIso: sample.endDate,
        adults: options.adults,
        children: options.children,
        quoteContext: sample.quoteContext ?? null,
        options: {
          timeoutMs: DEFAULT_SINGLE_OBSERVATION_TIMEOUT_MS,
        },
      });

      if (!result.success) {
        return {
          adapterKey: sample.adapterKey,
          listingId: sample.listingId,
          elapsedMs: result.elapsedMs,
          bookingElapsedMs: null,
          success: false,
          reason: `${result.error.code}: ${result.error.message}`,
          runtimeError: result.error,
          observationSample: {
            startDate: sample.startDate,
            endDate: sample.endDate,
            quoteAvailable: false,
            currency: null,
            baseTotal: null,
            taxesTotal: null,
            feesTotalExclTaxes: null,
            grandTotal: null,
            quotedTotal: null,
            handoffUrl: sample.handoffUrl,
          },
        };
      }

      return {
        adapterKey: sample.adapterKey,
        listingId: sample.listingId,
        elapsedMs: result.elapsedMs,
        bookingElapsedMs: null,
        success: true,
        reason: null,
        runtimeError: null,
        observationSample: {
          startDate: result.observation.startDate,
          endDate: result.observation.endDate,
          quoteAvailable: result.observation.quoteAvailable,
          currency: result.observation.currency,
          baseTotal: result.observation.baseTotal,
          taxesTotal: result.observation.taxesTotal,
          feesTotalExclTaxes: result.observation.feesTotalExclTaxes,
          grandTotal: result.observation.grandTotal,
          quotedTotal: result.observation.quotedTotal,
          handoffUrl: result.observation.handoffUrl,
        },
      };
    } catch (error: unknown) {
      return {
        adapterKey: sample.adapterKey,
        listingId: sample.listingId,
        elapsedMs: performance.now() - startedAt,
        bookingElapsedMs: null,
        success: false,
        reason: error instanceof Error ? error.message : "single_quote_failed",
        runtimeError: {
          code: "RUNTIME_EXCEPTION",
          message:
            error instanceof Error ? error.message : "single_quote_failed",
          retryable: false,
        },
        observationSample: {
          startDate: sample.startDate,
          endDate: sample.endDate,
          quoteAvailable: false,
          currency: null,
          baseTotal: null,
          taxesTotal: null,
          feesTotalExclTaxes: null,
          grandTotal: null,
          quotedTotal: null,
          handoffUrl: sample.handoffUrl,
        },
      };
    }
  }

  return {
    adapterKey: sample.adapterKey,
    listingId: sample.listingId,
    elapsedMs: 0,
    bookingElapsedMs: null,
    success: false,
    reason: `quote_runtime_not_implemented:${sample.adapterKey}`,
    runtimeError: {
      code: "RUNTIME_NOT_IMPLEMENTED",
      message: `quote_runtime_not_implemented:${sample.adapterKey}`,
      retryable: false,
    },
    observationSample: {
      startDate: sample.startDate,
      endDate: sample.endDate,
      quoteAvailable: false,
      currency: null,
      baseTotal: null,
      taxesTotal: null,
      feesTotalExclTaxes: null,
      grandTotal: null,
      quotedTotal: null,
      handoffUrl: sample.handoffUrl,
    },
  };
}

async function runSingleQuoteRequestOnceWithTimeout(
  sample: ListingSample,
  options: CliOptions,
): Promise<RequestResult> {
  const timeoutMs = DEFAULT_SINGLE_OBSERVATION_TIMEOUT_MS;
  return new Promise((resolve) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({
        adapterKey: sample.adapterKey,
        listingId: sample.listingId,
        elapsedMs: timeoutMs,
        bookingElapsedMs: null,
        success: false,
        reason: `timeout_${timeoutMs}ms`,
        runtimeError: {
          code: "RUNNER_TIMEOUT",
          message: `timeout_${timeoutMs}ms`,
          retryable: true,
        },
        observationSample: {
          startDate: sample.startDate,
          endDate: sample.endDate,
          quoteAvailable: false,
          currency: null,
          baseTotal: null,
          taxesTotal: null,
          feesTotalExclTaxes: null,
          grandTotal: null,
          quotedTotal: null,
          handoffUrl: sample.handoffUrl,
        },
      });
    }, timeoutMs);

    runSingleQuoteRequestOnce(sample, options)
      .then((result) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve({
          adapterKey: sample.adapterKey,
          listingId: sample.listingId,
          elapsedMs: 0,
          bookingElapsedMs: null,
          success: false,
          reason:
            error instanceof Error ? error.message : "single_quote_failed",
          runtimeError: {
            code: "RUNNER_EXCEPTION",
            message:
              error instanceof Error ? error.message : "single_quote_failed",
            retryable: false,
          },
          observationSample: {
            startDate: sample.startDate,
            endDate: sample.endDate,
            quoteAvailable: false,
            currency: null,
            baseTotal: null,
            taxesTotal: null,
            feesTotalExclTaxes: null,
            grandTotal: null,
            quotedTotal: null,
            handoffUrl: sample.handoffUrl,
          },
        });
      });
  });
}

async function runSingleQuoteRequest(
  sample: ListingSample,
  options: CliOptions,
): Promise<RequestResult> {
  const windows =
    sample.fallbackWindows.length > 0
      ? sample.fallbackWindows
      : [
          {
            startDate: sample.startDate,
            endDate: sample.endDate,
            handoffUrl: sample.handoffUrl,
          },
        ];

  let lastFailure: RequestResult | null = null;
  for (const window of windows) {
    const windowSample: ListingSample = {
      ...sample,
      startDate: window.startDate,
      endDate: window.endDate,
      handoffUrl: window.handoffUrl,
      fallbackWindows: [],
    };

    const result = await runSingleQuoteRequestOnceWithTimeout(
      windowSample,
      options,
    );
    if (result.success) {
      return result;
    }
    lastFailure = result;
  }

  if (lastFailure) {
    return {
      ...lastFailure,
      reason: `all_windows_failed: ${lastFailure.reason ?? "quote_unavailable"}`,
    };
  }

  return {
    adapterKey: sample.adapterKey,
    listingId: sample.listingId,
    elapsedMs: 0,
    bookingElapsedMs: null,
    success: false,
    reason: "all_windows_failed: no_valid_windows",
    runtimeError: {
      code: "NO_VALID_WINDOWS",
      message: "all_windows_failed: no_valid_windows",
      retryable: false,
    },
    observationSample: {
      startDate: sample.startDate,
      endDate: sample.endDate,
      quoteAvailable: false,
      currency: null,
      baseTotal: null,
      taxesTotal: null,
      feesTotalExclTaxes: null,
      grandTotal: null,
      quotedTotal: null,
      handoffUrl: sample.handoffUrl,
    },
  };
}

async function runForAdapter(
  adapterKey: string,
  options: CliOptions,
): Promise<AdapterRunResult> {
  let candidates: ListingSample[] = [];
  try {
    candidates = await collectListingSamplesForAdapter(adapterKey, options);
  } catch (error: unknown) {
    return {
      adapterKey,
      sampleListings: 0,
      requestsTotal: 0,
      successful: 0,
      failed: 0,
      avgMs: null,
      medianMs: null,
      p95Ms: null,
      bookingAvgMs: null,
      bookingP95Ms: null,
      perListing: [],
      failureReason: error instanceof Error ? error.message : String(error),
    };
  }

  if (candidates.length === 0) {
    return {
      adapterKey,
      sampleListings: 0,
      requestsTotal: 0,
      successful: 0,
      failed: 0,
      avgMs: null,
      medianMs: null,
      p95Ms: null,
      bookingAvgMs: null,
      bookingP95Ms: null,
      perListing: [],
      failureReason:
        "No listing samples met minimum quote_available observation threshold.",
    };
  }

  const samples = candidates;

  if (samples.length === 0) {
    return {
      adapterKey,
      sampleListings: 0,
      requestsTotal: 0,
      successful: 0,
      failed: 0,
      avgMs: null,
      medianMs: null,
      p95Ms: null,
      bookingAvgMs: null,
      bookingP95Ms: null,
      perListing: [],
      failureReason:
        "No listing samples met minimum quote_available observation threshold.",
    };
  }

  if (!options.summaryOnly) {
    console.log(
      paint(
        `\nAdapter ${adapterKey}: selected ${samples.length} listings (min available observations: ${options.minAvailableObservations})`,
        COLOR.cyan,
      ),
    );

    const selectedRows = samples.map((sample) => ({
      listingId: sample.listingId,
      availableObservations: sample.availableObservations,
      startDate: sample.startDate,
      endDate: sample.endDate,
    }));
    console.log(
      renderTable(
        ["Listing", "Avail Obs", "Start", "End"],
        selectedRows.map((row) => [
          row.listingId,
          String(row.availableObservations),
          row.startDate,
          row.endDate,
        ]),
      ),
    );
  }

  const results: RequestResult[] = [];
  const totalRequests = samples.length * options.repeats;
  let completed = 0;
  let okCount = 0;
  let failCount = 0;

  for (let run = 0; run < options.repeats; run += 1) {
    for (const sample of samples) {
      const result = await runSingleQuoteRequest(sample, options);
      results.push(result);
      completed += 1;
      if (result.success) {
        okCount += 1;
      } else {
        failCount += 1;
      }

      writeProgressLine(
        `${renderProgressBar({
          completed,
          total: totalRequests,
          ok: okCount,
          fail: failCount,
          adapterKey,
          phase: "run",
        })} ${paint(sample.listingId, COLOR.dim)} ${fmtMsCompact(result.elapsedMs)}${
          result.reason && !result.success
            ? ` ${paint(result.reason, COLOR.red)}`
            : ""
        }`,
      );
    }
  }
  clearProgressLine();

  const successful = results.filter((item) => item.success);
  const failed = results.length - successful.length;

  if (successful.length === 0) {
    return {
      adapterKey,
      sampleListings: samples.length,
      requestsTotal: results.length,
      successful: 0,
      failed,
      avgMs: null,
      medianMs: null,
      p95Ms: null,
      bookingAvgMs: null,
      bookingP95Ms: null,
      perListing: [],
      failureReason: "No successful quote responses captured.",
    };
  }

  const quoteLatencies = successful.map((item) => item.elapsedMs);
  const bookingLatencies = successful
    .map((item) => item.bookingElapsedMs)
    .filter((value): value is number => value !== null);

  const perListingMap = new Map<
    string,
    {
      availableObservations: number;
      totalCount: number;
      successfulLatencies: number[];
    }
  >();

  for (const sample of samples) {
    perListingMap.set(sample.listingId, {
      availableObservations: sample.availableObservations,
      totalCount: 0,
      successfulLatencies: [],
    });
  }

  for (const result of results) {
    const current = perListingMap.get(result.listingId);
    if (!current) {
      continue;
    }
    current.totalCount += 1;
    if (result.success) {
      current.successfulLatencies.push(result.elapsedMs);
    }
  }

  const perListing = Array.from(perListingMap.entries())
    .map(([listingId, stats]) => ({
      listingId,
      availableObservations: stats.availableObservations,
      successCount: stats.successfulLatencies.length,
      totalCount: stats.totalCount,
      avgMs:
        stats.successfulLatencies.length > 0
          ? mean(stats.successfulLatencies)
          : null,
      medianMs:
        stats.successfulLatencies.length > 0
          ? median(stats.successfulLatencies)
          : null,
      p95Ms:
        stats.successfulLatencies.length > 0
          ? percentile(stats.successfulLatencies, 95)
          : null,
    }))
    .sort((left, right) => {
      const leftAvg = left.avgMs ?? -1;
      const rightAvg = right.avgMs ?? -1;
      return rightAvg - leftAvg;
    });

  return {
    adapterKey,
    sampleListings: samples.length,
    requestsTotal: results.length,
    successful: successful.length,
    failed,
    avgMs: mean(quoteLatencies),
    medianMs: median(quoteLatencies),
    p95Ms: percentile(quoteLatencies, 95),
    bookingAvgMs: bookingLatencies.length ? mean(bookingLatencies) : null,
    bookingP95Ms: bookingLatencies.length
      ? percentile(bookingLatencies, 95)
      : null,
    perListing,
    failureReason: null,
  };
}

async function resolveAdapters(options: CliOptions): Promise<string[]> {
  if (options.adapters.length === 1 && options.adapters[0] === "all") {
    const quoteRuntimeAdapters = getKnownQuoteRuntimeAdapterKeys();
    const adaptersWithQuotes = new Set(await listAdaptersWithQuotes());
    return quoteRuntimeAdapters.filter((adapterKey) =>
      adaptersWithQuotes.has(adapterKey),
    );
  }
  return options.adapters;
}

function printAdapterSummaryTable(results: AdapterRunResult[]): void {
  const colorizedHeaders = [
    paint("Adapter", COLOR.cyan),
    paint("Status", COLOR.cyan),
    paint("Listings", COLOR.cyan),
    paint("Success", COLOR.cyan),
    paint("Avg", COLOR.cyan),
    paint("Median", COLOR.cyan),
    paint("P95", COLOR.cyan),
  ];

  const sortedResults = [...results].sort((left, right) => {
    if (left.avgMs === null && right.avgMs === null) {
      return left.adapterKey.localeCompare(right.adapterKey);
    }
    if (left.avgMs === null) {
      return 1;
    }
    if (right.avgMs === null) {
      return -1;
    }
    if (left.avgMs !== right.avgMs) {
      return left.avgMs - right.avgMs;
    }
    return left.adapterKey.localeCompare(right.adapterKey);
  });

  const rows = sortedResults.map((result) => {
    const status =
      result.failureReason !== null
        ? paint("✗", COLOR.red)
        : result.failed > 0
          ? paint("!", COLOR.yellow)
          : paint("✓", COLOR.green);
    const successText = `${result.successful}/${result.requestsTotal}`;
    const successColor =
      result.failureReason !== null
        ? COLOR.red
        : result.failed > 0
          ? COLOR.yellow
          : COLOR.green;

    return [
      paint(result.adapterKey, COLOR.blue),
      status,
      String(result.sampleListings),
      paint(successText, successColor),
      fmtMs(result.avgMs),
      fmtMs(result.medianMs),
      fmtMs(result.p95Ms),
    ];
  });

  console.log(`\n${paint("Run Summary (Per Adapter)", COLOR.bold)}`);
  console.log(
    renderTable(colorizedHeaders, rows, [
      "left",
      "left",
      "right",
      "right",
      "right",
      "right",
      "right",
    ]),
  );
}

function printPerAdapterListingLatencyTable(result: AdapterRunResult): void {
  if (result.perListing.length === 0) {
    return;
  }

  const colorizedHeaders = [
    paint("Listing", COLOR.cyan),
    paint("Avail Obs", COLOR.cyan),
    paint("Success", COLOR.cyan),
    paint("Avg", COLOR.cyan),
    paint("Median", COLOR.cyan),
    paint("P95", COLOR.cyan),
  ];

  const rows = result.perListing.map((item) => {
    const successText = `${item.successCount}/${item.totalCount}`;
    const successColor =
      item.successCount === item.totalCount
        ? COLOR.green
        : item.successCount > 0
          ? COLOR.yellow
          : COLOR.red;

    return [
      paint(item.listingId, COLOR.blue),
      String(item.availableObservations),
      paint(successText, successColor),
      fmtMs(item.avgMs),
      fmtMs(item.medianMs),
      fmtMs(item.p95Ms),
    ];
  });

  console.log(
    `\n${paint(`Per Listing Latency (${result.adapterKey})`, COLOR.bold)}`,
  );
  console.log(
    renderTable(colorizedHeaders, rows, [
      "left",
      "right",
      "right",
      "right",
      "right",
      "right",
    ]),
  );
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.adapters.length === 0) {
    throw new Error(
      "Missing required adapter selection. Pass --adapters <key[,key...]> or --adapters all.",
    );
  }
  const adapters = await resolveAdapters(options);

  if (adapters.length === 0) {
    throw new Error("No adapters selected.");
  }

  console.log(paint("Ad-hoc Single Quote Latency Analyzer", COLOR.bold));
  console.log(
    paint(
      `adapters=${adapters.join(",")} sample_listings=${options.sampleListings} repeats=${options.repeats} min_available_observations=${options.minAvailableObservations} include_booking_fetch=${options.includeBookingFetch} summary_only=${options.summaryOnly}`,
      COLOR.dim,
    ),
  );

  const results: AdapterRunResult[] = [];
  for (const adapterKey of adapters) {
    const result = await runForAdapter(adapterKey, options);
    results.push(result);

    if (result.failureReason) {
      console.log(
        paint(
          `Adapter ${adapterKey} failed: ${result.failureReason}`,
          COLOR.red,
        ),
      );
      if (!options.continueOnError) {
        break;
      }
    }
  }

  printAdapterSummaryTable(results);

  if (!options.summaryOnly) {
    for (const result of results) {
      printPerAdapterListingLatencyTable(result);
    }
  }

  const successfulAdapters = results.filter(
    (item) => item.failureReason === null,
  );
  const failedAdapters = results.length - successfulAdapters.length;

  console.log(`\n${paint("Overall", COLOR.bold)}`);
  console.log(`- adapters_total: ${results.length}`);
  console.log(
    `- adapters_successful: ${paint(String(successfulAdapters.length), COLOR.green)}`,
  );
  console.log(
    `- adapters_failed: ${failedAdapters > 0 ? paint(String(failedAdapters), COLOR.red) : String(failedAdapters)}`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(paint(`ad-hoc quote latency failed: ${message}`, COLOR.red));
  process.exitCode = 1;
});
