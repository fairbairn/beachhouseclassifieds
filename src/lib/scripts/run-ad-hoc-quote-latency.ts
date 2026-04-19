import {
  getKnownQuoteRuntimeAdapterKeys,
  getQuoteRuntimeExecutor,
} from "@/lib/pricing/quote-runtime/registry";
import { selectCanonicalListings } from "@/lib/pricing/shared/canonical-index-listings";
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
  singleListingId: string | null;
  singleStartDate: string | null;
  singleEndDate: string | null;
  randomSingle: boolean;
  includeBookingFetch: boolean;
  continueOnError: boolean;
  summaryOnly: boolean;
  jsonOutput: boolean;
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

type ListingSample = {
  adapterKey: string;
  listingId: string;
  detailUrl: string;
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

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function paint(text: string, color: string): string {
  return `${color}${text}${COLOR.reset}`;
}

function fmtMs(value: number | null): string {
  return value === null ? "n/a" : `${value.toFixed(1)} ms`;
}

function fmtMsCompact(value: number | null): string {
  return value === null ? "n/a" : `${value.toFixed(1)}ms`;
}

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

function fmtCurrency(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "n/a";
  }

  const normalized = Math.abs(value) < 0.005 ? 0 : roundCurrency(value);
  return normalized.toFixed(2);
}

function shellEscapeSingleQuotes(value: string): string {
  return value.replace(/'/g, `'"'"'`);
}

function parsePostStyleHandoffUrl(input: string): {
  endpoint: string;
  method: string;
  contentType: string;
  payloadRaw: string;
  payloadPretty: string;
  curlCommand: string;
} | null {
  try {
    const parsed = new URL(input);
    const hash = parsed.hash.startsWith("#")
      ? parsed.hash.slice(1)
      : parsed.hash;
    if (!hash) {
      return null;
    }

    const params = new URLSearchParams(hash);
    const method = (params.get("method") ?? "").trim().toUpperCase();
    const contentType = (params.get("contentType") ?? "").trim();
    const payloadRaw = params.get("payload") ?? "";

    if (method !== "POST" || !contentType || !payloadRaw) {
      return null;
    }

    let payloadPretty = payloadRaw;
    try {
      const parsedPayload = JSON.parse(payloadRaw) as unknown;
      payloadPretty = JSON.stringify(parsedPayload, null, 2);
    } catch {
      // Keep raw payload when not valid JSON.
    }

    const endpoint = `${parsed.origin}${parsed.pathname}${parsed.search}`;
    const curlCommand = `curl -X POST '${shellEscapeSingleQuotes(endpoint)}' -H 'content-type: ${shellEscapeSingleQuotes(contentType)}' --data '${shellEscapeSingleQuotes(payloadRaw)}'`;

    return {
      endpoint,
      method,
      contentType,
      payloadRaw,
      payloadPretty,
      curlCommand,
    };
  } catch {
    return null;
  }
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
  let singleListingId: string | null = null;
  let singleStartDate: string | null = null;
  let singleEndDate: string | null = null;
  let randomSingle = false;
  let includeBookingFetch = false;
  let continueOnError = true;
  let summaryOnly = false;
  let jsonOutput = false;

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

    if (arg === "--listing-id" && value) {
      singleListingId = value.trim();
      index += 1;
      continue;
    }

    if (arg === "--start-date" && value) {
      singleStartDate = value.trim();
      index += 1;
      continue;
    }

    if (arg === "--end-date" && value) {
      singleEndDate = value.trim();
      index += 1;
      continue;
    }

    if (arg === "--random-single") {
      randomSingle = true;
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

    if (arg === "--json") {
      jsonOutput = true;
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
    singleListingId,
    singleStartDate,
    singleEndDate,
    randomSingle,
    includeBookingFetch,
    continueOnError,
    summaryOnly,
    jsonOutput,
  };
}

function isIsoDate(value: string): boolean {
  if (!ISO_DATE_REGEX.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

function pickRandom<T>(items: T[]): T {
  const index = Math.floor(Math.random() * items.length);
  return items[index]!;
}

function readDetailUrlFromQuoteContext(
  quoteContext: Record<string, unknown> | null,
): string | null {
  if (!quoteContext) {
    return null;
  }

  const value = quoteContext.detail_url;
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function canonicalizeDetailUrlForAdapter(
  adapterKey: string,
  detailUrl: string,
): string {
  if (adapterKey !== "360blue") {
    return detailUrl;
  }

  try {
    const parsed = new URL(detailUrl);
    if (parsed.hostname.endsWith("callistavacations.com")) {
      parsed.hostname = "www.360blue.com";
      parsed.protocol = "https:";
    }
    return parsed.toString();
  } catch {
    return detailUrl;
  }
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
      const activeListings = await selectCanonicalListings({
        adapterKey,
        maxListings: null,
      });
      const quoteEntries = await readdir(quotesDir, { withFileTypes: true });
      const quoteFiles = new Set(
        quoteEntries
          .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
          .map((entry) => entry.name),
      );
      const hasQuoteFiles = activeListings.some((listing) =>
        quoteFiles.has(`${listing.externalListingId}.json`),
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
  maxSamplesOverride?: number | null,
): Promise<ListingSample[]> {
  const quotesDir = resolve(BASE_DATA_ROOT, adapterKey, "details", "quotes");
  const activeListings = await selectCanonicalListings({
    adapterKey,
    maxListings: null,
  });

  const candidates: ListingSample[] = [];

  for (const listing of activeListings) {
    const fileName = `${listing.externalListingId}.json`;
    const sidecarPath = resolve(quotesDir, fileName);
    let sidecar: QuotesSidecar;
    try {
      const sidecarRaw = await readFile(sidecarPath, "utf8");
      sidecar = JSON.parse(sidecarRaw) as QuotesSidecar;
    } catch {
      continue;
    }

    const listingId = sidecar.external_listing_id?.trim() ?? "";
    const detailUrlRaw = sidecar.detail_url?.trim() ?? "";
    const detailUrl = canonicalizeDetailUrlForAdapter(adapterKey, detailUrlRaw);
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

    const canonicalEntry = activeListings.find(
      (entry) => entry.externalListingId === listingId,
    );
    const quoteContext = canonicalEntry?.quoteContext ?? null;

    candidates.push({
      adapterKey,
      listingId,
      detailUrl,
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

  const maxSamples =
    maxSamplesOverride === undefined
      ? options.sampleListings
      : maxSamplesOverride;

  if (maxSamples === null) {
    return candidates;
  }

  return candidates.slice(0, maxSamples);
}

async function loadDetailQuoteContext(
  adapterKey: string,
  listingId: string,
): Promise<Record<string, unknown> | null> {
  const activeListings = await selectCanonicalListings({
    adapterKey,
    maxListings: null,
  });
  const listing = activeListings.find(
    (entry) => entry.externalListingId === listingId,
  );
  return listing?.quoteContext ?? null;
}

async function loadQuotesSidecar(
  adapterKey: string,
  listingId: string,
): Promise<QuotesSidecar | null> {
  const sidecarPath = resolve(
    BASE_DATA_ROOT,
    adapterKey,
    "details",
    "quotes",
    `${listingId}.json`,
  );

  try {
    const raw = await readFile(sidecarPath, "utf8");
    return JSON.parse(raw) as QuotesSidecar;
  } catch {
    return null;
  }
}

async function buildExplicitSingleSample(input: {
  adapterKey: string;
  listingId: string;
  startDate: string;
  endDate: string;
}): Promise<ListingSample> {
  const quoteContext = await loadDetailQuoteContext(
    input.adapterKey,
    input.listingId,
  );
  const sidecar = await loadQuotesSidecar(input.adapterKey, input.listingId);

  const observations = sidecar?.observations ?? [];
  const availableObservations = observations.filter(
    (observation) => observation.quote_available === true,
  );
  const matchingObservation = observations.find(
    (observation) =>
      observation.start_date === input.startDate &&
      observation.end_date === input.endDate &&
      typeof observation.handoff_url === "string",
  );

  return {
    adapterKey: input.adapterKey,
    listingId: input.listingId,
    detailUrl: canonicalizeDetailUrlForAdapter(
      input.adapterKey,
      sidecar?.detail_url?.trim() ||
        readDetailUrlFromQuoteContext(quoteContext) ||
        "n/a",
    ),
    quoteContext,
    startDate: input.startDate,
    endDate: input.endDate,
    handoffUrl: matchingObservation?.handoff_url ?? "",
    availableObservations: availableObservations.length,
    fallbackWindows: [],
  };
}

function printSingleQuoteReport(input: {
  adapterKey: string;
  sample: ListingSample;
  result: RequestResult;
  adults: number;
  children: number;
}): void {
  const { adapterKey, sample, result, adults, children } = input;
  const successColor = result.success ? COLOR.green : COLOR.red;
  const runtimeHandoff =
    result.observationSample.handoffUrl?.trim() ||
    (typeof result.runtimeError?.details?.handoff_url === "string"
      ? result.runtimeError.details.handoff_url.trim()
      : "") ||
    "n/a";

  console.log(`\n${paint("Single Quote Result", COLOR.bold)}`);

  const requestRows = [
    [paint("Adapter", COLOR.cyan), paint(adapterKey, COLOR.blue)],
    [paint("Listing", COLOR.cyan), paint(sample.listingId, COLOR.blue)],
    [paint("Stay", COLOR.cyan), `${sample.startDate} -> ${sample.endDate}`],
    [paint("Guests", COLOR.cyan), `${adults}/${children} (adults/children)`],
    [
      paint("Status", COLOR.cyan),
      paint(result.success ? "success" : "failed", successColor),
    ],
    [
      paint("Latency", COLOR.cyan),
      paint(fmtMs(result.elapsedMs), successColor),
    ],
  ];

  console.log(
    renderTable(
      [paint("Field", COLOR.cyan), paint("Value", COLOR.cyan)],
      requestRows,
    ),
  );

  const baseTotal = result.observationSample.baseTotal;
  const feesTotal = result.observationSample.feesTotalExclTaxes;
  const subTotal =
    typeof baseTotal === "number" && typeof feesTotal === "number"
      ? roundCurrency(baseTotal + feesTotal)
      : null;

  const pricingRows = [
    [paint("Currency", COLOR.cyan), result.observationSample.currency ?? "n/a"],
    [paint("Base Total", COLOR.cyan), fmtCurrency(baseTotal)],
    [paint("Fees", COLOR.cyan), fmtCurrency(feesTotal)],
    [paint("Sub-Total", COLOR.cyan), fmtCurrency(subTotal)],
    [
      paint("Taxes", COLOR.cyan),
      fmtCurrency(result.observationSample.taxesTotal),
    ],
    [
      paint("Grand Total", COLOR.cyan),
      fmtCurrency(result.observationSample.grandTotal),
    ],
  ];

  console.log(`\n${paint("Pricing Breakdown", COLOR.bold)}`);
  console.log(
    renderTable(
      [paint("Metric", COLOR.cyan), paint("Value", COLOR.cyan)],
      pricingRows,
      ["left", "right"],
    ),
  );

  const urlRows = [
    [paint("Detail", COLOR.cyan), sample.detailUrl || "n/a"],
    [paint("Checkout (handoff_url)", COLOR.cyan), runtimeHandoff],
  ];

  console.log(`\n${paint("URLs", COLOR.bold)}`);
  console.log(
    renderTable(
      [paint("Source", COLOR.cyan), paint("URL", COLOR.cyan)],
      urlRows,
    ),
  );

  const postStyle = parsePostStyleHandoffUrl(runtimeHandoff);
  if (postStyle) {
    console.log(`\n${paint("Manual Checkout Test", COLOR.bold)}`);
    console.log(
      renderTable(
        [paint("Field", COLOR.cyan), paint("Value", COLOR.cyan)],
        [
          [paint("Method", COLOR.cyan), postStyle.method],
          [paint("Endpoint", COLOR.cyan), postStyle.endpoint],
          [paint("Content-Type", COLOR.cyan), postStyle.contentType],
        ],
      ),
    );
    console.log(`${paint("Payload", COLOR.cyan)}:`);
    console.log(postStyle.payloadPretty);
    console.log(`${paint("cURL", COLOR.cyan)}:`);
    console.log(postStyle.curlCommand);
  }

  if (!result.success && result.reason) {
    console.log(`\n${paint("Failure Reason", COLOR.bold)}`);
    console.log(paint(result.reason, COLOR.red));
  }
}

function validateSingleModeInput(options: CliOptions): void {
  const explicitMode =
    options.singleListingId !== null ||
    options.singleStartDate !== null ||
    options.singleEndDate !== null;

  if (!explicitMode) {
    return;
  }

  if (
    options.singleListingId === null ||
    options.singleStartDate === null ||
    options.singleEndDate === null
  ) {
    throw new Error(
      "Single quote mode requires --listing-id, --start-date, and --end-date together.",
    );
  }

  if (
    !isIsoDate(options.singleStartDate) ||
    !isIsoDate(options.singleEndDate)
  ) {
    throw new Error(
      "--start-date and --end-date must be ISO dates (YYYY-MM-DD).",
    );
  }

  if (options.singleEndDate <= options.singleStartDate) {
    throw new Error("--end-date must be later than --start-date.");
  }
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
        const runtimeHandoffUrl =
          typeof result.error.details?.handoff_url === "string"
            ? result.error.details.handoff_url
            : null;

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
            handoffUrl: runtimeHandoffUrl,
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
          handoffUrl: null,
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
      handoffUrl: null,
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
          handoffUrl: null,
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
            handoffUrl: null,
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
      handoffUrl: null,
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

  if (!options.summaryOnly && !options.jsonOutput) {
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

      if (!options.jsonOutput) {
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
  }
  if (!options.jsonOutput) {
    clearProgressLine();
  }

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
  validateSingleModeInput(options);

  if (options.adapters.length === 0) {
    throw new Error(
      "Missing required adapter selection. Pass --adapters <key[,key...]> or --adapters all.",
    );
  }
  const adapters = await resolveAdapters(options);

  if (adapters.length === 0) {
    throw new Error("No adapters selected.");
  }

  const explicitSingleMode =
    options.singleListingId !== null &&
    options.singleStartDate !== null &&
    options.singleEndDate !== null;
  const runSingleMode = options.randomSingle || explicitSingleMode;

  if (runSingleMode) {
    if (adapters.length !== 1) {
      throw new Error(
        "Single quote mode requires exactly one adapter. Use --adapter-key <adapter>.",
      );
    }

    const adapterKey = adapters[0]!;
    let sample: ListingSample;

    if (options.randomSingle) {
      const candidates = await collectListingSamplesForAdapter(
        adapterKey,
        options,
        null,
      );
      if (candidates.length === 0) {
        throw new Error(
          "No random single-quote candidates found with >=3 bedrooms and available observations.",
        );
      }

      const chosenListing = pickRandom(candidates);
      const windows =
        chosenListing.fallbackWindows.length > 0
          ? chosenListing.fallbackWindows
          : [
              {
                startDate: chosenListing.startDate,
                endDate: chosenListing.endDate,
                handoffUrl: chosenListing.handoffUrl,
              },
            ];
      const chosenWindow = pickRandom(windows);

      sample = {
        ...chosenListing,
        startDate: chosenWindow.startDate,
        endDate: chosenWindow.endDate,
        handoffUrl: chosenWindow.handoffUrl,
        fallbackWindows: [],
      };
    } else {
      sample = await buildExplicitSingleSample({
        adapterKey,
        listingId: options.singleListingId!,
        startDate: options.singleStartDate!,
        endDate: options.singleEndDate!,
      });
    }

    const result = await runSingleQuoteRequestOnceWithTimeout(sample, options);
    if (options.jsonOutput) {
      const baseTotal = result.observationSample.baseTotal;
      const feesTotal = result.observationSample.feesTotalExclTaxes;
      const subTotal =
        typeof baseTotal === "number" && typeof feesTotal === "number"
          ? roundCurrency(baseTotal + feesTotal)
          : null;

      console.log(
        JSON.stringify(
          {
            mode: "single",
            adapterKey,
            randomSingle: options.randomSingle,
            guests: {
              adults: options.adults,
              children: options.children,
            },
            sample: {
              listingId: sample.listingId,
              detailUrl: sample.detailUrl,
              startDate: sample.startDate,
              endDate: sample.endDate,
            },
            result,
            pricing: {
              currency: result.observationSample.currency,
              baseTotal,
              feesTotalExclTaxes: feesTotal,
              subTotal,
              taxesTotal: result.observationSample.taxesTotal,
              grandTotal: result.observationSample.grandTotal,
              quotedTotal: result.observationSample.quotedTotal,
            },
            urls: {
              detailUrl: sample.detailUrl || null,
              handoffUrl: result.observationSample.handoffUrl,
            },
          },
          null,
          2,
        ),
      );
    } else {
      console.log(paint("Ad-hoc Single Quote Latency Analyzer", COLOR.bold));
      console.log(
        paint(
          `mode=single adapter=${adapterKey} listing=${sample.listingId} start=${sample.startDate} end=${sample.endDate} random_single=${options.randomSingle}`,
          COLOR.dim,
        ),
      );
      printSingleQuoteReport({
        adapterKey,
        sample,
        result,
        adults: options.adults,
        children: options.children,
      });
    }

    if (!result.success) {
      process.exitCode = 1;
    }
    return;
  }

  if (!options.jsonOutput) {
    console.log(paint("Ad-hoc Single Quote Latency Analyzer", COLOR.bold));
    console.log(
      paint(
        `adapters=${adapters.join(",")} sample_listings=${options.sampleListings} repeats=${options.repeats} min_available_observations=${options.minAvailableObservations} include_booking_fetch=${options.includeBookingFetch} summary_only=${options.summaryOnly}`,
        COLOR.dim,
      ),
    );
  }

  const results: AdapterRunResult[] = [];
  for (const adapterKey of adapters) {
    const result = await runForAdapter(adapterKey, options);
    results.push(result);

    if (result.failureReason && !options.jsonOutput) {
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

  const successfulAdapters = results.filter(
    (item) => item.failureReason === null,
  );
  const failedAdapters = results.length - successfulAdapters.length;

  if (options.jsonOutput) {
    console.log(
      JSON.stringify(
        {
          mode: "batch",
          options: {
            adapters,
            sampleListings: options.sampleListings,
            repeats: options.repeats,
            minAvailableObservations: options.minAvailableObservations,
            adults: options.adults,
            children: options.children,
            includeBookingFetch: options.includeBookingFetch,
            continueOnError: options.continueOnError,
            summaryOnly: options.summaryOnly,
          },
          results,
          overall: {
            adaptersTotal: results.length,
            adaptersSuccessful: successfulAdapters.length,
            adaptersFailed: failedAdapters,
          },
        },
        null,
        2,
      ),
    );
    return;
  }

  printAdapterSummaryTable(results);

  if (!options.summaryOnly) {
    for (const result of results) {
      printPerAdapterListingLatencyTable(result);
    }
  }

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
  const options = parseArgs(process.argv.slice(2));
  if (options.jsonOutput) {
    console.error(
      JSON.stringify(
        {
          success: false,
          error: {
            message,
          },
        },
        null,
        2,
      ),
    );
  } else {
    console.error(paint(`ad-hoc quote latency failed: ${message}`, COLOR.red));
  }
  process.exitCode = 1;
});
